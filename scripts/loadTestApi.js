// scripts/loadTestApi.js
// Load test the API implementation in backend/ with autocannon: the same 12 dashboard requests in rotation,
// after one warm-up pass (so the Stage 3 cache is filled and framework overhead dominates).
// Usage: node scripts/loadTestApi.js <label>  → prints results, writes docs/analysis/data/api-<label>-load.json

import autocannon from "autocannon";
import { mkdirSync, writeFileSync } from "node:fs";
import { startServer, LOAD_PATHS } from "./apiHarness.js";

const label = process.argv[2] ?? "unnamed";
const DURATION_S = 15;
const CONNECTIONS = 10;

const server = await startServer({ port: 3190, env: { API_RATE_LIMIT_PER_MIN: "100000000" } });
try {
  for (const path of LOAD_PATHS) {
    const res = await fetch(server.base + path);
    if (res.status !== 200) throw new Error(`warm-up ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const latencies = [];
  const result = await autocannon({
    url: server.base,
    connections: CONNECTIONS,
    duration: DURATION_S,
    requests: LOAD_PATHS.map((path) => ({ method: "GET", path })),
    setupClient: (client) => client.on("response", (_status, _bytes, responseTime) => latencies.push(responseTime)),
  });
  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)];
  const summary = {
    label,
    req_per_s: Math.round(result.requests.average),
    p50_ms: Math.round(pct(50) * 10) / 10,
    p95_ms: Math.round(pct(95) * 10) / 10,
    p99_ms: Math.round(pct(99) * 10) / 10,
    requests: result.requests.total,
    non_2xx: result.non2xx,
    errors: result.errors + result.timeouts,
    peak_rss_mb: server.peakRssMb(),
    connections: CONNECTIONS,
    duration_s: DURATION_S,
  };
  console.table([summary]);
  mkdirSync("docs/analysis/data", { recursive: true });
  writeFileSync(`docs/analysis/data/api-${label}-load.json`, JSON.stringify({ summary, paths: LOAD_PATHS, measured_at: new Date() }, null, 2));
} finally {
  await server.stop();
}
