// Contract for the statistics chart. The three candidate implementations (feature/drilldown-v1..v3) implement
// StatsChart with these props, so the drill-down and trend panels can use any of them unchanged.
// Measurement markers every implementation sets: root element with data-chart and data-points={points.length}.
import type { TempUnit } from "@/lib/units";

/** One bucket (a year, month, day or period). Values are metric (°C / mm); null = no data (an empty slot, not 0). */
export type ChartPoint = {
  key: string;     // passed to onSelect, e.g. "2025", "07", "14"
  label: string;   // axis label, e.g. "2025", "Jul", "14"
  min: number | null;
  max: number | null;
  avg: number | null;
  sum: number | null;
};

export type StatsChartProps = {
  points: ChartPoint[];
  metric: "temp_c" | "precip_mm";   // temperature: avg line + min/max band; precipitation: bars of the sum
  unit: TempUnit;
  title: string;                    // accessible name of the chart
  onSelect?: (key: string) => void; // makes points with data selectable (drill-down)
  readyMark?: string;               // performance.mark name after the first render with data (measurements)
  maWindow?: number;                // moving-average window in points (7 for daily, 3 for periods)
  hoverKey?: string | null;         // synced crosshair: the hovered bucket, shared by twin charts
  onHoverKey?: (key: string | null) => void;
  fileName?: string;                // base name of the PNG/CSV downloads
};

/** The plotted value of a point in display units. */
export const valueOf = (p: ChartPoint, metric: StatsChartProps["metric"], unit: TempUnit): number | null => {
  if (metric === "precip_mm") return p.sum;
  if (p.avg == null) return null;
  return unit === "F" ? (p.avg * 9) / 5 + 32 : p.avg;
};
