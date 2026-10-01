// src/stage1/openMeteoForecast.js
// Open-Meteo hourly forecasts for several models → `forecast_snapshots` (same shape as NWS, plus `model`).
// issued_at is the model's run time when Open-Meteo publishes it, so lead times compare fairly with NWS.
// Only hours within that run's horizon are kept; hours with no data are not stored.

import { config } from "../config.js";
import { COLLECTIONS } from "../collections.js";
import { openMeteoGet } from "../lib/http.js";
import { ApiBudget, BudgetExceeded } from "../lib/apiBudget.js";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const META_URL = (domain) => `https://api.open-meteo.com/data/${domain}/static/meta.json`;
const SNAPSHOTS = COLLECTIONS.forecastSnapshots;
const FORECAST_DAYS = 7;
const HOUR_MS = 3_600_000;

// Model → Open-Meteo domain whose meta.json gives the latest run time. Only models that come from ONE run
// schedule at our locations are listed. Everything else uses the fetch hour (issued_at_basis "fetch_hour"):
// - best_match: picks models per location.
// - gfs_seamless (legacy): over the US it is HRRR for ~48 h, then GFS, so it has no single run time.
//   Use gfs_hrrr + gfs_global instead.
const RUN_DOMAIN = {
  ecmwf_ifs025: "ecmwf_ifs025",
  icon_seamless: "dwd_icon",   // ICON-EU/D2 nests don't cover the US, so here it is ICON global only
  icon_global: "dwd_icon",
  gfs_global: "ncep_gfs025",
  gfs_hrrr: "ncep_hrrr_conus", // hourly runs, CONUS only
};

// How far each run reaches, by run hour (UTC). Open-Meteo fills hours past the latest run's end with an OLDER
// run, so for model_run snapshots we keep only hours within the latest run's horizon (measured with the
// Single Runs API on 2026-09-28). Models not listed reach past FORECAST_DAYS.
const SYNOPTIC = new Set([0, 6, 12, 18]);
const MAX_LEAD_HOURS = {
  gfs_hrrr: (runHour) => (SYNOPTIC.has(runHour) ? 48 : 18),
  ecmwf_ifs025: (runHour) => (runHour % 12 === 0 ? 360 : 144),
  icon_global: (runHour) => (runHour % 12 === 0 ? 180 : 120),
  icon_seamless: (runHour) => (runHour % 12 === 0 ? 180 : 120),
};

// Models with a limited domain: states they cover. Other locations skip the model (recorded, not stored).
const CONUS_EXCLUDED = new Set(["AK", "HI", "PR", "GU", "VI", "AS", "MP"]);
const COVERS = {
  gfs_hrrr: (location) => !CONUS_EXCLUDED.has(location.state),
};

// Open-Meteo variable → field in `values` (names shared with NWS snapshots where they overlap).
const VARIABLES = {
  temperature_2m: "temp_c",
  apparent_temperature: "apparent_temp_c",
  dew_point_2m: "dew_point_c",
  relative_humidity_2m: "rel_humidity_pct",
  precipitation_probability: "precip_prob_pct",
  precipitation: "precip_mm",
  cloud_cover: "cloud_cover_pct",
  wind_speed_10m: "wind_speed_ms",
  wind_gusts_10m: "wind_gust_ms",
  wind_direction_10m: "wind_dir_deg",
  weather_code: "weather_code",
  is_day: "is_daytime",
};

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compass = (deg) => (deg == null ? null : COMPASS[Math.round(deg / 22.5) % 16]);
const floorHour = (date) => new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);

/** Latest run time per model, from Open-Meteo's meta.json. Missing/failed → not in the map. */
async function fetchRunTimes(models, run) {
  const runTimes = new Map();
  for (const model of models) {
    const domain = RUN_DOMAIN[model];
    if (!domain) continue;
    try {
      const meta = await openMeteoGet(META_URL(domain));
      if (meta.last_run_initialisation_time) runTimes.set(model, new Date(meta.last_run_initialisation_time * 1000));
    } catch (err) {
      run.error(null, new Error(`meta.json for ${model} (${domain}): ${err.message}; using fetch hour`));
    }
  }
  return runTimes;
}

/** Hours a run of `model` reaches (Infinity when it reaches past what we request). */
export const maxLeadHours = (model, runHour) => MAX_LEAD_HOURS[model]?.(runHour) ?? Infinity;

/** Does `model` have data at this location? */
export const coversLocation = (model, location) => COVERS[model]?.(location) ?? true;

/** Last target time we trust for this model and issue: the run's horizon for model_run, else no cap. */
function maxTarget(model, issued) {
  const horizon = MAX_LEAD_HOURS[model];
  if (issued.basis !== "model_run" || !horizon) return Infinity;
  return issued.at.getTime() + horizon(issued.at.getUTCHours()) * HOUR_MS;
}

function toSnapshots(location, model, hourly, issued, meta) {
  const suffix = `_${model}`;
  const fromHour = floorHour(meta.fetched_at);
  const lastTarget = maxTarget(model, issued);
  const docs = [];
  hourly.time.forEach((t, i) => {
    const target = new Date(`${t}Z`);
    if (target < fromHour) return;           // today's past hours are not a forecast
    if (target.getTime() > lastTarget) return; // past the run's horizon: filled from an older run
    const values = {};
    for (const [variable, field] of Object.entries(VARIABLES)) values[field] = hourly[`${variable}${suffix}`]?.[i] ?? null;
    if (Object.values(values).every((v) => v === null)) return;   // no data for this hour: store nothing
    values.is_daytime = values.is_daytime == null ? null : values.is_daytime === 1;
    values.wind_dir = compass(values.wind_dir_deg);
    const leadHours = Math.round((target - issued.at) / HOUR_MS);
    docs.push({
      location_id: location.id,
      source: "open-meteo",
      model,
      kind: "hourly",
      issued_at: issued.at,
      issued_at_basis: issued.basis,
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

/** Weighted Open-Meteo calls for one request (billed per 10 variables and per 14 days). */
export const requestWeight = (modelCount) =>
  Math.max(1, (Object.keys(VARIABLES).length * modelCount) / 10) * Math.max(1, FORECAST_DAYS / 14);

export async function fetchOpenMeteoForecasts(store, locations, run) {
  const allModels = config.stage1.openMeteoForecastModels;
  const runTimes = await fetchRunTimes(allModels, run);
  // Shared Open-Meteo budget (the backfill leaves at least 25% of it to the other jobs).
  const budget = new ApiBudget(store, "open-meteo", config.openMeteoBudget);

  for (const [i, location] of locations.entries()) {
    try {
      const models = allModels.filter((m) => coversLocation(m, location));
      for (const m of allModels.filter((x) => !models.includes(x))) run.skip(location.id, `${m}: location outside model domain`);
      const params = new URLSearchParams({
        latitude: location.lat,
        longitude: location.lon,
        hourly: Object.keys(VARIABLES).join(","),
        models: models.join(","),
        forecast_days: FORECAST_DAYS,
        timezone: "GMT",
        wind_speed_unit: "ms",
      });
      try {
        await budget.reserve(requestWeight(models.length));
      } catch (err) {
        if (!(err instanceof BudgetExceeded)) throw err;
        run.skip(null, `stopped before ${location.id}: ${err.message}; ${locations.length - i} locations not fetched`);
        console.log(`[om-forecast] ${err.message}; ${locations.length - i} locations left for the next run`);
        break;
      }
      const fetchedAt = new Date();
      const data = await openMeteoGet(`${FORECAST_URL}?${params}`, { cost: requestWeight(models.length) });
      const meta = { etl_batch_id: run.etlBatchId, source_timestamp: fetchedAt, fetched_at: fetchedAt };
      const counts = [];
      for (const model of models) {
        const issued = runTimes.has(model)
          ? { at: runTimes.get(model), basis: "model_run" }
          : { at: floorHour(fetchedAt), basis: "fetch_hour" };
        const docs = toSnapshots(location, model, data.hourly ?? { time: [] }, issued, meta);
        if (!docs.length) run.skip(location.id, `${model}: no data returned`);
        const result = docs.length ? await store.upsertMany(SNAPSHOTS.name, docs, SNAPSHOTS.uniqueKey) : {};
        run.add(docs.length, result);
        counts.push(`${model} ${docs.length}`);
      }
      console.log(`[om-forecast] ${location.id}: ${counts.join(", ")}`);
    } catch (err) {
      run.error(location.id, err);
    }
  }

  // If a model published a new run while we were fetching, some snapshots may hold the newer run
  // under the older issued_at. Rare (runs land ~4x/day); flag it so the run is marked partial.
  const after = await fetchRunTimes(allModels, { error: () => {} });
  for (const [model, at] of runTimes) {
    if (after.has(model) && after.get(model).getTime() !== at.getTime()) {
      run.error(null, new Error(`${model} published a new run during this fetch; snapshots may mix runs`));
    }
  }
}
