"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ItinerarySummary, SavedItinerary, SavedTrip } from "@/data/store";
import { addDays, daysBetween, formatDate, formatShortDate, todayIso, type IsoDate } from "@/domain/dates";
import { advisoriesFor, ATTRACTIONS, CATALOG_PROVENANCE, CATEGORY_LABEL, parkById, PARKS, SCHEDULE_LABEL } from "@/itinerary/catalog";
import { ITINERARY_ENGINE_VERSION, STANDARD_VARIANTS, type ItineraryComparison } from "@/itinerary/engine";
import { contextDifferences } from "@/itinerary/context";
import { defaultPreferences, emptyParkInfo, type AttractionPref, type Itinerary, type ItineraryInput, type Preferences, type TripContext } from "@/itinerary/types";
import { CompareView, ItineraryView, StatusBadges } from "./ItineraryView";
import { KnownInfoEditor, type KnownInfoSection } from "./KnownInfoEditor";

const DRAFT_KEY = "dvo:itinerary-draft";
const PLANNER_DRAFT_KEY = "dvo:draft-request";
const TICKET_LABEL = { base: "1 park per day", park_hopper: "Park Hopper", park_hopper_plus: "Park Hopper Plus" } as const;

interface Comparison {
  variants: { label: string; differs: string[]; itinerary: Itinerary }[];
  summary: string[];
  details?: ItineraryComparison;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.errors?.join(" ") ?? `Error ${res.status}`);
  return body as T;
}

export function ItineraryPlanner({ savedId }: { savedId?: string }) {
  const [input, setInput] = useState<ItineraryInput | null>(null);
  const [tripId, setTripId] = useState<string | null>(null);
  const [result, setResult] = useState<Itinerary | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [saved, setSaved] = useState<SavedItinerary | null>(null);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The inputs the shown result was planned from (to flag edits since). */
  const [resultInput, setResultInput] = useState<string | null>(null);

  // Restore: a saved itinerary, or this browser's unsaved draft.
  useEffect(() => {
    if (savedId) {
      fetch(`/api/itineraries/${encodeURIComponent(savedId)}`)
        .then((r) => json<{ itinerary: SavedItinerary }>(r))
        .then(({ itinerary }) => {
          const v = itinerary.versions[itinerary.versions.length - 1]!;
          setSaved(itinerary);
          setName(itinerary.name);
          setTripId(itinerary.tripId);
          setInput(v.input);
          setResult(v.result);
          setResultInput(JSON.stringify(v.input));
          // Changes made in the assistant arrive as a draft for this saved itinerary.
          if (new URLSearchParams(location.search).get("draft")) {
            try {
              const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
              if (d?.savedId === itinerary.id && d.input) {
                setInput(d.input);
                setNotice("Loaded the changes made with the assistant. Plan again, then “Save as new version” to keep them.");
              }
            } catch {
              /* no draft */
            }
          }
        })
        .catch((e) => setError(e.message));
      return;
    }
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
      if (d?.input) {
        setInput(d.input);
        setTripId(d.tripId ?? null);
      }
    } catch {
      /* no draft */
    }
  }, [savedId]);
  useEffect(() => {
    if (savedId || !input) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ input, tripId }));
    } catch {
      /* storage unavailable */
    }
  }, [input, tripId, savedId]);

  // Has the linked saved trip changed since this itinerary was planned? Never applied silently.
  const [drift, setDrift] = useState<{ current: TripContext | null; differences: string[]; missing: boolean } | null>(null);
  useEffect(() => {
    if (!tripId || !input || input.demo) {
      setDrift(null);
      return;
    }
    let live = true;
    fetch(`/api/itinerary/context?tripId=${encodeURIComponent(tripId)}`)
      .then(async (r) => {
        const b = await r.json().catch(() => ({}));
        if (!live) return;
        if (r.status === 404) setDrift({ current: null, differences: [], missing: true });
        else if (r.ok) setDrift({ current: b.context, differences: contextDifferences(input.context, b.context), missing: false });
        else setDrift({ current: null, differences: [b.errors?.join(" ") ?? "The saved trip can't be read right now."], missing: false });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // Only re-check when the linked trip or the planned trip changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId, input?.context.arrival, input?.context.departure, input?.context.resortId, JSON.stringify(input?.context.ticket)]);

  const start = (context: TripContext, opts: { demo?: ItineraryInput; tripId?: string | null } = {}) => {
    setInput(opts.demo ?? { context, prefs: defaultPreferences(), parkInfo: emptyParkInfo(), demo: false });
    setTripId(opts.tripId ?? null);
    setResult(null);
    setComparison(null);
    setSaved(null);
    setName(opts.demo ? "Demonstration plan" : context.source.label);
  };

  const run = async (compare: boolean) => {
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      const r = await json<{ itinerary: Itinerary; comparison?: Comparison }>(await fetch("/api/itinerary/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input, compare }) }));
      setResult(r.itinerary);
      setResultInput(JSON.stringify(input));
      setComparison(r.comparison ?? null);
      setViewVersion(null);
      requestAnimationFrame(() => document.getElementById("result")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async (asNewVersion: boolean) => {
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      const body = JSON.stringify({ name: name.trim() || "My itinerary", tripId, note: asNewVersion ? "Regenerated after edits" : "Generated", input });
      const r = asNewVersion && saved
        ? await json<{ itinerary: SavedItinerary }>(await fetch(`/api/itineraries/${saved.id}`, { method: "POST", headers: { "content-type": "application/json" }, body }))
        : await json<{ itinerary: SavedItinerary }>(await fetch("/api/itineraries", { method: "POST", headers: { "content-type": "application/json" }, body }));
      setSaved(r.itinerary);
      setResult(r.itinerary.versions[r.itinerary.versions.length - 1]!.result);
      setResultInput(JSON.stringify(input));
      setViewVersion(null);
      setNotice(asNewVersion ? `Saved as version ${r.itinerary.versions.length}. Earlier versions are kept unchanged.` : "Saved.");
      if (!savedId) window.history.replaceState(null, "", `/itinerary/${r.itinerary.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const askAssistant = async () => {
    if (!input) return;
    setBusy(true);
    try {
      // The conversation's trip plan matches the itinerary's trip when it came from a saved trip or the planner.
      let request: unknown = undefined;
      if (tripId) request = (await fetch(`/api/trips?id=${encodeURIComponent(tripId)}`).then((r) => (r.ok ? r.json() : null)))?.trip?.request;
      else if (input.context.source.kind === "request") {
        try {
          request = JSON.parse(localStorage.getItem(PLANNER_DRAFT_KEY) ?? "null") ?? undefined;
        } catch {
          /* none */
        }
      }
      const r = await json<{ conversation: { id: string } }>(
        await fetch("/api/conversations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request, itinerary: { input, savedId: saved?.id ?? null, tripId }, title: `Itinerary: ${name || input.context.source.label}` }) }),
      );
      location.href = `/assistant?c=${r.conversation.id}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  // Missing information in a plan links straight to the form that fills it in.
  const [knownSection, setKnownSection] = useState<KnownInfoSection>("hours");
  const openKnown = (section: string) => {
    setKnownSection(section as KnownInfoSection);
    const el = document.getElementById("known-info") as HTMLDetailsElement | null;
    if (el) {
      el.open = true;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const update = (fn: (i: ItineraryInput) => ItineraryInput) => setInput((i) => (i ? fn(i) : i));
  const setPrefs = (p: Partial<Preferences>) => update((i) => ({ ...i, prefs: { ...i.prefs, ...p } }));

  const shown = viewVersion !== null && saved ? saved.versions.find((v) => v.version === viewVersion)!.result : result;

  if (!input) return <StartChooser onStart={start} error={error} />;

  return (
    <div className="stack" style={{ gap: 16, maxWidth: 1100 }}>
      <div className="row">
        <div className="stack" style={{ gap: 2 }}>
          <Link href="/itinerary" className="small" onClick={() => !savedId && localStorage.removeItem(DRAFT_KEY)}>
            ← Start over / saved itineraries
          </Link>
          <h1>Itinerary planner</h1>
        </div>
        <span className="spacer" />
        <button onClick={askAssistant} disabled={busy}>
          Plan with the assistant
        </button>
      </div>
      {input.demo && (
        <div className="banner banner-demo">
          <div>
            <strong>Demonstration scenario.</strong> A fictional trip with <strong>illustrative</strong> park hours, waits and a dinner reservation, so you can try the planner. None of it is a real schedule or availability.
          </div>
        </div>
      )}
      {error && <div className="banner banner-error">{error}</div>}
      {notice && <div className="banner banner-info small">{notice}</div>}

      {drift?.missing && (
        <div className="banner banner-warn small">
          <div>The saved trip this itinerary was planned for no longer exists. The itinerary keeps its own copy of the trip details shown below.</div>
        </div>
      )}
      {drift && drift.differences.length > 0 && (
        <div className="banner banner-warn small" data-testid="trip-drift">
          <div className="stack" style={{ gap: 6 }}>
            <strong>The saved trip has changed since this itinerary was planned:</strong>
            <ul className="notices">
              {drift.differences.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
            <div>This plan still uses the details below. Nothing changes unless you choose to.</div>
            {drift.current && (
              <div>
                <button
                  onClick={() => {
                    update((i) => ({ ...i, context: drift.current! }));
                    setNotice("Now using the current trip details. Plan again (and save as a new version) to update the itinerary; the earlier version is kept.");
                  }}
                >
                  Use the current trip details
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      <TripCard ctx={input.context} />

      <Step n={1} title="Parks">
        <ParksStep input={input} setPrefs={setPrefs} />
      </Step>
      <Step n={2} title="Attractions and activities">
        <AttractionsStep input={input} setPrefs={setPrefs} />
      </Step>
      <Step n={3} title="Pace and preferences">
        <PaceStep prefs={input.prefs} hopper={!!input.context.ticket?.hopper} setPrefs={setPrefs} />
      </Step>
      <Step n={4} title="What you already know (optional)" collapsed id="known-info">
        <p className="small muted">
          The app has no live park information: no official hours, closures, waits, crowd levels, reservation or Lightning Lane availability. Add what you know; anything missing is shown as unknown and the plan says what it assumed.
        </p>
        <KnownInfoEditor info={input.parkInfo} onChange={(parkInfo) => update((i) => ({ ...i, parkInfo }))} dates={tripDateList(input.context)} parks={input.prefs.parks} today={todayIso()} section={knownSection} onSection={setKnownSection} />
      </Step>

      <div className="card card-pad row" style={{ position: "sticky", bottom: 8, zIndex: 5 }}>
        <button className="primary" disabled={busy} onClick={() => run(false)}>
          {busy ? "Planning…" : result ? "Plan again with these choices" : "Plan my days"}
        </button>
        <button disabled={busy} onClick={() => run(true)} title="Same trip and park information, two sets of preferences">
          Compare relaxed vs ride-focused
        </button>
        <span className="spacer" />
        <span className="small muted">The plan is calculated by deterministic rules; nothing is booked.</span>
      </div>

      {(result || saved) && (
        <div className="card card-pad stack">
          <div className="row">
            <h2>Save</h2>
            <span className="spacer" />
            {saved && <span className="small muted">{saved.versions.length} version{saved.versions.length === 1 ? "" : "s"} saved</span>}
          </div>
          <div className="row">
            <input style={{ maxWidth: 320 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Itinerary name" />
            {saved ? (
              <button className="primary" disabled={busy} onClick={() => save(true)}>
                Save as new version
              </button>
            ) : (
              <button className="primary" disabled={busy || !result} onClick={() => save(false)}>
                Save itinerary
              </button>
            )}
          </div>
          {saved && (
            <div className="small stack" style={{ gap: 4 }}>
              {[...saved.versions].reverse().map((v) => (
                <div key={v.version} className="row" style={{ gap: 6 }}>
                  <button className="link" onClick={() => setViewVersion(v.version === saved.versions.length ? null : v.version)}>
                    Version {v.version}
                  </button>
                  <span className="muted">
                    {new Date(v.createdAt).toLocaleString()} · {v.note} · {v.result.headline}
                    {v.engineVersion !== ITINERARY_ENGINE_VERSION ? ` · made with planner ${v.engineVersion} (current ${ITINERARY_ENGINE_VERSION}; plan again to update it as a new version)` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div id="result" />
      {shown && viewVersion === null && resultInput !== null && resultInput !== JSON.stringify(input) && (
        <div className="banner banner-warn small">
          <div>You changed your choices since this plan was made. Press “Plan again” to update it{saved ? ", then “Save as new version”" : ""}.</div>
        </div>
      )}
      {viewVersion !== null && <div className="banner banner-info small">Viewing saved version {viewVersion} as it was generated. It is never changed; plan again to create a new version.</div>}
      {comparison && viewVersion === null && (
        <CompareView
          variants={comparison.variants}
          summary={comparison.summary}
          details={comparison.details}
          onUse={(label) => {
            const v = STANDARD_VARIANTS.find((x) => x.label === label)!;
            setPrefs({ ...v.prefs, priorities: { ...input.prefs.priorities, ...(v.prefs.priorities ?? {}) } });
            setComparison(null);
            setNotice(`Applied the "${label}" preferences. Press "Plan again" to see the full plan.`);
          }}
        />
      )}
      {shown && !(comparison && viewVersion === null) && <ItineraryView it={shown} onAction={viewVersion === null ? openKnown : undefined} />}
    </div>
  );
}

function tripDateList(ctx: TripContext): IsoDate[] {
  return Array.from({ length: Math.min(daysBetween(ctx.arrival, ctx.departure), 20) + 1 }, (_, i) => addDays(ctx.arrival, i));
}

function Step({ n, title, children, collapsed = false, id }: { n: number; title: string; children: React.ReactNode; collapsed?: boolean; id?: string }) {
  return (
    <details className="card card-pad" open={!collapsed} id={id}>
      <summary style={{ cursor: "pointer" }}>
        <h2 style={{ display: "inline" }}>
          {n}. {title}
        </h2>
      </summary>
      <div className="stack" style={{ gap: 10, marginTop: 10 }}>
        {children}
      </div>
    </details>
  );
}

function TripCard({ ctx }: { ctx: TripContext }) {
  const t = ctx.ticket;
  const u = t?.usage;
  return (
    <div className="card card-pad stack">
      <h2>Your trip</h2>
      <dl className="kv">
        <dt>From</dt>
        <dd>{ctx.source.label}</dd>
        <dt>Dates</dt>
        <dd>
          {formatDate(ctx.arrival)} → {formatDate(ctx.departure)} ({daysBetween(ctx.arrival, ctx.departure)} nights)
          {!ctx.parkOnArrivalDay || !ctx.parkOnDepartureDay ? ` · no park on ${[!ctx.parkOnArrivalDay && "arrival", !ctx.parkOnDepartureDay && "departure"].filter(Boolean).join(" or ")} day` : ""}
        </dd>
        <dt>Party</dt>
        <dd>
          {ctx.party.adults} adult{ctx.party.adults === 1 ? "" : "s"}
          {ctx.party.children ? `, ${ctx.party.children} child${ctx.party.children === 1 ? "" : "ren"}` : ""}
          {ctx.party.infants ? `, ${ctx.party.infants} infant${ctx.party.infants === 1 ? "" : "s"}` : ""}
        </dd>
        <dt>Staying at</dt>
        <dd>{ctx.resortName}</dd>
        <dt>Tickets</dt>
        <dd>{t ? `${t.days} park day${t.days === 1 ? "" : "s"}, ${TICKET_LABEL[t.option]}` : "No park tickets"}</dd>
        <dt>Ticket rules</dt>
        <dd className="small">
          {u
            ? [
                u.useWithinDays !== null ? `use within ${u.useWithinDays} days` : "use-within window unknown",
                u.expiresOn ? `expires ${formatShortDate(u.expiresOn)}` : null,
                u.blockoutDates?.length ? `${u.blockoutDates.length} blocked-out date(s)` : null,
                u.parkReservationRequired === null ? "park reservations: unknown" : u.parkReservationRequired ? "park reservations required" : "no park reservations needed",
              ]
                .filter(Boolean)
                .join(" · ") + (t?.usageSource ? ` (${t.usageSource})` : "")
            : "Not recorded: nothing is assumed. Add a ticket rule on Price data if you know them."}
        </dd>
      </dl>
    </div>
  );
}

function ParksStep({ input, setPrefs }: { input: ItineraryInput; setPrefs: (p: Partial<Preferences>) => void }) {
  const prefs = input.prefs;
  const dates = tripDateList(input.context);
  const toggle = (id: string) => setPrefs({ parks: prefs.parks.includes(id) ? prefs.parks.filter((p) => p !== id) : [...prefs.parks, id] });
  const setPin = (date: IsoDate, value: string) => {
    const pins = prefs.pins.filter((p) => p.date !== date);
    if (value === "rest") pins.push({ date, plan: { kind: "rest" } });
    else if (value) pins.push({ date, plan: { kind: "park", parkId: value } });
    setPrefs({ pins });
  };
  return (
    <>
      <div className="row">
        {PARKS.map((p) => (
          <label key={p.id} className="check">
            <input type="checkbox" checked={prefs.parks.includes(p.id)} onChange={() => toggle(p.id)} /> {p.name}
          </label>
        ))}
      </div>
      <p className="hint">Leave all unticked to let the planner use the parks of the attractions you mark (or all four).</p>
      <details>
        <summary className="small">Fix specific days (optional)</summary>
        <div className="grid3" style={{ marginTop: 8 }}>
          {dates.map((d) => {
            const pin = prefs.pins.find((p) => p.date === d);
            return (
              <label key={d} className="field">
                {formatShortDate(d)}
                <select value={pin ? (pin.plan.kind === "park" ? pin.plan.parkId : pin.plan.kind) : ""} onChange={(e) => setPin(d, e.target.value)}>
                  <option value="">Planner decides</option>
                  <option value="rest">Rest day / no park</option>
                  {PARKS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      </details>
    </>
  );
}

const PREF_LABEL: Record<AttractionPref | "", string> = { must: "Must", want: "Like", "": "Maybe", avoid: "Skip" };

function AttractionsStep({ input, setPrefs }: { input: ItineraryInput; setPrefs: (p: Partial<Preferences>) => void }) {
  const prefs = input.prefs;
  const parks = prefs.parks.length ? PARKS.filter((p) => prefs.parks.includes(p.id)) : PARKS;
  const [customName, setCustomName] = useState("");
  const [customArea, setCustomArea] = useState(parks[0]?.areas[0]?.id ?? "");
  const [customMin, setCustomMin] = useState(30);
  const set = (id: string, v: AttractionPref | "") => {
    const next = { ...prefs.attractions };
    if (v) next[id] = v;
    else delete next[id];
    setPrefs({ attractions: next });
  };
  return (
    <>
      <p className="hint">
        Mark what matters. Unmarked attractions may be added as extras if there's time. Durations are approximate ride or show lengths without waits ({CATALOG_PROVENANCE.source}, {CATALOG_PROVENANCE.observedAt}).
      </p>
      {parks.map((p) => (
        <details key={p.id} open={parks.length === 1}>
          <summary>
            <strong>{p.name}</strong>{" "}
            <span className="small muted">
              {ATTRACTIONS.filter((a) => a.parkId === p.id && prefs.attractions[a.id] === "must").length} must ·{" "}
              {ATTRACTIONS.filter((a) => a.parkId === p.id && prefs.attractions[a.id] === "want").length} like
            </span>
          </summary>
          <div className="scroll-x">
            <table className="cmp">
              <tbody>
                {ATTRACTIONS.filter((a) => a.parkId === p.id).map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.name}
                      <div className="small muted">
                        {p.areas.find((x) => x.id === a.areaId)?.name} · {CATEGORY_LABEL[a.category]} · ~{a.durationMin} min (estimate)
                        {a.schedule !== "continuous" ? ` · ${SCHEDULE_LABEL[a.schedule]}` : ""}
                        {a.minHeightIn ? ` · reported min. height ${a.minHeightIn} in (verify)` : ""}
                      </div>
                      {advisoriesFor(a, input.context.arrival, input.context.departure).map((x) => (
                        <div key={x.text} className="small save-neg">
                          Reported: {x.text} ({x.source}, checked {x.checkedAt}). Verify; add a closure if confirmed.
                        </div>
                      ))}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {(["must", "want", "", "avoid"] as const).map((v) => (
                        <button key={v} className={(prefs.attractions[a.id] ?? "") === v ? "primary" : ""} style={{ padding: "3px 8px", marginLeft: 2 }} onClick={() => set(a.id, v)} aria-pressed={(prefs.attractions[a.id] ?? "") === v}>
                          {PREF_LABEL[v]}
                        </button>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
      <details>
        <summary className="small">Add your own activity (character meet, parade spot, shopping…)</summary>
        <div className="grid3" style={{ marginTop: 8 }}>
          <label className="field">
            Name
            <input value={customName} onChange={(e) => setCustomName(e.target.value)} />
          </label>
          <label className="field">
            Where
            <select value={customArea} onChange={(e) => setCustomArea(e.target.value)}>
              {parks.flatMap((p) =>
                p.areas.map((ar) => (
                  <option key={ar.id} value={ar.id}>
                    {p.short} · {ar.name}
                  </option>
                )),
              )}
            </select>
          </label>
          <label className="field">
            Minutes
            <input type="number" min={5} max={480} value={customMin} onChange={(e) => setCustomMin(Number(e.target.value) || 30)} />
          </label>
        </div>
        <button
          style={{ marginTop: 8 }}
          disabled={!customName.trim()}
          onClick={() => {
            const park = PARKS.find((p) => p.areas.some((ar) => ar.id === customArea))!;
            setPrefs({ custom: [...prefs.custom, { id: `custom-${Date.now()}`, name: customName.trim(), parkId: park.id, areaId: customArea, durationMin: customMin, priority: "want" }] });
            setCustomName("");
          }}
        >
          Add activity
        </button>
        {prefs.custom.length > 0 && (
          <ul className="notices small">
            {prefs.custom.map((c) => (
              <li key={c.id}>
                {c.name} ({parkById.get(c.parkId)?.short}, {c.durationMin} min){" "}
                <button className="link" onClick={() => setPrefs({ custom: prefs.custom.map((x) => (x.id === c.id ? { ...x, priority: x.priority === "must" ? "want" : "must" } : x)) })}>
                  {c.priority === "must" ? "Must-do (make it a ‘like’)" : "Like (make it a must-do)"}
                </button>{" "}
                <button className="link" onClick={() => setPrefs({ custom: prefs.custom.filter((x) => x.id !== c.id) })}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </details>
    </>
  );
}

function PaceStep({ prefs, hopper, setPrefs }: { prefs: Preferences; hopper: boolean; setPrefs: (p: Partial<Preferences>) => void }) {
  const pr = prefs.priorities;
  const setPr = (k: keyof Preferences["priorities"], v: boolean) => setPrefs({ priorities: { ...pr, [k]: v } });
  return (
    <>
      <div className="row">
        <span className="small muted">Pace:</span>
        {(["relaxed", "moderate", "packed"] as const).map((p) => (
          <label key={p} className="check">
            <input type="radio" name="pace" checked={prefs.pace === p} onChange={() => setPrefs({ pace: p })} /> {p[0]!.toUpperCase() + p.slice(1)}
          </label>
        ))}
      </div>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={pr.minimizeWalking} onChange={(e) => setPr("minimizeWalking", e.target.checked)} /> Minimize walking
        </label>
        <label className="check">
          <input type="checkbox" checked={pr.reduceBacktracking} onChange={(e) => setPr("reduceBacktracking", e.target.checked)} /> Avoid crossing the park repeatedly
        </label>
        <label className="check">
          <input type="checkbox" checked={pr.maximizeAttractions} onChange={(e) => setPr("maximizeAttractions", e.target.checked)} /> Fit in as much as possible
        </label>
        <label className="check">
          <input type="checkbox" checked={pr.relaxedSchedule} onChange={(e) => setPr("relaxedSchedule", e.target.checked)} /> Keep it relaxed
        </label>
      </div>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={prefs.middayBreak} onChange={(e) => setPrefs({ middayBreak: e.target.checked })} /> Midday rest
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.flexibleAfternoons} onChange={(e) => setPrefs({ flexibleAfternoons: e.target.checked })} /> Keep 2–4 pm free
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.avoidDemandingArrivalDay} onChange={(e) => setPrefs({ avoidDemandingArrivalDay: e.target.checked })} /> Not the busiest day first
        </label>
        {hopper && (
          <label className="check">
            <input type="checkbox" checked={prefs.allowHopping} onChange={(e) => setPrefs({ allowHopping: e.target.checked })} /> Use Park Hopper
          </label>
        )}
        <label className="check">
          Rest day:{" "}
          <select style={{ width: "auto" }} value={prefs.restDay} onChange={(e) => setPrefs({ restDay: e.target.value as Preferences["restDay"] })}>
            <option value="avoid">Use every park day</option>
            <option value="allow">Planner decides</option>
            <option value="prefer">I'd like one</option>
          </select>
        </label>
      </div>
      <details>
        <summary className="small">Times, meals and planning assumptions</summary>
        <div className="grid3" style={{ marginTop: 8 }}>
          <label className="field">
            Start the day at
            <input type="time" value={prefs.dayStart} onChange={(e) => e.target.value && setPrefs({ dayStart: e.target.value })} />
          </label>
          <label className="field">
            End the day by
            <input type="time" value={prefs.dayEnd} onChange={(e) => e.target.value && setPrefs({ dayEnd: e.target.value })} />
          </label>
          <label className="field">
            Arrival day: free from
            <input type="time" value={prefs.arrivalDayStart} onChange={(e) => e.target.value && setPrefs({ arrivalDayStart: e.target.value })} />
          </label>
          <label className="field">
            Lunch between
            <span className="row" style={{ flexWrap: "nowrap" }}>
              <input type="time" value={prefs.lunch?.start ?? ""} onChange={(e) => setPrefs({ lunch: e.target.value ? { start: e.target.value, end: prefs.lunch?.end ?? "13:30" } : null })} />
              <input type="time" value={prefs.lunch?.end ?? ""} onChange={(e) => prefs.lunch && e.target.value && setPrefs({ lunch: { ...prefs.lunch, end: e.target.value } })} />
            </span>
          </label>
          <label className="field">
            Dinner between
            <span className="row" style={{ flexWrap: "nowrap" }}>
              <input type="time" value={prefs.dinner?.start ?? ""} onChange={(e) => setPrefs({ dinner: e.target.value ? { start: e.target.value, end: prefs.dinner?.end ?? "19:30" } : null })} />
              <input type="time" value={prefs.dinner?.end ?? ""} onChange={(e) => prefs.dinner && e.target.value && setPrefs({ dinner: { ...prefs.dinner, end: e.target.value } })} />
            </span>
          </label>
          <label className="field">
            Wait buffer per ride when unknown (min)
            <input type="number" min={0} max={120} value={prefs.waitBufferMin} onChange={(e) => setPrefs({ waitBufferMin: Math.max(0, Math.min(120, Number(e.target.value) || 0)) })} />
          </label>
          <label className="field">
            Walking pace
            <select value={prefs.mobility} onChange={(e) => setPrefs({ mobility: e.target.value as Preferences["mobility"] })}>
              <option value="standard">Standard</option>
              <option value="slower">Slower (more time between areas)</option>
            </select>
          </label>
          <label className="field">
            Lightning Lane
            <select value={prefs.lightningLane} onChange={(e) => setPrefs({ lightningLane: e.target.value as Preferences["lightningLane"] })}>
              <option value="if_held">Use return windows I enter</option>
              <option value="none">Don't plan with Lightning Lane</option>
            </select>
          </label>
        </div>
        <p className="hint">The wait buffer is your planning assumption, not a forecast: the app has no wait-time or crowd data.</p>
      </details>
    </>
  );
}

function StartChooser({ onStart, error }: { onStart: (ctx: TripContext, opts?: { demo?: ItineraryInput; tripId?: string | null }) => void; error: string | null }) {
  const [trips, setTrips] = useState<SavedTrip[]>([]);
  const [itins, setItins] = useState<ItinerarySummary[] | null>(null);
  const [err, setErr] = useState<string | null>(error);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    fetch("/api/trips")
      .then((r) => json<{ trips: SavedTrip[] }>(r))
      .then((b) => setTrips(b.trips))
      .catch((e) => setErr(e.message));
    fetch("/api/itineraries")
      .then((r) => json<{ itineraries: ItinerarySummary[] }>(r))
      .then((b) => setItins(b.itineraries))
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(load, [load]);
  const go = async (p: Promise<Response>, opts: { tripId?: string } = {}) => {
    setBusy(true);
    setErr(null);
    try {
      const b = await json<{ context: TripContext }>(await p);
      onStart(b.context, { tripId: opts.tripId ?? null });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Arriving from "Plan the park days for this option" or a saved trip's "Plan the park days".
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const tripParam = q.get("trip");
    if (tripParam) {
      go(fetch(`/api/itinerary/context?tripId=${encodeURIComponent(tripParam)}`), { tripId: tripParam });
      return;
    }
    if (q.get("option")) {
      try {
        const o = JSON.parse(localStorage.getItem("dvo:itinerary-option") ?? "null");
        if (o?.request && o.option) go(fetch("/api/itinerary/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: o.request, option: o.option }) }));
      } catch {
        /* nothing to start from */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const draft = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(PLANNER_DRAFT_KEY) ?? "null");
    } catch {
      return null;
    }
  }, []);
  return (
    <div className="stack" style={{ gap: 16, maxWidth: 900 }}>
      <div>
        <h1>Itinerary planner</h1>
        <p className="muted">
          Turn a trip into a day-by-day park plan: which park each day, what to do and in what order, with meals, breaks and walking time. The plan is built by deterministic rules from what you choose and what you know; the app has no live park hours, waits or availability.
        </p>
      </div>
      {err && <div className="banner banner-error">{err}</div>}
      <div className="card card-pad stack">
        <h2>Start from a trip</h2>
        {trips.length === 0 && <p className="small muted">No saved trips yet.</p>}
        {trips.map((t) => (
          <div key={t.id} className="row">
            <span>{t.name}</span>
            <span className="spacer" />
            <button disabled={busy} onClick={() => go(fetch(`/api/itinerary/context?tripId=${encodeURIComponent(t.id)}`), { tripId: t.id })}>
              Plan this trip
            </button>
          </div>
        ))}
        <div className="row">
          <span>Your current plan on Plan & compare</span>
          <span className="spacer" />
          <button disabled={busy || !draft} onClick={() => go(fetch("/api/itinerary/context", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: draft }) }))}>
            Plan it
          </button>
        </div>
        <p className="hint">The itinerary uses the trip's preferred plan: dates, resort and ticket.</p>
      </div>
      <div className="card card-pad stack">
        <h2>Just trying it out?</h2>
        <div className="row">
          <span>A demonstration trip with illustrative hours and waits (not real).</span>
          <span className="spacer" />
          <button
            disabled={busy}
            onClick={async () => {
              const b = await json<{ demo: ItineraryInput }>(await fetch("/api/itinerary/context?demo=1"));
              onStart(b.demo.context, { demo: b.demo });
            }}
          >
            Try the demo
          </button>
        </div>
      </div>
      <div className="card card-pad stack">
        <h2>Saved itineraries</h2>
        {itins === null ? (
          <p className="small muted">Loading…</p>
        ) : itins.length === 0 ? (
          <p className="small muted">None yet.</p>
        ) : (
          itins.map((x) => (
            <div key={x.id} className="row">
              <Link href={`/itinerary/${x.id}`}>{x.name}</Link>
              <span className="small muted">
                {x.versionCount} version{x.versionCount === 1 ? "" : "s"} · updated {new Date(x.updatedAt).toLocaleString()}
              </span>
              {x.trip && (
                <span className="small muted">
                  · {x.trip.label}: {x.trip.arrival} → {x.trip.departure}
                </span>
              )}
              {x.latest && <span className="small">{x.latest.headline}</span>}
              <span className="spacer" />
              <button
                className="link"
                onClick={async () => {
                  if (!confirm(`Delete “${x.name}” and all its versions?`)) return;
                  await fetch(`/api/itineraries/${x.id}`, { method: "DELETE" });
                  load();
                }}
              >
                Delete
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export { StatusBadges };
