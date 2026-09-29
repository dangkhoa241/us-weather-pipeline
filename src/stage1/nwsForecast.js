// src/stage1/nwsForecast.js
// NWS forecasts → `forecast_snapshots`. Each fetch stores every forecast period keyed by
// (location, kind, issued_at, target_time), so we keep the history of forecasts for accuracy stats.

import { COLLECTIONS } from "../collections.js";
import { nwsGet } from "../lib/http.js";

const SNAPSHOTS = COLLECTIONS.forecastSnapshots;
const HOUR_MS = 3_600_000;

// kind → location field holding the NWS URL (resolved by the locations seed)
const KINDS = {
  hourly: "nws_forecast_hourly_url",   // 1-hour periods, ~7 days
  periods: "nws_forecast_url",         // 12-hour day/night periods, 7 days
};

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

/** "10 km/h" or "10 to 20 km/h" → { low, high } in m/s. */
function parseWind(text) {
  const nums = (text ?? "").match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
  if (!nums.length) return { low: null, high: null };
  const toMs = (kmh) => round1(kmh / 3.6);
  return { low: toMs(nums[0]), high: toMs(nums.at(-1)) };
}

/** Temperature in °C whatever unit NWS answered with (we ask for SI, but be safe). */
function tempC(period) {
  if (period.temperature == null) return null;
  const value = typeof period.temperature === "object" ? period.temperature.value : period.temperature;
  if (value == null) return null;
  return round1(period.temperatureUnit === "F" ? ((value - 32) * 5) / 9 : value);
}

function toSnapshot(location, kind, issuedAt, generatedAt, period, meta) {
  const target = new Date(period.startTime);
  const leadHours = Math.round((target - issuedAt) / HOUR_MS);
  const wind = parseWind(period.windSpeed);
  return {
    location_id: location.id,
    source: "nws",
    model: "nws",
    kind,
    issued_at: issuedAt,
    issued_at_basis: "nws_update_time",
    target_time: target,
    target_end_time: new Date(period.endTime),
    lead_hours: leadHours,
    lead_days: Math.floor(leadHours / 24),
    generated_at: generatedAt,
    values: {
      temp_c: tempC(period),
      dew_point_c: round1(period.dewpoint?.value),
      rel_humidity_pct: period.relativeHumidity?.value ?? null,
      precip_prob_pct: period.probabilityOfPrecipitation?.value ?? null,
      wind_speed_ms: wind.low,
      wind_speed_max_ms: wind.high,
      wind_dir: period.windDirection || null,
      is_daytime: period.isDaytime ?? null,
      name: period.name || null,
      short_forecast: period.shortForecast || null,
      detailed_forecast: period.detailedForecast || null,
    },
    ...meta,
  };
}

export async function fetchForecasts(store, locations, run) {
  for (const location of locations) {
    for (const [kind, urlField] of Object.entries(KINDS)) {
      try {
        const url = location[urlField];
        if (!url) throw new Error(`no ${urlField}; run npm run seed:locations`);
        const fetchedAt = new Date();
        const { properties: p } = await nwsGet(`${url}?units=si`);
        const issuedAt = new Date(p.updateTime ?? p.generatedAt);
        const generatedAt = p.generatedAt ? new Date(p.generatedAt) : null;
        const meta = { etl_batch_id: run.etlBatchId, source_timestamp: generatedAt ?? issuedAt, fetched_at: fetchedAt };
        const docs = (p.periods ?? []).map((period) => toSnapshot(location, kind, issuedAt, generatedAt, period, meta));
        const result = docs.length ? await store.upsertMany(SNAPSHOTS.name, docs, SNAPSHOTS.uniqueKey) : {};
        run.add(docs.length, result);
        console.log(`[forecast] ${location.id} ${kind}: ${docs.length} periods, issued ${issuedAt.toISOString()}`, result);
      } catch (err) {
        run.error(location.id, new Error(`${kind}: ${err.message}`));
      }
    }
  }
}
