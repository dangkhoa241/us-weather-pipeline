// Contract for the forecast replay chart. The three candidate designs (feature/forecast-replay-v1..v3) implement
// ReplayChart with these props, so ForecastReplayPanel uses any of them unchanged.
// Markers every implementation sets: root element with data-replay-chart and data-series={series.length}; one
// keyboard-focusable element per model with an aria-label that states its values in words.
import type { ReplaySeries } from "@/lib/replay";
import type { TempUnit } from "@/lib/units";

export type ReplayChartProps = {
  series: ReplaySeries[];   // one per model, display units, points ordered lead 7 → 1 (earliest forecast first)
  observed: number;         // the day's observed high, display units
  unit: TempUnit;
  title: string;            // accessible name of the chart
};
