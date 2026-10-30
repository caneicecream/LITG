"use client";

import { CATALOG } from "@/data/catalog";
import type { UserPriceEntry } from "@/data/store";
import { formatShortDate, todayIso } from "@/domain/dates";
import { formatCents } from "@/domain/money";
import { DINING_LABEL, TICKET_LABEL } from "@/domain/pricing/calculate";
import type { Provenance } from "@/domain/provenance";
import type { PaymentTerms, TicketUsage, TripRequest } from "@/domain/types";
import { MoneyInput, NumberInput } from "../ui";

export const KIND_LABEL: Record<UserPriceEntry["kind"], string> = {
  stay_quote: "Stay / package quote",
  room_rate: "Nightly room rate",
  ticket_price: "Ticket price",
  ticket_rule: "Ticket usage rule",
  dining_plan_price: "Dining plan price",
  point_chart: "DVC point chart",
  point_cost: "DVC point cost",
  promotion: "Promotion",
};

export const resortName = (id: string) => CATALOG.resorts.find((r) => r.id === id)?.name.replace("Disney's ", "") ?? id;
export const roomName = (rid: string, id: string) => CATALOG.resorts.find((r) => r.id === rid)?.roomTypes.find((x) => x.id === id)?.name ?? id;

/** The planner's last request (saved locally), used to prefill forms. */
export function readDraft(): TripRequest | null {
  try {
    const raw = localStorage.getItem("dvo:draft-request");
    return raw ? (JSON.parse(raw) as TripRequest) : null;
  } catch {
    return null;
  }
}

export function staleAfterDays(): number {
  return readDraft()?.data.staleAfterDays ?? 14;
}

function weekdayLabel(days: number[]): string {
  const k = [...days].sort().join(",");
  if (k === "0,1,2,3,4") return "Sun–Thu";
  if (k === "5,6") return "Fri–Sat";
  return days.map((d) => "SMTWTFS"[d]).join("");
}

export function describe(e: UserPriceEntry): string {
  switch (e.kind) {
    case "stay_quote": {
      const what =
        e.bookingMethod === "package"
          ? `package with ${e.ticket?.days}-day ${TICKET_LABEL[e.ticket!.option]}${e.dining !== "out_of_pocket" ? ` + ${DINING_LABEL[e.dining]}` : ""}`
          : e.bookingMethod === "points"
            ? `DVC point rental${e.points ? ` (${e.points.pointsRequired} pts)` : ""}`
            : "room only";
      return `${e.label} — ${resortName(e.resortId)}, ${roomName(e.resortId, e.roomTypeId)}; ${formatShortDate(e.checkIn)}, ${e.nights} nights; ${e.adults} adults${e.children ? ` + ${e.children} children` : ""}; ${what}${e.booked ? "; BOOKED" : ""}`;
    }
    case "room_rate":
      return `${resortName(e.resortId)}, ${roomName(e.resortId, e.roomTypeId)}; nights ${formatShortDate(e.validFrom)} – ${formatShortDate(e.validTo)}${e.daysOfWeek ? ` (${weekdayLabel(e.daysOfWeek)})` : ""}${e.taxIncluded ? "; incl. tax" : ""}`;
    case "ticket_price":
      return `${e.days}-day ${TICKET_LABEL[e.option]}, ${e.age}; start ${formatShortDate(e.validFrom)} – ${formatShortDate(e.validTo)}; ${e.channel === "third_party" ? "third-party seller" : "Disney"}${e.taxIncluded ? "; incl. tax" : ""}${e.usage ? `; ${usageText(e.usage)}` : ""}`;
    case "ticket_rule":
      return `${e.days ? `${e.days}-day` : "All"} ${TICKET_LABEL[e.option]} (${e.channel === "third_party" ? "third-party" : "Disney"}): ${usageText(e.usage)}`;
    case "dining_plan_price":
      return `${DINING_LABEL[e.plan]}, ${e.age}; ${formatShortDate(e.validFrom)} – ${formatShortDate(e.validTo)}${e.taxIncluded ? "; incl. tax" : ""}`;
    case "point_chart":
      return `${resortName(e.resortId)}, ${roomName(e.resortId, e.roomTypeId)}; nights ${formatShortDate(e.validFrom)} – ${formatShortDate(e.validTo)}${e.daysOfWeek ? ` (${weekdayLabel(e.daysOfWeek)})` : ""}`;
    case "point_cost":
      return `${e.label} (${e.type === "rental" ? "rental" : "own points"})${e.resortIds ? `; ${e.resortIds.map(resortName).join(", ")}` : "; all DVC resorts"}${e.feeCents ? `; ${formatCents(e.feeCents)} fee` : ""}${e.terms ? `; ${e.terms.refundability.replace("_", "-")}` : ""}`;
    case "promotion":
      return `${e.name}; travel ${formatShortDate(e.travel.from)} – ${formatShortDate(e.travel.to)}${e.requiresPackage ? "; package only" : ""}`;
  }
}

export function priceText(e: UserPriceEntry): string {
  switch (e.kind) {
    case "stay_quote":
      return `${formatCents(e.totalCents)}${e.taxIncluded ? "" : e.taxCents !== undefined ? ` + ${formatCents(e.taxCents)} tax` : " + tax"}`;
    case "room_rate":
      return `${formatCents(e.nightlyCents)}/night`;
    case "ticket_price":
      return `${formatCents(e.cents)}/person`;
    case "dining_plan_price":
      return `${formatCents(e.perNightCents)}/night`;
    case "point_chart":
      return `${e.pointsPerNight} pts/night`;
    case "point_cost":
      return `${formatCents(e.centsPerPoint)}/point`;
    case "ticket_rule":
      return "—";
    case "promotion":
      return e.discount.type === "room_percent" ? `${e.discount.pct}% off room` : `${formatCents(e.discount.cents)} off${e.discount.type === "room_fixed_per_night" ? "/night" : ""}`;
  }
}

export function usageText(u: TicketUsage): string {
  const parts = [
    u.useWithinDays ? `use within ${u.useWithinDays} days` : "use window unknown",
    ...(u.expiresOn ? [`expires ${formatShortDate(u.expiresOn)}`] : []),
    ...(u.blockoutDates?.length ? [`${u.blockoutDates.length} blocked-out date(s)`] : []),
    u.parkReservationRequired === null ? "park reservations unknown" : u.parkReservationRequired ? "park reservations required" : "no park reservations",
  ];
  return parts.join(", ");
}

// ─────────────────────────────── Provenance editor ───────────────────────────────

export interface ProvenanceState {
  status: "manual" | "estimated";
  source: string;
  sourceUrl: string;
  observedAt: string;
  notes: string;
}

export const emptyProvenance = (source = ""): ProvenanceState => ({ status: "manual", source, sourceUrl: "", observedAt: todayIso(), notes: "" });

export function toProvenance(p: ProvenanceState): Provenance {
  return {
    status: p.status,
    source: p.source.trim(),
    observedAt: p.observedAt,
    ...(p.sourceUrl.trim() ? { sourceUrl: p.sourceUrl.trim() } : {}),
    ...(p.notes.trim() ? { notes: p.notes.trim() } : {}),
  };
}

export function fromProvenance(p: Provenance): ProvenanceState {
  return { status: p.status === "estimated" ? "estimated" : "manual", source: p.source, sourceUrl: p.sourceUrl ?? "", observedAt: p.observedAt, notes: p.notes ?? "" };
}

export function ProvenanceFields({ value, onChange }: { value: ProvenanceState; onChange: (p: ProvenanceState) => void }) {
  const set = (patch: Partial<ProvenanceState>) => onChange({ ...value, ...patch });
  return (
    <fieldset className="card-pad" style={{ border: "1px dashed var(--border)", borderRadius: 8 }}>
      <legend className="small muted" style={{ padding: "0 6px" }}>
        Where did this price come from?
      </legend>
      <div className="grid3">
        <label className="field">
          Status
          <select value={value.status} onChange={(e) => set({ status: e.target.value as ProvenanceState["status"] })}>
            <option value="manual">Copied from a real quote/page</option>
            <option value="estimated">My own estimate</option>
          </select>
        </label>
        <label className="field">
          Source
          <input value={value.source} placeholder="e.g. disneyworld.com quote" onChange={(e) => set({ source: e.target.value })} />
        </label>
        <label className="field">
          Observed on
          <input type="date" value={value.observedAt} onChange={(e) => set({ observedAt: e.target.value })} />
        </label>
        <label className="field" style={{ gridColumn: "span 2" }}>
          Link (optional)
          <input type="url" value={value.sourceUrl} onChange={(e) => set({ sourceUrl: e.target.value })} />
        </label>
        <label className="field">
          Notes (optional)
          <input value={value.notes} onChange={(e) => set({ notes: e.target.value })} />
        </label>
      </div>
    </fieldset>
  );
}

// ─────────────────────────────── Ticket usage editor ───────────────────────────────

export interface UsageState {
  enabled: boolean;
  useWithinDays: number | undefined;
  expiresOn: string;
  blockoutDates: string;
  parkRes: "unknown" | "required" | "not_required";
}

export const emptyUsage = (): UsageState => ({ enabled: false, useWithinDays: undefined, expiresOn: "", blockoutDates: "", parkRes: "unknown" });

export function fromUsage(u: TicketUsage | undefined): UsageState {
  if (!u) return emptyUsage();
  return {
    enabled: true,
    useWithinDays: u.useWithinDays ?? undefined,
    expiresOn: u.expiresOn ?? "",
    blockoutDates: (u.blockoutDates ?? []).join(", "),
    parkRes: u.parkReservationRequired === null ? "unknown" : u.parkReservationRequired ? "required" : "not_required",
  };
}

export function toUsage(u: UsageState): TicketUsage | undefined {
  if (!u.enabled) return undefined;
  const blockouts = u.blockoutDates.split(/[\s,]+/).filter(Boolean);
  return {
    useWithinDays: u.useWithinDays ?? null,
    ...(u.expiresOn ? { expiresOn: u.expiresOn } : {}),
    ...(blockouts.length ? { blockoutDates: blockouts } : {}),
    parkReservationRequired: u.parkRes === "unknown" ? null : u.parkRes === "required",
  };
}

export function UsageFields({ value, onChange, optional = true }: { value: UsageState; onChange: (u: UsageState) => void; optional?: boolean }) {
  const set = (patch: Partial<UsageState>) => onChange({ ...value, ...patch });
  return (
    <div className="stack">
      {optional && (
        <label className="check">
          <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> The ticket terms state usage rules
        </label>
      )}
      {(value.enabled || !optional) && (
        <div className="grid3">
          <label className="field">
            Use within (days, blank = unknown)
            <NumberInput min={1} max={366} value={value.useWithinDays} onChange={(v) => set({ useWithinDays: v })} />
          </label>
          <label className="field">
            Expires on (optional)
            <input type="date" value={value.expiresOn} onChange={(e) => set({ expiresOn: e.target.value })} />
          </label>
          <label className="field">
            Park reservations
            <select value={value.parkRes} onChange={(e) => set({ parkRes: e.target.value as UsageState["parkRes"] })}>
              <option value="unknown">Unknown</option>
              <option value="required">Required</option>
              <option value="not_required">Not required</option>
            </select>
          </label>
          <label className="field" style={{ gridColumn: "span 3" }}>
            Blocked-out dates (optional, YYYY-MM-DD, comma separated)
            <input value={value.blockoutDates} onChange={(e) => set({ blockoutDates: e.target.value })} />
          </label>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── Payment terms editor ───────────────────────────────

export interface TermsState {
  enabled: boolean;
  depositCents: number | undefined;
  depositDueDate: string;
  finalPaymentDueDate: string;
  amountPaidCents: number | undefined;
  refundability: PaymentTerms["refundability"];
  freeCancellationUntil: string;
  penalties: { fromDate: string; mode: "cents" | "pct"; value: number | undefined }[];
  notes: string;
}

export const emptyTerms = (): TermsState => ({
  enabled: false,
  depositCents: undefined,
  depositDueDate: "",
  finalPaymentDueDate: "",
  amountPaidCents: undefined,
  refundability: "unknown",
  freeCancellationUntil: "",
  penalties: [],
  notes: "",
});

export function fromTerms(t: PaymentTerms | undefined): TermsState {
  if (!t) return emptyTerms();
  return {
    enabled: true,
    depositCents: t.depositCents ?? undefined,
    depositDueDate: t.depositDueDate ?? "",
    finalPaymentDueDate: t.finalPaymentDueDate ?? "",
    amountPaidCents: t.amountPaidCents,
    refundability: t.refundability,
    freeCancellationUntil: t.freeCancellationUntil ?? "",
    penalties: t.cancellationPenalties.map((p) => ({ fromDate: p.fromDate, mode: p.pct !== undefined ? "pct" : "cents", value: p.pct ?? p.cents })),
    notes: t.notes ?? "",
  };
}

export function toTerms(t: TermsState): PaymentTerms | undefined {
  if (!t.enabled) return undefined;
  return {
    depositCents: t.depositCents ?? null,
    ...(t.depositDueDate ? { depositDueDate: t.depositDueDate } : {}),
    installments: [],
    ...(t.finalPaymentDueDate ? { finalPaymentDueDate: t.finalPaymentDueDate } : {}),
    ...(t.amountPaidCents !== undefined ? { amountPaidCents: t.amountPaidCents } : {}),
    refundability: t.refundability,
    ...(t.freeCancellationUntil ? { freeCancellationUntil: t.freeCancellationUntil } : {}),
    cancellationPenalties: t.penalties.map((p) => (p.mode === "pct" ? { fromDate: p.fromDate, pct: p.value } : { fromDate: p.fromDate, cents: p.value })),
    ...(t.notes.trim() ? { notes: t.notes.trim() } : {}),
  };
}

export function TermsFields({ value, onChange, label }: { value: TermsState; onChange: (t: TermsState) => void; label: string }) {
  const set = (patch: Partial<TermsState>) => onChange({ ...value, ...patch });
  const setPenalty = (i: number, patch: Partial<TermsState["penalties"][number]>) =>
    set({ penalties: value.penalties.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  return (
    <div className="stack">
      <label className="check">
        <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> {label}
      </label>
      {value.enabled && (
        <>
          <div className="grid3">
            <label className="field">
              Deposit (blank = unknown)
              <MoneyInput optional value={value.depositCents} onChange={(v) => set({ depositCents: v })} step={0.01} />
            </label>
            <label className="field">
              Deposit due
              <input type="date" value={value.depositDueDate} onChange={(e) => set({ depositDueDate: e.target.value })} />
            </label>
            <label className="field">
              Remaining balance due
              <input type="date" value={value.finalPaymentDueDate} onChange={(e) => set({ finalPaymentDueDate: e.target.value })} />
            </label>
            <label className="field">
              Refundability
              <select value={value.refundability} onChange={(e) => set({ refundability: e.target.value as TermsState["refundability"] })}>
                <option value="unknown">Unknown</option>
                <option value="refundable">Refundable</option>
                <option value="partially_refundable">Partially refundable</option>
                <option value="non_refundable">Non-refundable</option>
              </select>
            </label>
            <label className="field">
              Free cancellation until
              <input type="date" value={value.freeCancellationUntil} disabled={value.refundability === "non_refundable"} onChange={(e) => set({ freeCancellationUntil: e.target.value })} />
            </label>
            <label className="field">
              Amount already paid (if booked)
              <MoneyInput optional value={value.amountPaidCents} onChange={(v) => set({ amountPaidCents: v })} step={0.01} />
            </label>
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <div className="hint">Cancellation penalties (from a date on, cancelling costs a fixed amount or a % of the total):</div>
            {value.penalties.map((p, i) => (
              <div key={i} className="row" style={{ flexWrap: "nowrap" }}>
                <input type="date" aria-label="Penalty from" value={p.fromDate} onChange={(e) => setPenalty(i, { fromDate: e.target.value })} style={{ flex: 1.2 }} />
                <select aria-label="Penalty type" value={p.mode} onChange={(e) => setPenalty(i, { mode: e.target.value as "cents" | "pct", value: undefined })} style={{ flex: 1 }}>
                  <option value="cents">$ amount</option>
                  <option value="pct">% of total</option>
                </select>
                <div style={{ flex: 1 }}>
                  {p.mode === "cents" ? (
                    <MoneyInput ariaLabel="Penalty amount" value={p.value} onChange={(v) => setPenalty(i, { value: v })} />
                  ) : (
                    <NumberInput ariaLabel="Penalty percent" min={1} max={100} value={p.value} onChange={(v) => setPenalty(i, { value: v })} />
                  )}
                </div>
                <button type="button" className="link danger" aria-label="Remove penalty" onClick={() => set({ penalties: value.penalties.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="link" style={{ alignSelf: "flex-start" }} onClick={() => set({ penalties: [...value.penalties, { fromDate: "", mode: "cents", value: undefined }] })}>
              + Add penalty tier
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────── API helpers ───────────────────────────────

export async function postJson(url: string, body: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; errors: string[] }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, errors: (data as { errors?: string[] }).errors ?? [`Request failed (${res.status})`] };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, errors: [`Could not reach the server: ${String(err)}`] };
  }
}

export function Errors({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="banner banner-error small" role="alert">
      <ul className="notices">
        {errors.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    </div>
  );
}
