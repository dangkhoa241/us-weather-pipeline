// API tests for backend/app.js (Hono) with Hono's built-in test client (app.request) and a fake service,
// so no port, database or Docker is needed. The real service is covered by its own logic and the probe script.

import { describe, it, expect, vi, beforeAll } from "vitest";

const RATE_LIMIT = 40;
let createApp;
let ApiError;

beforeAll(async () => {
  // config.js reads the environment once at import, so set it before importing the app.
  vi.stubEnv("API_RATE_LIMIT_PER_MIN", String(RATE_LIMIT));
  vi.stubEnv("CORS_ORIGINS", "http://localhost:5173");
  ({ createApp } = await import("../backend/app.js"));
  ({ ApiError } = await import("../src/api/service.js"));
});

/** Fake service: every method resolves to a recognizable envelope and records its arguments. */
function fakeService(overrides = {}) {
  const ok = (name) => vi.fn(async (args) => ({ data: [{ route: name, args }], meta: { source: "cache", data_version: "v1" } }));
  return {
    locations: ok("locations"), stats: ok("stats"), map: ok("map"), drill: ok("drill"), forecast: ok("forecast"),
    alerts: ok("alerts"), accuracy: ok("accuracy"), records: ok("records"),
    pipelineStatus: ok("pipelineStatus"), pipelineRuns: ok("pipelineRuns"),
    health: vi.fn(async () => ({ status: "ok", checks: {} })),
    ...overrides,
  };
}

const request = (app, path, headers = {}) => app.request(path, { headers });

describe("routes and validation", () => {
  it("returns the service envelope for a valid request", async () => {
    const service = fakeService();
    const res = await request(createApp({ service }), "/api/v1/locations");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: [{ route: "locations" }], meta: { source: "cache" } });
  });

  it("splits the location list and applies defaults for /stats", async () => {
    const service = fakeService();
    const res = await request(createApp({ service }), "/api/v1/stats?locations=stockton-ca,miami-fl&from=2026-08-01&to=2026-08-31");
    expect(res.status).toBe(200);
    expect(service.stats).toHaveBeenCalledWith({
      locations: ["stockton-ca", "miami-fl"], metric: "temp_c", period: "day", from: "2026-08-01", to: "2026-08-31",
    });
  });

  it("passes path parameters and coerces numbers for /forecast", async () => {
    const service = fakeService();
    const res = await request(createApp({ service }), "/api/v1/forecast/miami-fl?days=3");
    expect(res.status).toBe(200);
    expect(service.forecast).toHaveBeenCalledWith({ locationId: "miami-fl", days: 3 });
  });

  it.each([
    ["unknown metric", "/api/v1/stats?locations=stockton-ca&metric=DROP"],
    ["SQL-like location id", "/api/v1/stats?locations=stockton-ca'%20OR%201=1--"],
    ["unknown / operator-like parameter", "/api/v1/pipeline/runs?stage[$ne]=x"],
    ["too many locations", `/api/v1/stats?locations=${Array.from({ length: 26 }, (_, i) => `c-${i}`).join(",")}`],
    ["limit out of range", "/api/v1/pipeline/runs?limit=100000"],
    ["bad drill key", "/api/v1/drill?location=miami-fl&level=quarter&key=2025-Q9"],
    ["path traversal in id", "/api/v1/forecast/..%2F..%2Fetc%2Fpasswd"],
    ["bad state", "/api/v1/alerts?state=texas"],
  ])("rejects %s with 400 before calling the service", async (_name, path) => {
    const service = fakeService();
    const res = await request(createApp({ service }), path);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("errors", () => {
  it("passes ApiError status, code and message through", async () => {
    const service = fakeService({ records: vi.fn(async () => { throw new ApiError(404, "not_found", "unknown location(s): x"); }) });
    const res = await request(createApp({ service }), "/api/v1/records?location=atlantis-xx");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "unknown location(s): x" } });
  });

  it("hides internal error details behind a generic 500", async () => {
    const secret = "ECONNREFUSED clickhouse:8123 user=weather password=hunter2";
    const service = fakeService({ map: vi.fn(async () => { throw new Error(secret); }) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(createApp({ service }), "/api/v1/map");
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: { code: "internal", message: "Internal server error" } });
    expect(text).not.toMatch(/ECONNREFUSED|clickhouse|hunter2|at .*\.js/);
    expect(spy).toHaveBeenCalled();   // the details go to the server log instead
    spy.mockRestore();
  });

  it("returns 404 JSON for unknown routes", async () => {
    const res = await request(createApp({ service: fakeService() }), "/api/v1/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("reports 503 when a required dependency is down", async () => {
    const service = fakeService({ health: vi.fn(async () => ({ status: "down", checks: { warehouse: { ok: false } } })) });
    expect((await request(createApp({ service }), "/api/v1/health")).status).toBe(503);
  });
});

describe("security headers, CORS, docs", () => {
  it("sends strict security headers on API responses", async () => {
    const res = await request(createApp({ service: fakeService() }), "/api/v1/locations");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("allows only the configured origin", async () => {
    const app = createApp({ service: fakeService() });
    const allowed = await request(app, "/api/v1/locations", { Origin: "http://localhost:5173" });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const other = await request(app, "/api/v1/locations", { Origin: "https://evil.example" });
    expect(other.headers.get("access-control-allow-origin")).not.toBe("https://evil.example");
  });

  it("documents all 15 routes and serves a pinned Swagger UI under a CSP", async () => {
    const app = createApp({ service: fakeService() });
    const spec = await (await request(app, "/openapi.json")).json();
    expect(Object.keys(spec.paths)).toHaveLength(15);
    expect(spec.paths["/api/v1/forecast/{locationId}"]).toBeDefined();
    const docs = await request(app, "/docs");
    expect(await docs.text()).toContain("swagger-ui-dist@5.33.0/swagger-ui-bundle.js");
    expect(docs.headers.get("content-security-policy")).toContain("script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.33.0/");
  });
});

describe("rate limiting", () => {
  it(`answers 429 after ${RATE_LIMIT} requests per minute`, async () => {
    const app = createApp({ service: fakeService() });
    const statuses = [];
    for (let i = 0; i < RATE_LIMIT + 5; i += 1) statuses.push((await request(app, "/api/v1/locations")).status);
    expect(statuses.slice(0, RATE_LIMIT).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(RATE_LIMIT)).toEqual(Array(5).fill(429));
    const limited = await request(app, "/api/v1/locations");
    expect((await limited.json()).error.code).toBe("rate_limited");
    expect(limited.headers.get("ratelimit") ?? limited.headers.get("retry-after")).toBeTruthy();
  });
});
