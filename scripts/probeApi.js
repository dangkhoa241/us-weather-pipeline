// scripts/probeApi.js
// Black-box security and contract probe of the API in backend/: input validation, error leakage, CORS,
// security headers, rate limiting, OpenAPI docs. Same checks for every implementation.
// Usage: node scripts/probeApi.js <label>  → prints a pass/fail table, writes docs/analysis/data/api-<label>-probe.json

import { mkdirSync, writeFileSync } from "node:fs";
import { startServer } from "./apiHarness.js";

const label = process.argv[2] ?? "unnamed";
const RATE_LIMIT = 30;
const ROUTES = ["/api/v1/locations", "/api/v1/stats", "/api/v1/map", "/api/v1/drill", "/api/v1/forecast/{locationId}",
  "/api/v1/alerts", "/api/v1/accuracy", "/api/v1/records", "/api/v1/pipeline/status", "/api/v1/pipeline/runs", "/api/v1/health"];

const server = await startServer({ port: 3191, env: { API_RATE_LIMIT_PER_MIN: String(RATE_LIMIT), CORS_ORIGINS: "http://localhost:5173" } });
const results = [];
const check = (group, name, pass, detail = "") => results.push({ group, check: name, pass: pass ? "PASS" : "FAIL", detail: String(detail).slice(0, 80) });
const get = (path, headers = {}) => fetch(server.base + path, { headers });
const leaks = (text) => /\bat .+\.(js|ts):\d+|node_modules|ClickHouse|Mongo|ECONN|stack/i.test(text);

try {
  // Input validation: bad values get a 400 JSON error, never reach the database, never echo internals.
  const bad = {
    "unknown metric": "/api/v1/stats?locations=stockton-ca&metric=DROP",
    "SQL-like location": "/api/v1/stats?locations=stockton-ca'%20OR%201=1--",
    "NoSQL operator in query": "/api/v1/pipeline/runs?stage[$ne]=x",
    "bad date": "/api/v1/map?from=2026-13-45&to=2026-09-23",
    "too many locations": `/api/v1/stats?locations=${Array.from({ length: 26 }, (_, i) => `city-${i}`).join(",")}`,
    "limit out of range": "/api/v1/pipeline/runs?limit=100000",
    "path traversal in id": "/api/v1/forecast/..%2F..%2Fetc%2Fpasswd",
    "bad drill key": "/api/v1/drill?location=miami-fl&level=quarter&key=2025-Q9",
  };
  for (const [name, path] of Object.entries(bad)) {
    const res = await get(path);
    const text = await res.text();
    const json = (() => { try { return JSON.parse(text); } catch { return null; } })();
    check("validation", name, res.status === 400 && json?.error?.code && !leaks(text), `${res.status} ${text.slice(0, 60)}`);
  }
  const notFound = await get("/api/v1/forecast/atlantis-xx");
  check("validation", "unknown location → 404", notFound.status === 404, notFound.status);

  // Error leakage: unknown routes and methods give JSON without stack traces or server details.
  const noRoute = await get("/api/v1/does-not-exist");
  const noRouteText = await noRoute.text();
  check("errors", "unknown route → 404 JSON", noRoute.status === 404 && noRouteText.startsWith("{") && !leaks(noRouteText), `${noRoute.status} ${noRouteText.slice(0, 50)}`);
  const post = await fetch(`${server.base}/api/v1/locations`, { method: "POST" });
  check("errors", "unsupported method → 404/405", [404, 405].includes(post.status), post.status);
  const malformed = await get("/api/v1/stats?locations=%E0%A4%A");
  const malformedText = await malformed.text();
  check("errors", "malformed URL encoding → 4xx, no leak", malformed.status >= 400 && malformed.status < 500 && !leaks(malformedText), `${malformed.status} ${malformedText.slice(0, 50)}`);

  // CORS: only the configured dashboard origin is allowed.
  const good = await get("/api/v1/locations", { Origin: "http://localhost:5173" });
  check("cors", "allowed origin gets ACAO", good.headers.get("access-control-allow-origin") === "http://localhost:5173", good.headers.get("access-control-allow-origin"));
  const evil = await get("/api/v1/locations", { Origin: "https://evil.example" });
  const acao = evil.headers.get("access-control-allow-origin");
  check("cors", "other origin gets no ACAO", !acao || acao === "http://localhost:5173", acao ?? "none");

  // Security headers.
  const h = good.headers;
  check("headers", "X-Content-Type-Options: nosniff", h.get("x-content-type-options") === "nosniff", h.get("x-content-type-options"));
  check("headers", "clickjacking protection", Boolean(h.get("x-frame-options") || /frame-ancestors/.test(h.get("content-security-policy") ?? "")), h.get("x-frame-options") ?? h.get("content-security-policy"));
  check("headers", "no X-Powered-By", !h.get("x-powered-by"), h.get("x-powered-by") ?? "none");
  check("headers", "Referrer-Policy set", Boolean(h.get("referrer-policy")), h.get("referrer-policy"));

  // OpenAPI docs.
  const docs = await get("/docs");
  const docsText = await docs.text();
  check("docs", "/docs serves Swagger UI", docs.status === 200 && /swagger/i.test(docsText), docs.status);
  const spec = await (await get("/openapi.json")).json().catch(() => ({}));
  const documented = Object.keys(spec.paths ?? {}).map((p) => p.replace(/:(\w+)/g, "{$1}"));
  const missing = ROUTES.filter((r) => !documented.includes(r));
  check("docs", "openapi.json lists all 11 routes", missing.length === 0, missing.length ? `missing ${missing.join(" ")}` : `${documented.length} paths`);

  // Rate limiting last (it uses up the budget): more than RATE_LIMIT requests/minute from one IP get 429.
  const statuses = [];
  for (let i = 0; i < RATE_LIMIT + 10; i += 1) statuses.push((await get("/api/v1/locations")).status);
  const limited = await get("/api/v1/locations");
  check("rate limit", `429 after ${RATE_LIMIT}/min`, statuses.includes(429), `${statuses.filter((s) => s === 429).length} of ${statuses.length} were 429`);
  check("rate limit", "429 tells when to retry", Boolean(limited.headers.get("retry-after") || limited.headers.get("ratelimit-reset") || limited.headers.get("x-ratelimit-reset") || limited.headers.get("ratelimit")),
    limited.headers.get("retry-after") ?? limited.headers.get("ratelimit-reset") ?? limited.headers.get("ratelimit"));
} finally {
  await server.stop();
}

console.table(results);
const passed = results.filter((r) => r.pass === "PASS").length;
console.log(`${label}: ${passed}/${results.length} checks passed`);
mkdirSync("docs/analysis/data", { recursive: true });
writeFileSync(`docs/analysis/data/api-${label}-probe.json`, JSON.stringify({ label, passed, total: results.length, results, measured_at: new Date() }, null, 2));
