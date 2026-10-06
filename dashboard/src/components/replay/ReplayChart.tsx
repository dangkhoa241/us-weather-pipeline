// Placeholder replay chart on the base branch: a plain list per model. The candidate designs replace this file.
import type { ReplayChartProps } from "@/components/replay/types";
import { fmt } from "@/lib/units";

export function ReplayChart({ series, observed, unit, title }: ReplayChartProps) {
  return (
    <div data-replay-chart data-series={series.length} role="group" aria-label={title} className="text-sm">
      <p>Observed high: {fmt(observed)}°{unit}</p>
      <ul>{series.map((s) => <li key={s.id} tabIndex={0} aria-label={`${s.name}: ${s.points.map((p) => `${fmt(p.v)}°${unit} ${p.lead} days ahead`).join(", ")}`}>{s.name}: {s.points.length} forecasts</li>)}</ul>
    </div>
  );
}
