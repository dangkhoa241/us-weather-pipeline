// src/api/service.js
// Framework-independent API logic: one function per route, taking already-parsed parameters and returning
// { data, meta }. Reads go through the Stage 3 cache (src/stage3/dashboard.js); pipeline data comes from the raw
// store. Expected problems throw ApiError (status + code + safe message); anything else is an internal error that
// the HTTP layer must turn into a generic 500 without details.

import { createDashboard, cacheStatus, VERSION_KEY } from "../stage3/dashboard.js";
import { archiveEndDay } from "../stage1/openMeteoHistory.js";
import { COLLECTIONS } from "../collections.js";
import { COMPARE, DRILL_LEVELS, LIMITS, METRICS, PERIODS, STAGES } from "./params.js";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const DAY_MS = 86_400_000;
const toDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (day) => Date.parse(`${day}T00:00:00Z`);
const badRequest = (message) => new ApiError(400, "bad_request", message);

/** Default range: the last 30 complete days of observations (the archive lags ~5 days). */
function resolveRange(from, to) {
  const end = to ?? archiveEndDay();
  const start = from ?? toDay(dayMs(end) - 29 * DAY_MS);
  if (Number.isNaN(dayMs(start)) || Number.isNaN(dayMs(end))) throw badRequest("from/to must be valid dates");
  if (start > end) throw badRequest("from must not be after to");
  if ((dayMs(end) - dayMs(start)) / DAY_MS + 1 > LIMITS.maxRangeDays) throw badRequest(`range is longer than ${LIMITS.maxRangeDays} days`);
  return { from: start, to: end };
}

function shiftRange({ from, to }, compare) {
  if (compare === "last_year") {
    const back = (day) => `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`.replace(/-02-29$/, "-02-28");
    return { from: back(from), to: back(to) };
  }
  const days = (dayMs(to) - dayMs(from)) / DAY_MS + 1;   // previous period of the same length
  return { from: toDay(dayMs(from) - days * DAY_MS), to: toDay(dayMs(from) - DAY_MS) };
}

/** `locations=all`: every tracked city, averaged per period (see usAverage). */
export const ALL_LOCATIONS = "all";

/**
 * US-wide rows: per period, the mean of each value over the cities that have it (nulls ignored, never 0);
 * n_values / n_hours are summed and `cities` counts the cities with data in that period.
 */
export function usAverage(rows) {
  const groups = new Map();
  for (const r of rows) groups.set(r.period_start, [...(groups.get(r.period_start) ?? []), r]);
  const mean = (g, f) => {
    const v = g.map((r) => r[f]).filter((x) => x != null);
    return v.length ? Math.round((v.reduce((a, x) => a + x, 0) / v.length) * 1000) / 1000 : null;
  };
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period_start, g]) => ({
    location_id: ALL_LOCATIONS, period_start,
    min: mean(g, "min"), max: mean(g, "max"), avg: mean(g, "avg"), sum: mean(g, "sum"),
    n_values: g.reduce((a, r) => a + r.n_values, 0), n_hours: g.reduce((a, r) => a + r.n_hours, 0),
    cities: g.filter((r) => r.n_values > 0).length,
  }));
}

const CHILD = { year: "half", half: "quarter", quarter: "month", month: "week", week: "day", day: "hour" };

/** Drill-down key → local date range of that period (e.g. quarter "2025-Q3" → 2025-07-01..2025-09-30). */
export function drillRange(level, key) {
  const fail = () => { throw badRequest(`key "${key}" does not match level "${level}"`); };
  const y = Number(key.slice(0, 4));
  const monthEnd = (year, month) => toDay(Date.UTC(year, month, 0));   // month is 1-based; day 0 = last of previous
  switch (level) {
    case "year": if (!/^\d{4}$/.test(key)) fail(); return { from: `${y}-01-01`, to: `${y}-12-31` };
    case "half": {
      const m = /^\d{4}-H([12])$/.exec(key) ?? fail();
      return m[1] === "1" ? { from: `${y}-01-01`, to: `${y}-06-30` } : { from: `${y}-07-01`, to: `${y}-12-31` };
    }
    case "quarter": {
      const q = Number((/^\d{4}-Q([1-4])$/.exec(key) ?? fail())[1]);
      const first = 3 * (q - 1) + 1;
      return { from: `${y}-${String(first).padStart(2, "0")}-01`, to: monthEnd(y, first + 2) };
    }
    case "month": {
      const m = Number((/^\d{4}-(\d{2})$/.exec(key) ?? fail())[1]);
      if (m < 1 || m > 12) fail();
      return { from: `${key}-01`, to: monthEnd(y, m) };
    }
    case "week": case "day": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key) || toDay(dayMs(key)) !== key) fail();
      if (level === "day") return { from: key, to: key };
      if (new Date(dayMs(key)).getUTCDay() !== 1) throw badRequest("a week key must be a Monday");
      return { from: key, to: toDay(dayMs(key) + 6 * DAY_MS) };
    }
    default: throw badRequest(`level must be one of ${DRILL_LEVELS.join(", ")}`);
  }
}

const RUN_FIELDS = {
  _id: 0, etl_batch_id: 1, stage: 1, mode: 1, status: 1, started_at: 1, finished_at: 1, duration_ms: 1,
  rows_fetched: 1, inserted: 1, updated: 1, error_count: 1, skipped_count: 1,
  "steps.step": 1, "steps.status": 1, "steps.etl_batch_id": 1, "steps.duration_ms": 1,
};   // no error messages (not even a failed step's): they can contain internal hostnames and driver details

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{ warehouse, cache, store }} deps  connected Warehouse, CacheStore and RawStore adapters
 */
export function createService({ warehouse, cache, store }) {
  const dashboard = createDashboard({ warehouse, cache });

  async function dataVersion() {
    try {
      return (await cache.get(VERSION_KEY))?.version ?? null;
    } catch {
      return null;
    }
  }

  async function query(type, params) {
    const { data, source } = await dashboard.query(type, params);
    return { data, meta: { source, data_version: await dataVersion() } };
  }

  async function knownLocationIds() {
    return new Set((await dashboard.query("locations", {})).data.map((l) => l.id));
  }

  async function requireLocations(ids) {
    if (!Array.isArray(ids) || !ids.length) throw badRequest("at least one location is required");
    if (ids.length > LIMITS.maxLocations) throw badRequest(`at most ${LIMITS.maxLocations} locations`);
    const known = await knownLocationIds();
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new ApiError(404, "not_found", `unknown location(s): ${unknown.join(", ")}`);
  }

  /** Accuracy queries: target-date range, all US / one state / one (known) city, optional lead day 1..7. */
  async function accuracyQuery(type, { from, to, location, state, lead, limit }) {
    if (location && state) throw badRequest("use either location or state, not both");
    if (location) await requireLocations([location]);
    if (state != null && (typeof state !== "string" || !/^[A-Z]{2}$/.test(state))) throw badRequest("state must be a 2-letter code");
    if (lead != null && (!Number.isInteger(lead) || lead < 1 || lead > LIMITS.maxLeadDays)) throw badRequest(`lead must be 1..${LIMITS.maxLeadDays}`);
    const range = resolveRange(from, to);
    const params = { ...range, locationIds: location ? [location] : [], state: state ?? "", lead: lead ?? 0, ...(limit != null ? { limit } : {}) };
    const result = await query(type, params);
    result.meta.range = range;
    return result;
  }

  return {
    locations: () => query("locations", {}),

    async stats({ locations, metric = "temp_c", period = "day", from, to, compare }) {
      if (!METRICS.includes(metric)) throw badRequest(`metric must be one of ${METRICS.join(", ")}`);
      if (!PERIODS.includes(period)) throw badRequest(`period must be one of ${PERIODS.join(", ")}`);
      if (compare != null && !COMPARE.includes(compare)) throw badRequest(`compare must be one of ${COMPARE.join(", ")}`);
      const all = locations.length === 1 && locations[0] === ALL_LOCATIONS;
      const ids = all ? [...(await knownLocationIds())].sort() : locations;
      if (!all) await requireLocations(ids);
      const range = resolveRange(from, to);
      const shape = (rows) => (all ? usAverage(rows) : rows);
      const result = await query("stats", { locationIds: ids, metric, period, ...range });
      result.data = shape(result.data);
      result.meta.range = range;
      if (compare) {
        const other = shiftRange(range, compare);
        result.compare = { ...other, data: shape((await dashboard.query("stats", { locationIds: ids, metric, period, ...other })).data) };
      }
      return result;
    },

    async map({ from, to }) {
      const range = resolveRange(from, to);
      const result = await query("map", range);
      result.meta.range = range;
      return result;
    },

    async drill({ location, level, key, metric = "temp_c" }) {
      if (!DRILL_LEVELS.includes(level)) throw badRequest(`level must be one of ${DRILL_LEVELS.join(", ")}`);
      if (!METRICS.includes(metric)) throw badRequest(`metric must be one of ${METRICS.join(", ")}`);
      await requireLocations([location]);
      const range = drillRange(level, key);
      const result = await query("stats", { locationIds: [location], metric, period: CHILD[level], ...range });
      result.meta = { ...result.meta, level, key, child_level: CHILD[level], range };
      return result;
    },

    async forecast({ locationId, days = 7 }) {
      if (!Number.isInteger(days) || days < 1 || days > LIMITS.maxForecastDays) throw badRequest(`days must be 1..${LIMITS.maxForecastDays}`);
      await requireLocations([locationId]);
      return query("forecast", { locationId, days });
    },

    async forecastPeriods({ locationId }) {
      await requireLocations([locationId]);
      return query("periods", { locationId });
    },

    alerts: ({ state } = {}) => query("alerts", { state: state ?? "" }),

    accuracy: ({ from, to, location, state }) => accuracyQuery("accuracy", { from, to, location, state }),

    accuracyStates: ({ from, to, lead = 1 }) => accuracyQuery("accuracyStates", { from, to, lead }),

    accuracyMonths: ({ from, to, location, state, lead }) => accuracyQuery("accuracyMonths", { from, to, location, state, lead }),

    async accuracyMisses({ from, to, location, state, lead, limit = 10 }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxMisses) throw badRequest(`limit must be 1..${LIMITS.maxMisses}`);
      return accuracyQuery("misses", { from, to, location, state, lead, limit });
    },

    async records({ location }) {
      await requireLocations([location]);
      return query("records", { locationId: location });
    },

    async pipelineStatus() {
      const latest = {};
      for (const stage of STAGES) {
        latest[stage] = await store.findOne(COLLECTIONS.pipelineRuns.name, { stage }, { sort: { started_at: -1 }, projection: RUN_FIELDS });
      }
      let cacheInfo = null;
      try { cacheInfo = await cacheStatus(cache); } catch { /* cache down: report null */ }
      return { data: { cache: cacheInfo, latest_runs: latest }, meta: { source: "store" } };
    },

    async pipelineRuns({ limit = 50, stage } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxRuns) throw badRequest(`limit must be 1..${LIMITS.maxRuns}`);
      if (stage != null && (typeof stage !== "string" || !STAGES.includes(stage))) throw badRequest(`stage must be one of ${STAGES.join(", ")}`);
      const runs = await store.find(COLLECTIONS.pipelineRuns.name, stage ? { stage } : {},
        { sort: { started_at: -1 }, limit, projection: RUN_FIELDS });
      return { data: runs, meta: { source: "store" } };
    },

    /** Dependency checks (1 s each). The cache is optional: without it the API is "degraded", not down. */
    async health() {
      const check = async (fn) => {
        const t0 = Date.now();
        try { return { ok: (await withTimeout(fn(), 1000)) !== false, ms: Date.now() - t0 }; } catch { return { ok: false, ms: Date.now() - t0 }; }
      };
      const [rawStore, warehouseOk, cacheOk] = await Promise.all([check(() => store.ping()), check(() => warehouse.ping()), check(() => cache.ping())]);
      const status = !rawStore.ok || !warehouseOk.ok ? "down" : cacheOk.ok ? "ok" : "degraded";
      return { status, checks: { raw_store: rawStore, warehouse: warehouseOk, cache: cacheOk } };
    },
  };
}
