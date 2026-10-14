# Warehouse and ETL: Stage 2 (MongoDB → ClickHouse)

Rebuild steps: the "Run it locally" section of the [README](../../README.md#run-it-locally) (`npm run etl:clickhouse`).

## Purpose

Turn raw documents into analytics tables that answer the dashboard's questions fast: hourly weather per city,
forecast snapshots for accuracy scoring, alerts, and daily and monthly rollups in each city's local time.

## Requirements

- Load only what is new since the last run; re-running must never create duplicates.
- Group days, weeks and months by each city's local time, while storing times in UTC.
- Keep missing values `null`, and keep broken records out of the tables without losing them.
- No string-built SQL: every value is passed as a ClickHouse query parameter.
- Self-hosted and free: ClickHouse in Docker.

## Design

- **Incremental load.** `etlToClickHouse.js` keeps a marker per collection (`stage2:<collection>` in `watermarks`)
  and reads documents with `stored_at` at or after it, in batches of 20,000. The new marker is the time the run
  started, taken before reading, so anything stored during the run is picked up next time. `--full` reloads everything.
- **Transform.** `src/stage2/transform.js` maps documents to rows (warehouse-neutral), adds `local_time` from the
  city's IANA time zone, and runs range checks (for example temperature −70 to 60 °C, humidity 0–100%). A row out of
  range goes to the `quarantine` table with the reason and the original payload.
- **Tables.** All tables use `ReplacingMergeTree` keyed by the natural key, so loading the same row twice keeps one.
  Reads use `FINAL`. `hourly_weather` is partitioned by month and ordered by `(location_id, time)`;
  `forecast_snapshots` is ordered by `(location_id, model, kind, target_time, issued_at)`.
- **Rollups.** After loading, `weather_daily` and `weather_monthly` are recomputed only for the cities and local days
  the run touched (whole months for the monthly table).
- **Run log.** Each run is logged in the raw store's `pipeline_runs` and mirrored into the warehouse's
  `pipeline_runs` table.
- **Adapter.** All SQL lives in `src/adapters/warehouse/clickhouseWarehouse.js`, behind the `Warehouse` interface
  (`WAREHOUSE=clickhouse`). Period grouping uses fixed SQL fragments picked from a whitelist, and every input is a
  `{name:Type}` query parameter.
- **Schedule.** Stage 2 runs inside `pipeline.js` after Stage 1, every 3 hours by default (see
  [ingestion](ingestion.md)).

## Alternatives considered

See [decision 3](../DESIGN_DECISIONS.md#3-clickhouse-as-the-warehouse-with-incremental-idempotent-loads): querying
MongoDB directly, BigQuery's free tier (its sandbox expires tables after 60 days) and ClickHouse Cloud (trial only).

## Failure handling

- A failed load is recorded as `failed` in both run logs, and `pipeline.js` stops before Stage 3 and notifies.
- The marker moves only after a collection's load finishes, so a crash means the next run reads the same documents
  again; `ReplacingMergeTree` absorbs the repeats.
- Quarantined rows are counted in the run and logged, not dropped silently. The run logs the temperature null rate.

## Security

- ClickHouse listens on `127.0.0.1:8123` only (`docker-compose.yml`); it is never reachable from the public site.
- No SQL is built from strings with values in it: values, identifiers and arrays go through `query_params`. A legacy
  endpoint that pasted `?city=` into SQL was the reason for this rule (README, Security).

## Numbers

| Number | Source |
|---|---|
| 1,752,816 hourly rows (53 cities from 2023-01-01) and 3,419,895 forecast snapshots, as of 2026-10-09 | [ROADMAP.md](../ROADMAP.md), "Resume numbers" |
| Loaded incrementally "in seconds" | [ROADMAP.md](../ROADMAP.md), "Resume numbers" |
| Batch size 20,000 documents | `etlToClickHouse.js` (`BATCH`) |

## Where in the code

| What | File |
|---|---|
| Stage 2 runner | `etlToClickHouse.js` |
| Documents → rows, range checks | `src/stage2/transform.js` |
| Local time from a time zone | `src/lib/time.js` |
| Schema, inserts, rollups, queries | `src/adapters/warehouse/clickhouseWarehouse.js` |
| Interface and factory | `src/adapters/warehouse/Warehouse.js`, `src/adapters/warehouse/index.js` |
| Container | `docker-compose.yml` (`clickhouse`) |
