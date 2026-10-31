"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { describeRequest, unconfirmedSections } from "@/ai/patch";
import type { AiStatus } from "@/ai/providers/config";
import type { Conversation, ConversationMessage } from "@/ai/types";
import { CATALOG } from "@/data/catalog";
import type { ConversationSummary } from "@/data/store";
import type { Evaluation, OptimizationResult, TripRequest } from "@/domain/types";
import { Results } from "../Results";
import { TripForm } from "../TripForm";
import { MessageView } from "./Messages";
import { CompareView, ItineraryView } from "../itinerary/ItineraryView";

const SUGGESTIONS = [
  "What if we stayed one more night?",
  "Could I save money by arriving a day earlier?",
  "Show me what happens if I remove Park Hopper Plus.",
  "Compare a Deluxe resort against a Value resort.",
  "Why did the cheapest option win?",
];

const ITINERARY_SUGGESTIONS = [
  "Build a relaxed plan.",
  "Minimize walking and avoid crossing the park repeatedly.",
  "Keep our afternoons flexible.",
  "Compare a ride-focused plan with a relaxed plan.",
  "What would we lose if we removed a park day?",
];

const EXAMPLE =
  "Two adults for my birthday, ideally six or seven nights, preferably Pop Century, with Park Hopper Plus and a dining plan. I'd like to keep it under $5,000 but I'm flexible with dates.";

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { errors?: string[] }).errors?.join("; ") ?? `Request failed (${res.status})`);
  return data as T;
}

export function AssistantPage() {
  const params = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [list, setList] = useState<ConversationSummary[]>([]);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TripRequest | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const id = params.get("c");

  const loadList = useCallback(() => fetch("/api/conversations").then((r) => r.json()).then((b) => setList(b.conversations ?? [])), []);

  useEffect(() => {
    fetch("/api/assistant").then((r) => r.json()).then(setStatus).catch(() => setStatus(null));
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (!id) {
      setConv(null);
      return;
    }
    fetch(`/api/conversations?id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("This conversation no longer exists."))))
      .then((b) => setConv(b.conversation))
      .catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conv?.messages.length, busy]);

  const act = async (label: string, body: Record<string, unknown>) => {
    if (!conv) return;
    setBusy(label);
    setError(null);
    try {
      const { conversation } = await post<{ conversation: Conversation }>("/api/assistant", { conversationId: conv.id, ...body });
      setConv(conversation);
      loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const start = async (request?: TripRequest) => {
    setBusy("Starting…");
    try {
      const { conversation } = await post<{ conversation: Conversation }>("/api/conversations", request ? { request } : {});
      router.push(`/assistant?c=${conversation.id}`);
      setConv(conversation);
      loadList();
      return conversation;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const send = async (message: string) => {
    const m = message.trim();
    if (!m) return;
    setText("");
    let c = conv;
    if (!c) c = (await start()) ?? null;
    if (!c) return;
    setBusy(status?.mode === "ai" ? "Interpreting your request…" : "Reading your request…");
    setError(null);
    // Show the message immediately while the server works.
    setConv({ ...c, messages: [...c.messages, { id: "pending", at: new Date().toISOString(), role: "user", kind: "user", text: m }] });
    try {
      const { conversation } = await post<{ conversation: Conversation }>("/api/assistant", { action: "message", conversationId: c.id, text: m });
      setConv(conversation);
      loadList();
    } catch (e) {
      setConv(c);
      setText(m);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!conv || !confirm(`Delete “${conv.title}”?`)) return;
    await fetch(`/api/conversations?id=${encodeURIComponent(conv.id)}`, { method: "DELETE" });
    setConv(null);
    router.push("/assistant");
    loadList();
  };

  const loadDetail = useCallback(
    async (evalId: string): Promise<Evaluation | null> => {
      if (!conv) return null;
      const res = await fetch(`/api/optimize?include=${encodeURIComponent(evalId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(conv.request) });
      if (!res.ok) return null;
      return ((await res.json()) as OptimizationResult).included.find((e) => e.id === evalId) ?? null;
    },
    [conv],
  );

  const openInPlanner = () => {
    if (!conv) return;
    try {
      localStorage.setItem("dvo:draft-request", JSON.stringify(conv.request));
    } catch {
      /* ignore */
    }
    router.push("/");
  };

  const openItinerary = () => {
    const it = conv?.itinerary;
    if (!it) return;
    try {
      localStorage.setItem("dvo:itinerary-draft", JSON.stringify({ input: it.input, tripId: it.tripId, savedId: it.savedId }));
    } catch {
      /* ignore */
    }
    // A saved itinerary opens with the assistant's changes on top, to save as a new version.
    router.push(it.savedId ? `/itinerary/${it.savedId}?draft=1` : "/itinerary");
  };

  const isCurrent = (m: ConversationMessage) => JSON.stringify(m.run?.request) === JSON.stringify(conv?.request);
  const entries = conv ? describeRequest(conv.request, CATALOG) : [];
  const unconfirmed = conv ? unconfirmedSections(conv.confirmed) : [];

  return (
    <div className="assistant-layout">
      <section className="card chat">
        <div className="chat-head">
          <div className="row">
            <select
              aria-label="Conversation"
              value={conv?.id ?? ""}
              onChange={(e) => router.push(e.target.value ? `/assistant?c=${e.target.value}` : "/assistant")}
              style={{ flex: 1, width: "auto" }}
            >
              <option value="">{conv ? "—" : "Select a conversation…"}</option>
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => start()} disabled={!!busy}>
              New
            </button>
            {conv && (
              <button type="button" className="link danger" onClick={remove}>
                Delete
              </button>
            )}
          </div>
          <div className="row small">
            {status && (
              <span className={`chip ${status.mode === "ai" ? "chip-manual" : "chip-plain"}`} title={status.reason ?? status.provider}>
                {status.mode === "ai" ? status.label : "Basic mode"}
              </span>
            )}
            {status?.mode === "basic" && <span className="muted">{status.reason} Set ANTHROPIC_API_KEY for the AI assistant.</span>}
            <span className="spacer" />
            {conv && (
              <label className="check small">
                <input type="checkbox" checked={conv.autoApply} onChange={(e) => act("Saving…", { action: "settings", autoApply: e.target.checked })} /> Apply changes automatically
              </label>
            )}
          </div>
        </div>

        <div className="chat-body" aria-live="polite">
          {!conv?.messages.length && (
            <div className="stack small muted" style={{ padding: 8 }}>
              <p>
                Describe the trip you want in your own words. I&apos;ll turn it into a plan you can review; the optimizer then prices and ranks every option.
                Every price you see comes from the optimizer, never from the AI.
              </p>
              <button type="button" className="link" style={{ alignSelf: "flex-start" }} onClick={() => setText(EXAMPLE)}>
                Try an example
              </button>
            </div>
          )}
          {conv?.messages.map((m) => (
            <MessageView
              key={m.id}
              m={m}
              busy={!!busy}
              onApply={(mid) => act("Running the optimizer…", { action: "apply", messageId: mid })}
              onDismiss={(mid) => act("Dismissing…", { action: "dismiss", messageId: mid })}
              onRestore={(msg) => act("Restoring and re-running…", { action: "run", request: msg.run!.request, reason: "restore" })}
              isCurrentRequest={isCurrent}
            />
          ))}
          {busy && (
            <div className="chat-notice small">
              <span className="spinner dark" /> {busy}
            </div>
          )}
          {error && (
            <div className="banner banner-error small" role="alert">
              {error}
            </div>
          )}
          <div ref={chatEnd} />
        </div>

        <form
          className="chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          {(conv?.lastResult || conv?.itinerary) && (
            <div className="suggestions">
              {(conv.itinerary ? ITINERARY_SUGGESTIONS : SUGGESTIONS).map((s) => (
                <button key={s} type="button" className="suggest" disabled={!!busy} onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
          <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-end" }}>
            <textarea
              aria-label="Message"
              rows={2}
              value={text}
              placeholder="e.g. 6 nights in late January for two adults, under $4,500"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(text);
                }
              }}
            />
            <button type="submit" className="primary" disabled={!!busy || !text.trim()}>
              Send
            </button>
          </div>
        </form>
      </section>

      <section className="stack" style={{ gap: 16, minWidth: 0 }}>
        {conv?.itinerary && (
          <div className="card card-pad stack" data-testid="itinerary-panel">
            <div className="row">
              <h2>Itinerary</h2>
              <span className="small muted">Planned by deterministic rules; the assistant only proposes preference changes.</span>
              <span className="spacer" />
              <button type="button" onClick={openItinerary}>
                Open in itinerary planner
              </button>
            </div>
            {conv.itinerary.lastComparison ? (
              <CompareView variants={conv.itinerary.lastComparison} summary={[]} />
            ) : conv.itinerary.lastResult ? (
              <ItineraryView it={conv.itinerary.lastResult} compact />
            ) : (
              <p className="small muted">No itinerary yet. Ask for one (“Build a relaxed plan”) or apply a proposed change.</p>
            )}
          </div>
        )}
        {conv?.itinerary && (
          <p className="small muted">
            Itinerary for {conv.itinerary.input.context.source.label}: {conv.itinerary.input.context.arrival} → {conv.itinerary.input.context.departure}. Trip-pricing questions (nights, resorts, budget) use the trip plan below.
          </p>
        )}
        {conv ? (
          <div className="card card-pad stack" data-testid="plan-summary">
            <div className="row">
              <h2>Your plan</h2>
              <span className="small muted">The structured request the optimizer runs. AI changes appear here only after you apply them.</span>
              <span className="spacer" />
              <button
                type="button"
                onClick={() => {
                  setDraft(structuredClone(conv.request));
                  setEditing(!editing);
                }}
              >
                {editing ? "Close editor" : "Edit plan"}
              </button>
              <button type="button" onClick={openInPlanner}>
                Open in full planner
              </button>
            </div>
            <div className="plan-grid">
              {(["requirement", "preference"] as const).map((kind) => (
                <div key={kind}>
                  <div className="section-title">{kind === "requirement" ? "Requirements (filter options out)" : "Preferences (only rank)"}</div>
                  <dl className="kv small">
                    {entries
                      .filter((e) => e.kind === kind)
                      .map((e) => (
                        <FragmentRow key={e.key} label={e.label} value={e.value} unconfirmed={unconfirmed.includes(e.section)} />
                      ))}
                  </dl>
                </div>
              ))}
            </div>
            {unconfirmed.length > 0 && (
              <p className="small muted">
                <span className="chip chip-plain">default</span> marks values you haven&apos;t told me yet. Tell me, or edit the plan.
              </p>
            )}
            {editing && draft && (
              <div className="card" style={{ maxHeight: 520, overflowY: "auto" }}>
                <TripForm request={draft} onChange={setDraft} />
                <div className="actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={!!busy}
                    onClick={async () => {
                      await act("Running the optimizer…", { action: "run", request: draft, reason: "form" });
                      setEditing(false);
                    }}
                  >
                    Run with these changes
                  </button>
                  <button type="button" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="card card-pad stack">
            <h2>Plan with the assistant</h2>
            <p className="muted">
              Start by describing your trip on the left, or continue a saved conversation. You can also start from the plan currently in the
              planner.
            </p>
            <div className="row">
              <button
                type="button"
                onClick={() => {
                  try {
                    const raw = localStorage.getItem("dvo:draft-request");
                    start(raw ? (JSON.parse(raw) as TripRequest) : undefined);
                  } catch {
                    start();
                  }
                }}
              >
                Start from my planner settings
              </button>
            </div>
          </div>
        )}

        {conv?.lastResult ? (
          <Results result={conv.lastResult} loadDetail={loadDetail} />
        ) : conv && !conv.itinerary ? (
          <div className="card empty">No results yet. Apply a proposed change (or edit the plan) to run the optimizer.</div>
        ) : null}
      </section>
    </div>
  );
}

function FragmentRow({ label, value, unconfirmed }: { label: string; value: string; unconfirmed: boolean }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {value} {unconfirmed && <span className="chip chip-plain">default</span>}
      </dd>
    </>
  );
}
