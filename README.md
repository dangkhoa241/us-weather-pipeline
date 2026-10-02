# US Weather Pipeline

**Which weather model forecasts the US best? An end-to-end data pipeline and dashboard that collects forecasts from 5 models, scores them against what actually happened, and explains 3 years of weather for 53 US cities, on a $0 budget.**

[![CI](https://github.com/dangkhoa241/us-weather-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/dangkhoa241/us-weather-pipeline/actions/workflows/ci.yml)
![Tests](https://img.shields.io/badge/tests-107%20passing-brightgreen)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Live demo](https://img.shields.io/badge/live%20demo-vercel-black?logo=vercel)](https://us-weather-pipeline.vercel.app)

### ▶ [Live demo: us-weather-pipeline.vercel.app](https://us-weather-pipeline.vercel.app)

![Demo: All US overview → click a city → drill into a month → Accuracy page → dark mode](docs/images/demo.gif)

## Key finding

> **ECMWF is the most accurate model: 2.1 °F average error one day ahead.**

| Model (lead day 1) | Average error | Bias |
|---|---|---|
| 🥇 ECMWF | **2.1 °F** | none |
| 🥈 ICON | 2.3 °F | none |
| 🥉 HRRR | 2.9 °F | 0.6 °F too cold |
| GFS | 3.1 °F | 0.7 °F too warm |
| *Best-match blend (baseline)* | *2.6 °F* | *0.6 °F too cold* |

Error grows by about 0.25 °F for each extra day of lead time. The scores compare hourly forecasts with observed temperatures: about 65,000 pairs per model, from 20 cities, 2026-06-29 to 2026-09-26. Method: [How this is measured](#how-accuracy-is-measured).

## Design decisions

I designed the product and its features. Claude Code implemented them under my direction, using a compare-3-implementations-and-review process from my earlier ExpenseTracker project.

- **City drill-down:** click a city → 12 months → click a month → daily values, with a year selector.
- **Map and state table side by side, linked:** hovering or clicking one highlights the other.
- **Twin Temperature + Rain charts** with a moving average, an average line and ▲ max / ▼ min markers (inspired by BI dashboards I built at FPT Telecom).
- **Charts appear only when you click a city.** The default is an "All US" overview.
- **Period filters:** Week / Month / Quarter / Half-Year / Year.
- **One city per state,** so the whole map is covered.
- **Forecast-accuracy leaderboard** to answer "which weather model is most accurate?".
- **$0 budget:** everything runs on free tiers.
- **Compare & review:** 3 implementations per key feature, and a security review every stage.

## Features

| | |
|---|---|
| ![Overview: All US KPIs, map with 53 city dots and linked state table](docs/images/readme-overview.png) | ![City drill-down in dark mode: twin temperature and rain charts with synced crosshair](docs/images/readme-city-dark.png) |
| **Overview:** All US KPIs with comparison to the previous period, a map with 53 city dots and a linked, sortable state table. | **City history (dark mode):** years → months → days, twin charts with a synced crosshair, and PNG/CSV download. |
| ![Forecast accuracy leaderboard and charts](docs/images/readme-accuracy.png) | ![Forecast page in dark mode: 7-day cards, 48-hour charts, model spread](docs/images/readme-forecast-dark.png) |
| **Accuracy:** the leaderboard by lead day, error vs lead time, bias by month, the best model per state and the biggest misses. | **Forecast:** 7-day NWS cards, the next 48 hours, a "Models disagree?" spread chart and active NWS alerts. |

Also included:
- Every filter is in the URL, so links can be shared and Back/Forward work.
- Keyboard-accessible map and charts.
- Light and dark themes that follow the system.
- Missing data always shows as a gap, never as 0.

## Architecture

```mermaid
flowchart LR
  subgraph Sources["Free public APIs"]
    NWS["NWS API<br/>forecasts + alerts"]
    OM["Open-Meteo<br/>history + 5 models"]
  end
  subgraph Cloud["Cloud collection (free tiers)"]
    GHA["AWS Lambda + EventBridge<br/>every 3 h / hourly"] --> ATLAS[("MongoDB Atlas M0<br/>7-day buffer")]
  end
  subgraph Local["Docker Compose (self-hosted)"]
    F["Stage 1<br/>fetchWeather.js"] --> M[("MongoDB<br/>raw")]
    M -->|"Stage 2<br/>incremental ETL"| CH[("ClickHouse<br/>warehouse + rollups")]
    CH -->|"Stage 3<br/>versioned cache"| R[("Redis")]
  end
  NWS --> GHA
  NWS --> F
  OM --> F
  ATLAS -->|sync-atlas| M
  R --> API["Stage 4<br/>Hono API + OpenAPI"]
  CH -.->|cache miss| API
  API --> UI["Stage 5<br/>React dashboard"]
  API -->|export:snapshot| SNAP["Static JSON snapshot"] --> VERCEL["Vercel demo"]
```

- **Stage 1** collects raw data with retries, rate limits and a weighted Open-Meteo call budget. NWS forecasts are also collected in the cloud, so the laptop can be off.
- **Stage 2** loads only new rows (watermark) into `ReplacingMergeTree` tables. Daily and monthly rollups use each city's local time.
- **Stage 3** puts a versioned cache in front of the warehouse. The landing page's queries are pre-warmed after each load.
- **Stage 4** serves the API: one Zod definition per route drives validation, the OpenAPI docs and the dashboard's TypeScript types.
- **Stage 5** is the dashboard: React + TypeScript, with hand-rolled d3 for the map and charts.

## AWS deployment (🚧 in progress, target: mid-October 2026)

> **Status: in progress.** The local Docker stack and the Vercel demo above are what runs today. Deployed on AWS so far
> (Free plan, us-east-2, one SAM stack in `infra/template.yaml`): SNS email alerts, a 30-day S3 raw archive, and a
> Lambda that collects NWS alerts (hourly) and forecasts (every 3 h) on EventBridge schedules into
> MongoDB Atlas + the archive, replacing the GitHub Actions schedules (GitHub skipped scheduled runs; the workflows stay as a manual fallback). The Atlas URI is an
> SSM SecureString read at cold start; the role is capped by a permissions boundary. Setup: [docs/SETUP_AWS.md](docs/SETUP_AWS.md).

```mermaid
flowchart LR
  EB["EventBridge Scheduler<br/>cron rules"] --> L["Lambda<br/>fetcher (Stage 1)"]
  NWS["NWS API"] --> L
  OM["Open-Meteo"] --> L
  L --> S3[("S3<br/>raw store")]
  S3 --> ETL["Lambda<br/>ETL + aggregates"]
  ETL --> DDB[("DynamoDB<br/>cache")]
  DDB --> API["Lambda<br/>Hono API"]
  L -->|failures, heat waves| SNS["SNS<br/>alerts"]
  CF["CloudFront<br/>dashboard (S3 origin)"] --> API
```

| Adapter interface | Current implementation | AWS version (in progress) |
|---|---|---|
| `RawStore` | MongoDB | S3 |
| `CacheStore` | Redis | DynamoDB |
| `Scheduler` | node-cron | EventBridge |
| `Notifier` | console | SNS |

The adapter design already allows the switch through `.env` (e.g. `RAW_STORE=s3`, `CACHE_STORE=dynamodb`); the AWS adapters are being built.

**All on the free tier:** Lambda (1 M requests / month), DynamoDB (25 GB), SNS (1 M publishes), CloudFront (1 TB transfer / month) and EventBridge Scheduler (14 M invocations / month) have always-free allowances; S3 stays at a few hundred MB with a retention rule. A **$1 AWS budget alert** is set before anything is deployed, and the limits are checked again at sign-up and recorded in the [roadmap](docs/ROADMAP.md).

## By the numbers

| | |
|---|---|
| Cities | **53** (the largest city in each state, plus DC and Stockton) |
| Rows loaded | **1.04 M** hourly observations, **1.82 M** forecast snapshots |
| Cache, warm p95 | **35.4 → 2.9 ms** (12× faster); cold p95 62.2 → 32.3 ms |
| API | ~1,600 req/s, p95 12.7 ms, 0 errors; 22/22 security probe checks |
| Tests | **107** Vitest tests (33 backend + 74 dashboard) and 18 checks on the demo build |
| Demo snapshot | 2.9 MB (418 KB gzipped) for 53 cities × 3+ years |
| Budget | **$0** |

## Built with Claude Code: compare & review

For each key feature, Claude Code built **3 implementations** on separate branches (`feature/<name>-v1..v3`). I compared them with measured numbers, merged the winner and fixed the security issues the comparison surfaced.

| Feature | Options compared | Winner | Why | Security issues caught | Report |
|---|---|---|---|---|---|
| Stage 3 caching | No cache · cache-aside · pre-warm + cache-aside | **Combined** (cache-aside + small pre-warm list + single-flight) | 12× faster warm p95 with the least code; landing page fast after each load | A Redis outage made requests hang (now fail fast); unbounded cache memory (now `maxmemory` + LRU) | [caching.md](docs/analysis/caching.md) |
| Stage 4 API layer | Express + Zod · Fastify + JSON Schema · Hono + zod-openapi | **Hono** | Same throughput; lowest memory, fewest dependencies, one definition per route | NoSQL operator injection via `?stage[$ne]=x` (qs parser); unknown params ignored or silently dropped; no CSP by default; Swagger UI loaded from a CDN without a pinned version | [api-layer.md](docs/analysis/api-layer.md) |
| Stage 5 US map | ECharts · react-simple-maps · d3-geo | **d3-geo** | Smallest (+47 KB), fastest, every state keyboard-accessible | ECharts tooltip built HTML strings from data (XSS risk); test hooks on `window` | [map-drilldown.md](docs/analysis/map-drilldown.md) |
| Stage 5 drill-down chart | ECharts · Recharts · d3-scale/d3-shape | **d3** | +10 KB vs +108 KB (Recharts), 185 ms render, full keyboard drill-down | HTML tooltip formatters avoided; the `window` hook was not merged; Recharts' larger dependency tree | [drilldown-chart.md](docs/analysis/drilldown-chart.md) |

## Security

- **SQL injection fixed:** a legacy endpoint pasted `?city=` into SQL with quote doubling, which a backslash bypasses in ClickHouse. All SQL now uses ClickHouse `query_params` (`{name:Type}`), and no user input is ever interpolated.
- **NoSQL operator injection blocked:** query strings are parsed as plain strings, and every route has a `.strict()` Zod schema, so `?x[$ne]=` and unknown parameters get a 400.
- **CSP everywhere:**
  - The API sends `default-src 'none'`.
  - The `/docs` page loads a pinned Swagger UI version.
  - The demo runs under a strict CSP with no `eval` (Zod runs "jitless").
  - React escapes all data, and nothing uses `dangerouslySetInnerHTML`.
- **Secret scanning:** `npm run check:secrets` must pass before every push. It checks:
  - the history and the working tree for secrets;
  - that `.env` is not tracked;
  - that every commit uses the noreply email;
  - that no untracked files are left over.
- **Least privilege:** databases and the API listen on `127.0.0.1`. Workflows have `contents: read`, secrets are set only on the steps that need them, and `npm ci --ignore-scripts` runs in CI.
- **Rate limiting and CORS** on the API, plus a 22-check black-box security probe (`npm run probe:api`).
- **A `/security-review` at the end of every stage**, with low findings logged in the [roadmap](docs/ROADMAP.md#known-limitations).

## Tech stack

| Layer | Tools |
|---|---|
| Collection | Node.js 18+ (ESM), NWS API, Open-Meteo, node-cron, AWS Lambda + EventBridge |
| Storage | MongoDB (raw), ClickHouse (warehouse), Redis (cache), MongoDB Atlas M0 (cloud buffer) |
| API | Hono, @hono/zod-openapi, Zod, Swagger UI |
| Dashboard | React 19, TypeScript, Vite, d3-geo / d3-scale / d3-shape, ECharts (sparklines), TanStack Query + Table, Zustand, Tailwind CSS, shadcn/ui |
| Quality | Vitest, React Testing Library, Playwright (demo checks, GIF), Docker Compose |
| Hosting | Vercel (static demo), GitHub Actions CI |

Each storage layer sits behind an adapter (`RawStore`, `CacheStore`, `Warehouse`, `Scheduler`, `Notifier`). A cloud service such as BigQuery or DynamoDB can be added as one new file.

## Run it locally

Requirements: Node.js 18+ and Docker Desktop.

```bash
npm install && (cd dashboard && npm install)
cp .env.example .env              # set NWS_USER_AGENT to your contact
docker compose up -d              # MongoDB, ClickHouse, Redis + fetcher (collects on a schedule)
npm run seed:locations            # 53 cities + NWS grid points

npm run fetch                     # Stage 1: APIs → MongoDB
npm run etl:clickhouse            # Stage 2: MongoDB → ClickHouse
npm run etl:redis                 # Stage 3: ClickHouse → Redis
npm start                         # Stage 4: API on http://127.0.0.1:3000 (docs at /docs)
cd dashboard && npm run dev       # Stage 5: dashboard on http://localhost:5173

npm test                          # backend tests (no Docker needed)
```

More: [cloud collection setup](docs/SETUP_CLOUD_COLLECTION.md), [Vercel demo](docs/DEPLOY_VERCEL.md), [roadmap](docs/ROADMAP.md).

## $0 budget: free-tier design

| Service | Free limit | Our use |
|---|---|---|
| Open-Meteo | 10,000 weighted calls / day (non-commercial) | ~2,400 / day, capped at 6,000 by our own budget ledger |
| NWS API | No published quota | ~106 requests / 3 h |
| MongoDB Atlas M0 | 512 MB | ~370 MB with a 7-day retention |
| Vercel Hobby | 100 GB transfer / month | ~0.5 MB per visit (static snapshot) |
| GitHub Actions | Free on public repos | CI (+ manual collection fallback) |
| MongoDB, ClickHouse, Redis | Self-hosted in Docker | Local disk only |

None of these needs a credit card. Every external service has its limits and overflow behavior documented in the [roadmap](docs/ROADMAP.md).

## How accuracy is measured

- **Error (MAE):** each hourly temperature forecast vs the temperature observed at that hour, averaged without the sign.
- **Bias:** the average of forecast − observed. Positive means the model runs too warm.
- **Lead day:** how many days before the forecast hour the model run was issued.
- **Converting to °F:** errors and biases are ×1.8, with no +32.
- **Baseline:** best-match is a lead-day-only baseline (its issue time is approximate). It is listed but not ranked, and left out of "biggest misses". Legacy snapshots are excluded.

## Known limitations

- Model accuracy covers ~Jul–Aug 2026 for the original 20 cities so far, because the backfill is still catching up. NWS joins the leaderboard once its forecasts can be matched with observations (~5-day lag).
- The 14 newest cities are still loading their 3-year history (they show as hollow dots on the map).
- The demo is a frozen snapshot. Some accuracy views exist only for all US over the last 90 days.
- Collection of Open-Meteo forecasts needs the local Docker stack running. NWS is collected in the cloud.

The full list is in the [roadmap](docs/ROADMAP.md#known-limitations).

## Credits

This project started from [Weather-Database-System](https://github.com/iDarshanaPatil/Weather-Database-System), a basic course project I built with Darshana Patil, Manu Mathew Jiss and Shradha Pujari at University of the Pacific. This version is a substantial rewrite and extension: multi-source US forecasts, forecast-accuracy analysis, a new API, caching, cloud collection and a React dashboard.

Weather data: [National Weather Service](https://www.weather.gov/documentation/services-web-api) and [Open-Meteo](https://open-meteo.com/) (CC BY 4.0). Map data: [us-atlas](https://github.com/topojson/us-atlas).

## License

[MIT](LICENSE) © 2026 Khoa Tran
