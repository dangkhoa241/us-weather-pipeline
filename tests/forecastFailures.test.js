import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runMode } from "../src/stage1/runMode.js";
import { forecastFailureEvent, newRepeatFailures } from "../src/stage1/nwsForecast.js";

// NWS: Kansas City's grid point answers 500 while `failing` is on (as on 2026-10-07 00:07–06:07 UTC).
const nws = vi.hoisted(() => ({ failing: false }));
vi.mock("../src/lib/http.js", () => ({
  nwsGet: vi.fn(async (url) => {
    if (nws.failing && url.includes("/EAX/")) throw new Error(`HTTP 500 for ${url} - { "title": "Unexpected Problem" }`);
    const t = new Date().toISOString();
    return { properties: { updateTime: t, generatedAt: t, periods: [{ startTime: t, endTime: t, temperature: 20 }] } };
  }),
}));

const locations = [
  { id: "chicago-il", name: "Chicago", state: "IL", nws_forecast_url: "https://api.weather.gov/gridpoints/LOT/76,73/forecast", nws_forecast_hourly_url: "https://api.weather.gov/gridpoints/LOT/76,73/forecast/hourly" },
  { id: "kansas-city-mo", name: "Kansas City", state: "MO", nws_forecast_url: "https://api.weather.gov/gridpoints/EAX/44,51/forecast", nws_forecast_hourly_url: "https://api.weather.gov/gridpoints/EAX/44,51/forecast/hourly" },
];

/** In-memory RawStore: enough of the interface for runMode + the forecast stage. */
function memoryStore() {
  const db = { locations: structuredClone(locations), pipeline_runs: [], forecast_snapshots: [] };
  const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => (v && typeof v === "object" && !(v instanceof Date) ? true : doc[k] === v));
  return {
    db,
    async find(c, filter = {}, { sort, limit } = {}) {
      let rows = (db[c] ?? []).filter((d) => matches(d, filter));
      if (sort) {
        const [[k, dir]] = Object.entries(sort);
        rows = [...rows].sort((a, b) => (a[k] < b[k] ? -dir : a[k] > b[k] ? dir : 0));
      }
      return structuredClone(limit ? rows.slice(0, limit) : rows);
    },
    async insertOne(c, doc) { db[c].push({ ...doc }); },
    async updateOne(c, filter, fields) { Object.assign(db[c].find((d) => matches(d, filter)), fields); },
    async upsertMany(c, docs) { db[c].push(...docs); return { inserted: docs.length, updated: 0, unchanged: 0 }; },
    addRawResponse() {},
    async flushRawResponses() {},
  };
}

describe("NWS forecast partial runs → email only when a city fails 2 runs in a row (fixed dates)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("replays 2026-10-07: 1 failed run → no email, 2 in a row → 1 email, still failing → none, recovery → none", async () => {
    const store = memoryStore();
    const notifier = { notify: vi.fn(async () => {}) };
    const at = async (time, failing) => {
      vi.setSystemTime(new Date(time));
      nws.failing = failing;
      const before = notifier.notify.mock.calls.length;
      const { status } = await runMode("forecast", store, notifier, {});
      return { status, emails: notifier.notify.mock.calls.slice(before).map(([e]) => e) };
    };

    expect(await at("2026-10-06T21:07:00Z", false)).toEqual({ status: "success", emails: [] });
    expect(await at("2026-10-07T00:07:00Z", true)).toEqual({ status: "partial", emails: [] });     // first failure: no email
    expect(await at("2026-10-07T03:07:00Z", true)).toEqual({ status: "partial", emails: [{       // second in a row: one email
      level: "warn",
      title: "Stage 1 forecast: 1 city failed 2 runs in a row",
      message: "Kansas City, MO failed: NWS HTTP 500 on 2 calls; last good forecast from 2026-10-06 21:07 UTC",
    }] });
    expect(await at("2026-10-07T06:07:00Z", true)).toEqual({ status: "partial", emails: [] });     // already told
    expect(await at("2026-10-07T09:07:00Z", false)).toEqual({ status: "success", emails: [] });    // recovery: no email
    // Every partial run is still recorded with its errors.
    expect(store.db.pipeline_runs.map((r) => [r.status, r.error_count])).toEqual([["success", 0], ["partial", 2], ["partial", 2], ["partial", 2], ["success", 0]]);

    // A new streak after recovery warns again on its second run.
    expect((await at("2026-10-08T00:07:00Z", true)).emails).toEqual([]);
    expect((await at("2026-10-08T03:07:00Z", true)).emails.map((e) => e.message)).toEqual([
      "Kansas City, MO failed: NWS HTTP 500 on 2 calls; last good forecast from 2026-10-07 09:07 UTC",
    ]);
  });

  it("other run failures keep the old email (a fatal forecast run)", async () => {
    vi.setSystemTime(new Date("2026-10-07T00:07:00Z"));
    const store = { ...memoryStore(), find: vi.fn(async () => { throw new Error("Atlas down"); }) };
    const notifier = { notify: vi.fn(async () => {}) };
    await runMode("forecast", store, notifier, {});
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", title: "Stage 1 forecast failed" }));
  });

  it("counts a streak per city and words each line by city", () => {
    const kc = { location_id: "kansas-city-mo", message: "hourly: HTTP 500 for x" };
    const chi = { location_id: "chicago-il", message: "periods: fetch failed - socket hang up" };
    const run = (...errors) => ({ errors });
    expect(newRepeatFailures([kc, chi], [run(kc), run()])).toEqual(["kansas-city-mo"]);   // chicago: first failure
    expect(newRepeatFailures([kc], [run(kc), run(kc)])).toEqual([]);                        // 3rd in a row: already told
    expect(newRepeatFailures([kc], [])).toEqual([]);                                         // no history yet
    const event = forecastFailureEvent(["chicago-il", "kansas-city-mo"], [kc, chi], locations, { "kansas-city-mo": new Date("2026-10-06T21:08:00Z") });
    expect(event.message.split("\n")).toEqual([
      "Chicago, IL failed: periods: fetch failed on 1 call; no good forecast stored",
      "Kansas City, MO failed: NWS HTTP 500 on 1 call; last good forecast from 2026-10-06 21:08 UTC",
    ]);
  });
});
