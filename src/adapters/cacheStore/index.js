// Factory: picks the CacheStore implementation from config (CACHE_STORE in .env).

import { config } from "../../config.js";
import { RedisCacheStore } from "./redisCacheStore.js";

export function createCacheStore(kind = config.adapters.cacheStore) {
  switch (kind) {
    case "redis":
      return new RedisCacheStore(config.redis);
    // case "dynamodb": return new DynamoCacheStore(config.dynamodb);   // optional AWS phase
    default:
      throw new Error(`Unknown CACHE_STORE "${kind}". Supported: redis`);
  }
}

export { CacheStore } from "./CacheStore.js";
