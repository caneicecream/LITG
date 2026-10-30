"use client";

import { Fragment, useEffect, useState } from "react";
import type { QuoteDraft } from "@/data/importers/quoteText";
import type { UserPriceEntry } from "@/data/store";
import { formatShortDate, todayIso } from "@/domain/dates";
import { effectiveStatus } from "@/domain/provenance";
import type { StayQuote } from "@/domain/types";
import { BulkTickets } from "./prices/BulkTickets";
import { EntryForm, type EntryKind } from "./prices/EntryForm";
import { PasteQuote } from "./prices/PasteQuote";
import { QuoteForm, type QuoteFormMode } from "./prices/QuoteForm";
import { History, RecheckForm, StaleReview } from "./prices/Recheck";
import { describe, KIND_LABEL, priceText, staleAfterDays } from "./prices/shared";
import { StatusChip, STATUS_HELP } from "./ui";

type Tab = "paste" | "quote" | "bulk_tickets" | EntryKind;
const TABS: { id: Tab; label: string }[] = [
  { id: "paste", label: "Paste quotes" },
  { id: "quote", label: "Quote form" },
  { id: "bulk_tickets", label: "Bulk ticket prices" },
  { id: "room_rate", label: "Nightly rate" },
  { id: "ticket_price", label: "Ticket price" },
  { id: "ticket_rule", label: "Ticket rules" },
  { id: "dining_plan_price", label: "Dining plan" },
  { id: "point_chart", label: "DVC points chart" },
  { id: "point_cost", label: "DVC point cost" },
  { id: "promotion", label: "Promotion" },
];

export function PriceManager() {
  const [entries, setEntries] = useState<UserPriceEntry[] | null>(null);
  const [tab, setTab] = useState<Tab>("paste");
  const [quoteInit, setQuoteInit] = useState<{ draft?: QuoteDraft; mode: QuoteFormMode; key: number }>({ mode: "new", key: 0 });
  const [rowAction, setRowAction] = useState<{ id: string; action: "recheck" | "history" } | null>(null);
  const [kindFilter, setKindFilter] = useState<UserPriceEntry["kind"] | "all">("all");
  const [staleDays, setStaleDays] = useState(14);

  const load = () =>
    fetch("/api/prices")
      .then((r) => r.json())
      .then((b) => setEntries(b.entries));
  useEffect(() => {
    setStaleDays(staleAfterDays());
    load();
  }, []);

  const remove = async (id: string) => {
    if (!confirm("Delete this entry and its history? This cannot be undone.")) return;
    await fetch(`/api/prices?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    load();
  };
  const duplicate = (q: StayQuote) => {
    const { id: _id, history: _h, ...draft } = q;
    setQuoteInit({ draft, mode: "duplicate", key: Date.now() });
    setTab("quote");
    requestAnimationFrame(() => document.getElementById("entry-forms")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const shown = (entries ?? []).filter((e) => kindFilter === "all" || e.kind === kindFilter);
  const kinds = [...new Set((entries ?? []).map((e) => e.kind))];

  return (
    <div className="stack" style={{ gap: 16, maxWidth: 1150 }}>
      <div className="stack" style={{ gap: 6 }}>
        <h1>Price data</h1>
        <p className="muted">
          Real prices make the optimizer useful. Paste or enter quotes from booking pages and providers, then compare them on Plan & compare.
          Your entries are compared exactly and ranked separately from illustrative demo data. Re-check entries when they go stale; earlier
          observations are kept as history.
        </p>
        <details>
          <summary className="small muted" style={{ cursor: "pointer" }}>
            How prices are labelled
          </summary>
          <dl className="kv" style={{ marginTop: 8 }}>
            {(Object.keys(STATUS_HELP) as (keyof typeof STATUS_HELP)[]).map((s) => (
              <Fragment key={s}>
                <dt>
                  <StatusChip status={s} />
                </dt>
                <dd className="small">{STATUS_HELP[s]}</dd>
              </Fragment>
            ))}
          </dl>
          <p className="small muted">
            Your entries are <b>Manually entered</b> (copied from a real quote) or <b>Estimated</b> (your own estimate). <b>Verified</b> is reserved
            for vetted automated data sources, none of which is connected. When several prices cover the same item, the most trustworthy wins;
            among equally trusted prices, the most recent wins.
          </p>
        </details>
      </div>

      {entries && <StaleReview entries={entries} staleDays={staleDays} onChanged={load} />}

      <div className="card card-pad" id="entry-forms">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "active" : undefined}
              onClick={() => {
                if (t.id === "quote" && tab !== "quote") setQuoteInit({ mode: "new", key: Date.now() });
                setTab(t.id);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === "paste" && <PasteQuote onSaved={load} />}
        {tab === "quote" && (
          <QuoteForm
            key={quoteInit.key}
            initial={quoteInit.draft}
            mode={quoteInit.mode}
            onSaved={load}
            onCancel={quoteInit.mode === "duplicate" ? () => setQuoteInit({ mode: "new", key: Date.now() }) : undefined}
          />
        )}
        {tab === "bulk_tickets" && <BulkTickets onSaved={load} />}
        {tab !== "paste" && tab !== "quote" && tab !== "bulk_tickets" && <EntryForm key={tab} kind={tab} onSaved={load} />}
      </div>

      <div className="card">
        <div className="row card-pad" style={{ paddingBottom: 8 }}>
          <h2>Your prices ({entries?.length ?? 0})</h2>
          <span className="spacer" />
          {kinds.length > 1 && (
            <select aria-label="Filter by type" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)} style={{ width: "auto" }}>
              <option value="all">All types</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          )}
        </div>
        {!entries ? (
          <div className="empty">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="empty">No prices yet. Paste a quote above. Until then, only illustrative demo data is available.</div>
        ) : (
          <div className="table-wrap">
            <table className="cmp" aria-label="Your prices">
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
                {shown.map((e) => (
                  <Fragment key={e.id}>
                    <tr>
                      <td className="small">{KIND_LABEL[e.kind]}</td>
                      <td className="small">{describe(e)}</td>
                      <td className="r num">{priceText(e)}</td>
                      <td>
                        <StatusChip status={effectiveStatus(e.provenance, todayIso(), staleDays)} />
                        <div className="small muted">seen {formatShortDate(e.provenance.observedAt)}</div>
                        {e.history?.length ? <div className="small muted">{e.history.length} earlier observation(s)</div> : null}
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
                      <td style={{ whiteSpace: "nowrap" }}>
                        {e.kind === "stay_quote" && (
                          <button className="link" onClick={() => duplicate(e)}>
                            Duplicate
                          </button>
                        )}
                        <button className="link" onClick={() => setRowAction(rowAction?.id === e.id && rowAction.action === "recheck" ? null : { id: e.id, action: "recheck" })}>
                          Re-check
                        </button>
                        <button className="link" onClick={() => setRowAction(rowAction?.id === e.id && rowAction.action === "history" ? null : { id: e.id, action: "history" })}>
                          History
                        </button>
                        <button className="link danger" onClick={() => remove(e.id)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                    {rowAction?.id === e.id && (
                      <tr className="detail-row">
                        <td colSpan={6} style={{ padding: 14 }}>
                          {rowAction.action === "recheck" ? (
                            <RecheckForm
                              entry={e}
                              onCancel={() => setRowAction(null)}
                              onDone={() => {
                                setRowAction({ id: e.id, action: "history" });
                                load();
                              }}
                            />
                          ) : (
                            <History entry={e} />
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
