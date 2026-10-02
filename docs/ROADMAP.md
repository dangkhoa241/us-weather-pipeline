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

| Service | Free limit | When exceeded | Card? | Our use: 53 cities (current) | Note |
|---|---|---|---|---|---|
| NWS API | No published quota; needs a `User-Agent` with contact | Temporary block (403/429) | No | ~106 forecast req / 3 h (~40 s), 1 alerts req / h | fine |
| Open-Meteo | Non-commercial only. 600 / min, 5,000 / hour, 10,000 / day *weighted* calls (a request counts extra per 10 variables and per 14 days) | 429 until the window resets | No | ~2,400 / day steady (24%: ~1,100 history/backfill/baseline + ~1,270 om-forecast every 6 h); our cap 2,000 / h and 6,000 / day, backfill ≤ 75% of it | catch-up below |
| Vercel Hobby (dashboard demo, static) | 100 GB Fast Data Transfer / month, 100 deployments / day, 45 min / build; non-commercial only | Project paused (Hobby is never billed) | No | ~0.5 MB gzipped per visit (≈ 200k visits / month) | static snapshot, size independent of traffic |
| MongoDB Atlas M0 (NWS via GitHub Actions) | 512 MB storage | Writes fail | No | ~48 MB / day; 7-day TTL ≈ 335 MB data, ~370 MB with indexes (72%) | if > 430 MB: retention 5 days |
| Discord webhook | ~30 messages / min per webhook | 429 | No | a few / day | a few / day |
| GitHub Actions | Free on public repos (private: 2,000 min / month) | Jobs stop running | No | — | — |
| MongoDB, ClickHouse, Redis (Docker) | Self-hosted; limited only by disk | Disk full | No | ~32 MB / day on disk (≈ 12 GB / year), mostly forecast snapshots | local disk only |
| AWS SNS (Stage 6a part 1, deployed 2026-10-01, us-east-2) | Always free: 1 M publishes, 1,000 email deliveries / month | Free plan: covered by sign-up credits, never billed; credits used up → account closes | No (Free plan) | warn/error only: a few emails / day (< 150 / month) | SNS_MIN_LEVEL=warn; one email per alerts run |
| AWS Lambda NWS collector (Stage 6a part 3, deployed 2026-10-02, us-east-2) | Always free: 1 M requests + 400,000 GB-s / month | Free plan: credits; used up → account closes | No (Free plan) | 24 alerts + 8 forecast runs / day ≈ 960 invocations, ~6,800 GB-s / month (256 MB; measured 2026-10-02: alerts ~8 s / 158 MB, forecasts ~88 s / 168 MB; 2%) | 5 min timeout, no VPC (no NAT), handler never throws (no retries) |
| Amazon EventBridge rules (part 3) | Scheduled rules: no charge | — | No | 2 rules, 32 invocations / day | hourly at most |
| CloudWatch Logs (part 3) | Always free: 5 GB ingest + 5 GB storage / month | Free plan: credits | No | < 50 MB / month | 7-day retention |
| SSM Parameter Store (part 3) | Standard parameters free; SecureString with the AWS-managed key `aws/ssm` (KMS: 20,000 free requests / month) | Standard throughput: throttled, not billed | No | 1 parameter, ≤ ~1,000 reads / month (cold starts) | no customer KMS key |
| AWS S3 raw archive (Stage 6a part 2, deployed 2026-10-02, us-east-2) | 12-month free tier: 5 GB storage, 2,000 PUT + 20,000 GET / month (Free plan: over that is paid from the credits, never billed) | Free plan: credits; used up → account closes | No (Free plan) | ~22 PUTs / day ≈ 660 / month (33%: Lambda 16, local ~6); caps Lambda 16 + local 10 / day ≤ 806 / month (40%); first day: 6 objects, 3.2 MB; ~175 MB held by the 30-day rule (3.5%); GET only by hand | one object per source and run; ≤ 1 per source per hour; hard cap RAW_ARCHIVE_MAX_PUTS_PER_DAY=50 (≤ 1,500 / month); 32 MB per source and run |

AWS (Stage 6a, docs/SETUP_AWS.md; cost guard in CLAUDE.md): **Free plan** account (new sign-up experience, until 2027-04-02).
No charges are possible: usage above the always-free allowances is paid from the sign-up credits ($100 + up to $100), and
the account **closes automatically** when the credits run out or the plan ends (data kept 90 days), unless upgraded.
So AWS only holds copies (alert emails, a 30-day raw archive, one Lambda); the local stack stays primary, and the
infrastructure is code (`infra/template.yaml`) to redeploy elsewhere. All planned services are on the Free-plan list
(SNS, S3, Lambda, EventBridge, CloudWatch Logs, CloudFormation, IAM, SSM; checked 2026-10-02). Planned allowances:
Lambda 1 M requests + 400,000 GB-s / month, CloudWatch Logs 5 GB, EventBridge Scheduler 14 M invocations / month;
S3: assume it draws on the credits (not verified as always free): keep it to a few hundred MB with the 30-day lifecycle rule.
S3 archive estimate (measured 2026-10-01, gzipped): NWS forecast ~5.7 KB / city (hourly + 12 h) × 53 cities × 8 runs / day
≈ 72 MB / month; Open-Meteo forecast ~10 KB / city × 53 × 4 / day ≈ 64 MB; NWS alerts ~40 KB × 24 / day ≈ 29 MB;
history + baseline ~10 MB. PUTs: forecast 8 + om-forecast 4 + alerts 24 + history 1 + baseline 1 ≈ 38 / day.
Deploy-target notes (not in use yet): Oracle Cloud Always Free requires a credit card to sign up.
Atlas M0 holds only the last 7 days of NWS data (see the table); the full raw store stays local. The BigQuery sandbox (no card) expires tables after 60 days.

Completion estimates after expanding to 53 cities (2026-10-01, budgets unchanged):
- History (3 years × 33 new cities, ~3,300 weighted calls): ~1–3 days of Docker running.
- om-backfill (90 days × 33 new cities + the first 20 from Aug 8, ~64,000 calls + ~840/day of new runs):
  ~18 days at the full 6,000 calls/day (Docker on ≥ 4 h/day), ~30 days at ~2 h/day.

Cost follow-ups:
- [x] Open-Meteo usage budget: `api_usage` ledger per UTC hour/day (defaults 2,000 / 6,000 weighted calls), shared by history, om-backfill, om-baseline and om-forecast; jobs stop cleanly and resume
- [x] Accuracy data from `om-backfill` (Single Runs, 1 weighted call per run/model/city); live `om-forecast` every 6 h for the Forecast page
- [ ] Retention for raw `forecast_snapshots` / `observations_hourly` in MongoDB once they are loaded into the warehouse

**Pipeline flow (keep script names):**
`fetchWeather.js` (API → MongoDB) → `etlToClickHouse.js` (MongoDB → ClickHouse) → `clickhouseToRedis.js` (ClickHouse → Redis) → `backend/` (Express API) → `dashboard/`

**Adapter rule:** every external service sits behind a small interface chosen via `.env`, so AWS can be added later without touching pipeline code.

| Interface | Local (now) | Cloud (optional later phase) |
|---|---|---|
| RawStore | MongoDB | S3 |
| CacheStore | Redis | DynamoDB |
| Warehouse | ClickHouse | BigQuery (free tier) |
| Scheduler | node-cron | EventBridge |
| Notifier | Console / Discord | SNS |

**Data sources (free):**
- National Weather Service (`api.weather.gov`): 7-day + hourly forecasts, active alerts. No key; requires a `User-Agent` header.
- Open-Meteo: archive API for history (last ~5 days are null or model-filled → skip them); forecast API for multi-model snapshots.

**Scope:** 53 US cities: the largest city of every state, Washington DC, Stockton (CA) and Miami (FL). A `locations` collection/table
(`id, name, state, region, lat, lon, timezone, nws_office, grid_x, grid_y`; `timezone` is IANA, e.g. `America/Los_Angeles`); region is Northeast / Midwest / South / West. Every stage loops over it.

---

## Setup (Mon)

- [x] Fresh repository, team leftovers removed (TEAM_NAME key prefix, hard-coded author filter, team author metadata → `PIPELINE_NAME`, team names)
- [x] `docs/ROADMAP.md` + `CLAUDE.md`
- [x] `docker-compose.yml` (MongoDB, ClickHouse, Redis) + `.env.example`
- [x] Adapter interfaces in `src/adapters/` with local implementations (Mongo, Redis, node-cron, console)
- [x] `Warehouse` adapter (`WAREHOUSE=clickhouse`): schema, inserts, watermark, period builder; nothing else imports `@clickhouse/client`
      (legacy `etlToClickHouse.js`, `clickhouseToRedis.js`, `backend/config/clickhouse.js` still do until Stages 2–4 rewrite them)
- [x] Seed `locations` with 20 test cities
- [x] Expand `locations` to 53 cities (largest per state + DC + Stockton + Miami)

## Known bugs

- [x] 1. `fetchStocktonWeather.js` only fetches 1 day (`hoursBack = 24 * 1`); archive API returns nulls for the last ~5 days
- [x] 2. ClickHouse columns are non-nullable `Float32` → nulls silently stored as 0
- [x] 3a. Duplicates in MongoDB: inserts have no unique key
- [x] 3b. Duplicates in ClickHouse: `etlToClickHouse` loads ALL docs every run; `monthly_agg` uses `INSERT…SELECT` every run
- [x] 4. `daily_weather` actually holds hourly rows (hour dropped via `timestamp.slice(0,10)`)
- [ ] 5. Dashboard month labels shift one month back (`new Date("YYYY-MM-01")` parsed as UTC, shown in America/Los_Angeles)
- [ ] 6. Frontend turns null into 0 (`?.toFixed(1) || 0`) and uses `alert()`
- [x] 7. `backend/routes/monthly.js` builds SQL by string interpolation → use ClickHouse `query_params`
- [x] 8. (fixed: `/api/v1/pipeline/status` reports the real data version from `cacheStatus()`; legacy routes removed) Sync status computed from Redis TTL in two places; `/api/sync-now` only runs the Redis step; `/health` checks nothing
- [x] 9. `etlToClickHouse.js` never closes the ClickHouse client, skips closing Mongo on early return; uses `host:` while backend uses `url:`

## Resume numbers

- Stage 3 cache (10 dashboard queries, local Docker): warm p95 **35.4 → 2.9 ms** (12× faster), cold p95 **62.2 → 32.3 ms**;
  373 KB of Redis for 20 cities (the fully pre-warmed variant needed 3.2 MB). Method and data: `docs/analysis/caching.md`.
- Data: 3 years × 20 cities hourly observations (~524k rows), ~960k forecast snapshots (5 models + best_match baseline + NWS; backfill still running), loaded
  incrementally into ClickHouse in seconds.
- API (Hono, 12 dashboard requests, 10 connections): ~1,600 req/s, p95 12.7 ms, 0 errors; 22/22 security checks.
  Compared with Express + Zod and Fastify + JSON Schema: same throughput within noise, Hono lowest memory (~150 MB vs
  up to 282 MB) and smallest dependency tree (116 vs 168–174 packages). Method and data: `docs/analysis/api-layer.md`.
- Dashboard map (3 implementations compared): hand-rolled d3-geo adds 47 KB gzipped (vs 71 KB react-simple-maps, 83 KB
  ECharts), first render 149 ms, 51 keyboard-focusable labelled states/cities. Method: `docs/analysis/map-drilldown.md`.
- City drill-down chart (3 implementations compared): hand-rolled d3-scale/d3-shape SVG adds 10 KB gzipped (vs 17 KB
  ECharts, 108 KB Recharts), first render 185 ms, every month/day a keyboard-focusable button; drill state in the URL.
  Method: `docs/analysis/drilldown-chart.md`.
- Static demo: 2.9 MB snapshot (412 KB gzipped): daily data for 53 cities from 2023-01-01 (monthly values derived in
  the browser), forecasts, NWS periods/alerts and accuracy details; 17/17 demo checks, 0 CSP violations under a strict policy.
- Forecast accuracy (90 days, 20 cities, lead day 1): ECMWF 2.1°F average error, ICON 2.3°F, HRRR 2.9°F, GFS 3.1°F;
  the best-match baseline 2.6°F. Error grows ~0.25°F per extra lead day.
- AWS (Free plan, $0): NWS collection on Lambda + EventBridge (~960 runs / month, ~2% of the free GB-s; forecast run
  106 requests → ~9,000 rows in ~88 s at 168 MB), SNS alerts, 30-day S3 archive (~33% of free PUTs, ≤ 40% by hard caps);
  one SAM stack, permissions boundary on every role, removed by `npm run aws:teardown`.
- Tests: 107 Vitest tests (33 backend + 74 dashboard), no Docker needed, run in GitHub Actions CI; 18 automated checks on the static demo build.

## Known limitations

Accepted for now (personal project: good enough beats perfect). Revisit only if they break something visible.
- AWS Free plan ends 2027-04-02: the account then closes unless upgraded (needs my OK), and AWS deletes the data
  after 90 days. The Vercel dashboard doesn't depend on AWS (static snapshot); once Part 4 is built, it falls back to
  the bundled snapshot when CloudFront is unavailable. NWS collection would fall back to the manual GitHub workflows.
- The dashboard is not live yet (Part 4 not built): it shows the last exported snapshot.
- NWS Lambda: a run that hits the 5 min timeout sends no SNS email (only the Lambda error in its logs). It doesn't seed
  locations (Atlas already has them; a new city needs one manual `seed:locations` against Atlas). Heat-alert emails can
  arrive twice if alerts are run locally by hand (`npm run fetch` / `fetch:watch` outside Docker), because Atlas and the
  local store each see the alert as new. The Docker fetcher has alerts off.
- S3 raw archive: NWS alerts are kept once per 3-hour UTC slot (00, 03, … UTC; fetched hourly), so a failed run at
  those hours leaves a 3-hour gap; `om-backfill` is not
  archived; a run's responses for one source stop being archived past 32 MB (only a big history catch-up); skipped
  or failed uploads are logged, not retried.
- `best_match` baseline: `issued_at` is approximate (target − N days) and `lead_hours` is null; compare it by lead day only.
- HRRR is backfilled for 00/06/12/18Z runs only (Single Runs doesn't keep the hourly runs in between).
- `precipitation_probability` is missing from backfilled model forecasts (ensemble-only in Single Runs).
- `gfs_seamless` snapshots from the first day are tagged `legacy` / `exclude_from_accuracy`; live `best_match` snapshots
  from the first day (`issued_at_basis: fetch_hour`) remain but aren't used for accuracy.
- Live `om-forecast` reads the run time from `meta.json` before fetching; if a model publishes a new run mid-fetch the run is
  marked partial and some snapshots may mix runs.
- NWS sometimes serves old forecasts (e.g. Philadelphia issued the day before); stored as-is with their `issued_at`.
- GitHub Actions cron runs can start 10–30+ min late or be skipped (first night: 5 of ~7 forecast runs and 4 of ~20 alert
  runs happened); alerts are checked hourly at best, so short alerts can be missed.
- Observed history lags ~5 days (archive), so accuracy for the most recent days fills in later.
- Rollups include partial days (e.g. the last archive day); the `hours` column tells complete days apart.
- Forecast accuracy covers temperature on hourly forecasts only (NWS 12-hour periods and precipitation skill not yet).
- `forecast_accuracy` is a plain view computed at query time; fine at 53 cities, may need materializing if it slows down.
- `cityForecast` still shows the first day's live `icon_seamless` and `best_match` snapshots as extra "models".
- The popular (pre-warmed) and benchmark queries use fixed dates; they should become relative ("last 7 days") in Stage 4.
- Cache hit/miss counters are cumulative (never reset); per-day counters can come with the Pipeline Ops page.

Security (low; from the security review of Stages 1–2, compose and workflows):
- Local MongoDB and Redis have no authentication, and ClickHouse uses the development password `weather` with access
  management on. Acceptable because all three are bound to 127.0.0.1 and hold only public weather data.
- GitHub Actions are pinned by major version tag (`@v7`), not by commit SHA. They are GitHub-owned actions.
- Atlas network access is `0.0.0.0/0` (GitHub runners have changing IPs), mitigated by a user limited to the `weather`
  database, a generated password and TLS.
- API rate limits are kept in process memory and keyed on the socket address; behind a reverse proxy this needs
  trusted-proxy handling, and with several API processes a shared store (e.g. Redis).
- The `/docs` page allows `'unsafe-inline'` scripts (Swagger UI's init script); it has no user content and only the
  pinned CDN path is allowed for external scripts.
- The API is not a Docker Compose service yet (run with `npm start`).
- Dashboard: city dot values are means of yearly rows weighted by hours (same as the state values, not per-day exact);
  PNG downloads use the system sans-serif font (the web font isn't available to the exported image).
- Forecast page: Open-Meteo model forecasts are refreshed every 6 h by the watcher (`om-forecast`, ~318 weighted calls
  per run, ~1,270/day from the shared budget), so they need the local machine on; NWS is collected in the cloud.
- Accuracy page: model accuracy so far covers ~Jul 1 – Aug 7 for the original 20 cities (om-backfill works forward from
  the oldest day); NWS appears once its forecasts can be matched with observations (~5-day archive lag). States
  without tracked cities or enough pairs are hatched.
- Biggest misses exclude best_match (approximate issue time); a few remaining large misses may still be data artifacts.
- Demo snapshot: accuracy map/bias/misses only for all US over the default 90-day range (other choices show a note).
- Dashboard: KPI sparklines stay daily (the Period filter drives the trend chart); the map colors by temperature or
  precipitation only. The city chart scales its text with the width (SVG `viewBox`).
- Static demo: data frozen at the snapshot date; forecast accuracy only for preset ranges; Zod runs "jitless" in the
  browser (no `new Function`, required by the CSP).
- Legacy `backend/` (rewritten in Stage 4): CORS allows any origin, errors return internal messages to the client, and
  it reads `process.env` directly. It now listens on 127.0.0.1 only.

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
- [x] Open-Meteo forecasts as snapshots with a `model` field: gfs_hrrr, gfs_global, ecmwf_ifs025, icon_global (backfilled
      from Single Runs) + best_match baseline (Previous Runs); live `om-forecast` every 6 h (02:40/08:40/14:40/20:40 UTC, after the model runs)
- [x] IANA `timezone` per location
- [x] `om-backfill`: past 00/06/12/18Z runs of gfs_hrrr, gfs_global, ecmwf_ifs025, icon_global from the Single Runs API
      (exact `issued_at`, run-horizon caps, progress marker per model + city); 90-day backfill spread over ~5 days
- [x] `om-baseline`: best_match baseline from the Previous Runs API (value forecast 1–7 days before each past hour;
      `lead_days` exact, `issued_at` approximate, `lead_hours` null); live best_match collection stopped
- [x] NWS collection in the cloud: GitHub Actions (forecasts every 3 h, alerts hourly) → MongoDB Atlas M0 with a 14-day TTL;
      `sync-atlas` copies it to local Mongo at watcher startup and daily; warning + `sync_stale` run if the last sync is > 7 days old
- [x] **Start collecting forecasts today** (accuracy data needed by Friday): `fetcher` service in Docker Compose
      (`restart: unless-stopped`); on start it warns and records a `gap_detected` run if the newest snapshot is > 6 h old

## Stage 2 – MongoDB → ClickHouse (`etlToClickHouse.js`) (Tue)

- [x] True incremental load (watermark): `stored_at` stamp on every raw-store write, marker per collection (also catches `sync-atlas` copies)
- [x] **Daily aggregates group by each city's local day**, not the UTC day (storage stays UTC). ClickHouse needs a
      constant time zone in `toDate(time, tz)`, so Stage 2 writes a `local_time` column (wall-clock time from
      `locations.timezone`, via `src/lib/time.js`) and the period builder groups on it. Same for week/month/…;
      a "day" in Honolulu starts 10 h after UTC midnight.
- [x] `hourly_weather` with Nullable columns, `ReplacingMergeTree`
- [x] Rollups `weather_daily` / `weather_monthly` (ReplacingMergeTree, recomputed for touched local days); week / quarter / half-year / year
      come from the period builder (`queryStats`)
- [x] `forecast_snapshots`
- [x] `forecast_accuracy`: view joining hourly forecasts with observations (temperature error, abs error); `accuracySummary` gives MAE and bias per model and lead day
- [x] `alerts`
- [x] Data quality checks (null rate, ranges) + quarantine table (simple; rows/day check not yet)
- [x] `pipeline_runs` (batch_id, stage, rows_in, rows_out, duration, status)

## Stage 3 – ClickHouse → Redis (`clickhouseToRedis.js`) (Wed)

Chosen after comparing three strategies (`docs/analysis/caching.md`): versioned cache-aside + pre-warmed landing-page
queries + single-flight.
- [x] Cache keyed by query params (hash of normalized params + data version)
- [x] Refresh after each Stage 2 run (version pointer switch after pre-warming 4 popular queries; old version deleted)
- [x] Store `data_version` so sync status reflects the real sync (`cacheStatus()`: version, loaded_at, switched_at)
- [x] Track cache hits and misses (per query type)
- [x] Redis down → answers come from ClickHouse (fail fast, no hang); Redis capped at 64 MB (`volatile-lru`)

## Stage 4 – Backend API (`backend/`) (Wed)

Hono, chosen after comparing Express + Zod, Fastify + JSON Schema and Hono (`docs/analysis/api-layer.md`).
- [x] Zod validation (`@hono/zod-openapi`; unknown query parameters rejected)
- [x] Swagger at `/docs` (OpenAPI at `/openapi.json`, generated from the same Zod route definitions; Swagger UI pinned)
- [x] Rate limiting (per client IP, `API_RATE_LIMIT_PER_MIN`), CORS for `CORS_ORIGINS`, security headers + strict CSP
- [x] Parameterized queries only
- [x] One ClickHouse query builder for all periods
      (half-year = `if(toMonth(d) <= 6, toStartOfYear(d), addMonths(toStartOfYear(d), 6))`)
- [x] `GET /api/v1/locations`
- [x] `GET /api/v1/stats?locations=&metric=&period=day|week|month|quarter|half|year&from=&to=&compare=previous|last_year`
- [x] `GET /api/v1/map?from=&to=` (state level; city level not yet)
- [x] `GET /api/v1/drill?location=&level=&key=` (keys like `2025`, `2025-H1`, `2025-Q3`, `2025-07`, `2025-07-07`)
- [x] `GET /api/v1/forecast/:locationId`
- [x] `GET /api/v1/alerts?state=`
- [x] `GET /api/v1/accuracy?location=&from=&to=` (all lead days returned; no `period`/`lead` filter yet)
- [x] `GET /api/v1/records?location=`
- [x] `GET /api/v1/pipeline/status`, `GET /api/v1/pipeline/runs` (`POST /api/v1/pipeline/run` not yet)
- [x] `GET /api/v1/health` (checks Mongo, ClickHouse, Redis; 503 when a required one is down, "degraded" without Redis)
- [x] Tests: 19 Vitest API tests (`app.request()`), security probe `npm run probe:api` (22 checks), load test `npm run loadtest:api`

## Stage 5 – Dashboard (`dashboard/`, rebuilt with React) (Thu–Sat)

Stack (all free / open source): React + TypeScript + Vite, ECharts via `echarts-for-react`, TanStack Query (API data,
caching, loading/error states), TanStack Table (tables), Zustand (filter state, synced to the URL), Tailwind CSS + shadcn/ui.

**Setup & filters (Thu)**
- [x] React + TypeScript + Vite scaffold with Tailwind + shadcn/ui, echarts-for-react, TanStack Query/Table, Zustand
- [x] Filters in a Zustand store kept in sync with the URL (shareable links, back/forward work); °F default
- [x] Global filters: location, period (Week/Month/Quarter/Half-Year/Year), date range + presets, metric, °F/°C, compare (previous period / same period last year)
- [x] KPI cards with delta and sparkline
- [x] US choropleth map (states, Albers USA with AK/HI insets, us-atlas TopoJSON)
- [x] Map: click state → zoom + city markers; click city → select location (hand-rolled d3-geo, chosen in
      `docs/analysis/map-drilldown.md`; keyboard accessible)
- [x] UI upgrade: map ~60% + linked state table ~40% (hover/click linked, sticky header); all 53 cities as dots
      (glow + value, hollow grey while data is loading); hatched states without data; crisp borders + US outline;
      county borders lazy-loaded on state zoom (separate ~260 KB gzipped chunk, never on first load)
- [x] City history hidden until a city is clicked (fade/slide-in + scroll; × closes and clears `city/year/month`)
- [x] Twin Temperature + Rain charts (drill-down and trend): synced crosshair/tooltip and drill-down, moving average
      (7 days / 3 periods), dashed mean, ▲ max / ▼ min, PNG/CSV download, pill tabs for the period
- [ ] Map toggles: metric / forecast error / active NWS alerts; 7-day forecast time slider

- [x] API types shared with the backend (`src/api/schemas.js`), 74 dashboard tests (Vitest + React Testing Library)
- [x] Static demo on Vercel Hobby: `npm run export:snapshot` → `dashboard/public/data/`, `build:snapshot` mode with a
      "Demo data as of" badge, `dashboard/vercel.json` (strict CSP), `docs/DEPLOY_VERCEL.md`

**Drill-down, charts, tables (Fri)**
- [x] City drill-down chart below the map: years → 12 months of a year (only years with data; future months empty) →
      days of a month, breadcrumb City › Year › Month, state in the URL (`year`, `month`); follows the Metric filter
      (temperature avg line + min/max band, rain bars). Hand-rolled d3 SVG, chosen in `docs/analysis/drilldown-chart.md`
- [x] Trend chart over the selected range grouped by the Period filter (week/month/quarter/half/year)
- [ ] Time drill-down: Year → Half → Quarter → Month → Week → Day → Hour, with breadcrumb
- [ ] Place drill-down: US → Region → State → City
- [ ] Charts: ~~temperature min/max band, rain bars~~ (done), calendar heatmap, wind rose, monthly box plot, anomaly vs normal, state ranking, temperature vs rain scatter
- [ ] Tables: sortable, searchable, paginated, grouped by period, conditional colors, CSV export, click row to drill in
- [x] Page tabs with real URLs (`/`, `/forecast`, `/accuracy`), Back/Forward, filters kept in the query string
- [x] Forecast page: 7 daily cards (NWS periods), next 48 h twin charts, "Models disagree?" (daily high per model +
      spread), active NWS alerts for the state; "Forecast as of" label in the demo
- [x] Forecast Accuracy page: hero line, sortable leaderboard (lead days 1–7, bias, samples, rank), error vs lead day,
      map (best model per state / one model's error), bias by month, biggest misses, "how this is measured"
- [x] "All US" default (US-wide averages; `/stats?locations=all`), no default city
- [x] README with demo GIF (`npm run demo:gif`: Playwright + ffmpeg-static), architecture, numbers, compare & review summary; MIT license; CI workflow
- [ ] Statistics page

**More pages (Sat)**
- [ ] Compare page (2–4 cities) *(cut first if short on time)*
- [ ] Records page
- [ ] Pipeline Ops page
- [x] Dark mode (follows the system, toggle stored per browser), inline errors (no `alert()`), missing data shown as gaps
- [ ] Freshness badge

## Stage 6a – AWS, part 1 (Free plan; docs/SETUP_AWS.md, cost guard in CLAUDE.md)

- [x] Setup guide: `weather-dev` IAM user (CLI only) with a least-privilege policy (`infra/iam/weather-dev-policy.json`),
      AWS CLI + SAM CLI on Windows, `aws configure --profile weather-dev`; keys only in `~/.aws`;
      `check:secrets` catches AWS key IDs, secret keys and session tokens
- [x] Part 1 code: `SnsNotifier` (NOTIFIER=sns; warn/error emailed, failures never break the pipeline, credentials
      redacted), heat alerts (new NWS heat alerts for tracked cities, one email per run), SAM template (SNS topic,
      HTTPS-only topic policy, email subscription), `npm run aws:validate | aws:deploy | aws:teardown`; tests with a mocked SDK client
- [x] Part 1 deploy: stack `weather-pipeline` in us-east-2, email subscription confirmed; `.env` NOTIFIER=sns +
      SNS_TOPIC_ARN, test alert sent (2026-10-01)
- [x] Part 2 code: `S3RawArchive` behind the RawStore (RAW_ARCHIVE=s3): one gzipped NDJSON object per source and
      Stage 1 run, PUT caps in `api_usage`, upload failures only logged; bucket in `infra/template.yaml` (private,
      Block Public Access, SSE-S3, HTTPS only, versioning off, 30-day expiry); runtime `s3:PutObject` on that bucket
      only; teardown empties the bucket; tests with a mocked S3 client
- [x] Part 2 deploy (policies updated by hand: docs/SETUP_AWS.md step 9), RAW_ARCHIVE=s3 + RAW_ARCHIVE_BUCKET in `.env`;
      first object verified 2026-10-02 (nws-forecast run: 106 responses, 235 KB)
- [x] Part 3 code: Lambda `weather-pipeline-nws-collector` (`src/lambda/nwsCollector.js`, esbuild bundle) runs the
      NWS alerts (hourly) and forecast (every 3 h) modes → Atlas (same collections, 7-day TTL) + S3 archive (`nws-*`);
      Atlas URI from an SSM SecureString (aws/ssm key) at cold start; failures → SNS, never thrown (no retries);
      role with the boundary and only ssm:GetParameter / s3:PutObject / sns:Publish / its logs; log group 7 days;
      tests with mocked SSM/store/notifier
- [x] Part 3 deploy (2026-10-02): dev policy + SSM parameter by hand (docs/SETUP_AWS.md step 10), `npm run aws:deploy`;
      test invokes: alerts 157 rows in 8 s, forecast 9,010 rows in 88 s (168 MB peak), both in Atlas `pipeline_runs`
      and archived to S3
- [x] Part 3 switch-over: GitHub NWS workflows → `workflow_dispatch` only (manual fallback); local fetcher runs no
      alerts (`ALERTS_CRON: "off"` in docker-compose; they arrive via sync-atlas); local `RAW_ARCHIVE_MAX_PUTS_PER_DAY=20`
- [x] Part 4 design: live dashboard without the laptop (`docs/analysis/live-dashboard.md`); chose B (S3 + CloudFront
      static JSON, daily history Lambda, accuracy published locally)
- [x] Archive NWS alerts once per 3-hour UTC slot; Lambda cap 16 / day (deployed 2026-10-02); local fetcher NWS
      forecast off (`FORECAST_CRON: "off"`, Lambda + sync-atlas), local cap 10 / day → S3 PUTs ~33% (≤ 40% by caps)
- [ ] Part 4 build: history-updater Lambda, S3 + CloudFront (OAC), backfill,
      dashboard reads CloudFront with bundled-snapshot fallback, CSP `connect-src`

## Cross-cutting

- [x] `pipeline.js` orchestrator (1 → 2 → 3, stop on failure) scheduled by node-cron in the fetcher (every 3 h at :50);
      parent run with steps in `pipeline_runs`, failures sent to the Notifier
- [ ] Heat-wave alerts + pipeline-failure alerts via Notifier (Sat)
- [ ] Docker Compose: add API service (Wed)
- [ ] Unit tests (Sat) — started: Vitest, 31 tests (12 cache + 19 API; `npm test`)
- [ ] Testcontainers integration tests (Sat) *(cut first if short on time)*
- [ ] GitHub Actions CI (Sat)
- [ ] README with Mermaid architecture diagram (Sun)
- [ ] Screenshots + demo GIF, polish (Sun)

## Optional later phase – cloud (free tiers only, $1 budget alert first)

- [ ] Previous Runs backfill for longer lead-day history (to 2025-03): value from the run N days earlier (N = 1–7),
      `issued_at` derived from the run cycle; lead-day precision only

- [ ] BigQueryWarehouse (deploy target, free tier): one new file in `src/adapters/warehouse/` with its own SQL;
      sandbox tables expire after 60 days
- [ ] RawStore → S3 (a 30-day raw *archive* copy exists since Stage 6a part 2; MongoDB stays the raw store)
- [ ] CacheStore → DynamoDB
- [ ] Scheduler → EventBridge
- [x] Notifier → SNS (Stage 6a part 1)

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
