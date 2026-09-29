// Warehouse interface: analytical store for cleaned data and aggregates (ClickHouse now, BigQuery later).
// Pipeline and API code only call these methods; all SQL lives inside the implementation.

/** Logical table names. Implementations map them to their own tables. */
export const TABLES = Object.freeze(["locations", "hourly_weather", "forecast_snapshots", "alerts", "pipeline_runs"]);

/** Periods the stats query can group by (all use each city's local time). */
export const PERIODS = Object.freeze(["hour", "day", "week", "month", "quarter", "half", "year"]);

/** hourly_weather columns that can be aggregated. */
export const METRICS = Object.freeze([
  "temp_c", "apparent_temp_c", "dew_point_c", "rel_humidity_pct", "precip_mm", "rain_mm", "snowfall_cm",
  "cloud_cover_pct", "pressure_msl_hpa", "wind_speed_ms", "wind_gust_ms",
]);

export class Warehouse {
  async connect() { throw new Error("Warehouse.connect not implemented"); }

  async close() { throw new Error("Warehouse.close not implemented"); }

  /** Can the warehouse be reached? Used by /health. */
  async ping() { throw new Error("Warehouse.ping not implemented"); }

  /** Create the database and tables if missing (idempotent). */
  async ensureSchema() { throw new Error("Warehouse.ensureSchema not implemented"); }

  /**
   * Insert rows into a logical table. Re-inserting the same natural key must not create duplicates
   * (deduplicated by the implementation, e.g. ReplacingMergeTree). Dates are JS Dates in UTC.
   * @param {string} table one of TABLES
   * @param {object[]} rows
   * @returns {Promise<number>} rows sent
   */
  async insert(table, rows) { throw new Error("Warehouse.insert not implemented"); }

  /** Latest `fetched_at` loaded into a table (Stage 2 incremental watermark), or null when empty. */
  async latestFetchedAt(table) { throw new Error("Warehouse.latestFetchedAt not implemented"); }

  /** Distinct rows by natural key (after deduplication). */
  async countRows(table) { throw new Error("Warehouse.countRows not implemented"); }

  /**
   * Aggregate one metric per location and period, grouped by each location's local time.
   * @param {{ locationIds: string[], metric: string, period: string, from: string, to: string }} q
   *        from/to are local dates, inclusive (YYYY-MM-DD)
   * @returns {Promise<Array<{ location_id: string, period_start: string, min: number|null, max: number|null,
   *          avg: number|null, sum: number|null, n_values: number, n_hours: number }>>}
   *          n_values counts non-null measurements; n_hours counts all hours in the period
   */
  async queryStats(q) { throw new Error("Warehouse.queryStats not implemented"); }
}
