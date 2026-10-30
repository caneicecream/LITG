import { describe, expect, it } from "vitest";
import { applyPatch, diffRequests, describeRequest, moneyMentions } from "@/ai/patch";
import { CATALOG } from "@/data/catalog";
import { defaultTripRequest } from "@/data/defaults";
import { patch } from "./helpers";

const base = defaultTripRequest(); // Pop Century, Jan 17 2027, 6 nights, PH+ preferred, window Jan 4 – Feb 20, 5–7 nights
const say = (...t: string[]) => t;

describe("applyPatch (natural language → TripRequest)", () => {
  it("changes only what the patch names and preserves every other choice", () => {
    const r = applyPatch(base, patch({ preferred: { arrival: null, nights: 7, resortId: null, roomTypeId: null, ticketOption: null, bookingMethod: null, dining: null } }), CATALOG, say("7 nights"));
    expect(r.errors).toEqual([]);
    const { preferred: p1, ...rest1 } = r.request!;
    const { preferred: p0, ...rest0 } = base;
    expect(rest1).toEqual(rest0);
    expect({ ...p1, nights: 6 }).toEqual(p0);
    expect(r.diff).toEqual(["Preferred nights: 6 → 7"]);
  });

  it("resolves 'one more night' deterministically and widens the window to fit", () => {
    const narrow = { ...base, dates: { earliestArrival: "2027-01-17", latestDeparture: "2027-01-23", minNights: 6, maxNights: 6 } };
    const r = applyPatch(narrow, patch({ adjustNights: 1 }), CATALOG, say("one more night"));
    expect(r.request!.preferred.nights).toBe(7);
    expect(r.request!.dates).toEqual({ earliestArrival: "2027-01-17", latestDeparture: "2027-01-24", minNights: 6, maxNights: 7 });
    expect(r.adjustments.join(" ")).toMatch(/Maximum stay raised from 6 to 7/);
    expect(r.adjustments.join(" ")).toMatch(/Latest departure moved/);
    // Party, resort, tickets, dining, budget untouched.
    expect(r.request!.party).toEqual(narrow.party);
    expect(r.request!.preferred.resortId).toBe("pop-century");
    expect(r.request!.tickets).toEqual(narrow.tickets);
    expect(r.request!.budget).toEqual(narrow.budget);
  });

  it("moves the preferred arrival for 'a day earlier', extending the window when needed", () => {
    const tight = { ...base, dates: { ...base.dates, earliestArrival: "2027-01-17" } };
    const r = applyPatch(tight, patch({ shiftPreferredArrivalDays: -1 }), CATALOG, say("a day earlier"));
    expect(r.request!.preferred.arrival).toBe("2027-01-16");
    expect(r.request!.dates.earliestArrival).toBe("2027-01-16");
  });

  it("maps tiers to allowed resorts and rejects unknown resort ids", () => {
    const r = applyPatch(base, patch({ resorts: { allowedResortIds: null, allowTiers: ["value"], requireDisneyOwned: null, preferredResortIds: null, considerPoints: null } }), CATALOG, []);
    expect(r.request!.resorts.allowedResortIds.sort()).toEqual(CATALOG.resorts.filter((x) => x.tier === "value").map((x) => x.id).sort());
    const bad = applyPatch(base, patch({ resorts: { allowedResortIds: ["hogwarts"], allowTiers: null, requireDisneyOwned: null, preferredResortIds: null, considerPoints: null } }), CATALOG, []);
    expect(bad.request).toBeNull();
    expect(bad.errors[0]).toMatch(/unknown resort id/);
    const both = applyPatch(base, patch({ resorts: { allowedResortIds: ["pop-century"], allowTiers: ["value"], requireDisneyOwned: null, preferredResortIds: null, considerPoints: null } }), CATALOG, []);
    expect(both.errors[0]).toMatch(/both as a list and as tiers/);
  });

  it("keeps the preferred plan consistent when a ticket type is removed", () => {
    const r = applyPatch(base, patch({ tickets: { parkDays: null, allowedOptions: ["base", "park_hopper"], parkOnArrivalDay: null, parkOnDepartureDay: null, allowThirdParty: null } }), CATALOG, say("remove park hopper plus"));
    expect(r.request!.tickets.allowedOptions).toEqual(["base", "park_hopper"]);
    expect(r.request!.preferred.ticketOption).toBe("park_hopper");
    expect(r.adjustments[0]).toMatch(/now Park Hopper/);
  });

  it("only applies money the user actually said (never invents budgets)", () => {
    const b = (target: number | null, hard: number | null) => patch({ budget: { targetDollars: target, clearTarget: false, hardLimitDollars: hard, clearHardLimit: false } });
    const ok = applyPatch(base, b(5000, null), CATALOG, say("keep it under $5,000"));
    expect(ok.request!.budget.targetCents).toBe(500_000);
    const k = applyPatch(base, b(4500, null), CATALOG, say("something under 4.5k?"));
    expect(k.request!.budget.targetCents).toBe(450_000);
    const invented = applyPatch(base, b(null, 4000), CATALOG, say("find something cheaper"));
    expect(invented.request!.budget.hardLimitCents).toBeUndefined();
    expect(invented.warnings[0]).toMatch(/\$4,000\.00 was not applied because you didn't mention that amount/);
  });

  it("validates the patched request with the planner's schema", () => {
    const r = applyPatch(base, patch({ dates: { earliestArrival: null, latestDeparture: null, minNights: 8, maxNights: 7 } }), CATALOG, []);
    expect(r.request).toBeNull();
    expect(r.errors.join()).toMatch(/Maximum nights/);
    expect(applyPatch(base, patch({ dates: { earliestArrival: "2027-02-30", latestDeparture: null, minNights: null, maxNights: null } }), CATALOG, []).errors[0]).toMatch(/not a valid date/);
  });

  it("requiring a dining plan updates the preferred plan to a dining-plan package", () => {
    const r = applyPatch(base, patch({ dining: { policy: "require", foodPerAdultPerNightDollars: null, foodPerChildPerNightDollars: null } }), CATALOG, say("we need a dining plan"));
    expect(r.request!.preferred).toMatchObject({ dining: "dining_plan", bookingMethod: "package" });
  });

  it("describes hard requirements separately from preferences", () => {
    const d = describeRequest(base, CATALOG);
    expect(d.find((x) => x.key === "hardLimit")?.kind).toBe("requirement");
    expect(d.find((x) => x.key === "target")?.kind).toBe("preference");
    expect(d.find((x) => x.key === "prefResorts")?.kind).toBe("preference");
    expect(diffRequests(base, { ...base, party: { ...base.party, adults: 3 } }, CATALOG)).toEqual(["Travelers: 2 adult(s), 0 child(ren) 3–9, 0 under 3 → 3 adult(s), 0 child(ren) 3–9, 0 under 3"]);
  });

  it("recognizes money mentions but not small bare numbers", () => {
    expect([...moneyMentions("6 or 7 nights, under $5,000, max 4.5k, about 3000 dollars")].sort((a, b) => a - b)).toEqual([300_000, 450_000, 500_000]);
  });
});
