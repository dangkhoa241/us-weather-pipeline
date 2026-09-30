// src/api/deps.js
// Connect the adapters the API needs and build the service. The cache is optional: if Redis is down the API
// still answers from the warehouse (and /health reports "degraded").

import { createRawStore } from "../adapters/rawStore/index.js";
import { createWarehouse } from "../adapters/warehouse/index.js";
import { createCacheStore } from "../adapters/cacheStore/index.js";
import { createService } from "./service.js";
import { config } from "../config.js";

export async function createApiDeps() {
  const store = createRawStore();
  const warehouse = createWarehouse();
  const cache = createCacheStore();
  await Promise.all([store.connect(), warehouse.connect(), cache.connect({ optional: true })]);
  const service = createService({ warehouse, cache, store });
  if (config.api.benchMemoryLog) {
    setInterval(() => console.log(`[mem] ${JSON.stringify({ rss: process.memoryUsage().rss })}`), 250).unref();
  }
  return {
    service,
    async close() {
      await Promise.allSettled([store.close(), warehouse.close(), cache.close()]);
    },
  };
}
