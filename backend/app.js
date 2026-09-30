// backend/app.js — Stage 4 API, v1: Express + Zod (OpenAPI generated from the Zod schemas).
// Routes call the framework-independent service (src/api/service.js); this file only does HTTP: validation,
// security middleware, errors and docs.

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import { z } from "zod";
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { config } from "../src/config.js";
import { ApiError } from "../src/api/service.js";
import { PATTERNS, METRICS, PERIODS, DRILL_LEVELS, COMPARE, STAGES, LIMITS } from "../src/api/params.js";

extendZodWithOpenApi(z);

// ---- Schemas (shared rules from src/api/params.js) ----------------------------------------------------------
const locationId = z.string().regex(new RegExp(PATTERNS.locationId)).openapi({ example: "stockton-ca" });
const date = z.string().regex(new RegExp(PATTERNS.date)).openapi({ example: "2026-09-01" });
const range = { from: date.optional(), to: date.optional() };
const locationList = z.string().max(1000)
  .transform((s) => s.split(","))
  .pipe(z.array(locationId).min(1).max(LIMITS.maxLocations))
  .openapi({ type: "string", example: "stockton-ca,miami-fl", description: "comma-separated location ids" });

const S = {
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
  forecastParams: z.object({ locationId }).strict(),
  forecastQuery: z.object({ days: z.coerce.number().int().min(1).max(LIMITS.maxForecastDays).default(7) }).strict(),
  alerts: z.object({ state: z.string().regex(new RegExp(PATTERNS.state)).optional() }).strict(),
  accuracy: z.object({ location: locationId.optional(), ...range }).strict(),
  records: z.object({ location: locationId }).strict(),
  runs: z.object({
    limit: z.coerce.number().int().min(1).max(LIMITS.maxRuns).default(50),
    stage: z.enum(STAGES).optional(),
  }).strict(),
};

// ---- Routes -------------------------------------------------------------------------------------------------
const ROUTES = [
  { path: "/locations", summary: "All tracked locations", query: S.none, run: (s) => s.locations() },
  { path: "/stats", summary: "Metric per location and period (local time), optional comparison", query: S.stats,
    run: (s, q) => s.stats(q) },
  { path: "/map", summary: "Per-state values for the US map", query: S.map, run: (s, q) => s.map(q) },
  { path: "/drill", summary: "Drill down one period (year → half → quarter → month → week → day → hour)", query: S.drill,
    run: (s, q) => s.drill(q) },
  { path: "/forecast/:locationId", summary: "Latest forecast per model for one location", params: S.forecastParams,
    query: S.forecastQuery, run: (s, q, p) => s.forecast({ locationId: p.locationId, days: q.days }) },
  { path: "/alerts", summary: "Active NWS alerts, optionally for one state", query: S.alerts, run: (s, q) => s.alerts(q) },
  { path: "/accuracy", summary: "Forecast MAE and bias per model and lead day", query: S.accuracy, run: (s, q) => s.accuracy(q) },
  { path: "/records", summary: "Record days for one location", query: S.records, run: (s, q) => s.records(q) },
  { path: "/pipeline/status", summary: "Cache data version, hit rate and latest run per stage", query: S.none,
    run: (s) => s.pipelineStatus() },
  { path: "/pipeline/runs", summary: "Recent pipeline runs", query: S.runs, run: (s, q) => s.pipelineRuns(q) },
];

function openApiDocument() {
  const registry = new OpenAPIRegistry();
  const envelope = z.object({ data: z.any(), meta: z.record(z.string(), z.any()).optional() });
  const error = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
  for (const r of ROUTES) {
    registry.registerPath({
      method: "get",
      path: `/api/v1${r.path.replace(/:(\w+)/g, "{$1}")}`,
      summary: r.summary,
      request: { query: r.query, ...(r.params ? { params: r.params } : {}) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: envelope } } },
        400: { description: "Invalid parameters", content: { "application/json": { schema: error } } },
        404: { description: "Unknown location", content: { "application/json": { schema: error } } },
        429: { description: "Rate limit exceeded", content: { "application/json": { schema: error } } },
      },
    });
  }
  registry.registerPath({
    method: "get", path: "/api/v1/health", summary: "Dependency health (raw store, warehouse, cache)",
    responses: { 200: { description: "ok or degraded" }, 503: { description: "a required dependency is down" } },
  });
  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: { title: "US Weather Pipeline API", version: "1.0.0" },
  });
}

// ---- App ----------------------------------------------------------------------------------------------------
const sendError = (res, status, code, message) => res.status(status).json({ error: { code, message } });
const describeIssue = (issue) => `${issue.path.join(".") || "query"}: ${issue.message}`;

/** @param {{ service: ReturnType<import("../src/api/service.js").createService> }} deps */
export function createApp({ service }) {
  const app = express();
  app.set("query parser", "simple");   // flat string values only: ?a[$ne]=x can't become an object
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: config.api.corsOrigins, methods: ["GET"] }));

  const spec = openApiDocument();
  app.get("/openapi.json", (_req, res) => res.json(spec));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(spec));

  app.use("/api", rateLimit({
    windowMs: 60_000,
    limit: config.api.rateLimitPerMin,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => sendError(res, 429, "rate_limited", "Too many requests, try again later"),
  }));

  const router = express.Router();
  for (const r of ROUTES) {
    router.get(r.path, async (req, res, next) => {
      const query = r.query.safeParse(req.query);
      if (!query.success) return sendError(res, 400, "bad_request", describeIssue(query.error.issues[0]));
      const params = r.params ? r.params.safeParse(req.params) : { success: true, data: {} };
      if (!params.success) return sendError(res, 400, "bad_request", describeIssue(params.error.issues[0]));
      try {
        res.json(await r.run(service, query.data, params.data));
      } catch (err) {
        next(err);
      }
    });
  }
  router.get("/health", async (_req, res, next) => {
    try {
      const health = await service.health();
      res.status(health.status === "down" ? 503 : 200).json(health);
    } catch (err) {
      next(err);
    }
  });
  app.use("/api/v1", router);

  app.use((_req, res) => sendError(res, 404, "not_found", "Route not found"));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof ApiError) return sendError(res, err.status, err.code, err.message);
    if (err?.type === "entity.parse.failed" || err instanceof URIError || err?.status === 400) {
      return sendError(res, 400, "bad_request", "Malformed request");
    }
    console.error("[api] internal error:", err);   // details stay in the server log
    return sendError(res, 500, "internal", "Internal server error");
  });
  return app;
}
