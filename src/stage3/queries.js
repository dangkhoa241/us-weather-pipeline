// src/stage3/queries.js
// The dashboard's read queries in one place: how to run each on the Warehouse, how to normalize its parameters
// (so equivalent requests share one cache key), and which ones are popular enough to pre-warm.

import { createHash } from "node:crypto";

const sortedUnique = (ids = []) => [...new Set(ids)].sort();

export const QUERY_TYPES = {
  stats: {
    normalize: ({ locationIds, metric, period, from, to }) => ({ locationIds: sortedUnique(locationIds), metric, period, from, to }),
    run: (warehouse, p) => warehouse.queryStats(p),
  },
  map: {
    normalize: ({ from, to }) => ({ from, to }),
    run: (warehouse, p) => warehouse.mapByState(p),
  },
  accuracy: {
    normalize: ({ from, to, locationIds, state = "" }) => ({ from, to, locationIds: sortedUnique(locationIds), state }),
    run: (warehouse, p) => warehouse.accuracySummary(p),
  },
  accuracyStates: {
    normalize: ({ from, to, lead = 1 }) => ({ from, to, lead }),
    run: (warehouse, p) => warehouse.accuracyByState(p),
  },
  accuracyMonths: {
    normalize: ({ from, to, locationIds, state = "", lead = 0 }) => ({ from, to, locationIds: sortedUnique(locationIds), state, lead }),
    run: (warehouse, p) => warehouse.accuracyByMonth(p),
  },
  misses: {
    normalize: ({ from, to, locationIds, state = "", lead = 0, limit = 10 }) =>
      ({ from, to, locationIds: sortedUnique(locationIds), state, lead, limit }),
    run: (warehouse, p) => warehouse.biggestMisses(p),
  },
  forecast: {
    normalize: ({ locationId, days = 7 }) => ({ locationId, days }),
    run: (warehouse, p) => warehouse.cityForecast(p),
  },
  periods: {
    normalize: ({ locationId }) => ({ locationId }),
    run: (warehouse, p) => warehouse.forecastPeriods(p),
  },
  locations: {
    normalize: () => ({}),
    run: (warehouse) => warehouse.listLocations(),
  },
  alerts: {
    normalize: ({ state = "" } = {}) => ({ state }),
    run: (warehouse, p) => warehouse.activeAlerts(p),
  },
  records: {
    normalize: ({ locationId }) => ({ locationId }),
    run: (warehouse, p) => warehouse.records(p),
  },
};

export function normalizeQuery(type, params = {}) {
  const spec = QUERY_TYPES[type];
  if (!spec) throw new Error(`Unknown query type "${type}". Known: ${Object.keys(QUERY_TYPES).join(", ")}`);
  return spec.normalize(params);
}

/** Stable cache key: the same logical query always gives the same key, whatever the parameter order. */
export function queryKey(type, params, dataVersion) {
  const normalized = normalizeQuery(type, params);
  const canonical = JSON.stringify(normalized, Object.keys(normalized).sort());
  const hash = createHash("sha1").update(canonical).digest("hex").slice(0, 16);
  return `wx:q:${dataVersion}:${type}:${hash}`;
}

// ~10 realistic dashboard requests (dates inside the loaded data; observations end ~5 days before today).
const ALL_CITIES = [
  "anchorage-ak", "atlanta-ga", "boston-ma", "chicago-il", "denver-co", "detroit-mi", "honolulu-hi", "houston-tx",
  "kansas-city-mo", "las-vegas-nv", "los-angeles-ca", "miami-fl", "minneapolis-mn", "nashville-tn", "new-orleans-la",
  "new-york-ny", "philadelphia-pa", "phoenix-az", "seattle-wa", "stockton-ca",
];
export const BENCH_QUERIES = [
  { name: "stats day, 1 city, 30 d", type: "stats", params: { locationIds: ["stockton-ca"], metric: "temp_c", period: "day", from: "2026-08-25", to: "2026-09-23" } },
  { name: "stats week precip, 1 city, 90 d", type: "stats", params: { locationIds: ["miami-fl"], metric: "precip_mm", period: "week", from: "2026-06-26", to: "2026-09-23" } },
  { name: "stats month, 3 cities, 12 mo", type: "stats", params: { locationIds: ["new-york-ny", "chicago-il", "los-angeles-ca"], metric: "temp_c", period: "month", from: "2025-10-01", to: "2026-09-23" } },
  { name: "stats quarter, 5 cities, 2 y", type: "stats", params: { locationIds: ["phoenix-az", "denver-co", "seattle-wa", "houston-tx", "boston-ma"], metric: "temp_c", period: "quarter", from: "2024-10-01", to: "2026-09-23" } },
  { name: "stats year, all cities, 3 y", type: "stats", params: { locationIds: ALL_CITIES, metric: "temp_c", period: "year", from: "2023-10-01", to: "2026-09-23" } },
  { name: "map by state, 7 d", type: "map", params: { from: "2026-09-17", to: "2026-09-23" } },
  { name: "map by state, 30 d", type: "map", params: { from: "2026-08-25", to: "2026-09-23" } },
  { name: "accuracy all cities, 60 d", type: "accuracy", params: { from: "2026-07-26", to: "2026-09-23" } },
  { name: "accuracy 1 city, 30 d", type: "accuracy", params: { from: "2026-08-25", to: "2026-09-23", locationIds: ["stockton-ca"] } },
  { name: "forecast 1 city, 7 d", type: "forecast", params: { locationId: "stockton-ca", days: 7 } },
];

// What the dashboard's landing page requests by default: the national maps, the accuracy overview and a 12-month
// overview of all cities. These are pre-warmed after each Stage 2 run. Per-city pages (e.g. forecasts, 871 rows
// each) are not: at 150 cities they would cost ~25 MB of Redis per load (docs/analysis/caching.md).
export const POPULAR_QUERIES = [
  { type: "map", params: { from: "2026-09-17", to: "2026-09-23" } },
  { type: "map", params: { from: "2026-08-25", to: "2026-09-23" } },
  { type: "accuracy", params: { from: "2026-07-26", to: "2026-09-23" } },
  { type: "stats", params: { locationIds: ALL_CITIES, metric: "temp_c", period: "month", from: "2025-10-01", to: "2026-09-23" } },
];
