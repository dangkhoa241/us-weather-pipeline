// backend/app.js — Stage 4 API, v3: Hono + @hono/zod-openapi (runs on Node here; the same app runs on
// edge/serverless runtimes). Routes call the framework-independent service (src/api/service.js); this file only
// does HTTP: validation, security middleware, errors and docs.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { rateLimiter } from "hono-rate-limiter";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "../src/config.js";
import { ApiError } from "../src/api/service.js";
import { PATTERNS, METRICS, PERIODS, DRILL_LEVELS, COMPARE, STAGES, LIMITS } from "../src/api/params.js";

// ---- Schemas (shared rules from src/api/params.js); query objects reject unknown keys -------------------------
const locationId = z.string().regex(new RegExp(PATTERNS.locationId)).openapi({ example: "stockton-ca" });
const date = z.string().regex(new RegExp(PATTERNS.date)).openapi({ example: "2026-09-01" });
const range = { from: date.optional(), to: date.optional() };
const locationList = z.string().max(1000)
  .transform((s) => s.split(","))
  .pipe(z.array(locationId).min(1).max(LIMITS.maxLocations))
  .openapi({ type: "string", example: "stockton-ca,miami-fl", description: "comma-separated location ids" });

const Q = {
  none: z.object({}).strict(),
  stats: z.object({
    locations: locationList,
    metric: z.enum(METRICS).default("temp_c"),
    period: z.enum(PERIODS).default("day"),
    compare: z.enum(COMPARE).optional(),
    ...range,
  }).strict(),
  map: z.object(range).strict(),
  drill: z.object({
    location: locationId,
    level: z.enum(DRILL_LEVELS),
    key: z.string().regex(new RegExp(PATTERNS.drillKey)).openapi({ example: "2025-Q3" }),
    metric: z.enum(METRICS).default("temp_c"),
  }).strict(),
  forecast: z.object({ days: z.coerce.number().int().min(1).max(LIMITS.maxForecastDays).default(7) }).strict(),
  alerts: z.object({ state: z.string().regex(new RegExp(PATTERNS.state)).optional() }).strict(),
  accuracy: z.object({ location: locationId.optional(), ...range }).strict(),
  records: z.object({ location: locationId }).strict(),
  runs: z.object({
    limit: z.coerce.number().int().min(1).max(LIMITS.maxRuns).default(50),
    stage: z.enum(STAGES).optional(),
  }).strict(),
};

const envelope = z.object({ data: z.any(), meta: z.record(z.string(), z.any()).optional() });
const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
const json = (schema, description) => ({ description, content: { "application/json": { schema } } });
const RESPONSES = {
  200: json(envelope, "OK"),
  400: json(errorSchema, "Invalid parameters"),
  404: json(errorSchema, "Unknown location"),
  429: json(errorSchema, "Rate limit exceeded"),
};

const ROUTES = [
  { path: "/locations", summary: "All tracked locations", query: Q.none, run: (s) => s.locations() },
  { path: "/stats", summary: "Metric per location and period (local time), optional comparison", query: Q.stats, run: (s, q) => s.stats(q) },
  { path: "/map", summary: "Per-state values for the US map", query: Q.map, run: (s, q) => s.map(q) },
  { path: "/drill", summary: "Drill down one period (year → half → quarter → month → week → day → hour)", query: Q.drill, run: (s, q) => s.drill(q) },
  { path: "/forecast/{locationId}", summary: "Latest forecast per model for one location", query: Q.forecast,
    params: z.object({ locationId }).strict(), run: (s, q, p) => s.forecast({ locationId: p.locationId, days: q.days }) },
  { path: "/alerts", summary: "Active NWS alerts, optionally for one state", query: Q.alerts, run: (s, q) => s.alerts(q) },
  { path: "/accuracy", summary: "Forecast MAE and bias per model and lead day", query: Q.accuracy, run: (s, q) => s.accuracy(q) },
  { path: "/records", summary: "Record days for one location", query: Q.records, run: (s, q) => s.records(q) },
  { path: "/pipeline/status", summary: "Cache data version, hit rate and latest run per stage", query: Q.none, run: (s) => s.pipelineStatus() },
  { path: "/pipeline/runs", summary: "Recent pipeline runs", query: Q.runs, run: (s, q) => s.pipelineRuns(q) },
];

// Swagger UI comes from a CDN: pin the version, and let the docs page load scripts only from that exact path.
const SWAGGER_UI_VERSION = "5.33.0";
const SWAGGER_UI_CDN = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/`;
// API responses are JSON: nothing may run, load or frame them.
const apiHeaders = secureHeaders({ contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } });
// The docs page runs Swagger UI (an inline init script + the pinned CDN bundle) and fetches /openapi.json.
const docsHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'none'"],
    scriptSrc: ["'unsafe-inline'", SWAGGER_UI_CDN],
    styleSrc: ["'unsafe-inline'", SWAGGER_UI_CDN],
    imgSrc: ["'self'", "data:", SWAGGER_UI_CDN],
    connectSrc: ["'self'"],
    frameAncestors: ["'none'"],
  },
});

const errorBody = (code, message) => ({ error: { code, message } });
const describeIssue = (issue) => `${issue.path.join(".") || "query"}: ${issue.message}`;

/** @param {{ service: ReturnType<import("../src/api/service.js").createService> }} deps */
export function createApp({ service }) {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json(errorBody("bad_request", describeIssue(result.error.issues[0])), 400);
    },
  });

  app.use("*", (c, next) => (c.req.path === "/docs" ? docsHeaders(c, next) : apiHeaders(c, next)));
  app.use("/api/*", cors({ origin: config.api.corsOrigins, allowMethods: ["GET"] }));
  app.use("/api/*", rateLimiter({
    windowMs: 60_000,
    limit: config.api.rateLimitPerMin,
    standardHeaders: "draft-7",
    keyGenerator: (c) => {
      try {
        return getConnInfo(c).remote.address ?? "unknown";
      } catch {
        return "unknown";   // no Node socket (e.g. app.request() in tests, other runtimes): one shared bucket
      }
    },
    handler: (c) => c.json(errorBody("rate_limited", "Too many requests, try again later"), 429),
  }));

  for (const r of ROUTES) {
    const route = createRoute({
      method: "get",
      path: `/api/v1${r.path}`,
      summary: r.summary,
      request: { query: r.query, ...(r.params ? { params: r.params } : {}) },
      responses: RESPONSES,
    });
    app.openapi(route, async (c) => c.json(await r.run(service, c.req.valid("query"), r.params ? c.req.valid("param") : {}), 200));
  }
  app.openapi(createRoute({
    method: "get", path: "/api/v1/health", summary: "Dependency health (raw store, warehouse, cache)",
    responses: { 200: { description: "ok or degraded" }, 503: { description: "a required dependency is down" } },
  }), async (c) => {
    const health = await service.health();
    return c.json(health, health.status === "down" ? 503 : 200);
  });

  app.doc("/openapi.json", { openapi: "3.0.3", info: { title: "US Weather Pipeline API", version: "1.0.0" } });
  app.get("/docs", swaggerUI({ url: "/openapi.json", version: SWAGGER_UI_VERSION }));

  app.notFound((c) => c.json(errorBody("not_found", "Route not found"), 404));
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(errorBody(err.code, err.message), err.status);
    if (err?.status >= 400 && err.status < 500) return c.json(errorBody("bad_request", "Malformed request"), err.status);
    console.error("[api] internal error:", err);   // details stay in the server log
    return c.json(errorBody("internal", "Internal server error"), 500);
  });
  return app;
}
