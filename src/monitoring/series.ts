import { daysBetween, type IsoDate } from "@/domain/dates";
import type { Cents } from "@/domain/money";
import type { PriceStatus } from "@/domain/provenance";
import type { ObservationRecord } from "./observations";

/**
 * Price history as trend series. A series contains only observations of the
 * SAME configuration (fingerprint), with the SAME tax treatment and the SAME
 * kind of evidence (quoted vs estimated), so a line between two points is
 * always a like-for-like comparison. Anything else is a separate series.
 */

export type EvidenceClass = "quoted" | "estimated";

export interface SeriesPoint {
  observationId: string;
  entryId: string;
  observedOn: IsoDate;
  recordedAt: string;
  valueCents: Cents;
  status: ObservationRecord["status"];
  /** Status today: "stale" once a quoted observation is older than the staleness window. */
  effectiveStatus: PriceStatus;
  source: string;
  sourceUrl: string | null;
  origin: ObservationRecord["origin"];
  assumptions: string[];
}

export interface PriceSeries {
  key: string;
  fingerprint: string;
  taxTreatment: "all_in" | "pre_tax";
  evidence: EvidenceClass;
  points: SeriesPoint[];
  latest: SeriesPoint;
  previous: SeriesPoint | null;
  /** Latest − previous (null with fewer than two points). */
  changeCents: Cents | null;
  changePct: number | null;
  trend: "up" | "down" | "flat" | "insufficient";
  lowest: SeriesPoint;
  highest: SeriesPoint;
  /** Days since the latest observation. */
  ageDays: number;
  stale: boolean;
  /** Why no trend can be shown, if so. */
  insufficientReason: string | null;
}

export const evidenceOf = (s: ObservationRecord["status"]): EvidenceClass => (s === "estimated" ? "estimated" : "quoted");

/** Order of observations in time: when seen at the source, then when recorded. */
export const byTime = (a: { observedOn: IsoDate; recordedAt: string }, b: { observedOn: IsoDate; recordedAt: string }) =>
  a.observedOn === b.observedOn ? (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0) : a.observedOn < b.observedOn ? -1 : 1;

export const pctChange = (from: Cents, to: Cents): number | null => (from === 0 ? null : Math.round(((to - from) / from) * 10000) / 100);

/** Group stay-quote observations into equivalent series. Non-quote observations are ignored. */
export function buildSeries(observations: ObservationRecord[], today: IsoDate, staleAfterDays: number): PriceSeries[] {
  const groups = new Map<string, ObservationRecord[]>();
  for (const o of observations) {
    if (o.kind !== "stay_quote" || !o.seriesKey || !o.fingerprint || o.comparableTotalCents === null) continue;
    if (o.status === "illustrative") continue;
    const key = `${o.seriesKey}|${evidenceOf(o.status)}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const out: PriceSeries[] = [];
  for (const [key, obs] of groups) {
    const points: SeriesPoint[] = [...obs].sort(byTime).map((o) => {
      const age = daysBetween(o.observedOn, today);
      return {
        observationId: o.id,
        entryId: o.entryId,
        observedOn: o.observedOn,
        recordedAt: o.recordedAt,
        valueCents: o.comparableTotalCents!,
        status: o.status,
        effectiveStatus: o.status !== "estimated" && age > staleAfterDays ? "stale" : o.status,
        source: o.source,
        sourceUrl: o.sourceUrl,
        origin: o.origin,
        assumptions: o.assumptions,
      };
    });
    const latest = points[points.length - 1]!;
    const previous = points.length > 1 ? points[points.length - 2]! : null;
    const changeCents = previous ? latest.valueCents - previous.valueCents : null;
    const ageDays = daysBetween(latest.observedOn, today);
    const first = obs[0]!;
    out.push({
      key,
      fingerprint: first.fingerprint!,
      taxTreatment: first.seriesKey!.endsWith("#pre_tax") ? "pre_tax" : "all_in",
      evidence: evidenceOf(first.status),
      points,
      latest,
      previous,
      changeCents,
      changePct: previous ? pctChange(previous.valueCents, latest.valueCents) : null,
      trend: changeCents === null ? "insufficient" : changeCents > 0 ? "up" : changeCents < 0 ? "down" : "flat",
      lowest: points.reduce((a, b) => (b.valueCents < a.valueCents ? b : a)),
      highest: points.reduce((a, b) => (b.valueCents > a.valueCents ? b : a)),
      ageDays,
      stale: latest.effectiveStatus === "stale",
      insufficientReason:
        points.length < 2
          ? "Only one observation of this exact configuration has been recorded. A trend needs at least two observations of the same configuration, with the same tax treatment."
          : null,
    });
  }
  // Most recently observed first.
  return out.sort((a, b) => -byTime(a.latest, b.latest));
}

/** Explain why observations of related configurations were kept on separate lines. */
export function seriesSeparationNotes(series: PriceSeries[]): string[] {
  const notes: string[] = [];
  const byFp = new Map<string, PriceSeries[]>();
  for (const s of series) byFp.set(s.fingerprint, [...(byFp.get(s.fingerprint) ?? []), s]);
  for (const list of byFp.values()) {
    if (list.some((s) => s.taxTreatment === "pre_tax") && list.some((s) => s.taxTreatment === "all_in")) {
      notes.push("Pre-tax totals are shown separately from totals that include tax; they are not comparable.");
    }
    if (list.some((s) => s.evidence === "estimated") && list.some((s) => s.evidence === "quoted")) {
      notes.push("Your own estimates are shown separately from quoted prices.");
    }
  }
  return [...new Set(notes)];
}
