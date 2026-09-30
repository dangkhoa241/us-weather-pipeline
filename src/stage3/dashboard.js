// src/stage3/dashboard.js — caching strategy v1: no cache.
// Every dashboard request goes straight to the warehouse. Simplest possible baseline; nothing to invalidate.

import { QUERY_TYPES, normalizeQuery } from "./queries.js";

export function createDashboard({ warehouse }) {
  return {
    async query(type, params) {
      const normalized = normalizeQuery(type, params);
      return { data: await QUERY_TYPES[type].run(warehouse, normalized), source: "warehouse" };
    },
  };
}

/** Nothing is cached, so there is nothing to refresh after a Stage 2 load. */
export async function afterStage2() {
  return { prewarmed: 0 };
}
