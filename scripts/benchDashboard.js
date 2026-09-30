// scripts/benchDashboard.js
// Benchmark a caching strategy (src/stage3/dashboard.js) on the 10 dashboard queries in src/stage3/queries.js.
// Cold = first request after a Stage 2 run (afterStage2 with a new data version); warm = repeated requests.
// Usage: node scripts/benchDashboard.js <label>   → prints a table and writes docs/analysis/data/caching-<label>.json

import { performance } from "node:perf_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { createWarehouse } from "../src/adapters/warehouse/index.js";
import { createCacheStore } from "../src/adapters/cacheStore/index.js";
import { BENCH_QUERIES } from "../src/stage3/queries.js";
import { createDashboard, afterStage2 } from "../src/stage3/dashboard.js";

const COLD_ROUNDS = 5;
const WARM_REPEATS = 20;
const label = process.argv[2] ?? "unnamed";

const pct = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const ms = (v) => Math.round(v * 10) / 10;

async function timed(fn) {
  const t0 = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - t0 };
}

const warehouse = createWarehouse();
const cache = createCacheStore();
try {
  await warehouse.connect();
  await cache.connect();
  await cache.clear("wx:");
  const memoryBefore = await cache.stats();
  const dashboard = createDashboard({ warehouse, cache });

  const cold = new Map(BENCH_QUERIES.map((q) => [q.name, []]));
  const warm = new Map(BENCH_QUERIES.map((q) => [q.name, []]));
  const refreshMs = [];
  const rowCounts = new Map();

  for (let round = 0; round < COLD_ROUNDS; round += 1) {
    const { ms: t } = await timed(() => afterStage2({ warehouse, cache, dataVersion: `bench-${Date.now()}-${round}` }));
    refreshMs.push(t);
    for (const q of BENCH_QUERIES) {
      const { result, ms: qt } = await timed(() => dashboard.query(q.type, q.params));
      cold.get(q.name).push(qt);
      rowCounts.set(q.name, result.data.length);
    }
  }
  for (let i = 0; i < WARM_REPEATS; i += 1) {
    for (const q of BENCH_QUERIES) warm.get(q.name).push((await timed(() => dashboard.query(q.type, q.params))).ms);
  }
  const memoryAfter = await cache.stats();

  const perQuery = BENCH_QUERIES.map((q) => ({
    query: q.name, rows: rowCounts.get(q.name),
    cold_p50_ms: ms(pct(cold.get(q.name), 50)), warm_p50_ms: ms(pct(warm.get(q.name), 50)),
  }));
  const allCold = [...cold.values()].flat();
  const allWarm = [...warm.values()].flat();
  const summary = {
    label,
    cold_p50_ms: ms(pct(allCold, 50)), cold_p95_ms: ms(pct(allCold, 95)),
    warm_p50_ms: ms(pct(allWarm, 50)), warm_p95_ms: ms(pct(allWarm, 95)),
    after_stage2_ms: ms(pct(refreshMs, 50)),
    redis_keys: memoryAfter.keys,
    redis_memory_kb: Math.round((memoryAfter.usedBytes - memoryBefore.usedBytes) / 1024),
    samples: { cold: allCold.length, warm: allWarm.length },
  };
  console.table(perQuery);
  console.table([summary]);
  mkdirSync("docs/analysis/data", { recursive: true });
  writeFileSync(`docs/analysis/data/caching-${label}.json`, JSON.stringify({ summary, perQuery, measured_at: new Date() }, null, 2));
} finally {
  await cache.clear("wx:").catch(() => {});
  await cache.close();
  await warehouse.close();
}
