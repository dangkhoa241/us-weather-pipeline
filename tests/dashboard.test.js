// Unit tests for the Stage 3 dashboard cache (src/stage3/dashboard.js) and its query keys (src/stage3/queries.js).
// Uses in-memory fakes for the cache and the warehouse, so no Docker is needed.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDashboard, afterStage2, cacheStatus, VERSION_KEY } from "../src/stage3/dashboard.js";
import { queryKey, normalizeQuery, POPULAR_QUERIES } from "../src/stage3/queries.js";

/** In-memory CacheStore with the same contract as RedisCacheStore (JSON values, null when missing). */
function fakeCache() {
  const data = new Map();
  return {
    data,
    get: vi.fn(async (key) => (data.has(key) ? JSON.parse(data.get(key)) : null)),
    set: vi.fn(async (key, value) => { data.set(key, JSON.stringify(value)); }),
    del: vi.fn(async (key) => { data.delete(key); }),
    incr: vi.fn(async (key, by = 1) => { const v = Number(data.get(key) ?? 0) + by; data.set(key, String(v)); return v; }),
    clear: vi.fn(async (prefix) => { let n = 0; for (const k of [...data.keys()]) if (k.startsWith(prefix)) { data.delete(k); n += 1; } return n; }),
  };
}

/** Warehouse whose methods return a marker row and count calls. */
function fakeWarehouse() {
  const answer = (name) => vi.fn(async (params) => [{ from: name, params }]);
  return { queryStats: answer("stats"), mapByState: answer("map"), accuracySummary: answer("accuracy"), cityForecast: answer("forecast") };
}

const MAP = { from: "2026-09-17", to: "2026-09-23" };
const flush = () => new Promise((r) => setTimeout(r, 0));   // let fire-and-forget counters finish

describe("queryKey", () => {
  it("is the same for equivalent parameters in any order", () => {
    const a = queryKey("stats", { metric: "temp_c", period: "day", from: "2026-01-01", to: "2026-01-31", locationIds: ["b", "a", "a"] }, "v1");
    const b = queryKey("stats", { locationIds: ["a", "b"], to: "2026-01-31", from: "2026-01-01", period: "day", metric: "temp_c" }, "v1");
    expect(a).toBe(b);
  });

  it("changes with the data version and with the parameters", () => {
    expect(queryKey("map", MAP, "v1")).not.toBe(queryKey("map", MAP, "v2"));
    expect(queryKey("map", MAP, "v1")).not.toBe(queryKey("map", { ...MAP, to: "2026-09-24" }, "v1"));
  });

  it("never puts raw user input into the key", () => {
    const key = queryKey("forecast", { locationId: "x' OR 1=1 --\r\nFLUSHALL" }, "v1");
    expect(key).toMatch(/^wx:q:v1:forecast:[0-9a-f]{16}$/);
  });

  it("rejects unknown query types", () => {
    expect(() => normalizeQuery("drop-table", {})).toThrow(/Unknown query type/);
  });
});

describe("createDashboard (cache-aside)", () => {
  let cache, warehouse, dashboard;
  beforeEach(async () => {
    cache = fakeCache();
    warehouse = fakeWarehouse();
    dashboard = createDashboard({ warehouse, cache, ttlSec: 60 });
    await cache.set(VERSION_KEY, { version: "v1" });
  });

  it("queries the warehouse on a miss, then serves the cached result", async () => {
    const first = await dashboard.query("map", MAP);
    const second = await dashboard.query("map", MAP);
    expect(first.source).toBe("warehouse");
    expect(second.source).toBe("cache");
    expect(second.data).toEqual(first.data);
    expect(warehouse.mapByState).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(queryKey("map", MAP, "v1"), first.data, { ttlSec: 60 });
  });

  it("shares one warehouse query between concurrent misses (single-flight)", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => dashboard.query("forecast", { locationId: "miami-fl" })));
    expect(warehouse.cityForecast).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => JSON.stringify(r.data))).size).toBe(1);
  });

  it("falls back to the warehouse when the cache fails", async () => {
    cache.get.mockRejectedValue(new Error("Redis down"));
    cache.set.mockRejectedValue(new Error("Redis down"));
    const r = await dashboard.query("map", MAP);
    expect(r.source).toBe("warehouse");
    expect(r.data[0].from).toBe("map");
  });

  it("propagates warehouse errors and does not cache them", async () => {
    warehouse.mapByState.mockRejectedValueOnce(new Error("ClickHouse down"));
    await expect(dashboard.query("map", MAP)).rejects.toThrow("ClickHouse down");
    expect(cache.data.has(queryKey("map", MAP, "v1"))).toBe(false);
    expect((await dashboard.query("map", MAP)).source).toBe("warehouse");   // retried, not stuck
  });

  it("counts hits and misses per query type", async () => {
    await dashboard.query("map", MAP);
    await dashboard.query("map", MAP);
    await dashboard.query("map", MAP);
    await flush();
    const status = await cacheStatus(cache);
    expect(status.by_type.map).toEqual({ hits: 2, misses: 1 });
    expect(status.hit_rate).toBeCloseTo(2 / 3, 2);
    expect(status.data_version).toBe("v1");
  });
});

describe("afterStage2", () => {
  it("pre-warms popular queries under the new version before switching readers to it", async () => {
    const cache = fakeCache();
    const warehouse = fakeWarehouse();
    const order = [];
    cache.set.mockImplementation(async (key, value) => { order.push(key); cache.data.set(key, JSON.stringify(value)); });

    const result = await afterStage2({ warehouse, cache, dataVersion: "v2", loadedAt: new Date("2026-09-30T06:00:00Z") });

    expect(result).toMatchObject({ prewarmed: POPULAR_QUERIES.length, failed: 0 });
    expect(order.at(-1)).toBe(VERSION_KEY);   // pointer switched last
    expect(order.slice(0, -1).every((k) => k.startsWith("wx:q:v2:"))).toBe(true);
    const dashboard = createDashboard({ warehouse, cache });
    expect((await dashboard.query("map", POPULAR_QUERIES[0].params)).source).toBe("cache");   // landing page never cold
  });

  it("deletes the previous version's cached results", async () => {
    const cache = fakeCache();
    const warehouse = fakeWarehouse();
    await afterStage2({ warehouse, cache, dataVersion: "v1" });
    const dashboard = createDashboard({ warehouse, cache });
    await dashboard.query("forecast", { locationId: "miami-fl" });   // cache-aside entry under v1
    const result = await afterStage2({ warehouse, cache, dataVersion: "v2" });
    expect(result.deleted).toBeGreaterThan(0);
    expect([...cache.data.keys()].some((k) => k.startsWith("wx:q:v1:"))).toBe(false);
    expect((await cache.get(VERSION_KEY)).version).toBe("v2");
  });

  it("still switches the version when some warm-up queries fail", async () => {
    const cache = fakeCache();
    const warehouse = fakeWarehouse();
    warehouse.mapByState.mockRejectedValue(new Error("timeout"));
    const result = await afterStage2({ warehouse, cache, dataVersion: "v3" });
    expect(result.failed).toBe(POPULAR_QUERIES.filter((q) => q.type === "map").length);
    expect((await cache.get(VERSION_KEY)).version).toBe("v3");
  });
});
