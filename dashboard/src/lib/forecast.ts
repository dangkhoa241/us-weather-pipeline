// Forecast page helpers: UTC → city-local time, NWS day/night periods → daily cards, the next 48 hours,
// and each model's daily high. Everything is anchored on the forecast's own times (not the clock), so the frozen
// demo snapshot works the same as live data.
import type { ChartPoint } from "@/components/chart/types";

/** "2026-10-01 20:00:00" (UTC from the API) → Date. */
export const utc = (s: string) => new Date(`${s.replace(" ", "T")}Z`);

const partsCache = new Map<string, Intl.DateTimeFormat>();
/** Local date ("YYYY-MM-DD"), hour (0–23) and weekday ("Thu") of a UTC time in a city's time zone. */
export function local(s: string, tz: string) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", weekday: "short", hourCycle: "h23" });
    partsCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(utc(s)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: p.weekday };
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export type Period = { target_time: string; temp_c: number | null; precip_prob_pct: number | null; short_forecast: string | null };
export type DayCard = { date: string; weekday: string; high: number | null; low: number | null; rainChance: number | null; text: string; night: boolean };

/** NWS day/night periods → one card per local date: day period = high, the night that starts that date = low. */
export function dailyCards(periods: Period[], tz: string, count = 7): DayCard[] {
  const byDate = new Map<string, DayCard>();
  for (const p of periods) {
    const { date, hour, weekday } = local(p.target_time, tz);
    const isNight = hour >= 18 || hour < 6;
    const c = byDate.get(date) ?? { date, weekday, high: null, low: null, rainChance: null, text: "", night: true };
    if (isNight) c.low = p.temp_c;
    else { c.high = p.temp_c; c.night = false; }
    if (p.precip_prob_pct != null) c.rainChance = Math.max(c.rainChance ?? 0, p.precip_prob_pct);
    if (!isNight || !c.text) c.text = p.short_forecast ?? c.text;
    byDate.set(date, c);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(0, count);
}

export type Condition = "storm" | "snow" | "rain" | "fog" | "cloud" | "partly" | "clear";
/** Simple condition class from the forecaster's text, for the icon. */
export function conditionOf(text: string): Condition {
  const t = text.toLowerCase();
  if (/thunder|t-storm/.test(t)) return "storm";
  if (/snow|sleet|flurr|ice|wintry/.test(t)) return "snow";
  if (/rain|shower|drizzle/.test(t)) return "rain";
  if (/fog|haze|smoke|dust/.test(t)) return "fog";
  if (/partly|mostly sunny|mostly clear/.test(t)) return "partly";
  if (/cloud|overcast/.test(t)) return "cloud";
  return "clear";
}

export type HourlyRow = { model: string; target_time: string; temp_c: number | null; precip_mm: number | null; precip_prob_pct: number | null };

/** The first 48 hourly NWS values: temperature points and rain-chance points (rain chance in `sum`). */
export function next48(rows: HourlyRow[], tz: string): { temp: ChartPoint[]; rain: ChartPoint[] } {
  const nws = rows.filter((r) => r.model === "nws").sort((a, b) => a.target_time.localeCompare(b.target_time)).slice(0, 48);
  const label = (s: string) => {
    const { hour, weekday } = local(s, tz);
    return hour === 0 ? weekday : `${hour % 12 || 12}${hour < 12 ? "a" : "p"}`;
  };
  const point = (r: HourlyRow, avg: number | null, sum: number | null): ChartPoint => ({ key: r.target_time, label: label(r.target_time), min: null, max: null, avg, sum });
  return { temp: nws.map((r) => point(r, r.temp_c, null)), rain: nws.map((r) => point(r, null, r.precip_prob_pct)) };
}

/**
 * Daily high per model for `days` local days starting the day after the forecast starts. A day needs at least
 * `minHours` hourly values for a model, otherwise it is a gap (a partial day would understate the high).
 */
export function modelDailyHighs(rows: HourlyRow[], tz: string, models: string[], days = 7, minHours = 18) {
  if (!rows.length) return { dates: [] as string[], series: {} as Record<string, (number | null)[]> };
  const first = rows.reduce((a, r) => (r.target_time < a ? r.target_time : a), rows[0].target_time);
  const start = addDays(local(first, tz).date, 1);
  const dates = Array.from({ length: days }, (_, i) => addDays(start, i));
  const series: Record<string, (number | null)[]> = {};
  for (const m of models) {
    const byDate = new Map<string, number[]>();
    for (const r of rows) {
      if (r.model !== m || r.temp_c == null) continue;
      const d = local(r.target_time, tz).date;
      byDate.set(d, [...(byDate.get(d) ?? []), r.temp_c]);
    }
    series[m] = dates.map((d) => { const v = byDate.get(d); return v && v.length >= minHours ? Math.max(...v) : null; });
  }
  // Drop trailing days no model covers (the forecast horizon ends mid-day).
  let n = dates.length;
  while (n > 0 && models.every((m) => series[m][n - 1] == null)) n -= 1;
  return { dates: dates.slice(0, n), series: Object.fromEntries(models.map((m) => [m, series[m].slice(0, n)])) };
}

const SEVERITY_RANK: Record<string, number> = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };

/** NWS re-issues alerts (updates have new ids): keep one per event + area + times, most severe first, then soonest end. */
export function dedupeAlerts<A extends { event: string; area_desc: string | null; onset: string | null; ends: string | null; expires: string | null; severity: string | null }>(alerts: A[]): A[] {
  const seen = new Map<string, A>();
  for (const a of alerts) {
    const key = [a.event, a.area_desc, a.onset, a.ends ?? a.expires].join("|");
    if (!seen.has(key)) seen.set(key, a);
  }
  return [...seen.values()].sort((a, b) =>
    (SEVERITY_RANK[a.severity ?? ""] ?? 9) - (SEVERITY_RANK[b.severity ?? ""] ?? 9) || (a.ends ?? a.expires ?? "").localeCompare(b.ends ?? b.expires ?? ""));
}
