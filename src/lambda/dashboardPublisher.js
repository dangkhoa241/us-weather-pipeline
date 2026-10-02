// AWS Lambda (Stage 6a part 4): publishes the live dashboard files to S3, served by CloudFront (docs/analysis/live-dashboard.md, design B).
// Event { "parts": ["history", "forecasts", "alerts"] } once a day, { "parts": ["forecasts", "alerts"] } every 3 hours
// (infra/template.yaml). Each part is one JSON file under s3://<DASHBOARD_BUCKET>/<DASHBOARD_PREFIX>:
//   recent.json     last DASHBOARD_RECENT_DAYS days of daily temperature/precipitation per city + "All US"
//                   (Open-Meteo archive; the dashboard lays it over the bundled snapshot's daily files)
//   forecasts.json  latest hourly forecast per model (NWS from Atlas, Open-Meteo models fetched here) + NWS day/night periods
//   alerts.json     active NWS alerts (from Atlas, written by the NWS collector Lambda)
// Forecast accuracy stays in the bundled snapshot (it needs the local ClickHouse forecast history).
// Every file passes the snapshot's FORBIDDEN check before upload, and uploads are capped per day (ledger in Atlas).
// The handler never throws, so Lambda doesn't retry (and send the same email three times).

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "../config.js";
import { COLLECTIONS } from "../collections.js";
import { createRawStore } from "../adapters/rawStore/index.js";
import { createNotifier } from "../adapters/notifier/index.js";
import { redact } from "../adapters/notifier/snsNotifier.js";
import { openMeteoGet } from "../lib/http.js";
import { ApiBudget, BudgetExceeded } from "../lib/apiBudget.js";
import { localWallClock } from "../lib/time.js";
import { archiveEndDay } from "../stage1/openMeteoHistory.js";
import { coversLocation, fetchRunTimes, maxLeadHours } from "../stage1/openMeteoForecast.js";
import { usAverage } from "../publish/usAverage.js";
import { DAY_MS, apiTime, columns, compactForecast, dailyStats, dayMs, publicJson, toDay } from "../publish/snapshotFormat.js";
import { getSecureParameter } from "./ssmParameter.js";

export const PARTS = ["history", "forecasts", "alerts"];
export const FORMAT = 1;   // bump when a live file's layout changes (the dashboard checks it)
const HOUR_MS = 3_600_000;
const FORECAST_DAYS = 8;   // as the local export (/forecast?days=8)
const OM_MODELS = ["ecmwf_ifs025", "gfs_global", "icon_global", "gfs_hrrr"];
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
// Own Open-Meteo ledger (Lambda IPs are not the laptop's): ~230 weighted calls / day for history + ~65 per forecast run.
const OPEN_METEO_LIMITS = { perHour: 1000, perDay: 2000 };
const MAX_ALERTS = 200;    // as the API's /alerts

// Browser and CloudFront cache times, matched to the schedule: CloudFront keeps a file for at most ~1/6 of the time
// until the next upload (30 min of a 3-hour cycle, 3 h of a day), the browser for a few minutes.
export const FILES = {
  history: { name: "recent.json", cacheControl: "public, max-age=900, s-maxage=10800" },
  forecasts: { name: "forecasts.json", cacheControl: "public, max-age=300, s-maxage=1800" },
  alerts: { name: "alerts.json", cacheControl: "public, max-age=300, s-maxage=1800" },
};

const floorHour = (date) => new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
/** Weighted Open-Meteo calls: billed per 10 variables (× models) and per 14 days. */
const weight = (variables, days) => Math.max(1, variables / 10) * Math.max(1, days / 14);

// ---- recent.json --------------------------------------------------------------------------------------------------
/** Daily history of the last `days` days per city (local days, as the API) and the US-wide average. */
export async function buildRecent(locations, { getJson, budget, days, endDay, now }) {
  const from = toDay(dayMs(endDay) - (days - 1) * DAY_MS);
  const cities = {};
  const allRows = { temp: [], precip: [] };
  const errors = [];
  for (const loc of locations) {
    try {
      await budget.reserve(weight(2, days));
      const params = new URLSearchParams({
        latitude: loc.lat, longitude: loc.lon, start_date: from, end_date: endDay,
        hourly: "temperature_2m,precipitation", timezone: loc.timezone,   // local times → local days
      });
      const hourly = (await getJson(`${ARCHIVE_URL}?${params}`, { cost: weight(2, days) })).hourly ?? { time: [] };
      const temp = dailyStats(loc.id, hourly.time, hourly.temperature_2m ?? []);
      const precip = dailyStats(loc.id, hourly.time, hourly.precipitation ?? []);
      cities[loc.id] = { temp: columns(temp, from, days, ["min", "max", "avg", "n"]), precip: columns(precip, from, days, ["sum", "n"]) };
      allRows.temp.push(...temp);
      allRows.precip.push(...precip);
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err;
      errors.push(`${loc.id}: ${redact(err.message)}`);
    }
  }
  if (errors.length > locations.length / 2) throw new Error(`history failed for ${errors.length} of ${locations.length} cities (${errors[0]})`);
  const all = {
    temp: columns(usAverage(allRows.temp), from, days, ["min", "max", "avg", "n", "cities"]),
    precip: columns(usAverage(allRows.precip), from, days, ["sum", "n", "cities"]),
  };
  const last = all.temp.n.findLastIndex((n) => n != null);
  if (last < 0) throw new Error("history: no data returned");
  return {
    data: { format: FORMAT, generated_at: now.toISOString(), data_as_of: toDay(dayMs(from) + last * DAY_MS), from, days, cities, all },
    errors,
  };
}

// ---- forecasts.json -----------------------------------------------------------------------------------------------
/** Latest NWS hourly forecast (from the hour now on) and day/night periods for one city, read from Atlas. */
async function nwsFromStore(store, loc, now) {
  const SNAPSHOTS = COLLECTIONS.forecastSnapshots.name;
  const latest = (kind) => store.findOne(SNAPSHOTS, { location_id: loc.id, model: "nws", kind }, { sort: { issued_at: -1 }, projection: { issued_at: 1 } });
  const [hourlyIssue, periodsIssue] = await Promise.all([latest("hourly"), latest("periods")]);
  const hourly = hourlyIssue ? await store.find(SNAPSHOTS, {
    location_id: loc.id, model: "nws", kind: "hourly", issued_at: hourlyIssue.issued_at,
    target_time: { $gte: floorHour(now), $lt: new Date(now.getTime() + FORECAST_DAYS * DAY_MS) },
  }, { sort: { target_time: 1 } }) : [];
  const periods = periodsIssue ? await store.find(SNAPSHOTS, {
    location_id: loc.id, model: "nws", kind: "periods", issued_at: periodsIssue.issued_at,
  }, { sort: { target_time: 1 } }) : [];
  return {
    rows: hourly.map((d) => ({ model: "nws", issued_at: apiTime(d.issued_at), target_time: apiTime(d.target_time),
      temp_c: d.values?.temp_c ?? null, precip_mm: null, precip_prob_pct: d.values?.precip_prob_pct ?? null })),
    // As the API: periods of the latest issue that haven't ended yet.
    periods: periods
      .filter((d) => (d.target_end_time ?? new Date(d.target_time.getTime() + 12 * HOUR_MS)) > now)
      .map((d) => ({
        issued_at: apiTime(d.issued_at), target_time: apiTime(d.target_time), target_end_time: apiTime(d.target_end_time),
        local_target_time: apiTime(localWallClock(d.target_time, loc.timezone)),
        temp_c: d.values?.temp_c ?? null, precip_prob_pct: d.values?.precip_prob_pct ?? null,
        wind_speed_ms: d.values?.wind_speed_ms ?? null, short_forecast: d.values?.short_forecast ?? null,
      })),
  };
}

/** Open-Meteo model forecasts for one city: hours from now within each run's horizon (as Stage 1 stores them). */
async function openMeteoRows(loc, { getJson, budget, runTimes, now }) {
  const models = OM_MODELS.filter((m) => coversLocation(m, loc));
  const cost = weight(3 * models.length, FORECAST_DAYS);
  await budget.reserve(cost);
  const params = new URLSearchParams({
    latitude: loc.lat, longitude: loc.lon, hourly: "temperature_2m,precipitation,precipitation_probability",
    models: models.join(","), forecast_days: FORECAST_DAYS, timezone: "GMT",
  });
  const hourly = (await getJson(`${FORECAST_URL}?${params}`, { cost })).hourly ?? { time: [] };
  const rows = [];
  for (const model of models) {
    const issued = runTimes.get(model) ?? floorHour(now);
    const lastTarget = runTimes.has(model) ? issued.getTime() + maxLeadHours(model, issued.getUTCHours()) * HOUR_MS : Infinity;
    hourly.time.forEach((t, i) => {
      const target = new Date(`${t}Z`);
      if (target < floorHour(now) || target.getTime() > lastTarget) return;
      const [temp_c, precip_mm, precip_prob_pct] = ["temperature_2m", "precipitation", "precipitation_probability"]
        .map((v) => hourly[`${v}_${model}`]?.[i] ?? null);
      if (temp_c == null && precip_mm == null && precip_prob_pct == null) return;   // no data: no row
      rows.push({ model, issued_at: apiTime(issued), target_time: apiTime(target), temp_c, precip_mm, precip_prob_pct });
    });
  }
  return rows;
}

export async function buildForecasts(store, locations, { getJson, budget, now, getRunTimes = fetchRunTimes }) {
  const errors = [];
  const runTimes = await getRunTimes(OM_MODELS, { error: (_, err) => errors.push(redact(err.message)) });
  const forecasts = {};
  const periods = {};
  for (const loc of locations) {
    let rows = [];
    try {
      const nws = await nwsFromStore(store, loc, now);
      rows = nws.rows;
      periods[loc.id] = nws.periods;
    } catch (err) {
      errors.push(`${loc.id} nws: ${redact(err.message)}`);
      periods[loc.id] = [];
    }
    try {
      rows.push(...(await openMeteoRows(loc, { getJson, budget, runTimes, now })));
    } catch (err) {
      if (err instanceof BudgetExceeded) throw err;
      errors.push(`${loc.id} open-meteo: ${redact(err.message)}`);
    }
    forecasts[loc.id] = compactForecast(rows);
  }
  const empty = locations.filter((l) => !Object.keys(forecasts[l.id]).length).length;
  if (empty > locations.length / 2) throw new Error(`forecasts missing for ${empty} of ${locations.length} cities (${errors[0] ?? "no data"})`);
  return { data: { format: FORMAT, generated_at: now.toISOString(), forecasts, periods }, errors };
}

// ---- alerts.json --------------------------------------------------------------------------------------------------
export async function buildAlerts(store, { now }) {
  const docs = await store.find(COLLECTIONS.alerts.name, { $or: [{ expires: null }, { expires: { $gt: now } }] });
  const alerts = docs
    .sort((a, b) => (a.expires ?? Infinity) - (b.expires ?? Infinity))   // as the API: by expiry, open-ended last
    .slice(0, MAX_ALERTS)
    .map((d) => ({
      id: String(d.id), event: d.event ?? "Alert", severity: d.severity ?? null, urgency: d.urgency ?? null, certainty: d.certainty ?? null,
      headline: d.headline ?? null, area_desc: d.area_desc ?? null, states: d.states ?? [], location_ids: d.location_ids ?? [],
      onset: apiTime(d.onset), expires: apiTime(d.expires), ends: apiTime(d.ends),
    }));
  return { data: { format: FORMAT, generated_at: now.toISOString(), alerts }, errors: [] };
}

// ---- upload -------------------------------------------------------------------------------------------------------
async function upload(s3, store, part, data, now) {
  const { name, cacheControl } = FILES[part];
  const body = publicJson(name, data);   // throws on anything internal: nothing is uploaded
  await new ApiBudget(store, "s3-dashboard", { perHour: Infinity, perDay: config.aws.dashboardMaxPutsPerDay }).reserve(1, now);
  await s3.send(new PutObjectCommand({
    Bucket: config.aws.dashboardBucket,
    Key: `${config.aws.dashboardPrefix}${name}`,
    Body: body,
    ContentType: "application/json; charset=utf-8",
    CacheControl: cacheControl,
    ServerSideEncryption: "AES256",   // SSE-S3 (also the bucket default)
  }));
  return { name, kb: Math.round(body.length / 1024) };
}

/** Dependencies are injectable for tests. */
export function createHandler({
  getParameter = getSecureParameter,
  makeStore = (uri) => createRawStore(config.adapters.rawStore, { uri }, { archive: false }),
  makeNotifier = createNotifier,
  makeS3 = () => new S3Client({ region: config.aws.region, maxAttempts: 3 }),
  getJson = openMeteoGet,
  getRunTimes = fetchRunTimes,
  clock = () => new Date(),
} = {}) {
  let mongoUri = null;   // kept for warm invocations

  return async function handler(event) {
    const notifier = makeNotifier();
    const parts = event?.parts ?? ["forecasts", "alerts"];
    if (!Array.isArray(parts) || !parts.length || parts.some((p) => !PARTS.includes(p))) {
      await notifier.notify({ level: "error", title: "Lambda dashboard publisher: bad event", message: `parts must be a list of ${PARTS.join(", ")}` });
      return { status: "failed" };
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.aws.dashboardBucket ?? "") || !/^[a-z0-9-]+\/$/.test(config.aws.dashboardPrefix)) {
      await notifier.notify({ level: "error", title: "Lambda dashboard publisher: bad config", message: "DASHBOARD_BUCKET / DASHBOARD_PREFIX are not set" });
      return { status: "failed" };
    }
    const now = clock();
    const uploaded = [];
    const failed = [];
    const warnings = [];
    let store = null;
    let s3 = null;
    try {
      mongoUri ??= await getParameter(config.aws.mongoUriParam);
      store = makeStore(mongoUri);
      await store.connect();
      s3 = makeS3();
      const locations = await store.find(COLLECTIONS.locations.name, {}, { sort: { id: 1 } });
      if (!locations.length) throw new Error("no locations in the store");
      const budget = new ApiBudget(store, "open-meteo-lambda", OPEN_METEO_LIMITS);
      const builders = {
        history: () => buildRecent(locations, { getJson, budget, days: config.aws.dashboardRecentDays, endDay: archiveEndDay(), now }),
        forecasts: () => buildForecasts(store, locations, { getJson, budget, now, getRunTimes }),
        alerts: () => buildAlerts(store, { now }),
      };
      for (const part of parts) {
        try {
          const { data, errors } = await builders[part]();
          warnings.push(...errors.map((e) => `${part}: ${e}`));
          uploaded.push(await upload(s3, store, part, data, now));
        } catch (err) {
          failed.push(`${part}: ${redact(err.message)}`);
        }
      }
    } catch (err) {
      mongoUri = null;   // re-read next time (the parameter may have been rotated)
      failed.push(redact(err?.message ?? err));
    } finally {
      await store?.close().catch((err) => console.warn(`[dashboard] close: ${redact(err.message)}`));
      s3?.destroy?.();
    }
    for (const u of uploaded) console.log(`[dashboard] ${config.aws.dashboardPrefix}${u.name}: ${u.kb} KB`);
    for (const w of warnings.slice(0, 20)) console.warn(`[dashboard] ${w}`);
    const status = failed.length ? (uploaded.length ? "partial" : "failed") : "success";
    if (failed.length) {
      console.error(`[dashboard] ${status}: ${failed.join("; ")}`);
      await notifier.notify({ level: status === "failed" ? "error" : "warn", title: `Lambda dashboard publisher ${status}`, message: failed.join("\n") });
    }
    return { status, parts, uploaded: uploaded.map((u) => u.name), failed: failed.length, warnings: warnings.length };
  };
}

export const handler = createHandler();
