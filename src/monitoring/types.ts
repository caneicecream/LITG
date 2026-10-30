import { z } from "zod";
import type { IsoDate } from "@/domain/dates";
import type { Cents } from "@/domain/money";
import type { PriceStatus } from "@/domain/provenance";
import type { PaymentTerms } from "@/domain/types";
import type { SwitchingAnalysis } from "./switching";

/** Per-monitor preferences. Every field has a default, so older rows stay valid. */
export const monitorSettingsSchema = z.object({
  frequency: z.enum(["daily", "weekly", "manual"]).default("daily"),
  /** A quoted price older than this many days is flagged as stale. */
  staleAfterDays: z.number().int().min(1).max(365).default(14),
  /** Price changes notify when at least this many cents OR this percentage. */
  minChangeCents: z.number().int().min(0).max(10_000_000).default(2_500),
  minChangePct: z.number().min(0).max(100).default(1),
  /** Smallest net benefit after switching costs worth telling you about. */
  minSavingsCents: z.number().int().min(0).max(10_000_000).default(10_000),
  /** Switching costs the reservation terms don't capture. */
  knownSwitchingFeesCents: z.number().int().min(0).max(10_000_000).default(0),
  otherNonRefundableCents: z.number().int().min(0).max(10_000_000).default(0),
  /** Costs outside both totals for changing tickets / dining; null = unknown. */
  ticketChangeCents: z.number().int().min(-10_000_000).max(10_000_000).nullable().default(0),
  diningChangeCents: z.number().int().min(-10_000_000).max(10_000_000).nullable().default(0),
  notifyOn: z
    .object({
      decreases: z.boolean().default(true),
      increases: z.boolean().default(true),
      promotions: z.boolean().default(true),
      stale: z.boolean().default(true),
      missing: z.boolean().default(true),
      newQuotes: z.boolean().default(true),
      alternatives: z.boolean().default(true),
    })
    .prefault({}),
  email: z.boolean().default(false),
});
export type MonitorSettings = z.infer<typeof monitorSettingsSchema>;
export const defaultMonitorSettings = (): MonitorSettings => monitorSettingsSchema.parse({});

/** A compact, durable record of one evaluated vacation option at check time. */
export interface EvalSummary {
  evaluationId: string;
  label: string;
  fingerprint: string;
  totalCents: Cents;
  complete: boolean;
  missing: string[];
  dataStatus: PriceStatus;
  containsIllustrative: boolean;
  quoteId: string | null;
  promotion: { id: string; name: string; savingsCents: Cents } | null;
  potentialPromotions: { id: string; name: string }[];
  lines: { key: string; label: string; amountCents: Cents | null; status: PriceStatus; source: string }[];
  /** Terms when priced from a quote (deposit, cancellation). */
  terms: PaymentTerms | null;
}

/**
 * What one monitor check saw. A check RE-EVALUATES the saved trip with the
 * prices stored at that moment; it is not a live price check. New prices come
 * only from observations (your entries and re-checks, or an authorized adapter).
 */
export interface CheckSnapshot {
  version: 1;
  checkedAt: string;
  today: IsoDate;
  requestHash: string;
  /** Hash of all price data the optimizer saw: changes only when an observation is added or changed. */
  dataHash: string;
  engineVersion: string;
  catalogHash: string;
  demoMode: boolean;
  tracked: EvalSummary | null;
  trackedNote: string | null;
  /** The booked reservation that prices the tracked configuration, if any. */
  reservation: { quoteId: string; totalCents: Cents; terms: PaymentTerms | null; status: PriceStatus } | null;
  bestAlternative: (EvalSummary & { savingsCents: Cents; likeForLike: boolean; differences: string[] }) | null;
  cheapest: EvalSummary | null;
  /** Switching analysis (reservation held) — or null. */
  switching: SwitchingAnalysis | null;
  /** Observations of the tracked configuration recorded since the previous check. */
  newObservations: { id: string; entryId: string; observedOn: IsoDate; recordedAt: string; valueCents: Cents | null; source: string; status: string; taxTreatment: string | null }[];
  /** Adapters consulted and what they returned (none are configured by default). */
  adapters: { id: string; name: string; outcome: string }[];
}

export type MonitorEventType =
  | "first_check"
  | "price_decrease"
  | "price_increase"
  | "price_confirmed"
  | "provenance_changed"
  | "configuration_changed"
  | "recalculated"
  | "promotion_applied"
  | "promotion_ended"
  | "promotion_possible"
  | "stale"
  | "price_missing"
  | "price_available"
  | "new_comparable_quote"
  | "cheaper_alternative";

export interface MonitorEvent {
  type: MonitorEventType;
  severity: "info" | "notice" | "important";
  title: string;
  detail: string;
  /** Change of the tracked total (when the event is about one). */
  deltaCents?: Cents;
  deltaPct?: number | null;
  /** Whether this event should produce a notification under the monitor's settings. */
  notify: boolean;
  /** Stable key: the same situation never notifies twice. */
  dedupeKey: string;
  evidence: string[];
}
