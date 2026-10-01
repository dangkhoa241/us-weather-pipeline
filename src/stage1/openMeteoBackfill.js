// src/stage1/openMeteoBackfill.js
// Past model forecasts from Open-Meteo's Single Runs API → `forecast_snapshots`, so forecast collection does not
// depend on a machine being on. One request = one run (00/06/12/18Z) of one model at one location, so issued_at
// is the exact run time. Resumable: a progress marker per model + location; stops cleanly at the API budget.

import { config } from "../config.js";
import { COLLECTIONS } from "../collections.js";
import { openMeteoGet, HttpError } from "../lib/http.js";
import { ApiBudget, BudgetExceeded } from "../lib/apiBudget.js";
import { maxLeadHours, coversLocation, compass } from "./openMeteoForecast.js";

const SINGLE_RUNS_URL = "https://single-runs-api.open-meteo.com/v1/forecast";
const META_URL = (domain) => `https://api.open-meteo.com/data/${domain}/static/meta.json`;
const SNAPSHOTS = COLLECTIONS.forecastSnapshots;
const WATERMARKS = COLLECTIONS.watermarks;
const HOUR_MS = 3_600_000;
const RUN_STEP_MS = 6 * HOUR_MS;
const FORECAST_DAYS = 7;
const RECENT_MS = 24 * HOUR_MS;   // a missing run younger than this may still appear; retry it later
// The backfill is the biggest Open-Meteo user; it may take at most this share of the hourly/daily budget so the
// history load (and the baseline) always get the rest, even while a large backfill is catching up.
const BUDGET_SHARE = 0.75;

// Domain whose meta.json says which run is the latest.
const RUN_DOMAIN = {
  gfs_hrrr: "ncep_hrrr_conus",
  gfs_global: "ncep_gfs025",
  ecmwf_ifs025: "ecmwf_ifs025",
  icon_global: "dwd_icon",
};

// 10 variables → each request is billed as exactly 1 weighted call (Open-Meteo bills per 10 variables).
// precipitation_probability is ensemble-only in Single Runs; is_day is derivable from time + location.
const VARIABLES = {
  temperature_2m: "temp_c",
  apparent_temperature: "apparent_temp_c",
  dew_point_2m: "dew_point_c",
  relative_humidity_2m: "rel_humidity_pct",
  precipitation: "precip_mm",
  cloud_cover: "cloud_cover_pct",
  wind_speed_10m: "wind_speed_ms",
  wind_gusts_10m: "wind_gust_ms",
  wind_direction_10m: "wind_dir_deg",
  weather_code: "weather_code",
};
const REQUEST_COST = Math.max(1, Object.keys(VARIABLES).length / 10) * Math.max(1, FORECAST_DAYS / 14);

const markerSource = (model) => `om-single-runs:${model}`;
const floorToRun = (ms) => Math.floor(ms / RUN_STEP_MS) * RUN_STEP_MS;
const runParam = (date) => date.toISOString().slice(0, 16);   // "2026-09-28T06:00"

/** Latest 00/06/12/18Z run per model that Open-Meteo has published. */
async function latestRuns(models, run) {
  const latest = new Map();
  for (const model of models) {
    const domain = RUN_DOMAIN[model];
    if (!domain) {
      run.error(null, new Error(`${model}: no run metadata known; not backfilled`));
      continue;
    }
    try {
      const meta = await openMeteoGet(META_URL(domain));
      latest.set(model, floorToRun(meta.last_run_initialisation_time * 1000));
    } catch (err) {
      run.error(null, new Error(`meta.json for ${model}: ${err.message}`));
    }
  }
  return latest;
}

function toSnapshots(location, model, hourly, issuedAt, meta) {
  const lastTarget = issuedAt.getTime() + maxLeadHours(model, issuedAt.getUTCHours()) * HOUR_MS;
  const docs = [];
  hourly.time.forEach((t, i) => {
    const target = new Date(`${t}Z`);
    if (target < issuedAt || target.getTime() > lastTarget) return;   // outside this run
    const values = {};
    for (const [variable, field] of Object.entries(VARIABLES)) values[field] = hourly[variable]?.[i] ?? null;
    if (Object.values(values).every((v) => v === null)) return;      // no data: store nothing
    values.wind_dir = compass(values.wind_dir_deg);
    const leadHours = Math.round((target - issuedAt) / HOUR_MS);
    docs.push({
      location_id: location.id,
      source: "open-meteo",
      model,
      kind: "hourly",
      issued_at: issuedAt,
      issued_at_basis: "model_run",
      fetch_method: "single_runs",
      target_time: target,
      target_end_time: new Date(target.getTime() + HOUR_MS),
      lead_hours: leadHours,
      lead_days: Math.floor(leadHours / 24),
      generated_at: null,
      values,
      ...meta,
    });
  });
  return docs;
}

async function fetchRun(location, model, issuedAt) {
  const params = new URLSearchParams({
    latitude: location.lat,
    longitude: location.lon,
    models: model,
    run: runParam(issuedAt),
    hourly: Object.keys(VARIABLES).join(","),
    forecast_days: FORECAST_DAYS,
    timezone: "GMT",
    wind_speed_unit: "ms",
  });
  return openMeteoGet(`${SINGLE_RUNS_URL}?${params}`, { cost: REQUEST_COST, maxRetries: 2 });
}

const isRunMissing = (err) => err instanceof HttpError && err.status === 400 && /not available/i.test(err.message);

/**
 * Backfill runs from `days` ago up to the latest published run, oldest first, until the budget is used up.
 * @param {{ days?: number, models?: string[] }} [options]
 */
export async function backfillOpenMeteoRuns(store, locations, run, options = {}) {
  const days = options.days ?? config.stage1.omBackfillDays;
  const models = options.models ?? config.stage1.omBackfillModels;
  const budget = new ApiBudget(store, "open-meteo", config.openMeteoBudget, { share: BUDGET_SHARE });
  const now = Date.now();
  const earliest = floorToRun(now - days * 24 * HOUR_MS);
  const latest = await latestRuns(models, run);

  // Which (model, location) pairs to fill, and where each one resumes.
  const markers = new Map();
  for (const doc of await store.find(WATERMARKS.name, { source: { $in: models.map(markerSource) } })) {
    markers.set(`${doc.source}|${doc.location_id}`, doc.last_time.getTime());
  }
  const pairs = [];
  for (const model of latest.keys()) {
    for (const location of locations) {
      if (!coversLocation(model, location)) {
        run.skip(location.id, `${model}: location outside model domain`);
        continue;
      }
      const done = markers.get(`${markerSource(model)}|${location.id}`);
      pairs.push({ model, location, next: Math.max(earliest, done != null ? done + RUN_STEP_MS : earliest) });
    }
  }

  const stopAt = new Set();   // pairs that hit a too-recent missing run: retry next time
  try {
    for (let runMs = Math.min(...pairs.map((p) => p.next)); runMs <= Math.max(...latest.values()); runMs += RUN_STEP_MS) {
      for (const pair of pairs) {
        const key = `${pair.model}|${pair.location.id}`;
        if (runMs < pair.next || runMs > latest.get(pair.model) || stopAt.has(key)) continue;
        const issuedAt = new Date(runMs);

        await budget.reserve(REQUEST_COST);
        const fetchedAt = new Date();
        const meta = { etl_batch_id: run.etlBatchId, source_timestamp: fetchedAt, fetched_at: fetchedAt };
        try {
          const data = await fetchRun(pair.location, pair.model, issuedAt);
          const docs = toSnapshots(pair.location, pair.model, data.hourly ?? { time: [] }, issuedAt, meta);
          const result = docs.length ? await store.upsertMany(SNAPSHOTS.name, docs, SNAPSHOTS.uniqueKey) : {};
          run.add(docs.length, result);
          if (!docs.length) run.skip(pair.location.id, `${pair.model} ${runParam(issuedAt)}Z: no data`);
        } catch (err) {
          if (!isRunMissing(err)) throw err;
          if (now - runMs < RECENT_MS) {   // not published in Single Runs yet
            stopAt.add(key);
            continue;
          }
          run.skip(pair.location.id, `${pair.model} ${runParam(issuedAt)}Z: run not available`);
        }
        await store.upsertMany(WATERMARKS.name,
          [{ source: markerSource(pair.model), location_id: pair.location.id, last_time: issuedAt, updated_at: new Date() }],
          WATERMARKS.uniqueKey);
      }
      if (new Date(runMs).getUTCHours() === 18) {
        console.log(`[om-backfill] runs up to ${runParam(new Date(runMs))}Z done, ${run.counts.rows_fetched} rows so far`);
      }
    }
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err;
    run.skip(null, `stopped: ${err.message}; resumes on the next run`);
    console.log(`[om-backfill] ${err.message}; resuming on the next run`);
  }

  const used = await budget.usage();
  console.log(`[om-backfill] Open-Meteo usage now: ${Math.round(used.hour)} this hour, ${Math.round(used.day)} today`);
}
