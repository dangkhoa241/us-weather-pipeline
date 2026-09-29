// src/stage1/openMeteoForecast.js
// Open-Meteo hourly forecasts for several models → `forecast_snapshots` (same shape as NWS, plus `model`).
// issued_at is the model's run time when Open-Meteo publishes it, so lead times compare fairly with NWS.

import { config } from "../config.js";
import { COLLECTIONS } from "../collections.js";
import { openMeteoGet } from "../lib/http.js";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const META_URL = (domain) => `https://api.open-meteo.com/data/${domain}/static/meta.json`;
const SNAPSHOTS = COLLECTIONS.forecastSnapshots;
const FORECAST_DAYS = 7;
const HOUR_MS = 3_600_000;

// Model → Open-Meteo domain whose meta.json gives the run time. The seamless models blend several
// domains; the global one is used as the run time. Models not listed (best_match) use the fetch hour.
const RUN_DOMAIN = {
  gfs_seamless: "ncep_gfs025",
  ecmwf_ifs025: "ecmwf_ifs025",
  icon_seamless: "dwd_icon",
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
const compass = (deg) => (deg == null ? null : COMPASS[Math.round(deg / 22.5) % 16]);
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

function toSnapshots(location, model, hourly, issued, meta) {
  const suffix = `_${model}`;
  const fromHour = floorHour(meta.fetched_at);
  const docs = [];
  hourly.time.forEach((t, i) => {
    const target = new Date(`${t}Z`);
    if (target < fromHour) return;   // today's past hours are not a forecast
    const values = {};
    for (const [variable, field] of Object.entries(VARIABLES)) values[field] = hourly[`${variable}${suffix}`]?.[i] ?? null;
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
  // A model with no data here (e.g. out of its domain) returns all nulls: store nothing for it.
  return docs.some((d) => d.values.temp_c !== null) ? docs : [];
}

export async function fetchOpenMeteoForecasts(store, locations, run) {
  const models = config.stage1.openMeteoForecastModels;
  const runTimes = await fetchRunTimes(models, run);
  const weight = Math.max(1, (Object.keys(VARIABLES).length * models.length) / 10) * Math.max(1, FORECAST_DAYS / 14);

  for (const location of locations) {
    try {
      const params = new URLSearchParams({
        latitude: location.lat,
        longitude: location.lon,
        hourly: Object.keys(VARIABLES).join(","),
        models: models.join(","),
        forecast_days: FORECAST_DAYS,
        timezone: "GMT",
        wind_speed_unit: "ms",
      });
      const fetchedAt = new Date();
      const data = await openMeteoGet(`${FORECAST_URL}?${params}`, { cost: weight });
      const meta = { etl_batch_id: run.etlBatchId, source_timestamp: fetchedAt, fetched_at: fetchedAt };
      const counts = [];
      for (const model of models) {
        const issued = runTimes.has(model)
          ? { at: runTimes.get(model), basis: "model_run" }
          : { at: floorHour(fetchedAt), basis: "fetch_hour" };
        const docs = toSnapshots(location, model, data.hourly ?? { time: [] }, issued, meta);
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
  const after = await fetchRunTimes(models, { error: () => {} });
  for (const [model, at] of runTimes) {
    if (after.has(model) && after.get(model).getTime() !== at.getTime()) {
      run.error(null, new Error(`${model} published a new run during this fetch; snapshots may mix runs`));
    }
  }
}
