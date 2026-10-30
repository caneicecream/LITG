import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pgBackendFor } from "@/data/backends/pg";
import { defaultTripRequest } from "@/data/defaults";
import type { Db } from "@/db/pool";
import type { StoreBackend } from "@/data/store";
import type { TripRequest } from "@/domain/types";
import type { ObservationAdapter } from "@/monitoring/adapters";
import { listNotifications, markRead, saveNotificationSettings, unreadCount, type EmailSender } from "@/monitoring/notify";
import { createMonitor, getMonitor, listChecks, monitorHistory, runDueMonitors, runMonitorCheck, updateMonitor } from "@/monitoring/service";
import { describeDb, freshSchema, popQuote } from "./helpers";

// Saved-vacation monitoring end to end (requires TEST_DATABASE_URL). Fictional prices.

const request = (): TripRequest => ({
  ...defaultTripRequest(),
  dates: { earliestArrival: "2027-02-01", latestDeparture: "2027-02-05", minNights: 4, maxNights: 4 },
  preferred: { arrival: "2027-02-01", nights: 4, resortId: "pop-century", roomTypeId: "standard", ticketOption: "base", bookingMethod: "package", dining: "out_of_pocket" },
  resorts: { allowedResortIds: ["pop-century", "all-star-movies"], requireOnProperty: true, preferredResortIds: [] },
  tickets: { parkDays: 3, allowedOptions: ["base"], parkOnArrivalDay: false, parkOnDepartureDay: false, allowThirdParty: true },
  dining: { policy: "exclude", outOfPocketPerAdultPerNightCents: 0, outOfPocketPerChildPerNightCents: 0 },
  budget: {},
  data: { includeIllustrative: false, staleAfterDays: 14 },
});

const at = (d: string) => new Date(`${d}T12:00:00.000Z`);
const noEmail = { email: null, adapters: [] };

describeDb("monitoring a saved trip", () => {
  let db: Db;
  let store: StoreBackend;
  let monitorId: string;
  let quoteId: string;

  // Recording times follow the simulated clock, as they would in real use.
  let clock = at("2026-10-27");
  beforeAll(async () => {
    db = await freshSchema("t_monitor");
    store = pgBackendFor(db, { now: () => clock });
    quoteId = (await store.addPrice(popQuote())).id;
    const trip = await store.saveTrip({ name: "February trip", request: request() });
    const m = await createMonitor(db, trip.id, {}, at("2026-10-28"));
    monitorId = m!.id;
  });
  afterAll(() => db.end());

  it("is opt-in per saved trip and idempotent", async () => {
    const m = await getMonitor(db, monitorId);
    expect(m).toMatchObject({ enabled: true, tripName: "February trip", settings: { frequency: "daily", minChangeCents: 2_500 } });
    expect((await createMonitor(db, m!.tripId))!.id).toBe(monitorId);
    expect(await createMonitor(db, "no-such-trip")).toBeNull();
  });

  it("first check records a baseline without notifying", async () => {
    const out = await runMonitorCheck(db, monitorId, { trigger: "manual", now: at("2026-10-28"), ...noEmail });
    expect(out!.check.snapshot.tracked).toMatchObject({ totalCents: 250_000, complete: true, quoteId });
    expect(out!.check.events.map((e) => e.type)).toEqual(["first_check"]);
    expect(out!.notification).toBeNull();
  });

  it("re-evaluating unchanged stored prices finds nothing and creates no observations", async () => {
    const obsBefore = (await db.query("SELECT 1 FROM price_observations")).length;
    const out = await runMonitorCheck(db, monitorId, { trigger: "manual", now: at("2026-10-29"), ...noEmail });
    expect(out!.check.events).toEqual([]);
    expect(out!.notification).toBeNull();
    expect((await db.query("SELECT 1 FROM price_observations")).length).toBe(obsBefore);
  });

  it("a new observation that lowers the price is detected and notified once", async () => {
    clock = new Date("2026-10-29T13:00:00.000Z");
    const r = await store.recheckPrice(quoteId, { observedAt: "2026-10-29", value: 230_000, source: "disneyworld.com re-check (TEST)" });
    expect(r.ok).toBe(true);
    const out = await runMonitorCheck(db, monitorId, { trigger: "manual", now: at("2026-10-30"), ...noEmail });
    const drop = out!.check.events.find((e) => e.type === "price_decrease")!;
    expect(drop).toMatchObject({ deltaCents: -20_000, deltaPct: -8, notify: true });
    expect(out!.notification?.title).toBe("February trip: Price down $200.00 (-8%)");
    expect(out!.notification?.body).toMatch(/does not check live availability\. Nothing has been booked, changed or cancelled/);

    // The same situation again: no second notification.
    const again = await runMonitorCheck(db, monitorId, { trigger: "manual", now: at("2026-10-30"), ...noEmail });
    expect(again!.notification).toBeNull();
    expect(await unreadCount(db)).toBe(1);
    expect(await markRead(db, "all")).toBe(1);
    expect(await unreadCount(db)).toBe(0);
  });

  it("a new quote for the same configuration from another source is reported", async () => {
    clock = new Date("2026-10-30T13:00:00.000Z");
    await store.addPrice(popQuote({ label: "agent quote", totalCents: 228_000, taxIncluded: false, provenance: { status: "manual", source: "travel agent (TEST)", observedAt: "2026-10-27" } }));
    const out = await runMonitorCheck(db, monitorId, { trigger: "manual", now: at("2026-10-31"), ...noEmail });
    const e = out!.check.events.find((x) => x.type === "new_comparable_quote")!;
    expect(e.detail).toMatch(/\$2,280\.00 observed 2026-10-27 \(travel agent \(TEST\), manual\); it excludes tax/);
  });

  it("history keeps equivalent series apart and explains them", async () => {
    const m = (await getMonitor(db, monitorId))!;
    const trip = (await store.getTrip(m.tripId))!;
    const h = await monitorHistory(db, m, trip, at("2026-10-31"));
    const allIn = h.series.find((s) => s.taxTreatment === "all_in")!;
    expect(allIn.points.map((p) => p.valueCents)).toEqual([250_000, 230_000]);
    expect(allIn.trend).toBe("down");
    const preTax = h.series.find((s) => s.taxTreatment === "pre_tax")!;
    expect(preTax.insufficientReason).toMatch(/needs at least two/);
    expect(h.separationNotes.join()).toMatch(/Pre-tax totals are shown separately/);
    expect(h.evaluations.length).toBe((await listChecks(db, monitorId, 200)).length);
  });

  it("scheduled runs only check due, enabled monitors, never twice concurrently", async () => {
    await db.query("UPDATE monitors SET next_check_at = $2 WHERE id = $1", [monitorId, "2026-11-01T00:00:00.000Z"]);
    expect(await runDueMonitors(db, { now: at("2026-10-31"), ...noEmail })).toEqual([]);
    const [a, b] = await Promise.all([runDueMonitors(db, { now: at("2026-11-02"), ...noEmail }), runDueMonitors(db, { now: at("2026-11-02"), ...noEmail })]);
    expect([...a, ...b]).toHaveLength(1);
    expect((await getMonitor(db, monitorId))!.nextCheckAt).toBe("2026-11-03T12:00:00.000Z");
    await updateMonitor(db, monitorId, { enabled: false });
    await db.query("UPDATE monitors SET next_check_at = $2 WHERE id = $1", [monitorId, "2026-11-01T00:00:00.000Z"]);
    expect(await runDueMonitors(db, { now: at("2026-11-05"), ...noEmail })).toEqual([]);
    await updateMonitor(db, monitorId, { enabled: true });
  });
});

describeDb("switching analysis, notifications by email, and adapters", () => {
  let db: Db;
  let store: StoreBackend;
  let monitorId: string;

  beforeAll(async () => {
    db = await freshSchema("t_monitor2");
    store = pgBackendFor(db);
    await store.addPrice(
      popQuote({
        booked: true,
        terms: { depositCents: 20_000, installments: [], amountPaidCents: 20_000, finalPaymentDueDate: "2026-12-18", refundability: "refundable", freeCancellationUntil: "2026-12-18", cancellationPenalties: [{ fromDate: "2026-12-19", cents: 20_000 }] },
      }),
    );
    const trip = await store.saveTrip({ name: "Booked trip", request: request() });
    monitorId = (await createMonitor(db, trip.id, { email: true }))!.id;
    await saveNotificationSettings(db, { emailEnabled: true, emailTo: "me@example.com" });
    await runMonitorCheck(db, monitorId, { trigger: "manual", now: at("2026-10-28"), ...noEmail });
  });
  afterAll(() => db.end());

  it("a cheaper like-for-like quote is analysed net of switching costs, then emailed", async () => {
    await store.addPrice(popQuote({ resortId: "all-star-movies", totalCents: 200_000, terms: { depositCents: 20_000, installments: [], refundability: "refundable", cancellationPenalties: [] } }));
    const send = vi.fn<EmailSender["send"]>().mockResolvedValue(undefined);
    const out = await runMonitorCheck(db, monitorId, { trigger: "manual", now: at("2026-10-29"), email: { send }, adapters: [] });
    const sw = out!.check.snapshot.switching!;
    expect(sw).toMatchObject({ verdict: "worth_considering", originalCostCents: 250_000, newCostCents: 200_000, priceDifferenceCents: 50_000, cancellationPenaltyCents: 0, netBenefitCents: 50_000, refundCents: 20_000, dueNowCents: 20_000, remainingBalanceAfterCents: 180_000 });
    expect(out!.check.events.find((e) => e.type === "cheaper_alternative")!.notify).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![0]).toMatchObject({ to: "me@example.com", subject: expect.stringMatching(/^Booked trip: Cheaper option found: Worth considering/) });
    expect(out!.notification?.delivery.email?.status).toBe("sent");
  });

  it("after the free-cancellation date the penalty counts, stale prices need re-checking, and fees can tip the balance", async () => {
    const out = await runMonitorCheck(db, monitorId, { trigger: "manual", now: at("2026-12-20"), ...noEmail });
    expect(out!.check.snapshot.switching).toMatchObject({ cancellationPenaltyCents: 20_000, netBenefitCents: 30_000, verdict: "review" });
    expect(out!.check.snapshot.switching!.headline).toMatch(/stale\. Re-check before acting/);
    await updateMonitor(db, monitorId, { settings: { knownSwitchingFeesCents: 40_000 } });
    const out2 = await runMonitorCheck(db, monitorId, { trigger: "manual", now: at("2026-12-21"), ...noEmail });
    expect(out2!.check.snapshot.switching).toMatchObject({ switchingCostCents: 60_000, netBenefitCents: -10_000, verdict: "not_worth_it" });
    expect(out2!.notification).toBeNull();
    await updateMonitor(db, monitorId, { settings: { knownSwitchingFeesCents: 0 } });
  });

  it("an email failure never loses the in-app notification", async () => {
    await store.addPrice(popQuote({ resortId: "all-star-movies", totalCents: 190_000, provenance: { status: "manual", source: "newer (TEST)", observedAt: "2026-12-22" } }));
    const send = vi.fn<EmailSender["send"]>().mockRejectedValue(new Error("SMTP down"));
    const out = await runMonitorCheck(db, monitorId, { trigger: "manual", now: at("2026-12-22"), email: { send }, adapters: [] });
    expect(out!.notification?.delivery.email).toMatchObject({ status: "failed", error: "SMTP down" });
    expect((await listNotifications(db)).some((n) => n.id === out!.notification!.id)).toBe(true);
  });

  it("authorized adapters: validated, deduplicated, failures isolated", async () => {
    const fresh = popQuote({ totalCents: 245_000, provenance: { status: "verified", source: "Partner API (TEST)", observedAt: "2026-12-23" } });
    const good: ObservationAdapter = { id: "partner", name: "Partner API (TEST)", limitations: "Test adapter.", fetchQuotes: async () => [fresh, { nonsense: true }, popQuote({ nights: 5 })] };
    const broken: ObservationAdapter = { id: "broken", name: "Broken", limitations: "", fetchQuotes: async () => { throw new Error("timeout"); } };
    const out = await runMonitorCheck(db, monitorId, { trigger: "scheduled", now: at("2026-12-23"), email: null, adapters: [good, broken] });
    expect(out!.check.snapshot.adapters).toEqual([
      { id: "partner", name: "Partner API (TEST)", outcome: "1 new observation(s), 0 unchanged, 2 rejected by validation" },
      { id: "broken", name: "Broken", outcome: "failed: timeout" },
    ]);
    const obs = await db.query<{ status: string; origin: string }>("SELECT status, origin FROM price_observations WHERE origin = 'adapter'");
    expect(obs).toEqual([{ status: "verified", origin: "adapter" }]);
    const again = await runMonitorCheck(db, monitorId, { trigger: "scheduled", now: at("2026-12-23"), email: null, adapters: [good] });
    expect(again!.check.snapshot.adapters[0]!.outcome).toMatch(/^0 new observation\(s\), 1 unchanged/);
  });
});

describe("monitor settings", () => {
  it("fill defaults and reject invalid values", async () => {
    const { monitorSettingsSchema } = await import("@/monitoring/types");
    expect(monitorSettingsSchema.parse({}).notifyOn.decreases).toBe(true);
    expect(monitorSettingsSchema.safeParse({ frequency: "hourly" }).success).toBe(false);
    expect(monitorSettingsSchema.safeParse({ minChangeCents: -1 }).success).toBe(false);
  });
});
