"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { defaultTripRequest } from "@/data/defaults";
import { parseTripRequest } from "@/domain/schema";
import type { Evaluation, OptimizationResult, TripRequest } from "@/domain/types";
import { Results } from "./Results";
import { TripForm } from "./TripForm";

const DRAFT_KEY = "dvo:draft-request";

export function Planner() {
  const params = useSearchParams();
  const router = useRouter();
  const tripId = params.get("trip");
  const [request, setRequest] = useState<TripRequest>(defaultTripRequest);
  const [trip, setTrip] = useState<{ id: string; name: string } | null>(null);
  const [result, setResult] = useState<OptimizationResult | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const loaded = useRef(false);
  // The request that produced `result`; detail look-ups must use it, not later edits.
  const lastRun = useRef<TripRequest | null>(null);

  const run = useCallback(async (req: TripRequest) => {
    const parsed = parseTripRequest(req);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors([]);
    setRunning(true);
    try {
      const res = await fetch("/api/optimize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
      const body = await res.json();
      if (!res.ok) setErrors(body.errors ?? ["Optimization failed"]);
      else {
        lastRun.current = req;
        setResult(body as OptimizationResult);
        setStale(false);
      }
    } catch (err) {
      setErrors([`Could not reach the optimizer: ${String(err)}`]);
    } finally {
      setRunning(false);
    }
  }, []);

  // Initial load: a saved trip (?trip=id), else the local draft, else defaults. Then run once.
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    (async () => {
      let initial = defaultTripRequest();
      if (tripId) {
        const res = await fetch(`/api/trips?id=${encodeURIComponent(tripId)}`);
        if (res.ok) {
          const { trip: t } = await res.json();
          initial = t.request;
          setTrip({ id: t.id, name: t.name });
          setSaveName(t.name);
        } else {
          setErrors(["That saved trip could not be found."]);
        }
      } else {
        try {
          const draft = localStorage.getItem(DRAFT_KEY);
          if (draft && parseTripRequest(JSON.parse(draft)).ok) initial = JSON.parse(draft);
        } catch {
          /* storage unavailable: use defaults */
        }
      }
      setRequest(initial);
      run(initial);
    })();
  }, [tripId, run]);

  const update = (r: TripRequest) => {
    setRequest(r);
    setStale(true);
    setSavedMsg(null);
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(r));
    } catch {
      /* ignore */
    }
  };

  const save = async () => {
    const name = saveName.trim() || "My Disney trip";
    setSaving(true);
    try {
      const res = await fetch("/api/trips", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: trip?.id, name, request }),
      });
      const body = await res.json();
      if (!res.ok) setErrors(body.errors ?? ["Save failed"]);
      else {
        setTrip({ id: body.trip.id, name: body.trip.name });
        setSavedMsg(`Saved “${body.trip.name}”.`);
        if (!tripId) router.replace(`/?trip=${body.trip.id}`, { scroll: false });
      }
    } finally {
      setSaving(false);
    }
  };

  const loadDetail = useCallback(async (id: string): Promise<Evaluation | null> => {
    if (!lastRun.current) return null;
    const res = await fetch(`/api/optimize?include=${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(lastRun.current),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as OptimizationResult;
    return body.included.find((e) => e.id === id) ?? null;
  }, []);

  const reset = () => {
    const d = defaultTripRequest();
    setTrip(null);
    setSaveName("");
    update(d);
    if (tripId) router.replace("/", { scroll: false });
    run(d);
  };

  return (
    <div className="planner">
      <aside className="card sidebar">
        <div className="section row">
          <h2 style={{ flex: 1 }}>{trip ? trip.name : "Plan a trip"}</h2>
          <button type="button" className="link" onClick={reset}>
            Reset
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(request);
          }}
        >
          <TripForm request={request} onChange={update} />
          <div className="actions" style={{ flexDirection: "column" }}>
            {errors.length > 0 && (
              <div className="banner banner-error small">
                <ul className="notices">
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
            <button type="submit" className="primary" disabled={running}>
              {running && <span className="spinner" />} {running ? "Optimizing…" : stale ? "Find best options (inputs changed)" : "Find best options"}
            </button>
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input aria-label="Trip name" placeholder="Trip name" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
              <button type="button" onClick={save} disabled={saving} style={{ whiteSpace: "nowrap" }}>
                {trip ? "Update saved trip" : "Save trip"}
              </button>
            </div>
            {savedMsg && <div className="small save-pos">{savedMsg}</div>}
          </div>
        </form>
      </aside>

      <section>
        {result ? (
          <div style={{ opacity: stale ? 0.6 : 1, transition: "opacity 0.15s" }}>
            {stale && (
              <div className="banner banner-info small" style={{ marginBottom: 12 }}>
                Inputs changed. These results are from the previous run. Press “Find best options” to recalculate.
              </div>
            )}
            <Results result={result} loadDetail={loadDetail} />
          </div>
        ) : (
          <div className="card empty">{running ? "Optimizing…" : "Set up your trip and press “Find best options”."}</div>
        )}
      </section>
    </div>
  );
}
