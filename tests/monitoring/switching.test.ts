import { describe, expect, it } from "vitest";
import { analyzeSwitching, type SwitchingInput } from "@/monitoring/switching";
import type { PaymentTerms } from "@/domain/types";

// Pure financial tests: no database, no notifications. All amounts fictional.

const terms = (over: Partial<PaymentTerms> = {}): PaymentTerms => ({
  depositCents: 20_000,
  installments: [],
  finalPaymentDueDate: "2027-01-02",
  amountPaidCents: 20_000,
  refundability: "refundable",
  freeCancellationUntil: "2027-01-02",
  cancellationPenalties: [{ fromDate: "2027-01-03", cents: 20_000 }, { fromDate: "2027-01-25", pct: 100 }],
  ...over,
});

const input = (over: Partial<SwitchingInput> = {}): SwitchingInput => ({
  asOf: "2026-12-01",
  current: { totalCents: 300_000, terms: terms(), status: "manual" },
  alternative: { totalCents: 270_000, terms: terms({ amountPaidCents: undefined }), status: "manual", likeForLike: true, differences: [] },
  knownFeesCents: 0,
  otherNonRefundableCents: 0,
  ticketChangeCents: 0,
  diningChangeCents: 0,
  minBenefitCents: 10_000,
  ...over,
});

describe("switching-cost analysis", () => {
  it("free cancellation: the whole difference is the net benefit", () => {
    const a = analyzeSwitching(input());
    expect(a.priceDifferenceCents).toBe(30_000);
    expect(a.cancellationPenaltyCents).toBe(0);
    expect(a.switchingCostCents).toBe(0);
    expect(a.netBenefitCents).toBe(30_000);
    expect(a.verdict).toBe("worth_considering");
    // Cash flows: refund of the $200 paid, new $200 deposit due now, $2,500 left on the new booking.
    expect(a.refundCents).toBe(20_000);
    expect(a.dueNowCents).toBe(20_000);
    expect(a.remainingBalanceAfterCents).toBe(250_000);
    expect(a.remainingBalanceIfKeptCents).toBe(280_000);
  });

  it("subtracts the penalty, fees and other non-refundable amounts", () => {
    const a = analyzeSwitching(input({ asOf: "2027-01-10", knownFeesCents: 2_500, otherNonRefundableCents: 1_500 }));
    expect(a.cancellationPenaltyCents).toBe(20_000);
    expect(a.switchingCostCents).toBe(24_000);
    expect(a.netBenefitCents).toBe(6_000);
    expect(a.verdict).toBe("review"); // positive but under the $100 threshold
    expect(a.dueNowCents).toBe(22_500); // deposit + fee
    expect(a.refundCents).toBe(0); // $200 paid − $200 penalty
  });

  it("a cheaper quote is not worth it when switching costs exceed the difference", () => {
    const a = analyzeSwitching(input({ asOf: "2027-01-26" })); // 100% penalty tier
    expect(a.priceDifferenceCents).toBe(30_000);
    expect(a.cancellationPenaltyCents).toBe(300_000);
    expect(a.netBenefitCents).toBe(-270_000);
    expect(a.verdict).toBe("not_worth_it");
    expect(a.headline).toMatch(/\$300\.00 cheaper, but switching would cost \$3,000\.00/);
  });

  it("unknown cancellation terms: no reliable recommendation", () => {
    const a = analyzeSwitching(input({ current: { totalCents: 300_000, terms: null, status: "manual" } }));
    expect(a.verdict).toBe("unknown");
    expect(a.netBenefitCents).toBeNull();
    expect(a.switchingCostCents).toBeNull();
    expect(a.priceDifferenceCents).toBe(30_000); // shown, but never called a saving
    expect(a.headline).toMatch(/No reliable recommendation/);
    expect(a.unknowns.join()).toMatch(/terms are not recorded/);
  });

  it("past the free-cancellation date with no recorded penalty: unknown", () => {
    const a = analyzeSwitching(input({ asOf: "2027-01-05", current: { totalCents: 300_000, terms: terms({ cancellationPenalties: [] }), status: "manual" } }));
    expect(a.cancellationPenaltyCents).toBeNull();
    expect(a.verdict).toBe("unknown");
  });

  it("unknown refundability: unknown", () => {
    const a = analyzeSwitching(input({ current: { totalCents: 300_000, terms: terms({ refundability: "unknown", freeCancellationUntil: undefined, cancellationPenalties: [] }), status: "manual" } }));
    expect(a.verdict).toBe("unknown");
    expect(a.unknowns.join()).toMatch(/refundable/);
  });

  it("unknown ticket or dining change cost: unknown", () => {
    expect(analyzeSwitching(input({ ticketChangeCents: null })).verdict).toBe("unknown");
    expect(analyzeSwitching(input({ diningChangeCents: null })).verdict).toBe("unknown");
  });

  it("ticket/dining change costs and credits are part of the switching cost", () => {
    const a = analyzeSwitching(input({ ticketChangeCents: 5_000, diningChangeCents: -2_000 }));
    expect(a.switchingCostCents).toBe(3_000);
    expect(a.netBenefitCents).toBe(27_000);
  });

  it("non-refundable with nothing paid recorded is treated as fully lost (conservative)", () => {
    const a = analyzeSwitching(input({ current: { totalCents: 300_000, terms: terms({ refundability: "non_refundable", freeCancellationUntil: undefined, cancellationPenalties: [], amountPaidCents: undefined }), status: "manual" } }));
    expect(a.cancellationPenaltyCents).toBe(300_000);
    expect(a.verdict).toBe("not_worth_it");
    expect(a.assumptions.join()).toMatch(/amount already paid is not recorded/);
  });

  it("never recommends switching to a different trip or on stale/estimated/illustrative prices", () => {
    expect(analyzeSwitching(input({ alternative: { ...input().alternative, likeForLike: false, differences: ["5 vs 6 nights"] } })).verdict).toBe("review");
    expect(analyzeSwitching(input({ alternative: { ...input().alternative, status: "stale" } })).verdict).toBe("review");
    expect(analyzeSwitching(input({ alternative: { ...input().alternative, status: "estimated" } })).verdict).toBe("review");
    expect(analyzeSwitching(input({ alternative: { ...input().alternative, status: "illustrative" } })).verdict).toBe("unknown");
  });

  it("alternative not cheaper", () => {
    const a = analyzeSwitching(input({ alternative: { ...input().alternative, totalCents: 310_000 } }));
    expect(a.priceDifferenceCents).toBe(-10_000);
    expect(a.verdict).toBe("not_worth_it");
  });

  it("unknown new deposit leaves the amount due now unknown", () => {
    const a = analyzeSwitching(input({ alternative: { ...input().alternative, terms: null } }));
    expect(a.dueNowCents).toBeNull();
    expect(a.remainingBalanceAfterCents).toBeNull();
    expect(a.verdict).toBe("worth_considering"); // the decision itself doesn't depend on the deposit
  });

  it("flags an approaching free-cancellation deadline", () => {
    const a = analyzeSwitching(input({ asOf: "2026-12-25" }));
    expect(a.daysUntilFreeCancellationEnds).toBe(8);
    expect(a.reasons.join()).toMatch(/Free cancellation ends 2027-01-02 \(8 days/);
  });

  it("is deterministic", () => {
    expect(analyzeSwitching(input())).toEqual(analyzeSwitching(input()));
  });
});
