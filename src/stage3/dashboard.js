// src/stage3/dashboard.js — caching strategy v2: cache-aside per query.
// Look in the cache first; on a miss, query the warehouse and store the result with a TTL. Keys contain the
// current data version (the latest Stage 2 run), so a Stage 2 load invalidates everything by moving the version
// pointer; the old version's keys are then deleted. If the cache is down, requests fall back to the warehouse.

import { config } from "../config.js";
import { QUERY_TYPES, normalizeQuery, queryKey } from "./queries.js";

export const VERSION_KEY = "wx:meta:data_version";

export function createDashboard({ warehouse, cache, ttlSec = config.redis.ttlSec }) {
  async function currentVersion() {
    try {
      return (await cache.get(VERSION_KEY))?.version ?? "none";
    } catch {
      return null;   // cache unavailable
    }
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
      }
      const data = await QUERY_TYPES[type].run(warehouse, normalized);
      if (key) await cache.set(key, data, { ttlSec }).catch(() => {});
      return { data, source: "warehouse" };
    },
  };
}

/** Point readers at the new data version and delete the previous version's cached results. */
export async function afterStage2({ cache, dataVersion, loadedAt = new Date() }) {
  const previous = (await cache.get(VERSION_KEY))?.version;
  await cache.set(VERSION_KEY, { version: dataVersion, loaded_at: loadedAt, switched_at: new Date() }, { ttlSec: 0 });
  const deleted = previous && previous !== dataVersion ? await cache.clear(`wx:q:${previous}:`) : 0;
  return { prewarmed: 0, deleted };
}
