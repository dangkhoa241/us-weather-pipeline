import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Live data from CloudFront with the bundled snapshot as fallback (Stage 6a part 4).
const LIVE = "https://dtest.cloudfront.net";
const BUNDLED = "snapshot-2026-09-26";

const manifest = { format: 1, snapshot: BUNDLED, data_as_of: "2026-09-26", window: { from: "2026-09-24", to: "2026-09-26" }, generated_at: "2026-10-01T22:00:00Z" };
const daily = (id: string, avg: (number | null)[]) => ({
  location_id: id, from: "2026-09-24", days: 3,
  temp: { min: avg, max: avg, avg, n: avg.map((v) => (v == null ? null : 24)) },
  precip: { sum: [0, 0, 0], n: [24, 24, 24] },
});
const recent = {
  format: 1, generated_at: "2026-10-02T06:36:00Z", data_as_of: "2026-09-28", from: "2026-09-26", days: 3,
  cities: { "chicago-il": { temp: { min: [5, 6, 7], max: [5, 6, 7], avg: [5, 6, 7], n: [24, 24, 24] }, precip: { sum: [1, 1, 1], n: [24, 24, 24] } } },
  all: { temp: { min: [1, 1, 1], max: [1, 1, 1], avg: [1, 1, 1], n: [24, 24, 24], cities: [1, 1, 1] }, precip: { sum: [0, 0, 0], n: [24, 24, 24], cities: [1, 1, 1] } },
};
const bundledAlerts = [{ id: "bundled", event: "Old", severity: null, urgency: null, certainty: null, headline: null, area_desc: null, states: ["IL"], location_ids: [], onset: null, expires: null, ends: null }];
const liveAlerts = { format: 1, generated_at: "2026-10-02T09:35:00Z", alerts: [{ ...bundledAlerts[0], id: "live" }] };
const accuracy = { "|2026-09-20|2026-09-26": [{ model: "nws", lead_days: 1, n: 10, mae_c: 1.2, bias_c: 0.1 }] };

type Responses = Record<string, unknown | Error | number>;
function mockFetch(live: Responses) {
  const bundled: Responses = {
    "/data/manifest.json": manifest,
    [`/data/${BUNDLED}/daily-chicago-il.json`]: daily("chicago-il", [10, 11, 12]),
    [`/data/${BUNDLED}/alerts.json`]: bundledAlerts,
    [`/data/${BUNDLED}/accuracy.json`]: accuracy,
  };
  const fetch = vi.fn(async (url: string) => {
    const body = url.startsWith(LIVE) ? live[url.slice(LIVE.length + 1)] ?? 403 : bundled[url] ?? 404;
    if (body instanceof Error) throw body;
    if (typeof body === "number") return new Response("{}", { status: body });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function load(live: Responses) {
  vi.resetModules();
  vi.stubEnv("VITE_LIVE_DATA_URL", LIVE);
  const fetch = mockFetch(live);
  const mod = await import("@/lib/snapshot");
  await mod.initSnapshot();
  return { ...mod, fetch };
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllGlobals());

describe("withRecent", () => {
  it("lays live days over the bundled file and extends the window; days without live data keep the bundled value", async () => {
    const { withRecent } = await import("@/lib/snapshot");
    const live = { temp: { min: [null, 6], max: [null, 6], avg: [null, 6], n: [null, 24] }, precip: { sum: [2, 3], n: [24, 24] } };
    const out = withRecent(daily("x", [10, 11, 12]), live, "2026-09-26", 2);
    expect(out.days).toBe(4);
    expect(out.temp.avg).toEqual([10, 11, 12, 6]);   // 09-26 kept (no live temp), 09-27 added
    expect(out.precip.sum).toEqual([0, 0, 2, 3]);
  });
});

describe("live data with bundled fallback", () => {
  it("uses live history, alerts and the live data-as-of day when CloudFront answers", async () => {
    const { dataSource, snapshotApi, liveTime } = await load({ "recent.json": recent, "alerts.json": liveAlerts });
    expect(dataSource()).toEqual({ kind: "live", data_as_of: "2026-09-28", generated_at: recent.generated_at });
    const stats = await snapshotApi.stats({ locations: "chicago-il", metric: "temp_c", period: "day", from: "2026-09-24", to: "2026-09-28" });
    expect(stats.data.map((r) => r.avg)).toEqual([10, 11, 5, 6, 7]);
    expect(stats.meta?.source).toBe("live");
    expect((await snapshotApi.alerts()).data.map((a) => a.id)).toEqual(["live"]);
    expect(liveTime("alerts")).toBe(liveAlerts.generated_at);
  });

  it("falls back to the bundled snapshot when the live files fail or are invalid", async () => {
    const { dataSource, snapshotApi, liveTime, fetch } = await load({ "recent.json": new TypeError("Failed to fetch"), "alerts.json": { format: 2 } });
    expect(dataSource()).toMatchObject({ kind: "snapshot", data_as_of: "2026-09-26" });
    const stats = await snapshotApi.stats({ locations: "chicago-il", metric: "temp_c", period: "day", from: "2026-09-24", to: "2026-09-26" });
    expect(stats.data.map((r) => r.avg)).toEqual([10, 11, 12]);
    expect((await snapshotApi.alerts()).data.map((a) => a.id)).toEqual(["bundled"]);
    expect(liveTime("alerts")).toBeNull();
    expect(fetch).toHaveBeenCalledWith(`${LIVE}/recent.json`, expect.objectContaining({ signal: expect.any(AbortSignal) }));   // with a timeout
  });

  it("falls back on an HTTP error (e.g. 403 from CloudFront when the file is missing)", async () => {
    const { dataSource } = await load({ "recent.json": 403 });
    expect(dataSource()?.kind).toBe("snapshot");
  });

  it("finds bundled accuracy for a preset range that live history moved forward", async () => {
    const { snapshotApi } = await load({ "recent.json": recent });
    // "last 7 days" ends on the live day 2026-09-28; the bundled table has it ending 2026-09-26 (2 days earlier)
    expect((await snapshotApi.accuracy({ from: "2026-09-22", to: "2026-09-28" })).data).toEqual(accuracy["|2026-09-20|2026-09-26"]);
  });

  it("makes no live request when no CloudFront URL is configured", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_LIVE_DATA_URL", "");
    const fetch = mockFetch({});
    const mod = await import("@/lib/snapshot");
    await mod.initSnapshot();
    expect(mod.dataSource()?.kind).toBe("snapshot");
    expect(fetch.mock.calls.every(([url]) => !String(url).startsWith("https://"))).toBe(true);
  });
});
