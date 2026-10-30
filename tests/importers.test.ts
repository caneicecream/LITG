import { describe, expect, it } from "vitest";
import { formatQuoteText, parseQuoteText, QUOTE_TEMPLATE } from "@/data/importers/quoteText";
import { parseTicketPriceTable, type BulkTicketDefaults } from "@/data/importers/ticketBulk";
import { matchByName, parseDate, parseMoney } from "@/data/importers/values";
import { CATALOG } from "@/data/catalog";

// All quotes below are fictional TEST DATA.
const FULL = `Resort: Pop Century
Room: Standard Room
Check-in: Jan 17, 2027
Check-out: 1/23/2027
Adults: 2
Children: 0
Booking: package
Tickets: Park Hopper Plus, 5 days
Dining: none
Total: $2,450.00
Taxes included: yes
Deposit: $200
Final payment due: 2026-12-18
Refundable: yes
Free cancellation until: 2026-12-18
Cancellation penalty: $200 from 2026-12-19
Source: TEST DATA quote
URL: https://example.com/quote
Observed: 2026-10-29
Notes: fictional`;

describe("value parsers", () => {
  it("parses money strictly", () => {
    expect(parseMoney("$2,450.00")).toBe(245_000);
    expect(parseMoney("612")).toBe(61_200);
    expect(parseMoney("1234.5")).toBe(123_450);
    expect(parseMoney("-5")).toBeNull();
    expect(parseMoney("12.345")).toBeNull();
    expect(parseMoney("1,23")).toBeNull();
  });
  it("parses common date formats and rejects impossible dates", () => {
    expect(parseDate("2027-01-17")).toBe("2027-01-17");
    expect(parseDate("Sun, Jan 17, 2027")).toBe("2027-01-17");
    expect(parseDate("September 3 2027")).toBe("2027-09-03");
    expect(parseDate("Sept. 3, 2027")).toBe("2027-09-03");
    expect(parseDate("2/30/2027")).toBeNull();
    expect(parseDate("Janxyz 3 2027")).toBeNull();
  });
  it("matches names exactly or uniquely, and reports ambiguity instead of guessing", () => {
    expect(matchByName("Pop Century", CATALOG.resorts)).toMatchObject({ item: { id: "pop-century" } });
    expect(matchByName("Contemporary", CATALOG.resorts)).toMatchObject({ item: { id: "contemporary" } });
    const poly = matchByName("Polynesian", CATALOG.resorts);
    expect("error" in poly && poly.error).toMatch(/ambiguous/);
    expect(matchByName("Nonexistent Lodge", CATALOG.resorts)).toHaveProperty("error");
  });
});

describe("paste-friendly quote entry", () => {
  it("parses a complete package quote with payment terms", () => {
    const [q] = parseQuoteText(FULL);
    expect(q!.errors).toEqual([]);
    expect(q!.entry).toMatchObject({
      resortId: "pop-century",
      roomTypeId: "standard",
      checkIn: "2027-01-17",
      nights: 6,
      adults: 2,
      children: 0,
      bookingMethod: "package",
      ticket: { option: "park_hopper_plus", days: 5 },
      dining: "out_of_pocket",
      totalCents: 245_000,
      taxIncluded: true,
      terms: {
        depositCents: 20_000,
        refundability: "refundable",
        freeCancellationUntil: "2026-12-18",
        cancellationPenalties: [{ fromDate: "2026-12-19", cents: 20_000 }],
      },
      provenance: { status: "manual", source: "TEST DATA quote", observedAt: "2026-10-29", sourceUrl: "https://example.com/quote" },
    });
  });

  it("lists every missing field instead of inferring it", () => {
    const [q] = parseQuoteText("Resort: Pop Century\nTotal: $1,000");
    expect(q!.entry).toBeNull();
    const all = q!.errors.join("\n");
    for (const f of ["Room", "Check-in", "Check-out or Nights", "Adults", "Children", "Booking", "Taxes included", "Source", "Observed"]) {
      expect(all).toContain(f);
    }
  });

  it("requires tickets and dining for packages, and rejects them for room-only quotes", () => {
    const pkg = parseQuoteText(FULL.replace("Tickets: Park Hopper Plus, 5 days\n", "").replace("Dining: none\n", ""))[0]!;
    expect(pkg.errors.join()).toMatch(/Tickets/);
    expect(pkg.errors.join()).toMatch(/Dining/);
    const roomOnly = parseQuoteText(FULL.replace("Booking: package", "Booking: room only"))[0]!;
    expect(roomOnly.errors.join()).toMatch(/can't include tickets/);
  });

  it("rejects inconsistent dates, ambiguous resorts and conflicting tax fields", () => {
    expect(parseQuoteText(FULL.replace("Check-out: 1/23/2027", "Check-out: 1/23/2027\nNights: 5"))[0]!.errors.join()).toMatch(/doesn't match/);
    expect(parseQuoteText(FULL.replace("Resort: Pop Century", "Resort: Polynesian"))[0]!.errors.join()).toMatch(/ambiguous/);
    expect(parseQuoteText(`${FULL}\nTaxes: $300`)[0]!.errors.join()).toMatch(/marked as including taxes/);
  });

  it("accepts a pre-tax room-only quote with separately quoted taxes", () => {
    const text = FULL.replace("Booking: package", "Booking: room only")
      .replace("Tickets: Park Hopper Plus, 5 days\n", "")
      .replace("Dining: none\n", "")
      .replace("Taxes included: yes", "Taxes included: no\nTaxes: $151.20");
    const [q] = parseQuoteText(text);
    expect(q!.errors).toEqual([]);
    expect(q!.entry).toMatchObject({ bookingMethod: "separate", taxIncluded: false, taxCents: 15_120 });
  });

  it("parses DVC point-rental quotes with points and price per point", () => {
    const text = `Resort: Saratoga Springs
Room: Deluxe Studio
Check-in: 2027-02-01
Nights: 4
Adults: 2
Children: 1
Booking: points (rental)
Points: 64
Price per point: $21
Total: $1,344
Taxes included: yes
Refundable: no
Source: TEST DATA broker
Observed: 2026-10-28`;
    const [q] = parseQuoteText(text);
    expect(q!.errors).toEqual([]);
    expect(q!.entry).toMatchObject({ bookingMethod: "points", points: { pointsRequired: 64, centsPerPoint: 2_100 }, terms: { refundability: "non_refundable" } });
  });

  it("parses several quotes separated by ---, and warns about unrecognized lines", () => {
    const res = parseQuoteText(`${FULL}\nFavourite color: blue\n---\n${FULL.replace("Jan 17, 2027", "Jan 18, 2027").replace("1/23/2027", "1/24/2027")}`);
    expect(res).toHaveLength(2);
    expect(res[0]!.warnings.join()).toMatch(/Favourite color/);
    expect(res[1]!.entry?.checkIn).toBe("2027-01-18");
  });

  it("round-trips through formatQuoteText (used for duplicates)", () => {
    const [q] = parseQuoteText(FULL);
    const again = parseQuoteText(formatQuoteText(q!.entry!))[0]!;
    expect(again.errors).toEqual([]);
    expect(again.entry).toEqual({ ...q!.entry!, label: again.entry!.label });
  });

  it("refuses the blank template until it is filled in", () => {
    const [q] = parseQuoteText(QUOTE_TEMPLATE);
    expect(q!.entry).toBeNull();
    expect(q!.errors.join()).toMatch(/Total/);
  });
});

describe("bulk ticket prices", () => {
  const defaults: BulkTicketDefaults = {
    option: "park_hopper",
    days: 4,
    age: "adult",
    channel: "disney",
    taxIncluded: false,
    provenance: { status: "manual", source: "TEST DATA calendar", observedAt: "2026-10-29" },
  };

  it("reads dates, ranges and prices in simple mode", () => {
    const { entries, errors } = parseTicketPriceTable(
      "2027-01-04, $612.00\n2027-01-05 .. 2027-01-08   598\nJan 9, 2027 to Jan 15, 2027 | 640.50",
      defaults,
    );
    expect(errors).toEqual([]);
    expect(entries.map((e) => [e.validFrom, e.validTo, e.cents])).toEqual([
      ["2027-01-04", "2027-01-04", 61_200],
      ["2027-01-05", "2027-01-08", 59_800],
      ["2027-01-09", "2027-01-15", 64_050],
    ]);
    expect(entries.every((e) => e.option === "park_hopper" && e.days === 4 && e.age === "adult")).toBe(true);
  });

  it("reads a table with per-row ticket types, durations, ages and usage windows", () => {
    const csv = `start,end,ticket,days,age,price,use_within
2027-01-04,2027-01-10,base,3,adult,"$450.00",5
2027-01-04,2027-01-10,park hopper plus,3,child,520,
2027-01-04,,base,1,adult,159,`;
    const { entries, errors } = parseTicketPriceTable(csv, { ...defaults, option: undefined, days: undefined, age: undefined });
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ option: "base", days: 3, cents: 45_000, usage: { useWithinDays: 5 } });
    expect(entries[1]).toMatchObject({ option: "park_hopper_plus", age: "child" });
    expect(entries[1]!.usage).toBeUndefined();
    expect(entries[2]).toMatchObject({ validFrom: "2027-01-04", validTo: "2027-01-04", days: 1 });
  });

  it("is all-or-nothing and reports errors by line", () => {
    const { entries, errors } = parseTicketPriceTable("2027-01-04, 612\n2027-02-30, 600\n2027-01-06, -5\n2027-01-09 .. 2027-01-07, 600", defaults);
    expect(entries).toEqual([]);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4]);
  });

  it("rejects overlapping ranges for the same ticket and impossible usage windows", () => {
    const overlap = parseTicketPriceTable("2027-01-04 .. 2027-01-10, 612\n2027-01-08, 600", defaults);
    expect(overlap.errors[0]?.message).toMatch(/Overlaps line 1/);
    const usage = parseTicketPriceTable("2027-01-04, 612", { ...defaults, usage: { useWithinDays: 3, parkReservationRequired: null } });
    expect(usage.errors[0]?.message).toMatch(/can't be used within 3 days/);
  });

  it("requires ticket type, days and age from the batch or the row", () => {
    const { errors } = parseTicketPriceTable("2027-01-04, 612", { ...defaults, option: undefined });
    expect(errors[0]?.message).toMatch(/ticket type/);
  });
});
