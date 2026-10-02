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
function fakeStore({ alerts = [], snapshots = [] } = {}) {
  const usage = new Map();
  const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
    if (k === "$or") return v.some((f) => matches(doc, f));
    if (v && typeof v === "object" && !(v instanceof Date)) {
      return (v.$gte == null || doc[k] >= v.$gte) && (v.$lt == null || doc[k] < v.$lt) && (v.$gt == null || (doc[k] != null && doc[k] > v.$gt));
    }
    return v instanceof Date ? doc[k]?.getTime() === v.getTime() : (doc[k] ?? null) === v;
  });
  const data = { locations: LOCATIONS, alerts, forecast_snapshots: snapshots };
  return {
    usage,
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

/** Open-Meteo stand-in: archive → 3 local days of hourly values; forecast → 2 hours for every requested model. */
function fakeOpenMeteo({ failFor = [] } = {}) {
  return vi.fn(async (url) => {
    const u = new URL(url);
    if (failFor.some((lat) => u.searchParams.get("latitude") === String(lat))) throw new Error("HTTP 429 for open-meteo");
    if (u.hostname.startsWith("archive")) {
      const time = [];
      for (const day of ["2026-09-25", "2026-09-26", "2026-09-27"]) for (let h = 0; h < 24; h += 1) time.push(`${day}T${String(h).padStart(2, "0")}:00`);
      const temp = time.map((t, i) => (t.startsWith("2026-09-27") ? null : 10 + (i % 24)));   // last day: no data yet
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

function setup({ store = fakeStore(), getJson = fakeOpenMeteo(), getParameter = vi.fn(async () => URI) } = {}) {
  const notifier = { notify: vi.fn(async () => {}) };
  const send = vi.fn(async () => ({}));
  const handler = createHandler({
    getParameter, makeStore: vi.fn(() => store), makeNotifier: () => notifier, makeS3: () => ({ send, destroy: vi.fn() }),
    getJson, getRunTimes: async () => new Map([["ecmwf_ifs025", at("2026-10-02T00:00:00Z")]]), clock: () => NOW,
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
    expect(out).toMatchObject({ status: "success", uploaded: ["forecasts.json", "alerts.json"], failed: 0 });
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

  it("publishes recent.json only when asked", async () => {
    const { handler, body } = setup();
    const out = await handler({ parts: ["history"] });
    expect(out.uploaded).toEqual(["recent.json"]);
    expect(body("recent.json")).toMatchObject({ format: 1, days: 3 });
  });

  it("stops at the daily PUT cap and says so", async () => {
    const { handler, send, notifier } = setup();
    await handler({ parts: ["history", "forecasts", "alerts"] });   // 3 PUTs = the cap
    const out = await handler({ parts: ["alerts"] });
    expect(out.status).toBe("failed");
    expect(send).toHaveBeenCalledTimes(3);
    expect(notifier.notify).toHaveBeenLastCalledWith(expect.objectContaining({ level: "error", message: expect.stringMatching(/s3-dashboard daily budget/) }));
  });

  it("never uploads a file with internal values (FORBIDDEN check) and reports a partial run", async () => {
    const store = fakeStore({ alerts: [{ id: "x", event: "see mongodb+srv://u:p@host", expires: null, states: [], location_ids: [] }] });
    const { handler, send, notifier } = setup({ store });
    const out = await handler({ parts: ["history", "alerts"] });
    expect(out).toMatchObject({ status: "partial", uploaded: ["recent.json"] });
    expect(send.mock.calls.map(([c]) => c.input.Key)).toEqual(["dashboard/recent.json"]);
    const [event] = notifier.notify.mock.calls.at(-1);
    expect(event.level).toBe("warn");
    expect(event.message).not.toMatch(/u:p@host/);
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
