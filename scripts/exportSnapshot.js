// scripts/exportSnapshot.js
// Export a static data snapshot for the dashboard's demo deployment (Vercel, no backend in the cloud).
// Calls the local API (npm start must be running) for everything the dashboard needs and writes compact,
// versioned JSON into dashboard/public/data/<snapshot>/ plus dashboard/public/data/manifest.json.
// Usage: npm start (in another terminal), then npm run export:snapshot

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { config } from "../src/config.js";
import { DAY_MS, FORECAST_MODELS, columns, compactForecast, dayMs, historyProblems, publicJson, toDay } from "../src/publish/snapshotFormat.js";

const API = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}/api/v1`;
const OUT = new URL("../dashboard/public/data/", import.meta.url);
const FORMAT = 1;                 // bump when the file layout changes (the dashboard checks it)
const MIN_WINDOW_DAYS = 731;      // at least 2 years: "last 12 months" compared with the same period last year
const MAX_RANGE_DAYS = 4000;      // the API's longest range; used to find the earliest year with data
const PRESET_DAYS = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 };
const MAX_TOTAL_KB = 5 * 1024;    // fail if the snapshot gets big (Vercel serves it as static files)
// Accuracy rows only for the models the dashboard shows (legacy gfs_seamless / icon_seamless snapshots are left out).
const ACCURACY_MODELS = new Set([...FORECAST_MODELS, "best_match"]);
const known = (rows) => rows.filter((r) => ACCURACY_MODELS.has(r.model));
const MIN_DAYS = 30;              // same as MIN_DAYS in dashboard/src/lib/accuracy.ts: fewer days → head-to-head note

let calls = 0;
async function get(path, params = {}) {
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const res = await fetch(url);
    calls += 1;
    if (res.status === 429) {   // respect the API's rate limit
      const wait = Number(res.headers.get("retry-after") ?? 5);
      process.stdout.write(`  rate limited, waiting ${wait}s\n`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    const body = await res.json();
    if (!res.ok) throw new Error(`${path} → ${res.status}: ${body?.error?.message ?? "error"}`);
    return body;
  }
  throw new Error(`${path}: still rate limited`);
}

// Same ranges as the dashboard's presets and comparisons (dashboard/src/lib/dates.ts).
function presetRanges(dataEnd) {
  const ranges = Object.fromEntries(Object.entries(PRESET_DAYS).map(([k, n]) => [k, { from: toDay(dayMs(dataEnd) - (n - 1) * DAY_MS), to: dataEnd }]));
  ranges.ytd = { from: `${dataEnd.slice(0, 4)}-01-01`, to: dataEnd };
  return ranges;
}
function compareRanges({ from, to }) {
  const back = (d) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`.replace(/-02-29$/, "-02-28");
  const days = (dayMs(to) - dayMs(from)) / DAY_MS + 1;
  return [
    { from: toDay(dayMs(from) - days * DAY_MS), to: toDay(dayMs(from) - DAY_MS) },
    { from: back(from), to: back(to) },
  ];
}

const files = {};
function write(dir, name, data) {
  const text = publicJson(name, data);   // throws on anything internal (hostnames, connection strings, run ids)
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL(name, dir), text);
  files[name] = { bytes: text.length, gzip_bytes: gzipSync(text).length, sha256: createHash("sha256").update(text).digest("hex").slice(0, 16) };
}

const t0 = Date.now();
const locations = (await get("/locations")).data;
// The API's default range ends at the latest complete observation day; use it as "data as of".
const dataEnd = (await get("/map")).meta.range.to;
// The window starts on Jan 1 of the earliest year any city has data for, so the drill-down covers every year
// (monthly values are derived from the daily columns in the dashboard). One period=year call per city.
// A year needs at least one full day of hours: history fetched from Jan 1 UTC starts on Dec 31 in US local time.
const searchFrom = toDay(dayMs(dataEnd) - (MAX_RANGE_DAYS - 1) * DAY_MS);
let firstYear = dataEnd.slice(0, 4);
for (const loc of locations) {
  const years = (await get("/stats", { locations: loc.id, metric: "temp_c", period: "year", from: searchFrom, to: dataEnd })).data;
  for (const r of years) if (r.n_values >= 24 && r.period_start.slice(0, 4) < firstYear) firstYear = r.period_start.slice(0, 4);
}
const minFrom = toDay(dayMs(dataEnd) - (MIN_WINDOW_DAYS - 1) * DAY_MS);
const windowFrom = `${firstYear}-01-01` < minFrom ? `${firstYear}-01-01` : minFrom;
const WINDOW_DAYS = (dayMs(dataEnd) - dayMs(windowFrom)) / DAY_MS + 1;
const snapshotId = `snapshot-${dataEnd}`;
const dir = new URL(`${snapshotId}/`, OUT);
console.log(`[snapshot] ${locations.length} locations, data ${windowFrom} .. ${dataEnd}`);

// Daily temperature and precipitation per location; the dashboard derives periods, comparisons and the map.
const dailies = {};
for (const loc of locations) {
  const base = { locations: loc.id, period: "day", from: windowFrom, to: dataEnd };
  const temp = (await get("/stats", { ...base, metric: "temp_c" })).data;
  const precip = (await get("/stats", { ...base, metric: "precip_mm" })).data;
  dailies[loc.id] = {
    location_id: loc.id, from: windowFrom, days: WINDOW_DAYS,
    temp: columns(temp, windowFrom, WINDOW_DAYS, ["min", "max", "avg", "n"]),
    precip: columns(precip, windowFrom, WINDOW_DAYS, ["sum", "n"]),
  };
}
// Data quality: refuse to replace the current snapshot when a city has no history or a gap (e.g. a backfill that
// stopped at the API budget and resumes on the next run).
const problems = historyProblems(locations, dailies);
if (problems.length) {
  throw new Error(`history incomplete for ${problems.length} of ${locations.length} cities; snapshot not written:\n  ${problems.join("\n  ")}`);
}

// Keep only the current snapshot: remove older snapshot folders, not the other files in public/data (e.g. the
// forecast replay sample, replay-sample.json).
mkdirSync(OUT, { recursive: true });
for (const name of readdirSync(OUT)) if (/^snapshot-\d{4}-\d{2}-\d{2}$/.test(name)) rmSync(new URL(`${name}/`, OUT), { recursive: true, force: true });
write(dir, "locations.json", locations);
for (const loc of locations) write(dir, `daily-${loc.id}.json`, dailies[loc.id]);

// US-wide daily values (average across cities, as /stats?locations=all), so the default "All US" view loads one file.
{
  const base = { locations: "all", period: "day", from: windowFrom, to: dataEnd };
  const temp = (await get("/stats", { ...base, metric: "temp_c" })).data;
  const precip = (await get("/stats", { ...base, metric: "precip_mm" })).data;
  write(dir, "daily-all.json", {
    location_id: "all", from: windowFrom, days: WINDOW_DAYS,
    temp: columns(temp, windowFrom, WINDOW_DAYS, ["min", "max", "avg", "n", "cities"]),
    precip: columns(precip, windowFrom, WINDOW_DAYS, ["sum", "n", "cities"]),
  });
}

// Forecast accuracy cannot be derived from daily data: pre-compute it for every preset range and its comparisons.
const ranges = Object.values(presetRanges(dataEnd)).flatMap((r) => [r, ...compareRanges(r)]);
const accuracy = {};
for (const location of ["", ...locations.map((l) => l.id)]) {
  for (const r of ranges) {
    const key = `${location}|${r.from}|${r.to}`;
    if (!(key in accuracy)) accuracy[key] = known((await get("/accuracy", { ...r, ...(location ? { location } : {}) })).data);
  }
}
write(dir, "accuracy.json", accuracy);

// Accuracy page details (map by state, bias by month, biggest misses) for all US over the dashboard's default range
// (last 90 days) and lead days 1–7 only: other areas/ranges would multiply the snapshot size.
const detailRange = presetRanges(dataEnd)["90d"];
const details = { range: detailRange, states: {}, months: {}, misses: {}, matched: {} };
for (let lead = 1; lead <= 7; lead += 1) {
  details.states[lead] = known((await get("/accuracy/states", { ...detailRange, lead })).data);
  details.months[lead] = known((await get("/accuracy/months", { ...detailRange, lead })).data);
  details.misses[lead] = known((await get("/accuracy/misses", { ...detailRange, lead, limit: 10 })).data);
}
// Head-to-head rows for models with a short history at a lead day (not ranked by the dashboard yet).
const summary90 = accuracy[`|${detailRange.from}|${detailRange.to}`] ?? [];
for (const r of summary90) {
  if (r.model === "best_match" || r.days >= MIN_DAYS || !r.n || r.lead_days < 1 || r.lead_days > 7) continue;
  (details.matched[r.model] ??= {})[r.lead_days] = known((await get("/accuracy/matched", { ...detailRange, lead: r.lead_days, model: r.model })).data);
}
write(dir, "accuracy-details.json", details);

// Latest forecast per model and location, as compact arrays: hours after `start` → [temp_c, precip_mm, precip_prob_pct].
const forecasts = {};
for (const loc of locations) {
  forecasts[loc.id] = compactForecast((await get(`/forecast/${loc.id}`, { days: 8 })).data);
}
write(dir, "forecasts.json", forecasts);

// NWS day/night periods per location (daily forecast cards) and the alerts active at export time.
const periods = {};
for (const loc of locations) periods[loc.id] = (await get(`/forecast/${loc.id}/periods`)).data;
write(dir, "periods.json", periods);
write(dir, "alerts.json", (await get("/alerts")).data);

const totalKb = Object.values(files).reduce((a, f) => a + f.bytes, 0) / 1024;
const gzipKb = Object.values(files).reduce((a, f) => a + f.gzip_bytes, 0) / 1024;
if (totalKb > MAX_TOTAL_KB) throw new Error(`snapshot is ${totalKb.toFixed(0)} KB, over the ${MAX_TOTAL_KB} KB budget`);
write(OUT, "manifest.json", {
  format: FORMAT,
  snapshot: snapshotId,
  data_as_of: dataEnd,
  window: { from: windowFrom, to: dataEnd },
  generated_at: new Date().toISOString(),
  files,
});
console.log(`[snapshot] ${Object.keys(files).length} files, ${totalKb.toFixed(0)} KB (${gzipKb.toFixed(0)} KB gzipped), ${calls} API calls, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`[snapshot] written to dashboard/public/data/ (${readdirSync(dir).length} files in ${snapshotId}/)`);
