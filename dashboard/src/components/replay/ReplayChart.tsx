// Forecast replay chart, design A: one line per model over lead days 7 → 1, converging on the dashed observed high.
// Identity is never color alone: each model has its own marker shape, a direct label at its last forecast, and a
// legend button (focus or hover highlights the model). Every lead day is a focusable column with a tooltip that lists
// all models' values. Hand-rolled SVG with d3-scale/d3-shape (as the drill-down chart); colors follow the theme.
import { useRef, useState } from "react";
import { scaleLinear, scalePoint } from "d3-scale";
import { line, symbol, symbolCircle, symbolCross, symbolDiamond, symbolSquare, symbolTriangle, type SymbolType } from "d3-shape";
import type { ReplayChartProps } from "@/components/replay/types";
import { useWidth } from "@/components/chart/useWidth";
import { daysAhead } from "@/lib/replay";
import { fmt } from "@/lib/units";

const H = 320;
const M = { top: 16, right: 92, bottom: 34, left: 44 };
const LEADS = [7, 6, 5, 4, 3, 2, 1];
const SHAPES: Record<string, SymbolType> = {
  ecmwf_ifs025: symbolCircle, gfs_global: symbolSquare, icon_global: symbolTriangle, gfs_hrrr: symbolDiamond, best_match: symbolCross,
};
const shape = (id: string) => symbol(SHAPES[id] ?? symbolCircle, 64)() ?? "";

export function ReplayChart({ series, observed, unit, title }: ReplayChartProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const W = useWidth(rootRef);
  const [focus, setFocus] = useState<string | null>(null);   // highlighted model
  const [lead, setLead] = useState<number | null>(null);      // hovered/focused lead day

  const values = series.flatMap((s) => s.points.map((p) => p.v)).concat(observed);
  const x = scalePoint<number>().domain(LEADS).range([M.left, W - M.right]).padding(0.3);
  const y = scaleLinear().domain([Math.min(...values), Math.max(...values)]).nice().range([H - M.bottom, M.top]);
  const path = line<{ lead: number; v: number }>().x((p) => x(p.lead) ?? 0).y((p) => y(p.v));
  const step = x.step();

  // Direct labels at each model's last forecast, nudged apart vertically (≥ 13 px).
  const labels = series.map((s) => ({ s, y: y(s.points.at(-1)!.v) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 13);
  const dim = (id: string) => (focus && focus !== id ? 0.2 : 1);
  const at = (l: number) => series.flatMap((s) => s.points.filter((p) => p.lead === l).map((p) => ({ s, v: p.v })));

  return (
    <div ref={rootRef} data-replay-chart data-series={series.length} role="group" aria-label={title} className="relative flex flex-col gap-2">
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs" aria-label="Models">
        {series.map((s) => (
          <li key={s.id}>
            <button type="button" aria-pressed={focus === s.id}
              aria-label={`${s.name}: ${s.points.map((p) => `${fmt(p.v)}°${unit} ${daysAhead(p.lead)}`).join(", ")}`}
              onMouseEnter={() => setFocus(s.id)} onMouseLeave={() => setFocus(null)} onFocus={() => setFocus(s.id)} onBlur={() => setFocus(null)}
              className="flex items-center gap-1.5 rounded px-1 py-0.5 text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
              <svg width={12} height={12} viewBox="-6 -6 12 12" aria-hidden><path d={shape(s.id)} style={{ fill: s.color }} /></svg>{s.name}
            </button>
          </li>
        ))}
        <li className="flex items-center gap-1.5 px-1 py-0.5 text-muted-foreground">
          <svg width={16} height={4} aria-hidden><line x1={0} x2={16} y1={2} y2={2} strokeDasharray="4 2" strokeWidth={2} style={{ stroke: "var(--foreground)" }} /></svg>Observed
        </li>
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
          {lead != null && <line x1={x(lead)} x2={x(lead)} y1={M.top} y2={H - M.bottom} strokeDasharray="3 3" style={{ stroke: "var(--muted-foreground)" }} />}
          <line x1={M.left} x2={W - M.right} y1={y(observed)} y2={y(observed)} strokeDasharray="6 4" strokeWidth={2} style={{ stroke: "var(--foreground)" }} />
          {series.map((s) => (
            <g key={s.id} opacity={dim(s.id)}>
              <path d={path(s.points) ?? ""} fill="none" strokeWidth={2} strokeDasharray={s.id === "best_match" ? "5 3" : undefined} style={{ stroke: s.color }} />
              {s.points.map((p) => (
                <path key={p.lead} d={shape(s.id)} transform={`translate(${x(p.lead)},${y(p.v)})`} strokeWidth={1.5} style={{ fill: s.color, stroke: "var(--card)" }} />
              ))}
            </g>
          ))}
          {labels.map(({ s, y: ly }) => (
            <text key={s.id} x={W - M.right + 8} y={ly} dy="0.32em" fontSize={11} opacity={dim(s.id)} style={{ fill: "var(--foreground)" }}>
              {s.name} {fmt(s.points.at(-1)!.v, 0)}°
            </text>
          ))}
          <text x={W - M.right + 8} y={y(observed)} dy={-6} fontSize={11} fontWeight={600} style={{ fill: "var(--foreground)" }}>obs {fmt(observed)}°</text>
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
          <div className="font-medium">{daysAhead(lead)}</div>
          {at(lead).sort((a, b) => b.v - a.v).map(({ s, v }) => (
            <div key={s.id} className="flex items-center gap-1.5">
              <svg width={10} height={10} viewBox="-6 -6 12 12" aria-hidden><path d={shape(s.id)} style={{ fill: s.color }} /></svg>
              {s.name} <span className="ml-auto pl-3 tabular-nums">{fmt(v)}°{unit} ({v >= observed ? "+" : "−"}{fmt(Math.abs(v - observed))})</span>
            </div>
          ))}
          <div className="text-muted-foreground">Observed {fmt(observed)}°{unit}</div>
        </div>
      )}
    </div>
  );
}
