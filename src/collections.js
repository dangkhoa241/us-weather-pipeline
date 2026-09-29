// src/collections.js
// RawStore collection names and their natural unique keys (one place, so every stage agrees).

import { config } from "./config.js";

export const COLLECTIONS = Object.freeze({
  locations: { name: "locations", uniqueKey: ["id"], indexes: [["state"], ["region"]] },
  observationsHourly: {
    name: "observations_hourly",
    uniqueKey: ["location_id", "time"],
    indexes: [["fetched_at"], ["etl_batch_id"], ["stored_at"]],
  },
  forecastSnapshots: {
    name: "forecast_snapshots",
    uniqueKey: ["location_id", "model", "kind", "issued_at", "target_time"],   // model: "nws" or an Open-Meteo model
    indexes: [["fetched_at"], ["location_id", "target_time"], ["stored_at"]],
    retentionField: "fetched_at",
  },
  alerts: { name: "alerts", uniqueKey: ["id"], indexes: [["fetched_at"], ["states"], ["expires"], ["stored_at"]], retentionField: "fetched_at" },
  watermarks: { name: "watermarks", uniqueKey: ["source", "location_id"] },
  pipelineRuns: { name: "pipeline_runs", uniqueKey: ["etl_batch_id"], indexes: [["started_at"], ["stage"]], retentionField: "started_at" },
  apiUsage: { name: "api_usage", uniqueKey: ["api", "period"] },   // weighted calls per UTC hour/day (src/lib/apiBudget.js)
});

/**
 * Create every collection's indexes (idempotent). With RAW_RETENTION_DAYS > 0 (the free Atlas cluster),
 * collections that have a retentionField get a TTL index so old documents are deleted automatically.
 */
export async function ensureCollections(store, retentionDays = config.retentionDays) {
  for (const { name, uniqueKey, indexes, retentionField } of Object.values(COLLECTIONS)) {
    const retention = retentionField && retentionDays > 0 ? { field: retentionField, days: retentionDays } : undefined;
    await store.ensureCollection(name, { uniqueKey, indexes, retention });
  }
}
