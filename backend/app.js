// backend/app.js — Stage 4 API, v2: Fastify + JSON Schema (Ajv validation, OpenAPI via @fastify/swagger).
// Routes call the framework-independent service (src/api/service.js); this file only does HTTP: validation,
// security plugins, errors and docs.

import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { config } from "../src/config.js";
import { ApiError } from "../src/api/service.js";
import { PATTERNS, METRICS, PERIODS, DRILL_LEVELS, COMPARE, STAGES, LIMITS } from "../src/api/params.js";

// ---- Schemas (shared rules from src/api/params.js) ----------------------------------------------------------
const locationId = { type: "string", pattern: PATTERNS.locationId, examples: ["stockton-ca"] };
const date = { type: "string", pattern: PATTERNS.date, examples: ["2026-09-01"] };
const id = PATTERNS.locationId.slice(1, -1);   // without ^ and $
const locationList = {
  type: "string",
  pattern: `^${id}(,${id}){0,${LIMITS.maxLocations - 1}}$`,
  description: `comma-separated location ids (at most ${LIMITS.maxLocations})`,
  examples: ["stockton-ca,miami-fl"],
};
const query = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const range = { from: date, to: date };

const Q = {
  none: query({}),
  stats: query({
    locations: locationList,
    metric: { type: "string", enum: [...METRICS], default: "temp_c" },
    period: { type: "string", enum: [...PERIODS], default: "day" },
    compare: { type: "string", enum: [...COMPARE] },
    ...range,
  }, ["locations"]),
  map: query(range),
  drill: query({
    location: locationId,
    level: { type: "string", enum: [...DRILL_LEVELS] },
    key: { type: "string", pattern: PATTERNS.drillKey, examples: ["2025-Q3"] },
    metric: { type: "string", enum: [...METRICS], default: "temp_c" },
  }, ["location", "level", "key"]),
  forecast: query({ days: { type: "integer", minimum: 1, maximum: LIMITS.maxForecastDays, default: 7 } }),
  alerts: query({ state: { type: "string", pattern: PATTERNS.state } }),
  accuracy: query({ location: locationId, ...range }),
  records: query({ location: locationId }, ["location"]),
  runs: query({
    limit: { type: "integer", minimum: 1, maximum: LIMITS.maxRuns, default: 50 },
    stage: { type: "string", enum: [...STAGES] },
  }),
};

const ROUTES = [
  { path: "/locations", summary: "All tracked locations", querystring: Q.none, run: (s) => s.locations() },
  { path: "/stats", summary: "Metric per location and period (local time), optional comparison", querystring: Q.stats,
    run: (s, q) => s.stats({ ...q, locations: q.locations.split(",") }) },
  { path: "/map", summary: "Per-state values for the US map", querystring: Q.map, run: (s, q) => s.map(q) },
  { path: "/drill", summary: "Drill down one period (year → half → quarter → month → week → day → hour)", querystring: Q.drill,
    run: (s, q) => s.drill(q) },
  { path: "/forecast/:locationId", summary: "Latest forecast per model for one location", querystring: Q.forecast,
    params: { type: "object", properties: { locationId }, required: ["locationId"], additionalProperties: false },
    run: (s, q, p) => s.forecast({ locationId: p.locationId, days: q.days }) },
  { path: "/alerts", summary: "Active NWS alerts, optionally for one state", querystring: Q.alerts, run: (s, q) => s.alerts(q) },
  { path: "/accuracy", summary: "Forecast MAE and bias per model and lead day", querystring: Q.accuracy, run: (s, q) => s.accuracy(q) },
  { path: "/records", summary: "Record days for one location", querystring: Q.records, run: (s, q) => s.records(q) },
  { path: "/pipeline/status", summary: "Cache data version, hit rate and latest run per stage", querystring: Q.none,
    run: (s) => s.pipelineStatus() },
  { path: "/pipeline/runs", summary: "Recent pipeline runs", querystring: Q.runs, run: (s, q) => s.pipelineRuns(q) },
];

const errorBody = (code, message) => ({ error: { code, message } });

/** @param {{ service: ReturnType<import("../src/api/service.js").createService> }} deps */
export async function buildApp({ service }) {
  const app = Fastify({
    logger: false,
    // Reject unknown parameters (Fastify's default silently removes them) and coerce "7" → 7.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true, useDefaults: true } },
  });

  await app.register(helmet);
  await app.register(cors, { origin: config.api.corsOrigins, methods: ["GET"] });
  await app.register(swagger, { openapi: { info: { title: "US Weather Pipeline API", version: "1.0.0" } } });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.setErrorHandler((err, _req, reply) => {
    if (err.validation) {
      const issue = err.validation[0];
      return reply.code(400).send(errorBody("bad_request", `${err.validationContext}${issue.instancePath} ${issue.message}`));
    }
    if (err instanceof ApiError) return reply.code(err.status).send(errorBody(err.code, err.message));
    if (err.statusCode === 429) return reply.code(429).send(errorBody("rate_limited", "Too many requests, try again later"));
    if (err.statusCode >= 400 && err.statusCode < 500) return reply.code(err.statusCode).send(errorBody("bad_request", "Malformed request"));
    console.error("[api] internal error:", err);   // details stay in the server log
    return reply.code(500).send(errorBody("internal", "Internal server error"));
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send(errorBody("not_found", "Route not found")));

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  // API routes in their own scope, so only they are rate limited (not /docs).
  await app.register(async (api) => {
    await api.register(rateLimit, {
      max: config.api.rateLimitPerMin,
      timeWindow: "1 minute",
      errorResponseBuilder: () => Object.assign(new Error("rate limited"), { statusCode: 429 }),
    });
    for (const r of ROUTES) {
      api.get(r.path, { schema: { summary: r.summary, querystring: r.querystring, ...(r.params ? { params: r.params } : {}) } },
        async (req) => r.run(service, req.query, req.params));
    }
    api.get("/health", { schema: { summary: "Dependency health (raw store, warehouse, cache)" } }, async (_req, reply) => {
      const health = await service.health();
      return reply.code(health.status === "down" ? 503 : 200).send(health);
    });
  }, { prefix: "/api/v1" });

  return app;
}
