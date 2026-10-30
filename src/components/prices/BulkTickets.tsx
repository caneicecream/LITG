"use client";

import { useState } from "react";
import { parseTicketPriceTable, type BulkTicketResult } from "@/data/importers/ticketBulk";
import { formatShortDate } from "@/domain/dates";
import { formatCents } from "@/domain/money";
import { TICKET_LABEL } from "@/domain/pricing/calculate";
import type { AgeCategory, TicketChannel, TicketOption } from "@/domain/types";
import { NumberInput } from "../ui";
import { emptyProvenance, emptyUsage, Errors, postJson, ProvenanceFields, toProvenance, toUsage, UsageFields } from "./shared";

const TICKETS = Object.keys(TICKET_LABEL) as TicketOption[];
const EXAMPLE = `2027-01-04, $612.00
2027-01-05 .. 2027-01-08, 598.00
Jan 9, 2027 to Jan 15, 2027, 640.50`;

/**
 * Bulk entry from a published ticket price calendar: one date (or range) and
 * price per line, or a table with a header row. Validated as a whole and saved
 * all-or-nothing.
 */
export function BulkTickets({ onSaved }: { onSaved: () => void }) {
  const [option, setOption] = useState<TicketOption | "">("park_hopper");
  const [days, setDays] = useState<number | undefined>(4);
  const [age, setAge] = useState<AgeCategory | "">("adult");
  const [channel, setChannel] = useState<TicketChannel>("disney");
  const [taxIncluded, setTaxIncluded] = useState(false);
  const [usage, setUsage] = useState(emptyUsage());
  const [prov, setProv] = useState(emptyProvenance("Walt Disney World ticket price calendar"));
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<BulkTicketResult | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const check = () => {
    setMsg(null);
    setErrors([]);
    if (!prov.source.trim()) {
      setErrors(["Say where these prices came from"]);
      return;
    }
    setPreview(
      parseTicketPriceTable(text, {
        option: option || undefined,
        days,
        age: age || undefined,
        channel,
        taxIncluded,
        usage: toUsage(usage),
        provenance: toProvenance(prov),
      }),
    );
  };

  const save = async () => {
    if (!preview || preview.entries.length === 0) return;
    const res = await postJson("/api/prices", { entries: preview.entries });
    if (!res.ok) return setErrors(res.errors);
    setMsg(`Saved ${preview.entries.length} ticket price${preview.entries.length === 1 ? "" : "s"}.`);
    setPreview(null);
    setText("");
    onSaved();
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <p className="small muted">
        Enter several date-specific prices at once, e.g. from a published price calendar. Each line is a start date (or a range of start
        dates) and the per-person price for the whole ticket. A table with a header row (<code>start,end,ticket,days,age,price,use_within</code>)
        can set those per row instead. Every line is validated; nothing is saved unless all lines are valid.
      </p>
      <div className="grid3">
        <label className="field">
          Ticket type
          <select value={option} onChange={(e) => setOption(e.target.value as TicketOption | "")}>
            <option value="">From each row</option>
            {TICKETS.map((t) => (
              <option key={t} value={t}>
                {TICKET_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Days (blank = from each row)
          <NumberInput min={1} max={10} value={days} onChange={setDays} />
        </label>
        <label className="field">
          Age
          <select value={age} onChange={(e) => setAge(e.target.value as AgeCategory | "")}>
            <option value="">From each row</option>
            <option value="adult">Adult (10+)</option>
            <option value="child">Child (3–9)</option>
          </select>
        </label>
        <label className="field">
          Sold by
          <select value={channel} onChange={(e) => setChannel(e.target.value as TicketChannel)}>
            <option value="disney">Disney</option>
            <option value="third_party">Authorized third-party seller</option>
          </select>
        </label>
        <label className="check" style={{ alignSelf: "end" }}>
          <input type="checkbox" checked={taxIncluded} onChange={(e) => setTaxIncluded(e.target.checked)} /> Prices include tax
        </label>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <h3>Usage rules for this batch (optional)</h3>
        <p className="hint">Only record rules stated for these tickets. Rules are never assumed to apply to other ticket products.</p>
        <UsageFields value={usage} onChange={setUsage} />
      </div>
      <label className="field">
        Prices
        <textarea aria-label="Ticket prices" rows={8} className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} />
      </label>
      <ProvenanceFields value={prov} onChange={setProv} />
      <div className="row">
        <button type="button" className="primary" onClick={check} disabled={!text.trim()}>
          Check prices
        </button>
        {preview && preview.entries.length > 0 && (
          <button type="button" className="primary" onClick={save}>
            Save {preview.entries.length} price{preview.entries.length === 1 ? "" : "s"}
          </button>
        )}
        {msg && <span className="small save-pos">{msg}</span>}
      </div>
      <Errors errors={errors} />
      {preview && preview.errors.length > 0 && (
        <div className="banner banner-error small" role="alert">
          <div>
            <b>Nothing can be saved until these lines are fixed:</b>
            <ul className="notices">
              {preview.errors.map((e, i) => (
                <li key={i}>
                  {e.line ? `Line ${e.line}: ` : ""}
                  {e.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {preview && preview.entries.length > 0 && (
        <table className="cmp" aria-label="Ticket price preview">
          <thead>
            <tr>
              <th>Start dates</th>
              <th>Ticket</th>
              <th>Age</th>
              <th className="r">Per person</th>
              <th>Usage</th>
            </tr>
          </thead>
          <tbody>
            {preview.entries.map((e, i) => (
              <tr key={i}>
                <td>{e.validFrom === e.validTo ? formatShortDate(e.validFrom) : `${formatShortDate(e.validFrom)} – ${formatShortDate(e.validTo)}`}</td>
                <td>
                  {e.days}-day {TICKET_LABEL[e.option]}
                </td>
                <td>{e.age}</td>
                <td className="r num">
                  {formatCents(e.cents)}
                  {e.taxIncluded ? " incl. tax" : ""}
                </td>
                <td className="small muted">{e.usage?.useWithinDays ? `within ${e.usage.useWithinDays} days` : "unknown"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
