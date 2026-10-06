// Forecast replay panel, opened from the city's day drill-down ("Replay forecasts"). For one past day it shows what
// each model predicted 1–7 days before, live from Open-Meteo's Previous Runs API. If the live call fails, it says so
// and shows a bundled sample made by the same client code. Every state without data says so in words.
import { useEffect, useRef, useState } from "react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ReplayChart } from "@/components/replay/ReplayChart";
import { dayLabel, daysAhead, pickSample, replayCity, replayDaysInMonth, replayInsight, replayRange, replaySeries, ReplayError, type ReplayResult } from "@/lib/replay";
import { useReplay, useReplaySample } from "@/lib/useReplay";
import { modelName } from "@/lib/models";
import { Term } from "@/components/Term";
import { monthName } from "@/lib/drill";
import { fmt, toUnit, type TempUnit } from "@/lib/units";

type Props = {
  city: string;
  cityName: string;
  year: string;
  month: string;      // "07"
  unit: TempUnit;
  now: number;        // injected clock (tests use fixed dates)
  onClose: () => void;
  onJump: (year: string, month: string) => void;   // open a month that can be replayed
};

export function ForecastReplayPanel({ city, cityName, year, month, unit, now, onClose, onJump }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);   // keyboard users land on the panel they opened
  const days = replayDaysInMonth(year, month, now);
  const [picked, setPicked] = useState("");
  const day = days.includes(picked) ? picked : days.at(-1) ?? "";
  const live = useReplay(city, day, now);
  const failed = live.isError && !(live.error instanceof ReplayError && live.error.kind === "invalid");
  const sample = useReplaySample(failed);
  const sampleResult = failed && sample.data ? pickSample(sample.data, city) : null;

  let body: React.ReactNode;
  if (!replayCity(city)) body = <p className="text-sm text-muted-foreground">Forecast replay isn't available for this location.</p>;
  else if (!day) {
    const { from, to } = replayRange(now);
    const target = `${year}-${month}` < from.slice(0, 7) ? from : to;
    body = (
      <p className="text-sm text-muted-foreground">
        Forecast replay covers {dayLabel(from)} – {dayLabel(to)} (observations need about a week to settle), so no days in {monthName(month)} {year}.{" "}
        <button type="button" className="underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => onJump(target.slice(0, 4), target.slice(5, 7))}>
          Show {monthName(target.slice(5, 7))} {target.slice(0, 4)}
        </button>
      </p>
    );
  } else if (live.isPending) body = <Skeleton className="h-64" aria-label="Loading forecasts" />;
  else if (live.data) body = <ReplayBody result={live.data} cityName={cityName} unit={unit} />;
  else if (!failed) body = <p role="alert" className="text-sm text-destructive">{live.error?.message}</p>;
  else {
    const reason = live.error?.message ?? "";
    body = (
      <div className="flex flex-col gap-3">
        <p role="alert" data-replay-unavailable className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
          <strong>Live data unavailable.</strong> {reason}{" "}
          {sample.isPending ? "Loading a bundled sample…" : sampleResult ? `Showing a bundled sample instead: ${replayCity(sampleResult.city)?.name}, ${dayLabel(sampleResult.day)}.` : "No bundled sample either."}
        </p>
        {sampleResult && <ReplayBody result={sampleResult} cityName={replayCity(sampleResult.city)?.name ?? sampleResult.city} unit={unit} />}
      </div>
    );
  }
  const isSample = Boolean(sampleResult);

  return (
    <Card data-replay-panel role="region" aria-labelledby="replay-heading">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <h3 id="replay-heading" ref={heading} tabIndex={-1} className="outline-none focus-visible:underline">Forecast replay</h3>
          <span data-replay-source className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
            <span className={`size-2 rounded-full ${isSample ? "bg-amber-500" : "bg-emerald-500"}`} aria-hidden />
            {isSample ? "Sample · bundled, not live" : <>Live · Open-Meteo <Term k="Previous runs">previous runs</Term></>}
          </span>
        </CardTitle>
        <CardDescription>What each model predicted for the day's high <Term k="Lead day">1 to 7 days before</Term>, against the <Term k="Observed">observed</Term> high.</CardDescription>
        <CardAction className="flex items-center gap-2">
          {days.length > 0 && (
            <Select value={day} onValueChange={setPicked}>
              <SelectTrigger className="w-44" aria-label="Day to replay"><SelectValue /></SelectTrigger>
              <SelectContent>{days.map((d) => <SelectItem key={d} value={d}>{dayLabel(d)}</SelectItem>)}</SelectContent>
            </Select>
          )}
          <button type="button" aria-label="Close forecast replay" onClick={onClose}
            className="rounded-md px-2 py-1 text-lg leading-none text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">×</button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {body}
        <p className="text-xs text-muted-foreground">
          Data: <a className="underline underline-offset-2" href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo.com</a>{" "}
          (Previous Runs and Historical Weather APIs), licensed{" "}
          <Term k="CC BY 4.0" /> (<a className="underline underline-offset-2" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">licence</a>).{" "}
          <Term k="Lead day">Lead day</Term> N = the forecast made N days before; <Term k="Observed">observed</Term> = Open-Meteo's historical <Term k="Reanalysis">reanalysis</Term>, not a station reading.
        </p>
      </CardContent>
    </Card>
  );
}

function ReplayBody({ result, cityName, unit }: { result: ReplayResult; cityName: string; unit: TempUnit }) {
  const series = replaySeries(result, unit);
  const observed = toUnit(result.observed, unit) as number;
  return (
    <div className="flex flex-col gap-3">
      <p data-replay-insight className="text-base font-medium">{replayInsight(result, unit)}</p>
      <p className="text-sm text-muted-foreground"><Term k="Observed">Observed</Term> high in {cityName} on {dayLabel(result.day)}: <strong className="text-foreground">{fmt(observed)}°{unit}</strong></p>
      <ReplayChart series={series} observed={observed} unit={unit} title={`Forecasts of the high for ${cityName} on ${dayLabel(result.day)}, by days ahead`} />
      <ul className="sr-only" aria-label="Forecasts by model">
        {series.map((s) => (
          <li key={s.id}>{s.name}: {s.points.map((p) => `${fmt(p.v)}°${unit} ${daysAhead(p.lead)}`).join(", ")}.</li>
        ))}
      </ul>
      {result.missing.length > 0 && (
        <p className="text-xs text-muted-foreground">No forecasts from {result.missing.map(modelName).join(", ")} for this place and day
          {result.missing.includes("gfs_hrrr") ? " (HRRR covers the lower 48 states only)" : ""}.</p>
      )}
    </div>
  );
}
