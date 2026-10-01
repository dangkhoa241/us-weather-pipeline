// Forecast accuracy: how close each model's hourly temperature forecasts came to what was observed.
// Hero line, leaderboard, error vs lead day, US map (best model per state, or one model's error), bias by month,
// biggest misses, and a short "how this is measured" note. Errors/biases in °F are ×1.8 only (lib/accuracy.ts).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from "@tanstack/react-table";
import { api, isSnapshot, type AreaParams, type LocationRow } from "@/lib/api";
import { bestModelByState, biasWord, errorToUnit, heroLine, leaderboard, LEAD_DAYS, MIN_SAMPLES, monthLabel, type LeaderRow } from "@/lib/accuracy";
import { colorFor, extent } from "@/lib/colors";
import { local } from "@/lib/forecast";
import { MODELS, MODEL_BY_ID, modelName } from "@/lib/models";
import { snapshotAccuracyRange } from "@/lib/snapshot";
import { fmt, type TempUnit } from "@/lib/units";
import { selectedRange, useFilters } from "@/store/filters";
import { FilterBar } from "@/components/FilterBar";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MultiLineChart } from "@/components/chart/MultiLineChart";
import { UsMap } from "@/components/map/UsMap";

const ERROR_PALETTE = ["#1a9850", "#91cf60", "#d9ef8b", "#fee08b", "#fc8d59", "#d73027"] as const;

export function AccuracyPage() {
  const f = useFilters();
  const range = selectedRange(f);
  const lead = Number(f.lead);
  const deg = `°${f.unit}`;
  const area: AreaParams = { ...range, ...(/^[A-Z]{2}$/.test(f.area) ? { state: f.area } : f.area ? { location: f.area } : {}) };
  const locations = useQuery({ queryKey: ["locations"], queryFn: api.locations, staleTime: Infinity });
  const cities = new Map((locations.data?.data ?? []).map((l) => [l.id, l]));
  const areaName = !f.area ? "all US" : cities.get(f.area) ? `${cities.get(f.area)!.name}, ${cities.get(f.area)!.state}` : f.area;

  const summary = useQuery({ queryKey: ["accuracy", area], queryFn: () => api.accuracy(area) });
  const states = useQuery({ queryKey: ["accuracyStates", range, lead], queryFn: () => api.accuracyStates({ ...range, lead }) });
  const months = useQuery({ queryKey: ["accuracyMonths", area, lead], queryFn: () => api.accuracyMonths({ ...area, lead }) });
  const misses = useQuery({ queryKey: ["accuracyMisses", area, lead], queryFn: () => api.accuracyMisses({ ...area, lead, limit: 10 }) });
  const demoRange = useQuery({ queryKey: ["snapshotAccuracyRange"], queryFn: snapshotAccuracyRange, enabled: isSnapshot, staleTime: Infinity });

  const board = useMemo(() => leaderboard(summary.data?.data ?? [], lead, f.unit), [summary.data, lead, f.unit]);
  const hero = heroLine(board, lead, f.unit);
  const baseline = board.find((r) => r.baseline);
  const demoLimited = isSnapshot && demoRange.data && (f.area !== "" || demoRange.data.from !== range.from || demoRange.data.to !== range.to);

  return (
    <>
      <FilterBar fields={["area", "range", "lead", "unit"]} />

      <Card className="bg-gradient-to-br from-card to-muted/60">
        <CardHeader>
          <CardDescription>Forecast accuracy · {areaName} · {range.from} – {range.to}</CardDescription>
          <CardTitle className="text-2xl leading-tight" data-hero>
            {summary.isPending ? <Skeleton className="h-8 w-2/3" /> : hero ?? "Not enough forecast/observation pairs for this selection yet."}
          </CardTitle>
          {hero && baseline?.mae[lead - 1] != null && (
            <CardDescription>For comparison, the Open-Meteo best-match blend (baseline) misses by {fmt(baseline.mae[lead - 1], 1)}{deg} on average.</CardDescription>
          )}
        </CardHeader>
        {demoLimited && (
          <CardContent className="text-xs text-muted-foreground">
            Demo snapshot: the map, bias and misses are pre-computed for all US over {demoRange.data!.from} – {demoRange.data!.to} only.
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Leaderboard</CardTitle>
          <CardDescription>Average error (MAE, {deg}) by lead day; bias and sample size at lead day {lead}. Click a column to sort.</CardDescription>
        </CardHeader>
        <CardContent>
          {summary.error ? <Problem what="the leaderboard" error={summary.error} /> : summary.isPending ? <Skeleton className="h-48" /> : !board.length ? (
            <Empty />
          ) : <Leaderboard rows={board} lead={lead} deg={deg} />}
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Error grows with lead time</CardTitle>
            <CardDescription>Average error ({deg}) vs how many days ahead the forecast was made. Dashed: baseline.</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.isPending ? <Skeleton className="h-72" /> : !board.length ? <Empty /> : (
              <MultiLineChart labels={LEAD_DAYS.map((d) => `${d} day${d === 1 ? "" : "s"}`)} unitLabel={deg} digits={1}
                title={`Average forecast error by lead day, ${areaName}`}
                series={board.map((r) => ({ id: r.model, name: r.name, color: MODEL_BY_ID.get(r.model)!.color, values: r.mae, dashed: r.baseline }))} />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Too hot or too cold?</CardTitle>
            <CardDescription>Bias by month at lead day {lead} ({deg}): above 0 = forecasts ran too warm, below 0 = too cold.</CardDescription>
          </CardHeader>
          <CardContent>
            {months.error ? <Problem what="the bias chart" error={months.error} /> : months.isPending ? <Skeleton className="h-72" /> : (
              <BiasChart rows={months.data?.data ?? []} unit={f.unit} deg={deg} areaName={areaName} />
            )}
          </CardContent>
        </Card>
      </div>

      <AccuracyMap rows={states.data?.data ?? []} pending={states.isPending} error={states.error} lead={lead} unit={f.unit} deg={deg}
        locations={locations.data?.data ?? []} onState={(code) => useFilters.getState().setFilters({ area: code })} />

      <Card>
        <CardHeader>
          <CardTitle>Biggest misses</CardTitle>
          <CardDescription>Largest hourly errors at lead day {lead} ({areaName}); at most one per city and day. Times are city-local.</CardDescription>
        </CardHeader>
        <CardContent>
          {misses.error ? <Problem what="the biggest misses" error={misses.error} /> : misses.isPending ? <Skeleton className="h-40" /> : !misses.data?.data.length ? <Empty /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-misses>
                <thead><tr className="border-b text-left">
                  <th className="px-2 py-2 font-medium">When</th><th className="px-2 py-2 font-medium">City</th><th className="px-2 py-2 font-medium">Model</th>
                  <th className="px-2 py-2 text-right font-medium">Forecast</th><th className="px-2 py-2 text-right font-medium">Actual</th><th className="px-2 py-2 text-right font-medium">Miss</th>
                </tr></thead>
                <tbody>
                  {misses.data.data.map((m) => {
                    const c = cities.get(m.location_id);
                    const when = c ? local(m.target_time, c.timezone) : null;
                    const temp = (v: number | null) => (v == null ? "—" : `${fmt(f.unit === "F" ? v * 1.8 + 32 : v, 1)}°`);
                    const err = errorToUnit(m.error_c, f.unit);
                    return (
                      <tr key={`${m.location_id}-${m.target_time}-${m.model}`} className="border-b last:border-0">
                        <td className="px-2 py-1.5 tabular-nums">{when ? `${when.date} ${String(when.hour).padStart(2, "0")}:00` : m.target_time}</td>
                        <td className="px-2 py-1.5">{c ? `${c.name}, ${c.state}` : m.location_id}</td>
                        <td className="px-2 py-1.5">{modelName(m.model)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{temp(m.forecast_c)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{temp(m.observed_c)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums" style={{ color: (err ?? 0) > 0 ? "var(--c-temp)" : "var(--c-cool)" }}>
                          {err == null ? "—" : `${err > 0 ? "+" : ""}${fmt(err, 1)}${deg}`} <span className="text-xs text-muted-foreground">{biasWord(err)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>How this is measured</CardTitle></CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground md:grid-cols-2">
          <p><b className="text-foreground">Error (MAE)</b>: each hourly temperature forecast is compared with the temperature observed at that hour (Open-Meteo archive); the average size of the difference, ignoring its sign.</p>
          <p><b className="text-foreground">Bias</b>: the average signed difference (forecast − observed). Positive means the model runs too warm, negative too cold. In °F, errors and biases are ×1.8 (no +32).</p>
          <p><b className="text-foreground">Lead day</b>: how many days before the forecast hour the model run was issued (1 = the day before). Errors usually grow with lead time.</p>
          <p><b className="text-foreground">Data</b>: past model runs (ECMWF, GFS, ICON, HRRR) and NWS forecasts collected by the pipeline. <i>Best match</i> is a lead-day-only baseline (approximate issue time), listed but not ranked; legacy snapshots are excluded; models with fewer than {MIN_SAMPLES} pairs aren't ranked. NWS appears once its forecasts can be matched with observations (~5-day lag).</p>
        </CardContent>
      </Card>
    </>
  );
}

const column = createColumnHelper<LeaderRow>();

function Leaderboard({ rows, lead, deg }: { rows: LeaderRow[]; lead: number; deg: string }) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "rank", desc: false }]);
  const columns = useMemo(() => [
    column.accessor((r) => r.rank ?? 99, { id: "rank", header: "Rank", cell: (c) => c.row.original.rank ?? "–" }),
    column.accessor("name", { header: "Model", cell: (c) => (
      <span className="flex items-center gap-2"><span className="inline-block size-2.5 rounded-full" style={{ background: MODEL_BY_ID.get(c.row.original.model)?.color }} />
        {c.getValue()}{c.row.original.baseline && <span className="text-xs text-muted-foreground">baseline</span>}</span>) }),
    ...LEAD_DAYS.map((d) => column.accessor((r) => r.mae[d - 1] ?? undefined, {
      id: `lead${d}`, header: `${d}d`, sortUndefined: "last",
      cell: (c) => <span className={d === lead ? "font-semibold" : ""}>{fmt(c.row.original.mae[d - 1], 1)}</span>,
    })),
    column.accessor((r) => r.bias ?? undefined, { id: "bias", header: "Bias", sortUndefined: "last", cell: (c) => {
      const b = c.row.original.bias;
      return b == null ? "—" : <span>{b > 0 ? "+" : ""}{fmt(b, 1)}{deg} <span className="text-xs text-muted-foreground">{biasWord(b)}</span></span>;
    } }),
    column.accessor("n", { header: "Samples", cell: (c) => c.getValue().toLocaleString("en-US") }),
  ], [lead, deg]);
  const table = useReactTable({ data: rows, columns, state: { sorting }, onSortingChange: setSorting, getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel() });
  const numeric = (id: string) => id !== "name";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-leaderboard>
        <caption className="sr-only">Forecast error by model and lead day</caption>
        <thead>
          {table.getHeaderGroups().map((g) => (
            <tr key={g.id} className="border-b">
              {g.headers.map((h) => (
                <th key={h.id} scope="col" aria-sort={h.column.getIsSorted() === "asc" ? "ascending" : h.column.getIsSorted() === "desc" ? "descending" : "none"}
                  className={`px-2 py-2 font-medium ${numeric(h.column.id) ? "text-right" : "text-left"} ${h.column.id === `lead${lead}` ? "bg-muted/60" : ""}`}>
                  <button type="button" onClick={h.column.getToggleSortingHandler()}>
                    {flexRender(h.column.columnDef.header, h.getContext())}{{ asc: " ▲", desc: " ▼" }[h.column.getIsSorted() as string] ?? ""}
                  </button>
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((r) => (
            <tr key={r.id} data-model={r.original.model} className={`border-b last:border-0 ${r.original.rank === 1 ? "bg-muted/40" : ""}`}>
              {r.getVisibleCells().map((c) => (
                <td key={c.id} className={`px-2 py-1.5 ${numeric(c.column.id) ? "text-right tabular-nums" : ""} ${c.column.id === `lead${lead}` ? "bg-muted/60" : ""}`}>
                  {flexRender(c.column.columnDef.cell, c.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BiasChart({ rows, unit, deg, areaName }: { rows: { month: string; model: string; bias_c: number | null; n: number }[]; unit: TempUnit; deg: string; areaName: string }) {
  const monthsList = [...new Set(rows.map((r) => r.month))].sort();
  const series = MODELS.filter((m) => rows.some((r) => r.model === m.id)).map((m) => ({
    id: m.id, name: m.name, color: m.color, dashed: m.baseline,
    values: monthsList.map((mo) => {
      const r = rows.find((x) => x.model === m.id && x.month === mo);
      return r && r.n >= MIN_SAMPLES ? errorToUnit(r.bias_c, unit) : null;
    }),
  }));
  if (!monthsList.length) return <Empty />;
  return <MultiLineChart labels={monthsList.map(monthLabel)} series={series} unitLabel={deg} zeroLine digits={1} title={`Forecast bias by month, ${areaName}`} />;
}

function AccuracyMap({ rows, pending, error, lead, unit, deg, locations, onState }: {
  rows: { state: string; model: string; n: number; mae_c: number | null; bias_c: number | null }[]; pending: boolean; error: Error | null;
  lead: number; unit: TempUnit; deg: string; locations: LocationRow[]; onState: (code: string) => void;
}) {
  const [mode, setMode] = useState("best");
  const models = MODELS.filter((m) => !m.baseline && rows.some((r) => r.model === m.id));
  const best = bestModelByState(rows);
  let fill: Map<string, { color: string; label: string }>;
  let legend: React.ReactNode;
  if (mode === "best") {
    fill = new Map([...best].map(([st, b]) => [st, { color: MODEL_BY_ID.get(b.model)!.color, label: `${modelName(b.model)} is best, ${fmt(errorToUnit(b.mae_c, unit), 1)}${deg} average error` }]));
    const used = models.filter((m) => [...best.values()].some((b) => b.model === m.id));
    legend = (
      <ul className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {used.map((m) => <li key={m.id} className="flex items-center gap-1.5"><span className="inline-block size-3 rounded-sm" style={{ background: m.color }} />{m.name}</li>)}
        <li className="flex items-center gap-1.5"><span className="inline-block size-3 rounded-sm" style={{ background: "var(--map-hatch)" }} />not enough data</li>
      </ul>
    );
  } else {
    const mine = rows.filter((r) => r.model === mode && r.n >= MIN_SAMPLES && r.mae_c != null);
    const values = mine.map((r) => errorToUnit(r.mae_c, unit) as number);
    const ext = extent(values) ?? [0, 1];
    fill = new Map(mine.map((r) => {
      const v = errorToUnit(r.mae_c, unit) as number;
      return [r.state, { color: colorFor(v, ext, ERROR_PALETTE), label: `${modelName(mode)} average error ${fmt(v, 1)}${deg}, bias ${fmt(errorToUnit(r.bias_c, unit), 1)}${deg}` }];
    }));
    legend = (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{fmt(ext[0], 1)}</span><div className="h-2 w-40 rounded" style={{ background: `linear-gradient(to right, ${ERROR_PALETTE.join(",")})` }} /><span>{fmt(ext[1], 1)}</span>
        <span>{modelName(mode)} average error ({deg}), lead day {lead}</span>
      </div>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Who forecasts each state best?</CardTitle>
        <CardDescription>Lead day {lead}. Click a state to filter the page to it.</CardDescription>
        <CardAction>
          <Select value={mode} onValueChange={setMode}>
            <SelectTrigger className="w-48" aria-label="Map shows"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="best">Best model per state</SelectItem>
              {models.map((m) => <SelectItem key={m.id} value={m.id}>Error of {m.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent>
        {error ? <Problem what="the map" error={error} /> : pending ? <Skeleton className="h-80" /> : (
          <div className="mx-auto max-w-4xl" data-accuracy-map data-mode={mode}>
            <UsMap states={[]} locations={locations} metric="temp_c" unit={unit} selectedLocation="" onSelectLocation={() => {}}
              stateFill={fill} legend={legend} showCities={false} onStateClick={onState} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Empty() {
  return <p className="text-sm text-muted-foreground">No forecast/observation pairs for this selection yet. Try a longer date range or another lead day.</p>;
}

function Problem({ what, error }: { what: string; error: Error }) {
  return <Alert variant="destructive"><AlertTitle>Could not load {what}</AlertTitle><AlertDescription>{error.message}</AlertDescription></Alert>;
}
