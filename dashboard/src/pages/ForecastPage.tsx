// Forecast for one city: 7 daily cards (NWS day/night periods), the next 48 hours (NWS hourly, twin charts),
// "Models disagree?" (daily high per model with the spread shaded) and active NWS alerts for the city's state.
// City: the `city` filter (the city selected on the map); without one, a prompt to pick a city.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cloud, CloudFog, CloudLightning, CloudRain, CloudSun, Moon, Snowflake, Sun } from "lucide-react";
import { api, isSnapshot, type AlertRow } from "@/lib/api";
import { conditionOf, dailyCards, dedupeAlerts, local, modelDailyHighs, next48, type Condition } from "@/lib/forecast";
import { MODELS } from "@/lib/models";
import { liveTime } from "@/lib/snapshot";
import { fmt, toUnit, type TempUnit } from "@/lib/units";
import { useFilters } from "@/store/filters";
import { FilterBar } from "@/components/FilterBar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { TwinCharts } from "@/components/chart/TwinCharts";
import { MultiLineChart } from "@/components/chart/MultiLineChart";

const ICONS: Record<Condition, typeof Sun> = { storm: CloudLightning, snow: Snowflake, rain: CloudRain, fog: CloudFog, cloud: Cloud, partly: CloudSun, clear: Sun };
const CHART_MODELS = MODELS.filter((m) => !m.baseline);

export function ForecastPage() {
  const f = useFilters();
  const locations = useQuery({ queryKey: ["locations"], queryFn: api.locations, staleTime: Infinity });
  const city = locations.data?.data.find((l) => l.id === f.city);
  return (
    <>
      <FilterBar fields={["city", "unit"]} />
      {!f.city ? (
        <Card data-forecast-prompt>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">Pick a city above (or click one on the Overview map) to see its forecast.</CardContent>
        </Card>
      ) : !city ? (
        <Skeleton className="h-40" />
      ) : (
        <CityForecast id={city.id} name={`${city.name}, ${city.state}`} state={city.state} tz={city.timezone} unit={f.unit} />
      )}
    </>
  );
}

function CityForecast({ id, name, state, tz, unit }: { id: string; name: string; state: string; tz: string; unit: TempUnit }) {
  const hourly = useQuery({ queryKey: ["forecast", id], queryFn: () => api.forecast(id) });
  const periods = useQuery({ queryKey: ["periods", id], queryFn: () => api.forecastPeriods(id) });
  const alerts = useQuery({ queryKey: ["alerts", state], queryFn: () => api.alerts(state) });
  const rows = hourly.data?.data ?? [];
  const nwsIssued = rows.find((r) => r.model === "nws")?.issued_at ?? periods.data?.data[0]?.issued_at;
  const deg = `°${unit}`;
  const t = (c: number | null) => toUnit(c, unit);

  const cards = dailyCards(periods.data?.data ?? [], tz);
  const h48 = next48(rows, tz);
  const highs = modelDailyHighs(rows, tz, CHART_MODELS.map((m) => m.id));
  const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const series = CHART_MODELS.map((m) => ({ id: m.id, name: m.name, color: m.color, values: (highs.series[m.id] ?? []).map(t) }))
    .filter((s) => s.values.some((v) => v != null));

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{name}</CardTitle>
          <CardDescription data-forecast-issued>
            {nwsIssued ? (isSnapshot && !liveTime("forecasts") ? `Forecast as of ${nwsIssued.slice(0, 10)}` : `NWS forecast issued ${fmtLocal(nwsIssued, tz)} (local time)`) : "Loading forecast…"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {periods.error ? <Problem what="the daily forecast" error={periods.error} /> : periods.isPending ? <Skeleton className="h-36" /> : !cards.length ? (
            <p className="text-sm text-muted-foreground">No NWS periods for this city right now.</p>
          ) : (
            <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7" aria-label="7-day forecast">
              {cards.map((c) => {
                const cond = conditionOf(c.text);
                const Icon = c.night && cond === "clear" ? Moon : ICONS[cond];
                return (
                  <li key={c.date} data-day={c.date} className="flex flex-col items-center gap-1 rounded-lg border bg-muted/40 p-3 text-center">
                    <span className="text-xs font-medium text-muted-foreground">{c.weekday} {Number(c.date.slice(8))}</span>
                    <Icon className="size-8" style={{ color: cond === "rain" || cond === "storm" ? "var(--c-rain)" : cond === "clear" || cond === "partly" ? "var(--c-avg)" : "var(--muted-foreground)" }} aria-hidden />
                    <span className="text-sm tabular-nums"><b>{c.high == null ? "—" : `${fmt(t(c.high), 0)}°`}</b> <span className="text-muted-foreground">{c.low == null ? "" : `/ ${fmt(t(c.low), 0)}°`}</span></span>
                    <span className="text-xs tabular-nums" style={{ color: "var(--c-rain)" }}>{c.rainChance == null ? "" : `💧 ${c.rainChance}%`}</span>
                    <span className="line-clamp-2 text-xs text-muted-foreground" title={c.text}>{c.text || "—"}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>

      <section aria-label="Next 48 hours" className="flex flex-col gap-2">
        <h2 className="px-1 text-sm font-semibold">Next 48 hours (NWS)</h2>
        <TwinCharts unit={unit} subject={name} scope="next 48 hours" maWindow={3} rainTitle="Rain chance" rainUnit="%"
          temp={{ points: h48.temp, pending: hourly.isPending, error: hourly.error }}
          rain={{ points: h48.rain, pending: hourly.isPending, error: hourly.error }} emptyHint="No hourly NWS forecast for this city right now." />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Models disagree?</CardTitle>
          <CardDescription>Daily high for the next 7 days from each model; the shaded spread shows how uncertain the forecast is.
            Days a model doesn't fully cover (e.g. HRRR beyond ~18 h) are left empty.</CardDescription>
        </CardHeader>
        <CardContent>
          {hourly.error ? <Problem what="the model forecasts" error={hourly.error} /> : hourly.isPending ? <Skeleton className="h-72" /> : series.length < 2 ? (
            <p className="text-sm text-muted-foreground">Not enough model forecasts for this city yet.</p>
          ) : (
            <MultiLineChart labels={highs.dates.map(dayLabel)} series={series} unitLabel={deg} spread digits={0}
              title={`Daily high forecast by model for ${name}`} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active NWS alerts · {state}</CardTitle>
          <CardDescription>{!isSnapshot ? "Alerts that have not expired, for the whole state." : liveTime("alerts") ? `Alerts that had not expired at ${liveTime("alerts")!.slice(0, 16).replace("T", " ")} UTC, for the whole state.` : "Alerts active when the demo snapshot was taken."}</CardDescription>
        </CardHeader>
        <CardContent>
          {alerts.error ? <Problem what="alerts" error={alerts.error} /> : alerts.isPending ? <Skeleton className="h-20" /> : (
            <AlertList alerts={dedupeAlerts(alerts.data?.data ?? [])} state={state} tz={tz} />
          )}
        </CardContent>
      </Card>
    </>
  );
}

const SEVERITY: Record<string, string> = { Extreme: "#b91c1c", Severe: "#ea580c", Moderate: "#d97706", Minor: "#2563eb" };

function AlertList({ alerts, state, tz }: { alerts: AlertRow[]; state: string; tz: string }) {
  const [all, setAll] = useState(false);
  if (!alerts.length) return <p className="text-sm text-muted-foreground" data-no-alerts>No active alerts for {state}.</p>;
  const shown = all ? alerts : alerts.slice(0, 6);
  return (
    <>
      <ul className="grid gap-2 md:grid-cols-2" aria-label="Alerts">
        {shown.map((a) => <AlertItem key={a.id} a={a} tz={tz} />)}
      </ul>
      {alerts.length > shown.length && (
        <button type="button" className="mt-3 text-sm underline underline-offset-2" onClick={() => setAll(true)}>Show all {alerts.length} alerts</button>
      )}
    </>
  );
}

function AlertItem({ a, tz }: { a: AlertRow; tz: string }) {
  const color = SEVERITY[a.severity ?? ""] ?? "#6b7280";
  const end = a.ends ?? a.expires;
  return (
    <li data-alert data-severity={a.severity ?? "Unknown"} className="rounded-lg border-l-4 bg-muted/40 p-3 text-sm" style={{ borderLeftColor: color }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded px-1.5 py-0.5 text-xs font-semibold text-white" style={{ background: color }}>{a.severity ?? "Unknown"}</span>
        <span className="font-medium">{a.event}</span>
      </div>
      {a.area_desc && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{a.area_desc}</p>}
      <p className="mt-1 text-xs text-muted-foreground">
        {a.onset ? `From ${fmtLocal(a.onset, tz)}` : "In effect"}{end ? ` until ${fmtLocal(end, tz)}` : ""} (city time)
      </p>
    </li>
  );
}

function Problem({ what, error }: { what: string; error: Error }) {
  return <Alert variant="destructive"><AlertTitle>Could not load {what}</AlertTitle><AlertDescription>{error.message}</AlertDescription></Alert>;
}

function fmtLocal(s: string, tz: string) {
  const { date } = local(s, tz);
  const time = new Date(`${s.replace(" ", "T")}Z`).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return `${new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}, ${time}`;
}
