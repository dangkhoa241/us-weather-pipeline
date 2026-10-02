// Snapshot data source for the static demo (VITE_DATA_MODE=snapshot): same interface as the live API client,
// but reads the JSON files written by `npm run export:snapshot` (public/data/). Stats, periods, comparisons and
// the state map are computed here from daily values with the same rules as the API; forecast accuracy is
// pre-computed for the preset ranges and their comparisons.
// Live data (Stage 6a part 4): when the build sets VITE_LIVE_DATA_URL (CloudFront), recent history, forecasts and alerts
// are fetched from there first; any live file that fails, times out or doesn't validate falls back to the bundled one.
import { z } from "zod";
import type { AccuracyMonthRow, AccuracyRow, AccuracyStateRow, AlertRow, AreaParams, MissRow, ForecastRow, LocationRow, MapRow, PeriodRow, StatsResponse, StatsRow } from "@/lib/api";
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
  // `cities` only in daily-all.json (US-wide averages, the "All US" location)
  temp: { min: (number | null)[]; max: (number | null)[]; avg: (number | null)[]; n: (number | null)[]; cities?: (number | null)[] };
  precip: { sum: (number | null)[]; n: (number | null)[]; cities?: (number | null)[] };
};

let manifest: SnapshotManifest | null = null;
const files = new Map<string, Promise<unknown>>();

// ---- Live files (CloudFront) --------------------------------------------------------------------------------------
const LIVE_URL: string = import.meta.env.VITE_LIVE_DATA_URL ?? "";
const LIVE_TIMEOUT_MS = 4000;
const LIVE_FORMAT = 1;
const DAY_MS = 86_400_000;
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const col = z.array(z.number().nullable());
const recentSchema = z.object({
  format: z.literal(LIVE_FORMAT), generated_at: z.string(), data_as_of: isoDay, from: isoDay, days: z.number().int().min(1).max(400),
  cities: z.record(z.string(), z.object({ temp: z.object({ min: col, max: col, avg: col, n: col }), precip: z.object({ sum: col, n: col }) })),
  all: z.object({ temp: z.object({ min: col, max: col, avg: col, n: col, cities: col }), precip: z.object({ sum: col, n: col, cities: col }) }),
});
const forecastsSchema = z.object({
  format: z.literal(LIVE_FORMAT), generated_at: z.string(), forecasts: z.record(z.string(), z.unknown()), periods: z.record(z.string(), z.unknown()),
});
const alertsSchema = z.object({ format: z.literal(LIVE_FORMAT), generated_at: z.string(), alerts: z.array(z.unknown()) });
type Recent = z.infer<typeof recentSchema>;
type RecentColumns = Pick<Daily, "temp" | "precip">;

/** Where the history shown comes from: CloudFront ("live") or the files bundled with the build ("snapshot"). */
export type DataSource = { kind: "live" | "snapshot"; data_as_of: string; generated_at: string };
let source: DataSource | null = null;
let recent: Recent | null = null;
let shift = 0;   // days the live history runs past the bundled snapshot (accuracy stays as bundled)
const liveTimes = new Map<"forecasts" | "alerts", string>();
let liveForecasts: Promise<z.infer<typeof forecastsSchema> | null> | null = null;

/** A live file, or null if none is configured or it fails, takes longer than LIVE_TIMEOUT_MS or doesn't validate. */
async function fetchLive<S extends z.ZodType>(name: string, schema: S): Promise<z.infer<S> | null> {
  if (!LIVE_URL) return null;
  try {
    const res = await fetch(`${LIVE_URL}/${name}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const parsed = schema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type Columns = Record<string, (number | null)[] | undefined>;

/** Lay recent live days over a bundled daily file: live wins on days it has data for; the window grows to its end. */
export function withRecent(d: Daily, r: RecentColumns | undefined, rFrom: string, rDays: number): Daily {
  if (!r) return d;
  const offset = Math.round((dayMs(rFrom) - dayMs(d.from)) / DAY_MS);
  const days = Math.max(d.days, offset + rDays);
  const grow = (cols: Columns) =>
    Object.fromEntries(Object.entries(cols).map(([k, a]) => [k, a && [...a, ...new Array<null>(Math.max(0, days - a.length)).fill(null)]]));
  const out = { ...d, days, temp: grow(d.temp), precip: grow(d.precip) } as Daily;
  for (let j = 0; j < rDays; j += 1) {
    const i = offset + j;
    if (i < 0) continue;
    for (const group of ["temp", "precip"] as const) {
      const live = r[group] as Columns;
      if (live.n?.[j] == null) continue;   // no live value that day: keep the bundled one
      for (const [k, a] of Object.entries(out[group] as Columns)) if (a) a[i] = live[k]?.[j] ?? null;
    }
  }
  return out;
}

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
  recent = await fetchLive("recent.json", recentSchema);
  const end = recent && recent.data_as_of > manifest.data_as_of ? recent.data_as_of : manifest.data_as_of;
  shift = Math.round((dayMs(end) - dayMs(manifest.data_as_of)) / DAY_MS);
  source = recent
    ? { kind: "live", data_as_of: end, generated_at: recent.generated_at }
    : { kind: "snapshot", data_as_of: manifest.data_as_of, generated_at: manifest.generated_at };
  setDataEnd(end);
  return manifest;
}

export const snapshotManifest = () => manifest;
export const dataSource = () => source;
/** When the live forecasts / alerts shown were published, or null while the bundled file is shown. */
export const liveTime = (kind: "forecasts" | "alerts") => liveTimes.get(kind) ?? null;

async function load(name: string): Promise<unknown> {
  if (name === "forecasts.json" || name === "periods.json") {
    liveForecasts ??= fetchLive("forecasts.json", forecastsSchema);
    const live = await liveForecasts;
    if (live) {
      liveTimes.set("forecasts", live.generated_at);
      return name === "forecasts.json" ? live.forecasts : live.periods;
    }
  }
  if (name === "alerts.json") {
    const live = await fetchLive("alerts.json", alertsSchema);
    if (live) {
      liveTimes.set("alerts", live.generated_at);
      return live.alerts;
    }
  }
  const data = await fetchJson(`/data/${manifest!.snapshot}/${name}`);
  const city = /^daily-(.+)\.json$/.exec(name)?.[1];
  if (!city || !recent) return data;
  return withRecent(data as Daily, city === "all" ? recent.all : recent.cities[city], recent.from, recent.days);
}

function file<T>(name: string): Promise<T> {
  if (!manifest) throw new Error("Demo data not loaded");
  if (!/^[a-z0-9.-]+\.json$/.test(name)) throw new Error("Invalid data file");
  if (!files.has(name)) files.set(name, load(name));
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
      rows.push({ location_id: d.location_id, period_start: day, min: null, max: null, avg: null, sum: d.precip.sum[i], n_values: n, n_hours: n,
        ...(d.precip.cities ? { cities: d.precip.cities[i] ?? 0 } : {}) });
    } else {
      const n = d.temp.n[i];
      if (n == null) continue;
      rows.push({ location_id: d.location_id, period_start: day, min: d.temp.min[i], max: d.temp.max[i], avg: d.temp.avg[i], sum: null, n_values: n, n_hours: n,
        ...(d.temp.cities ? { cities: d.temp.cities[i] ?? 0 } : {}) });
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
      ...(g.some((r) => r.cities != null) ? { cities: Math.max(...g.map((r) => r.cities ?? 0)) } : {}),
    };
  }).sort((a, b) => (a.location_id + a.period_start).localeCompare(b.location_id + b.period_start));
}

async function statsFor(ids: string[], metric: string, period: string, from: string, to: string) {
  const all = await Promise.all(ids.map((id) => file<Daily>(`daily-${id}.json`).then((d) => dailyRows(d, metric, from, to))));
  return aggregate(all.flat(), period);
}

type AccuracyDetails = {
  range: { from: string; to: string };
  states: Record<number, AccuracyStateRow[]>;
  months: Record<number, AccuracyMonthRow[]>;
  misses: Record<number, MissRow[]>;
};
// Accuracy is computed locally and only bundled. With live history the presets end `shift` days later, so a range is
// also looked up `shift` days earlier: "last 90 days" shows the bundled "last 90 days" (the page says "as of").
type Range = { from: string; to: string };
const back = (r: Range, days = shift): Range => ({ from: toDay(dayMs(r.from) - days * DAY_MS), to: toDay(dayMs(r.to) - days * DAY_MS) });
const sameRange = (a: Range, b: Range) => a.from === b.from && a.to === b.to;
const rangeMatch = (d: AccuracyDetails, p: Range) => sameRange(d.range, p) || sameRange(d.range, back(p));
const detailsMatch = (d: AccuracyDetails, p: AreaParams) => !p.location && !p.state && rangeMatch(d, p);

/** In the demo, accuracy details exist for this range only (the dashboard says so for other choices). */
export async function snapshotAccuracyRange() {
  return back((await file<AccuracyDetails>("accuracy-details.json")).range, -shift);
}

/** Last day of the bundled snapshot: forecast accuracy is "as of" this day even when history is live. */
export const accuracyAsOf = () => manifest?.data_as_of ?? null;

// ---- API-compatible client ------------------------------------------------------------------------------------
const meta = (range?: { from: string; to: string }) => ({ source: source?.kind ?? "snapshot", data_version: manifest?.snapshot ?? null, ...(range ? { range } : {}) });

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

  /** Pre-computed for the preset ranges and their comparisons (all US or one city); states are not in the demo. */
  async accuracy(p: AreaParams) {
    const table = await file<Record<string, AccuracyRow[]>>("accuracy.json");
    const key = (r: Range) => `${p.location ?? ""}|${r.from}|${r.to}`;
    return { data: p.state ? [] : table[key(p)] ?? table[key(back(p))] ?? [], meta: meta(p) };
  },

  // Accuracy details are exported for all US over the default range only (keeps the snapshot small).
  async accuracyStates(p: { from: string; to: string; lead: number }) {
    const d = await file<AccuracyDetails>("accuracy-details.json");
    return { data: (rangeMatch(d, p) ? d.states[p.lead] : null) ?? [], meta: meta(p) };
  },

  async accuracyMonths(p: AreaParams & { lead: number }) {
    const d = await file<AccuracyDetails>("accuracy-details.json");
    return { data: (detailsMatch(d, p) ? d.months[p.lead] : null) ?? [], meta: meta(p) };
  },

  async accuracyMisses(p: AreaParams & { lead: number; limit?: number }) {
    const d = await file<AccuracyDetails>("accuracy-details.json");
    return { data: ((detailsMatch(d, p) ? d.misses[p.lead] : null) ?? []).slice(0, p.limit ?? 10), meta: meta(p) };
  },
};
