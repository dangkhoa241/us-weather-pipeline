# Stage 3 caching: comparison of three strategies

Three implementations of `src/stage3/dashboard.js` were built on parallel branches from the same base commit
(`feature/caching-v1`, `-v2`, `-v3`, one git worktree each). The base (on `main`) holds everything they share: the
four dashboard query types with parameter normalization (`src/stage3/queries.js`), the Warehouse queries, the
CacheStore adapter and the benchmark (`npm run bench:dashboard <label>`).

| Version | Strategy |
|---|---|
| v1 | No cache: every request goes to ClickHouse. |
| v2 | Cache-aside per query. The key is `wx:q:<data_version>:<type>:<hash of normalized params>`, with a TTL. After each Stage 2 run, a version pointer (`wx:meta:data_version`) moves to the new run and the old version's keys are deleted. |
| v3 | v2's read path plus pre-warming: after each Stage 2 run the popular landing-page queries are computed under the **new** version first, then the pointer switches, so readers never meet an empty cache. Concurrent misses for one key share a single warehouse query (single-flight). |

## Benchmark

10 realistic dashboard requests (5 period stats of different sizes, 2 state maps, 2 accuracy summaries, 1 city
forecast; see `BENCH_QUERIES`). Cold = first request after a simulated Stage 2 run (5 rounds × 10 queries = 50
samples); warm = 20 further rounds (200 samples). Local Docker (ClickHouse 24.8, Redis 7), 20 cities, 3 years of
hourly data, ~700k forecast snapshots. Raw results: `docs/analysis/data/caching-v*.json`.

| | v1 | v2 | v3 |
|---|---|---|---|
| Cold p50 / p95 | 27.8 / 62.2 ms | 28.2 / 45.8 ms | 27.0 / 45.2 ms |
| Cold p50 of the 4 popular queries | 14–41 ms | 14–36 ms | **1.4–2.7 ms** |
| Warm p50 / p95 | 21.4 / 35.4 ms | **1.4 / 2.4 ms** | 1.5 / 2.9 ms |
| Work after each Stage 2 run | 0 | 8 ms | 258 ms (24 queries) |
| Redis keys / memory | 0 / 0 | 11 / 212 KB | 31 / 3.2 MB |

Cold p95 is lower with a cache even though cold requests miss: v1's p95 includes ClickHouse's own first-run cost
for every request, while v2/v3 pay it once per data version. Most of v3's memory is the 20 pre-warmed city forecasts
(871 rows each); at 150 cities that alone would be ~25 MB, close to the 30 MB of the Redis Cloud free plan.

## Comparison

| Criterion | v1 no cache | v2 cache-aside | v3 pre-warm + cache-aside |
|---|---|---|---|
| Files changed (vs base) | 1 | 1 | 1 |
| Code size (`dashboard.js`) | 18 lines (12 code) | 44 lines (34 code) | 81 lines (64 code) |
| Architecture | Pass-through | Read-through cache, versioned keys, O(1) invalidation by moving a pointer | v2 + background warming before the pointer switch, single-flight |
| Complexity | None | Low: one key scheme, one pointer | Medium: warm list to maintain, concurrency limit, partial-failure handling |
| Error handling | Warehouse errors surface directly | Cache errors are caught and fall back to the warehouse, **but** a down Redis makes requests hang (the client queues commands offline), so the fallback never runs | Same as v2; warming failures are counted and the switch still happens |
| Security | Every request hits ClickHouse: easy to overload | Keys are hashes of normalized params (no user text in keys); values only come from the warehouse. Unbounded key count from arbitrary params can grow Redis memory; local Redis has no auth | Same as v2, plus a fixed memory cost per Stage 2 run that grows with the number of cities |
| Performance | Baseline | Warm requests ~15× faster (p95 35 → 2.4 ms) | Same warm speed; popular pages fast immediately after a load |
| Extensibility | Nothing to extend | New query type = one entry in `QUERY_TYPES` | Same, plus choosing whether it's warmed |

## Decision: combine (v2 base + a small pre-warm list from v3)

- **v2's read path** (versioned cache-aside) gives almost all of the gain with the least code.
- **v3's pre-warm, but only for small national queries** (maps, accuracy overview, 12-month overview): the landing
  page is fast right after every load, without per-city forecasts filling Redis. City pages use cache-aside.
- **Keep single-flight** from v3: a few lines, and it prevents a burst of identical misses from stampeding ClickHouse.

Security and robustness fixes surfaced by the comparison, applied with the merge:
1. **Redis down must not hang requests:** the Redis client fails fast (no offline queue, connect timeout), so the
   dashboard falls back to ClickHouse.
2. **Bounded memory:** Redis runs with `maxmemory` and `allkeys-lru`, so many distinct parameter combinations evict
   old entries instead of growing without limit. Parameter validation (Zod) follows in Stage 4.
3. Hit/miss counters and the data-version record (`wx:meta:data_version` with `loaded_at`) give the API a real sync
   status instead of guessing from TTLs (roadmap bug 8).
