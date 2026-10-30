import { isIsoDate, type IsoDate } from "@/domain/dates";
import type { Cents } from "@/domain/money";

/** Strict value parsers for pasted text. Each returns null when the text isn't unambiguous. */

/** "$2,450.00", "2450", "2,450.5" → cents. Rejects negatives and more than two decimals. */
export function parseMoney(text: string): Cents | null {
  const t = text.trim().replace(/^usd\s*/i, "").replace(/\s*usd$/i, "").replace(/^\$\s*/, "");
  if (!/^\d{1,3}(,\d{3})*(\.\d{1,2})?$|^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.replace(/,/g, "").split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "Jan", "Jan.", "Sept", "January" → 1–12; anything else → null. */
function monthNumber(word: string): number | null {
  const w = word.toLowerCase().replace(/\.$/, "");
  const i = MONTH_NAMES.findIndex((m) => w === m || w === m.slice(0, 3) || (m === "september" && w === "sept"));
  return i < 0 ? null : i + 1;
}

/** "2027-01-17", "1/17/2027" (US order), "Jan 17, 2027", "January 17 2027", optionally prefixed by a weekday. */
export function parseDate(text: string): IsoDate | null {
  const t = text.trim().replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, "");
  let parts: [number, number, number] | null = null; // y, m, d
  let match: RegExpMatchArray | null;
  if ((match = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) parts = [Number(match[3]), Number(match[1]), Number(match[2])];
  else if ((match = t.match(/^([a-z]+\.?)\s+(\d{1,2}),?\s+(\d{4})$/i))) {
    const m = monthNumber(match[1]!);
    if (m) parts = [Number(match[3]), m, Number(match[2])];
  }
  if (!parts) return null;
  const iso = `${String(parts[0]).padStart(4, "0")}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}`;
  return isIsoDate(iso) ? iso : null;
}

export function parseYesNo(text: string): boolean | null {
  const t = text.trim().toLowerCase();
  if (["yes", "y", "true", "included", "incl", "incl.", "includes tax", "tax included"].includes(t)) return true;
  if (["no", "n", "false", "excluded", "not included", "plus tax", "+ tax", "before tax"].includes(t)) return false;
  return null;
}

export function parseInteger(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** Lowercase, drop punctuation and filler words, for matching names. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/walt disney world|disney's|disneys|disney|\bresort\b|& spa|\bspa\b|\bthe\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Match free text against named items: exact normalized match first, then a
 * unique containment match. Ambiguity is an error, never a guess.
 */
export function matchByName<T extends { id: string; name: string }>(
  text: string,
  items: readonly T[],
  opts: { matchIds?: boolean } = {},
): { item: T } | { error: string } {
  const n = normalizeName(text);
  if (!n) return { error: "is empty" };
  const exact = items.filter((x) => ((opts.matchIds ?? true) && x.id === text.trim()) || normalizeName(x.name) === n);
  if (exact.length === 1) return { item: exact[0]! };
  const partial = items.filter((x) => normalizeName(x.name).includes(n));
  if (partial.length === 1) return { item: partial[0]! };
  if (partial.length > 1) return { error: `"${text.trim()}" is ambiguous: ${partial.map((x) => x.name).join(" / ")}` };
  return { error: `"${text.trim()}" doesn't match any known name` };
}
