// City drill-down below the map: years → 12 months of a year → days of a month, with a breadcrumb.
// The level lives in the URL (filters year/month), so links and back/forward keep it.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type StatsRow } from "@/lib/api";
import { allYearsRange, dayPoints, drillLevel, monthName, monthPoints, rangeFor, yearPoints, yearsWithData } from "@/lib/drill";
import { ALL_US, useFilters } from "@/store/filters";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SignupButton } from "@/components/SignupDialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TwinCharts, type TwinData } from "@/components/chart/TwinCharts";
import { maWindowFor } from "@/lib/movingAverage";
import { ForecastReplayPanel } from "@/components/replay/ForecastReplayPanel";

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

  // Both charts (temperature and rain) always show the same level, so every level is queried for both metrics.
  const stats = (metric: "temp_c" | "precip_mm", period: string, range: { from: string; to: string } | null, enabled = true) => {
    const p = { locations: cityId, metric, period, ...range! };
    return useQuery({ queryKey: ["stats", p], queryFn: () => api.stats(p), enabled: enabled && range != null });   // eslint-disable-line react-hooks/rules-of-hooks
  };

  const years = stats("temp_c", "year", allYearsRange());
  const yearList = yearsWithData(years.data?.data ?? []);
  const level = drillLevel(f.year, f.month);
  const year = f.year === "all" ? "" : f.year || yearList[0] || "";

  const monthsRange = year ? rangeFor(year) : null;
  const daysRange = year && f.month ? rangeFor(year, f.month) : null;
  const yearsRain = stats("precip_mm", "year", allYearsRange());
  const monthsT = stats("temp_c", "month", monthsRange, level === "months");
  const monthsR = stats("precip_mm", "month", monthsRange, level === "months");
  const daysT = stats("temp_c", "day", daysRange, level === "days");
  const daysR = stats("precip_mm", "day", daysRange, level === "days");

  const [qt, qr] = level === "years" ? [years, yearsRain] : level === "months" ? [monthsT, monthsR] : [daysT, daysR];
  const build = (rows: StatsRow[]) => level === "years" ? yearPoints(rows) : level === "months" ? monthPoints(rows) : dayPoints(year, f.month, rows);
  const temp: TwinData = { points: build(qt.data?.data ?? []), pending: years.isPending || qt.isPending, error: qt.error };
  const rain: TwinData = { points: build(qr.data?.data ?? []), pending: years.isPending || qr.isPending, error: qr.error };

  const withData = new Set([...temp.points, ...rain.points].filter((p) => p.avg != null || p.sum != null).map((p) => p.key));
  const onSelect = level === "years" ? (key: string) => f.setFilters({ year: key, month: "" })
    : level === "months" ? (key: string) => { if (withData.has(key)) f.setFilters({ year, month: key }); }
    : undefined;
  const scope = level === "years" ? "per year" : level === "months" ? `per month, ${year}` : `per day, ${monthName(f.month)} ${year}`;
  // Forecast replay: only on request, at the days level. The clock is read once, when it opens (null = closed).
  const [replayNow, setReplayNow] = useState<number | null>(null);
  const replay = replayNow != null;
  const replayButton = useRef<HTMLButtonElement>(null);
  const closeReplay = () => { setReplayNow(null); replayButton.current?.focus(); };

  return (
    <div className="flex flex-col gap-4">
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
            <SignupButton cityId={cityId} cityName={cityName} />
            {level === "days" && (
              <button ref={replayButton} type="button" aria-expanded={replay} aria-controls="forecast-replay" onClick={() => setReplayNow(replay ? null : Date.now())}
                className="rounded-md bg-cta px-2.5 py-1 text-sm font-medium text-cta-foreground shadow-sm transition-colors hover:bg-cta-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cta aria-expanded:bg-cta-hover">
                Replay forecasts
              </button>
            )}
            {level !== "years" && yearList.length > 0 && (
              <Select value={year} onValueChange={(y) => f.setFilters({ year: y, month: "" })}>
                <SelectTrigger className="w-28" aria-label="Year"><SelectValue /></SelectTrigger>
                <SelectContent>{yearList.map((y) => <SelectItem key={y} value={y}>{y}</SelectItem>)}</SelectContent>
              </Select>
            )}
            <button type="button" aria-label="Close city history" className="rounded-md px-2 py-1 text-lg leading-none text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => f.setFilters({ city: "", year: "", month: "", location: ALL_US })}>×</button>
          </CardAction>
        </CardHeader>
        {onSelect && (
          <CardContent data-drill-hint className="-mt-2 text-xs text-muted-foreground">
            Select a {level === "years" ? "year" : "month"} on either chart to drill down.
            {level === "months" && <> Open a month, then use <strong className="font-semibold text-cta">Replay forecasts</strong> to see how each model's forecast changed.</>}
          </CardContent>
        )}
      </Card>
      {replayNow != null && level === "days" && (
        <div id="forecast-replay">
          <ForecastReplayPanel city={cityId} cityName={cityName} year={year} month={f.month} unit={f.unit} now={replayNow}
            onClose={closeReplay} onJump={(y, m) => f.setFilters({ year: y, month: m })} />
        </div>
      )}
      <TwinCharts temp={temp} rain={rain} unit={f.unit} subject={cityName} scope={scope} maWindow={maWindowFor(level === "days")}
        onSelect={onSelect} emptyHint={`${cityName} has no data ${scope}.`} readyMark="drill-chart-ready" />
    </div>
  );
}

function Crumb({ current, onClick, children }: { current?: boolean; onClick?: () => void; children: React.ReactNode }) {
  if (current) return <span aria-current="page" className="font-medium text-foreground">{children}</span>;
  return <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={onClick}>{children}</button>;
}
