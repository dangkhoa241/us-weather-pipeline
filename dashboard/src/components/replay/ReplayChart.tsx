// Forecast replay chart, design B: small multiples. One panel per model on a shared y-scale, each with the dashed
// observed high, so every model's path is seen alone without overlap. The panel title names the model (identity
// never by color alone) and its one-day-ahead miss. Each panel is focusable and states its values in words; points
// have native tooltips. Hand-rolled SVG with d3-scale/d3-shape; colors follow the theme.
import { useRef } from "react";
import { scaleLinear, scalePoint } from "d3-scale";
import { line } from "d3-shape";
import type { ReplayChartProps } from "@/components/replay/types";
import { useWidth } from "@/components/chart/useWidth";
import { daysAhead } from "@/lib/replay";
import { fmt } from "@/lib/units";

const PH = 170;   // panel height
const M = { top: 8, right: 10, bottom: 22, left: 34 };
const GAP = 12;
const LEADS = [7, 6, 5, 4, 3, 2, 1];

export function ReplayChart({ series, observed, unit, title }: ReplayChartProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const W = useWidth(rootRef);
  const cols = W >= 900 ? Math.min(5, series.length) : W >= 560 ? 3 : 2;
  const PW = Math.max(120, (W - GAP * (cols - 1)) / cols);

  const values = series.flatMap((s) => s.points.map((p) => p.v)).concat(observed);
  const x = scalePoint<number>().domain(LEADS).range([M.left, PW - M.right]).padding(0.3);
  const y = scaleLinear().domain([Math.min(...values), Math.max(...values)]).nice(4).range([PH - M.bottom, M.top]);
  const path = line<{ lead: number; v: number }>().x((p) => x(p.lead) ?? 0).y((p) => y(p.v));
  const signed = (d: number) => `${d >= 0 ? "+" : "−"}${fmt(Math.abs(d))}°`;

  return (
    <div ref={rootRef} data-replay-chart data-series={series.length} role="group" aria-label={title}
      className="grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: GAP }}>
      {series.map((s) => {
        const last = s.points.at(-1)!;
        return (
          <figure key={s.id} tabIndex={0} className="m-0 rounded-md p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${s.name}: ${s.points.map((p) => `${fmt(p.v)}°${unit} ${daysAhead(p.lead)}`).join(", ")}; observed ${fmt(observed)}°${unit}`}>
            <figcaption className="flex items-baseline justify-between gap-2 text-xs" aria-hidden>
              <span className="flex items-center gap-1.5 font-medium text-foreground">
                <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />{s.name}
              </span>
              <span className="tabular-nums text-muted-foreground">{last.lead}d: {signed(last.v - observed)}{unit}</span>
            </figcaption>
            <svg width="100%" height={PH} viewBox={`0 0 ${PW} ${PH}`} className="block" aria-hidden>
              {y.ticks(4).map((t) => (
                <g key={t} transform={`translate(0,${y(t)})`}>
                  <line x1={M.left} x2={PW - M.right} style={{ stroke: "var(--border)" }} />
                  <text x={M.left - 4} dy="0.32em" textAnchor="end" fontSize={10} style={{ fill: "var(--muted-foreground)" }}>{fmt(t, 0)}°</text>
                </g>
              ))}
              {LEADS.map((l) => (
                <text key={l} x={x(l)} y={PH - 6} textAnchor="middle" fontSize={10} style={{ fill: "var(--muted-foreground)" }}>{l}d</text>
              ))}
              <line x1={M.left} x2={PW - M.right} y1={y(observed)} y2={y(observed)} strokeDasharray="5 3" strokeWidth={1.5} style={{ stroke: "var(--foreground)" }} />
              <path d={path(s.points) ?? ""} fill="none" strokeWidth={2} style={{ stroke: s.color }} />
              {s.points.map((p) => (
                <circle key={p.lead} cx={x(p.lead)} cy={y(p.v)} r={4} strokeWidth={1.5} style={{ fill: s.color, stroke: "var(--card)" }}>
                  <title>{`${s.name}, ${daysAhead(p.lead)}: ${fmt(p.v)}°${unit} (${signed(p.v - observed)}${unit})`}</title>
                </circle>
              ))}
            </svg>
          </figure>
        );
      })}
      <p className="text-xs text-muted-foreground" style={{ gridColumn: "1 / -1" }} aria-hidden>
        Dashed line: observed high {fmt(observed)}°{unit}. x-axis: days before the day; same scale in every panel.
      </p>
    </div>
  );
}
