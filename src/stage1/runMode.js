// src/stage1/runMode.js
// Run one Stage 1 mode with its own pipeline_runs entry. Shared by the CLI (fetchWeather.js) and pipeline.js.

import { COLLECTIONS } from "../collections.js";
import { RunLog } from "../lib/runLog.js";
import { fetchHistory } from "./openMeteoHistory.js";
import { fetchForecasts } from "./nwsForecast.js";
import { fetchOpenMeteoForecasts } from "./openMeteoForecast.js";
import { backfillOpenMeteoRuns } from "./openMeteoBackfill.js";
import { backfillBestMatchBaseline } from "./openMeteoBaseline.js";
import { fetchAlerts } from "./nwsAlerts.js";
import { syncFromAtlas } from "./atlasSync.js";

export async function loadLocations(store, locationIds) {
  const filter = locationIds ? { id: { $in: locationIds } } : {};
  const locations = await store.find(COLLECTIONS.locations.name, filter, { sort: { id: 1 } });
  if (locationIds) {
    const missing = locationIds.filter((id) => !locations.some((l) => l.id === id));
    if (missing.length) throw new Error(`Unknown location(s): ${missing.join(", ")}`);
  }
  if (!locations.length) throw new Error("No locations found. Run: npm run seed:locations");
  return locations;
}

export const JOBS = {
  history: (store, locations, run, opts) => fetchHistory(store, locations, run, opts.range),
  forecast: (store, locations, run) => fetchForecasts(store, locations, run),
  "om-forecast": (store, locations, run) => fetchOpenMeteoForecasts(store, locations, run),
  "om-backfill": (store, locations, run, opts) => backfillOpenMeteoRuns(store, locations, run, { days: opts.days }),
  "om-baseline": (store, locations, run, opts) => backfillBestMatchBaseline(store, locations, run, { days: opts.days }),
  alerts: (store, locations, run, opts) => fetchAlerts(store, locations, run, opts.notifier),
  "sync-atlas": (store, locations, run) => syncFromAtlas(store, run),
};

/** Run one mode with its own run log; returns the run summary. */
export async function runMode(mode, store, notifier, opts) {
  const run = await new RunLog(store, { stage: "stage1", mode }).start();
  let summary;
  try {
    const locations = mode === "sync-atlas" ? [] : await loadLocations(store, opts.locationIds);
    await JOBS[mode](store, locations, run, { ...opts, notifier });
    summary = await run.finish();
  } catch (err) {
    summary = await run.finish(err);
  }
  const { status, etl_batch_id, rows_fetched, inserted, updated, unchanged, error_count, skipped_count, duration_ms } = summary;
  console.log(`[stage1:${mode}] ${status} in ${(duration_ms / 1000).toFixed(1)}s`,
    { etl_batch_id, rows_fetched, inserted, updated, unchanged, error_count, skipped_count });
  if (status !== "success") {
    await notifier.notify({
      level: status === "failed" ? "error" : "warn",
      title: `Stage 1 ${mode} ${status}`,
      message: `${error_count} error(s), batch ${etl_batch_id}`,
    });
  }
  return summary;
}
