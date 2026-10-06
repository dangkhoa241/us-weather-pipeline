// Forecast replay chart, design C: the min–max band of all models per lead day (how much they disagreed) with thin
// model lines inside and the dashed observed high; the band narrowing toward 1 day is the story. Models are named in a
// legend whose items are focusable (hover/focus highlights one line); each lead day is a focusable column whose
// tooltip gives the spread and every model's value. Hand-rolled SVG with d3-scale/d3-shape; colors follow the theme.
import { useRef, useState } from "react";
import { scaleLinear, scalePoint } from "d3-scale";
import { area, line } from "d3-shape";
import type { ReplayChartProps } from "@/components/replay/types";
import { useWidth } from "@/components/chart/useWidth";
import { daysAhead } from "@/lib/replay";
import { fmt } from "@/lib/units";

const H = 320;
const M = { top: 16, right: 64, bottom: 34, left: 44 };
const LEADS = [7, 6, 5, 4, 3, 2, 1];

export function ReplayChart({ series, observed, unit, title }: ReplayChartProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const W = useWidth(rootRef);
  const [focus, setFocus] = useState<string | null>(null);
  const [lead, setLead] = useState<number | null>(null);

  const at = (l: number) => series.flatMap((s) => s.points.filter((p) => p.lead === l).map((p) => ({ s, v: p.v })));
  const band = LEADS.map((l) => ({ l, vs: at(l).map((a) => a.v) })).filter((b) => b.vs.length >= 2)
    .map((b) => ({ l: b.l, lo: Math.min(...b.vs), hi: Math.max(...b.vs) }));
  const values = series.flatMap((s) => s.points.map((p) => p.v)).concat(observed);
  const x = scalePoint<number>().domain(LEADS).range([M.left, W - M.right]).padding(0.3);
  const y = scaleLinear().domain([Math.min(...values), Math.max(...values)]).nice().range([H - M.bottom, M.top]);
  const path = line<{ lead: number; v: number }>().x((p) => x(p.lead) ?? 0).y((p) => y(p.v));
  const bandPath = area<{ l: number; lo: number; hi: number }>().x((b) => x(b.l) ?? 0).y0((b) => y(b.lo)).y1((b) => y(b.hi));
  const step = x.step();
  const dim = (id: string) => (focus && focus !== id ? 0.15 : 1);
  const spread = (l: number) => band.find((b) => b.l === l);

  return (
    <div ref={rootRef} data-replay-chart data-series={series.length} role="group" aria-label={title} className="relative flex flex-col gap-2">
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Models">
        <li className="flex items-center gap-1.5 px-1 py-0.5 text-muted-foreground">
          <span className="inline-block h-3 w-4 rounded-sm" style={{ background: "var(--muted-foreground)", opacity: 0.25 }} aria-hidden />Spread (lowest–highest model)
        </li>
        {series.map((s) => (
          <li key={s.id}>
            <button type="button" aria-pressed={focus === s.id}
              aria-label={`${s.name}: ${s.points.map((p) => `${fmt(p.v)}°${unit} ${daysAhead(p.lead)}`).join(", ")}`}
              onMouseEnter={() => setFocus(s.id)} onMouseLeave={() => setFocus(null)} onFocus={() => setFocus(s.id)} onBlur={() => setFocus(null)}
              className="flex items-center gap-1.5 rounded px-1 py-0.5 text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
              <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} aria-hidden />{s.name}
            </button>
          </li>
        ))}
      </ul>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block max-w-full" onMouseLeave={() => setLead(null)}>
        <g aria-hidden="true">
          {y.ticks(5).map((t) => (
            <g key={t} transform={`translate(0,${y(t)})`}>
              <line x1={M.left} x2={W - M.right} style={{ stroke: "var(--border)" }} />
              <text x={M.left - 6} dy="0.32em" textAnchor="end" fontSize={11} style={{ fill: "var(--muted-foreground)" }}>{fmt(t, 0)}°</text>
            </g>
          ))}
          {LEADS.map((l) => (
            <text key={l} x={x(l)} y={H - 16} textAnchor="middle" fontSize={11} style={{ fill: lead === l ? "var(--foreground)" : "var(--muted-foreground)" }}>{l}d</text>
          ))}
          <text x={(M.left + W - M.right) / 2} y={H - 2} textAnchor="middle" fontSize={11} style={{ fill: "var(--muted-foreground)" }}>days before the day →</text>
          <path d={bandPath(band) ?? ""} style={{ fill: "var(--muted-foreground)", opacity: 0.2 }} />
          {band.map((b) => (
            <text key={b.l} x={x(b.l)} y={y(b.hi) - 6} textAnchor="middle" fontSize={10} style={{ fill: "var(--muted-foreground)" }}>±{fmt((b.hi - b.lo) / 2, 1)}</text>
          ))}
          {lead != null && <line x1={x(lead)} x2={x(lead)} y1={M.top} y2={H - M.bottom} strokeDasharray="3 3" style={{ stroke: "var(--muted-foreground)" }} />}
          {series.map((s) => (
            <g key={s.id} opacity={dim(s.id)}>
              <path d={path(s.points) ?? ""} fill="none" strokeWidth={focus === s.id ? 2.5 : 1.5} style={{ stroke: s.color }} />
              {s.points.map((p) => <circle key={p.lead} cx={x(p.lead)} cy={y(p.v)} r={3} style={{ fill: s.color }} />)}
            </g>
          ))}
          <line x1={M.left} x2={W - M.right} y1={y(observed)} y2={y(observed)} strokeDasharray="6 4" strokeWidth={2} style={{ stroke: "var(--foreground)" }} />
          <text x={W - M.right + 6} y={y(observed)} dy="0.32em" fontSize={11} fontWeight={600} style={{ fill: "var(--foreground)" }}>obs {fmt(observed, 0)}°</text>
        </g>
        {LEADS.map((l) => (
          <rect key={l} x={(x(l) ?? 0) - step / 2} y={M.top} width={step} height={H - M.top - M.bottom} fill="transparent" tabIndex={0} role="img"
            aria-label={`${daysAhead(l)}: ${at(l).map(({ s, v }) => `${s.name} ${fmt(v)}°${unit}`).join(", ") || "no forecasts"}; observed ${fmt(observed)}°${unit}`}
            onMouseEnter={() => setLead(l)} onFocus={() => setLead(l)} onBlur={() => setLead(null)} className="outline-none focus-visible:stroke-ring focus-visible:stroke-2" />
        ))}
      </svg>
      {lead != null && (
        <div data-tooltip role="presentation" className="pointer-events-none absolute top-10 z-10 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          style={{ left: Math.min(Math.max(0, (x(lead) ?? 0) + 12), Math.max(0, W - 170)) }}>
          <div className="font-medium">{daysAhead(lead)}{spread(lead) ? ` · spread ${fmt(spread(lead)!.hi - spread(lead)!.lo)}°` : ""}</div>
          {at(lead).sort((a, b) => b.v - a.v).map(({ s, v }) => (
            <div key={s.id} className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} aria-hidden />
              {s.name} <span className="ml-auto pl-3 tabular-nums">{fmt(v)}°{unit}</span>
            </div>
          ))}
          <div className="text-muted-foreground">Observed {fmt(observed)}°{unit}</div>
        </div>
      )}
    </div>
  );
}
