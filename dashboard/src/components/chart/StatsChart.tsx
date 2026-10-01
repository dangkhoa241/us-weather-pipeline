// Statistics chart, v2: Recharts (SVG). Temperature: avg line + min/max band (range Area); precipitation: bars.
// Null buckets are gaps (never drawn as 0). With onSelect, dots/bars are labelled, keyboard-focusable buttons.
import { useEffect } from "react";
import { Area, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmt } from "@/lib/units";
import { valueOf, type StatsChartProps } from "./types";

const toUnit = (v: number | null, rain: boolean, unit: string) => (v == null || rain ? v : unit === "F" ? (v * 9) / 5 + 32 : v);

type Row = { key: string; label: string; value: number | null; band: [number, number] | null; min: number | null; max: number | null };
type Num = number | string | undefined;
type ShapeProps = { cx?: Num; cy?: Num; x?: Num; y?: Num; width?: Num; height?: Num; payload?: unknown };

export function StatsChart({ points, metric, unit, title, onSelect, readyMark }: StatsChartProps) {
  useEffect(() => {
    // ResponsiveContainer measures its parent first, so the chart paints a frame later.
    if (readyMark && points.length) requestAnimationFrame(() => requestAnimationFrame(() => performance.mark(readyMark)));
  }, [readyMark, points.length]);

  const rain = metric === "precip_mm";
  const unitLabel = rain ? "mm" : `°${unit}`;
  const data: Row[] = points.map((p) => {
    const min = toUnit(p.min, rain, unit);
    const max = toUnit(p.max, rain, unit);
    return { key: p.key, label: p.label, value: valueOf(p, metric, unit), band: min != null && max != null ? [min, max] : null, min, max };
  });
  const describe = (r: Row) => r.value == null ? `${r.label}: no data`
    : rain ? `${r.label}: ${fmt(r.value)} mm` : `${r.label}: average ${fmt(r.value)}${unitLabel}, min ${fmt(r.min)}, max ${fmt(r.max)}`;
  const interactive = (r: Row | undefined) => onSelect != null && r?.value != null;
  const handlers = (r: Row) => ({
    "data-key": r.key, tabIndex: 0, role: "button", "aria-label": `${describe(r)}. Show details`,
    onClick: () => onSelect?.(r.key),
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(r.key); } },
    style: { cursor: "pointer", outline: "none" },
  });

  const Dot = ({ cx, cy, payload }: ShapeProps) => {
    const r = payload as Row | undefined;
    if (cx == null || cy == null || !r || r.value == null) return <g />;
    return <circle cx={Number(cx)} cy={Number(cy)} r={interactive(r) ? 5 : 3} fill="#d73027" stroke="#fff" {...(interactive(r) ? handlers(r) : {})} />;
  };
  const BarShape = ({ x = 0, y = 0, width = 0, height = 0, payload }: ShapeProps) => {
    const r = payload as Row | undefined;
    return <rect x={Number(x)} y={Number(y)} width={Number(width)} height={Math.max(0, Number(height))} fill="#2171b5"
      {...(r && interactive(r) ? handlers(r) : {})} />;
  };

  return (
    <div data-chart data-points={points.length} role="group" aria-label={title} style={{ height: 280 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}
          onClick={(state) => {
            const r = data.find((d) => d.label === state?.activeLabel);
            if (r && interactive(r)) onSelect?.(r.key);
          }}>
          <CartesianGrid vertical={false} stroke="#e5e7eb" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 11 }} width={44} domain={rain ? [0, "auto"] : ["auto", "auto"]} />
          <Tooltip formatter={(v) => (Array.isArray(v) ? `${fmt(Number(v[0]))} – ${fmt(Number(v[1]))}` : `${fmt(Number(v))} ${unitLabel}`)} />
          {rain ? (
            <Bar dataKey="value" name="Precipitation" shape={BarShape} isAnimationActive={false} />
          ) : (
            <>
              <Area dataKey="band" name="Min–max" fill="#fdae61" fillOpacity={0.35} stroke="none" connectNulls={false} isAnimationActive={false} />
              <Line dataKey="value" name="Average" stroke="#d73027" strokeWidth={2} dot={Dot} activeDot={false} connectNulls={false} isAnimationActive={false} />
            </>
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
