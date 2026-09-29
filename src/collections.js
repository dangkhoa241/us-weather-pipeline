// src/collections.js
// RawStore collection names and their natural unique keys (one place, so every stage agrees).

export const COLLECTIONS = Object.freeze({
  locations: { name: "locations", uniqueKey: ["id"], indexes: [["state"], ["region"]] },
  observationsHourly: {
    name: "observations_hourly",
    uniqueKey: ["location_id", "time"],
    indexes: [["fetched_at"], ["etl_batch_id"]],
  },
  forecastSnapshots: {
    name: "forecast_snapshots",
    uniqueKey: ["location_id", "model", "kind", "issued_at", "target_time"],   // model: "nws" or an Open-Meteo model
    indexes: [["fetched_at"], ["location_id", "target_time"]],
  },
  alerts: { name: "alerts", uniqueKey: ["id"], indexes: [["fetched_at"], ["states"], ["expires"]] },
  watermarks: { name: "watermarks", uniqueKey: ["source", "location_id"] },
  pipelineRuns: { name: "pipeline_runs", uniqueKey: ["etl_batch_id"], indexes: [["started_at"], ["stage"]] },
});

/** Create every collection's unique index (idempotent). */
export async function ensureCollections(store) {
  for (const { name, uniqueKey, indexes } of Object.values(COLLECTIONS)) {
    await store.ensureCollection(name, { uniqueKey, indexes });
  }
}
