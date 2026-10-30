"use client";

import { Fragment } from "react";
import { CATALOG, TIER_LABEL } from "@/data/catalog";
import { DINING_LABEL, TICKET_LABEL } from "@/domain/pricing/calculate";
import { WEIGHT_LABEL } from "@/domain/optimizer/scoring";
import { availableParkDays } from "@/domain/optimizer/constraints";
import type { Audience, OtherExpense, TicketOption, TripRequest, Tristate, ValueWeights } from "@/domain/types";
import { MoneyInput, NumberInput } from "./ui";

type Props = { request: TripRequest; onChange: (r: TripRequest) => void };

const TIER_ORDER = ["value", "moderate", "deluxe", "deluxe_villa", "partner", "off_property"] as const;
const TICKETS = Object.keys(TICKET_LABEL) as TicketOption[];

export function TripForm({ request: r, onChange }: Props) {
  const set = <K extends keyof TripRequest>(key: K, value: Partial<TripRequest[K]>) =>
    onChange({ ...r, [key]: { ...(r[key] as object), ...(value as object) } as TripRequest[K] });

  const prefResort = CATALOG.resorts.find((x) => x.id === r.preferred.resortId);
  const allowedAll = r.resorts.allowedResortIds.length === 0;
  const isAllowed = (id: string) => allowedAll || r.resorts.allowedResortIds.includes(id);
  const toggleAllowed = (id: string) => {
    const current = allowedAll ? CATALOG.resorts.map((x) => x.id) : r.resorts.allowedResortIds;
    const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    set("resorts", { allowedResortIds: next.length === CATALOG.resorts.length ? [] : next });
  };
  const togglePreferred = (id: string) => {
    const cur = r.resorts.preferredResortIds;
    set("resorts", { preferredResortIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };
  const toggleTicket = (t: TicketOption) => {
    const cur = r.tickets.allowedOptions;
    set("tickets", { allowedOptions: cur.includes(t) ? cur.filter((x) => x !== t) : TICKETS.filter((x) => x === t || cur.includes(x)) });
  };
  const maxParkDays = availableParkDays(r.dates.maxNights, r.tickets.parkOnArrivalDay, r.tickets.parkOnDepartureDay);

  const setExpense = (i: number, patch: Partial<OtherExpense>) =>
    onChange({ ...r, otherExpenses: r.otherExpenses.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  return (
    <div>
      <div className="section">
        <div className="section-title">Travelers</div>
        <div className="grid3">
          <label className="field">
            Adults (10+)
            <NumberInput min={1} max={10} value={r.party.adults} onChange={(v) => set("party", { adults: v ?? 1 })} />
          </label>
          <label className="field">
            Children 3–9
            <NumberInput min={0} max={10} value={r.party.children} onChange={(v) => set("party", { children: v ?? 0 })} />
          </label>
          <label className="field">
            Under 3
            <NumberInput min={0} max={4} value={r.party.infants} onChange={(v) => set("party", { infants: v ?? 0 })} />
          </label>
        </div>
      </div>

      <div className="section">
        <div className="section-title">Flexible dates</div>
        <div className="grid2">
          <label className="field">
            Earliest arrival
            <input type="date" value={r.dates.earliestArrival} onChange={(e) => set("dates", { earliestArrival: e.target.value })} />
          </label>
          <label className="field">
            Latest departure
            <input type="date" value={r.dates.latestDeparture} onChange={(e) => set("dates", { latestDeparture: e.target.value })} />
          </label>
          <label className="field">
            Min nights
            <NumberInput min={1} max={14} value={r.dates.minNights} onChange={(v) => set("dates", { minNights: v ?? 1 })} />
          </label>
          <label className="field">
            Max nights
            <NumberInput min={1} max={14} value={r.dates.maxNights} onChange={(v) => set("dates", { maxNights: v ?? 1 })} />
          </label>
        </div>
      </div>

      <div className="section">
        <div className="section-title">Park tickets</div>
        <div className="grid2">
          <label className="field">
            Park days (required)
            <NumberInput min={0} max={10} value={r.tickets.parkDays} onChange={(v) => set("tickets", { parkDays: v ?? 0 })} />
          </label>
          <div className="hint" style={{ alignSelf: "end" }}>
            Up to {maxParkDays} park day{maxParkDays === 1 ? "" : "s"} fit in a {r.dates.maxNights}-night stay with these settings.
          </div>
        </div>
        {r.tickets.parkDays > 0 && (
          <div className="stack" style={{ marginTop: 10 }}>
            <div className="hint">Accepted ticket types (hard requirement):</div>
            {TICKETS.map((t) => (
              <label key={t} className="check">
                <input type="checkbox" checked={r.tickets.allowedOptions.includes(t)} onChange={() => toggleTicket(t)} />
                {TICKET_LABEL[t]}
              </label>
            ))}
            <label className="check">
              <input type="checkbox" checked={r.tickets.parkOnArrivalDay} onChange={(e) => set("tickets", { parkOnArrivalDay: e.target.checked })} />
              Use a park day on arrival day
            </label>
            <label className="check">
              <input type="checkbox" checked={r.tickets.parkOnDepartureDay} onChange={(e) => set("tickets", { parkOnDepartureDay: e.target.checked })} />
              Use a park day on departure day
            </label>
            <label className="check">
              <input type="checkbox" checked={r.tickets.allowThirdParty} onChange={(e) => set("tickets", { allowThirdParty: e.target.checked })} />
              Consider authorized third-party ticket prices you entered
            </label>
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-title">Resorts</div>
        <label className="check" style={{ marginBottom: 4 }}>
          <input type="checkbox" checked={r.resorts.requireOnProperty} onChange={(e) => set("resorts", { requireOnProperty: e.target.checked })} />
          Must stay at a Disney-owned resort
        </label>
        <label className="check" style={{ marginBottom: 8 }}>
          <input type="checkbox" checked={!!r.resorts.considerPoints} onChange={(e) => set("resorts", { considerPoints: e.target.checked })} />
          Also consider DVC villas booked with points
        </label>
        <div className="row small" style={{ marginBottom: 6 }}>
          <button type="button" className="link" onClick={() => set("resorts", { allowedResortIds: [] })}>
            Allow all
          </button>
          {TIER_ORDER.map((t) => (
            <button
              key={t}
              type="button"
              className="link"
              onClick={() => set("resorts", { allowedResortIds: CATALOG.resorts.filter((x) => x.tier === t).map((x) => x.id) })}
            >
              Only {TIER_LABEL[t]}
            </button>
          ))}
        </div>
        <table className="resort-table">
          <thead>
            <tr>
              <th>Resort</th>
              <th className="c">Allowed</th>
              <th className="c">Preferred</th>
            </tr>
          </thead>
          <tbody>
            {TIER_ORDER.map((tier) => (
              <Fragment key={tier}>
                <tr>
                  <th colSpan={3} style={{ paddingTop: 8 }}>
                    {TIER_LABEL[tier]}
                  </th>
                </tr>
                {CATALOG.resorts
                  .filter((x) => x.tier === tier)
                  .map((x) => {
                    const blocked = r.resorts.requireOnProperty && !x.disneyOwned;
                    return (
                      <tr key={x.id} style={{ opacity: blocked ? 0.45 : 1 }}>
                        <td>{x.name.replace("Disney's ", "").replace("Walt Disney World ", "")}</td>
                        <td className="c">
                          <input type="checkbox" aria-label={`Allow ${x.name}`} checked={isAllowed(x.id) && !blocked} disabled={blocked} onChange={() => toggleAllowed(x.id)} />
                        </td>
                        <td className="c">
                          <input type="checkbox" aria-label={`Prefer ${x.name}`} checked={r.resorts.preferredResortIds.includes(x.id)} onChange={() => togglePreferred(x.id)} />
                        </td>
                      </tr>
                    );
                  })}
              </Fragment>
            ))}
          </tbody>
        </table>
        <p className="hint" style={{ marginTop: 6 }}>Allowed is a hard requirement; preferred only affects the best-value score.</p>
      </div>

      <div className="section">
        <div className="section-title">Your preferred plan (savings baseline)</div>
        <div className="grid2">
          <label className="field">
            Arrival
            <input type="date" value={r.preferred.arrival ?? ""} onChange={(e) => set("preferred", { arrival: e.target.value || undefined })} />
          </label>
          <label className="field">
            Nights
            <NumberInput min={1} max={14} value={r.preferred.nights} onChange={(v) => set("preferred", { nights: v })} />
          </label>
          <label className="field">
            Resort
            <select
              value={r.preferred.resortId ?? ""}
              onChange={(e) => {
                const resort = CATALOG.resorts.find((x) => x.id === e.target.value);
                set("preferred", { resortId: resort?.id, roomTypeId: resort?.roomTypes[0]?.id });
              }}
            >
              <option value="">—</option>
              {CATALOG.resorts.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name.replace("Disney's ", "")}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Room
            <select value={r.preferred.roomTypeId ?? ""} onChange={(e) => set("preferred", { roomTypeId: e.target.value || undefined })}>
              {(prefResort?.roomTypes ?? []).map((rt) => (
                <option key={rt.id} value={rt.id}>
                  {rt.name}
                </option>
              ))}
            </select>
          </label>
          {r.tickets.parkDays > 0 && (
            <label className="field">
              Ticket
              <select value={r.preferred.ticketOption ?? ""} onChange={(e) => set("preferred", { ticketOption: (e.target.value || undefined) as TicketOption | undefined })}>
                <option value="">—</option>
                {TICKETS.map((t) => (
                  <option key={t} value={t}>
                    {TICKET_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            Dining
            <select value={r.preferred.dining ?? "out_of_pocket"} onChange={(e) => set("preferred", { dining: e.target.value as TripRequest["preferred"]["dining"] })}>
              {(Object.keys(DINING_LABEL) as (keyof typeof DINING_LABEL)[]).map((d) => (
                <option key={d} value={d}>
                  {DINING_LABEL[d]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Booking
            <select
              value={r.preferred.dining && r.preferred.dining !== "out_of_pocket" ? "package" : (r.preferred.bookingMethod ?? "separate")}
              disabled={!!r.preferred.dining && r.preferred.dining !== "out_of_pocket"}
              onChange={(e) => set("preferred", { bookingMethod: e.target.value as "separate" | "package" | "points" })}
            >
              <option value="separate">Separately</option>
              {prefResort?.disneyOwned !== false && <option value="package">Disney package</option>}
              {prefResort?.dvcPoints && <option value="points">DVC points</option>}
            </select>
          </label>
        </div>
      </div>

      <div className="section">
        <div className="section-title">Dining</div>
        <label className="field">
          Dining plan
          <select value={r.dining.policy} onChange={(e) => set("dining", { policy: e.target.value as TripRequest["dining"]["policy"] })}>
            <option value="consider">Consider if it saves money</option>
            <option value="prefer">Prefer a dining plan (affects value score)</option>
            <option value="require">Require a dining plan</option>
            <option value="exclude">No dining plan</option>
          </select>
        </label>
        <div className="grid2" style={{ marginTop: 10 }}>
          <label className="field">
            Food per adult / night
            <MoneyInput value={r.dining.outOfPocketPerAdultPerNightCents} onChange={(v) => set("dining", { outOfPocketPerAdultPerNightCents: v ?? 0 })} />
          </label>
          <label className="field">
            Food per child / night
            <MoneyInput value={r.dining.outOfPocketPerChildPerNightCents} onChange={(v) => set("dining", { outOfPocketPerChildPerNightCents: v ?? 0 })} />
          </label>
        </div>
        <p className="hint" style={{ marginTop: 6 }}>Your pay-as-you-go estimate. Needed to compare against a dining plan; set $0 to leave food out of totals.</p>
      </div>

      <div className="section">
        <div className="section-title">Transportation</div>
        <div className="grid2">
          <label className="field">
            Getting around
            <select value={r.transport.mode} onChange={(e) => set("transport", { mode: e.target.value as TripRequest["transport"]["mode"] })}>
              <option value="no_car">No car</option>
              <option value="own_car">Own car (parking only)</option>
              <option value="rental_car">Rental car</option>
            </select>
          </label>
          {r.transport.mode === "rental_car" && (
            <label className="field">
              Rental per day
              <MoneyInput value={r.transport.rentalPerDayCents} onChange={(v) => set("transport", { rentalPerDayCents: v ?? 0 })} />
            </label>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-title">Budget</div>
        <div className="grid2">
          <label className="field">
            Target (soft)
            <MoneyInput optional step={50} value={r.budget.targetCents} onChange={(v) => set("budget", { targetCents: v })} />
          </label>
          <label className="field">
            Hard limit
            <MoneyInput optional step={50} value={r.budget.hardLimitCents} onChange={(v) => set("budget", { hardLimitCents: v })} />
          </label>
        </div>
        <p className="hint" style={{ marginTop: 6 }}>Options over the target are flagged. Options over the hard limit are excluded.</p>
      </div>

      <div className="section">
        <div className="section-title">Other expenses</div>
        <div className="stack">
          {r.otherExpenses.map((x, i) => (
            <div key={i} className="row" style={{ flexWrap: "nowrap" }}>
              <input aria-label="Expense label" value={x.label} onChange={(e) => setExpense(i, { label: e.target.value })} style={{ flex: 2 }} />
              <div style={{ flex: 1 }}>
                <MoneyInput ariaLabel="Expense amount" value={x.cents} onChange={(v) => setExpense(i, { cents: v ?? 0 })} />
              </div>
              <select aria-label="Expense unit" value={x.per} onChange={(e) => setExpense(i, { per: e.target.value as OtherExpense["per"] })} style={{ flex: 1.3 }}>
                <option value="trip">/ trip</option>
                <option value="night">/ night</option>
                <option value="person">/ person</option>
                <option value="person_night">/ person / night</option>
              </select>
              <button type="button" className="link danger" aria-label="Remove expense" onClick={() => onChange({ ...r, otherExpenses: r.otherExpenses.filter((_, j) => j !== i) })}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" className="link" style={{ alignSelf: "flex-start" }} onClick={() => onChange({ ...r, otherExpenses: [...r.otherExpenses, { label: "Airport transfer", cents: 0, per: "trip" }] })}>
            + Add expense
          </button>
        </div>
      </div>

      <div className="section">
        <div className="section-title">Offer eligibility</div>
        <div className="grid3">
          {(["florida_resident", "annual_passholder", "military"] as Audience[]).map((a) => (
            <label key={a} className="field">
              {{ florida_resident: "Florida resident", annual_passholder: "Passholder", military: "Military" }[a]}
              <select value={r.eligibility[a]} onChange={(e) => set("eligibility", { [a]: e.target.value as Tristate })}>
                <option value="unknown">Not sure</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 6 }}>Offers needing unconfirmed eligibility are shown as possibilities, never included in totals.</p>
      </div>

      <div className="section">
        <div className="section-title">Ranking</div>
        <div className="row" style={{ marginBottom: 8 }}>
          <label className="check">
            <input type="radio" checked={r.objective === "lowest_cost"} onChange={() => onChange({ ...r, objective: "lowest_cost" })} /> Lowest total cost
          </label>
          <label className="check">
            <input type="radio" checked={r.objective === "best_value"} onChange={() => onChange({ ...r, objective: "best_value" })} /> Best value
          </label>
        </div>
        <details>
          <summary className="hint" style={{ cursor: "pointer" }}>Best-value weights</summary>
          <div className="stack" style={{ marginTop: 8 }}>
            {(Object.keys(WEIGHT_LABEL) as (keyof ValueWeights)[]).map((k) => (
              <label key={k} className="field">
                <span className="row">
                  {WEIGHT_LABEL[k]} <span className="spacer" /> <span className="num">{r.weights[k]}</span>
                </span>
                <input type="range" min={0} max={100} step={5} value={r.weights[k]} onChange={(e) => set("weights", { [k]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
        </details>
      </div>

      <div className="section">
        <div className="section-title">Price data</div>
        <label className="check">
          <input type="checkbox" checked={r.data.includeIllustrative} onChange={(e) => set("data", { includeIllustrative: e.target.checked })} />
          Include illustrative demo prices
        </label>
        <label className="field" style={{ marginTop: 8 }}>
          Treat quotes older than (days) as stale
          <NumberInput min={1} max={365} value={r.data.staleAfterDays} onChange={(v) => set("data", { staleAfterDays: v ?? 14 })} />
        </label>
      </div>
    </div>
  );
}
