"use client";

import { useState } from "react";
import type { ConversationMessage, Fact } from "@/ai/types";
import { formatCents } from "@/domain/money";

/** Renders [F3] citations as small chips that reveal the cited fact. */
function Cited({ text, facts }: { text: string; facts: Fact[] }) {
  const byId = new Map(facts.map((f) => [f.id, f.text]));
  const parts = text.split(/(\[F\d+\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^\[(F\d+)\]$/);
        if (!m) return <span key={i}>{p}</span>;
        return (
          <span key={i} className="cite" title={byId.get(m[1]!) ?? "Unknown fact"}>
            {m[1]}
          </span>
        );
      })}
    </>
  );
}

export function MessageView({
  m,
  busy,
  onApply,
  onDismiss,
  onRestore,
  isCurrentRequest,
}: {
  m: ConversationMessage;
  busy: boolean;
  onApply: (id: string) => void;
  onDismiss: (id: string) => void;
  onRestore: (m: ConversationMessage) => void;
  isCurrentRequest: (m: ConversationMessage) => boolean;
}) {
  const [showFacts, setShowFacts] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);

  if (m.kind === "user") return <div className="bubble user">{m.text}</div>;
  if (m.kind === "notice") return <div className="chat-notice small">{m.text}</div>;
  if (m.kind === "error")
    return (
      <div className="banner banner-error small" role="alert">
        {m.text}
      </div>
    );
  if (m.kind === "reply")
    return (
      <div className="bubble assistant">
        <div className="bubble-label">Assistant · interpretation</div>
        <div className="pre">{m.text}</div>
      </div>
    );

  if (m.kind === "proposal" && m.proposal) {
    const p = m.proposal;
    return (
      <div className={`card proposal proposal-${p.status}`} data-testid="proposal">
        <div className="row">
          <b>Proposed changes</b>
          <span className={`chip ${p.status === "pending" ? "chip-estimated" : p.status === "applied" ? "chip-manual" : p.status === "invalid" ? "chip-unavailable" : "chip-plain"}`}>{p.status}</span>
          <span className="spacer" />
          <span className="small muted">{m.source === "rules" ? "basic mode" : "AI interpretation"}</span>
        </div>
        {m.text && <div className="pre small">{m.text}</div>}
        {p.diff.length > 0 && (
          <ul className="diff">
            {p.diff.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        )}
        {p.adjustments.map((a) => (
          <div key={a} className="small muted">
            ↳ {a}
          </div>
        ))}
        {p.comparisons.length > 0 && (
          <div className="small">
            <b>Side-by-side comparisons:</b>
            <ul className="diff">
              {p.comparisons.map((c) => (
                <li key={c.label}>
                  {c.label}
                  {c.diff.length ? `: ${c.diff.join("; ")}` : ""}
                  {c.errors.length ? <span className="save-neg"> — {c.errors.join("; ")}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}
        {p.warnings.map((w) => (
          <div key={w} className="small save-neg">
            ⚠ {w}
          </div>
        ))}
        {p.errors.length > 0 && (
          <div className="banner banner-error small">
            Can't apply: {p.errors.join("; ")}
          </div>
        )}
        {p.proposal.evidence.length > 0 && (
          <button type="button" className="link small" onClick={() => setShowEvidence(!showEvidence)}>
            {showEvidence ? "Hide" : "Show"} what I based this on
          </button>
        )}
        {showEvidence && (
          <ul className="small muted diff">
            {p.proposal.evidence.map((e, i) => (
              <li key={i}>
                {e.field}: “{e.userQuote}”
              </li>
            ))}
          </ul>
        )}
        {p.status === "pending" && (
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => onApply(m.id)}>
              Apply & run optimizer
            </button>
            <button type="button" disabled={busy} onClick={() => onDismiss(m.id)}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    );
  }

  if (m.kind === "result" && m.run) {
    const r = m.run;
    return (
      <div className="card result-msg" data-testid="result-message">
        <div className="row">
          <b>Optimizer results</b>
          <span className="chip chip-plain">calculated by the optimizer</span>
          <span className="spacer" />
          {!isCurrentRequest(m) && (
            <button type="button" className="link small" disabled={busy} onClick={() => onRestore(m)}>
              Restore this plan
            </button>
          )}
        </div>
        <div className="small">{m.text}</div>
        {r.diff.length > 0 && <div className="small muted">After: {r.diff.join("; ")}</div>}
        {r.variants.length > 0 && (
          <table className="cmp small">
            <tbody>
              {r.variants.map((v) => (
                <tr key={v.label}>
                  <td>{v.label}</td>
                  <td className="r num">{v.summary?.cheapest ? `cheapest ${formatCents(v.summary.cheapest.totalCents)}` : (v.error ?? "no fully priced option")}</td>
                  <td className="r num">{v.summary?.bestValue ? `best value ${formatCents(v.summary.bestValue.totalCents)}` : ""}</td>
                  <td>{v.summary?.demoMode ? <span className="chip chip-illustrative">Illustrative</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  if (m.kind === "explanation" && m.explanation) {
    const e = m.explanation;
    return (
      <div className="bubble assistant" data-testid="explanation">
        <div className="bubble-label">{e.grounded === "ai" ? "AI explanation · every figure checked against the optimizer's results" : "Optimizer facts (deterministic explanation)"}</div>
        {e.rejectedReason && <div className="small save-neg">{e.rejectedReason}</div>}
        <div className="pre">
          <Cited text={m.text} facts={e.facts} />
        </div>
        <button type="button" className="link small" onClick={() => setShowFacts(!showFacts)}>
          {showFacts ? "Hide" : "Show"} the {e.facts.length} optimizer facts behind this
        </button>
        {showFacts && (
          <ol className="facts small">
            {e.facts.map((f) => (
              <li key={f.id} className={e.cited.includes(f.id) ? "cited" : undefined}>
                <b>{f.id}</b> {f.text}
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }
  return null;
}
