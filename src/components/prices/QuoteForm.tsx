"use client";

import { useMemo, useState } from "react";
import { CATALOG } from "@/data/catalog";
import type { QuoteDraft } from "@/data/importers/quoteText";
import { addDays, daysBetween, todayIso } from "@/domain/dates";
import { DINING_LABEL, TICKET_LABEL } from "@/domain/pricing/calculate";
import type { BookingMethod, DiningChoice, TicketOption } from "@/domain/types";
import { MoneyInput, NumberInput } from "../ui";
import {
  emptyProvenance,
  emptyTerms,
  emptyUsage,
  Errors,
  fromProvenance,
  fromTerms,
  fromUsage,
  postJson,
  ProvenanceFields,
  readDraft,
  resortName,
  TermsFields,
  toProvenance,
  toTerms,
  toUsage,
  UsageFields,
  type ProvenanceState,
  type TermsState,
  type UsageState,
} from "./shared";

const TICKETS = Object.keys(TICKET_LABEL) as TicketOption[];

interface State {
  label: string;
  resortId: string;
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  adults: number | undefined;
  children: number | undefined;
  bookingMethod: BookingMethod;
  ticketOption: TicketOption;
  ticketDays: number | undefined;
  dining: DiningChoice;
  totalCents: number | undefined;
  taxIncluded: boolean;
  taxCents: number | undefined;
  pointsRequired: number | undefined;
  centsPerPoint: number | undefined;
  usage: UsageState;
  terms: TermsState;
  booked: boolean;
  prov: ProvenanceState;
}

export type QuoteFormMode = "new" | "duplicate" | "review";

function initialState(initial: QuoteDraft | undefined, mode: QuoteFormMode): State {
  if (initial) {
    const s: State = {
      label: initial.label,
      resortId: initial.resortId,
      roomTypeId: initial.roomTypeId,
      checkIn: initial.checkIn,
      checkOut: addDays(initial.checkIn, initial.nights),
      adults: initial.adults,
      children: initial.children,
      bookingMethod: initial.bookingMethod,
      ticketOption: initial.ticket?.option ?? "park_hopper",
      ticketDays: initial.ticket?.days ?? 5,
      dining: initial.dining,
      totalCents: initial.totalCents,
      taxIncluded: initial.taxIncluded,
      taxCents: initial.taxCents,
      pointsRequired: initial.points?.pointsRequired,
      centsPerPoint: initial.points?.centsPerPoint,
      usage: fromUsage(initial.ticket?.usage),
      terms: fromTerms(initial.terms),
      booked: !!initial.booked,
      prov: fromProvenance(initial.provenance),
    };
    if (mode === "duplicate") {
      // A copy is a new observation: the price must be entered again, and it isn't a booking.
      // The old label usually names the old dates or resort; let a new one be generated from the edited details.
      s.label = "";
      s.totalCents = undefined;
      s.taxCents = undefined;
      s.booked = false;
      s.terms = { ...s.terms, amountPaidCents: undefined };
      s.prov = { ...s.prov, observedAt: todayIso() };
    }
    return s;
  }
  const d = readDraft();
  const resortId = d?.preferred.resortId ?? "pop-century";
  const resort = CATALOG.resorts.find((r) => r.id === resortId);
  const checkIn = d?.preferred.arrival ?? "";
  return {
    label: "",
    resortId,
    roomTypeId: d?.preferred.roomTypeId ?? resort?.roomTypes[0]?.id ?? "standard",
    checkIn,
    checkOut: checkIn && d?.preferred.nights ? addDays(checkIn, d.preferred.nights) : "",
    adults: d?.party.adults ?? 2,
    children: d?.party.children ?? 0,
    bookingMethod: resort?.disneyOwned ? "package" : "separate",
    ticketOption: d?.preferred.ticketOption ?? "park_hopper",
    ticketDays: d?.tickets.parkDays || 5,
    dining: "out_of_pocket",
    totalCents: undefined,
    taxIncluded: true,
    taxCents: undefined,
    pointsRequired: undefined,
    centsPerPoint: undefined,
    usage: emptyUsage(),
    terms: emptyTerms(),
    booked: false,
    prov: emptyProvenance("Walt Disney World website quote"),
  };
}

function toEntry(s: State): unknown {
  const pkg = s.bookingMethod === "package";
  const nights = s.checkIn && s.checkOut ? daysBetween(s.checkIn, s.checkOut) : undefined;
  return {
    kind: "stay_quote",
    label: s.label.trim() || `${resortName(s.resortId)} ${pkg ? "package" : s.bookingMethod === "points" ? "point rental" : "room"} ${s.checkIn}`,
    resortId: s.resortId,
    roomTypeId: s.roomTypeId,
    checkIn: s.checkIn,
    nights,
    adults: s.adults,
    children: s.children,
    bookingMethod: s.bookingMethod,
    ...(pkg ? { ticket: { option: s.ticketOption, days: s.ticketDays, ...(toUsage(s.usage) ? { usage: toUsage(s.usage) } : {}) } } : {}),
    dining: pkg ? s.dining : "out_of_pocket",
    totalCents: s.totalCents,
    taxIncluded: s.taxIncluded,
    ...(!s.taxIncluded && s.taxCents !== undefined ? { taxCents: s.taxCents } : {}),
    ...(s.bookingMethod === "points" && s.pointsRequired && s.centsPerPoint ? { points: { pointsRequired: s.pointsRequired, centsPerPoint: s.centsPerPoint } } : {}),
    ...(toTerms(s.terms) ? { terms: toTerms(s.terms) } : {}),
    ...(s.booked ? { booked: true } : {}),
    provenance: toProvenance(s.prov),
  };
}

export function QuoteForm({ initial, mode = "new", onSaved, onCancel }: { initial?: QuoteDraft; mode?: QuoteFormMode; onSaved: () => void; onCancel?: () => void }) {
  const [s, setS] = useState<State>(() => initialState(initial, mode));
  const [errors, setErrors] = useState<string[]>([]);
  const [ok, setOk] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<State>) => {
    setS((prev) => ({ ...prev, ...patch }));
    setOk(null);
  };
  const resort = useMemo(() => CATALOG.resorts.find((r) => r.id === s.resortId), [s.resortId]);
  const nights = s.checkIn && s.checkOut ? daysBetween(s.checkIn, s.checkOut) : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (s.checkIn && s.checkOut && (nights ?? 0) < 1) {
      setErrors(["Check-out must be after check-in"]);
      return;
    }
    setSaving(true);
    const res = await postJson("/api/prices", toEntry(s));
    setSaving(false);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors([]);
    setOk(mode === "duplicate" ? "Saved as a new quote (the original is unchanged)." : "Saved. Re-run the optimizer on Plan & compare to use it.");
    onSaved();
  };

  return (
    <form onSubmit={submit} className="stack" style={{ gap: 14 }} aria-label="Quote form">
      {mode === "duplicate" && (
        <div className="banner banner-info small">
          Duplicating “{initial?.label}”. Change what differs (dates, resort, room, tickets, booking type) and enter the new quoted total. The original quote is kept as it is.
        </div>
      )}
      <div className="grid3">
        <label className="field" style={{ gridColumn: "span 3" }}>
          Label (optional)
          <input value={s.label} placeholder="e.g. Pop Century package, Jan 17" onChange={(e) => set({ label: e.target.value })} />
        </label>
        <label className="field">
          Resort
          <select
            value={s.resortId}
            onChange={(e) => {
              const r = CATALOG.resorts.find((x) => x.id === e.target.value)!;
              set({
                resortId: r.id,
                roomTypeId: r.roomTypes[0]!.id,
                bookingMethod: s.bookingMethod === "package" && !r.disneyOwned ? "separate" : s.bookingMethod === "points" && !r.dvcPoints ? "separate" : s.bookingMethod,
              });
            }}
          >
            {CATALOG.resorts.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name.replace("Disney's ", "")}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Room
          <select value={s.roomTypeId} onChange={(e) => set({ roomTypeId: e.target.value })}>
            {resort?.roomTypes.map((rt) => (
              <option key={rt.id} value={rt.id}>
                {rt.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Booking type
          <select value={s.bookingMethod} onChange={(e) => set({ bookingMethod: e.target.value as BookingMethod })}>
            {resort?.disneyOwned && <option value="package">Disney package (room + tickets)</option>}
            <option value="separate">Room only</option>
            {resort?.dvcPoints && <option value="points">DVC point rental</option>}
          </select>
        </label>
        <label className="field">
          Check-in
          <input type="date" value={s.checkIn} onChange={(e) => set({ checkIn: e.target.value })} />
        </label>
        <label className="field">
          Check-out {nights !== null && nights > 0 && <span className="muted">({nights} nights)</span>}
          <input type="date" value={s.checkOut} onChange={(e) => set({ checkOut: e.target.value })} />
        </label>
        <div className="grid2">
          <label className="field">
            Adults
            <NumberInput min={1} value={s.adults} onChange={(v) => set({ adults: v })} />
          </label>
          <label className="field">
            Children 3–9
            <NumberInput min={0} value={s.children} onChange={(v) => set({ children: v })} />
          </label>
        </div>
        {s.bookingMethod === "package" && (
          <>
            <label className="field">
              Tickets included
              <select value={s.ticketOption} onChange={(e) => set({ ticketOption: e.target.value as TicketOption })}>
                {TICKETS.map((t) => (
                  <option key={t} value={t}>
                    {TICKET_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Ticket days
              <NumberInput min={1} max={10} value={s.ticketDays} onChange={(v) => set({ ticketDays: v })} />
            </label>
            <label className="field">
              Dining included
              <select value={s.dining} onChange={(e) => set({ dining: e.target.value as DiningChoice })}>
                {(Object.keys(DINING_LABEL) as DiningChoice[]).map((d) => (
                  <option key={d} value={d}>
                    {d === "out_of_pocket" ? "No dining plan" : DINING_LABEL[d]}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {s.bookingMethod === "points" && (
          <>
            <label className="field">
              Points (optional)
              <NumberInput min={1} value={s.pointsRequired} onChange={(v) => set({ pointsRequired: v })} />
            </label>
            <label className="field">
              Price per point (optional)
              <MoneyInput optional value={s.centsPerPoint} onChange={(v) => set({ centsPerPoint: v })} step={0.01} />
            </label>
          </>
        )}
      </div>

      <div className="grid3">
        <label className="field">
          Quoted total
          <MoneyInput optional value={s.totalCents} onChange={(v) => set({ totalCents: v })} step={0.01} />
        </label>
        <label className="field">
          Taxes
          <select value={s.taxIncluded ? "yes" : "no"} onChange={(e) => set({ taxIncluded: e.target.value === "yes" })}>
            <option value="yes">Total includes taxes</option>
            <option value="no">Total is before taxes</option>
          </select>
        </label>
        {!s.taxIncluded && (
          <label className="field">
            Taxes shown on the quote (optional)
            <MoneyInput optional value={s.taxCents} onChange={(v) => set({ taxCents: v })} step={0.01} />
          </label>
        )}
      </div>
      {!s.taxIncluded && s.taxCents === undefined && (
        <p className="hint">
          {s.bookingMethod === "package"
            ? "Without a tax amount, a pre-tax package can't be fully priced (its taxes can't be split between room and tickets)."
            : s.bookingMethod === "points"
              ? "Point reservations are assumed to carry no lodging tax."
              : `Taxes will be estimated at ${resort?.taxJurisdictionId === "osceola-fl" ? "Osceola" : "Orange"} County's lodging rate and labelled as estimated.`}
        </p>
      )}

      {s.bookingMethod === "package" && (
        <div className="stack" style={{ gap: 6 }}>
          <h3>Ticket usage (optional)</h3>
          <UsageFields value={s.usage} onChange={(usage) => set({ usage })} />
        </div>
      )}

      <div className="stack" style={{ gap: 6 }}>
        <h3>Payment and cancellation</h3>
        <TermsFields value={s.terms} onChange={(terms) => set({ terms })} label="Record deposit, due dates and cancellation terms" />
        <label className="check">
          <input type="checkbox" checked={s.booked} onChange={(e) => set({ booked: e.target.checked, terms: e.target.checked ? { ...s.terms, enabled: true } : s.terms })} /> This is a reservation I already hold
        </label>
        {s.booked && <p className="hint">Savings against this reservation will be reduced by what cancelling it would cost, and not claimed when that cost is unknown.</p>}
      </div>

      <ProvenanceFields value={s.prov} onChange={(prov) => set({ prov })} />
      <Errors errors={errors} />
      <div className="row">
        <button type="submit" className="primary" disabled={saving}>
          {mode === "duplicate" ? "Save as new quote" : "Save quote"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        {ok && <span className="small save-pos">{ok}</span>}
      </div>
    </form>
  );
}
