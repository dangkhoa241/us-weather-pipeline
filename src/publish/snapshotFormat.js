// src/publish/snapshotFormat.js
// The dashboard snapshot's file format, shared by the local export (scripts/exportSnapshot.js, from the API) and the
// dashboard publisher Lambda (src/lambda/dashboardPublisher.js, from Open-Meteo + Atlas). Pure functions, no I/O.

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const dayMs = (day) => Date.parse(`${day}T00:00:00Z`);
export const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const round3 = (v) => Math.round(v * 1000) / 1000;

// Models the Forecast page shows (legacy and baseline forecasts are not exported).
export const FORECAST_MODELS = ["nws", "ecmwf_ifs025", "gfs_global", "icon_global", "gfs_hrrr"];

// Nothing internal may end up in a public snapshot.
export const FORBIDDEN = /localhost|127\.0\.0\.1|mongodb|clickhouse|redis:|:\/\/[^"]*@|password|etl_batch_id|stage2-|atlas/i;

/** Serialize a public file; throws if it contains anything internal. */
export function publicJson(name, data) {
  const text = JSON.stringify(data);
  if (FORBIDDEN.test(text)) throw new Error(`${name} contains a forbidden value (${text.match(FORBIDDEN)[0]}); not writing it`);
  return text;
}

/** Date → "YYYY-MM-DD HH:MM:SS" (UTC), the API's (ClickHouse) time format. */
export const apiTime = (date) => (date == null ? null : new Date(date).toISOString().slice(0, 19).replace("T", " "));

/** Daily rows → column arrays aligned to the window (null where a day is missing). */
export function columns(rows, from, days, fields) {
  const out = Object.fromEntries(fields.map((f) => [f, new Array(days).fill(null)]));
  for (const r of rows) {
    const i = Math.round((dayMs(r.period_start) - dayMs(from)) / DAY_MS);
    if (i >= 0 && i < days) for (const f of fields) out[f][i] = f === "n" ? r.n_values : f === "cities" ? r.cities : round1(r[f]);
  }
  return out;
}

/**
 * Hourly values in LOCAL time (Open-Meteo `timezone=<city tz>`) → one stats row per local day, like the API's
 * /stats?period=day: min/max/avg/sum over the day's non-null hours, n_values = those hours, n_hours = all hours.
 * Days without any value get no row (nulls stay null).
 */
export function dailyStats(locationId, times, values) {
  const days = new Map();
  times.forEach((t, i) => {
    const day = t.slice(0, 10);
    const d = days.get(day) ?? { vals: [], hours: 0 };
    d.hours += 1;
    if (values[i] != null) d.vals.push(values[i]);
    days.set(day, d);
  });
  const rows = [];
  for (const [day, { vals, hours }] of days) {
    if (!vals.length) continue;
    const sum = vals.reduce((a, v) => a + v, 0);
    rows.push({ location_id: locationId, period_start: day, min: Math.min(...vals), max: Math.max(...vals),
      avg: round3(sum / vals.length), sum: round3(sum), n_values: vals.length, n_hours: hours });
  }
  return rows;
}

/**
 * Forecast rows (API shape: model, issued_at, target_time, temp_c, precip_mm, precip_prob_pct) → per model
 * { issued_at, start, hours: [hours after start, temp_c, precip_mm, precip_prob_pct][] } (forecasts.json).
 */
export function compactForecast(rows) {
  const byModel = {};
  for (const r of rows.filter((x) => FORECAST_MODELS.includes(x.model))) {
    const m = (byModel[r.model] ??= { issued_at: r.issued_at, start: r.target_time, hours: [] });
    const h = Math.round((Date.parse(`${r.target_time.replace(" ", "T")}Z`) - Date.parse(`${m.start.replace(" ", "T")}Z`)) / HOUR_MS);
    m.hours.push([h, round1(r.temp_c), round1(r.precip_mm), r.precip_prob_pct]);
  }
  return byModel;
}
