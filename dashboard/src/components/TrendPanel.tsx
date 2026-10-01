// Statistics for the selected date range, grouped by the Period filter (week, month, quarter, half-year, year).
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { periodLabel } from "@/lib/drill";
import { METRICS, PERIODS, selectedRange, useFilters } from "@/store/filters";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { StatsChart } from "@/components/chart/StatsChart";
import type { ChartPoint } from "@/components/chart/types";

export function TrendPanel() {
  const f = useFilters();
  const range = selectedRange(f);
  const params = { locations: f.location, metric: f.metric, period: f.period, ...range };
  const stats = useQuery({ queryKey: ["stats", params], queryFn: () => api.stats(params) });
  const points: ChartPoint[] = (stats.data?.data ?? []).map((r) => ({
    key: r.period_start, label: periodLabel(r.period_start, f.period), min: r.min, max: r.max, avg: r.avg, sum: r.sum,
  }));
  const title = `${METRICS[f.metric]} by ${PERIODS[f.period].toLowerCase()}, ${range.from} – ${range.to}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trend by {PERIODS[f.period].toLowerCase()}</CardTitle>
        <CardDescription>{title}. Partial periods at the edges of the range include only the selected days.</CardDescription>
      </CardHeader>
      <CardContent>
        {stats.error ? (
          <Alert variant="destructive"><AlertTitle>Could not load the trend</AlertTitle><AlertDescription>{stats.error.message}</AlertDescription></Alert>
        ) : stats.isPending ? (
          <Skeleton className="h-72" />
        ) : !points.length ? (
          <Alert><AlertTitle>No data for this range</AlertTitle><AlertDescription>Pick another date range or location.</AlertDescription></Alert>
        ) : (
          <StatsChart points={points} metric={f.metric} unit={f.unit} title={title} />
        )}
      </CardContent>
    </Card>
  );
}
