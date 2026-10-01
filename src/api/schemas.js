// src/api/schemas.js
// API request and response schemas, shared by the backend (validation + OpenAPI, backend/app.js) and the dashboard
// (TypeScript types via z.infer + client-side checks). Plain Zod with .meta() so it runs in Node and the browser.

import { z } from "zod";
import { PATTERNS, METRICS, PERIODS, DRILL_LEVELS, COMPARE, STAGES, LIMITS } from "./params.js";

// ---- Request parameters (query objects reject unknown keys) -------------------------------------------------
export const locationId = z.string().regex(new RegExp(PATTERNS.locationId)).meta({ example: "stockton-ca" });
export const isoDate = z.string().regex(new RegExp(PATTERNS.date)).meta({ example: "2026-09-01" });
const range = { from: isoDate.optional(), to: isoDate.optional() };
export const locationList = z.string().max(1000)
  .transform((s) => s.split(","))
  .pipe(z.array(locationId).min(1).max(LIMITS.maxLocations))
  .meta({ example: "stockton-ca,miami-fl", description: "comma-separated location ids" });

export const metric = z.enum(METRICS);
export const period = z.enum(PERIODS);
export const compare = z.enum(COMPARE);

export const QUERY = {
  none: z.object({}).strict(),
  stats: z.object({
    locations: locationList,
    metric: metric.default("temp_c"),
    period: period.default("day"),
    compare: compare.optional(),
    ...range,
  }).strict(),
  map: z.object(range).strict(),
  drill: z.object({
    location: locationId,
    level: z.enum(DRILL_LEVELS),
    key: z.string().regex(new RegExp(PATTERNS.drillKey)).meta({ example: "2025-Q3" }),
    metric: metric.default("temp_c"),
  }).strict(),
  forecastParams: z.object({ locationId }).strict(),
  forecast: z.object({ days: z.coerce.number().int().min(1).max(LIMITS.maxForecastDays).default(7) }).strict(),
  alerts: z.object({ state: z.string().regex(new RegExp(PATTERNS.state)).optional() }).strict(),
  accuracy: z.object({ location: locationId.optional(), ...range }).strict(),
  records: z.object({ location: locationId }).strict(),
  runs: z.object({
    limit: z.coerce.number().int().min(1).max(LIMITS.maxRuns).default(50),
    stage: z.enum(STAGES).optional(),
  }).strict(),
};

// ---- Response rows (what `data` contains) -------------------------------------------------------------------
const num = z.number().nullable();   // nulls stay null: missing data is never 0
export const ROW = {
  location: z.object({
    id: z.string(), name: z.string(), state: z.string(), region: z.string(),
    lat: z.number(), lon: z.number(), timezone: z.string(),
  }),
  stats: z.object({
    location_id: z.string(), period_start: z.string(),
    min: num, max: num, avg: num, sum: num, n_values: z.number(), n_hours: z.number(),
  }),
  map: z.object({
    state: z.string(), region: z.string(), cities: z.number(),
    temp_avg_c: num, temp_max_c: num, precip_mm_per_city: num,
  }),
  accuracy: z.object({ model: z.string(), lead_days: z.number(), n: z.number(), mae_c: num, bias_c: num }),
  forecast: z.object({
    model: z.string(), issued_at: z.string(), target_time: z.string(),
    temp_c: num, precip_mm: num, precip_prob_pct: num, wind_speed_ms: num,
  }),
  records: z.object({
    first_day: z.string(), last_day: z.string(), days: z.number(),
    hottest_day: z.string(), hottest_c: num, coldest_day: z.string(), coldest_c: num,
    wettest_day: z.string(), wettest_mm: num, windiest_day: z.string(), windiest_gust_ms: num,
  }).nullable(),
};

export const meta = z.object({
  source: z.string(),
  data_version: z.string().nullable().optional(),
  range: z.object({ from: z.string(), to: z.string() }).optional(),
}).passthrough();

/**
 * `{ data, meta }` envelope around a data schema.
 * @template {z.ZodType} T
 * @param {T} data
 */
export const envelope = (data) => z.object({ data, meta: meta.optional() });

export const RESPONSE = {
  locations: envelope(z.array(ROW.location)),
  stats: envelope(z.array(ROW.stats)).extend({
    compare: z.object({ from: z.string(), to: z.string(), data: z.array(ROW.stats) }).optional(),
  }),
  map: envelope(z.array(ROW.map)),
  drill: envelope(z.array(ROW.stats)),
  forecast: envelope(z.array(ROW.forecast)),
  accuracy: envelope(z.array(ROW.accuracy)),
  records: envelope(ROW.records),
  any: envelope(z.any()),
};

export const errorResponse = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
