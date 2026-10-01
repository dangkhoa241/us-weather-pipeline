// Trend for the selected city (Location filter) and date range, grouped by the Period filter. Temperature and rain
// are shown side by side; the pill tabs are the same Period filter as in the filter bar.
import { useQuery } from "@tanstack/react-query";
import { api, type StatsRow } from "@/lib/api";
import { periodLabel } from "@/lib/drill";
import { maWindowFor } from "@/lib/movingAverage";
import { PERIODS, selectedRange, useFilters, type Period } from "@/store/filters";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TwinCharts, type TwinData } from "@/components/chart/TwinCharts";
import type { ChartPoint } from "@/components/chart/types";

const TABS: Record<Period, string> = { week: "Weekly", month: "Monthly", quarter: "Quarter", half: "Half", year: "Year" };

export function TrendPanel() {
  const f = useFilters();
  const range = selectedRange(f);
  const locations = useQuery({ queryKey: ["locations"], queryFn: api.locations, staleTime: Infinity });
  const city = locations.data?.data.find((l) => l.id === f.location);
  const subject = city ? `${city.name}, ${city.state}` : f.location;

  const query = (metric: "temp_c" | "precip_mm") => {
    const p = { locations: f.location, metric, period: f.period, ...range };
    return useQuery({ queryKey: ["stats", p], queryFn: () => api.stats(p) });   // eslint-disable-line react-hooks/rules-of-hooks
  };
  const toData = (q: ReturnType<typeof query>): TwinData => ({
    points: (q.data?.data ?? []).map((r: StatsRow): ChartPoint => ({
      key: r.period_start, label: periodLabel(r.period_start, f.period), min: r.min, max: r.max, avg: r.avg, sum: r.sum,
    })),
    pending: q.isPending, error: q.error,
  });
  const temp = toData(query("temp_c"));
  const rain = toData(query("precip_mm"));
  const scope = `by ${PERIODS[f.period].toLowerCase()}, ${range.from} – ${range.to}`;

  return (
    <section aria-label="Trend" className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Trend by {PERIODS[f.period].toLowerCase()}</CardTitle>
          <CardDescription>{subject}, {range.from} – {range.to}. Partial periods at the edges of the range include only the selected days.</CardDescription>
          <CardAction>
            <ToggleGroup type="single" variant="outline" size="sm" spacing={1} value={f.period} aria-label="Trend period"
              onValueChange={(v) => v && f.setFilters({ period: v as Period })}>
              {(Object.keys(TABS) as Period[]).map((p) => <ToggleGroupItem key={p} value={p} className="rounded-full px-3">{TABS[p]}</ToggleGroupItem>)}
            </ToggleGroup>
          </CardAction>
        </CardHeader>
      </Card>
      <TwinCharts temp={temp} rain={rain} unit={f.unit} subject={subject} scope={scope} maWindow={maWindowFor(false)}
        emptyHint="Pick another date range or location." />
    </section>
  );
}
