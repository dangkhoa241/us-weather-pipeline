# Roadmap

Portfolio project for Data Engineer / Software Engineer roles. Focus: US weather forecasts + historical statistics.

## Cost rule (personal project)
This is a personal portfolio project with a $0 budget. Use only free tools, free APIs and free tiers.
- Never add a paid service, a paid plan, or anything that needs a paid upgrade to keep working.
- Before adding any external service, check its free-tier limits and write them in docs/ROADMAP.md
  (limit, what happens when it is exceeded, and whether a credit card is required).
- Prefer self-hosted open-source tools (Docker) over managed services.
- Stay far below free limits: add rate limits, batch sizes and data retention so usage can't grow past them.
- If a feature can't be done for free, stop and ask me instead of choosing a paid option.

Approved free stack:
- Data: NWS API (free, public), Open-Meteo (free for non-commercial use)
- Local: Docker Compose with MongoDB, ClickHouse, Redis (all open source)
- Deploy: one always-free VM (e.g. Oracle Cloud Always Free) running the same Docker Compose stack,
  or MongoDB Atlas M0 + Upstash/Redis Cloud free plans; dashboard on Cloudflare Pages / Netlify / Vercel free plans
- CI: GitHub Actions (free for public repos)
- Alerts: Discord webhook (free)
- Optional later: BigQuery free tier (10 GB storage, 1 TB queries/month), AWS free tier.
  Both need a budget alert set to $1 before any use.
- Not allowed: ClickHouse Cloud (trial only), NAT Gateway, paid EC2/RDS, any paid API.

### Free-tier limits of services in use (checked 2026-09-29)

| Service | Free limit | When exceeded | Card? | Our use: 20 cities | Our use: 150 cities |
|---|---|---|---|---|---|
| NWS API | No published quota; needs a `User-Agent` with contact | Temporary block (403/429) | No | ~40 forecast req / 3 h, 1 alerts req / 15 min | ~300 req / 3 h |
| Open-Meteo | Non-commercial only. 600 / min, 5,000 / hour, 10,000 / day *weighted* calls (a request counts extra per 10 variables and per 14 days) | 429 until the window resets | No | ~800 / day steady; first 3-year backfill ~2,000 once | ~6,000 / day steady (60%, too close); backfill ~15,000 (over the daily limit) |
| Discord webhook | ~30 messages / min per webhook | 429 | No | a few / day | a few / day |
| GitHub Actions | Free on public repos (private: 2,000 min / month) | Jobs stop running | No | — | — |
| MongoDB, ClickHouse, Redis (Docker) | Self-hosted; limited only by disk | Disk full | No | ~12 MB / day on disk (≈ 4 GB / year), mostly forecast snapshots | ~90 MB / day (≈ 32 GB / year) |

Deploy-target notes (not in use yet): Oracle Cloud Always Free requires a credit card to sign up.
MongoDB Atlas M0 has 512 MB of storage; the raw store already holds ~260 MB (uncompressed), so M0 only works with
aggressive retention. The BigQuery sandbox (no card) expires tables after 60 days.

Cost follow-ups (must be done before expanding to ~150 cities):
- [ ] Open-Meteo usage budget: count weighted calls per hour/day and stop well below the limits; spread the first backfill over several days
- [ ] Run `om-forecast` every 6 h to match model runs (halves Open-Meteo usage), or trim models/variables
- [ ] Retention for raw `forecast_snapshots` / `observations_hourly` in MongoDB once they are loaded into the warehouse

**Pipeline flow (keep script names):**
`fetchWeather.js` (API → MongoDB) → `etlToClickHouse.js` (MongoDB → ClickHouse) → `clickhouseToRedis.js` (ClickHouse → Redis) → `backend/` (Express API) → `dashboard/`

**Adapter rule:** every external service sits behind a small interface chosen via `.env`, so AWS can be added later without touching pipeline code.

| Interface | Local (now) | AWS (optional later phase) |
|---|---|---|
| RawStore | MongoDB | S3 |
| CacheStore | Redis | DynamoDB |
| Scheduler | node-cron | EventBridge |
| Notifier | Console / Discord | SNS |

**Data sources (free):**
- National Weather Service (`api.weather.gov`): 7-day + hourly forecasts, active alerts. No key; requires a `User-Agent` header.
- Open-Meteo: archive API for history (last ~5 days are null or model-filled → skip them); forecast API for multi-model snapshots.

**Scope:** ~150 major US cities (largest city in each state + Stockton, CA). A `locations` collection/table
(`id, name, state, region, lat, lon, timezone, nws_office, grid_x, grid_y`; `timezone` is IANA, e.g. `America/Los_Angeles`); region is Northeast / Midwest / South / West. Every stage loops over it.

---

## Setup (Mon)

- [x] Fresh repository, team leftovers removed (TEAM_NAME key prefix, hard-coded author filter, team author metadata → `PIPELINE_NAME`, team names)
- [x] `docs/ROADMAP.md` + `CLAUDE.md`
- [x] `docker-compose.yml` (MongoDB, ClickHouse, Redis) + `.env.example`
- [x] Adapter interfaces in `src/adapters/` with local implementations (Mongo, Redis, node-cron, console)
- [x] Seed `locations` with 20 test cities
- [ ] Expand `locations` to ~150 cities

## Known bugs

- [x] 1. `fetchStocktonWeather.js` only fetches 1 day (`hoursBack = 24 * 1`); archive API returns nulls for the last ~5 days
- [ ] 2. ClickHouse columns are non-nullable `Float32` → nulls silently stored as 0
- [x] 3a. Duplicates in MongoDB: inserts have no unique key
- [ ] 3b. Duplicates in ClickHouse: `etlToClickHouse` loads ALL docs every run; `monthly_agg` uses `INSERT…SELECT` every run
- [ ] 4. `daily_weather` actually holds hourly rows (hour dropped via `timestamp.slice(0,10)`)
- [ ] 5. Dashboard month labels shift one month back (`new Date("YYYY-MM-01")` parsed as UTC, shown in America/Los_Angeles)
- [ ] 6. Frontend turns null into 0 (`?.toFixed(1) || 0`) and uses `alert()`
- [ ] 7. `backend/routes/monthly.js` builds SQL by string interpolation → use ClickHouse `query_params`
- [ ] 8. Sync status computed from Redis TTL in two places; `/api/sync-now` only runs the Redis step; `/health` checks nothing
- [ ] 9. `etlToClickHouse.js` never closes the ClickHouse client, skips closing Mongo on early return; uses `host:` while backend uses `url:`

## Stage 1 – API → MongoDB (`fetchWeather.js`, replaces `fetchStocktonWeather.js`) (Mon)

- [x] Locations seed (NWS office + grid resolved from `/points`)
- [x] Open-Meteo history: backfill CLI (`--location --from --to`)
- [x] Open-Meteo history: incremental watermark per location (3+ years)
- [x] Skip trailing nulls (archive lag ~5 days)
- [x] NWS forecasts every 3 hours stored as snapshots (`issued_at, target_time, lead_days, values`)
- [x] NWS alerts every 15 minutes
- [x] Retry with backoff + rate limiting
- [x] Unique indexes (no duplicates on re-run)
- [x] Run metadata: `etl_batch_id, source_timestamp, status, rows_fetched`
- [x] Open-Meteo forecasts (best_match, gfs_seamless, ecmwf_ifs025, icon_seamless) as snapshots with a `model` field
- [x] IANA `timezone` per location
- [ ] **Start collecting forecasts today** (accuracy data needed by Friday)

## Stage 2 – MongoDB → ClickHouse (`etlToClickHouse.js`) (Tue)

- [ ] True incremental load (watermark)
- [ ] **Daily aggregates group by each city's local day**, not the UTC day: `toDate(time, timezone)` using
      `locations.timezone` (storage stays UTC). Same for week/month/…; a "day" in Honolulu starts 10 h after UTC midnight.
- [ ] `hourly_weather` with Nullable columns, `ReplacingMergeTree`
- [ ] Materialized views: day / week / month / quarter / half-year / year
- [ ] `forecast_snapshots`
- [ ] `forecast_accuracy`: join forecasts with actuals (error, abs_error, MAE and bias per lead day)
- [ ] `alerts`
- [ ] Data quality checks (null rate, ranges, rows/day) + quarantine table
- [ ] `pipeline_runs` (batch_id, stage, rows_in, rows_out, duration, status)

## Stage 3 – ClickHouse → Redis (`clickhouseToRedis.js`) (Wed)

- [ ] Cache keyed by query params
- [ ] Refresh after each Stage 2 run
- [ ] Store `data_version` so sync status reflects the real sync
- [ ] Track cache hits and misses

## Stage 4 – Backend API (`backend/`) (Wed)

- [ ] Zod validation
- [ ] Swagger at `/docs`
- [ ] Rate limiting
- [ ] Parameterized queries only
- [ ] One ClickHouse query builder for all periods
      (half-year = `if(toMonth(d) <= 6, toStartOfYear(d), addMonths(toStartOfYear(d), 6))`)
- [ ] `GET /api/v1/locations`
- [ ] `GET /api/v1/stats?location=&metric=&period=week|month|quarter|half|year&from=&to=&compare=`
- [ ] `GET /api/v1/map?level=state|city&metric=&period=&at=`
- [ ] `GET /api/v1/drill?location=&level=&key=`
- [ ] `GET /api/v1/forecast/:locationId`
- [ ] `GET /api/v1/alerts?state=`
- [ ] `GET /api/v1/accuracy?location=&period=&lead=`
- [ ] `GET /api/v1/records?location=`
- [ ] `GET /api/v1/pipeline/status`, `GET /api/v1/pipeline/runs`, `POST /api/v1/pipeline/run?stage=`
- [ ] `GET /health` (checks Mongo, ClickHouse, Redis)

## Stage 5 – Dashboard (`dashboard/`, rebuilt with Vue 3 + Vite + TypeScript + ECharts + Pinia) (Thu–Sat)

**Setup & filters (Thu)**
- [ ] Vue 3 + Vite + TypeScript + vue-echarts + Pinia scaffold
- [ ] Filters kept in the URL; °F default
- [ ] Global filters: location, period (Week/Month/Quarter/Half-Year/Year), date range + presets, metric, °F/°C, compare (previous period / same period last year)
- [ ] KPI cards with delta and sparkline
- [ ] US choropleth map (states, Albers USA with AK/HI insets, us-atlas TopoJSON)
- [ ] Map: click state → zoom + city markers; click city → city page
- [ ] Map toggles: metric / forecast error / active NWS alerts; 7-day forecast time slider

**Drill-down, charts, tables (Fri)**
- [ ] Time drill-down: Year → Half → Quarter → Month → Week → Day → Hour, with breadcrumb
- [ ] Place drill-down: US → Region → State → City
- [ ] Charts: temperature min/max band, rain bars, calendar heatmap, wind rose, monthly box plot, anomaly vs normal, state ranking, temperature vs rain scatter
- [ ] Tables: sortable, searchable, paginated, grouped by period, conditional colors, CSV export, click row to drill in
- [ ] Pages: Overview, Forecast, Statistics, Forecast Accuracy

**More pages (Sat)**
- [ ] Compare page (2–4 cities) *(cut first if short on time)*
- [ ] Records page
- [ ] Pipeline Ops page
- [ ] Dark mode, inline errors (no `alert()`), freshness badge, missing data shown as gaps

## Cross-cutting

- [ ] `pipeline.js` orchestrator (1 → 2 → 3, stop on failure) scheduled by node-cron (Wed)
- [ ] Heat-wave alerts + pipeline-failure alerts via Notifier (Sat)
- [ ] Docker Compose: add API service (Wed)
- [ ] Unit tests (Sat)
- [ ] Testcontainers integration tests (Sat) *(cut first if short on time)*
- [ ] GitHub Actions CI (Sat)
- [ ] README with Mermaid architecture diagram (Sun)
- [ ] Screenshots + demo GIF, polish (Sun)

## Optional later phase – AWS

- [ ] RawStore → S3
- [ ] CacheStore → DynamoDB
- [ ] Scheduler → EventBridge
- [ ] Notifier → SNS

## Schedule

| Day | Focus |
|---|---|
| Mon | Docker Compose, `.env.example`, adapters, locations, Stage 1 (start collecting forecasts today) |
| Tue | Stage 2 (tables, materialized views, forecast accuracy, quality checks, run log) |
| Wed | Stage 3 + orchestrator + Stage 4 API |
| Thu | Dashboard setup, filters, KPI cards, US map with drill-down |
| Fri | Drill-down charts, tables, Forecast and Accuracy pages |
| Sat | Compare, Records, Pipeline Ops pages, alerts, tests, CI |
| Sun | README, screenshots, demo GIF, polish |

If time runs short, cut the Compare page and Testcontainers first.
