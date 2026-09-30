// src/stage3/dashboard.js — dashboard reads through a Redis cache (chosen strategy, see docs/analysis/caching.md).
// Cache-aside: look in the cache, on a miss query the warehouse and store the result with a TTL. Keys contain the
// current data version (latest Stage 2 run); after each load, the small set of popular landing-page queries is
// computed under the NEW version first, then the version pointer switches, so the landing page is never cold.
// Concurrent misses for one key share a single warehouse query (single-flight). Cache errors fall back to the
// warehouse. Hit/miss counters and the version record give the API a real cache/sync status.

import { config } from "../config.js";
import { QUERY_TYPES, POPULAR_QUERIES, normalizeQuery, queryKey } from "./queries.js";

export const VERSION_KEY = "wx:meta:data_version";
const COUNTER_PREFIX = "wx:stats:";   // wx:stats:hit:<type>, wx:stats:miss:<type>
const QUERY_TYPE_NAMES = Object.keys(QUERY_TYPES);
const PREWARM_CONCURRENCY = 4;

export function createDashboard({ warehouse, cache, ttlSec = config.redis.ttlSec }) {
  const inFlight = new Map();   // key → Promise of data (single-flight)
  const count = (kind, type) => { cache.incr(`${COUNTER_PREFIX}${kind}:${type}`).catch(() => {}); };   // fire and forget

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
          if (hit !== null) {
            count("hit", type);
            return { data: hit, source: "cache" };
          }
        } catch { /* cache read failed: use the warehouse */ }
        count("miss", type);
        if (!inFlight.has(key)) {
          inFlight.set(key, loadAndStore(type, normalized, key).finally(() => inFlight.delete(key)));
        }
        return { data: await inFlight.get(key), source: "warehouse" };
      }
      return { data: await loadAndStore(type, normalized, null), source: "warehouse" };
    },
  };
}

/**
 * Cache and sync status for the API: which Stage 2 load the cache serves (and when it was loaded/switched), plus
 * hit/miss counts per query type since the counters were last reset.
 */
export async function cacheStatus(cache) {
  const version = await cache.get(VERSION_KEY);
  const counters = {};
  for (const type of QUERY_TYPE_NAMES) {
    const [hits, misses] = await Promise.all([cache.get(`${COUNTER_PREFIX}hit:${type}`), cache.get(`${COUNTER_PREFIX}miss:${type}`)]);
    counters[type] = { hits: Number(hits ?? 0), misses: Number(misses ?? 0) };
  }
  const total = Object.values(counters).reduce((a, c) => ({ hits: a.hits + c.hits, misses: a.misses + c.misses }), { hits: 0, misses: 0 });
  return {
    data_version: version?.version ?? null,
    loaded_at: version?.loaded_at ?? null,
    switched_at: version?.switched_at ?? null,
    hit_rate: total.hits + total.misses ? Math.round((1000 * total.hits) / (total.hits + total.misses)) / 1000 : null,
    ...total,
    by_type: counters,
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
