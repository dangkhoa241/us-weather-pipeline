// src/publish/opsStatus.js
// status.json for the dashboard's Pipeline Ops page (docs/analysis/pipeline-ops.md): job health, data freshness,
// incidents and alert-email counts of the last 7 days, from `pipeline_runs`. Pure functions, no I/O.
// The file is public. Nothing from a run document is copied as text: incidents are rebuilt from fixed labels (job
// names, error categories) and city names from `locations`; sanitizeStatus() keeps only whitelisted fields, and
// assertPublicStatus() refuses anything that still looks internal.

import { FORBIDDEN } from "./snapshotFormat.js";

export const STATUS_FORMAT = 1;   // bump when the layout changes (the dashboard checks it)
export const WINDOW_DAYS = 7;     // pipeline_runs are kept 7 days in Atlas (RAW_RETENTION_DAYS)
const DAY_MS = 86_400_000;
const STUCK_MS = 30 * 60_000;     // "running" this long: the Lambda was stopped (timeout) before it finished
const MAX_INCIDENTS = 20;

/** The jobs shown, matched to their pipeline_runs entries; schedules as in infra/template.yaml. */
export const JOBS = [
  { id: "alerts", name: "Alerts collector", stage: "stage1", mode: "alerts", schedule: "Every hour at :23 UTC" },
  { id: "forecast", name: "Forecast collector", stage: "stage1", mode: "forecast", schedule: "Every 3 hours at :07 UTC" },
  { id: "publisher", name: "Dashboard publisher", stage: "publish", mode: "dashboard",
    schedule: "Every 3 hours at :35 UTC (history once a day, 06:35)" },
];
const jobOf = (run) => JOBS.find((j) => j.stage === run.stage && j.mode === run.mode) ?? null;

export const RUN_STATUS = { success: "ok", partial: "partial", failed: "failed" };

/** Error categories: the only words of an error that reach the public file. */
export const CATEGORIES = ["timeout", "rate limited", "API budget reached", "NWS error", "Open-Meteo error",
  "storage error", "upload error", "blocked by safety check", "setup error", "other error"];

/** Raw error message → one of CATEGORIES (never the message itself). */
export function errorCategory(message) {
  const m = String(message ?? "");
  if (/timed? ?out|timeout|AbortError|ETIMEDOUT|did not finish/i.test(m)) return "timeout";
  if (/HTTP 429|rate.?limit|too many requests/i.test(m)) return "rate limited";
  if (/budget/i.test(m)) return "API budget reached";
  if (/forbidden value/i.test(m)) return "blocked by safety check";
  if (/weather\.gov|\bNWS\b/i.test(m)) return "NWS error";
  if (/open-meteo/i.test(m)) return "Open-Meteo error";
  if (/mongo|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|topology|server selection|no locations/i.test(m)) return "storage error";
  if (/PutObject|NoSuchBucket|AccessDenied|\bS3\b/i.test(m)) return "upload error";
  if (/seed:locations|not set|bad event|bad config/i.test(m)) return "setup error";
  return "other error";
}

const time = (d) => (d == null ? null : new Date(d).toISOString());
const cityName = (byId, id) => {
  const l = byId.get(id);
  return l?.name && l.state ? `${l.name}, ${l.state}` : null;
};

/** A run's outcome, treating a run that never finished as failed ("timeout"). */
function outcome(run, now) {
  if (run.status === "running") {
    return now - new Date(run.started_at) > STUCK_MS ? { status: "failed", errors: [{ location_id: null, message: "did not finish" }] } : null;
  }
  return RUN_STATUS[run.status] ? { status: run.status, errors: run.errors ?? [] } : null;
}

export const incidentText = ({ job, city, category, runs, recovered }) => {
  const who = city ?? `${JOBS.find((j) => j.id === job)?.name ?? "Job"} run`;
  const how = !recovered ? "not recovered yet" : runs === 1 ? "recovered next run" : `recovered after ${runs} runs`;
  return `${who}: ${category}, ${how}`;
};

/**
 * Failure streaks per job and city (or the whole run when an error has no city), oldest run first: a city failing in
 * 3 runs in a row is one incident "…, recovered after 3 runs". `finished`: one job's finished runs, oldest first.
 */
function streaks(job, finished, byId) {
  const incidents = [];
  const open = new Map();   // key → { at, category, runs }
  const close = (key, recovered) => {
    const s = open.get(key);
    incidents.push({ at: s.at, job: job.id, city: key === "*" ? null : cityName(byId, key), category: s.category, runs: s.runs, recovered });
    open.delete(key);
  };
  for (const { run, errors } of finished) {
    const failing = new Map();
    for (const e of errors) {
      const key = e.location_id && byId.has(e.location_id) ? e.location_id : "*";
      if (!failing.has(key)) failing.set(key, errorCategory(e.message));
    }
    for (const key of [...open.keys()]) if (!failing.has(key)) close(key, true);
    for (const [key, category] of failing) {
      const s = open.get(key);
      if (s) s.runs += 1;
      else open.set(key, { at: time(run.started_at), category, runs: 1 });
    }
  }
  for (const key of [...open.keys()]) close(key, false);
  return incidents;
}

/**
 * Sum of the public alert-email counters saved by the alerts runs (oldest first); null while no run has recorded them.
 * `since`: the first counted run, so the page can say "counting since …" until the window is full.
 */
function alertTotals(runs) {
  const recorded = runs.filter((r) => r.public_alerts && typeof r.public_alerts === "object");
  const sum = (k) => (recorded.length ? recorded.reduce((a, r) => a + (Number.isInteger(r.public_alerts[k]) ? r.public_alerts[k] : 0), 0) : null);
  return { sent: sum("sent"), skippedCooldown: sum("cooldown"), skippedNotNew: sum("not_new"), runsCounted: recorded.length,
    since: time(recorded[0]?.started_at) };
}

/** Benchmark numbers (static): docs/analysis/caching.md. */
export const PERFORMANCE = {
  redisWarmP95: { beforeMs: 35.4, afterMs: 2.9, speedup: 12,
    source: "Stage 3 cache benchmark, 10 dashboard queries on local Docker (docs/analysis/caching.md)" },
};

/**
 * @param {{ runs: object[], locations: { id: string, name: string, state: string }[], now: Date,
 *           freshness?: { historyThrough?: string|null, forecastUpdatedAt?: string|null } }} input
 *   runs: pipeline_runs documents (any stages; the last WINDOW_DAYS days are used).
 *   freshness: values from the current publisher run; missing ones come from the latest publisher run that has them.
 */
export function buildStatus({ runs, locations, now, freshness = {} }) {
  const since = now.getTime() - WINDOW_DAYS * DAY_MS;
  const byId = new Map(locations.map((l) => [l.id, l]));
  const recent = runs
    .filter((r) => jobOf(r) && r.started_at && new Date(r.started_at).getTime() >= since)
    .sort((a, b) => new Date(a.started_at) - new Date(b.started_at));

  const jobs = [];
  const incidents = [];
  for (const job of JOBS) {
    const finished = recent.filter((r) => jobOf(r) === job).map((run) => ({ run, ...outcome(run, now) })).filter((x) => x.status);
    const last = finished.at(-1);
    jobs.push({
      id: job.id, name: job.name, schedule: job.schedule,
      lastRunAt: time(last?.run.started_at), lastStatus: last ? RUN_STATUS[last.status] : null,
      lastDurationMs: Number.isFinite(last?.run.duration_ms) ? Math.round(last.run.duration_ms) : null,
      runs7d: finished.length, okRuns7d: finished.filter((x) => x.status === "success").length,
    });
    incidents.push(...streaks(job, finished, byId));
  }

  const publishes = recent.filter((r) => jobOf(r)?.id === "publisher").reverse();
  const latest = (field) => publishes.find((r) => r[field] != null)?.[field] ?? null;
  return {
    format: STATUS_FORMAT,
    generatedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    jobs,
    freshness: {
      historyThrough: freshness.historyThrough ?? latest("history_as_of"),
      forecastUpdatedAt: time(freshness.forecastUpdatedAt ?? latest("forecasts_generated_at")),
    },
    incidents: incidents.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_INCIDENTS)
      .map((i) => ({ ...i, text: incidentText(i) })),
    alerts7d: alertTotals(recent.filter((r) => jobOf(r)?.id === "alerts")),
    performance: PERFORMANCE,
  };
}

// ---- Public-file safety ---------------------------------------------------------------------------------------------
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CITY = /^[A-Z][A-Za-z .'-]{0,40}, [A-Z]{2}$/;
const iso = (v) => (typeof v === "string" && ISO_TIME.test(v) ? v : null);
const count = (v, max = 1e9) => (Number.isInteger(v) && v >= 0 && v <= max ? v : null);
const oneOf = (v, list) => (list.includes(v) ? v : null);

/** Whitelist: rebuilds the status from known fields and fixed labels; anything else is dropped. */
export function sanitizeStatus(s) {
  return {
    format: STATUS_FORMAT,
    generatedAt: iso(s.generatedAt),
    windowDays: WINDOW_DAYS,
    jobs: JOBS.map((job) => {
      const j = s.jobs?.find((x) => x?.id === job.id) ?? {};
      return {
        id: job.id, name: job.name, schedule: job.schedule,
        lastRunAt: iso(j.lastRunAt), lastStatus: oneOf(j.lastStatus, Object.values(RUN_STATUS)),
        lastDurationMs: count(j.lastDurationMs, 3_600_000), runs7d: count(j.runs7d, 10_000) ?? 0, okRuns7d: count(j.okRuns7d, 10_000) ?? 0,
      };
    }),
    freshness: {
      historyThrough: typeof s.freshness?.historyThrough === "string" && ISO_DAY.test(s.freshness.historyThrough) ? s.freshness.historyThrough : null,
      forecastUpdatedAt: iso(s.freshness?.forecastUpdatedAt),
    },
    incidents: (Array.isArray(s.incidents) ? s.incidents : []).slice(0, MAX_INCIDENTS).flatMap((i) => {
      const clean = {
        at: iso(i?.at), job: oneOf(i?.job, JOBS.map((j) => j.id)),
        city: typeof i?.city === "string" && CITY.test(i.city) ? i.city : null,
        category: oneOf(i?.category, CATEGORIES) ?? "other error", runs: count(i?.runs, 10_000) ?? 1, recovered: i?.recovered === true,
      };
      return clean.at && clean.job ? [{ ...clean, text: incidentText(clean) }] : [];
    }),
    alerts7d: {
      sent: count(s.alerts7d?.sent), skippedCooldown: count(s.alerts7d?.skippedCooldown), skippedNotNew: count(s.alerts7d?.skippedNotNew),
      runsCounted: count(s.alerts7d?.runsCounted) ?? 0, since: iso(s.alerts7d?.since),
    },
    performance: PERFORMANCE,
  };
}

// Second net, on the serialized file: things that must never be public.
const LEAKS = [
  ["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/],
  ["ARN", /\barn:aws/i],
  ["AWS account ID", /(?<!\d)\d{12}(?!\d)/],
  ["bucket name", /weather-pipeline-raw|\bs3:\/\/|\.s3[.-]|"Bucket"/i],
  ["SSM parameter name", /\bssm\b|parameter\/|"\/weather-pipeline\//i],
  ["stack trace", /\bat \S+ \(|\.m?js:\d+|\n\s+at /],
  ["raw error text", /(Error|Exception):|HTTP \d{3}|https?:\/\//],
  ["subscriber data", /subscri/i],
];

/** Throws (naming the kind of leak, never its value) if the serialized status could expose anything internal. */
export function assertPublicStatus(text) {
  for (const [what, re] of LEAKS) if (re.test(text)) throw new Error(`status.json would expose a ${what}; not writing it`);
  if (FORBIDDEN.test(text)) throw new Error("status.json contains a forbidden value; not writing it");
  return text;
}

/** Sanitize + check + serialize: the only way status.json is written. */
export const publicStatusJson = (status) => assertPublicStatus(JSON.stringify(sanitizeStatus(status)));
