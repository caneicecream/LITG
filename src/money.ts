/** Parses "1,049.99" / "$899" / 899.99 into integer cents. Returns null for anything else. */
export function toCents(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
  }
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[$,\s]|USD/gi, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
