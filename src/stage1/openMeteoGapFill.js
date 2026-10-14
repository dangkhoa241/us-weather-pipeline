// src/stage1/openMeteoGapFill.js
// Fill accuracy gaps of the model forecasts from Open-Meteo's Previous Runs API → `forecast_snapshots`.
// A slot is (model, city, target hour, lead day N = 1..7). Only slots with no row at all (live om-forecast or the
// Single Runs backfill) are filled, insert-only, with the value the model forecast N days before the target hour.
// Like the best_match baseline: lead_days is exact, issued_at = target − N days is approximate, lead_hours is null,
// and the rows are marked fetch_method "previous_runs" / issued_at_basis "previous_runs_lead_day".
// No double counting: the Single Runs backfill is still catching up and may later write a slot that was filled here.
// supersedeFilledSlots() then sets exclude_from_accuracy on the filled row, so each slot is scored from one source.
// A fill writes only after a --validate run found every model within MAX_DAY1_DIFF_F (validationGate).

import { config } from "../config.js";
import { COLLECTIONS } from "../collections.js";
import { openMeteoGet } from "../lib/http.js";
import { ApiBudget, BudgetExceeded } from "../lib/apiBudget.js";
import { coversLocation, maxLeadHours } from "./openMeteoForecast.js";

const PREVIOUS_RUNS_URL = "https://previous-runs-api.open-meteo.com/v1/forecast";
const SNAPSHOTS = COLLECTIONS.forecastSnapshots;
const OBSERVATIONS = COLLECTIONS.observationsHourly.name;
const WATERMARKS = COLLECTIONS.watermarks;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const LEAD_DAYS = [1, 2, 3, 4, 5, 6, 7];
const SLOT_LEADS = 8;              // slot number = hour index × 8 + lead day
const MERGE_GAP_DAYS = 14;         // a request costs at least 14 days: join ranges closer than that
const SUPERSEDE_MARKER = { source: "om-gap-fill:supersede", location_id: "*" };
// Bulk job: like the Single Runs backfill it takes at most this share of the budget, so live forecasts keep room.
const BUDGET_SHARE = 0.75;

export const FILL_METHOD = "previous_runs";
export const FILL_BASIS = "previous_runs_lead_day";
/** Largest accepted difference between Previous Runs and Single Runs/live lead-day-1 MAE (°F). */
export const MAX_DAY1_DIFF_F = 0.1;

// Temperature only (accuracy is scored on temperature): 7 lead-day variables → 1 weighted call per 14 days.
const VARIABLES = { temperature_2m: "temp_c" };

/** Weighted calls of one request: billed per 10 variables and per 14 days. */
export const requestWeight = (days) =>
  Math.max(1, (Object.keys(VARIABLES).length * LEAD_DAYS.length) / 10) * Math.max(1, days / 14);

/** Lead days a model's 00/06/12/18Z runs reach (HRRR's reach 48 h: lead day 1 only). */
export const leadDaysFor = (model) =>
  LEAD_DAYS.filter((n) => [0, 6, 12, 18].some((h) => maxLeadHours(model, h) > n * 24));

const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStart = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
const pairKey = (model, locationId) => `${model}|${locationId}`;
const cToF = (c) => c * 1.8;

/**
 * Index of the slots that already have rows (any source), and of the Single Runs/live lead-day-1 temperatures
 * (for validation). Slots are numbers: hour index from `fromMs` × 8 + lead day.
 */
export async function loadSlots(store, models, fromMs, toMs) {
  const filled = new Map();   // pair → Set(slot)
  const day1 = new Map();     // pair → Map(hour index → temps °C), collected rows only
  const filter = {
    model: { $in: models }, kind: "hourly", lead_days: { $gte: 1, $lte: 7 },
    target_time: { $gte: new Date(fromMs), $lte: new Date(toMs) },
  };
  const projection = { _id: 0, location_id: 1, model: 1, target_time: 1, lead_days: 1, fetch_method: 1, "values.temp_c": 1 };
  for await (const batch of store.findBatches(SNAPSHOTS.name, filter, { projection })) {
    for (const doc of batch) {
      const key = pairKey(doc.model, doc.location_id);
      const hour = Math.round((new Date(doc.target_time).getTime() - fromMs) / HOUR_MS);
      if (!filled.has(key)) filled.set(key, new Set());
      filled.get(key).add(hour * SLOT_LEADS + doc.lead_days);
      const temp = doc.values?.temp_c;
      if (doc.lead_days === 1 && doc.fetch_method !== FILL_METHOD && temp != null) {
        if (!day1.has(key)) day1.set(key, new Map());
        const temps = day1.get(key);
        temps.set(hour, [...(temps.get(hour) ?? []), temp]);
      }
    }
  }
  return { filled, day1 };
}

/**
 * Request ranges for one (model, city): the days `wanted(day)` says yes to, joined into ranges when the days between
 * cost less than a separate request. Returns [{ from, to, days }] (ms, day starts).
 */
export function planRanges(fromMs, toMs, wanted) {
  const ranges = [];
  for (let day = dayStart(fromMs); day <= toMs; day += DAY_MS) {
    if (!wanted(day)) continue;
    const last = ranges.at(-1);
    if (last && day - last.to <= MERGE_GAP_DAYS * DAY_MS) last.to = day;
    else ranges.push({ from: day, to: day });
  }
  return ranges.map((r) => ({ ...r, days: Math.round((r.to - r.from) / DAY_MS) + 1 }));
}

/** Does this day have a slot (hour × lead day) with no row? */
export function dayHasGap(day, fromMs, filledSlots, leadDays) {
  const first = Math.round((day - fromMs) / HOUR_MS);
  for (let hour = first; hour < first + 24; hour += 1) {
    for (const n of leadDays) if (!filledSlots?.has(hour * SLOT_LEADS + n)) return true;
  }
  return false;
}

/** Previous Runs rows for the empty slots of one response. Never returns a row for a slot that has one. */
export function gapDocs(location, model, hourly, { fromMs, filledSlots, leadDays, meta }) {
  const docs = [];
  hourly.time.forEach((t, i) => {
    const target = new Date(`${t}Z`);
    const hour = Math.round((target.getTime() - fromMs) / HOUR_MS);
    for (const n of leadDays) {
      if (filledSlots?.has(hour * SLOT_LEADS + n)) continue;   // a collected (or earlier filled) row exists
      const values = {};
      for (const [variable, field] of Object.entries(VARIABLES)) values[field] = hourly[`${variable}_previous_day${n}`]?.[i] ?? null;
      if (Object.values(values).every((v) => v === null)) continue;   // no data: store nothing
      docs.push({
        location_id: location.id,
        source: "open-meteo",
        model,
        kind: "hourly",
        issued_at: new Date(target.getTime() - n * DAY_MS),   // approximate: the run cycle is not reported
        issued_at_basis: FILL_BASIS,
        fetch_method: FILL_METHOD,
        target_time: target,
        target_end_time: new Date(target.getTime() + HOUR_MS),
        lead_hours: null,
        lead_days: n,
        generated_at: null,
        values,
        ...meta,
      });
    }
  });
  return docs;
}

/**
 * Validation: lead-day-1 MAE of the collected rows (every run, as the accuracy views score them) vs Previous Runs,
 * on the same city-hours. Adds to `stats` (per model) for one response.
 */
export function addDay1Comparison(stats, model, locationId, hourly, { fromMs, day1Temps, observed }) {
  const s = (stats[model] ??= { city_hours: 0, collected_rows: 0, collected_abs_c: 0, previous_abs_c: 0 });
  hourly.time.forEach((t, i) => {
    const ms = new Date(`${t}Z`).getTime();
    const prev = hourly.temperature_2m_previous_day1?.[i];
    const temps = day1Temps?.get(Math.round((ms - fromMs) / HOUR_MS));
    const obs = observed.get(`${locationId}|${ms}`);
    if (prev == null || !temps?.length || obs == null) return;
    s.city_hours += 1;
    s.previous_abs_c += Math.abs(prev - obs);
    for (const temp of temps) s.collected_abs_c += Math.abs(temp - obs);
    s.collected_rows += temps.length;
  });
  return stats;
}

/** MAE per model in °F and the difference (Previous Runs − collected); `ok` when within MAX_DAY1_DIFF_F. */
export function summarizeComparison(stats) {
  return Object.fromEntries(Object.entries(stats).map(([model, s]) => {
    if (!s.city_hours) return [model, { city_hours: 0, ok: null }];
    const collected = cToF(s.collected_abs_c / s.collected_rows);
    const previous = cToF(s.previous_abs_c / s.city_hours);
    const diff = previous - collected;
    return [model, {
      city_hours: s.city_hours, collected_rows: s.collected_rows,
      collected_mae_f: +collected.toFixed(3), previous_runs_mae_f: +previous.toFixed(3), diff_f: +diff.toFixed(3),
      ok: Math.abs(diff) <= MAX_DAY1_DIFF_F,
    }];
  }));
}

/**
 * A fill writes only after a `--validate` run passed for every model: the latest successful validation must have
 * compared each model and found it within MAX_DAY1_DIFF_F. Returns { ok, reason }.
 */
export async function validationGate(store, models) {
  const [last] = await store.find(COLLECTIONS.pipelineRuns.name,
    { stage: "stage1", mode: "om-gap-fill", status: "success", "gap_fill.mode": "validate", "gap_fill.calls_used": { $gt: 0 } },
    { sort: { started_at: -1 }, limit: 1, projection: { _id: 0, started_at: 1, "gap_fill.validation": 1 } });
  if (!last) return { ok: false, reason: "no validation run yet (run: node fetchWeather.js om-gap-fill --validate)" };
  const validation = last.gap_fill?.validation ?? {};
  const bad = models.filter((m) => validation[m]?.ok !== true);
  if (bad.length) {
    const detail = bad.map((m) => (validation[m]?.diff_f != null ? `${m} ${validation[m].diff_f} °F` : `${m} not compared`)).join(", ");
    return { ok: false, reason: `the last validation (${new Date(last.started_at).toISOString().slice(0, 16)}Z) is over ${MAX_DAY1_DIFF_F} °F or missing for ${detail}` };
  }
  return { ok: true };
}

/**
 * Filled rows whose slot has since received a collected row (the Single Runs backfill, live om-forecast) are set
 * `exclude_from_accuracy`, so a slot is never scored twice. Incremental: only rows stored since the last pass.
 * @returns {Promise<number>} filled rows newly excluded
 */
export async function supersedeFilledSlots(store, models = config.stage1.omBackfillModels, now = new Date()) {
  const marker = await store.findOne(WATERMARKS.name, SUPERSEDE_MARKER);
  const live = { model: { $in: models }, kind: "hourly", fetch_method: FILL_METHOD, exclude_from_accuracy: { $ne: true } };
  let excluded = 0;
  if (await store.count(SNAPSHOTS.name, live)) {
    const since = marker?.last_time ?? new Date(0);
    const filter = { model: { $in: models }, kind: "hourly", fetch_method: { $ne: FILL_METHOD }, lead_days: { $gte: 1, $lte: 7 }, stored_at: { $gt: since } };
    const projection = { _id: 0, location_id: 1, model: 1, target_time: 1, lead_days: 1 };
    for await (const batch of store.findBatches(SNAPSHOTS.name, filter, { projection })) {
      const groups = new Map();
      for (const d of batch) {
        const key = `${d.model}|${d.location_id}|${d.lead_days}`;
        if (!groups.has(key)) groups.set(key, { model: d.model, location_id: d.location_id, lead_days: d.lead_days, times: [] });
        groups.get(key).times.push(d.target_time);
      }
      for (const g of groups.values()) {
        excluded += await store.updateMany(SNAPSHOTS.name,
          { ...live, model: g.model, location_id: g.location_id, lead_days: g.lead_days, target_time: { $in: g.times } },
          { exclude_from_accuracy: true, superseded_at: now, stored_at: now });   // stored_at: Stage 2 reloads the row
      }
    }
  }
  await store.upsertMany(WATERMARKS.name, [{ ...SUPERSEDE_MARKER, last_time: now, updated_at: now }], WATERMARKS.uniqueKey);
  return excluded;
}

/**
 * Fill the empty slots of target days `from`..`to` (default: the last OM_BACKFILL_DAYS days up to yesterday, UTC).
 * @param {{ range?: { from?: string, to?: string }, dryRun?: boolean, validate?: boolean, models?: string[],
 *           now?: Date }} [options]
 *   dryRun: plan only (no API calls, nothing written). validate: fetch the days that have collected lead-day-1 rows
 *   and compare MAE; nothing written.
 */
export async function fillForecastGaps(store, locations, run, options = {}) {
  const now = options.now ?? new Date();
  const models = options.models ?? config.stage1.omBackfillModels;
  const yesterday = dayStart(now.getTime()) - DAY_MS;   // every lead day of yesterday's hours is final
  const fromMs = options.range?.from ? Date.parse(`${options.range.from}T00:00:00Z`) : dayStart(now.getTime() - config.stage1.omBackfillDays * DAY_MS);
  const lastDay = Math.min(options.range?.to ? Date.parse(`${options.range.to}T00:00:00Z`) : yesterday, yesterday);
  const toMs = lastDay + DAY_MS - HOUR_MS;   // last target hour
  const mode = options.validate ? "validate" : options.dryRun ? "dry-run" : "fill";
  const planOnly = Boolean(options.dryRun);   // with validate: the validation plan only
  if (lastDay < fromMs) throw new Error(`nothing to fill: ${toDay(fromMs)} is after ${toDay(lastDay)}`);
  console.log(`[om-gap-fill] ${mode}${planOnly ? " (plan only)" : ""}: target days ${toDay(fromMs)}..${toDay(lastDay)}, models ${models.join(", ")}`);

  if (mode === "fill" && !planOnly) {
    const gate = await validationGate(store, models);
    if (!gate.ok) {
      run.skip(null, `not filled: ${gate.reason}`);
      console.warn(`[om-gap-fill] WARNING nothing filled: ${gate.reason}`);
      run.set({ gap_fill: { mode, gate: gate.reason } });
      return { mode, gate: gate.reason, requests: 0, calls_planned: 0, calls_used: 0, inserted_by_model: {} };
    }
    const n = await supersedeFilledSlots(store, models, now);
    if (n) console.log(`[om-gap-fill] ${n} filled rows superseded by collected rows`);
  }
  const { filled, day1 } = await loadSlots(store, models, fromMs, toMs);
  const observed = new Map();
  if (!planOnly) {
    for await (const batch of store.findBatches(OBSERVATIONS, { time: { $gte: new Date(fromMs), $lte: new Date(toMs) }, temp_c: { $ne: null } },
      { projection: { _id: 0, location_id: 1, time: 1, temp_c: 1 } })) {
      for (const o of batch) observed.set(`${o.location_id}|${new Date(o.time).getTime()}`, o.temp_c);
    }
  }

  // Which requests: for a fill, the days with an empty slot; for a validation, the days with collected day-1 rows.
  const plan = [];
  for (const model of models) {
    const leadDays = leadDaysFor(model);
    for (const location of locations) {
      if (!coversLocation(model, location)) continue;
      const key = pairKey(model, location.id);
      const temps = day1.get(key);
      const wanted = mode === "validate"
        ? (day) => [...Array(24).keys()].some((h) => temps?.has(Math.round((day - fromMs) / HOUR_MS) + h))
        : (day) => dayHasGap(day, fromMs, filled.get(key), leadDays);
      for (const r of planRanges(fromMs, lastDay, wanted)) {
        // A validation samples at most the last 14 days of each range (1 weighted call per range).
        const sample = mode === "validate" && r.days > 14 ? { from: r.to - 13 * DAY_MS, to: r.to, days: 14 } : r;
        plan.push({ model, location, leadDays: mode === "validate" ? [1] : leadDays, ...sample });
      }
    }
  }
  const plannedCalls = plan.reduce((a, r) => a + requestWeight(r.days), 0);
  console.log(`[om-gap-fill] ${plan.length} requests planned, ${plannedCalls.toFixed(1)} weighted calls`);
  run.set({ gap_fill: { mode, from: toDay(fromMs), to: toDay(lastDay), requests_planned: plan.length, calls_planned: +plannedCalls.toFixed(1) } });
  if (planOnly) {
    for (const model of models) {
      const reqs = plan.filter((r) => r.model === model);
      console.log(`  ${model}: ${reqs.length} requests, ${reqs.reduce((a, r) => a + r.days, 0)} city-days`);
    }
    return { mode, plan_only: true, requests: plan.length, calls_planned: plannedCalls, calls_used: 0 };
  }

  const budget = new ApiBudget(store, "open-meteo", config.openMeteoBudget, { share: BUDGET_SHARE });
  const stats = {};
  const insertedBy = {};
  let callsUsed = 0;
  let requests = 0;
  try {
    for (const r of plan) {
      const weight = requestWeight(r.days);
      await budget.reserve(weight);
      callsUsed += weight;
      requests += 1;
      const params = new URLSearchParams({
        latitude: r.location.lat,
        longitude: r.location.lon,
        models: r.model,
        start_date: toDay(r.from),
        end_date: toDay(r.to),
        hourly: r.leadDays.flatMap((n) => Object.keys(VARIABLES).map((v) => `${v}_previous_day${n}`)).join(","),
        timezone: "GMT",
      });
      const fetchedAt = new Date();
      let hourly;
      try {
        hourly = (await openMeteoGet(`${PREVIOUS_RUNS_URL}?${params}`, { cost: weight, maxRetries: 2 })).hourly ?? { time: [] };
      } catch (err) {
        run.error(r.location.id, new Error(`${r.model} ${toDay(r.from)}..${toDay(r.to)}: ${err.message}`));
        continue;
      }
      const key = pairKey(r.model, r.location.id);
      addDay1Comparison(stats, r.model, r.location.id, hourly, { fromMs, day1Temps: day1.get(key), observed });
      if (mode !== "fill") continue;
      const meta = { etl_batch_id: run.etlBatchId, source_timestamp: fetchedAt, fetched_at: fetchedAt };
      const docs = gapDocs(r.location, r.model, hourly, { fromMs, filledSlots: filled.get(key), leadDays: r.leadDays, meta });
      const result = docs.length ? await store.insertMissing(SNAPSHOTS.name, docs, SNAPSHOTS.uniqueKey) : {};
      run.add(docs.length, result);
      insertedBy[r.model] = (insertedBy[r.model] ?? 0) + (result.inserted ?? 0);
      if (requests % 50 === 0) console.log(`[om-gap-fill] ${requests}/${plan.length} requests, ${run.counts.inserted} rows inserted so far`);
    }
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err;
    run.skip(null, `stopped: ${err.message}; the next run continues with the slots still empty`);
    console.log(`[om-gap-fill] ${err.message}; the next run continues with the slots still empty`);
  }
  if (mode === "fill") {
    const n = await supersedeFilledSlots(store, models, new Date());   // rows the backfill wrote meanwhile
    if (n) console.log(`[om-gap-fill] ${n} filled rows superseded by rows collected during this run`);
  }

  const validation = summarizeComparison(stats);
  run.set({ gap_fill: { ...run.extra.gap_fill, requests, calls_used: +callsUsed.toFixed(1), inserted_by_model: insertedBy, validation } });
  console.log("[om-gap-fill] lead-day-1 MAE on the same city-hours (°F): collected rows vs Previous Runs");
  console.table(validation);
  const off = Object.entries(validation).filter(([, v]) => v.ok === false).map(([m]) => m);
  if (off.length) console.warn(`[om-gap-fill] WARNING Previous Runs differs by more than ${MAX_DAY1_DIFF_F} °F for: ${off.join(", ")}`);
  const used = await budget.usage();
  console.log(`[om-gap-fill] ${requests} requests, ${callsUsed.toFixed(1)} weighted calls; Open-Meteo usage now ${Math.round(used.hour)} this hour, ${Math.round(used.day)} today`);
  return { mode, requests, calls_planned: plannedCalls, calls_used: callsUsed, inserted_by_model: insertedBy, validation };
}
