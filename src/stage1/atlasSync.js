// src/stage1/atlasSync.js
// Copy what GitHub Actions collected on MongoDB Atlas (NWS forecasts, alerts, their run logs) into the local
// raw store. Incremental by a per-collection marker; upserts by natural key, so re-running never duplicates.
// Atlas keeps only RAW_RETENTION_DAYS (7) of data, so sync at least that often (warning after SYNC_WARN_DAYS).

import { config } from "../config.js";
import { COLLECTIONS } from "../collections.js";
import { createRawStore } from "../adapters/rawStore/index.js";

const WATERMARKS = COLLECTIONS.watermarks;
const RUNS = COLLECTIONS.pipelineRuns.name;
const BATCH = 5000;
const DAY_MS = 86_400_000;

// What to copy, and the date field that orders it. Runs are copied once finished (their final state).
const SYNCED = [
  { spec: COLLECTIONS.forecastSnapshots, field: "fetched_at" },
  { spec: COLLECTIONS.alerts, field: "fetched_at" },
  { spec: COLLECTIONS.pipelineRuns, field: "finished_at" },
];

export async function syncFromAtlas(localStore, run) {
  if (!config.atlas.uri) {
    run.skip(null, "ATLAS_MONGO_URI not set; nothing to sync");
    console.log("[sync-atlas] ATLAS_MONGO_URI not set; skipping");
    return;
  }
  const atlas = createRawStore(undefined, { uri: config.atlas.uri, db: config.atlas.db });
  try {
    await atlas.connect();
    for (const { spec, field } of SYNCED) {
      const markerKey = { source: `atlas-sync:${spec.name}`, location_id: "*" };
      const marker = (await localStore.findOne(WATERMARKS.name, markerKey))?.last_time ?? new Date(0);
      let since = marker;
      let copied = 0;
      for (;;) {
        // $gte + idempotent upserts: documents sharing the boundary timestamp are simply copied again.
        const docs = await atlas.find(spec.name, { [field]: { $gte: since } }, { sort: { [field]: 1 }, limit: BATCH });
        if (!docs.length) break;
        const result = await localStore.upsertMany(spec.name, docs.map((d) => ({ ...d, synced_from: "atlas" })), spec.uniqueKey);
        run.add(docs.length, result);
        copied += docs.length;
        const last = docs.at(-1)[field];
        const stuck = last.getTime() === since.getTime();   // a whole batch with one timestamp: stop, don't loop
        since = last;
        if (docs.length < BATCH || stuck) break;
      }
      if (since > marker) {
        await localStore.upsertMany(WATERMARKS.name, [{ ...markerKey, last_time: since, updated_at: new Date() }], WATERMARKS.uniqueKey);
      }
      console.log(`[sync-atlas] ${spec.name}: ${copied} documents copied (up to ${since.toISOString()})`);
    }
  } finally {
    await atlas.close();
  }
}

/**
 * Watcher startup check: warn and record in pipeline_runs when the last successful sync is older than
 * SYNC_WARN_DAYS (Atlas deletes data after RAW_RETENTION_DAYS, so a long gap loses NWS data for good).
 */
export async function checkSyncFreshness(store, notifier, now = new Date()) {
  if (!config.atlas.uri) return null;
  const last = await store.findOne(RUNS, { mode: "sync-atlas", status: "success" }, { sort: { finished_at: -1 } });
  const lastAt = last?.finished_at ?? null;
  const ageDays = lastAt ? (now - lastAt) / DAY_MS : null;
  if (lastAt && ageDays <= config.atlas.syncWarnDays) return null;

  const message = lastAt
    ? `last successful Atlas sync ${lastAt.toISOString()} (${ageDays.toFixed(1)} days ago)`
    : "no successful Atlas sync yet";
  console.warn(`[watch] WARNING ${message}; Atlas keeps ${config.retentionDays || 7} days of data`);
  await notifier.notify({ level: "warn", title: "Atlas sync is stale", message });
  const entry = {
    etl_batch_id: `stage1-sync-check-${now.toISOString().replace(/[-:.]/g, "")}`,
    pipeline: config.pipelineName,
    stage: "stage1",
    mode: "sync-check",
    status: "sync_stale",
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    threshold_days: config.atlas.syncWarnDays,
    last_success_at: lastAt,
    age_days: ageDays == null ? null : Math.round(ageDays * 10) / 10,
  };
  await store.insertOne(RUNS, entry);
  return entry;
}
