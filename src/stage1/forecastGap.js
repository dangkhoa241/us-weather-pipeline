// src/stage1/forecastGap.js
// Startup check for the watcher: if forecast collection was down (laptop off, Docker stopped), the newest
// snapshot is old. Warn and record the gap in pipeline_runs, so accuracy stats can explain missing lead times.

import { config } from "../config.js";
import { COLLECTIONS } from "../collections.js";

const HOUR_MS = 3_600_000;
const SNAPSHOTS = COLLECTIONS.forecastSnapshots.name;
const RUNS = COLLECTIONS.pipelineRuns.name;

// Watch mode → snapshot source it feeds.
const SOURCES = { forecast: "nws", "om-forecast": "open-meteo" };

/**
 * @param {string[]} modes  modes the watcher runs; only their sources are checked
 * @returns {Promise<object|null>} the pipeline_runs entry written, or null when collection is fresh
 */
export async function checkForecastGap(store, notifier, modes, now = new Date()) {
  const maxHours = config.stage1.forecastGapWarnHours;
  const gaps = [];
  for (const mode of modes) {
    const source = SOURCES[mode];
    if (!source) continue;
    const latest = await store.findOne(SNAPSHOTS, { source }, { sort: { fetched_at: -1 }, projection: { fetched_at: 1 } });
    const last = latest?.fetched_at ?? null;
    const hours = last ? (now - last) / HOUR_MS : null;
    if (last && hours <= maxHours) continue;
    gaps.push({ source, last_fetched_at: last, gap_hours: hours == null ? null : Math.round(hours * 10) / 10 });
  }
  if (!gaps.length) {
    console.log(`[watch] forecast snapshots are fresh (newer than ${maxHours} h)`);
    return null;
  }

  const summary = gaps
    .map((g) => `${g.source}: ${g.last_fetched_at ? `last ${g.last_fetched_at.toISOString()} (${g.gap_hours} h ago)` : "no snapshots yet"}`)
    .join("; ");
  console.warn(`[watch] WARNING forecast collection gap > ${maxHours} h - ${summary}`);
  await notifier.notify({ level: "warn", title: "Forecast collection gap", message: summary });

  const entry = {
    etl_batch_id: `stage1-gap-${now.toISOString().replace(/[-:.]/g, "")}`,
    pipeline: config.pipelineName,
    stage: "stage1",
    mode: "gap-check",
    status: "gap_detected",
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    threshold_hours: maxHours,
    gaps,   // gap per source: last_fetched_at → started_at (null = never collected)
  };
  await store.insertOne(RUNS, entry);
  return entry;
}
