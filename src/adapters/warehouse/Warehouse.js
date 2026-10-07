// Warehouse interface: analytical store for cleaned data and aggregates (ClickHouse now, BigQuery later).
// Pipeline and API code only call these methods; all SQL lives inside the implementation.

/** Logical table names. Implementations map them to their own tables. */
export const TABLES = Object.freeze(["locations", "hourly_weather", "forecast_snapshots", "alerts", "pipeline_runs", "quarantine"]);

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

  /**
   * Recompute the daily and monthly rollups (per location, in local time) for local days `from`..`to`.
   * Idempotent: recomputed rows replace the old ones.
   * @param {{ locationIds: string[], from: string, to: string }} range  YYYY-MM-DD, inclusive
   */
  async refreshRollups(range) { throw new Error("Warehouse.refreshRollups not implemented"); }

  /**
   * Temperature forecast accuracy per model and lead day: MAE and bias (forecast − observed), hourly forecasts
   * joined with observations. Snapshots flagged exclude_from_accuracy are left out.
   * @param {{ from: string, to: string, locationIds?: string[] }} q  target dates (UTC), inclusive
   * `days` = distinct target dates with scores (the dashboard ranks a model only after enough days).
   * @returns {Promise<Array<{ model: string, lead_days: number, n: number, days: number, mae_c: number, bias_c: number }>>}
   */
  async accuracySummary(q) { throw new Error("Warehouse.accuracySummary not implemented"); }

  /**
   * Head-to-head with `model` (a fair comparison for a model with a short history): for each other model, both
   * errors over the (city, hour) pairs both were scored on. n = those pairs. Optional lead day (0 = all).
   * @param {{ from: string, to: string, lead: number, model: string }} q
   * @returns {Promise<Array<{ model: string, n: number, mae_c: number, target_mae_c: number }>>}
   */
  async accuracyMatched(q) { throw new Error("Warehouse.accuracyMatched not implemented"); }

  /**
   * Accuracy per state and model for one lead day (US map).
   * @param {{ from: string, to: string, lead: number }} q
   * @returns {Promise<Array<{ state: string, model: string, n: number, days: number, mae_c: number, bias_c: number }>>}
   */
  async accuracyByState(q) { throw new Error("Warehouse.accuracyByState not implemented"); }

  /**
   * Accuracy per month (UTC, "YYYY-MM-01") and model. Optional filters: locationIds, state, lead (0 = all lead days).
   * @returns {Promise<Array<{ month: string, model: string, n: number, mae_c: number, bias_c: number }>>}
   */
  async accuracyByMonth(q) { throw new Error("Warehouse.accuracyByMonth not implemented"); }

  /**
   * The largest hourly errors, at most one per city and day; same filters as accuracyByMonth plus `limit`.
   * Only forecasts with an exact issue time (best_match, whose issue time is approximate, is left out).
   * @returns {Promise<Array<{ target_time: string, location_id: string, model: string, lead_days: number,
   *          forecast_c: number, observed_c: number, error_c: number }>>}
   */
  async biggestMisses(q) { throw new Error("Warehouse.biggestMisses not implemented"); }

  /**
   * One row per state for the US map, from the daily rollups over local days `from`..`to`.
   * @returns {Promise<Array<{ state: string, region: string, cities: number, temp_avg_c: number|null,
   *          temp_max_c: number|null, precip_mm_per_city: number|null }>>}
   */
  async mapByState({ from, to }) { throw new Error("Warehouse.mapByState not implemented"); }

  /**
   * Hourly forecast for one location: the latest issued run of each model, for the next `days` days.
   * @returns {Promise<Array<{ model: string, issued_at: string, target_time: string, temp_c: number|null,
   *          precip_mm: number|null, precip_prob_pct: number|null, wind_speed_ms: number|null }>>}
   */
  async cityForecast({ locationId, days }) { throw new Error("Warehouse.cityForecast not implemented"); }

  /**
   * NWS 12-hour forecast periods for one location from the latest issued forecast, not yet ended.
   * @returns {Promise<Array<{ issued_at: string, target_time: string, target_end_time: string|null, local_target_time: string,
   *          temp_c: number|null, precip_prob_pct: number|null, wind_speed_ms: number|null, short_forecast: string|null }>>}
   */
  async forecastPeriods({ locationId }) { throw new Error("Warehouse.forecastPeriods not implemented"); }

  /** All locations (id, name, state, region, lat, lon, timezone), ordered by state and name. */
  async listLocations() { throw new Error("Warehouse.listLocations not implemented"); }

  /** Alerts that have not expired, optionally for one state (2-letter code). At most 200. */
  async activeAlerts({ state }) { throw new Error("Warehouse.activeAlerts not implemented"); }

  /** Record days for one location from the daily rollups (hottest, coldest, wettest, windiest; complete days only). */
  async records({ locationId }) { throw new Error("Warehouse.records not implemented"); }

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
