import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyRecheck } from "@/data/observations";
import { migrateEntry, type UserPriceEntry } from "@/data/store";
import { summarizePayments } from "@/domain/pricing/payments";
import { evaluateTicketUsage } from "@/domain/pricing/ticketUsage";
import type { PaymentTerms, StayQuote } from "@/domain/types";

// Fictional TEST DATA throughout.

const terms = (over: Partial<PaymentTerms> = {}): PaymentTerms => ({
  depositCents: 20_000,
  installments: [],
  finalPaymentDueDate: "2026-12-18",
  refundability: "refundable",
  freeCancellationUntil: "2026-12-18",
  cancellationPenalties: [{ fromDate: "2026-12-19", cents: 20_000 }, { fromDate: "2027-01-12", pct: 100 }],
  ...over,
});

describe("payment schedule", () => {
  it("separates the amount due to book from the trip total", () => {
    const p = summarizePayments(terms(), 300_000, "2026-11-01");
    expect(p.totalCents).toBe(300_000);
    expect(p.dueToBookCents).toBe(20_000);
    expect(p.balanceCents).toBe(300_000);
    expect(p.schedule).toEqual([
      { dueDate: null, label: "Deposit", amountCents: 20_000, state: "upcoming" },
      { dueDate: "2026-12-18", label: "Final balance", amountCents: 280_000, state: "upcoming" },
    ]);
  });
  it("allocates payments already made and flags overdue amounts", () => {
    const p = summarizePayments(terms({ amountPaidCents: 20_000 }), 300_000, "2026-12-20");
    expect(p.dueToBookCents).toBe(0);
    expect(p.balanceCents).toBe(280_000);
    expect(p.schedule.map((s) => s.state)).toEqual(["paid", "overdue"]);
  });
  it("handles installments and warns when the schedule exceeds the total", () => {
    const p = summarizePayments(terms({ installments: [{ dueDate: "2026-11-15", amountCents: 100_000 }] }), 300_000, "2026-11-01");
    expect(p.schedule.map((s) => s.amountCents)).toEqual([20_000, 100_000, 180_000]);
    const over = summarizePayments(terms({ installments: [{ dueDate: "2026-11-15", amountCents: 400_000 }] }), 300_000, "2026-11-01");
    expect(over.warnings.join()).toMatch(/exceed/);
  });
});

describe("cancellation exposure", () => {
  it("is free inside the window, then follows the penalty tiers", () => {
    expect(summarizePayments(terms(), 300_000, "2026-12-18").cancellation.penaltyCents).toBe(0);
    expect(summarizePayments(terms(), 300_000, "2026-12-19").cancellation.penaltyCents).toBe(20_000);
    expect(summarizePayments(terms(), 300_000, "2027-01-12").cancellation.penaltyCents).toBe(300_000);
  });
  it("treats non-refundable bookings as losing what was paid", () => {
    const nr = terms({ refundability: "non_refundable", freeCancellationUntil: undefined, cancellationPenalties: [] });
    expect(summarizePayments({ ...nr, amountPaidCents: 120_000 }, 300_000, "2026-11-01").cancellation.penaltyCents).toBe(120_000);
    expect(summarizePayments(nr, 300_000, "2026-11-01").cancellation.penaltyCents).toBe(300_000);
  });
  it("returns unknown rather than guessing", () => {
    expect(summarizePayments(terms({ refundability: "unknown", cancellationPenalties: [] }), 300_000, "2026-11-01").cancellation.penaltyCents).toBeNull();
    const after = terms({ cancellationPenalties: [] });
    expect(summarizePayments(after, 300_000, "2026-12-30").cancellation.penaltyCents).toBeNull();
  });
});

describe("ticket usability", () => {
  it("is unknown when no usage rule is recorded", () => {
    expect(evaluateTicketUsage(undefined, null, "2027-02-02", 3, "2027-02-04").status).toBe("unknown");
  });
  it("checks the use-within window against the trip", () => {
    const ok = evaluateTicketUsage({ useWithinDays: 5, parkReservationRequired: false }, "rule", "2027-02-02", 3, "2027-02-10");
    expect(ok).toMatchObject({ status: "ok", usableDays: 5 });
    const short = evaluateTicketUsage({ useWithinDays: 2, parkReservationRequired: false }, "rule", "2027-02-02", 3, "2027-02-10");
    expect(short.status).toBe("violated");
    expect(short.reasons[0]).toMatch(/2-day use window/);
  });
  it("applies expiration and blockout dates when known", () => {
    const exp = evaluateTicketUsage({ useWithinDays: 10, expiresOn: "2027-02-03", parkReservationRequired: null }, "r", "2027-02-02", 3, "2027-02-10");
    expect(exp.status).toBe("violated");
    expect(exp.reasons[0]).toMatch(/expiration/);
    const blocked = evaluateTicketUsage({ useWithinDays: 4, blockoutDates: ["2027-02-03", "2027-02-04"], parkReservationRequired: null }, "r", "2027-02-02", 3, "2027-02-10");
    expect(blocked).toMatchObject({ status: "violated", usableDays: 2 });
    expect(blocked.unknowns).toContain("park reservation requirement");
  });
  it("reports unknown windows explicitly even when known checks pass", () => {
    const u = evaluateTicketUsage({ useWithinDays: null, expiresOn: "2027-12-31", parkReservationRequired: true }, "r", "2027-02-02", 3, "2027-02-10");
    expect(u.status).toBe("unknown");
    expect(u.unknowns).toEqual(["use-within window"]);
    expect(u.parkReservationRequired).toBe(true);
  });
});

const quote: StayQuote = {
  id: "q1",
  kind: "stay_quote",
  label: "TEST quote",
  resortId: "pop-century",
  roomTypeId: "standard",
  checkIn: "2027-01-17",
  nights: 6,
  adults: 2,
  children: 0,
  bookingMethod: "package",
  ticket: { option: "park_hopper", days: 5 },
  dining: "out_of_pocket",
  totalCents: 250_000,
  taxIncluded: true,
  provenance: { status: "manual", source: "TEST site", observedAt: "2026-10-01", sourceUrl: "https://example.com/a" },
};

describe("re-checking a quote (history is preserved)", () => {
  it("keeps the previous observation when marking a quote still current", () => {
    const r = applyRecheck(quote, { observedAt: "2026-10-30" }, "2026-10-30T10:00:00Z");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.entry as StayQuote;
    expect(e.totalCents).toBe(250_000);
    expect(e.provenance).toMatchObject({ observedAt: "2026-10-30", source: "TEST site", sourceUrl: "https://example.com/a" });
    expect(e.history).toEqual([
      { observedAt: "2026-10-01", supersededAt: "2026-10-30T10:00:00Z", status: "manual", source: "TEST site", sourceUrl: "https://example.com/a", value: 250_000 },
    ]);
  });
  it("updates the price and source while keeping every earlier observation", () => {
    const first = applyRecheck(quote, { observedAt: "2026-10-15", value: 240_000, source: "TEST site (sale)", sourceUrl: null }, "t1");
    if (!first.ok) throw new Error(first.error);
    const second = applyRecheck(first.entry, { observedAt: "2026-10-30", value: 255_000 }, "t2");
    if (!second.ok) throw new Error(second.error);
    const e = second.entry as StayQuote;
    expect(e.totalCents).toBe(255_000);
    expect(e.provenance.sourceUrl).toBeUndefined();
    expect(e.history!.map((h) => [h.observedAt, h.value, h.source])).toEqual([
      ["2026-10-01", 250_000, "TEST site"],
      ["2026-10-15", 240_000, "TEST site (sale)"],
    ]);
  });
  it("rejects going back in time and nonsensical prices", () => {
    expect(applyRecheck(quote, { observedAt: "2026-09-01" }, "t").ok).toBe(false);
    expect(applyRecheck(quote, { observedAt: "2026-10-30", value: 0 }, "t").ok).toBe(false);
  });
  it("migrates Milestone 1 quotes (always tax-inclusive) on read", () => {
    const { taxIncluded: _t, ...legacy } = quote;
    expect((migrateEntry(legacy as unknown as UserPriceEntry) as StayQuote).taxIncluded).toBe(true);
  });
});

describe("store persistence of re-checks", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "dvo-store-"));
    process.env.DVO_STORE_PATH = path.join(dir, "store.json");
  });
  afterAll(() => {
    delete process.env.DVO_STORE_PATH;
    rmSync(dir, { recursive: true, force: true });
  });
  it("persists history across reads, and bulk adds are stored together", async () => {
    const store = await import("@/data/store");
    const { id: _id, ...draft } = quote;
    const saved = await store.addPrice(draft);
    const res = await store.recheckPrice(saved.id, { observedAt: "2026-10-30", value: 245_000 });
    expect(res.ok).toBe(true);
    const [reloaded] = await store.listPrices();
    expect((reloaded as StayQuote).totalCents).toBe(245_000);
    expect(reloaded!.history).toHaveLength(1);
    const many = await store.addPrices([draft, draft]);
    expect(many).toHaveLength(2);
    expect(await store.listPrices()).toHaveLength(3);
    expect((await store.recheckPrice("missing", { observedAt: "2026-10-30" })).ok).toBe(false);
  });
});
