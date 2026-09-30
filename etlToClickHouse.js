// etlToClickHouse.js — Stage 2: RawStore (MongoDB) → Warehouse (ClickHouse).
// Incremental: loads documents stored since the last run (stored_at marker per collection), refreshes the
// daily/monthly rollups for the local days it touched, and logs the run. Re-running never duplicates rows.
// Usage: node etlToClickHouse.js [--full]   (--full reloads everything)

import { parseArgs } from "node:util";
import { config } from "./src/config.js";
import { COLLECTIONS, ensureCollections } from "./src/collections.js";
import { createRawStore } from "./src/adapters/rawStore/index.js";
import { createWarehouse } from "./src/adapters/warehouse/index.js";
import { RunLog } from "./src/lib/runLog.js";
import { observationRows, forecastRows, alertRows, touchedDays } from "./src/stage2/transform.js";

const BATCH = 20_000;
const WATERMARKS = COLLECTIONS.watermarks;

const LOADS = [
  { collection: COLLECTIONS.observationsHourly.name, table: "hourly_weather",
    transform: (docs, tz, id) => observationRows(docs, tz, id) },
  { collection: COLLECTIONS.forecastSnapshots.name, table: "forecast_snapshots",
    transform: (docs, tz, id) => forecastRows(docs, tz, id) },
  { collection: COLLECTIONS.alerts.name, table: "alerts",
    transform: (docs) => ({ rows: alertRows(docs), quarantined: [] }) },
];

async function loadCollection(store, warehouse, run, load, timeZones, full, touched) {
  const markerKey = { source: `stage2:${load.collection}`, location_id: "*" };
  const marker = full ? null : await store.findOne(WATERMARKS.name, markerKey);
  const startedAt = new Date();   // taken before reading: the next run picks up anything stored from now on
  const filter = marker ? { stored_at: { $gte: marker.last_time } } : {};
  const stats = { read: 0, loaded: 0, quarantined: 0, nullTemp: 0 };

  for await (const docs of store.findBatches(load.collection, filter, { batchSize: BATCH })) {
    const { rows, quarantined, nullTemp = 0 } = load.transform(docs, timeZones, run.etlBatchId);
    await warehouse.insert(load.table, rows);
    if (quarantined.length) await warehouse.insert("quarantine", quarantined);
    if (load.table === "hourly_weather") {
      for (const [id, range] of touchedDays(rows)) {
        const t = touched.get(id);
        touched.set(id, t ? { from: range.from < t.from ? range.from : t.from, to: range.to > t.to ? range.to : t.to } : range);
      }
    }
    stats.read += docs.length;
    stats.loaded += rows.length;
    stats.quarantined += quarantined.length;
    stats.nullTemp += nullTemp;
    run.add(docs.length, { inserted: rows.length });
    console.log(`[stage2] ${load.table}: ${stats.read} read, ${stats.loaded} loaded so far`);
  }

  await store.upsertMany(WATERMARKS.name, [{ ...markerKey, last_time: startedAt, updated_at: new Date() }], WATERMARKS.uniqueKey);
  if (stats.quarantined) run.skip(null, `${load.table}: ${stats.quarantined} rows quarantined (range checks)`);
  const nullRate = load.table === "hourly_weather" && stats.loaded ? ` (temp null rate ${(100 * stats.nullTemp / stats.loaded).toFixed(2)}%)` : "";
  console.log(`[stage2] ${load.table}: ${stats.loaded} of ${stats.read} rows loaded, ${stats.quarantined} quarantined${nullRate}`);
}

/**
 * Run Stage 2 with already-connected stores. Returns the run summary; throws (after logging the run) on failure.
 * @param {{ store, warehouse, full?: boolean }} deps
 */
export async function runStage2({ store, warehouse, full = false }) {
  await ensureCollections(store);
  await warehouse.ensureSchema();
  const run = await new RunLog(store, { stage: "stage2", mode: full ? "full" : "incremental" }).start();
  try {
    const locations = await store.find(COLLECTIONS.locations.name);
    await warehouse.insert("locations", locations.map(({ _id, first_seen_at, stored_at, ...l }) => l));
    const timeZones = new Map(locations.map((l) => [l.id, l.timezone]));

    const touched = new Map();   // location_id → local days loaded (rollup refresh range)
    for (const load of LOADS) await loadCollection(store, warehouse, run, load, timeZones, full, touched);

    if (touched.size) {
      const ranges = [...touched.values()];
      const from = ranges.map((r) => r.from).sort()[0];
      const to = ranges.map((r) => r.to).sort().at(-1);
      await warehouse.refreshRollups({ locationIds: [...touched.keys()], from, to });
      console.log(`[stage2] rollups refreshed for ${touched.size} locations, ${from}..${to}`);
    }
    const summary = await run.finish();
    await logRunInWarehouse(warehouse, summary);
    console.log(`[stage2] ${summary.status} in ${(summary.duration_ms / 1000).toFixed(1)}s`);
    return summary;
  } catch (err) {
    const summary = await run.finish(err);
    await logRunInWarehouse(warehouse, summary).catch(() => {});
    throw err;
  }
}

/** Mirror the run into the warehouse's pipeline_runs (for the Pipeline Ops page). */
async function logRunInWarehouse(warehouse, s) {
  await warehouse.insert("pipeline_runs", [{
    etl_batch_id: s.etl_batch_id, pipeline: config.pipelineName, stage: s.stage, mode: s.mode, status: s.status,
    started_at: new Date(s.finished_at.getTime() - s.duration_ms), finished_at: s.finished_at, duration_ms: s.duration_ms,
    rows_in: s.rows_fetched, rows_out: s.inserted, error_count: s.error_count,
  }]);
}

// Run directly: node etlToClickHouse.js [--full]
if (process.argv[1]?.endsWith("etlToClickHouse.js")) {
  const { values } = parseArgs({ options: { full: { type: "boolean", default: false } } });
  const store = createRawStore();
  const warehouse = createWarehouse();
  try {
    await Promise.all([store.connect(), warehouse.connect()]);
    await runStage2({ store, warehouse, full: values.full });
  } catch (err) {
    console.error(`[stage2] ${err.message}`);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([warehouse.close(), store.close()]);
  }
}
