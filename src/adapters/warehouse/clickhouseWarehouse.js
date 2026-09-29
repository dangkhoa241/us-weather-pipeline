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
      lead_hours Int32,
      lead_days Int16,
      temp_c Nullable(Float32),
      dew_point_c Nullable(Float32),
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
};

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

  async #rows(query, params) {
    const result = await this.client.query({ query, query_params: params, format: "JSONEachRow" });
    return result.json();
  }
}
