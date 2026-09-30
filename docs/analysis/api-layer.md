# Stage 4 API layer: comparison of three frameworks

Three implementations of `backend/` were built on parallel branches from the same base commit
(`feature/api-v1`, `-v2`, `-v3`, one git worktree each). The base (on `main`) holds everything they share:
`src/api/service.js` (one function per route over the Stage 3 cache, semantic checks, `ApiError`),
`src/api/params.js` (patterns, enums and limits every framework must enforce), the load test
(`scripts/loadTestApi.js`) and the black-box security probe (`scripts/probeApi.js`). So the versions differ only in
the HTTP layer: routing, validation, OpenAPI, rate limiting, headers and error handling.

| Version | Stack |
|---|---|
| v1 | Express 4 + Zod 4 (`@asteasolutions/zod-to-openapi`, `swagger-ui-express`, `helmet`, `express-rate-limit`, `cors`) |
| v2 | Fastify 5 + JSON Schema (built-in Ajv, `@fastify/swagger(-ui)`, `@fastify/helmet`, `@fastify/rate-limit`, `@fastify/cors`) |
| v3 | Hono 4 + `@hono/zod-openapi` (Zod 4), `@hono/node-server`, `@hono/swagger-ui`, `hono/secure-headers`, `hono/cors`, `hono-rate-limiter` |

All three implement the same 11 routes under `/api/v1` (`locations`, `stats`, `map`, `drill`, `forecast/{locationId}`,
`alerts`, `accuracy`, `records`, `pipeline/status`, `pipeline/runs`, `health`), OpenAPI at `/openapi.json` + `/docs`,
per-IP rate limiting, CORS for the dashboard origin, security headers and JSON errors.

## Load test

autocannon, 10 connections, 15 s, the same 12 dashboard requests in rotation (stats of several sizes, maps, accuracy,
forecast, drill-down, records, locations) after one warm-up pass, so the Stage 3 cache is filled and the framework is
what differs. Two runs per version, second run in reverse order. Raw data: `docs/analysis/data/api-v*-load.json`.

| | v1 Express | v2 Fastify | v3 Hono |
|---|---|---|---|
| Requests/s (run 1 / run 2) | 1,544 / 1,357 | 1,583 / 1,358 | 1,388 / 1,495 |
| p95 latency (run 1 / run 2) | 10.5 / 12.2 ms | 11.1 / 13.6 ms | 15.4 / 13.2 ms |
| p99 latency (run 1 / run 2) | 13.8 / 14.8 ms | 15.4 / 18.4 ms | 19.8 / 17.2 ms |
| Peak memory (RSS) | 159 / 159 MB | 236 / 282 MB | **152 / 151 MB** |
| Errors / non-2xx | 0 | 0 | 0 |

Throughput and latency are a tie: run-to-run variation (±10 %) is larger than the differences between frameworks,
because most of each request is the Redis round trip and JSON serialization of results (the forecast has 864 rows).
Memory is not a tie: Fastify used ~1.6–1.8× the memory of the other two.

## Security probe

`scripts/probeApi.js`, 22 checks: 8 kinds of invalid input (unknown metric, SQL-like and NoSQL-operator parameters,
bad dates, too many locations, out-of-range limit, path traversal, bad drill key) must give a 400 JSON error without
internal details; unknown location → 404; unknown route/method and malformed URL encoding → 4xx JSON without leaks;
CORS only for the configured origin; `X-Content-Type-Options`, clickjacking protection, no `X-Powered-By`,
`Referrer-Policy`; Swagger UI and an OpenAPI document listing all 11 routes; 429 with retry information after the
per-minute limit. **All three pass 22/22** (`docs/analysis/data/api-v*-probe.json`) — after the fixes below.

## Comparison

| Criterion | v1 Express + Zod | v2 Fastify + JSON Schema | v3 Hono + zod-openapi |
|---|---|---|---|
| Files changed | 2 (`backend/app.js`, `server.js`) + legacy routes removed | same | same |
| Code size | 172 lines (150 code) | 133 lines (113 code) | 138 lines (120 code) |
| Dependency tree | 174 packages in `node_modules` | 168 | **116** |
| Architecture | Middleware chain; manual `safeParse` per route | Plugins + encapsulated scopes; schema per route compiled by Ajv | Middleware + typed routes; `createRoute` defines validation, OpenAPI and types at once |
| Validation / OpenAPI | Zod schemas; paths registered separately in an OpenAPI registry (same route table, but two wiring steps) | JSON Schema is native: validation, coercion, defaults and OpenAPI from one schema; list-of-ids needs a regex; verbose | One Zod route definition drives validation, OpenAPI and handler types; `defaultHook` formats errors |
| Complexity | Low, but more glue code | Low; a few non-obvious defaults | Low; least glue |
| Error handling | Error middleware; had to switch to the simple query parser | `setErrorHandler` + `setNotFoundHandler`; rate-limit errors come through the error handler | `onError` + `notFound`; validation errors via `defaultHook` |
| Security pitfalls found | Default `qs` parser turns `?stage[$ne]=x` into an object (switched to `simple`); unknown params were ignored until schemas were made `.strict()` | Ajv's default `removeAdditional` **silently drops** unknown params (disabled) | `secureHeaders` sets no CSP by default; Swagger UI loads its script from a CDN **without a pinned version** |
| Rate limit | `express-rate-limit`: `RateLimit` (draft-8) + `Retry-After` | `@fastify/rate-limit`: `x-ratelimit-*` + `Retry-After`, scoped to `/api/v1` | `hono-rate-limiter`: `RateLimit` (draft-7), key from the socket address |
| Testing | Needs `supertest` (or a real port) | `app.inject()` built in | `app.request()` built in (plain `Request`/`Response`) |
| Extensibility | Largest ecosystem | Rich plugin ecosystem, fast serialization with response schemas | Runs unchanged on Node, Bun, Deno and edge platforms; Zod schemas can be shared with the TypeScript dashboard |

All three rate limiters keep counts in process memory and key on the socket address; behind a reverse proxy they
would need trusted-proxy handling (noted under Known limitations).

## Decision: adopt v3 (Hono)

- **Performance:** a tie on requests/s and p95; lowest memory (~150 MB vs up to 282 MB for Fastify).
- **Least code and dependencies:** 120 lines of code and the smallest dependency tree (116 vs 168–174 packages).
- **One definition per route:** validation, OpenAPI and handler types come from the same Zod object, so the docs cannot
  drift from what is enforced. The same Zod schemas can be reused by the React + TypeScript dashboard in Stage 5.
- **Portable and easy to test:** built on the Fetch API (`app.request()` in tests, no port or `supertest` needed), and
  deployable to a free edge/serverless tier later without rewriting.

Security fixes surfaced by the comparison, applied with the merge:
1. **Pin the Swagger UI version** loaded from the CDN, and restrict `/docs` with a Content-Security-Policy that only
   allows that CDN.
2. **Strict CSP on API responses** (`default-src 'none'; frame-ancestors 'none'`): they are JSON and should never
   execute anything or be framed.
3. Unknown query parameters are rejected (already done for all versions during the comparison).

## Result after merging (Hono + fixes)

| | Value |
|---|---|
| Requests/s | 1,617 (10 connections, 15 s) |
| p50 / p95 / p99 | 5.6 / 12.7 / 16.6 ms |
| Peak memory | 188 MB (varies with garbage collection; runs above: 151–152 MB) |
| Errors / non-2xx | 0 |
| Security probe | 22/22 (`docs/analysis/data/api-final-probe.json`) |

Fixes applied: Swagger UI pinned to 5.33.0 with a CSP that only allows that CDN path on `/docs`; strict
`default-src 'none'; frame-ancestors 'none'` on API responses; the rate limiter falls back to one shared bucket when
there is no Node socket (before, that case threw and turned every request into a 500). Unit tests:
`tests/api.test.js` (19 tests with Hono's `app.request()` and a fake service).

