// clickhouseToRedis.js — Stage 3: refresh the dashboard cache after a Stage 2 load.
// The caching strategy lives in src/stage3/dashboard.js; this script tells it which data version is current
// (the latest successful Stage 2 run) and logs the run in pipeline_runs.
// Usage: node clickhouseToRedis.js

import { COLLECTIONS } from "./src/collections.js";
import { createRawStore } from "./src/adapters/rawStore/index.js";
import { createWarehouse } from "./src/adapters/warehouse/index.js";
import { createCacheStore } from "./src/adapters/cacheStore/index.js";
import { RunLog } from "./src/lib/runLog.js";
import { afterStage2 } from "./src/stage3/dashboard.js";

export async function runStage3({ store, warehouse, cache }) {
  const run = await new RunLog(store, { stage: "stage3", mode: "refresh" }).start();
  try {
    const stage2 = await store.findOne(COLLECTIONS.pipelineRuns.name, { stage: "stage2", status: "success" }, { sort: { finished_at: -1 } });
    if (!stage2) throw new Error("no successful Stage 2 run yet; run npm run etl:clickhouse first");
    const result = await afterStage2({ warehouse, cache, dataVersion: stage2.etl_batch_id, loadedAt: stage2.finished_at });
    run.add(result?.prewarmed ?? 0, { inserted: result?.prewarmed ?? 0 });
    console.log(`[stage3] cache refreshed for data version ${stage2.etl_batch_id}`, result ?? {});
    return await run.finish();
  } catch (err) {
    await run.finish(err);
    throw err;
  }
}

// Run directly: node clickhouseToRedis.js
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/").replace(/^\/?/, "/")}` || process.argv[1]?.endsWith("clickhouseToRedis.js")) {
  const store = createRawStore();
  const warehouse = createWarehouse();
  const cache = createCacheStore();
  try {
    await Promise.all([store.connect(), warehouse.connect(), cache.connect()]);
    const summary = await runStage3({ store, warehouse, cache });
    console.log(`[stage3] ${summary.status} in ${(summary.duration_ms / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error(`[stage3] ${err.message}`);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([store.close(), warehouse.close(), cache.close()]);
  }
}
