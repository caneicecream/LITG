/**
 * All money is represented as integer US cents to avoid floating-point drift.
 * Rounding happens only at explicit, documented points (percentages and taxes),
 * always half-up to the nearest cent.
 */
export type Cents = number;

export function dollarsToCents(dollars: number): Cents {
  return Math.round(dollars * 100);
}

/** Percentage of an amount, rounded half-up to the nearest cent. `pct` is e.g. 12.5 for 12.5%. */
export function percentOf(amount: Cents, pct: number): Cents {
  // Work in basis points * cents to keep the multiplication exact for typical inputs.
  return Math.round((amount * Math.round(pct * 10000)) / 1_000_000);
}

export function sumCents(values: readonly Cents[]): Cents {
  return values.reduce((a, b) => a + b, 0);
}

// Reuse one formatter: constructing Intl formatters per call is slow in hot loops.
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatCents(amount: Cents, opts: { sign?: boolean } = {}): string {
  const str = USD.format(Math.abs(amount) / 100);
  if (amount < 0) return `−${str}`;
  if (opts.sign && amount > 0) return `+${str}`;
  return str;
}
