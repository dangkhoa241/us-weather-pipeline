// Placeholder: the statistics chart is chosen by the Compare & review process (feature/drilldown-v1..v3).
// Same markers as the real charts (data-chart, readyMark), so this build is the "no chart" baseline.
import { useEffect } from "react";
import type { StatsChartProps } from "./types";

export function StatsChart({ points, title, readyMark }: StatsChartProps) {
  useEffect(() => {
    if (readyMark && points.length) requestAnimationFrame(() => performance.mark(readyMark));
  }, [readyMark, points.length]);
  return (
    <div data-chart data-points={points.length} role="img" aria-label={title} className="flex h-64 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
      {title}: {points.length} points — chart implementation pending
    </div>
  );
}
