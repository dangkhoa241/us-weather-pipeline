// src/stage1/openMeteoHistory.js
// Hourly history from the Open-Meteo archive API → `observations_hourly`.
// Incremental by default (per-location watermark); an explicit from/to range is a backfill.

import { config } from "../config.js";
import { COLLECTIONS } from "../collections.js";
import { openMeteoGet } from "../lib/http.js";
import { ApiBudget, BudgetExceeded } from "../lib/apiBudget.js";

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const SOURCE = "open-meteo-archive";
const OBS = COLLECTIONS.observationsHourly;
const WATERMARKS = COLLECTIONS.watermarks.name;
const DAY_MS = 86_400_000;
const CHUNK_DAYS = 366;

// Open-Meteo variable → our field name (units: °C, %, mm, cm, hPa, m/s, degrees).
const VARIABLES = {
  temperature_2m: "temp_c",
  apparent_temperature: "apparent_temp_c",
  dew_point_2m: "dew_point_c",
  relative_humidity_2m: "rel_humidity_pct",
  precipitation: "precip_mm",
  rain: "rain_mm",
  snowfall: "snowfall_cm",
  cloud_cover: "cloud_cover_pct",
  pressure_msl: "pressure_msl_hpa",
  wind_speed_10m: "wind_speed_ms",
  wind_gusts_10m: "wind_gust_ms",
  wind_direction_10m: "wind_dir_deg",
  weather_code: "weather_code",
};

const toDay = (date) => date.toISOString().slice(0, 10);
const parseDay = (day) => new Date(`${day}T00:00:00Z`);
const addDays = (date, n) => new Date(date.getTime() + n * DAY_MS);

/** Open-Meteo bills a request as several calls when it has >10 variables or >14 days. */
const requestWeight = (days) => Math.max(1, Object.keys(VARIABLES).length / 10) * Math.max(1, days / 14);

/** Last day the archive can be trusted (it lags ~5 days; newer hours come back null). */
export const archiveEndDay = () => toDay(addDays(new Date(), -config.stage1.archiveLagDays));

/** Split [from, to] (inclusive, YYYY-MM-DD) into chunks of at most CHUNK_DAYS days. */
function* chunks(fromDay, toDay_) {
  const end = parseDay(toDay_);
  for (let start = parseDay(fromDay); start <= end; start = addDays(start, CHUNK_DAYS)) {
    const chunkEnd = new Date(Math.min(addDays(start, CHUNK_DAYS - 1).getTime(), end.getTime()));
    yield [toDay(start), toDay(chunkEnd), Math.round((chunkEnd - start) / DAY_MS) + 1];
  }
}

async function fetchChunk(store, location, from, to, days, budget) {
  await budget.reserve(requestWeight(days));
  const params = new URLSearchParams({
    latitude: location.lat,
    longitude: location.lon,
    start_date: from,
    end_date: to,
    hourly: Object.keys(VARIABLES).join(","),
    timezone: "GMT",           // times come back in UTC
    wind_speed_unit: "ms",
  });
  const data = await openMeteoGet(`${ARCHIVE_URL}?${params}`, { cost: requestWeight(days) });
  store.addRawResponse("open-meteo-history", `${ARCHIVE_URL}?${params}`, data);
  return data.hourly ?? { time: [] };
}

/**
 * Column arrays → one doc per hour. Trailing hours where every measurement is null are dropped.
 * Hours after the fetch time are dropped too: near "today" the archive fills in model forecasts, not nulls.
 */
function toRows(location, hourly, meta) {
  const rows = hourly.time.map((t, i) => {
    const row = { location_id: location.id, time: new Date(`${t}Z`), source: SOURCE };
    for (const [variable, field] of Object.entries(VARIABLES)) row[field] = hourly[variable]?.[i] ?? null;
    return { ...row, ...meta };
  }).filter((row) => row.time <= meta.fetched_at);
  const hasData = (row) => Object.values(VARIABLES).some((field) => row[field] !== null);
  let end = rows.length;
  while (end > 0 && !hasData(rows[end - 1])) end -= 1;
  return { rows: rows.slice(0, end), trimmed: rows.length - end };
}

async function readWatermark(store, locationId) {
  return store.findOne(WATERMARKS, { source: SOURCE, location_id: locationId });
}

async function advanceWatermark(store, locationId, lastTime) {
  const current = await readWatermark(store, locationId);
  if (current?.last_time >= lastTime) return;   // a backfill of older data never moves it back
  await store.upsertMany(WATERMARKS, [{ source: SOURCE, location_id: locationId, last_time: lastTime, updated_at: new Date() }],
    COLLECTIONS.watermarks.uniqueKey);
}

/**
 * Fetch history for each location.
 * @param {{ from?: string, to?: string }} range  explicit range = backfill; omitted = incremental from watermark
 */
export async function fetchHistory(store, locations, run, { from, to } = {}) {
  const endLimit = archiveEndDay();
  const budget = new ApiBudget(store, "open-meteo", config.openMeteoBudget);
  for (const location of locations) {
    try {
      let start = from;
      const end = to && to < endLimit ? to : endLimit;
      if (!start) {
        const wm = await readWatermark(store, location.id);
        // Already have the archive's last day up to 23:00: nothing new until the archive moves on (saves a call
        // per city on every pipeline run).
        if (wm && wm.last_time >= new Date(`${end}T23:00:00Z`)) continue;
        // Re-fetch the watermark's day: its last hours may have been null (trimmed) last time.
        start = wm ? toDay(wm.last_time) : toDay(addDays(new Date(), -365 * config.stage1.historyYears));
      }
      if (start > end) {
        console.log(`[history] ${location.id}: up to date (next ${start}, archive ends ${end})`);
        continue;
      }

      for (const [chunkFrom, chunkTo, days] of chunks(start, end)) {
        const fetchedAt = new Date();
        const hourly = await fetchChunk(store, location, chunkFrom, chunkTo, days, budget);
        const meta = { etl_batch_id: run.etlBatchId, source_timestamp: fetchedAt, fetched_at: fetchedAt };
        const { rows, trimmed } = toRows(location, hourly, meta);
        const result = rows.length ? await store.upsertMany(OBS.name, rows, OBS.uniqueKey) : {};
        run.add(rows.length, result);
        if (rows.length) await advanceWatermark(store, location.id, rows.at(-1).time);
        console.log(`[history] ${location.id} ${chunkFrom}..${chunkTo}: ${rows.length} rows` +
          `${trimmed ? `, ${trimmed} trailing null hours skipped` : ""}`, result);
      }
    } catch (err) {
      if (err instanceof BudgetExceeded) {   // stop cleanly; the watermark makes the next run resume here
        run.skip(location.id, `stopped: ${err.message}`);
        console.log(`[history] ${err.message}; resuming on the next run`);
        return;
      }
      run.error(location.id, err);
    }
  }
}
