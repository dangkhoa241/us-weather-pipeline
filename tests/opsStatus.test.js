import { describe, it, expect } from "vitest";
import { CATEGORIES, JOBS, PERFORMANCE, assertPublicStatus, buildStatus, errorCategory, publicStatusJson, sanitizeStatus } from "../src/publish/opsStatus.js";

const NOW = new Date("2026-10-08T12:40:00Z");
const LOCATIONS = [
  { id: "kansas-city-mo", name: "Kansas City", state: "MO" },
  { id: "stockton-ca", name: "Stockton", state: "CA" },
];
const at = (iso) => new Date(iso);
const run = (mode, startedIso, status, extra = {}) => ({
  stage: mode === "dashboard" ? "publish" : "stage1", mode, status, started_at: at(startedIso), duration_ms: 1234, errors: [], ...extra,
});
const nwsError = (id) => ({ location_id: id, message: `periods: HTTP 500 for https://api.weather.gov/gridpoints/EAX/44,51/forecast?units=si - {"title":"Unexpected Problem"}` });

describe("errorCategory (raw error → fixed label)", () => {
  it.each([
    ["periods: HTTP 500 for https://api.weather.gov/gridpoints/EAX/44,51", "NWS error"],
    ["The operation was aborted due to timeout", "timeout"],
    ["connect ETIMEDOUT 1.2.3.4:443", "timeout"],
    ["HTTP 429 for https://archive-api.open-meteo.com/v1/archive?latitude=1", "rate limited"],
    ["history failed for 30 of 53 cities (x: HTTP 500 for https://archive-api.open-meteo.com/v1/archive)", "Open-Meteo error"],
    ["open-meteo-lambda daily budget reached (2000)", "API budget reached"],
    ["MongoServerSelectionError: connection <monitor> to 10.0.0.1:27017 closed", "storage error"],
    ["AccessDenied: User arn:aws:sts::123456789012:assumed-role/x is not authorized to perform: s3:PutObject", "upload error"],
    ["alerts.json contains a forbidden value (mongodb); not writing it", "blocked by safety check"],
    ["no nws_forecast_url; run npm run seed:locations", "setup error"],
    ["TypeError: Cannot read properties of undefined (reading 'x')\n    at fn (/var/task/index.mjs:12:3)", "other error"],
    [undefined, "other error"],
  ])("%s → %s", (message, category) => {
    expect(errorCategory(message)).toBe(category);
    expect(CATEGORIES).toContain(category);
  });
});

describe("buildStatus", () => {
  it("reports the last finished run per job with its schedule, status label and duration", () => {
    const status = buildStatus({ now: NOW, locations: LOCATIONS, runs: [
      run("alerts", "2026-10-08T11:23:00Z", "success", { duration_ms: 8123.4 }),
      run("alerts", "2026-10-08T12:23:00Z", "running"),   // still running (< 30 min): ignored
      run("forecast", "2026-10-08T12:07:00Z", "partial", { errors: [nwsError("stockton-ca")] }),
      run("dashboard", "2026-10-08T09:35:00Z", "failed", { errors: [{ location_id: null, message: "forecasts: HTTP 429 for open-meteo" }] }),
      run("om-forecast", "2026-10-08T12:00:00Z", "failed"),   // not a shown job
    ] });
    expect(status.generatedAt).toBe("2026-10-08T12:40:00.000Z");
    expect(status.jobs).toEqual([
      { id: "alerts", name: "Alerts collector", schedule: JOBS[0].schedule, lastRunAt: "2026-10-08T11:23:00.000Z", lastStatus: "ok", lastDurationMs: 8123, runs7d: 1, okRuns7d: 1 },
      { id: "forecast", name: "Forecast collector", schedule: JOBS[1].schedule, lastRunAt: "2026-10-08T12:07:00.000Z", lastStatus: "partial", lastDurationMs: 1234, runs7d: 1, okRuns7d: 0 },
      { id: "publisher", name: "Dashboard publisher", schedule: JOBS[2].schedule, lastRunAt: "2026-10-08T09:35:00.000Z", lastStatus: "failed", lastDurationMs: 1234, runs7d: 1, okRuns7d: 0 },
    ]);
    expect(status.performance).toEqual(PERFORMANCE);
    expect(PERFORMANCE.redisWarmP95).toMatchObject({ beforeMs: 35.4, afterMs: 2.9, speedup: 12 });
  });

  it("folds a city's failure streak into one incident and says when it recovered", () => {
    const runs = [
      run("forecast", "2026-10-07T00:07:00Z", "partial", { errors: [nwsError("kansas-city-mo"), nwsError("kansas-city-mo")] }),
      run("forecast", "2026-10-07T03:07:00Z", "partial", { errors: [nwsError("kansas-city-mo")] }),
      run("forecast", "2026-10-07T06:07:00Z", "partial", { errors: [nwsError("kansas-city-mo")] }),
      run("forecast", "2026-10-07T09:07:00Z", "success"),
      run("forecast", "2026-10-08T00:07:00Z", "partial", { errors: [nwsError("stockton-ca")] }),
      run("forecast", "2026-10-08T03:07:00Z", "success"),
      run("forecast", "2026-10-08T12:07:00Z", "partial", { errors: [{ location_id: "stockton-ca", message: "hourly: The operation was aborted due to timeout" }] }),
    ];
    const { incidents } = buildStatus({ now: NOW, locations: LOCATIONS, runs });
    expect(incidents.map((i) => i.text)).toEqual([
      "Stockton, CA: timeout, not recovered yet",
      "Stockton, CA: NWS error, recovered next run",
      "Kansas City, MO: NWS error, recovered after 3 runs",
    ]);
    expect(incidents[2]).toEqual({ at: "2026-10-07T00:07:00.000Z", job: "forecast", city: "Kansas City, MO", category: "NWS error", runs: 3, recovered: true,
      text: "Kansas City, MO: NWS error, recovered after 3 runs" });
  });

  it("names the job for whole-run failures and treats a run stuck in 'running' as a timeout", () => {
    const { incidents, jobs } = buildStatus({ now: NOW, locations: LOCATIONS, runs: [
      run("alerts", "2026-10-08T10:23:00Z", "failed", { errors: [{ location_id: null, message: "connect ECONNREFUSED" }] }),
      run("alerts", "2026-10-08T11:23:00Z", "running"),   // 77 min ago, never finished
    ] });
    expect(incidents.map((i) => i.text)).toEqual(["Alerts collector run: storage error, not recovered yet"]);
    expect(jobs[0]).toMatchObject({ lastRunAt: "2026-10-08T11:23:00.000Z", lastStatus: "failed" });
  });

  it("only uses the last 7 days (by the injected clock) and keeps the newest incidents first", () => {
    const { jobs, incidents } = buildStatus({ now: NOW, locations: LOCATIONS, runs: [
      run("forecast", "2026-09-30T12:07:00Z", "failed", { errors: [nwsError(null)] }),   // 8 days old
    ] });
    expect(jobs[1]).toMatchObject({ lastRunAt: null, lastStatus: null, lastDurationMs: null, runs7d: 0 });
    expect(incidents).toEqual([]);
  });

  it("sums the alert counters of the alerts runs; null while none recorded them", () => {
    const none = buildStatus({ now: NOW, locations: LOCATIONS, runs: [run("alerts", "2026-10-08T11:23:00Z", "success")] });
    expect(none.alerts7d).toEqual({ sent: null, skippedCooldown: null, skippedNotNew: null, runsCounted: 0 });
    const some = buildStatus({ now: NOW, locations: LOCATIONS, runs: [
      run("alerts", "2026-10-08T10:23:00Z", "success", { public_alerts: { sent: 2, cooldown: 1, not_new: 4, failed: 0 } }),
      run("alerts", "2026-10-08T11:23:00Z", "success", { public_alerts: { sent: 1, cooldown: 0, not_new: 3, failed: 0 } }),
      run("alerts", "2026-10-08T12:23:00Z", "success"),   // older code: not counted
    ] });
    expect(some.alerts7d).toEqual({ sent: 3, skippedCooldown: 1, skippedNotNew: 7, runsCounted: 2 });
  });

  it("freshness: this run's values first, else the latest publisher run that has them", () => {
    const runs = [
      run("dashboard", "2026-10-08T06:35:00Z", "success", { history_as_of: "2026-10-03", forecasts_generated_at: at("2026-10-08T06:36:10Z") }),
      run("dashboard", "2026-10-08T09:35:00Z", "success", { history_as_of: null, forecasts_generated_at: at("2026-10-08T09:36:00Z") }),
    ];
    expect(buildStatus({ now: NOW, locations: LOCATIONS, runs }).freshness).toEqual({ historyThrough: "2026-10-03", forecastUpdatedAt: "2026-10-08T09:36:00.000Z" });
    expect(buildStatus({ now: NOW, locations: LOCATIONS, runs, freshness: { forecastUpdatedAt: "2026-10-08T12:36:00.000Z" } }).freshness)
      .toEqual({ historyThrough: "2026-10-03", forecastUpdatedAt: "2026-10-08T12:36:00.000Z" });
  });
});

describe("status.json sanitizer (public file)", () => {
  // A worst-case run history: every kind of internal value in error text, extra fields and ids.
  const nasty = [
    run("alerts", "2026-10-08T10:23:00Z", "failed", {
      errors: [{ location_id: null, message: "AccessDenied: arn:aws:sns:us-east-2:123456789012:weather-pipeline-public-alerts for owner@example.com" }],
      public_alerts: { sent: 1, cooldown: 0, not_new: 0, failed: 0, subscribers: { "stockton-ca": 7 } },
      etl_batch_id: "stage1-alerts-20261008-abc", subscriber_count: 12,
    }),
    run("forecast", "2026-10-08T12:07:00Z", "partial", { errors: [
      { location_id: "stockton-ca", message: "TypeError: x\n    at fetchForecasts (/var/task/nwsForecast.mjs:84:13)" },
      { location_id: "not-a-city", message: "GetParameter /weather-pipeline/atlas-uri failed: mongodb+srv://u:p@cluster0.example.mongodb.net" },
    ] }),
    run("dashboard", "2026-10-08T09:35:00Z", "failed", { errors: [{ location_id: null, message: "NoSuchBucket: weather-pipeline-raw-123456789012 s3://weather-pipeline-raw-123456789012/dashboard/" }] }),
  ];

  it("the built status passes the leak check and carries none of the raw values", () => {
    const text = publicStatusJson(buildStatus({ now: NOW, locations: LOCATIONS, runs: nasty }));
    for (const bad of ["@example.com", "arn:", "123456789012", "weather-pipeline-raw", "/weather-pipeline/", "mongodb", "TypeError", "nwsForecast",
      "    at ", "HTTP", "etl_batch_id", "subscri", "not-a-city", "\"7\"", "AccessDenied"]) {
      expect(text).not.toContain(bad);
    }
    const parsed = JSON.parse(text);
    expect(parsed.incidents.map((i) => i.text).sort()).toEqual([
      "Alerts collector run: upload error, not recovered yet",
      "Dashboard publisher run: upload error, not recovered yet",
      "Forecast collector run: storage error, not recovered yet",
      "Stockton, CA: other error, not recovered yet",
    ]);
    expect(Object.keys(parsed.alerts7d)).toEqual(["sent", "skippedCooldown", "skippedNotNew", "runsCounted"]);
  });

  it("whitelist: unknown fields, free text and bad values are dropped or replaced by fixed labels", () => {
    const clean = sanitizeStatus({
      generatedAt: "2026-10-08T12:40:00.000Z", secret: "x",
      jobs: [{ id: "alerts", name: "owner@example.com", schedule: "arn:aws:events:…", lastRunAt: "yesterday", lastStatus: "exploded", lastDurationMs: -1, extra: 1 },
        { id: "evil", name: "x" }],
      freshness: { historyThrough: "2026-10-03; DROP", forecastUpdatedAt: "2026-10-08T09:36:00.000Z" },
      incidents: [
        { at: "2026-10-08T10:00:00.000Z", job: "forecast", city: "Stockton, CA", category: "HTTP 500 at https://api.weather.gov", runs: 2, recovered: true, text: "raw: Error: boom" },
        { at: "2026-10-08T10:00:00.000Z", job: "forecast", city: "owner@example.com", category: "timeout", runs: 1, recovered: false },
        { at: "not a time", job: "forecast", category: "timeout" },
      ],
      alerts7d: { sent: 3, skippedCooldown: "12", skippedNotNew: 1.5, runsCounted: 2, bySubscriber: { a: 1 } },
      performance: { fake: true },
    });
    expect(clean.jobs.map((j) => j.id)).toEqual(["alerts", "forecast", "publisher"]);
    expect(clean.jobs[0]).toEqual({ id: "alerts", name: "Alerts collector", schedule: JOBS[0].schedule, lastRunAt: null, lastStatus: null, lastDurationMs: null, runs7d: 0, okRuns7d: 0 });
    expect(clean.freshness).toEqual({ historyThrough: null, forecastUpdatedAt: "2026-10-08T09:36:00.000Z" });
    expect(clean.incidents.map((i) => i.text)).toEqual(["Stockton, CA: other error, recovered after 2 runs", "Forecast collector run: timeout, not recovered yet"]);
    expect(clean.alerts7d).toEqual({ sent: 3, skippedCooldown: null, skippedNotNew: null, runsCounted: 2 });
    expect(clean.performance).toEqual(PERFORMANCE);
    expect("secret" in clean).toBe(false);
    expect(() => assertPublicStatus(JSON.stringify(clean))).not.toThrow();
  });

  it.each([
    ["email address", { note: "owner@example.com" }],
    ["ARN", { note: "arn:aws:sns:us-east-2:1:topic" }],
    ["AWS account ID", { note: "123456789012" }],
    ["bucket name", { note: "weather-pipeline-raw-x" }],
    ["bucket name", { Bucket: "my-bucket" }],
    ["SSM parameter name", { note: "SSM GetParameter" }],
    ["SSM parameter name", { note: "/weather-pipeline/atlas-uri" }],
    ["stack trace", { note: "at handler (/var/task/index.mjs:1:2)" }],
    ["raw error text", { note: "TypeError: boom" }],
    ["raw error text", { note: "HTTP 500" }],
    ["raw error text", { note: "https://api.weather.gov/x" }],
    ["subscriber data", { subscribersByCity: { "stockton-ca": 3 } }],
  ])("the leak check refuses a %s", (what, value) => {
    expect(() => assertPublicStatus(JSON.stringify(value))).toThrow(new RegExp(`expose a ${what}`));
    // The error names the kind of leak, never the value.
    try { assertPublicStatus(JSON.stringify(value)); } catch (err) { expect(err.message).not.toContain(Object.values(value)[0]); }
  });

  it("the leak check also applies the snapshot FORBIDDEN rule", () => {
    expect(() => assertPublicStatus('{"x":"atlas"}')).toThrow(/forbidden/);
  });
});
