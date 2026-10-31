"use client";

import { useState } from "react";
import { formatShortDate, type IsoDate } from "@/domain/dates";
import { ATTRACTIONS, attractionById, parkById, PARKS } from "@/itinerary/catalog";
import type { InfoProvenance, ParkInfo } from "@/itinerary/types";
import { InfoChip } from "./ItineraryView";

/**
 * Manual entry of what the user knows: park hours, reservations, Lightning Lane
 * return windows, closures, wait and crowd estimates. Everything is stored with
 * its source and an "entered" date, and is never labelled as verified.
 */

type Section = "hours" | "dining" | "lightningLane" | "parkReservations" | "closures" | "waits" | "crowds";

const SECTIONS: { key: Section; label: string; help: string }[] = [
  { key: "hours", label: "Park hours", help: "From the official park calendar for your dates. Without these, your own planning window is used and the plan is provisional." },
  { key: "dining", label: "Dining reservations", help: "Reservations you hold. The plan builds around them." },
  { key: "lightningLane", label: "Lightning Lane return windows", help: "Only windows you actually hold. Availability is never assumed or checked." },
  { key: "parkReservations", label: "Park reservations", help: "Theme park reservations you hold, if your ticket requires them." },
  { key: "closures", label: "Closures", help: "Attractions you know are closed (refurbishment, seasonal)." },
  { key: "waits", label: "Wait estimates", help: "Your own expected waits. An observed wait is a past moment and is kept for reference only." },
  { key: "crowds", label: "Crowd estimates", help: "Your own expectation (low / moderate / high). It only scales the planning buffer for rides without a wait estimate." },
];

export function KnownInfoEditor({ info, onChange, dates, parks, today }: { info: ParkInfo; onChange: (p: ParkInfo) => void; dates: IsoDate[]; parks: string[]; today: string }) {
  const [open, setOpen] = useState<Section>("hours");
  const count = (k: Section) => (info[k] as unknown[]).length;
  const remove = (k: Section, i: number) => onChange({ ...info, [k]: (info[k] as unknown[]).filter((_, j) => j !== i) });
  const add = (k: Section, item: unknown) => onChange({ ...info, [k]: [...(info[k] as unknown[]), item] });
  const parkList = parks.length ? PARKS.filter((p) => parks.includes(p.id)) : PARKS;
  const attractions = ATTRACTIONS.filter((a) => parkList.some((p) => p.id === a.parkId));
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 4 }}>
        {SECTIONS.map((s) => (
          <button key={s.key} className={open === s.key ? "primary" : ""} onClick={() => setOpen(s.key)}>
            {s.label}
            {count(s.key) ? ` (${count(s.key)})` : ""}
          </button>
        ))}
      </div>
      <p className="hint">{SECTIONS.find((s) => s.key === open)!.help}</p>
      <Entries info={info} k={open} onRemove={(i) => remove(open, i)} />
      <AddForm key={open} k={open} dates={dates} parks={parkList.map((p) => p.id)} attractions={attractions.map((a) => a.id)} today={today} onAdd={(item) => add(open, item)} />
    </div>
  );
}

function describe(k: Section, x: Record<string, unknown>): string {
  const park = (id: unknown) => (id ? (parkById.get(String(id))?.name ?? String(id)) : "outside the parks");
  const attr = (id: unknown) => attractionById.get(String(id))?.name ?? String(id);
  const d = (v: unknown) => formatShortDate(String(v));
  switch (k) {
    case "hours":
      return `${d(x.date)} · ${park(x.parkId)} · ${x.open}–${x.close}${x.earlyEntryMin ? ` · early entry ${x.earlyEntryMin} min` : ""}`;
    case "dining":
      return `${d(x.date)} ${x.time} · ${x.name} · ${park(x.parkId)} · ${x.durationMin} min`;
    case "lightningLane":
      return `${d(x.date)} · ${attr(x.attractionId)} · return ${x.start}–${x.end}`;
    case "parkReservations":
      return `${d(x.date)} · ${park(x.parkId)}`;
    case "closures":
      return `${attr(x.attractionId)} closed ${d(x.from)}–${d(x.to)}`;
    case "waits":
      return `${attr(x.attractionId)} · ${x.minutes} min (${x.kind === "observed" ? "observed — reference only" : "your estimate"})`;
    case "crowds":
      return `${d(x.date)} · ${park(x.parkId)} · ${x.level}`;
  }
}

function Entries({ info, k, onRemove }: { info: ParkInfo; k: Section; onRemove: (i: number) => void }) {
  const list = info[k] as (Record<string, unknown> & { provenance: InfoProvenance })[];
  if (!list.length) return <p className="small muted">Nothing entered.</p>;
  return (
    <ul className="notices small">
      {list.map((x, i) => (
        <li key={i} className="row" style={{ gap: 6 }}>
          <span>{describe(k, x)}</span>
          <InfoChip status={x.provenance.status} />
          <span className="muted">{x.provenance.source}</span>
          <button className="link" onClick={() => onRemove(i)}>
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}

function AddForm({ k, dates, parks, attractions, today, onAdd }: { k: Section; dates: IsoDate[]; parks: string[]; attractions: string[]; today: string; onAdd: (item: unknown) => void }) {
  const [f, setF] = useState<Record<string, string>>({ date: dates[1] ?? dates[0] ?? "", parkId: parks[0] ?? "", attractionId: attractions[0] ?? "", open: "09:00", close: "21:00", time: "18:00", start: "10:00", end: "11:00", durationMin: "75", minutes: "30", kind: "your_estimate", level: "moderate", from: dates[0] ?? "", to: dates[dates.length - 1] ?? "", source: "", status: "manual", name: "", earlyEntryMin: "" });
  const [err, setErr] = useState<string | null>(null);
  const set = (key: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [key]: e.target.value }));
  const prov = (): InfoProvenance => ({ status: f.status as "manual" | "estimated", source: (f.source ?? "").trim() || (f.status === "manual" ? "Entered by you" : "Your estimate"), observedAt: today });
  const submit = () => {
    setErr(null);
    const time = (a: string, b: string) => a < b;
    let item: unknown;
    switch (k) {
      case "hours":
        if (!time(f.open!, f.close!)) return setErr("Closing time must be after opening time.");
        item = { date: f.date, parkId: f.parkId, open: f.open, close: f.close, earlyEntryMin: f.earlyEntryMin ? Number(f.earlyEntryMin) : null, provenance: prov() };
        break;
      case "dining":
        if (!f.name!.trim()) return setErr("Give the reservation a name.");
        item = { id: `din-${Date.now()}`, date: f.date, parkId: f.parkId === "outside" ? null : f.parkId, name: f.name!.trim(), time: f.time, durationMin: Number(f.durationMin) || 75, provenance: prov() };
        break;
      case "lightningLane":
        if (!time(f.start!, f.end!)) return setErr("The return window must end after it starts.");
        item = { id: `ll-${Date.now()}`, date: f.date, attractionId: f.attractionId, start: f.start, end: f.end, provenance: prov() };
        break;
      case "parkReservations":
        item = { date: f.date, parkId: f.parkId, provenance: prov() };
        break;
      case "closures":
        if (f.from! > f.to!) return setErr("The end date must be on or after the start date.");
        item = { attractionId: f.attractionId, from: f.from, to: f.to, provenance: prov() };
        break;
      case "waits":
        item = { attractionId: f.attractionId, minutes: Math.max(0, Math.min(300, Number(f.minutes) || 0)), kind: f.kind, date: null, provenance: { ...prov(), status: f.kind === "observed" ? "manual" : "estimated" } };
        break;
      case "crowds":
        item = { date: f.date, parkId: f.parkId, level: f.level, provenance: { ...prov(), status: "estimated" } };
        break;
    }
    onAdd(item);
  };
  const dateSel = (name = "date") => (
    <label className="field">
      {name === "date" ? "Date" : name === "from" ? "From" : "To"}
      <select value={f[name]} onChange={set(name)}>
        {dates.map((d) => (
          <option key={d} value={d}>
            {formatShortDate(d)}
          </option>
        ))}
      </select>
    </label>
  );
  const parkSel = (outside = false) => (
    <label className="field">
      Park
      <select value={f.parkId} onChange={set("parkId")}>
        {parks.map((p) => (
          <option key={p} value={p}>
            {parkById.get(p)!.name}
          </option>
        ))}
        {outside && <option value="outside">Outside the parks</option>}
      </select>
    </label>
  );
  const attrSel = () => (
    <label className="field">
      Attraction
      <select value={f.attractionId} onChange={set("attractionId")}>
        {attractions.map((a) => (
          <option key={a} value={a}>
            {parkById.get(attractionById.get(a)!.parkId)!.short} · {attractionById.get(a)!.name}
          </option>
        ))}
      </select>
    </label>
  );
  const timeIn = (name: string, label: string) => (
    <label className="field">
      {label}
      <input type="time" value={f[name]} onChange={set(name)} />
    </label>
  );
  return (
    <div className="stack" style={{ gap: 8, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
      <div className="grid3">
        {k === "hours" && (
          <>
            {dateSel()}
            {parkSel()}
            {timeIn("open", "Opens")}
            {timeIn("close", "Closes")}
            <label className="field">
              Early entry (min, if you have it)
              <input type="number" min={0} max={120} value={f.earlyEntryMin} onChange={set("earlyEntryMin")} placeholder="none" />
            </label>
          </>
        )}
        {k === "dining" && (
          <>
            {dateSel()}
            {parkSel(true)}
            <label className="field">
              Name
              <input value={f.name} onChange={set("name")} placeholder="e.g. Dinner at …" />
            </label>
            {timeIn("time", "Time")}
            <label className="field">
              Length (min)
              <input type="number" min={15} max={240} value={f.durationMin} onChange={set("durationMin")} />
            </label>
          </>
        )}
        {k === "lightningLane" && (
          <>
            {dateSel()}
            {attrSel()}
            {timeIn("start", "Return from")}
            {timeIn("end", "Return until")}
          </>
        )}
        {k === "parkReservations" && (
          <>
            {dateSel()}
            {parkSel()}
          </>
        )}
        {k === "closures" && (
          <>
            {attrSel()}
            {dateSel("from")}
            {dateSel("to")}
          </>
        )}
        {k === "waits" && (
          <>
            {attrSel()}
            <label className="field">
              Minutes
              <input type="number" min={0} max={300} value={f.minutes} onChange={set("minutes")} />
            </label>
            <label className="field">
              Kind
              <select value={f.kind} onChange={set("kind")}>
                <option value="your_estimate">My expected wait (used for planning)</option>
                <option value="observed">A wait I saw (reference only)</option>
              </select>
            </label>
          </>
        )}
        {k === "crowds" && (
          <>
            {dateSel()}
            {parkSel()}
            <label className="field">
              Expected crowds
              <select value={f.level} onChange={set("level")}>
                <option value="low">Low</option>
                <option value="moderate">Moderate</option>
                <option value="high">High</option>
              </select>
            </label>
          </>
        )}
        <label className="field">
          Source
          <input value={f.source} onChange={set("source")} placeholder="e.g. official park calendar, my confirmation email" />
        </label>
        {k !== "waits" && k !== "crowds" && (
          <label className="field">
            This is
            <select value={f.status} onChange={set("status")}>
              <option value="manual">From a source I checked</option>
              <option value="estimated">My estimate</option>
            </select>
          </label>
        )}
      </div>
      {err && <div className="err">{err}</div>}
      <div>
        <button onClick={submit}>Add</button>
      </div>
    </div>
  );
}
