// Snapshot data source for the static demo (VITE_DATA_MODE=snapshot): same interface as the live API client,
// but reads the JSON files written by `npm run export:snapshot` (public/data/). Stats, periods, comparisons and
// the state map are computed here from daily values with the same rules as the API; forecast accuracy is
// pre-computed for the preset ranges and their comparisons.
import { z } from "zod";
import type { AccuracyRow, AlertRow, ForecastRow, LocationRow, MapRow, PeriodRow, StatsResponse, StatsRow } from "@/lib/api";
import { compareRange, dayMs, setDataEnd, toDay } from "@/lib/dates";

const SUPPORTED_FORMAT = 1;
const manifestSchema = z.object({
  format: z.number(),
  snapshot: z.string().regex(/^snapshot-\d{4}-\d{2}-\d{2}$/),
  data_as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  window: z.object({ from: z.string(), to: z.string() }),
  generated_at: z.string(),
});
export type SnapshotManifest = z.infer<typeof manifestSchema>;

type Daily = {
  location_id: string; from: string; days: number;
  temp: { min: (number | null)[]; max: (number | null)[]; avg: (number | null)[]; n: (number | null)[] };
  precip: { sum: (number | null)[]; n: (number | null)[] };
};

let manifest: SnapshotManifest | null = null;
const files = new Map<string, Promise<unknown>>();

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Demo data not available (${res.status})`);
  return res.json();
}

/** Load the manifest once at startup; presets then count back from the snapshot's "data as of" day. */
export async function initSnapshot(): Promise<SnapshotManifest> {
  const parsed = manifestSchema.safeParse(await fetchJson("/data/manifest.json"));
  if (!parsed.success) throw new Error("Demo data manifest is invalid");
  if (parsed.data.format !== SUPPORTED_FORMAT) throw new Error(`Demo data format ${parsed.data.format} is not supported`);
  manifest = parsed.data;
  setDataEnd(manifest.data_as_of);
  return manifest;
}

export const snapshotManifest = () => manifest;

function file<T>(name: string): Promise<T> {
  if (!manifest) throw new Error("Demo data not loaded");
  if (!/^[a-z0-9.-]+\.json$/.test(name)) throw new Error("Invalid data file");
  if (!files.has(name)) files.set(name, fetchJson(`/data/${manifest.snapshot}/${name}`));
  return files.get(name) as Promise<T>;
}

// ---- Stats from daily columns ---------------------------------------------------------------------------------
function dailyRows(d: Daily, metric: string, from: string, to: string): StatsRow[] {
  const rows: StatsRow[] = [];
  for (let i = 0; i < d.days; i += 1) {
    const day = toDay(dayMs(d.from) + i * 86_400_000);
    if (day < from || day > to) continue;
    if (metric === "precip_mm") {
      const n = d.precip.n[i];
      if (n == null) continue;   // no data that day: no row (as the API)
      rows.push({ location_id: d.location_id, period_start: day, min: null, max: null, avg: null, sum: d.precip.sum[i], n_values: n, n_hours: n });
    } else {
      const n = d.temp.n[i];
      if (n == null) continue;
      rows.push({ location_id: d.location_id, period_start: day, min: d.temp.min[i], max: d.temp.max[i], avg: d.temp.avg[i], sum: null, n_values: n, n_hours: n });
    }
  }
  return rows;
}

/** Start of the period containing `day` (the API's period builder: Monday weeks, Jan/Jul halves). */
export function periodStart(day: string, period: string): string {
  const [y, m] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))];
  switch (period) {
    case "week": { const wd = (new Date(dayMs(day)).getUTCDay() + 6) % 7; return toDay(dayMs(day) - wd * 86_400_000); }
    case "month": return `${day.slice(0, 7)}-01`;
    case "quarter": return `${y}-${String(3 * Math.floor((m - 1) / 3) + 1).padStart(2, "0")}-01`;
    case "half": return m <= 6 ? `${y}-01-01` : `${y}-07-01`;
    case "year": return `${y}-01-01`;
    default: return day;
  }
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** Daily rows → period rows: min of mins, max of maxes, hour-weighted mean of means, sum of sums. */
export function aggregate(rows: StatsRow[], period: string): StatsRow[] {
  if (period === "day" || period === "hour") return rows;
  const groups = new Map<string, StatsRow[]>();
  for (const r of rows) {
    const key = `${r.location_id}|${periodStart(r.period_start, period)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()].map(([key, g]) => {
    const vals = (f: "min" | "max" | "sum") => g.map((r) => r[f]).filter((v): v is number => v != null);
    const withAvg = g.filter((r) => r.avg != null);
    const n = withAvg.reduce((a, r) => a + r.n_values, 0);
    return {
      location_id: key.split("|")[0], period_start: key.split("|")[1],
      min: vals("min").length ? Math.min(...vals("min")) : null,
      max: vals("max").length ? Math.max(...vals("max")) : null,
      avg: n ? round(withAvg.reduce((a, r) => a + (r.avg as number) * r.n_values, 0) / n, 3) : null,
      sum: vals("sum").length ? round(vals("sum").reduce((a, v) => a + v, 0), 3) : null,
      n_values: g.reduce((a, r) => a + r.n_values, 0), n_hours: g.reduce((a, r) => a + r.n_hours, 0),
    };
  }).sort((a, b) => (a.location_id + a.period_start).localeCompare(b.location_id + b.period_start));
}

async function statsFor(ids: string[], metric: string, period: string, from: string, to: string) {
  const all = await Promise.all(ids.map((id) => file<Daily>(`daily-${id}.json`).then((d) => dailyRows(d, metric, from, to))));
  return aggregate(all.flat(), period);
}

// ---- API-compatible client ------------------------------------------------------------------------------------
const meta = (range?: { from: string; to: string }) => ({ source: "snapshot", data_version: manifest?.snapshot ?? null, ...(range ? { range } : {}) });

export const snapshotApi = {
  async locations() {
    return { data: await file<LocationRow[]>("locations.json"), meta: meta() };
  },

  async stats(p: { locations: string; metric: string; period: string; from: string; to: string; compare?: string }): Promise<StatsResponse> {
    const ids = p.locations.split(",");
    const data = await statsFor(ids, p.metric, p.period, p.from, p.to);
    const result: StatsResponse = { data, meta: meta({ from: p.from, to: p.to }) };
    if (p.compare === "previous" || p.compare === "last_year") {
      const other = compareRange({ from: p.from, to: p.to }, p.compare);
      result.compare = { ...other, data: await statsFor(ids, p.metric, p.period, other.from, other.to) };
    }
    return result;
  },

  /** Per-state values like /api/v1/map: mean of daily means, max of daily maxima, precipitation per city. */
  async map(p: { from: string; to: string }) {
    const locations = await file<LocationRow[]>("locations.json");
    const byState = new Map<string, LocationRow[]>();
    for (const l of locations) byState.set(l.state, [...(byState.get(l.state) ?? []), l]);
    const rows: MapRow[] = [];
    for (const [state, locs] of byState) {
      const dailies = await Promise.all(locs.map((l) => file<Daily>(`daily-${l.id}.json`)));
      const temps = dailies.flatMap((d) => dailyRows(d, "temp_c", p.from, p.to));
      const rains = dailies.map((d) => dailyRows(d, "precip_mm", p.from, p.to));
      const avgs = temps.map((r) => r.avg).filter((v): v is number => v != null);
      const maxes = temps.map((r) => r.max).filter((v): v is number => v != null);
      const citiesWithRain = rains.filter((r) => r.some((x) => x.sum != null));
      const rainTotal = rains.flat().reduce((a, r) => a + (r.sum ?? 0), 0);
      if (!temps.length && !citiesWithRain.length) continue;
      rows.push({
        state, region: locs[0].region, cities: locs.length,
        temp_avg_c: avgs.length ? round(avgs.reduce((a, v) => a + v, 0) / avgs.length, 2) : null,
        temp_max_c: maxes.length ? Math.max(...maxes) : null,
        precip_mm_per_city: citiesWithRain.length ? round(rainTotal / citiesWithRain.length, 1) : null,
      });
    }
    return { data: rows.sort((a, b) => a.state.localeCompare(b.state)), meta: meta(p) };
  },

  /** Latest forecast per model as exported (frozen at the snapshot time). */
  async forecast(locationId: string) {
    const all = await file<Record<string, Record<string, { issued_at: string; start: string; hours: [number, number | null, number | null, number | null][] }>>>("forecasts.json");
    const rows: ForecastRow[] = [];
    for (const [model, m] of Object.entries(all[locationId] ?? {})) {
      const start = Date.parse(`${m.start.replace(" ", "T")}Z`);
      for (const [h, temp_c, precip_mm, precip_prob_pct] of m.hours) {
        const target_time = new Date(start + h * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
        rows.push({ model, issued_at: m.issued_at, target_time, temp_c, precip_mm, precip_prob_pct, wind_speed_ms: null });
      }
    }
    return { data: rows, meta: meta() };
  },

  async forecastPeriods(locationId: string) {
    const all = await file<Record<string, PeriodRow[]>>("periods.json");
    return { data: all[locationId] ?? [], meta: meta() };
  },

  async alerts(state?: string) {
    const all = await file<AlertRow[]>("alerts.json");
    return { data: state ? all.filter((a) => a.states.includes(state)) : all, meta: meta() };
  },

  /** Pre-computed for the preset ranges and their comparisons; other ranges have no accuracy in the demo. */
  async accuracy(p: { from: string; to: string; location?: string }) {
    const table = await file<Record<string, AccuracyRow[]>>("accuracy.json");
    return { data: table[`${p.location ?? ""}|${p.from}|${p.to}`] ?? [], meta: meta(p) };
  },
};
