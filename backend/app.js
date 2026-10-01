// backend/app.js — Stage 4 API, v3: Hono + @hono/zod-openapi (runs on Node here; the same app runs on
// edge/serverless runtimes). Routes call the framework-independent service (src/api/service.js); this file only
// does HTTP: validation, security middleware, errors and docs.

import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { rateLimiter } from "hono-rate-limiter";
import { getConnInfo } from "@hono/node-server/conninfo";
import { config } from "../src/config.js";
import { ApiError } from "../src/api/service.js";
import { QUERY, RESPONSE, errorResponse } from "../src/api/schemas.js";

// ---- Schemas: shared with the dashboard (src/api/schemas.js) ---------------------------------------------------
const json = (schema, description) => ({ description, content: { "application/json": { schema } } });
const responses = (ok) => ({
  200: json(ok, "OK"),
  400: json(errorResponse, "Invalid parameters"),
  404: json(errorResponse, "Unknown location"),
  429: json(errorResponse, "Rate limit exceeded"),
});

const ROUTES = [
  { path: "/locations", summary: "All tracked locations", query: QUERY.none, response: RESPONSE.locations, run: (s) => s.locations() },
  { path: "/stats", summary: "Metric per location and period (local time), optional comparison", query: QUERY.stats, response: RESPONSE.stats, run: (s, q) => s.stats(q) },
  { path: "/map", summary: "Per-state values for the US map", query: QUERY.map, response: RESPONSE.map, run: (s, q) => s.map(q) },
  { path: "/drill", summary: "Drill down one period (year → half → quarter → month → week → day → hour)", query: QUERY.drill, response: RESPONSE.drill, run: (s, q) => s.drill(q) },
  { path: "/forecast/{locationId}", summary: "Latest forecast per model for one location", query: QUERY.forecast, response: RESPONSE.forecast,
    params: QUERY.forecastParams, run: (s, q, p) => s.forecast({ locationId: p.locationId, days: q.days }) },
  { path: "/forecast/{locationId}/periods", summary: "NWS 12-hour forecast periods (day/night, short text) for one location", query: QUERY.none,
    response: RESPONSE.periods, params: QUERY.forecastParams, run: (s, q, p) => s.forecastPeriods({ locationId: p.locationId }) },
  { path: "/alerts", summary: "Active NWS alerts, optionally for one state", query: QUERY.alerts, response: RESPONSE.alerts, run: (s, q) => s.alerts(q) },
  { path: "/accuracy", summary: "Forecast MAE and bias per model and lead day (all US, one state or one city)", query: QUERY.accuracy, response: RESPONSE.accuracy, run: (s, q) => s.accuracy(q) },
  { path: "/accuracy/states", summary: "Forecast MAE and bias per state and model for one lead day", query: QUERY.accuracyStates, response: RESPONSE.accuracyStates, run: (s, q) => s.accuracyStates(q) },
  { path: "/accuracy/months", summary: "Forecast MAE and bias per month and model", query: QUERY.accuracyMonths, response: RESPONSE.accuracyMonths, run: (s, q) => s.accuracyMonths(q) },
  { path: "/accuracy/misses", summary: "Largest forecast errors (one per city and day)", query: QUERY.accuracyMisses, response: RESPONSE.misses, run: (s, q) => s.accuracyMisses(q) },
  { path: "/records", summary: "Record days for one location", query: QUERY.records, response: RESPONSE.records, run: (s, q) => s.records(q) },
  { path: "/pipeline/status", summary: "Cache data version, hit rate and latest run per stage", query: QUERY.none, response: RESPONSE.any, run: (s) => s.pipelineStatus() },
  { path: "/pipeline/runs", summary: "Recent pipeline runs", query: QUERY.runs, response: RESPONSE.any, run: (s, q) => s.pipelineRuns(q) },
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
      responses: responses(r.response),
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
