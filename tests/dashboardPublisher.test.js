import { describe, it, expect, vi, beforeEach } from "vitest";
import { PutObjectCommand } from "@aws-sdk/client-s3";

process.env.DASHBOARD_BUCKET = "weather-pipeline-raw-123456789012";
process.env.DASHBOARD_MAX_PUTS_PER_DAY = "3";
process.env.DASHBOARD_RECENT_DAYS = "3";
const { createHandler, buildRecent, buildAlerts, FILES } = await import("../src/lambda/dashboardPublisher.js");
const { dailyStats, publicJson } = await import("../src/publish/snapshotFormat.js");

const NOW = new Date("2026-10-02T12:10:00Z");
const URI = "mongodb+srv://publisher:s3cret@cluster0.example.mongodb.net";
const LOCATIONS = [
  { id: "chicago-il", state: "IL", lat: 41.88, lon: -87.63, timezone: "America/Chicago" },
  { id: "honolulu-hi", state: "HI", lat: 21.31, lon: -157.86, timezone: "Pacific/Honolulu" },
];
const at = (iso) => new Date(iso);

/** In-memory stand-in for the Atlas RawStore: just the calls the publisher makes. */
function fakeStore({ alerts = [], snapshots = [], runs = [] } = {}) {
  const usage = new Map();
  const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
    if (k === "$or") return v.some((f) => matches(doc, f));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      return (v.$gte == null || doc[k] >= v.$gte) && (v.$lt == null || doc[k] < v.$lt) && (v.$gt == null || (doc[k] != null && doc[k] > v.$gt));
    }
    return v instanceof Date ? doc[k]?.getTime() === v.getTime() : (doc[k] ?? null) === v;
  });
  const data = { locations: LOCATIONS, alerts, forecast_snapshots: snapshots, pipeline_runs: [...runs] };
  return {
    usage,
    data,
    insertOne: vi.fn(async (name, doc) => { (data[name] ??= []).push({ ...doc }); }),
    updateOne: vi.fn(async (name, filter, set) => { Object.assign(data[name].find((d) => matches(d, filter)), set); }),
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    find: vi.fn(async (name, filter = {}, { sort } = {}) => {
      const rows = (data[name] ?? []).filter((d) => matches(d, filter));
      const [key, dir] = Object.entries(sort ?? {})[0] ?? [];
      return key ? rows.sort((a, b) => (a[key] > b[key] ? dir : -dir)) : rows;
    }),
    findOne: vi.fn(async (name, filter = {}, { sort } = {}) => {
      if (name === "api_usage") return usage.has(`${filter.api}|${filter.period}`) ? { calls: usage.get(`${filter.api}|${filter.period}`) } : null;
      const rows = (data[name] ?? []).filter((d) => matches(d, filter));
      const [key, dir] = Object.entries(sort ?? {})[0] ?? [];
      return (key ? rows.sort((a, b) => (a[key] > b[key] ? dir : -dir)) : rows)[0] ?? null;
    }),
    increment: vi.fn(async (name, filter, inc) => {
      const k = `${filter.api}|${filter.period}`;
      usage.set(k, (usage.get(k) ?? 0) + inc.calls);
    }),
  };
}

/**
 * Open-Meteo stand-in: archive → hourly values for exactly the requested start_date..end_date (the last day has no
 * temperature yet, like the real archive), so no test depends on today's date; forecast → 2 hours for every model.
 */
function fakeOpenMeteo({ failFor = [] } = {}) {
  return vi.fn(async (url) => {
    const u = new URL(url);
    if (failFor.some((lat) => u.searchParams.get("latitude") === String(lat))) throw new Error("HTTP 429 for open-meteo");
    if (u.hostname.startsWith("archive")) {
      const [start, end] = [u.searchParams.get("start_date"), u.searchParams.get("end_date")];
      const time = [];
      for (let d = Date.parse(`${start}T00:00:00Z`); d <= Date.parse(`${end}T00:00:00Z`); d += 86_400_000) {
        for (let h = 0; h < 24; h += 1) time.push(`${new Date(d).toISOString().slice(0, 10)}T${String(h).padStart(2, "0")}:00`);
      }
      const temp = time.map((t, i) => (t.startsWith(end) ? null : 10 + (i % 24)));   // last day: no data yet
      return { hourly: { time, temperature_2m: temp, precipitation: time.map(() => 0.5) } };
    }
    const hourly = { time: ["2026-10-02T11:00", "2026-10-02T12:00", "2026-10-02T13:00"] };
    for (const m of u.searchParams.get("models").split(",")) {
      hourly[`temperature_2m_${m}`] = [1, 20, 21];
      hourly[`precipitation_${m}`] = [0, 0, 0.2];
      hourly[`precipitation_probability_${m}`] = [null, 10, 40];
    }
    return { hourly };
  });
}

const nwsSnapshots = (id) => [
  { location_id: id, model: "nws", kind: "hourly", issued_at: at("2026-10-02T09:00:00Z"), target_time: at("2026-10-02T12:00:00Z"), values: { temp_c: 18, precip_prob_pct: 5 } },
  { location_id: id, model: "nws", kind: "hourly", issued_at: at("2026-10-02T09:00:00Z"), target_time: at("2026-10-02T13:00:00Z"), values: { temp_c: 19, precip_prob_pct: 5 } },
  { location_id: id, model: "nws", kind: "hourly", issued_at: at("2026-10-01T21:00:00Z"), target_time: at("2026-10-02T12:00:00Z"), values: { temp_c: 99 } },   // older issue
  { location_id: id, model: "nws", kind: "periods", issued_at: at("2026-10-02T09:00:00Z"), target_time: at("2026-10-01T23:00:00Z"), target_end_time: at("2026-10-02T11:00:00Z"), values: { temp_c: 8 } },   // ended
  { location_id: id, model: "nws", kind: "periods", issued_at: at("2026-10-02T09:00:00Z"), target_time: at("2026-10-02T11:00:00Z"), target_end_time: at("2026-10-02T23:00:00Z"),
    values: { temp_c: 21, precip_prob_pct: 20, wind_speed_ms: 3.1, short_forecast: "Sunny" } },
];

function setup({ store = fakeStore(), getJson = fakeOpenMeteo(), getParameter = vi.fn(async () => URI), clock = () => NOW } = {}) {
  const notifier = { notify: vi.fn(async () => {}) };
  const send = vi.fn(async () => ({}));
  const handler = createHandler({
    getParameter, makeStore: vi.fn(() => store), makeNotifier: () => notifier, makeS3: () => ({ send, destroy: vi.fn() }),
    getJson, getRunTimes: async () => new Map([["ecmwf_ifs025", at("2026-10-02T00:00:00Z")]]), clock,
  });
  const body = (name) => JSON.parse(send.mock.calls.map(([c]) => c.input).find((i) => i.Key === `dashboard/${name}`).Body);
  return { handler, store, notifier, send, getJson, getParameter, body };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("dailyStats (hourly local time → API-like day rows)", () => {
  it("aggregates the non-null hours of each local day and drops days without values", () => {
    const rows = dailyStats("x", ["2026-09-01T00:00", "2026-09-01T01:00", "2026-09-02T00:00"], [10, null, null]);
    expect(rows).toEqual([{ location_id: "x", period_start: "2026-09-01", min: 10, max: 10, avg: 10, sum: 10, n_values: 1, n_hours: 2 }]);
  });
});

describe("buildRecent", () => {
  it("writes per-city columns and the US average over the cities that have data", async () => {
    const store = fakeStore();
    const { ApiBudget } = await import("../src/lib/apiBudget.js");
    const budget = new ApiBudget(store, "open-meteo-lambda", { perHour: 100, perDay: 100 });
    const { data, errors } = await buildRecent(LOCATIONS, { getJson: fakeOpenMeteo(), budget, days: 3, endDay: "2026-09-27", now: NOW });
    expect(errors).toEqual([]);
    expect(data).toMatchObject({ format: 1, from: "2026-09-25", days: 3, data_as_of: "2026-09-26" });
    expect(data.cities["chicago-il"].temp).toEqual({ min: [10, 10, null], max: [33, 33, null], avg: [21.5, 21.5, null], n: [24, 24, null] });
    expect(data.cities["chicago-il"].precip.sum).toEqual([12, 12, 12]);
    expect(data.all.temp.cities).toEqual([2, 2, null]);
    expect(data.all.temp.n).toEqual([48, 48, null]);
  });

  it("skips a failing city but fails when most cities fail", async () => {
    const store = fakeStore();
    const { ApiBudget } = await import("../src/lib/apiBudget.js");
    const budget = new ApiBudget(store, "om", { perHour: 100, perDay: 100 });
    const one = await buildRecent(LOCATIONS, { getJson: fakeOpenMeteo({ failFor: [21.31] }), budget, days: 3, endDay: "2026-09-27", now: NOW });
    expect(Object.keys(one.data.cities)).toEqual(["chicago-il"]);
    expect(one.errors).toHaveLength(1);
    await expect(buildRecent(LOCATIONS, { getJson: fakeOpenMeteo({ failFor: [21.31, 41.88] }), budget, days: 3, endDay: "2026-09-27", now: NOW }))
      .rejects.toThrow(/history failed for 2 of 2/);
  });
});

describe("buildAlerts", () => {
  it("keeps unexpired alerts in the API's shape, sorted by expiry with open-ended ones last", async () => {
    const store = fakeStore({ alerts: [
      { id: "a", event: "Heat Advisory", expires: null, states: ["IL"], location_ids: ["chicago-il"], description: "long text" },
      { id: "b", event: "Flood Watch", expires: at("2026-10-02T18:00:00Z"), states: ["HI"], location_ids: [] },
      { id: "c", event: "Old", expires: at("2026-10-01T00:00:00Z"), states: ["IL"], location_ids: [] },
    ] });
    const { data } = await buildAlerts(store, { now: NOW });
    expect(data.alerts.map((a) => a.id)).toEqual(["b", "a"]);
    expect(data.alerts[0]).toEqual({ id: "b", event: "Flood Watch", severity: null, urgency: null, certainty: null, headline: null,
      area_desc: null, states: ["HI"], location_ids: [], onset: null, expires: "2026-10-02 18:00:00", ends: null });
  });
});

describe("dashboard publisher handler", () => {
  it("uploads forecasts.json and alerts.json by default, private-bucket style (SSE-S3, cache headers, JSON)", async () => {
    const { handler, send, body } = setup({ store: fakeStore({ snapshots: [...nwsSnapshots("chicago-il"), ...nwsSnapshots("honolulu-hi")] }) });
    const out = await handler({});
    expect(out).toMatchObject({ status: "success", uploaded: ["forecasts.json", "alerts.json", "status.json"], failed: 0 });
    const inputs = send.mock.calls.map(([c]) => { expect(c).toBeInstanceOf(PutObjectCommand); return c.input; });
    expect(inputs[0]).toMatchObject({ Bucket: "weather-pipeline-raw-123456789012", Key: "dashboard/forecasts.json",
      ContentType: "application/json; charset=utf-8", CacheControl: FILES.forecasts.cacheControl, ServerSideEncryption: "AES256" });

    const { forecasts, periods } = body("forecasts.json");
    // NWS: the latest issue only, from the current hour on
    expect(forecasts["chicago-il"].nws).toEqual({ issued_at: "2026-10-02 09:00:00", start: "2026-10-02 12:00:00", hours: [[0, 18, null, 5], [1, 19, null, 5]] });
    // ECMWF has a known run time; past hours are dropped
    expect(forecasts["chicago-il"].ecmwf_ifs025).toEqual({ issued_at: "2026-10-02 00:00:00", start: "2026-10-02 12:00:00", hours: [[0, 20, 0, 10], [1, 21, 0.2, 40]] });
    expect(Object.keys(forecasts["honolulu-hi"])).not.toContain("gfs_hrrr");   // HRRR covers CONUS only
    expect(Object.keys(forecasts["chicago-il"])).toContain("gfs_hrrr");
    // Periods: only those not ended, with the local wall-clock time (Chicago is UTC-5 in October)
    expect(periods["chicago-il"]).toEqual([{ issued_at: "2026-10-02 09:00:00", target_time: "2026-10-02 11:00:00", target_end_time: "2026-10-02 23:00:00",
      local_target_time: "2026-10-02 06:00:00", temp_c: 21, precip_prob_pct: 20, wind_speed_ms: 3.1, short_forecast: "Sunny" }]);
  });

  it("takes the history window from the injected clock, never the real date", async () => {
    // A clock years away from today: if the code read the real date, the window (and these dates) would differ.
    const { handler, getJson, body } = setup({ clock: () => new Date("2031-03-15T06:35:00Z") });
    const out = await handler({ parts: ["history"] });
    expect(out.uploaded).toEqual(["recent.json", "status.json"]);
    // archive lag 5 days → ends 2031-03-10; DASHBOARD_RECENT_DAYS=3 → starts 2031-03-08
    const archive = getJson.mock.calls.map(([url]) => new URL(url)).filter((u) => u.hostname.startsWith("archive"));
    expect(archive.map((u) => [u.searchParams.get("start_date"), u.searchParams.get("end_date")]))
      .toEqual([["2031-03-08", "2031-03-10"], ["2031-03-08", "2031-03-10"]]);
    expect(body("recent.json")).toMatchObject({ from: "2031-03-08", days: 3, data_as_of: "2031-03-09", generated_at: "2031-03-15T06:35:00.000Z" });
  });

  it("publishes recent.json only when asked", async () => {
    const { handler, body } = setup();
    const out = await handler({ parts: ["history"] });
    expect(out.uploaded).toEqual(["recent.json", "status.json"]);
    expect(body("recent.json")).toMatchObject({ format: 1, days: 3 });
  });

  it("stops at the daily PUT cap and says so", async () => {
    const { handler, send, notifier } = setup();
    await handler({ parts: ["history", "forecasts", "alerts"] });   // 3 PUTs = the cap (status.json has its own)
    const out = await handler({ parts: ["alerts"] });
    expect(out).toMatchObject({ status: "failed", uploaded: ["status.json"] });   // status.json alone: still failed
    expect(send.mock.calls.map(([c]) => c.input.Key).filter((k) => k !== "dashboard/status.json")).toHaveLength(3);
    expect(notifier.notify).toHaveBeenLastCalledWith(expect.objectContaining({ level: "error", message: expect.stringMatching(/s3-dashboard daily budget/) }));
  });

  it("never uploads a file with internal values (FORBIDDEN check) and reports a partial run", async () => {
    const store = fakeStore({ alerts: [{ id: "x", event: "see mongodb+srv://u:p@host", expires: null, states: [], location_ids: [] }] });
    const { handler, send, notifier } = setup({ store });
    const out = await handler({ parts: ["history", "alerts"] });
    expect(out).toMatchObject({ status: "partial", uploaded: ["recent.json", "status.json"] });
    expect(send.mock.calls.map(([c]) => c.input.Key)).toEqual(["dashboard/recent.json", "dashboard/status.json"]);
    const [event] = notifier.notify.mock.calls.at(-1);
    expect(event.level).toBe("warn");
    expect(event.message).not.toMatch(/u:p@host/);
  });

  it("publishes status.json last, from pipeline_runs and this run's files, and records its own run", async () => {
    const runs = [
      { stage: "stage1", mode: "forecast", status: "partial", started_at: at("2026-10-02T09:07:00Z"), duration_ms: 88_000,
        errors: [{ location_id: "chicago-il", message: "periods: HTTP 500 for https://api.weather.gov/gridpoints/LOT/1,2" }] },
      { stage: "stage1", mode: "alerts", status: "success", started_at: at("2026-10-02T11:23:00Z"), duration_ms: 8_000,
        public_alerts: { sent: 1, cooldown: 2, not_new: 3, failed: 0 } },
      { stage: "publish", mode: "dashboard", status: "success", started_at: at("2026-10-02T09:35:00Z"), duration_ms: 40_000,
        history_as_of: "2026-09-26", forecasts_generated_at: at("2026-10-02T09:36:00Z") },
    ];
    const store = fakeStore({ runs, snapshots: nwsSnapshots("chicago-il") });
    const { handler, send, body } = setup({ store });
    const out = await handler({});
    expect(out.uploaded.at(-1)).toBe("status.json");
    expect(send.mock.calls.at(-1)[0].input).toMatchObject({ Key: "dashboard/status.json", CacheControl: FILES.status.cacheControl, ServerSideEncryption: "AES256" });
    const status = body("status.json");
    expect(status.generatedAt).toBe(NOW.toISOString());
    expect(status.jobs.map((j) => [j.id, j.lastStatus, j.lastRunAt])).toEqual([
      ["alerts", "ok", "2026-10-02T11:23:00.000Z"],
      ["forecast", "partial", "2026-10-02T09:07:00.000Z"],
      ["publisher", "ok", "2026-10-02T09:35:00.000Z"],   // the previous run: this one isn't finished yet
    ]);
    // forecasts from this run, history from the last run that published it
    expect(status.freshness).toEqual({ historyThrough: "2026-09-26", forecastUpdatedAt: NOW.toISOString() });
    expect(status.incidents.map((i) => i.text)).toEqual(["Forecast collector run: NWS error, not recovered yet"]);   // no city name in this fixture
    expect(status.alerts7d).toEqual({ sent: 1, skippedCooldown: 2, skippedNotNew: 3, runsCounted: 1, since: "2026-10-02T11:23:00.000Z" });

    const own = store.data.pipeline_runs.find((r) => r.etl_batch_id);
    expect(own).toMatchObject({ stage: "publish", mode: "dashboard", status: "success", uploaded: ["forecasts.json", "alerts.json", "status.json"],
      history_as_of: null, forecasts_generated_at: NOW });
  });

  it("freshness comes from the recent.json and forecasts.json uploaded in the same run, never older records", async () => {
    // An older publisher record with stale values: this run's files must win over it.
    const runs = [{ stage: "publish", mode: "dashboard", status: "success", started_at: at("2026-10-01T06:35:00Z"), duration_ms: 1,
      history_as_of: "2026-09-20", forecasts_generated_at: at("2026-09-28T00:00:00Z") }];
    const { handler, body, store } = setup({ store: fakeStore({ runs, snapshots: nwsSnapshots("chicago-il") }) });
    const out = await handler({ parts: ["history", "forecasts", "alerts"] });
    expect(out.uploaded).toEqual(["recent.json", "forecasts.json", "alerts.json", "status.json"]);
    const { freshness } = body("status.json");
    expect(freshness.historyThrough).toBe(body("recent.json").data_as_of);
    expect(freshness.forecastUpdatedAt).toBe(body("forecasts.json").generated_at);
    // NOW = 2026-10-02 12:10 UTC; archive lag 5 days → window ends 2026-09-27, whose last day has no values yet
    expect(freshness).toEqual({ historyThrough: "2026-09-26", forecastUpdatedAt: "2026-10-02T12:10:00.000Z" });
    // ... and the run record keeps them for the next runs (history is only published once a day)
    expect(store.data.pipeline_runs.find((r) => r.etl_batch_id)).toMatchObject({ history_as_of: "2026-09-26", forecasts_generated_at: NOW });
  });

  it("a forecasts-only run takes history from the last run that published it", async () => {
    const runs = [{ stage: "publish", mode: "dashboard", status: "success", started_at: at("2026-10-02T06:35:00Z"), duration_ms: 1, history_as_of: "2026-09-27" }];
    const { handler, body } = setup({ store: fakeStore({ runs, snapshots: nwsSnapshots("chicago-il") }) });
    await handler({});
    expect(body("status.json").freshness).toEqual({ historyThrough: "2026-09-27", forecastUpdatedAt: body("forecasts.json").generated_at });
  });

  it("still publishes status.json when every data file fails, and records the run as failed", async () => {
    const store = fakeStore({ alerts: [{ id: "x", event: "see mongodb+srv://u:p@host", expires: null, states: [], location_ids: [] }] });
    const { handler, body } = setup({ store });
    const out = await handler({ parts: ["alerts"] });
    expect(out).toMatchObject({ status: "failed", uploaded: ["status.json"] });
    expect(body("status.json").jobs).toHaveLength(3);
    const own = store.data.pipeline_runs.find((r) => r.etl_batch_id);
    expect(own).toMatchObject({ status: "failed", error_count: 1 });
    expect(JSON.stringify(own)).not.toContain("u:p@host");
  });

  it("rejects a bad event without touching AWS", async () => {
    const { handler, getParameter, send } = setup();
    expect(await handler({ parts: ["everything"] })).toEqual({ status: "failed" });
    expect(getParameter).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("never throws and redacts the connection string when Atlas is down", async () => {
    const store = fakeStore();
    store.connect.mockRejectedValue(new Error(`connect failed for ${URI}`));
    const { handler, notifier } = setup({ store });
    await expect(handler({})).resolves.toMatchObject({ status: "failed" });
    expect(JSON.stringify(notifier.notify.mock.calls)).not.toContain("s3cret");
  });
});

describe("publicJson", () => {
  it("refuses hostnames and connection strings", () => {
    expect(() => publicJson("a.json", { x: "http://localhost:3000" })).toThrow(/forbidden/);
    expect(publicJson("a.json", { x: 1 })).toBe('{"x":1}');
  });
});
