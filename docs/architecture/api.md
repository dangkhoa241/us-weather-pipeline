# API: Stage 4 (Hono + OpenAPI)

Rebuild steps: the "Run it locally" section of the [README](../../README.md#run-it-locally) (`npm start`).
Framework comparison: [analysis/api-layer.md](../analysis/api-layer.md).

## Purpose

Serve the dashboard's data as a REST API with OpenAPI docs: read the Stage 3 cache, fall back to ClickHouse on a
miss, and validate every request strictly. The API runs locally; the public site never calls it. Its answers reach
the site through the snapshot exported at redeploy (see [dashboard](dashboard.md)).

## Requirements

- Strict input validation: unknown or malformed parameters get a 400, never a silent default.
- Docs that cannot drift from what is enforced.
- Types the TypeScript dashboard can share.
- Rate limiting, CORS for the dashboard origin only, security headers, JSON errors without internal details.

## Design

- **One definition per route.** Each route under `/api/v1` is a `createRoute()` with a Zod query schema and response
  schema (`src/api/schemas.js`). The same object drives validation, the OpenAPI document (`/openapi.json`) and the
  handler types; the dashboard imports the schemas from `src/api/`.
- **Routes.** `locations`, `stats`, `map`, `drill`, `forecast/{locationId}`, `forecast/{locationId}/periods`,
  `alerts`, `accuracy`, `accuracy/states`, `accuracy/matched`, `accuracy/months`, `accuracy/misses`, `records`,
  `pipeline/status`, `pipeline/runs`, and `health` (503 when a required dependency is down).
- **Thin HTTP layer.** `backend/app.js` only does HTTP. Each route calls the framework-independent service
  (`src/api/service.js`), which reads through the Stage 3 cache and raises `ApiError` for semantic errors (for example
  an unknown location → 404).
- **Middleware.** `secureHeaders` with `default-src 'none'; frame-ancestors 'none'` on API responses; a separate CSP
  on `/docs` that allows only the pinned Swagger UI path (5.33.0); CORS (`GET` only) for `CORS_ORIGINS`; a per-IP
  rate limit of 120 requests a minute by default (`hono-rate-limiter`, draft-7 `RateLimit` headers).
- **Server.** `backend/server.js` runs the app on Node with `@hono/node-server`, on `127.0.0.1:3000` by default.

## Alternatives considered

See [decision 5](../DESIGN_DECISIONS.md#5-hono--zod-openapi-for-the-api): Express + Zod and Fastify + JSON Schema,
built on three branches and load-tested ([analysis/api-layer.md](../analysis/api-layer.md)).

## Failure handling

- Validation errors return `400 { error: { code: "bad_request", message } }` naming the first bad field.
- `ApiError` keeps its status and code; other 4xx become a generic "Malformed request".
- Anything else is logged on the server and returned as a generic `500 internal`, without details.
- Unknown routes return a JSON 404. Over the rate limit: 429 with retry information.
- Cache errors fall back to ClickHouse (see [cache](cache.md)).
- Without a Node socket (for example `app.request()` in tests) the rate limiter uses one shared bucket instead of
  throwing.

## Security

- **SQL injection:** all SQL uses ClickHouse `query_params`; no input is interpolated (see [warehouse](warehouse-etl.md)).
- **NoSQL operator injection:** query strings are parsed as plain strings and every schema is `.strict()`, so
  `?x[$ne]=` and unknown parameters get a 400.
- **Headers:** strict CSP on JSON responses, pinned Swagger UI with its own CSP, `nosniff`, clickjacking protection,
  no `X-Powered-By`.
- **Exposure:** the API binds to `127.0.0.1` and is not deployed.
- **Black-box probe:** `npm run probe:api` runs 22 checks (invalid input, unknown routes, CORS, headers, OpenAPI,
  rate limit).
- Known limitation: the rate limiter keys on the socket address, so behind a reverse proxy it would need
  trusted-proxy handling ([analysis/api-layer.md](../analysis/api-layer.md)).

## Numbers

| Number | Source |
|---|---|
| 1,617 requests/s, p50 / p95 / p99 5.6 / 12.7 / 16.6 ms, 0 errors (10 connections, 15 s) | [analysis/api-layer.md](../analysis/api-layer.md), "Result after merging" |
| Security probe 22/22 | [analysis/api-layer.md](../analysis/api-layer.md) |
| Peak memory ~150 MB vs up to 282 MB (Fastify); 116 packages vs 168–174 | [analysis/api-layer.md](../analysis/api-layer.md), "Load test" and "Comparison" |
| Rate limit 120 requests a minute per IP (default) | `src/config.js` (`API_RATE_LIMIT_PER_MIN`) |

## Where in the code

| What | File |
|---|---|
| HTTP layer, routes, middleware | `backend/app.js` |
| Server start and shutdown | `backend/server.js` |
| Zod schemas shared with the dashboard | `src/api/schemas.js`, `src/api/params.js` |
| Service (cache, fallback, semantic checks) | `src/api/service.js`, `src/api/deps.js` |
| Load test and security probe | `scripts/loadTestApi.js`, `scripts/probeApi.js` |
| Tests | `tests/api.test.js` |
