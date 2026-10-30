import type { IsoDate } from "@/domain/dates";
import type { Provenance } from "@/domain/provenance";
import type { AgeCategory, TicketChannel, TicketOption, TicketPrice, TicketUsage } from "@/domain/types";
import { priceEntrySchema } from "../entrySchema";
import { parseDate, parseInteger, parseMoney } from "./values";

/**
 * Bulk ticket-price entry from a published price calendar.
 *
 * Simple mode, one price per line, using the batch's ticket type/days/age:
 *     2027-01-04, $612.00
 *     2027-01-05 .. 2027-01-08   598
 *     Jan 9, 2027 to Jan 15, 2027 | 640.50
 *
 * Table mode, when the first line is a header naming columns (comma or tab separated):
 *     start,end,ticket,days,age,price,use_within
 * Missing columns fall back to the batch defaults; a value missing in both is an error.
 * Usage rules are per batch (or per row via `use_within`), never assumed for all tickets.
 */

export type TicketDraft = Omit<TicketPrice, "id" | "history">;

export interface BulkTicketDefaults {
  option?: TicketOption;
  days?: number;
  age?: AgeCategory;
  channel: TicketChannel;
  taxIncluded: boolean;
  usage?: TicketUsage;
  provenance: Provenance;
}

export interface BulkTicketResult {
  entries: TicketDraft[];
  errors: { line: number; message: string }[];
}

const MAX_PRICE_CENTS = 1_000_000; // $10,000 per person: anything above is a typo
const RANGE_SEP = /\s*(?:\.\.|\s+to\s+|\s+[–—-]\s+)\s*/i;

export function parseTicketPriceTable(text: string, defaults: BulkTicketDefaults): BulkTicketResult {
  const errors: BulkTicketResult["errors"] = [];
  const entries: (TicketDraft & { line: number })[] = [];
  const lines = text.split(/\r?\n/).map((l, i) => ({ text: l.trim(), line: i + 1 })).filter((l) => l.text && !l.text.startsWith("#"));
  if (lines.length === 0) return { entries: [], errors: [{ line: 0, message: "Nothing to import" }] };

  const header = detectHeader(lines[0]!.text);
  const rows = header ? lines.slice(1) : lines;
  for (const { text: row, line } of rows) {
    const err = (message: string) => errors.push({ line, message });
    let startText: string | undefined, endText: string | undefined, priceText: string | undefined;
    let optionText: string | undefined, daysText: string | undefined, ageText: string | undefined, useWithinText: string | undefined;
    if (header) {
      const cells = splitCells(row, header.sep);
      const cell = (name: string) => (header.cols[name] !== undefined ? cells[header.cols[name]!]?.trim() || undefined : undefined);
      startText = cell("start");
      endText = cell("end");
      priceText = cell("price");
      optionText = cell("ticket");
      daysText = cell("days");
      ageText = cell("age");
      useWithinText = cell("use_within");
    } else {
      const m = row.match(/^(.*?)(?:\s*[,|\t]\s*|\s+)(\$?[\d,]+(?:\.\d{1,2})?)\s*$/);
      if (!m) {
        err(`Couldn't read "${row}": expected a date (or date range) followed by a price`);
        continue;
      }
      [startText, endText] = m[1]!.split(RANGE_SEP);
      priceText = m[2];
    }

    const start = startText ? parseDate(startText) : null;
    if (!start) {
      err(`"${startText ?? ""}" is not a date`);
      continue;
    }
    const end = endText ? parseDate(endText) : start;
    if (!end) {
      err(`"${endText}" is not a date`);
      continue;
    }
    if (end < start) {
      err("The range ends before it starts");
      continue;
    }
    const cents = priceText ? parseMoney(priceText) : null;
    if (cents === null || cents <= 0 || cents > MAX_PRICE_CENTS) {
      err(`"${priceText ?? ""}" is not a valid per-person price`);
      continue;
    }
    const option = optionText ? parseOption(optionText) : defaults.option;
    if (!option) {
      err(optionText ? `"${optionText}" is not a ticket type (base, park hopper, park hopper plus)` : "Choose a ticket type");
      continue;
    }
    const days = daysText ? parseInteger(daysText, 1, 10) : (defaults.days ?? null);
    if (!days) {
      err(daysText ? `"${daysText}" is not a number of days from 1 to 10` : "Choose the number of ticket days");
      continue;
    }
    const age = ageText ? parseAge(ageText) : defaults.age;
    if (!age) {
      err(ageText ? `"${ageText}" is not adult or child` : "Choose adult or child");
      continue;
    }
    let usage = defaults.usage;
    if (useWithinText) {
      const n = parseInteger(useWithinText, 1, 366);
      if (!n) {
        err(`"${useWithinText}" is not a number of days`);
        continue;
      }
      usage = { ...(usage ?? { parkReservationRequired: null }), useWithinDays: n };
    }
    if (usage?.useWithinDays !== undefined && usage.useWithinDays !== null && usage.useWithinDays < days) {
      err(`A ${days}-day ticket can't be used within ${usage.useWithinDays} days`);
      continue;
    }
    const draft: TicketDraft = {
      kind: "ticket_price",
      option,
      days,
      age,
      validFrom: start,
      validTo: end,
      cents,
      taxIncluded: defaults.taxIncluded,
      channel: defaults.channel,
      ...(usage ? { usage } : {}),
      provenance: defaults.provenance,
    };
    const checked = priceEntrySchema.safeParse(draft);
    if (!checked.success) {
      for (const i of checked.error.issues) err(`${i.path.join(".") || "price"}: ${i.message}`);
      continue;
    }
    entries.push({ ...draft, line });
  }

  // Overlapping ranges for the same ticket product would make prices ambiguous.
  const byProduct = new Map<string, (TicketDraft & { line: number })[]>();
  for (const e of entries) {
    const k = `${e.option}/${e.days}/${e.age}/${e.channel}`;
    byProduct.set(k, [...(byProduct.get(k) ?? []), e]);
  }
  for (const list of byProduct.values()) {
    const sorted = [...list].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.validFrom <= sorted[i - 1]!.validTo) {
        errors.push({ line: sorted[i]!.line, message: `Overlaps line ${sorted[i - 1]!.line} for the same ticket (${rangeText(sorted[i - 1]!.validFrom, sorted[i - 1]!.validTo)})` });
      }
    }
  }
  errors.sort((a, b) => a.line - b.line);
  return { entries: errors.length ? [] : entries.map(({ line: _l, ...e }) => e), errors };
}

function rangeText(a: IsoDate, b: IsoDate) {
  return a === b ? a : `${a} to ${b}`;
}

const COLUMN_ALIASES: Record<string, string> = {
  date: "start", start: "start", from: "start", startdate: "start",
  end: "end", to: "end", until: "end", enddate: "end",
  price: "price", amount: "price", cost: "price",
  ticket: "ticket", type: "ticket", option: "ticket", tickettype: "ticket",
  days: "days", duration: "days",
  age: "age",
  usewithin: "use_within", validfor: "use_within",
};

function detectHeader(line: string): { sep: string; cols: Record<string, number> } | null {
  const sep = line.includes("\t") ? "\t" : line.includes(",") ? "," : null;
  if (!sep) return null;
  const names = line.split(sep).map((c) => COLUMN_ALIASES[c.trim().toLowerCase().replace(/[^a-z]/g, "")]);
  if (!names.includes("price") || !names.includes("start")) return null;
  const cols: Record<string, number> = {};
  names.forEach((n, i) => n && cols[n] === undefined && (cols[n] = i));
  return { sep, cols };
}

/** Split a CSV/TSV row, honouring double quotes (prices like "$1,234.00"). */
function splitCells(row: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of row) {
    if (ch === '"') quoted = !quoted;
    else if (ch === sep && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function parseOption(t: string): TicketOption | null {
  const v = t.toLowerCase();
  if (/plus/.test(v)) return "park_hopper_plus";
  if (/hopper/.test(v)) return "park_hopper";
  if (/base|standard|1 park/.test(v)) return "base";
  return null;
}

function parseAge(t: string): AgeCategory | null {
  const v = t.toLowerCase();
  if (/^(adult|adults|10\+)$/.test(v)) return "adult";
  if (/^(child|children|kid|kids|3-9)$/.test(v)) return "child";
  return null;
}
