// ClickHouse implementation of Warehouse. The only module that imports @clickhouse/client.
// Tables are ReplacingMergeTree keyed by the natural key, so re-loading the same rows never duplicates them.

import { createClient } from "@clickhouse/client";
import { Warehouse, TABLES, PERIODS, METRICS } from "./Warehouse.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const CLIENT_SETTINGS = {
  date_time_input_format: "best_effort",        // accept ISO strings from JSON-serialized JS Dates
  input_format_skip_unknown_fields: 1,          // callers may pass extra fields
  output_format_json_quote_64bit_integers: 0,   // counts come back as numbers
};

// Measurement columns shared by hourly_weather (all Nullable: missing stays NULL, never 0).
const MEASUREMENTS = `
  temp_c Nullable(Float32),
  apparent_temp_c Nullable(Float32),
  dew_point_c Nullable(Float32),
  rel_humidity_pct Nullable(Float32),
  precip_mm Nullable(Float32),
  rain_mm Nullable(Float32),
  snowfall_cm Nullable(Float32),
  cloud_cover_pct Nullable(Float32),
  pressure_msl_hpa Nullable(Float32),
  wind_speed_ms Nullable(Float32),
  wind_gust_ms Nullable(Float32),
  wind_dir_deg Nullable(Float32),
  weather_code Nullable(UInt8)`;

const LOAD_META = `
  etl_batch_id String,
  fetched_at DateTime64(3, 'UTC'),
  loaded_at DateTime64(3, 'UTC') DEFAULT now64(3)`;

const DDL = {
  locations: `
    CREATE TABLE IF NOT EXISTS locations (
      id String,
      name String,
      state LowCardinality(String),
      region LowCardinality(String),
      lat Float64,
      lon Float64,
      timezone LowCardinality(String),
      nws_office Nullable(String),
      updated_at DateTime64(3, 'UTC')
    ) ENGINE = ReplacingMergeTree(updated_at)
    ORDER BY id`,

  hourly_weather: `
    CREATE TABLE IF NOT EXISTS hourly_weather (
      location_id LowCardinality(String),
      time DateTime('UTC'),
      local_time DateTime('UTC') COMMENT 'wall-clock time in the location time zone (for local day/week/... grouping)',
      source LowCardinality(String),
      ${MEASUREMENTS},
      ${LOAD_META}
    ) ENGINE = ReplacingMergeTree(fetched_at)
    PARTITION BY toYYYYMM(time)
    ORDER BY (location_id, time)`,

  forecast_snapshots: `
    CREATE TABLE IF NOT EXISTS forecast_snapshots (
      location_id LowCardinality(String),
      source LowCardinality(String),
      model LowCardinality(String),
      kind LowCardinality(String),
      issued_at DateTime('UTC'),
      issued_at_basis LowCardinality(String),
      target_time DateTime('UTC'),
      target_end_time DateTime('UTC'),
      local_target_time DateTime('UTC') COMMENT 'wall-clock target time in the location time zone',
      lead_hours Nullable(Int32) COMMENT 'null when the run time is only approximate (best_match baseline)',
      lead_days Int16,
      fetch_method LowCardinality(Nullable(String)),
      exclude_from_accuracy UInt8 DEFAULT 0,
      temp_c Nullable(Float32),
      apparent_temp_c Nullable(Float32),
      dew_point_c Nullable(Float32),
      cloud_cover_pct Nullable(Float32),
      rel_humidity_pct Nullable(Float32),
      precip_prob_pct Nullable(Float32),
      precip_mm Nullable(Float32),
      wind_speed_ms Nullable(Float32),
      wind_gust_ms Nullable(Float32),
      wind_dir LowCardinality(Nullable(String)),
      weather_code Nullable(UInt8),
      short_forecast Nullable(String),
      ${LOAD_META}
    ) ENGINE = ReplacingMergeTree(fetched_at)
    PARTITION BY toYYYYMM(target_time)
    ORDER BY (location_id, model, kind, target_time, issued_at)`,

  alerts: `
    CREATE TABLE IF NOT EXISTS alerts (
      id String,
      event LowCardinality(String),
      headline Nullable(String),
      severity LowCardinality(Nullable(String)),
      urgency LowCardinality(Nullable(String)),
      certainty LowCardinality(Nullable(String)),
      status LowCardinality(Nullable(String)),
      message_type LowCardinality(Nullable(String)),
      area_desc Nullable(String),
      states Array(LowCardinality(String)),
      location_ids Array(String),
      sent Nullable(DateTime('UTC')),
      effective Nullable(DateTime('UTC')),
      onset Nullable(DateTime('UTC')),
      expires Nullable(DateTime('UTC')),
      ends Nullable(DateTime('UTC')),
      ${LOAD_META}
    ) ENGINE = ReplacingMergeTree(fetched_at)
    ORDER BY id`,

  pipeline_runs: `
    CREATE TABLE IF NOT EXISTS pipeline_runs (
      etl_batch_id String,
      pipeline LowCardinality(String),
      stage LowCardinality(String),
      mode LowCardinality(String),
      status LowCardinality(String),
      started_at DateTime64(3, 'UTC'),
      finished_at Nullable(DateTime64(3, 'UTC')),
      duration_ms Nullable(UInt64),
      rows_in UInt64 DEFAULT 0,
      rows_out UInt64 DEFAULT 0,
      error_count UInt32 DEFAULT 0,
      updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(updated_at)
    ORDER BY etl_batch_id`,

  quarantine: `
    CREATE TABLE IF NOT EXISTS quarantine (
      table_name LowCardinality(String),
      record_key String,
      reason String,
      payload String COMMENT 'the rejected row as JSON',
      etl_batch_id String,
      quarantined_at DateTime64(3, 'UTC') DEFAULT now64(3)
    ) ENGINE = ReplacingMergeTree(quarantined_at)
    ORDER BY (table_name, record_key)`,
};

// Rollups and views: derived from the tables above, so they are not insert targets.
const DERIVED_DDL = [
  `CREATE TABLE IF NOT EXISTS weather_daily (
      location_id LowCardinality(String),
      day Date COMMENT 'local day in the location time zone',
      temp_min_c Nullable(Float32),
      temp_max_c Nullable(Float32),
      temp_avg_c Nullable(Float32),
      precip_sum_mm Nullable(Float32),
      snowfall_sum_cm Nullable(Float32),
      wind_max_ms Nullable(Float32),
      gust_max_ms Nullable(Float32),
      rel_humidity_avg_pct Nullable(Float32),
      hours UInt8 COMMENT 'hours present (24 = complete day; 23/25 on DST days)',
      computed_at DateTime64(3, 'UTC')
    ) ENGINE = ReplacingMergeTree(computed_at)
    PARTITION BY toYear(day)
    ORDER BY (location_id, day)`,

  `CREATE TABLE IF NOT EXISTS weather_monthly (
      location_id LowCardinality(String),
      month Date COMMENT 'first local day of the month',
      temp_min_c Nullable(Float32),
      temp_max_c Nullable(Float32),
      temp_avg_c Nullable(Float32),
      precip_sum_mm Nullable(Float32),
      snowfall_sum_cm Nullable(Float32),
      wind_max_ms Nullable(Float32),
      gust_max_ms Nullable(Float32),
      hours UInt16,
      computed_at DateTime64(3, 'UTC')
    ) ENGINE = ReplacingMergeTree(computed_at)
    ORDER BY (location_id, month)`,

  `CREATE VIEW IF NOT EXISTS forecast_accuracy AS
    SELECT
      f.location_id AS location_id, f.source AS source, f.model AS model, f.kind AS kind,
      f.issued_at AS issued_at, f.issued_at_basis AS issued_at_basis, f.target_time AS target_time,
      f.lead_hours AS lead_hours, f.lead_days AS lead_days,
      f.temp_c AS forecast_temp_c, o.temp_c AS observed_temp_c,
      f.temp_c - o.temp_c AS temp_error_c, abs(f.temp_c - o.temp_c) AS temp_abs_error_c,
      f.precip_mm AS forecast_precip_mm, o.precip_mm AS observed_precip_mm
    FROM (
      SELECT * FROM forecast_snapshots FINAL
      WHERE kind = 'hourly' AND exclude_from_accuracy = 0 AND temp_c IS NOT NULL
    ) AS f
    INNER JOIN (
      SELECT location_id, time, temp_c, precip_mm FROM hourly_weather FINAL WHERE temp_c IS NOT NULL
    ) AS o ON f.location_id = o.location_id AND f.target_time = o.time`,
];

// Filters shared by the accuracy queries (all values are query_params): target dates, optional cities, optional
// state (via the locations table), optional lead day (0 = all lead days).
const ACCURACY_FILTER = `
        toDate(target_time) BETWEEN {from:Date} AND {to:Date}
        AND (empty({ids:Array(String)}) OR location_id IN {ids:Array(String)})
        AND (empty({state:String}) OR location_id IN (SELECT id FROM locations FINAL WHERE state = {state:String}))
        AND ({lead:UInt8} = 0 OR lead_days = {lead:UInt8})`;

function accuracyParams({ from, to, locationIds = [], state = "", lead = 0 }) {
  if (!DAY.test(from) || !DAY.test(to)) throw new Error("from/to must be dates like 2024-01-31");
  if (state && !/^[A-Z]{2}$/.test(state)) throw new Error("state must be a 2-letter code");
  if (!Number.isInteger(lead) || lead < 0 || lead > 16) throw new Error("lead must be 0..16");
  return { from, to, ids: locationIds ?? [], state, lead };
}

// Aggregates shared by the daily and monthly rollups (NULL when a day/month has no values).
const ROLLUP_AGGREGATES = `
      min(temp_c), max(temp_c), round(avg(temp_c), 2),
      if(count(precip_mm) = 0, NULL, round(sum(precip_mm), 2)),
      if(count(snowfall_cm) = 0, NULL, round(sum(snowfall_cm), 2)),
      max(wind_speed_ms), max(wind_gust_ms)`;

// Period builder: start of each period, from a location's local wall-clock time.
// Half-year = Jan 1 or Jul 1. Weeks start on Monday (ISO).
const PERIOD_START = {
  hour: "toStartOfHour(local_time)",
  day: "toDate(local_time)",
  week: "toMonday(local_time)",
  month: "toStartOfMonth(local_time)",
  quarter: "toStartOfQuarter(local_time)",
  half: "if(toMonth(local_time) <= 6, toStartOfYear(local_time), addMonths(toStartOfYear(local_time), 6))",
  year: "toStartOfYear(local_time)",
};

function assertTable(table) {
  if (!TABLES.includes(table)) throw new Error(`Unknown warehouse table "${table}". Known: ${TABLES.join(", ")}`);
}

export class ClickHouseWarehouse extends Warehouse {
  constructor({ url, user, password, db }) {
    super();
    if (!IDENTIFIER.test(db)) throw new Error(`Invalid ClickHouse database name "${db}"`);
    this.options = { url, username: user, password, clickhouse_settings: CLIENT_SETTINGS };
    this.db = db;
    this.client = null;
  }

  async connect() {
    this.client ??= createClient({ ...this.options, database: this.db });
    return this;
  }

  async close() {
    await this.client?.close();
    this.client = null;
  }

  async ping() {
    const res = await this.client.ping();
    return res.success;
  }

  async ensureSchema() {
    // The database may not exist yet, so create it from a client that is not bound to it.
    const admin = createClient(this.options);
    try {
      await admin.command({ query: "CREATE DATABASE IF NOT EXISTS {db:Identifier}", query_params: { db: this.db } });
    } finally {
      await admin.close();
    }
    for (const table of TABLES) await this.client.command({ query: DDL[table] });
    for (const query of DERIVED_DDL) await this.client.command({ query });
  }

  async refreshRollups({ locationIds, from, to }) {
    if (!locationIds.length) return;
    if (!DAY.test(from) || !DAY.test(to)) throw new Error("from/to must be dates like 2024-01-31");
    const params = { ids: locationIds, from, to };
    await this.client.command({
      query: `
        INSERT INTO weather_daily
        SELECT location_id, toDate(local_time) AS day, ${ROLLUP_AGGREGATES},
          round(avg(rel_humidity_pct), 1), count(), now64(3)
        FROM hourly_weather FINAL
        WHERE location_id IN {ids:Array(String)} AND toDate(local_time) BETWEEN {from:Date} AND {to:Date}
        GROUP BY location_id, day`,
      query_params: params,
    });
    // Whole months that contain any refreshed day.
    await this.client.command({
      query: `
        INSERT INTO weather_monthly
        SELECT location_id, toStartOfMonth(local_time) AS month, ${ROLLUP_AGGREGATES}, count(), now64(3)
        FROM hourly_weather FINAL
        WHERE location_id IN {ids:Array(String)}
          AND toStartOfMonth(local_time) BETWEEN toStartOfMonth({from:Date}) AND toStartOfMonth({to:Date})
        GROUP BY location_id, month`,
      query_params: params,
    });
  }

  async accuracySummary({ from, to, locationIds, state = "" }) {
    return this.#rows(`
      SELECT model, lead_days, count() AS n,
        round(avg(temp_abs_error_c), 2) AS mae_c, round(avg(temp_error_c), 2) AS bias_c
      FROM forecast_accuracy
      WHERE ${ACCURACY_FILTER}
      GROUP BY model, lead_days
      ORDER BY model, lead_days`,
    accuracyParams({ from, to, locationIds, state, lead: 0 }));
  }

  async accuracyByState({ from, to, lead }) {
    return this.#rows(`
      SELECT l.state AS state, a.model AS model, count() AS n,
        round(avg(a.temp_abs_error_c), 2) AS mae_c, round(avg(a.temp_error_c), 2) AS bias_c
      FROM forecast_accuracy AS a
      INNER JOIN (SELECT id, state FROM locations FINAL) AS l ON l.id = a.location_id
      WHERE toDate(a.target_time) BETWEEN {from:Date} AND {to:Date} AND a.lead_days = {lead:UInt8}
      GROUP BY state, model
      ORDER BY state, model`,
    accuracyParams({ from, to, lead }));
  }

  async accuracyByMonth({ from, to, locationIds, state = "", lead = 0 }) {
    return this.#rows(`
      SELECT toString(toStartOfMonth(target_time)) AS month, model, count() AS n,
        round(avg(temp_abs_error_c), 2) AS mae_c, round(avg(temp_error_c), 2) AS bias_c
      FROM forecast_accuracy
      WHERE ${ACCURACY_FILTER}
      GROUP BY month, model
      ORDER BY month, model`,
    accuracyParams({ from, to, locationIds, state, lead }));
  }

  async biggestMisses({ from, to, locationIds, state = "", lead = 0, limit = 10 }) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("limit must be 1..50");
    return this.#rows(`
      SELECT toString(target_time) AS target_time, location_id, model, lead_days,
        round(forecast_temp_c, 1) AS forecast_c, round(observed_temp_c, 1) AS observed_c, round(temp_error_c, 1) AS error_c
      FROM forecast_accuracy
      WHERE ${ACCURACY_FILTER}
        -- exact issue times only: best_match's issue time is approximate (lead day only), so it isn't a fair "miss"
        AND issued_at_basis NOT IN ('previous_runs_lead_day', 'fetch_hour')
      ORDER BY temp_abs_error_c DESC, target_time, model
      LIMIT 1 BY location_id, toDate(target_time)
      LIMIT {limit:UInt8}`,
    { ...accuracyParams({ from, to, locationIds, state, lead }), limit });
  }

  async insert(table, rows) {
    assertTable(table);
    if (!rows.length) return 0;
    await this.client.insert({ table, values: rows, format: "JSONEachRow" });
    return rows.length;
  }

  async latestFetchedAt(table) {
    assertTable(table);
    if (!["hourly_weather", "forecast_snapshots", "alerts"].includes(table)) {
      throw new Error(`${table} has no fetched_at column`);
    }
    const rows = await this.#rows(
      "SELECT if(count() = 0, NULL, max(fetched_at)) AS latest FROM {table:Identifier}", { table });
    return rows[0]?.latest ? new Date(`${rows[0].latest.replace(" ", "T")}Z`) : null;
  }

  async countRows(table) {
    assertTable(table);
    const rows = await this.#rows("SELECT count() AS n FROM {table:Identifier} FINAL", { table });
    return rows[0].n;
  }

  async queryStats({ locationIds, metric, period, from, to }) {
    if (!METRICS.includes(metric)) throw new Error(`Unknown metric "${metric}". Known: ${METRICS.join(", ")}`);
    if (!PERIODS.includes(period)) throw new Error(`Unknown period "${period}". Known: ${PERIODS.join(", ")}`);
    if (!DAY.test(from) || !DAY.test(to)) throw new Error("from/to must be dates like 2024-01-31");
    if (!Array.isArray(locationIds) || !locationIds.length) throw new Error("locationIds must be a non-empty array");

    // PERIOD_START values are fixed strings chosen by the whitelisted period; all inputs are query_params.
    return this.#rows(`
      SELECT
        location_id,
        toString(${PERIOD_START[period]}) AS period_start,
        min(m) AS min,
        max(m) AS max,
        round(avg(m), 3) AS avg,     -- Float32 storage: round away float noise
        round(sum(m), 3) AS sum,
        count(m) AS n_values,
        count() AS n_hours
      FROM (
        SELECT location_id, local_time, {metric:Identifier} AS m
        FROM hourly_weather FINAL
        WHERE location_id IN {ids:Array(String)}
          AND toDate(local_time) BETWEEN {from:Date} AND {to:Date}
      )
      GROUP BY location_id, period_start
      ORDER BY location_id, period_start`,
    { ids: locationIds, metric, from, to });
  }

  async mapByState({ from, to }) {
    if (!DAY.test(from) || !DAY.test(to)) throw new Error("from/to must be dates like 2024-01-31");
    return this.#rows(`
      SELECT l.state AS state, any(l.region) AS region, uniqExact(d.location_id) AS cities,
        round(avg(d.temp_avg_c), 2) AS temp_avg_c, max(d.temp_max_c) AS temp_max_c,
        round(sum(d.precip_sum_mm) / uniqExact(d.location_id), 1) AS precip_mm_per_city
      FROM weather_daily AS d FINAL
      INNER JOIN (SELECT id, state, region FROM locations FINAL) AS l ON l.id = d.location_id
      WHERE d.day BETWEEN {from:Date} AND {to:Date}
      GROUP BY state
      ORDER BY state`,
    { from, to });
  }

  async cityForecast({ locationId, days = 7 }) {
    if (typeof locationId !== "string" || !locationId) throw new Error("locationId is required");
    if (!Number.isInteger(days) || days < 1 || days > 16) throw new Error("days must be 1..16");
    return this.#rows(`
      SELECT model, issued_at, target_time,
        temp_c, precip_mm, precip_prob_pct, wind_speed_ms
      FROM forecast_snapshots FINAL
      WHERE location_id = {id:String} AND kind = 'hourly' AND exclude_from_accuracy = 0
        AND target_time >= toStartOfHour(now()) AND target_time < now() + toIntervalDay({days:UInt8})
        AND (model, issued_at) IN (
          SELECT model, max(issued_at) FROM forecast_snapshots
          WHERE location_id = {id:String} AND kind = 'hourly' AND exclude_from_accuracy = 0
          GROUP BY model)
      ORDER BY model, target_time`,
    { id: locationId, days });
  }

  async forecastPeriods({ locationId }) {
    if (typeof locationId !== "string" || !locationId) throw new Error("locationId is required");
    return this.#rows(`
      SELECT issued_at, target_time, target_end_time, local_target_time, temp_c, precip_prob_pct, wind_speed_ms, short_forecast
      FROM forecast_snapshots FINAL
      WHERE location_id = {id:String} AND source = 'nws' AND kind = 'periods'
        AND ifNull(target_end_time, target_time + toIntervalHour(12)) > now()
        AND issued_at = (SELECT max(issued_at) FROM forecast_snapshots WHERE location_id = {id:String} AND source = 'nws' AND kind = 'periods')
      ORDER BY target_time`,
    { id: locationId });
  }

  async listLocations() {
    return this.#rows(`
      SELECT id, name, state, region, lat, lon, timezone FROM locations FINAL ORDER BY state, name`, {});
  }

  async activeAlerts({ state = "" } = {}) {
    if (state && !/^[A-Z]{2}$/.test(state)) throw new Error("state must be a 2-letter code");
    return this.#rows(`
      SELECT id, event, severity, urgency, certainty, headline, area_desc, states, location_ids, onset, expires, ends
      FROM alerts FINAL
      WHERE (expires IS NULL OR expires > now()) AND (empty({state:String}) OR has(states, {state:String}))
      ORDER BY expires
      LIMIT 200`,
    { state });
  }

  async records({ locationId }) {
    if (typeof locationId !== "string" || !locationId) throw new Error("locationId is required");
    const rows = await this.#rows(`
      SELECT
        min(day) AS first_day, max(day) AS last_day, count() AS days,
        argMax(day, temp_max_c) AS hottest_day, max(temp_max_c) AS hottest_c,
        argMin(day, temp_min_c) AS coldest_day, min(temp_min_c) AS coldest_c,
        argMax(day, precip_sum_mm) AS wettest_day, max(precip_sum_mm) AS wettest_mm,
        argMax(day, gust_max_ms) AS windiest_day, max(gust_max_ms) AS windiest_gust_ms
      FROM weather_daily FINAL
      WHERE location_id = {id:String} AND hours >= 23   -- complete local days only (23 on DST days)
      HAVING days > 0`,
    { id: locationId });
    return rows[0] ?? null;
  }

  async #rows(query, params) {
    const result = await this.client.query({ query, query_params: params, format: "JSONEachRow" });
    return result.json();
  }
}
