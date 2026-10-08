// src/stage1/nwsForecast.js
// NWS forecasts → `forecast_snapshots`. Each fetch stores every forecast period keyed by
// (location, kind, issued_at, target_time), so we keep the history of forecasts for accuracy stats.

import { COLLECTIONS } from "../collections.js";
import { nwsGet } from "../lib/http.js";

const SNAPSHOTS = COLLECTIONS.forecastSnapshots;
const RUNS = COLLECTIONS.pipelineRuns.name;
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
        const data = await nwsGet(`${url}?units=si`);
        store.addRawResponse("nws-forecast", `${url}?units=si`, data);
        const { properties: p } = data;
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

// ---- Partial-run warning -------------------------------------------------------------------------------------------
// NWS sometimes answers 500 for one grid point for a few hours and recovers on its own (2026-10-07: Kansas City,
// 3 runs). Every partial run stays in pipeline_runs; the email goes out once per failure streak, when a city has
// failed 2 runs in a row (not on the first failure, not again while it keeps failing, not on recovery).

const failedCities = (errors) => new Set((errors ?? []).map((e) => e.location_id).filter(Boolean));

/** Cities whose failure streak just reached 2 runs: failed now and in the previous run, but not in the one before. */
export function newRepeatFailures(errors, previousRuns) {
  const [prev, before] = previousRuns.map((r) => failedCities(r.errors));
  return [...failedCities(errors)].filter((id) => prev?.has(id) && !before?.has(id)).sort();
}

const utcText = (date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** "Kansas City, MO failed: NWS HTTP 500 on 2 calls; last good forecast from 2026-10-06 21:08 UTC". */
export function forecastFailureEvent(cityIds, errors, locations, lastGood) {
  const lines = cityIds.map((id) => {
    const l = locations.find((x) => x.id === id);
    const mine = errors.filter((e) => e.location_id === id);
    const codes = [...new Set(mine.map((e) => /HTTP (\d{3})/.exec(e.message)?.[1]).filter(Boolean))];
    const what = codes.length ? `NWS HTTP ${codes.join("/")}` : mine[0].message.split(" - ")[0].slice(0, 120);
    const good = lastGood[id] ? `last good forecast from ${utcText(lastGood[id])}` : "no good forecast stored";
    return `${l ? `${l.name}, ${l.state}` : id} failed: ${what} on ${mine.length} ${mine.length === 1 ? "call" : "calls"}; ${good}`;
  });
  return {
    level: "warn",
    title: `Stage 1 forecast: ${cityIds.length} ${cityIds.length === 1 ? "city" : "cities"} failed 2 runs in a row`,
    message: lines.join("\n"),
  };
}

/** The warning for a partial forecast run, or null when no city has just failed twice in a row. */
export async function forecastPartialNotice(store, run, locations) {
  const recent = await store.find(RUNS, { stage: run.stage, mode: run.mode }, {
    sort: { started_at: -1 }, limit: 5, projection: { _id: 0, etl_batch_id: 1, status: 1, errors: 1 },
  });
  const previous = recent.filter((r) => r.etl_batch_id !== run.etlBatchId && r.status !== "running").slice(0, 2);
  const cityIds = newRepeatFailures(run.errors, previous);
  if (!cityIds.length) return null;
  const lastGood = {};
  for (const id of cityIds) {
    const [doc] = await store.find(SNAPSHOTS.name, { location_id: id, source: "nws" }, { sort: { fetched_at: -1 }, limit: 1, projection: { _id: 0, fetched_at: 1 } });
    if (doc?.fetched_at) lastGood[id] = new Date(doc.fetched_at);
  }
  return forecastFailureEvent(cityIds, run.errors, locations, lastGood);
}
