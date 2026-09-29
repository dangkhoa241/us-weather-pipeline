// fetchWeather.js — Stage 1: weather APIs (NWS, Open-Meteo) → RawStore (MongoDB).
// Run `node fetchWeather.js --help` for usage.

import { parseArgs } from "node:util";
import { config } from "./src/config.js";
import { COLLECTIONS, ensureCollections } from "./src/collections.js";
import { createRawStore } from "./src/adapters/rawStore/index.js";
import { createNotifier } from "./src/adapters/notifier/index.js";
import { createScheduler } from "./src/adapters/scheduler/index.js";
import { RunLog } from "./src/lib/runLog.js";
import { fetchHistory, archiveEndDay } from "./src/stage1/openMeteoHistory.js";
import { fetchForecasts } from "./src/stage1/nwsForecast.js";
import { fetchOpenMeteoForecasts } from "./src/stage1/openMeteoForecast.js";
import { fetchAlerts } from "./src/stage1/nwsAlerts.js";

const HELP = `
Usage: node fetchWeather.js [mode] [options]

Modes (default: all):
  history      Open-Meteo hourly history → observations_hourly
               incremental from each location's watermark (first run: last ${config.stage1.historyYears} years)
  forecast     NWS hourly + 12-hour forecasts → forecast_snapshots (model "nws")
  om-forecast  Open-Meteo hourly forecasts → forecast_snapshots, one per model:
               ${config.stage1.openMeteoForecastModels.join(", ")}
  alerts       NWS active alerts for tracked states → alerts
  all          history, forecast, om-forecast and alerts

Options:
  --location <id[,id…]>  only these locations (e.g. stockton-ca)
  --from <YYYY-MM-DD>    history backfill start (turns off incremental mode)
  --to <YYYY-MM-DD>      history backfill end (default and max: ${archiveEndDay()}, the archive lag limit)
  --watch                keep running on a schedule:
                           forecast "${config.stage1.forecastCron}", om-forecast "${config.stage1.openMeteoForecastCron}",
                           alerts "${config.stage1.alertsCron}", history "${config.stage1.historyCron}"
  -h, --help             show this help

Examples:
  node fetchWeather.js
  node fetchWeather.js history --location stockton-ca --from 2023-01-01 --to 2023-12-31
  node fetchWeather.js --watch
`;

const MODES = ["history", "forecast", "om-forecast", "alerts"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseCli() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      location: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      watch: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (positionals.length > 1) throw new Error(`Give one mode, not "${positionals.join(" ")}"`);
  const mode = positionals[0] ?? "all";
  if (![...MODES, "all"].includes(mode)) throw new Error(`Unknown mode "${mode}". Use one of: ${MODES.join(", ")}, all`);
  for (const key of ["from", "to"]) {
    if (values[key] && (!DAY_RE.test(values[key]) || Number.isNaN(Date.parse(values[key])))) {
      throw new Error(`--${key} must be a date like 2024-01-31`);
    }
  }
  if (values.to && !values.from) throw new Error("--to needs --from");
  if (values.from && values.to && values.from > values.to) throw new Error("--from is after --to");
  return {
    help: values.help,
    watch: values.watch,
    modes: mode === "all" ? MODES : [mode],
    locationIds: values.location?.split(",").map((s) => s.trim()).filter(Boolean),
    range: { from: values.from, to: values.to },
  };
}

async function loadLocations(store, locationIds) {
  const filter = locationIds ? { id: { $in: locationIds } } : {};
  const locations = await store.find(COLLECTIONS.locations.name, filter, { sort: { id: 1 } });
  if (locationIds) {
    const missing = locationIds.filter((id) => !locations.some((l) => l.id === id));
    if (missing.length) throw new Error(`Unknown location(s): ${missing.join(", ")}`);
  }
  if (!locations.length) throw new Error("No locations found. Run: npm run seed:locations");
  return locations;
}

const JOBS = {
  history: (store, locations, run, opts) => fetchHistory(store, locations, run, opts.range),
  forecast: (store, locations, run) => fetchForecasts(store, locations, run),
  "om-forecast": (store, locations, run) => fetchOpenMeteoForecasts(store, locations, run),
  alerts: (store, locations, run) => fetchAlerts(store, locations, run),
};

/** Run one mode with its own run log; returns the run summary. */
async function runMode(mode, store, notifier, opts) {
  const run = await new RunLog(store, { stage: "stage1", mode }).start();
  let summary;
  try {
    const locations = await loadLocations(store, opts.locationIds);
    await JOBS[mode](store, locations, run, opts);
    summary = await run.finish();
  } catch (err) {
    summary = await run.finish(err);
  }
  const { status, etl_batch_id, rows_fetched, inserted, updated, unchanged, error_count, duration_ms } = summary;
  console.log(`[stage1:${mode}] ${status} in ${(duration_ms / 1000).toFixed(1)}s`,
    { etl_batch_id, rows_fetched, inserted, updated, unchanged, error_count });
  if (status !== "success") {
    await notifier.notify({
      level: status === "failed" ? "error" : "warn",
      title: `Stage 1 ${mode} ${status}`,
      message: `${error_count} error(s), batch ${etl_batch_id}`,
    });
  }
  return summary;
}

async function runOnce(opts) {
  const store = createRawStore();
  const notifier = createNotifier();
  let failed = false;
  try {
    await store.connect();
    await ensureCollections(store);
    for (const mode of opts.modes) {
      const summary = await runMode(mode, store, notifier, opts);
      failed ||= summary.status !== "success";
    }
  } finally {
    await store.close();
  }
  if (failed) process.exitCode = 1;
}

async function watch(opts) {
  const store = createRawStore();
  const notifier = createNotifier();
  const scheduler = createScheduler({ notifier });
  const crons = {
    forecast: config.stage1.forecastCron,
    "om-forecast": config.stage1.openMeteoForecastCron,
    alerts: config.stage1.alertsCron,
    history: config.stage1.historyCron,
  };
  // Incremental only: an explicit backfill range makes no sense on a schedule.
  const jobOpts = { ...opts, range: {} };

  await store.connect();
  await ensureCollections(store);
  for (const mode of opts.modes) {
    scheduler.schedule(`stage1-${mode}`, crons[mode], async () => { await runMode(mode, store, notifier, jobOpts); });
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("[watch] stopping…");
    try {
      await scheduler.stop();
    } finally {
      await store.close();
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  // Run once right away so data starts flowing without waiting for the first tick.
  for (const mode of opts.modes) await runMode(mode, store, notifier, jobOpts);
  if (!stopping) await scheduler.start();
}

try {
  const opts = parseCli();
  if (opts.help) console.log(HELP);
  else if (opts.watch) await watch(opts);
  else await runOnce(opts);
} catch (err) {
  console.error(`[stage1] ${err.message}`);
  process.exitCode = 1;
}
