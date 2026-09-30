// pipeline.js — orchestrator: Stage 1 → Stage 2 → Stage 3, stopping at the first failed stage.
// Stage 1 here is the quick catch-up (copy NWS data from Atlas, incremental history); the heavier Stage 1 jobs
// (live NWS, Open-Meteo backfills) keep their own schedules in the watcher. Each stage logs its own run in
// pipeline_runs; the pipeline adds one parent run listing the steps. Failures are sent to the Notifier.
// Usage: node pipeline.js   (the fetcher container runs it on PIPELINE_CRON)

import { createRawStore } from "./src/adapters/rawStore/index.js";
import { createWarehouse } from "./src/adapters/warehouse/index.js";
import { createCacheStore } from "./src/adapters/cacheStore/index.js";
import { createNotifier } from "./src/adapters/notifier/index.js";
import { ensureCollections } from "./src/collections.js";
import { RunLog } from "./src/lib/runLog.js";
import { runMode } from "./src/stage1/runMode.js";
import { runStage2 } from "./etlToClickHouse.js";
import { runStage3 } from "./clickhouseToRedis.js";

const STAGE1_MODES = ["sync-atlas", "history"];

/**
 * Run the pipeline once. `store` must be connected; the warehouse and cache are opened and closed here.
 * @returns {Promise<object>} the pipeline run summary (status "success" | "partial" | "failed")
 */
export async function runPipeline({ store, notifier }) {
  const run = await new RunLog(store, { stage: "pipeline", mode: "1-2-3" }).start();
  const steps = [];
  const record = (step, summary) => steps.push({
    step, status: summary.status, etl_batch_id: summary.etl_batch_id, duration_ms: summary.duration_ms,
  });
  const warehouse = createWarehouse();
  const cache = createCacheStore();
  let failed = null;
  let current = "stage1";   // the step running when something throws

  try {
    // Stage 1: a failed mode stops the pipeline; "partial" (e.g. one city failed) is a warning and continues.
    for (const mode of STAGE1_MODES) {
      current = `stage1:${mode}`;
      const summary = await runMode(mode, store, notifier, { range: {} });
      record(`stage1:${mode}`, summary);
      if (summary.status === "partial") run.error(null, new Error(`stage1:${mode} partial`));
      if (summary.status === "failed") throw new Error(`stage1:${mode} failed (batch ${summary.etl_batch_id})`);
    }

    current = "stage2";
    await warehouse.connect();
    record("stage2", await runStage2({ store, warehouse }));

    current = "stage3";
    await cache.connect();
    record("stage3", await runStage3({ store, warehouse, cache }));
  } catch (err) {
    const message = err.message || err.code || err.errors?.[0]?.code || String(err);   // ECONNREFUSED has no message
    failed = new Error(`${current}: ${message}`);
    if (!steps.some((s) => s.step === current)) steps.push({ step: current, status: "failed", message });
  } finally {
    await Promise.allSettled([warehouse.close(), cache.close()]);
  }

  run.set({ steps });
  const summary = await run.finish(failed ?? undefined);
  const line = steps.map((s) => `${s.step}:${s.status}`).join(" → ");
  console.log(`[pipeline] ${summary.status} in ${(summary.duration_ms / 1000).toFixed(1)}s: ${line}`);
  if (summary.status !== "success") {
    await notifier.notify({
      level: summary.status === "failed" ? "error" : "warn",
      title: `Pipeline ${summary.status}`,
      message: failed ? `${failed.message} (steps: ${line})` : `steps: ${line}`,
    });
  }
  return summary;
}

// Run directly: node pipeline.js
if (process.argv[1]?.endsWith("pipeline.js")) {
  const store = createRawStore();
  const notifier = createNotifier();
  try {
    await store.connect();
    await ensureCollections(store);
    const summary = await runPipeline({ store, notifier });
    if (summary.status === "failed") process.exitCode = 1;
  } catch (err) {
    console.error(`[pipeline] ${err.message}`);
    process.exitCode = 1;
  } finally {
    await store.close();
  }
}
