// Forecast replay ("what each model predicted 1–7 days before"): live from the browser, straight from Open-Meteo.
// For one city and one past local day: the Previous Runs API gives each model's hourly forecast made 1–7 days earlier
// (temperature_2m_previous_dayN), the archive API gives the observed hours; both reduce to the local day's high.
// No dependency on the local stack, ClickHouse or AWS. Temperatures are °C here; display units are converted later.
//
// Open-Meteo facts this relies on (real requests, 2026-10-05; docs/analysis/forecast-replay.md):
// - CORS: both APIs answer `access-control-allow-origin: *`.
// - With `timezone=<IANA>` Open-Meteo applies ONE fixed offset (today's) to the whole response, so a winter day in
//   Los Angeles would be cut at 01:00. We ask for GMT and pick the local day's hours ourselves (Intl, DST-exact).
// - Lead days with data: ECMWF, GFS, best match 1–7; ICON 1–6; HRRR 1 only. ECMWF starts mid-Feb 2024.
// - The archive returns model-filled values for the last days, so only days ≥ REPLAY_LAG_DAYS old are offered.
import { z } from "zod";
import { CITIES } from "@cities";
import { MODEL_BY_ID } from "@/lib/models";
import { dayMs, toDay } from "@/lib/dates";
import { deltaToUnit, fmt, toUnit, type TempUnit } from "@/lib/units";

export const PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast";
export const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
export const REPLAY_TIMEOUT_MS = 4000;
export const FIRST_REPLAY_DAY = "2024-03-01";   // every model has previous runs from here on (ECMWF from ~2024-02-15)
export const REPLAY_LAG_DAYS = 7;                // archive values younger than ~5 days are model-filled, not observed
export const LEAD_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
/** Models requested, in the dashboard's order. NWS isn't in Open-Meteo, so it has no replay. */
export const REPLAY_MODEL_IDS = ["ecmwf_ifs025", "gfs_global", "icon_global", "gfs_hrrr", "best_match"] as const;
const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ReplayCity = { id: string; name: string; state: string; lat: number; lon: number; timezone: string };
// cities.js is plain JS (rows typed loosely by inference); each row has exactly these fields.
const CITY_BY_ID = new Map((CITIES as unknown as ReplayCity[]).map((c) => [c.id, c]));
/** One of the 53 tracked cities, or null (a Map lookup: ids like "__proto__" find nothing). */
export const replayCity = (id: string) => CITY_BY_ID.get(id) ?? null;

/** Days that can be replayed: from FIRST_REPLAY_DAY to today (UTC) − REPLAY_LAG_DAYS. */
export function replayRange(now: number) {
  return { from: FIRST_REPLAY_DAY, to: toDay(now - REPLAY_LAG_DAYS * DAY_MS) };
}

/** A real calendar day (rejects 2026-02-30, which Date.parse would roll over). */
const isCalendarDay = (day: string) => DAY_RE.test(day) && toDay(dayMs(day)) === day;

export class ReplayError extends Error {
  readonly kind: "invalid" | "unavailable";
  constructor(kind: "invalid" | "unavailable", message: string) { super(message); this.kind = kind; this.name = "ReplayError"; }
}

/** The city, or a ReplayError("invalid") for an unknown city or a day outside replayRange(now). */
export function checkReplayInput(cityId: string, day: string, now: number): ReplayCity {
  const city = replayCity(cityId);
  if (!city) throw new ReplayError("invalid", "Unknown city.");
  const { from, to } = replayRange(now);
  if (!isCalendarDay(day) || day < from || day > to) throw new ReplayError("invalid", `Pick a day between ${from} and ${to}.`);
  return city;
}

// Both requests cover the UTC days around the local day (US zones are UTC−4…−10, so the local day always fits).
const utcWindow = (day: string) => ({ start_date: toDay(dayMs(day) - DAY_MS), end_date: toDay(dayMs(day) + DAY_MS) });

export function previousRunsUrl(city: ReplayCity, day: string) {
  const params = new URLSearchParams({
    latitude: String(city.lat), longitude: String(city.lon),
    hourly: LEAD_DAYS.map((n) => `temperature_2m_previous_day${n}`).join(","),
    models: REPLAY_MODEL_IDS.join(","),
    timezone: "GMT", ...utcWindow(day),
  });
  return `${PREVIOUS_RUNS_URL}?${params}`;
}

export function archiveUrl(city: ReplayCity, day: string) {
  const params = new URLSearchParams({
    latitude: String(city.lat), longitude: String(city.lon), hourly: "temperature_2m", timezone: "GMT", ...utcWindow(day),
  });
  return `${ARCHIVE_URL}?${params}`;
}

const hourlySchema = z.object({
  hourly: z.object({ time: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)).max(24 * 4) })
    .catchall(z.array(z.number().nullable()).max(24 * 4)),   // 3 UTC days = 72 hours; anything bigger is refused
});
type Hourly = z.infer<typeof hourlySchema>["hourly"];

const dayFormat = new Map<string, Intl.DateTimeFormat>();
/** Local calendar day ("YYYY-MM-DD") of a UTC hour stamp in an IANA zone. */
function localDay(utc: string, timeZone: string) {
  let f = dayFormat.get(timeZone);
  if (!f) dayFormat.set(timeZone, (f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })));
  return f.format(new Date(`${utc}:00Z`));
}

/** Indexes of the hours inside the local day (23, 24 or 25 of them across DST changes). */
export function localDayHours(times: string[], timeZone: string, day: string) {
  return times.flatMap((t, i) => (localDay(t, timeZone) === day ? [i] : []));
}

/** The day's high, or null unless every local hour has a value (a partial day would understate the high). */
export function localHigh(values: (number | null)[] | undefined, hours: number[]) {
  if (!values || hours.length < 23) return null;
  let high = -Infinity;
  for (const i of hours) {
    const v = values[i];
    if (v == null || !Number.isFinite(v)) return null;
    high = Math.max(high, v);
  }
  return high;
}

export type ReplayModel = { id: string; name: string; leads: { lead: number; high: number }[] };
export type ReplayResult = {
  city: string; day: string;
  observed: number;            // observed local-day high, °C
  models: ReplayModel[];       // only models with data; leads sorted 7 → 1 (earliest forecast first)
  missing: string[];           // requested models that returned nothing for this day
};

/** Pure: two Open-Meteo responses → the result. Exported for the tests and the sample generator. */
export function buildReplay(city: ReplayCity, day: string, previous: Hourly, archive: Hourly): ReplayResult {
  const obsHours = localDayHours(archive.time, city.timezone, day);
  const observed = localHigh(archive.temperature_2m, obsHours);
  if (observed == null) throw new ReplayError("unavailable", "No complete observations for this day.");
  const hours = localDayHours(previous.time, city.timezone, day);
  const models: ReplayModel[] = [];
  const missing: string[] = [];
  for (const id of REPLAY_MODEL_IDS) {
    const leads = [...LEAD_DAYS].reverse().flatMap((lead) => {
      const high = localHigh(previous[`temperature_2m_previous_day${lead}_${id}`], hours);
      return high == null ? [] : [{ lead, high }];
    });
    if (leads.length) models.push({ id, name: MODEL_BY_ID.get(id)?.name ?? id, leads });
    else missing.push(id);
  }
  if (!models.length) throw new ReplayError("unavailable", "No model forecasts for this day.");
  return { city: city.id, day, observed, models, missing };
}

async function getHourly(url: string, signal: AbortSignal, fetchFn: typeof fetch): Promise<Hourly> {
  const res = await fetchFn(url, { signal, headers: { Accept: "application/json" }, credentials: "omit", referrerPolicy: "no-referrer" });
  if (!res.ok) throw new ReplayError("unavailable", `Open-Meteo answered ${res.status}.`);
  const parsed = hourlySchema.safeParse(await res.json());
  if (!parsed.success) throw new ReplayError("unavailable", "Unexpected answer from Open-Meteo.");
  return parsed.data.hourly;
}

export type FetchReplayOptions = { now: number; fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number };

/**
 * Two HTTP requests (Previous Runs + archive, in parallel), both aborted after timeoutMs. Throws ReplayError:
 * "invalid" before any request for bad input, "unavailable" for network errors, timeouts, HTTP errors or bad data.
 */
export async function fetchReplay(cityId: string, day: string, opts: FetchReplayOptions): Promise<ReplayResult> {
  const city = checkReplayInput(cityId, day, opts.now);
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, opts.timeoutMs ?? REPLAY_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [previous, archive] = await Promise.all([
      getHourly(previousRunsUrl(city, day), ctrl.signal, fetchFn),
      getHourly(archiveUrl(city, day), ctrl.signal, fetchFn),
    ]);
    return buildReplay(city, day, previous, archive);
  } catch (e) {
    if (e instanceof ReplayError) throw e;
    throw new ReplayError("unavailable", timedOut ? "Open-Meteo took too long to answer." : "Open-Meteo can't be reached.");
  } finally {
    clearTimeout(timer);
    ctrl.abort();   // one request failed: cancel the other
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

// ---- Bundled sample (fallback when the live call fails) --------------------------------------------------------------
export const SAMPLE_URL = "/data/replay-sample.json";
const resultSchema = z.object({
  city: z.string(), day: z.string().regex(DAY_RE), observed: z.number(),
  // Only the requested models: an unknown id anywhere (also in missing) makes the whole sample invalid.
  models: z.array(z.object({ id: z.enum(REPLAY_MODEL_IDS), name: z.string(), leads: z.array(z.object({ lead: z.number().int().min(1).max(7), high: z.number() })) })),
  missing: z.array(z.enum(REPLAY_MODEL_IDS)),
});
const sampleSchema = z.object({ format: z.literal(1), generated_at: z.string(), results: z.array(resultSchema).max(20) });

/** The bundled sample replays (made by scripts/buildReplaySample.mjs with fetchReplay), or [] if missing/invalid. */
export async function loadReplaySample(fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<ReplayResult[]> {
  try {
    const res = await fetchFn(SAMPLE_URL, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const parsed = sampleSchema.safeParse(await res.json());
    return parsed.success ? parsed.data.results.filter((r) => replayCity(r.city)) : [];
  } catch { return []; }
}

/** The sample to show: the same city if bundled, else the first one. */
export const pickSample = (samples: ReplayResult[], cityId: string) => samples.find((s) => s.city === cityId) ?? samples[0] ?? null;

// ---- Display helpers ----------------------------------------------------------------------------------------------------
/** One model's series for the chart, display units, earliest lead first. */
export type ReplaySeries = { id: string; name: string; color: string; points: { lead: number; v: number }[] };

export function replaySeries(r: ReplayResult, unit: TempUnit): ReplaySeries[] {
  return r.models.map((m) => ({
    id: m.id, name: m.name, color: MODEL_BY_ID.get(m.id)?.color ?? "var(--muted-foreground)",
    points: m.leads.map(({ lead, high }) => ({ lead, v: toUnit(high, unit) as number })),
  }));
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven"];
export const daysAhead = (lead: number) => `${WORDS[lead] ?? lead} day${lead === 1 ? "" : "s"} ahead`;

/**
 * One plain sentence from the data, e.g. "ECMWF was off by 3.1°F five days ahead and by 0.4°F one day ahead."
 * Leads with ECMWF when present (else the model with the longest range), then names the closest one-day forecast.
 */
export function replayInsight(r: ReplayResult, unit: TempUnit): string | null {
  if (!r.models.length) return null;
  const off = (c: number) => `${fmt(deltaToUnit(Math.abs(c - r.observed), unit))}°${unit}`;
  const main = r.models.find((m) => m.id === "ecmwf_ifs025") ?? [...r.models].sort((a, b) => b.leads[0].lead - a.leads[0].lead)[0];
  const [first, last] = [main.leads[0], main.leads.at(-1)!];
  let text = first === last
    ? `${main.name} was off by ${off(first.high)} ${daysAhead(first.lead)}.`
    : `${main.name} was off by ${off(first.high)} ${daysAhead(first.lead)} and by ${off(last.high)} ${daysAhead(last.lead)}.`;
  const oneDay = r.models.flatMap((m) => m.leads.filter((l) => l.lead === 1).map((l) => ({ name: m.name, err: Math.abs(l.high - r.observed), high: l.high })))
    .sort((a, b) => a.err - b.err);
  if (oneDay.length > 1) text += ` Closest one day ahead: ${oneDay[0].name} (${off(oneDay[0].high)} off).`;
  return text;
}

/** "Sun, Sep 20, 2026" for a day key. */
export const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Days of a month ("2026", "09") that can be replayed, oldest first. */
export function replayDaysInMonth(year: string, month: string, now: number) {
  const { from, to } = replayRange(now);
  const days: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const day = `${year}-${month}-${String(d).padStart(2, "0")}`;
    if (isCalendarDay(day) && day >= from && day <= to) days.push(day);
  }
  return days;
}
