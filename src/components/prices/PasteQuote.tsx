"use client";

import { useState } from "react";
import { parseQuoteText, QUOTE_TEMPLATE, type ParsedQuote, type QuoteDraft } from "@/data/importers/quoteText";
import { formatCents } from "@/domain/money";
import { DINING_LABEL, TICKET_LABEL } from "@/domain/pricing/calculate";
import { formatDate, addDays } from "@/domain/dates";
import { QuoteForm } from "./QuoteForm";
import { Errors, postJson, resortName, roomName } from "./shared";

/**
 * Paste-friendly entry: type or paste "Key: value" lines (several quotes
 * separated by ---), check them, then save. Nothing is saved until the user
 * confirms, and incomplete quotes are explained, not guessed at.
 */
export function PasteQuote({ onSaved }: { onSaved: () => void }) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedQuote[] | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [saved, setSaved] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const read = () => {
    setParsed(parseQuoteText(text));
    setSaved(new Set());
    setEditing(null);
    setErrors([]);
    setMsg(null);
  };
  const valid = (parsed ?? []).map((p, i) => ({ p, i })).filter(({ p, i }) => p.entry && !saved.has(i));

  const saveAll = async () => {
    const res = await postJson("/api/prices", { entries: valid.map(({ p }) => p.entry) });
    if (!res.ok) return setErrors(res.errors);
    setSaved(new Set([...saved, ...valid.map(({ i }) => i)]));
    setMsg(`Saved ${valid.length} quote${valid.length === 1 ? "" : "s"}.`);
    onSaved();
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <p className="small muted">
        Type or paste quote details as <code>Key: value</code> lines. Separate several quotes with a line of <code>---</code>. Required:
        resort, room, check-in, check-out (or nights), adults, children, booking (package / room only / points), total, taxes included,
        source and observed date; packages also need tickets and dining. Optional: deposit, due dates, refundability, cancellation
        penalties, booked, ticket usage, URL, notes. Nothing is filled in for you, and nothing is saved until you confirm.
      </p>
      <textarea
        aria-label="Quote text"
        rows={14}
        className="mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={QUOTE_TEMPLATE}
      />
      <div className="row">
        <button type="button" className="primary" onClick={read} disabled={!text.trim()}>
          Check quotes
        </button>
        <button type="button" onClick={() => setText((t) => (t.trim() ? `${t.trim()}\n---\n${QUOTE_TEMPLATE}` : QUOTE_TEMPLATE))}>
          Insert template
        </button>
      </div>

      {parsed && (
        <div className="stack" style={{ gap: 10 }}>
          <div className="row">
            <b>
              {parsed.length} quote{parsed.length === 1 ? "" : "s"} read · {parsed.filter((p) => p.entry).length} ready · {parsed.filter((p) => !p.entry).length} need
              fixes
            </b>
            <span className="spacer" />
            {valid.length > 1 && (
              <button type="button" className="primary" onClick={saveAll}>
                Save all {valid.length} ready quotes
              </button>
            )}
          </div>
          {msg && <div className="small save-pos">{msg}</div>}
          <Errors errors={errors} />
          {parsed.map((p, i) => (
            <div key={i} className="card card-pad stack" style={{ gap: 8, borderColor: p.entry ? undefined : "var(--bad)" }} data-testid="parsed-quote">
              <div className="row">
                <b>Quote {i + 1}</b>
                {saved.has(i) ? <span className="chip chip-manual">Saved</span> : p.entry ? <span className="chip chip-verified">Ready to save</span> : <span className="chip chip-unavailable">Needs fixes</span>}
                <span className="spacer" />
                {p.entry && !saved.has(i) && editing !== i && (
                  <>
                    <button type="button" onClick={() => setEditing(i)}>
                      Review in form
                    </button>
                    <button
                      type="button"
                      className="primary"
                      onClick={async () => {
                        const res = await postJson("/api/prices", p.entry);
                        if (!res.ok) return setErrors(res.errors);
                        setSaved(new Set([...saved, i]));
                        onSaved();
                      }}
                    >
                      Save
                    </button>
                  </>
                )}
              </div>
              {p.entry && <Summary q={p.entry} />}
              <Errors errors={p.errors} />
              {p.warnings.length > 0 && (
                <ul className="notices small muted">
                  {p.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              {editing === i && p.entry && (
                <QuoteForm
                  initial={p.entry}
                  mode="review"
                  onCancel={() => setEditing(null)}
                  onSaved={() => {
                    setSaved(new Set([...saved, i]));
                    setEditing(null);
                    onSaved();
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Summary({ q }: { q: QuoteDraft }) {
  const t = q.terms;
  return (
    <dl className="kv">
      <dt>Stay</dt>
      <dd>
        {resortName(q.resortId)}, {roomName(q.resortId, q.roomTypeId)} · {formatDate(q.checkIn)} → {formatDate(addDays(q.checkIn, q.nights))} ({q.nights} nights)
      </dd>
      <dt>Party</dt>
      <dd>
        {q.adults} adult{q.adults === 1 ? "" : "s"}, {q.children} child{q.children === 1 ? "" : "ren"}
      </dd>
      <dt>Booking</dt>
      <dd>
        {q.bookingMethod === "package"
          ? `Package: ${q.ticket!.days}-day ${TICKET_LABEL[q.ticket!.option]}, ${DINING_LABEL[q.dining]}`
          : q.bookingMethod === "points"
            ? `DVC point rental${q.points ? ` (${q.points.pointsRequired} points × ${formatCents(q.points.centsPerPoint)})` : ""}`
            : "Room only"}
      </dd>
      <dt>Total</dt>
      <dd>
        <b>{formatCents(q.totalCents)}</b> {q.taxIncluded ? "including taxes" : q.taxCents !== undefined ? `+ ${formatCents(q.taxCents)} taxes` : "before taxes"}
      </dd>
      {t && (
        <>
          <dt>Terms</dt>
          <dd>
            {t.depositCents !== null ? `Deposit ${formatCents(t.depositCents)}` : "Deposit unknown"} · {t.refundability.replace("_", " ")}
            {t.freeCancellationUntil ? ` · free cancellation until ${t.freeCancellationUntil}` : ""}
            {t.cancellationPenalties.length ? ` · ${t.cancellationPenalties.length} penalty tier(s)` : ""}
            {q.booked ? " · existing reservation" : ""}
          </dd>
        </>
      )}
      <dt>Source</dt>
      <dd>
        {q.provenance.source} · observed {q.provenance.observedAt} · {q.provenance.status === "manual" ? "manually entered" : "estimated"}
      </dd>
    </dl>
  );
}
