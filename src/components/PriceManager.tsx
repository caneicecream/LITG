"use client";

import { useEffect, useMemo, useState } from "react";
import { CATALOG } from "@/data/catalog";
import type { UserPriceEntry } from "@/data/store";
import { formatShortDate, todayIso } from "@/domain/dates";
import { formatCents } from "@/domain/money";
import { DINING_LABEL, TICKET_LABEL } from "@/domain/pricing/calculate";
import { effectiveStatus, type Provenance } from "@/domain/provenance";
import type { Audience, BookingMethod, DiningChoice, DiningPlan, TicketOption, TripRequest } from "@/domain/types";
import { MoneyInput, NumberInput, StatusChip, STATUS_HELP } from "./ui";

type Tab = "stay_quote" | "room_rate" | "ticket_price" | "dining_plan_price" | "promotion";
const TABS: { id: Tab; label: string }[] = [
  { id: "stay_quote", label: "Stay / package quote" },
  { id: "room_rate", label: "Nightly room rate" },
  { id: "ticket_price", label: "Ticket price" },
  { id: "dining_plan_price", label: "Dining plan price" },
  { id: "promotion", label: "Promotion" },
];
const TICKETS = Object.keys(TICKET_LABEL) as TicketOption[];
const resortName = (id: string) => CATALOG.resorts.find((r) => r.id === id)?.name.replace("Disney's ", "") ?? id;
const roomName = (rid: string, id: string) => CATALOG.resorts.find((r) => r.id === rid)?.roomTypes.find((x) => x.id === id)?.name ?? id;

function readDraft(): TripRequest | null {
  try {
    const raw = localStorage.getItem("dvo:draft-request");
    return raw ? (JSON.parse(raw) as TripRequest) : null;
  } catch {
    return null;
  }
}

export function PriceManager() {
  const [entries, setEntries] = useState<UserPriceEntry[] | null>(null);
  const [tab, setTab] = useState<Tab>("stay_quote");
  const load = () =>
    fetch("/api/prices")
      .then((r) => r.json())
      .then((b) => setEntries(b.entries));
  useEffect(() => {
    load();
  }, []);

  const remove = async (id: string) => {
    if (!confirm("Delete this price entry?")) return;
    await fetch(`/api/prices?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="stack" style={{ gap: 16, maxWidth: 1100 }}>
      <div className="stack" style={{ gap: 6 }}>
        <h1>Price data</h1>
        <p className="muted">
          Real prices make the optimizer useful. Copy totals from booking pages and quotes (for example the Walt Disney World website or an
          authorized seller) into the forms below. The optimizer compares your real prices exactly, ranks them separately from illustrative demo
          data, and marks entries older than your staleness setting as <StatusChip status="stale" />.
        </p>
      </div>

      <div className="card card-pad stack">
        <h2>How prices are labelled</h2>
        <dl className="kv">
          {(Object.keys(STATUS_HELP) as (keyof typeof STATUS_HELP)[]).map((s) => (
            <FragmentKV key={s} k={<StatusChip status={s} />} v={STATUS_HELP[s]} />
          ))}
        </dl>
        <p className="small muted">
          Entries you add can be <b>Manually entered</b> (copied from a real quote) or <b>Estimated</b> (your own estimate). <b>Verified</b> is
          reserved for vetted automated data sources, none of which is connected yet. When several prices cover the same item, the most
          trustworthy one wins, and among equally trusted prices the most recent wins.
        </p>
      </div>

      <div className="card card-pad">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : undefined} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <EntryForm key={tab} kind={tab} onSaved={load} />
      </div>

      <div className="card">
        <div className="card-pad" style={{ paddingBottom: 8 }}>
          <h2>Your prices ({entries?.length ?? 0})</h2>
        </div>
        {!entries ? (
          <div className="empty">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="empty">No prices yet. Add a quote above. Until then, only illustrative demo data is available.</div>
        ) : (
          <div className="table-wrap">
            <table className="cmp">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>What</th>
                  <th className="r">Price</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="small">{TABS.find((t) => t.id === e.kind)?.label}</td>
                    <td className="small">{describe(e)}</td>
                    <td className="r num">{price(e)}</td>
                    <td>
                      <StatusChip status={effectiveStatus(e.provenance, todayIso(), 14)} />
                      <div className="small muted">seen {formatShortDate(e.provenance.observedAt)}</div>
                    </td>
                    <td className="small">
                      {e.provenance.sourceUrl ? (
                        <a href={e.provenance.sourceUrl} target="_blank" rel="noreferrer">
                          {e.provenance.source}
                        </a>
                      ) : (
                        e.provenance.source
                      )}
                      {e.provenance.notes && <div className="muted">{e.provenance.notes}</div>}
                    </td>
                    <td>
                      <button className="link danger" onClick={() => remove(e.id)}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function FragmentKV({ k, v }: { k: React.ReactNode; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className="small">{v}</dd>
    </>
  );
}

function describe(e: UserPriceEntry): string {
  switch (e.kind) {
    case "stay_quote":
      return `${e.label} — ${resortName(e.resortId)}, ${roomName(e.resortId, e.roomTypeId)}; ${formatShortDate(e.checkIn)}, ${e.nights} nights; ${e.adults} adults${e.children ? ` + ${e.children} children` : ""}; ${
        e.bookingMethod === "package" ? `package with ${e.ticket?.days}-day ${TICKET_LABEL[e.ticket!.option]}${e.dining !== "out_of_pocket" ? ` + ${DINING_LABEL[e.dining]}` : ""}` : "room only"
      }`;
    case "room_rate":
      return `${resortName(e.resortId)}, ${roomName(e.resortId, e.roomTypeId)}; nights ${formatShortDate(e.validFrom)} – ${formatShortDate(e.validTo)}${e.daysOfWeek ? ` (${weekdayLabel(e.daysOfWeek)})` : ""}${e.taxIncluded ? "; incl. tax" : ""}`;
    case "ticket_price":
      return `${e.days}-day ${TICKET_LABEL[e.option]}, ${e.age}; start ${formatShortDate(e.validFrom)} – ${formatShortDate(e.validTo)}; ${e.channel === "third_party" ? "third-party seller" : "Disney"}${e.taxIncluded ? "; incl. tax" : ""}`;
    case "dining_plan_price":
      return `${DINING_LABEL[e.plan]}, ${e.age}; ${formatShortDate(e.validFrom)} – ${formatShortDate(e.validTo)}${e.taxIncluded ? "; incl. tax" : ""}`;
    case "promotion":
      return `${e.name}; travel ${formatShortDate(e.travel.from)} – ${formatShortDate(e.travel.to)}${e.requiresPackage ? "; package only" : ""}`;
  }
}

function price(e: UserPriceEntry): string {
  switch (e.kind) {
    case "stay_quote":
      return formatCents(e.totalCents);
    case "room_rate":
      return `${formatCents(e.nightlyCents)}/night`;
    case "ticket_price":
      return `${formatCents(e.cents)}/person`;
    case "dining_plan_price":
      return `${formatCents(e.perNightCents)}/night`;
    case "promotion":
      return e.discount.type === "room_percent" ? `${e.discount.pct}% off room` : `${formatCents(e.discount.cents)} off${e.discount.type === "room_fixed_per_night" ? "/night" : ""}`;
  }
}

function weekdayLabel(days: number[]): string {
  const k = [...days].sort().join(",");
  if (k === "0,1,2,3,4") return "Sun–Thu";
  if (k === "5,6") return "Fri–Sat";
  return days.map((d) => "SMTWTFS"[d]).join("");
}

// ─────────────────────────────── Entry form ───────────────────────────────

type Form = Record<string, unknown>;

function initialForm(kind: Tab): Form {
  const d = readDraft();
  const resortId = d?.preferred.resortId ?? "pop-century";
  const roomTypeId = d?.preferred.roomTypeId ?? CATALOG.resorts.find((r) => r.id === resortId)?.roomTypes[0]?.id ?? "standard";
  const base = { status: "manual", source: "", sourceUrl: "", observedAt: todayIso(), notes: "" };
  switch (kind) {
    case "stay_quote":
      return {
        ...base,
        source: "Walt Disney World website quote",
        label: "",
        resortId,
        roomTypeId,
        checkIn: d?.preferred.arrival ?? "",
        nights: d?.preferred.nights ?? 6,
        adults: d?.party.adults ?? 2,
        children: d?.party.children ?? 0,
        bookingMethod: "package",
        ticketOption: d?.preferred.ticketOption ?? "park_hopper",
        ticketDays: d?.tickets.parkDays || 5,
        dining: d?.preferred.dining ?? "out_of_pocket",
        totalCents: undefined,
      };
    case "room_rate":
      return { ...base, resortId, roomTypeId, validFrom: d?.dates.earliestArrival ?? "", validTo: d?.dates.latestDeparture ?? "", weekdays: "all", nightlyCents: undefined, taxIncluded: false };
    case "ticket_price":
      return { ...base, option: d?.preferred.ticketOption ?? "park_hopper", days: d?.tickets.parkDays || 5, age: "adult", validFrom: "", validTo: "", cents: undefined, taxIncluded: false, channel: "disney" };
    case "dining_plan_price":
      return { ...base, plan: "dining_plan", age: "adult", validFrom: "", validTo: "", perNightCents: undefined, taxIncluded: false };
    case "promotion":
      return {
        ...base,
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
        terms: "",
      };
  }
}

function buildEntry(kind: Tab, f: Form): unknown {
  const provenance: Provenance = {
    status: f.status as Provenance["status"],
    source: String(f.source ?? ""),
    observedAt: String(f.observedAt),
    ...(f.sourceUrl ? { sourceUrl: String(f.sourceUrl) } : {}),
    ...(f.notes ? { notes: String(f.notes) } : {}),
  };
  switch (kind) {
    case "stay_quote": {
      const pkg = f.bookingMethod === "package";
      return {
        kind,
        label: String(f.label || `${resortName(String(f.resortId))} ${pkg ? "package" : "room"} quote`),
        resortId: f.resortId,
        roomTypeId: f.roomTypeId,
        checkIn: f.checkIn,
        nights: f.nights,
        adults: f.adults,
        children: f.children,
        bookingMethod: f.bookingMethod,
        ticket: pkg ? { option: f.ticketOption, days: f.ticketDays } : undefined,
        dining: pkg ? f.dining : "out_of_pocket",
        totalCents: f.totalCents,
        provenance,
      };
    }
    case "room_rate":
      return {
        kind,
        resortId: f.resortId,
        roomTypeId: f.roomTypeId,
        validFrom: f.validFrom,
        validTo: f.validTo,
        daysOfWeek: f.weekdays === "sun_thu" ? [0, 1, 2, 3, 4] : f.weekdays === "fri_sat" ? [5, 6] : undefined,
        nightlyCents: f.nightlyCents,
        taxIncluded: f.taxIncluded,
        provenance,
      };
    case "ticket_price":
      return { kind, option: f.option, days: f.days, age: f.age, validFrom: f.validFrom, validTo: f.validTo, cents: f.cents, taxIncluded: f.taxIncluded, channel: f.channel, provenance };
    case "dining_plan_price":
      return { kind, plan: f.plan, age: f.age, validFrom: f.validFrom, validTo: f.validTo, perNightCents: f.perNightCents, taxIncluded: f.taxIncluded, provenance };
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
        terms: f.terms,
        provenance,
      };
  }
}

function EntryForm({ kind, onSaved }: { kind: Tab; onSaved: () => void }) {
  const [f, setF] = useState<Form>(() => initialForm(kind));
  const [errors, setErrors] = useState<string[]>([]);
  const [ok, setOk] = useState<string | null>(null);
  const set = (patch: Form) => {
    setF((prev) => ({ ...prev, ...patch }));
    setOk(null);
  };
  const s = (k: string) => String(f[k] ?? "");
  const n = (k: string) => f[k] as number | undefined;
  const resort = useMemo(() => CATALOG.resorts.find((r) => r.id === f.resortId), [f.resortId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch("/api/prices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(buildEntry(kind, f)) });
    const body = await res.json();
    if (!res.ok) {
      setErrors(body.errors ?? ["Could not save"]);
      return;
    }
    setErrors([]);
    setOk("Saved. Re-run the optimizer on Plan & compare to use it.");
    onSaved();
  };

  const resortRoom = (
    <>
      <label className="field">
        Resort
        <select value={s("resortId")} onChange={(e) => set({ resortId: e.target.value, roomTypeId: CATALOG.resorts.find((r) => r.id === e.target.value)?.roomTypes[0]?.id })}>
          {CATALOG.resorts.map((r) => (
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

  return (
    <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
      {kind === "stay_quote" && (
        <>
          <p className="small muted">
            Enter the <b>total including taxes</b> exactly as quoted. Package quotes replace the room, ticket and (if included) dining components,
            so nothing is double-counted. The quote is matched only to the exact same resort, room, dates, party, tickets and dining.
          </p>
          <div className="grid3">
            <label className="field" style={{ gridColumn: "span 3" }}>
              Label (optional)
              <input value={s("label")} placeholder="e.g. Pop Century package, Jan 17" onChange={(e) => set({ label: e.target.value })} />
            </label>
            {resortRoom}
            <label className="field">
              Booking type
              <select value={s("bookingMethod")} onChange={(e) => set({ bookingMethod: e.target.value as BookingMethod })}>
                <option value="package">Package (room + tickets)</option>
                <option value="separate">Room only</option>
              </select>
            </label>
            <label className="field">
              Check-in
              <input type="date" value={s("checkIn")} onChange={(e) => set({ checkIn: e.target.value })} />
            </label>
            <label className="field">
              Nights
              <NumberInput min={1} max={30} value={n("nights")} onChange={(v) => set({ nights: v })} />
            </label>
            <div className="grid2">
              <label className="field">
                Adults
                <NumberInput min={1} value={n("adults")} onChange={(v) => set({ adults: v })} />
              </label>
              <label className="field">
                Children 3–9
                <NumberInput min={0} value={n("children")} onChange={(v) => set({ children: v })} />
              </label>
            </div>
            {f.bookingMethod === "package" && (
              <>
                <label className="field">
                  Tickets included
                  <select value={s("ticketOption")} onChange={(e) => set({ ticketOption: e.target.value as TicketOption })}>
                    {TICKETS.map((t) => (
                      <option key={t} value={t}>
                        {TICKET_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Ticket days
                  <NumberInput min={1} max={10} value={n("ticketDays")} onChange={(v) => set({ ticketDays: v })} />
                </label>
                <label className="field">
                  Dining included
                  <select value={s("dining")} onChange={(e) => set({ dining: e.target.value as DiningChoice })}>
                    {(Object.keys(DINING_LABEL) as DiningChoice[]).map((d) => (
                      <option key={d} value={d}>
                        {d === "out_of_pocket" ? "No dining plan" : DINING_LABEL[d]}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label className="field">
              Total incl. taxes
              <MoneyInput optional value={n("totalCents")} onChange={(v) => set({ totalCents: v })} step={0.01} />
            </label>
          </div>
        </>
      )}

      {kind === "room_rate" && (
        <>
          <p className="small muted">A nightly rate for a range of nights (e.g. from a booking site’s rate calendar). Taxes are estimated on top unless you tick “includes tax”.</p>
          <div className="grid3">
            {resortRoom}
            <label className="field">
              Applies to
              <select value={s("weekdays")} onChange={(e) => set({ weekdays: e.target.value })}>
                <option value="all">Every night</option>
                <option value="sun_thu">Sun–Thu nights</option>
                <option value="fri_sat">Fri–Sat nights</option>
              </select>
            </label>
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
          <p className="small muted">Price per person for the whole multi-day ticket. Disney ticket prices depend on the first day of use, so give the start-date range the price applies to.</p>
          <div className="grid3">
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
            <label className="field">
              Sold by
              <select value={s("channel")} onChange={(e) => set({ channel: e.target.value })}>
                <option value="disney">Disney</option>
                <option value="third_party">Authorized third-party seller</option>
              </select>
            </label>
          </div>
          {taxBox}
          <p className="hint">Third-party tickets are only used for room-only bookings, never inside a Disney package.</p>
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

      {kind === "promotion" && (
        <>
          <p className="small muted">
            Record an offer’s rules as published. It is applied only when every rule is met. Offers are assumed not to combine, and they are
            never applied on top of a quote (quotes already include any offer applied at the time).
          </p>
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
          <div className="stack">
            <div className="hint">Eligible resorts (none ticked = all Disney resorts):</div>
            <div className="row">
              {CATALOG.resorts
                .filter((r) => r.onProperty)
                .map((r) => (
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
            <textarea rows={3} value={s("terms")} onChange={(e) => set({ terms: e.target.value })} />
          </label>
        </>
      )}

      <fieldset className="card-pad" style={{ border: "1px dashed var(--border)", borderRadius: 8 }}>
        <legend className="small muted" style={{ padding: "0 6px" }}>
          Where did this price come from?
        </legend>
        <div className="grid3">
          <label className="field">
            Status
            <select value={s("status")} onChange={(e) => set({ status: e.target.value })}>
              <option value="manual">Copied from a real quote/page</option>
              <option value="estimated">My own estimate</option>
            </select>
          </label>
          <label className="field">
            Source
            <input value={s("source")} placeholder="e.g. disneyworld.com quote" onChange={(e) => set({ source: e.target.value })} />
          </label>
          <label className="field">
            Observed on
            <input type="date" value={s("observedAt")} onChange={(e) => set({ observedAt: e.target.value })} />
          </label>
          <label className="field" style={{ gridColumn: "span 2" }}>
            Link (optional)
            <input type="url" value={s("sourceUrl")} onChange={(e) => set({ sourceUrl: e.target.value })} />
          </label>
          <label className="field">
            Notes (optional)
            <input value={s("notes")} onChange={(e) => set({ notes: e.target.value })} />
          </label>
        </div>
      </fieldset>

      {errors.length > 0 && (
        <div className="banner banner-error small">
          <ul className="notices">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="row">
        <button type="submit" className="primary">
          Save price
        </button>
        {ok && <span className="small save-pos">{ok}</span>}
      </div>
    </form>
  );
}
