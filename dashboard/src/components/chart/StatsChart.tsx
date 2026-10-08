// Statistics chart (Compare & review winner: hand-rolled SVG with d3-scale and d3-shape).
// Temperature: avg line + min/max band (gradient). Precipitation: rounded gradient bars. Overlays on both:
// dotted moving average, dashed mean with its value, ▲ max / ▼ min markers, value labels (hidden when crowded),
// a crosshair + tooltip that can be synced across twin charts, and a menu to download PNG/CSV.
// Null buckets are gaps (never drawn as 0). With onSelect, every bucket with data is a keyboard-operable button.
// Colors come from CSS variables (--c-*), so the chart follows the light/dark theme.
import { useEffect, useId, useRef, useState } from "react";
import { scaleBand, scaleLinear } from "d3-scale";
import { area, curveMonotoneX, line } from "d3-shape";
import { fmt } from "@/lib/units";
import { Term } from "@/components/Term";
import { movingAverage } from "@/lib/movingAverage";
import { downloadCsv, downloadPng, csvOf } from "./exportChart";
import { valueOf, type StatsChartProps } from "./types";
import { useWidth } from "./useWidth";

const H = 300;
const M = { top: 26, right: 14, bottom: 28, left: 46 };

const toUnit = (v: number | null, metric: string, unit: string) =>
  v == null || metric === "precip_mm" ? v : unit === "F" ? (v * 9) / 5 + 32 : v;

export function StatsChart({ points, metric, unit, title, onSelect, readyMark, maWindow = 3, hoverKey, onHoverKey, fileName, rainUnit = "mm" }: StatsChartProps) {
  const id = useId().replace(/:/g, "");
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const W = useWidth(rootRef);
  const [ownHover, setOwnHover] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const hovered = hoverKey !== undefined ? hoverKey : ownHover;
  const setHover = (k: string | null) => { setOwnHover(k); onHoverKey?.(k); };

  useEffect(() => {
    if (readyMark && points.length) requestAnimationFrame(() => performance.mark(readyMark));
  }, [readyMark, points.length]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => { if (!(e.target as Element | null)?.closest?.("[data-chart-menu]")) setMenu(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [menu]);

  const rain = metric === "precip_mm";
  const unitLabel = rain ? rainUnit : `°${unit}`;
  const pct = rain && rainUnit === "%";   // rain chance: fixed 0–100% axis, whole percents
  const rainText = (v: number | null) => (pct ? `${fmt(v, 0)}%` : `${fmt(v)} ${rainUnit}`);
  const rows = points.map((p) => ({ p, value: valueOf(p, metric, unit), min: toUnit(p.min, metric, unit), max: toUnit(p.max, metric, unit) }));
  type Row = (typeof rows)[number];
  const ma = movingAverage(rows.map((r) => r.value), maWindow);
  const present = rows.map((r) => r.value).filter((v): v is number => v != null);
  const mean = present.length ? present.reduce((a, v) => a + v, 0) / present.length : null;

  // Extremes: temperature uses the band (highest max, lowest min); rain uses the bars.
  const hiOf = (r: Row) => (rain ? r.value : r.max);
  const loOf = (r: Row) => (rain ? r.value : r.min);
  const top = rows.reduce<number>((best, r, i) => (hiOf(r) != null && (best < 0 || (hiOf(r) as number) > (hiOf(rows[best]) as number)) ? i : best), -1);
  const bottom = rows.reduce<number>((best, r, i) => (loOf(r) != null && (best < 0 || (loOf(r) as number) < (loOf(rows[best]) as number)) ? i : best), -1);

  const flat = top >= 0 && bottom >= 0 && hiOf(rows[top]) === loOf(rows[bottom]);   // all equal: no max/min to mark
  const ys = rows.flatMap((r) => (rain ? [r.value] : [r.min, r.max, r.value])).concat(ma).filter((v): v is number => v != null);
  const [lo, hi] = ys.length ? [Math.min(...ys), Math.max(...ys)] : [0, 1];
  const x = scaleBand<string>().domain(points.map((p) => p.key)).range([M.left, W - M.right]).padding(rain ? 0.28 : 0.1);
  const y = scaleLinear().domain(pct ? [0, 100] : rain ? [0, Math.max(hi, 1)] : [lo, hi === lo ? hi + 1 : hi]).nice().range([H - M.bottom, M.top]);
  const ticks = y.ticks(5);
  const tickDigits = ticks.length > 1 && ticks[1] - ticks[0] < 1 ? 1 : 0;
  const cx = (key: string) => (x(key) ?? 0) + x.bandwidth() / 2;
  const plotW = W - M.left - M.right;
  const showValues = points.length > 0 && plotW / points.length >= 34;
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 54))));   // axis label thinning

  const valueLine = line<Row>().defined((r) => r.value != null).x((r) => cx(r.p.key)).y((r) => y(r.value as number)).curve(curveMonotoneX);
  const bandArea = area<Row>().defined((r) => r.min != null && r.max != null).x((r) => cx(r.p.key))
    .y0((r) => y(r.min as number)).y1((r) => y(r.max as number)).curve(curveMonotoneX);
  const maLine = line<number | null>().defined((v) => v != null).x((_, i) => cx(points[i].key)).y((v) => y(v as number)).curve(curveMonotoneX);

  const describe = (r: Row) => r.value == null ? `${r.p.label}: no data`
    : rain ? `${r.p.label}: ${rainText(r.value)}` : `${r.p.label}: average ${fmt(r.value)}${unitLabel}, min ${fmt(r.min)}, max ${fmt(r.max)}`;
  const activate = (key: string) => (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(key); }
  };

  const hIdx = rows.findIndex((r) => r.p.key === hovered);
  const hr = hIdx >= 0 ? rows[hIdx] : null;
  const animKey = `${points.length}:${points[0]?.key}:${points[points.length - 1]?.key}`;
  const base = fileName ?? title.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
  const markColor = rain ? "var(--c-rain)" : "var(--c-temp)";

  return (
    <div ref={rootRef} data-chart data-points={points.length} role="group" aria-label={title} className="relative">
      <div className="absolute right-0 top-0 z-10" data-chart-menu>
        <button type="button" aria-label="Chart menu" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}
          className="rounded-md px-1.5 text-base leading-none text-muted-foreground hover:bg-muted hover:text-foreground">≡</button>
        {menu && (
          <div role="menu" className="absolute right-0 mt-1 w-40 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md">
            <button type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left hover:bg-muted"
              onClick={() => { if (svgRef.current) downloadPng(svgRef.current, base); setMenu(false); }}>Download PNG</button>
            <button type="button" role="menuitem" className="block w-full rounded px-2 py-1 text-left hover:bg-muted"
              onClick={() => { downloadCsv(csvOf(points, metric, unit, rainUnit), base); setMenu(false); }}>Download CSV</button>
          </div>
        )}
      </div>
      <svg ref={svgRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block max-w-full" onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id={`${id}-band`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--c-temp)", stopOpacity: 0.5 }} />
            <stop offset="100%" style={{ stopColor: "var(--c-cool)", stopOpacity: 0.14 }} />
          </linearGradient>
          <linearGradient id={`${id}-bar`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: "var(--c-rain)", stopOpacity: 1 }} />
            <stop offset="100%" style={{ stopColor: "var(--c-rain)", stopOpacity: 0.45 }} />
          </linearGradient>
        </defs>
        <g aria-hidden="true">
          {ticks.map((t) => (
            <g key={t} transform={`translate(0,${y(t)})`}>
              <line x1={M.left} x2={W - M.right} style={{ stroke: "var(--border)" }} />
              <text x={M.left - 6} dy="0.32em" textAnchor="end" fontSize={11} style={{ fill: "var(--muted-foreground)" }}>{fmt(t, tickDigits)}{pct ? "%" : ""}</text>
            </g>
          ))}
          {points.map((p, i) => i % every === 0 && (
            <text key={p.key} x={cx(p.key)} y={H - 8} textAnchor="middle" fontSize={11}
              style={{ fill: hovered === p.key ? "var(--foreground)" : "var(--muted-foreground)" }}>{p.label}</text>
          ))}
          {hr && <line x1={cx(hr.p.key)} x2={cx(hr.p.key)} y1={M.top} y2={H - M.bottom} strokeDasharray="3 3" data-crosshair style={{ stroke: "var(--muted-foreground)" }} />}

          <g key={animKey} className="chart-in">
            {rain ? rows.map((r) => r.value != null && r.value > 0 && (
              <rect key={r.p.key} className="chart-rise" x={x(r.p.key)} width={x.bandwidth()} y={y(r.value)} height={Math.max(0, y(0) - y(r.value))}
                rx={Math.min(6, x.bandwidth() / 2)} fill={`url(#${id}-bar)`} data-bar opacity={hovered && hovered !== r.p.key ? 0.6 : 1} />
            )) : (
              <>
                <path d={bandArea(rows) ?? ""} fill={`url(#${id}-band)`} data-band />
                <path d={valueLine(rows) ?? ""} className="chart-draw" pathLength={1} fill="none" strokeWidth={2.2} strokeLinecap="round" style={{ stroke: "var(--c-temp)" }} />
                {rows.map((r) => r.value != null && (
                  <circle key={r.p.key} cx={cx(r.p.key)} cy={y(r.value)} r={hovered === r.p.key ? 5 : 3} strokeWidth={1.5} style={{ fill: "var(--c-temp)", stroke: "var(--card)" }} />
                ))}
              </>
            )}
            <path d={maLine(ma) ?? ""} fill="none" strokeWidth={2} strokeLinecap="round" strokeDasharray="1 5" style={{ stroke: "var(--c-ma)" }} data-ma />
          </g>

          {mean != null && (
            <g>
              <title>Average: the mean of all values in the chart</title>
              <g data-mean>
                <line x1={M.left} x2={W - M.right} y1={y(mean)} y2={y(mean)} strokeDasharray="6 4" strokeWidth={1.2} style={{ stroke: "var(--c-avg)" }} />
                <text x={W - M.right - 2} y={y(mean) - 4} textAnchor="end" fontSize={11} fontWeight={600} paintOrder="stroke" strokeWidth={3}
                  style={{ fill: "var(--c-avg)", stroke: "var(--card)" }}>avg {rain ? rainText(mean) : `${fmt(mean)}${unitLabel}`}</text>
              </g>
            </g>
          )}

          {showValues && rows.map((r, i) => r.value != null && !(rain && r.value === 0) && i !== top && i !== bottom && (
            <text key={r.p.key} x={cx(r.p.key)} y={y(r.value) - 8} textAnchor="middle" fontSize={10}
              paintOrder="stroke" strokeWidth={3} style={{ fill: "var(--muted-foreground)", stroke: "var(--card)" }} data-value-label>{pct ? `${fmt(r.value, 0)}%` : fmt(r.value, rain ? 1 : 0)}</text>
          ))}
          {top >= 0 && !flat && (
            <text x={cx(rows[top].p.key)} y={y(hiOf(rows[top]) as number) - 7} textAnchor="middle" fontSize={11} fontWeight={700}
              paintOrder="stroke" strokeWidth={3} style={{ fill: markColor, stroke: "var(--card)" }} data-marker="max">▲ {pct ? rainText(hiOf(rows[top])) : fmt(hiOf(rows[top]))}</text>
          )}
          {bottom >= 0 && bottom !== top && !flat && (
            <text x={cx(rows[bottom].p.key)} y={rain ? y(loOf(rows[bottom]) as number) - 7 : Math.min(y(loOf(rows[bottom]) as number) + 15, H - M.bottom - 3)} textAnchor="middle" fontSize={11} fontWeight={700}
              paintOrder="stroke" strokeWidth={3} style={{ fill: "var(--c-cool)", stroke: "var(--card)" }} data-marker="min">▼ {pct ? rainText(loOf(rows[bottom])) : fmt(loOf(rows[bottom]))}</text>
          )}
        </g>

        {rows.map((r) => {
          const selectable = onSelect != null && r.value != null;
          const w = x.step();
          return (
            <rect key={r.p.key} data-key={r.p.key} x={(x(r.p.key) ?? 0) - (w - x.bandwidth()) / 2} y={M.top} width={w} height={H - M.top - M.bottom}
              fill="transparent" data-no-export onMouseEnter={() => setHover(r.p.key)} onFocus={() => setHover(r.p.key)}
              className={selectable ? "cursor-pointer outline-none focus-visible:fill-foreground/10" : undefined}
              {...(selectable ? { tabIndex: 0, role: "button", "aria-label": `${describe(r)}. Show details`,
                onClick: () => onSelect(r.p.key), onKeyDown: activate(r.p.key) } : { "aria-hidden": true })} />
          );
        })}
      </svg>
      {hr && (
        <div role="presentation" data-tooltip aria-hidden="true"
          className="pointer-events-none absolute top-6 z-10 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
          style={cx(hr.p.key) > W * 0.6 ? { right: W - cx(hr.p.key) + 10 } : { left: cx(hr.p.key) + 10 }}>
          <div className="font-medium">{hr.p.label}</div>
          {hr.value == null ? <div className="text-muted-foreground">No data</div> : rain ? (
            <div>{rainText(hr.value)}</div>
          ) : (
            <>
              <div>avg {fmt(hr.value)}{unitLabel}</div>
              <div className="text-muted-foreground">min {fmt(hr.min)} · max {fmt(hr.max)}</div>
            </>
          )}
          {ma[hIdx] != null && <div className="text-muted-foreground">trend {rain ? rainText(ma[hIdx]) : `${fmt(ma[hIdx])}${unitLabel}`}</div>}
        </div>
      )}
      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground" data-chart-legend>
        {mean != null && <span className="flex items-center gap-1"><svg width="16" height="6" aria-hidden><line x1="0" x2="16" y1="3" y2="3" strokeDasharray="6 4" strokeWidth="1.5" style={{ stroke: "var(--c-avg)" }} /></svg><Term k="avg" /></span>}
        <span className="flex items-center gap-1"><svg width="16" height="6" aria-hidden><line x1="1" x2="16" y1="3" y2="3" strokeDasharray="1 5" strokeLinecap="round" strokeWidth="2" style={{ stroke: "var(--c-ma)" }} /></svg><Term k="Moving average">moving average</Term> ({maWindow} points)</span>
        {rain && rainUnit === "mm" && <span><Term k="mm" /> of rain</span>}
      </p>
    </div>
  );
}
