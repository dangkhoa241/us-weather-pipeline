# Ingestion: Stage 1 fetcher and the raw store

Rebuild steps: the "Run it locally" section of the [README](../../README.md#run-it-locally); for the S3 archive copy,
[SETUP_AWS.md](../SETUP_AWS.md) (step 9).

## Purpose

Bring raw weather data into one local MongoDB raw store, from which every later stage reads:
- Open-Meteo hourly history (archive API);
- Open-Meteo forecasts from several weather models, live and backfilled, for accuracy scoring;
- NWS forecasts and alerts, collected on AWS by the [NWS collector](nws-collector.md) and copied home from Atlas.

## Requirements

- Free APIs only, inside their free limits: Open-Meteo is free for non-commercial use with weighted per-minute,
  per-hour and per-day limits; NWS has no published quota but needs a `User-Agent` with a contact.
- Loop over the `locations` collection (53 cities); nothing is tied to one city.
- Idempotent writes: every collection has a natural unique key, and re-running a fetch updates instead of
  duplicating.
- Missing measurements stay `null`, never `0`. Times are stored in UTC.
- Survive the laptop being off: catch up incrementally when it comes back.

## Design

- **Entry point.** `fetchWeather.js` runs one mode, all modes, or `--watch` (the `fetcher` Docker container runs
  `--watch`). Each mode run writes its own `pipeline_runs` entry through `runMode()`.

  | Mode | Source → collection | Default schedule in `--watch` |
  |---|---|---|
  | `history` | Open-Meteo archive → `observations_hourly` (incremental per city from a watermark; first run: last 3 years) | inside the pipeline run (see below) |
  | `om-forecast` | latest Open-Meteo forecast per model → `forecast_snapshots` | `40 2,8,14,20 * * *` (every 6 h) |
  | `om-backfill` | past model runs from the Single Runs API → `forecast_snapshots` (last 90 days, resumable per model and city) | `15 * * * *` |
  | `om-baseline` | best_match baseline from the Previous Runs API → `forecast_snapshots` | `45 6 * * *` |
  | `sync-atlas` | NWS data from Atlas → `forecast_snapshots`, `alerts`, `pipeline_runs` | inside the pipeline run |
  | `forecast`, `alerts` | NWS → `forecast_snapshots`, `alerts` | `"off"` in `docker-compose.yml`: the Lambda collects them |

- **Pipeline run.** In `--watch`, `sync-atlas` and `history` run as Stage 1 of `pipeline.js`, followed by Stage 2
  (ETL) and Stage 3 (cache refresh), on `PIPELINE_CRON` (default `50 */3 * * *`). A failed stage stops the run; a
  partial Stage 1 mode is a warning and the run continues.
- **Startup.** The watcher runs every scheduled job once at startup, forecasts first (a missed forecast snapshot is lost
  for good; history can be fetched any time), after two checks: the stale Atlas sync warning and a forecast-gap
  warning that records missing collection time in `pipeline_runs`.
- **HTTP.** All external calls go through `src/lib/http.js`: a `User-Agent` header, one rate limiter per API (at least
  250 ms between request starts by default), and retries with exponential backoff and jitter.
- **Open-Meteo budget.** A ledger in the `api_usage` collection counts weighted calls per UTC hour and day. Jobs
  reserve the cost before each request and stop cleanly at the budget, then resume on their next run. The defaults are
  2,000 an hour and 6,000 a day, under Open-Meteo's 5,000 and 10,000. The backfill may use at most 75% of the budget,
  so live forecasts always have room.
- **Raw store adapter.** Pipeline code uses the `RawStore` interface (`src/adapters/rawStore/`), and `RAW_STORE=mongo`
  picks MongoDB. `ensureCollections()` creates the unique keys and indexes; a TTL index is added only when
  `RAW_RETENTION_DAYS` is above 0 (it is 0 locally, so the local raw store keeps everything).
- **S3 archive copy.** With `RAW_ARCHIVE=s3`, each run's raw responses are also uploaded as one gzipped NDJSON object
  per source and run, at most one per source per UTC hour, and capped per day. MongoDB stays the primary raw store.

## Alternatives considered

- Collecting NWS on the laptop as well: turned off, see
  [decision 2](../DESIGN_DECISIONS.md#2-collect-nws-data-in-the-cloud-buffer-it-in-atlas-keep-the-rest-local).
- Calling MongoDB, S3 or a scheduler SDK directly instead of through adapters:
  [decision 8](../DESIGN_DECISIONS.md#8-every-external-service-sits-behind-an-adapter-chosen-by-env).
- Managed databases instead of self-hosted Docker: [decision 1](../DESIGN_DECISIONS.md#1-a-0-budget-free-tiers-only).

## Failure handling

- Network errors and HTTP 408/429/5xx are retried with backoff (`Retry-After` honoured); other 4xx fail at once.
- One failed city is recorded in the run's errors and the run is `partial`; the other cities still load.
- A run that is not `success` sends a `warn` or `error` through the `Notifier` (console locally, SNS when
  `NOTIFIER=sns`).
- At the Open-Meteo budget, `BudgetExceeded` stops the job cleanly; the next run resumes from its watermark.
- A failed S3 archive upload logs a warning and the pipeline goes on. Past the daily PUT cap, uploads are skipped and
  logged.
- The watcher shuts down cleanly on SIGINT/SIGTERM and closes the store.

## Security

- MongoDB listens on `127.0.0.1` only (Docker port mapping); no credentials are needed locally.
- The fetcher container gets AWS credentials only when `AWS_CONFIG_DIR` is set, read-only, and only the publish-only
  `weather-runtime` profile, never the deploy keys.
- Config comes only from environment variables read in `src/config.js`, all listed in `.env.example`.

## Numbers

| Number | Source |
|---|---|
| 53 cities | [README.md](../../README.md), "By the numbers" |
| Open-Meteo use ~2,400 weighted calls a day (24% of the free 10,000); our caps 2,000 / hour and 6,000 / day | [ROADMAP.md](../ROADMAP.md), free-tier table |
| Local Docker disk ~32 MB a day (≈ 12 GB a year), mostly forecast snapshots | [ROADMAP.md](../ROADMAP.md), free-tier table |
| 1.75 M hourly observations and 3.42 M forecast snapshots loaded (as of 2026-10-09) | [README.md](../../README.md), "By the numbers" |
| Local fetcher S3 archive: ~6 PUTs a day expected, cap 10 a day | [SETUP_AWS.md](../SETUP_AWS.md), S3 PUT budget table |

## Where in the code

| What | File |
|---|---|
| CLI, watcher, schedules | `fetchWeather.js` |
| Stage 1 → 2 → 3 orchestration | `pipeline.js` |
| Mode runner and run log | `src/stage1/runMode.js`, `src/lib/runLog.js` |
| Open-Meteo jobs | `src/stage1/openMeteoHistory.js`, `openMeteoForecast.js`, `openMeteoBackfill.js`, `openMeteoBaseline.js` |
| Atlas sync, forecast-gap check | `src/stage1/atlasSync.js`, `src/stage1/forecastGap.js` |
| HTTP and API budget | `src/lib/http.js`, `src/lib/apiBudget.js` |
| Collections and keys | `src/collections.js` |
| Raw store adapters | `src/adapters/rawStore/mongoRawStore.js`, `src/adapters/rawStore/s3RawArchive.js` |
| Scheduler adapter | `src/adapters/scheduler/cronScheduler.js` |
| Container | `docker-compose.yml` (`fetcher`) |
