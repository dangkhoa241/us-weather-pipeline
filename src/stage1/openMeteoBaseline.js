// src/stage1/openMeteoBaseline.js
// best_match baseline from Open-Meteo's Previous Runs API → `forecast_snapshots`. For each past target hour, the
// API gives the value forecast N days earlier (N = 1..7). best_match blends models (HRRR + GFS in the US), so it
// has no single run: lead_days (N) is exact, issued_at = target − N days is approximate, lead_hours stays null.

import { config } from "../config.js";
import { COLLECTIONS } from "../collections.js";
import { openMeteoGet } from "../lib/http.js";
import { ApiBudget, BudgetExceeded } from "../lib/apiBudget.js";

const PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast";
const SNAPSHOTS = COLLECTIONS.forecastSnapshots;
const WATERMARKS = COLLECTIONS.watermarks;
const MARKER = "om-previous-runs:best_match";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LEAD_DAYS = [1, 2, 3, 4, 5, 6, 7];
const CHUNK_DAYS = 14;

// Core variables for accuracy (kept small: every variable counts once per lead day).
const VARIABLES = {
  temperature_2m: "temp_c",
  dew_point_2m: "dew_point_c",
  precipitation: "precip_mm",
  wind_speed_10m: "wind_speed_ms",
  wind_gusts_10m: "wind_gust_ms",
};

const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
// Weighted calls: billed per 10 variables and per 14 days.
const requestWeight = (days) =>
  Math.max(1, (Object.keys(VARIABLES).length * LEAD_DAYS.length) / 10) * Math.max(1, days / CHUNK_DAYS);

function toSnapshots(location, hourly, meta) {
  const docs = [];
  hourly.time.forEach((t, i) => {
    const target = new Date(`${t}Z`);
    for (const n of LEAD_DAYS) {
      const values = {};
      for (const [variable, field] of Object.entries(VARIABLES)) values[field] = hourly[`${variable}_previous_day${n}`]?.[i] ?? null;
      if (Object.values(values).every((v) => v === null)) continue;   // no data: store nothing
      docs.push({
        location_id: location.id,
        source: "open-meteo",
        model: "best_match",
        kind: "hourly",
        issued_at: new Date(target.getTime() - n * DAY_MS),   // approximate: the run cycle is not reported
        issued_at_basis: "previous_runs_lead_day",
        fetch_method: "previous_runs",
        target_time: target,
        target_end_time: new Date(target.getTime() + HOUR_MS),
        lead_hours: null,
        lead_days: n,
        generated_at: null,
        values,
        ...meta,
      });
    }
  });
  return docs;
}

/** Fill complete target days (up to yesterday, UTC) from `days` ago, in 14-day chunks. */
export async function backfillBestMatchBaseline(store, locations, run, { days = config.stage1.omBackfillDays } = {}) {
  const budget = new ApiBudget(store, "open-meteo", config.openMeteoBudget);
  const lastDay = dayStart(Date.now()) - DAY_MS;   // yesterday: all its lead-day values are final
  const firstDay = dayStart(Date.now() - days * DAY_MS);
  const markers = new Map((await store.find(WATERMARKS.name, { source: MARKER })).map((d) => [d.location_id, d.last_time.getTime()]));

  try {
    for (const location of locations) {
      try {
        await fillLocation(location);
      } catch (err) {
        if (err instanceof BudgetExceeded) throw err;
        run.error(location.id, err);   // keep going with the other locations
      }
    }
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err;
    run.skip(null, `stopped: ${err.message}; resumes on the next run`);
    console.log(`[om-baseline] ${err.message}; resuming on the next run`);
  }

  async function fillLocation(location) {
    const done = markers.get(location.id);
    for (let from = Math.max(firstDay, done != null ? done + DAY_MS : firstDay); from <= lastDay; from += CHUNK_DAYS * DAY_MS) {
      const to = Math.min(from + (CHUNK_DAYS - 1) * DAY_MS, lastDay);
      const chunkDays = Math.round((to - from) / DAY_MS) + 1;
      await budget.reserve(requestWeight(chunkDays));
      const params = new URLSearchParams({
        latitude: location.lat,
        longitude: location.lon,
        models: "best_match",
        start_date: toDay(from),
        end_date: toDay(to),
        hourly: LEAD_DAYS.flatMap((n) => Object.keys(VARIABLES).map((v) => `${v}_previous_day${n}`)).join(","),
        timezone: "GMT",
        wind_speed_unit: "ms",
      });
      const fetchedAt = new Date();
      const data = await openMeteoGet(`${PREVIOUS_RUNS_URL}?${params}`, { cost: requestWeight(chunkDays) });
      store.addRawResponse("open-meteo-baseline", `${PREVIOUS_RUNS_URL}?${params}`, data);
      const meta = { etl_batch_id: run.etlBatchId, source_timestamp: fetchedAt, fetched_at: fetchedAt };
      const docs = toSnapshots(location, data.hourly ?? { time: [] }, meta);
      const result = docs.length ? await store.upsertMany(SNAPSHOTS.name, docs, SNAPSHOTS.uniqueKey) : {};
      run.add(docs.length, result);
      await store.upsertMany(WATERMARKS.name,
        [{ source: MARKER, location_id: location.id, last_time: new Date(to), updated_at: new Date() }], WATERMARKS.uniqueKey);
      console.log(`[om-baseline] ${location.id} ${toDay(from)}..${toDay(to)}: ${docs.length} snapshots`, result);
    }
  }
}
