"use client";

import { useState } from "react";
import { priceUnit, priceValue } from "@/data/observations";
import type { UserPriceEntry } from "@/data/store";
import { formatShortDate, todayIso } from "@/domain/dates";
import { formatCents } from "@/domain/money";
import { effectiveStatus } from "@/domain/provenance";
import { MoneyInput, NumberInput, StatusChip } from "../ui";
import { describe, Errors, KIND_LABEL, postJson, priceText } from "./shared";

const fmtValue = (e: UserPriceEntry, v: number | null) => (v === null ? "—" : priceUnit(e) === "points" ? `${v} pts` : formatCents(v));

/**
 * "Is this still current?" Re-check one entry: confirm the price is unchanged,
 * or record a new price and/or source. The previous observation is kept in the
 * entry's history (never overwritten).
 */
export function RecheckForm({ entry, onDone, onCancel }: { entry: UserPriceEntry; onDone: () => void; onCancel?: () => void }) {
  const unit = priceUnit(entry);
  const [observedAt, setObservedAt] = useState(todayIso());
  const [value, setValue] = useState<number | undefined>(undefined);
  const [source, setSource] = useState(entry.provenance.source);
  const [sourceUrl, setSourceUrl] = useState(entry.provenance.sourceUrl ?? "");
  const [notes, setNotes] = useState(entry.provenance.notes ?? "");
  const [errors, setErrors] = useState<string[]>([]);

  const submit = async (changed: boolean) => {
    if (changed && value === undefined) {
      setErrors(["Enter the new price, or use “Still current”"]);
      return;
    }
    const res = await postJson("/api/prices/recheck", {
      id: entry.id,
      observedAt,
      source,
      sourceUrl: sourceUrl.trim() ? sourceUrl.trim() : null,
      notes: notes.trim() ? notes.trim() : null,
      ...(changed ? { value } : {}),
    });
    if (!res.ok) return setErrors(res.errors);
    onDone();
  };

  return (
    <div className="stack" style={{ gap: 10 }} data-testid="recheck-form">
      <div className="small">
        <b>Currently:</b> {priceText(entry)} · seen {formatShortDate(entry.provenance.observedAt)} · {entry.provenance.source}
      </div>
      <div className="grid3">
        <label className="field">
          Checked on
          <input type="date" value={observedAt} onChange={(e) => setObservedAt(e.target.value)} />
        </label>
        {unit && (
          <label className="field">
            New {unit === "points" ? "points per night" : "price"} (if it changed)
            {unit === "points" ? (
              <NumberInput min={1} value={value} onChange={setValue} />
            ) : (
              <MoneyInput optional value={value} onChange={setValue} step={0.01} />
            )}
          </label>
        )}
        <label className="field">
          Source
          <input value={source} onChange={(e) => setSource(e.target.value)} />
        </label>
        <label className="field" style={{ gridColumn: "span 2" }}>
          Link
          <input type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
        </label>
        <label className="field">
          Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      <Errors errors={errors} />
      <div className="row">
        <button type="button" className="primary" onClick={() => submit(false)}>
          Still current
        </button>
        {unit && (
          <button type="button" onClick={() => submit(true)}>
            Save new price
          </button>
        )}
        {onCancel && (
          <button type="button" className="link" onClick={onCancel}>
            Cancel
          </button>
        )}
        <span className="hint">The previous observation is kept in the history.</span>
      </div>
    </div>
  );
}

/** Entries whose observation is older than the staleness threshold, each with a re-check form. */
export function StaleReview({ entries, staleDays, onChanged }: { entries: UserPriceEntry[]; staleDays: number; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const today = todayIso();
  const stale = entries.filter((e) => effectiveStatus(e.provenance, today, staleDays) === "stale");
  if (stale.length === 0) return null;
  return (
    <div className="card card-pad stack" style={{ borderColor: "var(--warn)" }} data-testid="stale-review">
      <div className="row">
        <h2>Needs re-checking</h2>
        <span className="chip chip-stale">{stale.length}</span>
      </div>
      <p className="small muted">
        These prices were last observed more than {staleDays} days ago, so results using them are marked <StatusChip status="stale" />. Check each
        source again and confirm the price or record the new one.
      </p>
      {stale.map((e) => (
        <div key={e.id} className="stack" style={{ gap: 6, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          <div className="row">
            <span className="small">
              <b>{KIND_LABEL[e.kind]}:</b> {describe(e)}
            </span>
            <span className="spacer" />
            {open !== e.id && (
              <button type="button" onClick={() => setOpen(e.id)}>
                Re-check
              </button>
            )}
          </div>
          {open === e.id && (
            <RecheckForm
              entry={e}
              onCancel={() => setOpen(null)}
              onDone={() => {
                setOpen(null);
                onChanged();
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/** Every observation of an entry, newest first. */
export function History({ entry }: { entry: UserPriceEntry }) {
  const rows = [
    { observedAt: entry.provenance.observedAt, value: priceValue(entry), source: entry.provenance.source, sourceUrl: entry.provenance.sourceUrl, status: entry.provenance.status, current: true },
    ...[...(entry.history ?? [])].reverse().map((h) => ({ ...h, current: false })),
  ];
  return (
    <table className="cmp small" aria-label="Observation history">
      <thead>
        <tr>
          <th>Observed</th>
          <th className="r">Value</th>
          <th>Source</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{formatShortDate(r.observedAt)}</td>
            <td className="r num">{fmtValue(entry, r.value)}</td>
            <td>
              {r.sourceUrl ? (
                <a href={r.sourceUrl} target="_blank" rel="noreferrer">
                  {r.source}
                </a>
              ) : (
                r.source
              )}
            </td>
            <td>{r.current ? <span className="chip chip-plain">current</span> : null}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
