// src/stage3/dashboard.js — caching strategy v3: pre-warmed popular queries + cache-aside fallback.
// After each Stage 2 load, the popular landing-page queries are computed under the NEW data version first, and
// only then is the version pointer switched, so readers never meet an empty cache. Other queries use
// cache-aside like v2. Concurrent misses for the same key share one warehouse query (single-flight).

import { config } from "../config.js";
import { QUERY_TYPES, POPULAR_QUERIES, normalizeQuery, queryKey } from "./queries.js";

export const VERSION_KEY = "wx:meta:data_version";
const PREWARM_CONCURRENCY = 4;

export function createDashboard({ warehouse, cache, ttlSec = config.redis.ttlSec }) {
  const inFlight = new Map();   // key → Promise of data (single-flight)

  async function currentVersion() {
    try {
      return (await cache.get(VERSION_KEY))?.version ?? "none";
    } catch {
      return null;   // cache unavailable
    }
  }

  async function loadAndStore(type, normalized, key) {
    const data = await QUERY_TYPES[type].run(warehouse, normalized);
    if (key) await cache.set(key, data, { ttlSec }).catch(() => {});
    return data;
  }

  return {
    async query(type, params) {
      const normalized = normalizeQuery(type, params);
      const version = await currentVersion();
      const key = version && queryKey(type, normalized, version);
      if (key) {
        try {
          const hit = await cache.get(key);
          if (hit !== null) return { data: hit, source: "cache" };
        } catch { /* cache read failed: use the warehouse */ }
        if (!inFlight.has(key)) {
          inFlight.set(key, loadAndStore(type, normalized, key).finally(() => inFlight.delete(key)));
        }
        return { data: await inFlight.get(key), source: "warehouse" };
      }
      return { data: await loadAndStore(type, normalized, null), source: "warehouse" };
    },
  };
}

/** Run `tasks` (functions returning promises) with at most `limit` running at once. */
async function runLimited(tasks, limit) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * Warm the popular queries under the new data version, then switch readers to it and delete the old version.
 * If warming fails part-way, the switch still happens (missing entries fall back to cache-aside).
 */
export async function afterStage2({ warehouse, cache, dataVersion, loadedAt = new Date(), ttlSec = config.redis.ttlSec }) {
  const previous = (await cache.get(VERSION_KEY))?.version;
  const outcomes = await runLimited(POPULAR_QUERIES.map(({ type, params }) => async () => {
    try {
      const normalized = normalizeQuery(type, params);
      await cache.set(queryKey(type, normalized, dataVersion), await QUERY_TYPES[type].run(warehouse, normalized), { ttlSec });
      return true;
    } catch {
      return false;
    }
  }), PREWARM_CONCURRENCY);
  await cache.set(VERSION_KEY, { version: dataVersion, loaded_at: loadedAt, switched_at: new Date() }, { ttlSec: 0 });
  const deleted = previous && previous !== dataVersion ? await cache.clear(`wx:q:${previous}:`) : 0;
  return { prewarmed: outcomes.filter(Boolean).length, failed: outcomes.filter((ok) => !ok).length, deleted };
}
