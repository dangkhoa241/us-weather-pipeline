// Several series on one d3 line chart (e.g. one line per forecast model), with an optional shaded spread between
// the lowest and highest series at each point, an optional zero line, a legend, and a crosshair + tooltip listing
// every series. Null values are gaps. Colors are CSS variables, so it follows the theme.
import { useRef, useState } from "react";
import { scalePoint, scaleLinear } from "d3-scale";
import { area, curveMonotoneX, line } from "d3-shape";
import { Term } from "@/components/Term";
import { isGlossaryKey } from "@/lib/glossary";
import { fmt } from "@/lib/units";
import { useWidth } from "./useWidth";

export type Series = { id: string; name: string; color: string; values: (number | null)[]; dashed?: boolean };

type Props = {
  labels: string[];                 // one per x position
  series: Series[];
  title: string;                    // accessible name
  unitLabel: string;                // e.g. "°F"
  spread?: boolean;                 // shade min..max across the series at each x
  zeroLine?: boolean;               // e.g. bias charts: 0 = no bias
  digits?: number;
  height?: number;
};

const M = { top: 14, right: 16, bottom: 28, left: 46 };

export function MultiLineChart({ labels, series, title, unitLabel, spread, zeroLine, digits = 1, height = 280 }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const W = useWidth(rootRef);
  const H = height;
  const [hover, setHover] = useState<number | null>(null);

  const all = series.flatMap((s) => s.values).filter((v): v is number => v != null);
  const [lo, hi] = all.length ? [Math.min(...all, zeroLine ? 0 : Infinity), Math.max(...all, zeroLine ? 0 : -Infinity)] : [0, 1];
  const keys = labels.map((_, i) => String(i));
  const x = scalePoint<string>().domain(keys).range([M.left + 12, W - M.right - 12]);
  const y = scaleLinear().domain(lo === hi ? [lo - 1, hi + 1] : [lo, hi]).nice().range([H - M.bottom, M.top]);
  const xi = (i: number) => x(String(i)) ?? 0;
  const ticks = y.ticks(5);
  const tickDigits = ticks.length > 1 && ticks[1] - ticks[0] < 1 ? 1 : 0;
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor((W - M.left - M.right) / 60))));

  const band = labels.map((_, i) => {
    const vs = series.map((s) => s.values[i]).filter((v): v is number => v != null);
    return vs.length >= 2 ? [Math.min(...vs), Math.max(...vs)] as const : null;
  });
  const bandPath = area<(typeof band)[number]>().defined((b) => b != null).x((_, i) => xi(i))
    .y0((b) => y(b![0])).y1((b) => y(b![1])).curve(curveMonotoneX)(band) ?? "";
  const linePath = (values: (number | null)[]) =>
    line<number | null>().defined((v) => v != null).x((_, i) => xi(i)).y((v) => y(v as number)).curve(curveMonotoneX)(values) ?? "";

  const step = labels.length > 1 ? xi(1) - xi(0) : W;
  const hx = hover != null ? xi(hover) : 0;

  return (
    <div ref={rootRef} className="relative" role="group" aria-label={title} data-multiline data-series={series.length}>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label="Legend">
        {series.map((s) => (
          <li key={s.id} className="flex items-center gap-1.5">
            <svg width="16" height="8" aria-hidden><line x1="0" x2="16" y1="4" y2="4" strokeWidth="2.5" strokeDasharray={s.dashed ? "4 3" : undefined} style={{ stroke: s.color }} /></svg>
            {isGlossaryKey(s.name) ? <Term k={s.name} /> : s.name}
          </li>
        ))}
        {spread && <li className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: "var(--c-spread)" }} aria-hidden /><Term k="Spread">spread</Term> between models</li>}
      </ul>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block max-w-full" onMouseLeave={() => setHover(null)}>
        <g aria-hidden="true">
          {ticks.map((t) => (
            <g key={t} transform={`translate(0,${y(t)})`}>
              <line x1={M.left} x2={W - M.right} style={{ stroke: zeroLine && t === 0 ? "var(--muted-foreground)" : "var(--border)" }} />
              <text x={M.left - 6} dy="0.32em" textAnchor="end" fontSize={11} style={{ fill: "var(--muted-foreground)" }}>{fmt(t, tickDigits)}</text>
            </g>
          ))}
          {labels.map((l, i) => i % every === 0 && (
            <text key={i} x={xi(i)} y={H - 8} textAnchor="middle" fontSize={11} style={{ fill: hover === i ? "var(--foreground)" : "var(--muted-foreground)" }}>{l}</text>
          ))}
          {spread && <path d={bandPath} data-spread style={{ fill: "var(--c-spread)" }} />}
          {hover != null && <line x1={hx} x2={hx} y1={M.top} y2={H - M.bottom} strokeDasharray="3 3" style={{ stroke: "var(--muted-foreground)" }} />}
          {series.map((s) => (
            <g key={s.id} data-series-id={s.id}>
              <path d={linePath(s.values)} fill="none" strokeWidth={2.2} strokeLinecap="round" strokeDasharray={s.dashed ? "5 4" : undefined} style={{ stroke: s.color }} />
              {s.values.map((v, i) => v != null && (
                <circle key={i} cx={xi(i)} cy={y(v)} r={hover === i ? 4.5 : 2.5} strokeWidth={1.2} style={{ fill: s.color, stroke: "var(--card)" }} />
              ))}
            </g>
          ))}
        </g>
        {labels.map((_, i) => (
          <rect key={i} x={xi(i) - step / 2} y={M.top} width={Math.max(step, 1)} height={H - M.top - M.bottom} fill="transparent"
            aria-hidden="true" onMouseEnter={() => setHover(i)} />
        ))}
      </svg>
      {hover != null && (
        <div data-tooltip aria-hidden="true" className="pointer-events-none absolute top-8 z-10 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          style={hx > W * 0.6 ? { right: W - hx + 10 } : { left: hx + 10 }}>
          <div className="font-medium">{labels[hover]}</div>
          {series.map((s) => (
            <div key={s.id} className="flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-full" style={{ background: s.color }} />
              {s.name}: {s.values[hover] == null ? "—" : `${fmt(s.values[hover], digits)}${unitLabel}`}
            </div>
          ))}
          {spread && band[hover] && <div className="text-muted-foreground">spread {fmt(band[hover]![1] - band[hover]![0], digits)}{unitLabel}</div>}
        </div>
      )}
      {/* Text alternative for screen readers: the same values as a table. */}
      <table className="sr-only">
        <caption>{title}</caption>
        <thead><tr><th scope="col">Point</th>{series.map((s) => <th key={s.id} scope="col">{s.name}</th>)}</tr></thead>
        <tbody>
          {labels.map((l, i) => <tr key={i}><th scope="row">{l}</th>{series.map((s) => <td key={s.id}>{s.values[i] == null ? "no data" : `${fmt(s.values[i], digits)}${unitLabel}`}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}
