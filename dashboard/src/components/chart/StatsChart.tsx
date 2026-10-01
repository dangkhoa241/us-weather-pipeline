// Statistics chart, v3: hand-rolled SVG with d3-scale and d3-shape.
// Temperature: avg line + min/max band; precipitation: bars. Null buckets are gaps (never drawn as 0).
// With onSelect, every bucket with data is a labelled, keyboard-focusable button (drill-down).
import { useEffect } from "react";
import { scaleBand, scaleLinear } from "d3-scale";
import { area, line } from "d3-shape";
import { fmt } from "@/lib/units";
import { valueOf, type ChartPoint, type StatsChartProps } from "./types";

const W = 800;
const H = 280;
const M = { top: 12, right: 12, bottom: 28, left: 44 };

const toUnit = (v: number | null, metric: string, unit: string) =>
  v == null || metric === "precip_mm" ? v : unit === "F" ? (v * 9) / 5 + 32 : v;

export function StatsChart({ points, metric, unit, title, onSelect, readyMark }: StatsChartProps) {
  useEffect(() => {
    if (readyMark && points.length) requestAnimationFrame(() => performance.mark(readyMark));
  }, [readyMark, points.length]);

  const rain = metric === "precip_mm";
  const unitLabel = rain ? "mm" : `°${unit}`;
  const rows = points.map((p) => ({
    p, value: valueOf(p, metric, unit), min: toUnit(p.min, metric, unit), max: toUnit(p.max, metric, unit),
  }));
  const ys = rows.flatMap((r) => (rain ? [r.value] : [r.min, r.max, r.value])).filter((v): v is number => v != null);
  const [lo, hi] = ys.length ? [Math.min(...ys), Math.max(...ys)] : [0, 1];
  const x = scaleBand<string>().domain(points.map((p) => p.key)).range([M.left, W - M.right]).padding(0.2);
  const y = scaleLinear().domain(rain ? [0, Math.max(hi, 1)] : [lo, hi === lo ? hi + 1 : hi]).nice().range([H - M.bottom, M.top]);
  const cx = (p: ChartPoint) => (x(p.key) ?? 0) + x.bandwidth() / 2;
  const band = area<(typeof rows)[number]>().defined((r) => r.min != null && r.max != null)
    .x((r) => cx(r.p)).y0((r) => y(r.min as number)).y1((r) => y(r.max as number));
  const avgLine = line<(typeof rows)[number]>().defined((r) => r.value != null).x((r) => cx(r.p)).y((r) => y(r.value as number));
  const every = Math.ceil(points.length / 16);   // thin out x labels for long series

  const describe = (r: (typeof rows)[number]) => r.value == null ? `${r.p.label}: no data`
    : rain ? `${r.p.label}: ${fmt(r.value)} mm`
    : `${r.p.label}: average ${fmt(r.value)}${unitLabel}, min ${fmt(r.min)}, max ${fmt(r.max)}`;
  const activate = (key: string) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(key); }
  };

  return (
    <div data-chart data-points={points.length} role="group" aria-label={title}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${title} (${unitLabel})`}>
        {y.ticks(5).map((t) => (
          <g key={t} transform={`translate(0,${y(t)})`}>
            <line x1={M.left} x2={W - M.right} stroke="#e5e7eb" />
            <text x={M.left - 6} dy="0.32em" textAnchor="end" fontSize={11} fill="#6b7280">{fmt(t, 0)}</text>
          </g>
        ))}
        {points.map((p, i) => i % every === 0 && (
          <text key={p.key} x={cx(p)} y={H - 8} textAnchor="middle" fontSize={11} fill="#6b7280">{p.label}</text>
        ))}
        {rain ? rows.map((r) => r.value != null && (
          <rect key={r.p.key} x={x(r.p.key)} width={x.bandwidth()} y={y(r.value)} height={Math.max(0, y(0) - y(r.value))} fill="#2171b5" />
        )) : (
          <>
            <path d={band(rows) ?? ""} fill="#fdae61" fillOpacity={0.35} />
            <path d={avgLine(rows) ?? ""} fill="none" stroke="#d73027" strokeWidth={2} />
            {rows.map((r) => r.value != null && <circle key={r.p.key} cx={cx(r.p)} cy={y(r.value)} r={3} fill="#d73027" />)}
          </>
        )}
        {rows.map((r) => {
          const selectable = onSelect != null && r.value != null;
          return (
            <rect key={r.p.key} data-key={r.p.key} x={x(r.p.key)} y={M.top} width={x.bandwidth()} height={H - M.top - M.bottom}
              fill="transparent" className={selectable ? "cursor-pointer outline-none hover:fill-black/5 focus-visible:fill-black/10" : undefined}
              {...(selectable ? { tabIndex: 0, role: "button", "aria-label": `${describe(r)}. Show details`,
                onClick: () => onSelect(r.p.key), onKeyDown: activate(r.p.key) } : { "aria-hidden": true })}>
              <title>{describe(r)}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}
