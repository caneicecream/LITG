"use client";

import { useMemo, useState } from "react";
import { CATALOG } from "@/data/catalog";
import { DINING_LABEL, TICKET_LABEL } from "@/domain/pricing/calculate";
import type { Audience, DiningPlan, TicketOption } from "@/domain/types";
import { MoneyInput, NumberInput } from "../ui";
import {
  emptyProvenance,
  emptyTerms,
  emptyUsage,
  Errors,
  postJson,
  ProvenanceFields,
  readDraft,
  TermsFields,
  toProvenance,
  toTerms,
  toUsage,
  UsageFields,
  type ProvenanceState,
  type TermsState,
  type UsageState,
} from "./shared";

export type EntryKind = "room_rate" | "ticket_price" | "ticket_rule" | "dining_plan_price" | "point_chart" | "point_cost" | "promotion";
const TICKETS = Object.keys(TICKET_LABEL) as TicketOption[];
const DVC = CATALOG.resorts.filter((r) => r.dvcPoints);

type Form = Record<string, unknown> & { prov: ProvenanceState; usage: UsageState; terms: TermsState };

function initialForm(kind: EntryKind): Form {
  const d = readDraft();
  const prefResort = d?.preferred.resortId ?? "pop-century";
  const resortId = kind === "point_chart" ? (DVC.find((r) => r.id === prefResort)?.id ?? DVC[0]!.id) : prefResort;
  const roomTypeId = CATALOG.resorts.find((r) => r.id === resortId)?.roomTypes[0]?.id ?? "standard";
  const common = { prov: emptyProvenance(), usage: emptyUsage(), terms: emptyTerms() };
  switch (kind) {
    case "room_rate":
      return { ...common, resortId, roomTypeId, validFrom: d?.dates.earliestArrival ?? "", validTo: d?.dates.latestDeparture ?? "", weekdays: "all", nightlyCents: undefined, taxIncluded: false };
    case "ticket_price":
      return { ...common, option: d?.preferred.ticketOption ?? "park_hopper", days: d?.tickets.parkDays || 5, age: "adult", validFrom: "", validTo: "", cents: undefined, taxIncluded: false, channel: "disney" };
    case "ticket_rule":
      return { ...common, usage: { ...emptyUsage(), enabled: true }, option: d?.preferred.ticketOption ?? "park_hopper", days: undefined, channel: "disney" };
    case "dining_plan_price":
      return { ...common, plan: "dining_plan", age: "adult", validFrom: "", validTo: "", perNightCents: undefined, taxIncluded: false };
    case "point_chart":
      return { ...common, resortId, roomTypeId, validFrom: "", validTo: "", weekdays: "all", pointsPerNight: undefined };
    case "point_cost":
      return { ...common, label: "", type: "rental", centsPerPoint: undefined, minPoints: undefined, feeCents: undefined, resortIds: [] as string[] };
    case "promotion":
      return {
        ...common,
        name: "",
        discountType: "room_percent",
        pct: 20,
        fixedCents: undefined,
        travelFrom: "",
        travelTo: "",
        rule: "all_nights",
        bookingFrom: "",
        bookingTo: "",
        resortIds: [] as string[],
        minNights: undefined,
        minTicketDays: undefined,
        requiresPackage: false,
        audience: [] as Audience[],
        terms_text: "",
      };
  }
}

const weekdaysOf = (w: unknown) => (w === "sun_thu" ? [0, 1, 2, 3, 4] : w === "fri_sat" ? [5, 6] : undefined);

function buildEntry(kind: EntryKind, f: Form): unknown {
  const provenance = toProvenance(f.prov);
  switch (kind) {
    case "room_rate":
      return { kind, resortId: f.resortId, roomTypeId: f.roomTypeId, validFrom: f.validFrom, validTo: f.validTo, daysOfWeek: weekdaysOf(f.weekdays), nightlyCents: f.nightlyCents, taxIncluded: f.taxIncluded, provenance };
    case "ticket_price":
      return { kind, option: f.option, days: f.days, age: f.age, validFrom: f.validFrom, validTo: f.validTo, cents: f.cents, taxIncluded: f.taxIncluded, channel: f.channel, ...(toUsage(f.usage) ? { usage: toUsage(f.usage) } : {}), provenance };
    case "ticket_rule":
      return { kind, option: f.option, days: f.days ?? null, channel: f.channel, usage: toUsage({ ...f.usage, enabled: true }), provenance };
    case "dining_plan_price":
      return { kind, plan: f.plan, age: f.age, validFrom: f.validFrom, validTo: f.validTo, perNightCents: f.perNightCents, taxIncluded: f.taxIncluded, provenance };
    case "point_chart":
      return { kind, resortId: f.resortId, roomTypeId: f.roomTypeId, validFrom: f.validFrom, validTo: f.validTo, daysOfWeek: weekdaysOf(f.weekdays), pointsPerNight: f.pointsPerNight, provenance };
    case "point_cost":
      return {
        kind,
        label: f.label,
        type: f.type,
        centsPerPoint: f.centsPerPoint,
        ...(f.minPoints ? { minPoints: f.minPoints } : {}),
        ...(f.feeCents ? { feeCents: f.feeCents } : {}),
        ...((f.resortIds as string[]).length ? { resortIds: f.resortIds } : {}),
        ...(toTerms(f.terms) ? { terms: toTerms(f.terms) } : {}),
        provenance,
      };
    case "promotion":
      return {
        kind,
        name: f.name,
        discount: f.discountType === "room_percent" ? { type: "room_percent", pct: f.pct } : { type: f.discountType, cents: f.fixedCents },
        travel: { from: f.travelFrom, to: f.travelTo, rule: f.rule },
        booking: f.bookingFrom && f.bookingTo ? { from: f.bookingFrom, to: f.bookingTo } : undefined,
        resortIds: (f.resortIds as string[]).length ? f.resortIds : undefined,
        minNights: f.minNights,
        minTicketDays: f.minTicketDays,
        requiresPackage: f.requiresPackage,
        audience: (f.audience as string[]).length ? f.audience : undefined,
        terms: f.terms_text,
        provenance,
      };
  }
}

const INTRO: Record<EntryKind, string> = {
  room_rate: "A nightly cash rate for a range of nights (e.g. from a booking site’s rate calendar). Taxes are estimated on top, at the resort’s county rate, unless you tick “includes tax”.",
  ticket_price: "Price per person for the whole multi-day ticket. Disney ticket prices depend on the first day of use, so give the start-date range the price applies to. For many dates at once, use Bulk ticket prices.",
  ticket_rule:
    "Usage rules for a ticket product, as stated in its terms: how many days you have to use it, expiration, blocked-out dates, park reservations. They apply to prices of that product that don’t state their own rules. Leave a field blank when the terms don’t say.",
  dining_plan_price: "Disney dining plans are sold with packages only, priced per person per night.",
  point_chart:
    "Points needed per night for a DVC villa, from the published point chart. Combined with a point cost (rental price per point, or your own points’ value) to price point stays.",
  point_cost:
    "What a DVC point costs you: a rental provider’s price per point, or your own valuation of points you own (mark that as an estimate). Record the provider’s payment and cancellation terms; point rentals are often non-refundable.",
  promotion: "Record an offer’s rules as published. It is applied only when every rule is met. Offers are assumed not to combine, and they are never applied on top of a quote.",
};

export function EntryForm({ kind, onSaved }: { kind: EntryKind; onSaved: () => void }) {
  const [f, setF] = useState<Form>(() => initialForm(kind));
  const [errors, setErrors] = useState<string[]>([]);
  const [ok, setOk] = useState<string | null>(null);
  const set = (patch: Partial<Form>) => {
    setF((prev) => ({ ...prev, ...patch }));
    setOk(null);
  };
  const s = (k: string) => String(f[k] ?? "");
  const n = (k: string) => f[k] as number | undefined;
  const resort = useMemo(() => CATALOG.resorts.find((r) => r.id === f.resortId), [f.resortId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await postJson("/api/prices", buildEntry(kind, f));
    if (!res.ok) return setErrors(res.errors);
    setErrors([]);
    setOk("Saved. Re-run the optimizer on Plan & compare to use it.");
    onSaved();
  };

  const resortRoom = (resorts = CATALOG.resorts) => (
    <>
      <label className="field">
        Resort
        <select value={s("resortId")} onChange={(e) => set({ resortId: e.target.value, roomTypeId: CATALOG.resorts.find((r) => r.id === e.target.value)?.roomTypes[0]?.id })}>
          {resorts.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name.replace("Disney's ", "")}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Room
        <select value={s("roomTypeId")} onChange={(e) => set({ roomTypeId: e.target.value })}>
          {resort?.roomTypes.map((rt) => (
            <option key={rt.id} value={rt.id}>
              {rt.name}
            </option>
          ))}
        </select>
      </label>
    </>
  );
  const dateRange = (fromLabel: string, toLabel: string) => (
    <>
      <label className="field">
        {fromLabel}
        <input type="date" value={s("validFrom")} onChange={(e) => set({ validFrom: e.target.value })} />
      </label>
      <label className="field">
        {toLabel}
        <input type="date" value={s("validTo")} onChange={(e) => set({ validTo: e.target.value })} />
      </label>
    </>
  );
  const weekdaysSel = (
    <label className="field">
      Applies to
      <select value={s("weekdays")} onChange={(e) => set({ weekdays: e.target.value })}>
        <option value="all">Every night</option>
        <option value="sun_thu">Sun–Thu nights</option>
        <option value="fri_sat">Fri–Sat nights</option>
      </select>
    </label>
  );
  const ageSel = (
    <label className="field">
      Age
      <select value={s("age")} onChange={(e) => set({ age: e.target.value })}>
        <option value="adult">Adult (10+)</option>
        <option value="child">Child (3–9)</option>
      </select>
    </label>
  );
  const taxBox = (
    <label className="check">
      <input type="checkbox" checked={!!f.taxIncluded} onChange={(e) => set({ taxIncluded: e.target.checked })} /> Price already includes tax
    </label>
  );
  const ticketSel = (
    <label className="field">
      Ticket type
      <select value={s("option")} onChange={(e) => set({ option: e.target.value })}>
        {TICKETS.map((t) => (
          <option key={t} value={t}>
            {TICKET_LABEL[t]}
          </option>
        ))}
      </select>
    </label>
  );
  const channelSel = (
    <label className="field">
      Sold by
      <select value={s("channel")} onChange={(e) => set({ channel: e.target.value })}>
        <option value="disney">Disney</option>
        <option value="third_party">Authorized third-party seller</option>
      </select>
    </label>
  );
  const resortChecks = (resorts: typeof CATALOG.resorts, label: string) => (
    <div className="stack">
      <div className="hint">{label}</div>
      <div className="row">
        {resorts.map((r) => (
          <label key={r.id} className="check small">
            <input
              type="checkbox"
              checked={(f.resortIds as string[]).includes(r.id)}
              onChange={() => {
                const cur = f.resortIds as string[];
                set({ resortIds: cur.includes(r.id) ? cur.filter((x) => x !== r.id) : [...cur, r.id] });
              }}
            />
            {r.name.replace("Disney's ", "").replace(" Resort", "")}
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <form onSubmit={submit} className="stack" style={{ gap: 14 }} aria-label={`${kind} form`}>
      <p className="small muted">{INTRO[kind]}</p>

      {kind === "room_rate" && (
        <>
          <div className="grid3">
            {resortRoom()}
            {weekdaysSel}
            {dateRange("First night", "Last night")}
            <label className="field">
              Nightly rate
              <MoneyInput optional value={n("nightlyCents")} onChange={(v) => set({ nightlyCents: v })} step={0.01} />
            </label>
          </div>
          {taxBox}
        </>
      )}

      {kind === "ticket_price" && (
        <>
          <div className="grid3">
            {ticketSel}
            <label className="field">
              Days
              <NumberInput min={1} max={10} value={n("days")} onChange={(v) => set({ days: v })} />
            </label>
            {ageSel}
            {dateRange("Start date from", "Start date to")}
            <label className="field">
              Price per person
              <MoneyInput optional value={n("cents")} onChange={(v) => set({ cents: v })} step={0.01} />
            </label>
            {channelSel}
          </div>
          {taxBox}
          <UsageFields value={f.usage} onChange={(usage) => set({ usage })} />
          <p className="hint">Third-party tickets are only used for room-only and point bookings, never inside a Disney package.</p>
        </>
      )}

      {kind === "ticket_rule" && (
        <>
          <div className="grid3">
            {ticketSel}
            <label className="field">
              Days (blank = every duration)
              <NumberInput min={1} max={10} value={n("days")} onChange={(v) => set({ days: v })} />
            </label>
            {channelSel}
          </div>
          <UsageFields value={f.usage} onChange={(usage) => set({ usage })} optional={false} />
        </>
      )}

      {kind === "dining_plan_price" && (
        <div className="grid3">
          <label className="field">
            Plan
            <select value={s("plan")} onChange={(e) => set({ plan: e.target.value as DiningPlan })}>
              <option value="quick_service_plan">{DINING_LABEL.quick_service_plan}</option>
              <option value="dining_plan">{DINING_LABEL.dining_plan}</option>
            </select>
          </label>
          {ageSel}
          <label className="field">
            Price per night
            <MoneyInput optional value={n("perNightCents")} onChange={(v) => set({ perNightCents: v })} step={0.01} />
          </label>
          {dateRange("Valid from", "Valid to")}
          <div style={{ alignSelf: "end" }}>{taxBox}</div>
        </div>
      )}

      {kind === "point_chart" && (
        <div className="grid3">
          {resortRoom(DVC)}
          {weekdaysSel}
          {dateRange("First night", "Last night")}
          <label className="field">
            Points per night
            <NumberInput min={1} max={1000} value={n("pointsPerNight")} onChange={(v) => set({ pointsPerNight: v })} />
          </label>
        </div>
      )}

      {kind === "point_cost" && (
        <>
          <div className="grid3">
            <label className="field">
              Label
              <input value={s("label")} placeholder="e.g. Rental broker quote" onChange={(e) => set({ label: e.target.value })} />
            </label>
            <label className="field">
              Kind
              <select value={s("type")} onChange={(e) => set({ type: e.target.value })}>
                <option value="rental">Rented points</option>
                <option value="owned">My own points</option>
              </select>
            </label>
            <label className="field">
              Price per point
              <MoneyInput optional value={n("centsPerPoint")} onChange={(v) => set({ centsPerPoint: v })} step={0.01} />
            </label>
            <label className="field">
              Minimum points (optional)
              <NumberInput min={1} value={n("minPoints")} onChange={(v) => set({ minPoints: v })} />
            </label>
            <label className="field">
              Fee per reservation (optional)
              <MoneyInput optional value={n("feeCents")} onChange={(v) => set({ feeCents: v })} step={0.01} />
            </label>
          </div>
          {resortChecks(DVC, "Applies to (none ticked = all DVC resorts):")}
          <TermsFields value={f.terms} onChange={(terms) => set({ terms })} label="Record the provider's payment and cancellation terms" />
        </>
      )}

      {kind === "promotion" && (
        <>
          <div className="grid3">
            <label className="field" style={{ gridColumn: "span 3" }}>
              Offer name
              <input value={s("name")} onChange={(e) => set({ name: e.target.value })} />
            </label>
            <label className="field">
              Discount
              <select value={s("discountType")} onChange={(e) => set({ discountType: e.target.value })}>
                <option value="room_percent">% off room rate</option>
                <option value="room_fixed_per_night">$ off per night</option>
                <option value="package_fixed">$ off package</option>
              </select>
            </label>
            {f.discountType === "room_percent" ? (
              <label className="field">
                Percent off
                <NumberInput min={1} max={100} value={n("pct")} onChange={(v) => set({ pct: v })} />
              </label>
            ) : (
              <label className="field">
                Amount
                <MoneyInput optional value={n("fixedCents")} onChange={(v) => set({ fixedCents: v })} />
              </label>
            )}
            <label className="field">
              Travel rule
              <select value={s("rule")} onChange={(e) => set({ rule: e.target.value })}>
                <option value="all_nights">Every night must be in the window</option>
                <option value="arrival_date">Arrival must be in the window</option>
                <option value="per_night">Discount only on nights in the window</option>
              </select>
            </label>
            <label className="field">
              Travel from
              <input type="date" value={s("travelFrom")} onChange={(e) => set({ travelFrom: e.target.value })} />
            </label>
            <label className="field">
              Travel to
              <input type="date" value={s("travelTo")} onChange={(e) => set({ travelTo: e.target.value })} />
            </label>
            <span />
            <label className="field">
              Book from (optional)
              <input type="date" value={s("bookingFrom")} onChange={(e) => set({ bookingFrom: e.target.value })} />
            </label>
            <label className="field">
              Book by (optional)
              <input type="date" value={s("bookingTo")} onChange={(e) => set({ bookingTo: e.target.value })} />
            </label>
            <span />
            <label className="field">
              Minimum nights
              <NumberInput min={1} value={n("minNights")} onChange={(v) => set({ minNights: v })} />
            </label>
            <label className="field">
              Minimum ticket days
              <NumberInput min={1} max={10} value={n("minTicketDays")} onChange={(v) => set({ minTicketDays: v })} />
            </label>
            <label className="check" style={{ alignSelf: "end" }}>
              <input type="checkbox" checked={!!f.requiresPackage} onChange={(e) => set({ requiresPackage: e.target.checked })} /> Package only
            </label>
          </div>
          {resortChecks(CATALOG.resorts.filter((r) => r.disneyOwned), "Eligible resorts (none ticked = all Disney-owned resorts):")}
          <div className="stack">
            <div className="hint">Only for (none ticked = everyone):</div>
            <div className="row">
              {(["florida_resident", "annual_passholder", "military"] as Audience[]).map((a) => (
                <label key={a} className="check small">
                  <input
                    type="checkbox"
                    checked={(f.audience as Audience[]).includes(a)}
                    onChange={() => {
                      const cur = f.audience as Audience[];
                      set({ audience: cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a] });
                    }}
                  />
                  {{ florida_resident: "Florida residents", annual_passholder: "Passholders", military: "Military" }[a]}
                </label>
              ))}
            </div>
          </div>
          <label className="field">
            Terms (paste the key conditions)
            <textarea rows={3} value={s("terms_text")} onChange={(e) => set({ terms_text: e.target.value })} />
          </label>
        </>
      )}

      <ProvenanceFields value={f.prov} onChange={(prov) => set({ prov })} />
      <Errors errors={errors} />
      <div className="row">
        <button type="submit" className="primary">
          Save
        </button>
        {ok && <span className="small save-pos">{ok}</span>}
      </div>
    </form>
  );
}
