"use client";

import { useEffect, useRef, useState } from "react";
import { daysBetween, formatShortDate } from "@/domain/dates";
import { formatCents } from "@/domain/money";
import { STATUS_LABEL } from "@/domain/provenance";
import type { PriceSeries } from "@/monitoring/series";

/**
 * One equivalent-configuration series: observed totals over observation date.
 * Points are joined only within the series (same configuration, same tax
 * treatment, same kind of evidence). Stale points are drawn hollow. With a
 * single observation, no line is drawn and the reason is stated.
 */
const H = 200;
const PAD = { l: 64, r: 16, t: 22, b: 26 };

function niceTicks(min: number, max: number): number[] {
  const span = Math.max(max - min, 100_00);
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const start = Math.floor(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + step / 2; v += step) out.push(v);
  return out;
}

export function PriceHistoryChart({ series, today }: { series: PriceSeries; today: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  // Draw at the container's pixel width so text stays at its real size.
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pts = series.points;
  const dates = pts.map((p) => p.observedOn);
  const first = dates[0]!;
  const lastDay = dates[dates.length - 1]! > today ? dates[dates.length - 1]! : today;
  const spanDays = Math.max(daysBetween(first, lastDay), 1);
  const values = pts.map((p) => p.valueCents);
  // Pad the domain so the end label never sits on the axis or the date labels.
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.2, 2_000);
  const ticks = niceTicks(Math.max(0, lo - pad), hi + pad / 2);
  const yMin = ticks[0]!;
  const yMax = ticks[ticks.length - 1]! === yMin ? yMin + 1 : ticks[ticks.length - 1]!;
  const x = (d: string) => PAD.l + (daysBetween(first, d) / spanDays) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);
  // Points observed on the same day are spread slightly so each stays visible.
  const xs = pts.map((p, i) => x(p.observedOn) + (i > 0 && pts[i - 1]!.observedOn === p.observedOn ? 6 : 0));
  const path = pts.map((p, i) => `${i ? "L" : "M"}${xs[i]!.toFixed(1)},${y(p.valueCents).toFixed(1)}`).join(" ");

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    let best = 0;
    xs.forEach((v, i) => {
      if (Math.abs(v - px) < Math.abs(xs[best]! - px)) best = i;
    });
    setHover(best);
  };
  const h = hover === null ? null : pts[hover]!;

  return (
    <div className="chart" ref={wrap}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Observed totals from ${formatShortDate(first)}: ${pts.map((p) => formatCents(p.valueCents)).join(", ")}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={PAD.l - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--muted)">
              {formatCents(t).replace(".00", "")}
            </text>
          </g>
        ))}
        <text x={PAD.l} y={H - 6} fontSize={11} fill="var(--muted)">
          {formatShortDate(first)}
        </text>
        <text x={W - PAD.r} y={H - 6} fontSize={11} fill="var(--muted)" textAnchor="end">
          {formatShortDate(lastDay)}
          {lastDay === today ? " (today)" : ""}
        </text>
        {h && <line x1={xs[hover!]} x2={xs[hover!]} y1={PAD.t} y2={H - PAD.b} stroke="var(--muted)" strokeWidth={1} />}
        {pts.length > 1 && <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
        {pts.map((p, i) => {
          const stale = p.effectiveStatus === "stale";
          return (
            <circle
              key={p.observationId}
              cx={xs[i]}
              cy={y(p.valueCents)}
              r={hover === i ? 6 : 4.5}
              fill={stale ? "var(--surface)" : "var(--accent)"}
              stroke={stale ? "var(--accent)" : "var(--surface)"}
              strokeWidth={2}
            />
          );
        })}
        {/* Direct label on the latest point only. */}
        <text
          x={xs[xs.length - 1]! - 8}
          y={y(series.latest.valueCents) + (series.previous && series.previous.valueCents > series.latest.valueCents ? 18 : -12)}
          textAnchor="end"
          fontSize={12}
          fontWeight={600}
          fill="var(--text)"
        >
          {formatCents(series.latest.valueCents)}
        </text>
      </svg>
      {h && (
        <div className="tip" style={{ left: `${(xs[hover!]! / W) * 100}%`, top: `${(y(h.valueCents) / H) * 100}%` }}>
          <strong className="num">{formatCents(h.valueCents)}</strong> · observed {formatShortDate(h.observedOn)}
          <br />
          <span className="muted">
            {h.source} · {STATUS_LABEL[h.effectiveStatus]} · {h.origin === "recheck" ? "re-check" : h.origin}
          </span>
        </div>
      )}
    </div>
  );
}
