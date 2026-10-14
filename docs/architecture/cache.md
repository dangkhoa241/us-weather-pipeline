# Cache: Stage 3 (ClickHouse → Redis)

Rebuild steps: the "Run it locally" section of the [README](../../README.md#run-it-locally) (`npm run etl:redis`).
Benchmark and comparison: [analysis/caching.md](../analysis/caching.md).

## Purpose

Answer the dashboard's repeated queries from memory instead of the warehouse, and make sure a new data load never
serves stale answers.

## Requirements

- Invalidate everything after each Stage 2 load, cheaply.
- Keep the landing page fast right after a load.
- Never make a request hang or fail because Redis is down: fall back to ClickHouse.
- Bounded memory, free and self-hosted (Redis in Docker).

## Design

- **Versioned cache-aside.** Keys contain the current data version (the latest successful Stage 2 run):
  `wx:q:<data_version>:<type>:<hash of normalized params>`, with a TTL (default 3,600 s). On a miss the warehouse is
  queried and the result stored. A version pointer (`wx:meta:data_version`) switches to the new run after each load,
  which invalidates all old keys at once.
- **Small pre-warm list.** After each load, the popular national queries (maps, accuracy overview, 12-month overview)
  are computed under the new version first, then the pointer switches, so the landing page is never cold. City pages
  use plain cache-aside.
- **Single-flight.** Concurrent misses for one key share one warehouse query.
- **Normalized parameters.** Query types and their parameter normalization live in `src/stage3/queries.js`; keys are
  hashes, so no user text ends up in a key.
- **Status.** Hit/miss counters and the version record (with `loaded_at`) feed `/api/v1/pipeline/status`.
- **Adapter.** `CacheStore` interface, `CACHE_STORE=redis`. `clickhouseToRedis.js` runs Stage 3 inside `pipeline.js`
  after Stage 2.

## Alternatives considered

See [decision 4](../DESIGN_DECISIONS.md#4-redis-cache-versioned-cache-aside-plus-a-small-pre-warm-list): no cache,
pure cache-aside, and pre-warming everything, built on three branches and benchmarked
([analysis/caching.md](../analysis/caching.md)).

## Failure handling

- **Redis down.** The client runs without an offline queue and with a 2 s connect timeout, so commands fail fast and
  the dashboard falls back to ClickHouse; it keeps reconnecting in the background (backoff up to 10 s). Measured with
  Redis stopped: answers from ClickHouse in 22–35 ms instead of hanging.
- **Cache write errors** are ignored; the answer still comes from the warehouse.
- **Pre-warm failures** are counted and the pointer still switches.
- **No Stage 2 run yet**: Stage 3 fails with a clear message and is logged in `pipeline_runs`.

## Security

- Redis listens on `127.0.0.1:6379` only (`docker-compose.yml`) and has no auth, which is acceptable only because it
  is local.
- `maxmemory 64mb` with `volatile-lru`: many distinct parameter combinations evict old results instead of growing
  without limit. The version pointer and counters have no TTL and are never evicted.
- Values only come from the warehouse; parameters are validated by the API's Zod schemas before they reach the cache.

## Numbers

| Number | Source |
|---|---|
| Warm p95 35.4 → 2.9 ms (12× faster), cold p95 62.2 → 32.3 ms | [analysis/caching.md](../analysis/caching.md), "Result after merging" |
| 19 keys / 373 KB of Redis (pre-warming everything: 31 keys / 3.2 MB) | [analysis/caching.md](../analysis/caching.md) |
| 57 ms of work after each Stage 2 run (4 pre-warmed queries) | [analysis/caching.md](../analysis/caching.md) |
| Benchmark set-up: 20 cities, 10 dashboard requests, local Docker | [analysis/caching.md](../analysis/caching.md), "Benchmark" |

## Where in the code

| What | File |
|---|---|
| Strategy (cache-aside, versions, pre-warm, single-flight) | `src/stage3/dashboard.js` |
| Query types, normalization, keys | `src/stage3/queries.js` |
| Stage 3 runner | `clickhouseToRedis.js` |
| Redis adapter | `src/adapters/cacheStore/redisCacheStore.js` |
| Redis memory settings | `docker-compose.yml` (`redis`) |
| Benchmark | `scripts/benchDashboard.js` (`npm run bench:dashboard`) |
| Tests | `tests/dashboard.test.js` |
