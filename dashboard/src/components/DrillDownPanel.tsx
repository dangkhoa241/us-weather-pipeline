// City drill-down below the map: years → 12 months of a year → days of a month, with a breadcrumb.
// The level lives in the URL (filters year/month), so links and back/forward keep it.
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { allYearsRange, dayPoints, drillLevel, monthName, monthPoints, rangeFor, yearPoints, yearsWithData } from "@/lib/drill";
import { METRICS, useFilters } from "@/store/filters";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { StatsChart } from "@/components/chart/StatsChart";

/** Hidden until a city is chosen (map click or shared link); then fades in and scrolls into view. */
export function DrillDownPanel() {
  const city = useFilters((s) => s.city);
  const ref = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }   // a shared link opens directly, without scrolling
    if (!city) return;
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    ref.current?.scrollIntoView?.({ behavior: calm ? "auto" : "smooth", block: "start" });
  }, [city]);
  return (
    <div ref={ref} data-drill-section className="scroll-mt-4">
      {city ? (
        <div key={city} className="animate-in fade-in slide-in-from-bottom-4 duration-300 motion-reduce:animate-none"><DrillDownCard city={city} /></div>
      ) : (
        <Card data-drill-placeholder>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">Click a city on the map to see its monthly history.</CardContent>
        </Card>
      )}
    </div>
  );
}

function DrillDownCard({ city: cityId }: { city: string }) {
  const f = useFilters();
  const locations = useQuery({ queryKey: ["locations"], queryFn: api.locations, staleTime: Infinity });
  const city = locations.data?.data.find((l) => l.id === cityId);
  const cityName = city ? `${city.name}, ${city.state}` : cityId;
  const base = { locations: cityId, metric: f.metric };

  const yearsRange = allYearsRange();
  const years = useQuery({ queryKey: ["stats", { ...base, period: "year", ...yearsRange }], queryFn: () => api.stats({ ...base, period: "year", ...yearsRange }) });
  const yearList = yearsWithData(years.data?.data ?? []);
  const level = drillLevel(f.year, f.month);
  const year = f.year === "all" ? "" : f.year || yearList[0] || "";

  const monthsRange = year ? rangeFor(year) : null;
  const months = useQuery({
    queryKey: ["stats", { ...base, period: "month", ...monthsRange }],
    queryFn: () => api.stats({ ...base, period: "month", ...monthsRange! }),
    enabled: level === "months" && monthsRange != null,
  });
  const daysRange = year && f.month ? rangeFor(year, f.month) : null;
  const days = useQuery({
    queryKey: ["stats", { ...base, period: "day", ...daysRange }],
    queryFn: () => api.stats({ ...base, period: "day", ...daysRange! }),
    enabled: level === "days" && daysRange != null,
  });

  const active = level === "years" ? years : level === "months" ? months : days;
  const points = level === "years" ? yearPoints(years.data?.data ?? [])
    : level === "months" ? monthPoints(months.data?.data ?? [])
    : dayPoints(year, f.month, days.data?.data ?? []);
  const withData = new Set(points.filter((p) => p.avg != null || p.sum != null).map((p) => p.key));
  const onSelect = level === "years" ? (key: string) => f.setFilters({ year: key, month: "" })
    : level === "months" ? (key: string) => { if (withData.has(key)) f.setFilters({ year, month: key }); }
    : undefined;
  const scope = level === "years" ? "per year" : level === "months" ? `per month, ${year}` : `per day, ${monthName(f.month)} ${year}`;
  const title = `${METRICS[f.metric]} in ${cityName} ${scope}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{cityName}</CardTitle>
        <CardDescription>
          <nav aria-label="Breadcrumb">
            <ol className="flex flex-wrap items-center gap-1">
              <li><Crumb current={level === "years"} onClick={() => f.setFilters({ year: "all", month: "" })}>{cityName}</Crumb></li>
              {level !== "years" && year && <li aria-hidden>›</li>}
              {level !== "years" && year && <li><Crumb current={level === "months"} onClick={() => f.setFilters({ year, month: "" })}>{year}</Crumb></li>}
              {level === "days" && <li aria-hidden>›</li>}
              {level === "days" && <li><Crumb current>{monthName(f.month)}</Crumb></li>}
            </ol>
          </nav>
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          {level !== "years" && yearList.length > 0 && (
            <Select value={year} onValueChange={(y) => f.setFilters({ year: y, month: "" })}>
              <SelectTrigger className="w-28" aria-label="Year"><SelectValue /></SelectTrigger>
              <SelectContent>{yearList.map((y) => <SelectItem key={y} value={y}>{y}</SelectItem>)}</SelectContent>
            </Select>
          )}
          <button type="button" aria-label="Close city history" className="rounded-md px-2 py-1 text-lg leading-none text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => f.setFilters({ city: "", year: "", month: "" })}>×</button>
        </CardAction>
      </CardHeader>
      <CardContent data-drill-panel>
        {active.error ? (
          <Alert variant="destructive"><AlertTitle>Could not load the chart</AlertTitle><AlertDescription>{active.error.message}</AlertDescription></Alert>
        ) : years.isPending || active.isPending ? (
          <Skeleton className="h-72" />
        ) : !withData.size ? (
          <Alert><AlertTitle>No data</AlertTitle><AlertDescription>{cityName} has no {METRICS[f.metric].toLowerCase()} data {scope}.</AlertDescription></Alert>
        ) : (
          <>
            <StatsChart points={points} metric={f.metric} unit={f.unit} title={title} onSelect={onSelect} readyMark="drill-chart-ready" />
            {onSelect && <p className="mt-2 text-xs text-muted-foreground">Select a {level === "years" ? "year" : "month"} to drill down.</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Crumb({ current, onClick, children }: { current?: boolean; onClick?: () => void; children: React.ReactNode }) {
  if (current) return <span aria-current="page" className="font-medium text-foreground">{children}</span>;
  return <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={onClick}>{children}</button>;
}
