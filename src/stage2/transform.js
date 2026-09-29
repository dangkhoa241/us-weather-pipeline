// src/stage2/transform.js
// Raw-store documents → warehouse rows (warehouse-neutral). Adds local_time from each city's time zone and runs
// simple range checks: rows with impossible values go to quarantine instead of the table. Nulls stay null.

import { localWallClock } from "../lib/time.js";

// Plausible ranges; a value outside means a broken record, not weather.
const RANGES = {
  temp_c: [-70, 60],
  apparent_temp_c: [-90, 75],
  dew_point_c: [-80, 40],
  rel_humidity_pct: [0, 100],
  precip_mm: [0, 300],        // per hour
  snowfall_cm: [0, 100],
  wind_speed_ms: [0, 110],
  wind_gust_ms: [0, 130],
  pressure_msl_hpa: [850, 1090],
};

/** @returns {string|null} why the row is invalid, or null */
function rangeProblem(values) {
  for (const [field, [lo, hi]] of Object.entries(RANGES)) {
    const v = values[field];
    if (v != null && (typeof v !== "number" || Number.isNaN(v) || v < lo || v > hi)) return `${field}=${v} outside [${lo}, ${hi}]`;
  }
  return null;
}

const quarantineRow = (table, key, reason, doc, etlBatchId) => ({
  table_name: table,
  record_key: key,
  reason,
  payload: JSON.stringify(doc),
  etl_batch_id: etlBatchId,
});

/**
 * @param {object[]} docs  observations_hourly documents
 * @param {Map<string, string>} timeZones  location_id → IANA zone
 * @returns {{ rows: object[], quarantined: object[], nullTemp: number }}
 */
export function observationRows(docs, timeZones, etlBatchId) {
  const rows = [];
  const quarantined = [];
  let nullTemp = 0;
  for (const { _id, first_seen_at, stored_at, ...doc } of docs) {
    const key = `${doc.location_id}|${doc.time.toISOString()}`;
    const tz = timeZones.get(doc.location_id);
    const problem = !tz ? "unknown location" : rangeProblem(doc);
    if (problem) {
      quarantined.push(quarantineRow("hourly_weather", key, problem, doc, etlBatchId));
      continue;
    }
    if (doc.temp_c == null) nullTemp += 1;
    rows.push({ ...doc, local_time: localWallClock(doc.time, tz) });
  }
  return { rows, quarantined, nullTemp };
}

/** forecast_snapshots documents → flat rows (values.* become columns). */
export function forecastRows(docs, timeZones, etlBatchId) {
  const rows = [];
  const quarantined = [];
  for (const { _id, first_seen_at, stored_at, values = {}, ...doc } of docs) {
    const key = `${doc.location_id}|${doc.model}|${doc.kind}|${doc.issued_at.toISOString()}|${doc.target_time.toISOString()}`;
    const tz = timeZones.get(doc.location_id);
    const problem = !tz ? "unknown location" : rangeProblem(values);
    if (problem) {
      quarantined.push(quarantineRow("forecast_snapshots", key, problem, { ...doc, values }, etlBatchId));
      continue;
    }
    rows.push({
      ...doc,
      ...values,
      exclude_from_accuracy: doc.exclude_from_accuracy ? 1 : 0,
      local_target_time: localWallClock(doc.target_time, tz),
    });
  }
  return { rows, quarantined };
}

/** alerts documents → rows (text fields the warehouse doesn't keep are ignored by the insert). */
export function alertRows(docs) {
  return docs.map(({ _id, first_seen_at, stored_at, ...doc }) => doc);
}

/** Local days (YYYY-MM-DD) touched by hourly rows, per location: the rollup refresh range. */
export function touchedDays(rows) {
  const byLocation = new Map();
  for (const { location_id, local_time } of rows) {
    const day = local_time.toISOString().slice(0, 10);
    const range = byLocation.get(location_id);
    if (!range) byLocation.set(location_id, { from: day, to: day });
    else {
      if (day < range.from) range.from = day;
      if (day > range.to) range.to = day;
    }
  }
  return byLocation;
}
