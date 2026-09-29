# CLAUDE.md

US weather data pipeline (portfolio project). Plan and progress: `docs/ROADMAP.md` — tick items off there as they are finished.

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

Free-tier limits of the services in use, and cost follow-ups: `docs/ROADMAP.md`.

## Flow (keep these script names)

```
fetchWeather.js      APIs (NWS, Open-Meteo) → MongoDB      Stage 1
etlToClickHouse.js   MongoDB → ClickHouse                  Stage 2
clickhouseToRedis.js ClickHouse → Redis                    Stage 3
backend/             Express API (reads Redis, falls back to ClickHouse)   Stage 4
dashboard/           UI (to be rebuilt with Vue 3 + ECharts)               Stage 5
```

Every stage loops over the `locations` collection/table; nothing is hard-coded to one city.

## Commands

```bash
docker compose up -d        # MongoDB :27017, ClickHouse :8123, Redis :6379
npm install
npm run seed:locations      # upsert cities + resolve NWS grid points
npm run fetch               # Stage 1 (all modes); see `node fetchWeather.js --help`
npm run fetch:watch         # Stage 1 on a schedule (forecasts every 3h, alerts every 15m)
npm run etl:clickhouse      # Stage 2
npm run etl:redis           # Stage 3
npm start                   # API + dashboard on :3000
```

## Conventions

- **ESM only** (`import`/`export`, `"type": "module"`). **Node 18+** (uses global `fetch`).
- **Config:** read environment variables only in `src/config.js`. Every variable must be listed in `.env.example`.
- **Adapter rule:** never import `mongodb`, `redis`, `node-cron`, or a notification SDK directly in pipeline or API code.
  Go through `src/adapters/` (`RawStore`, `CacheStore`, `Scheduler`, `Notifier`). The implementation is picked by
  `.env` (`RAW_STORE=mongo`, `CACHE_STORE=redis`, …) so AWS versions (S3, DynamoDB, EventBridge, SNS) can be added later
  as one new file per adapter.
- **No string-built SQL.** Pass values with ClickHouse `query_params` (`{name:Type}` placeholders). Never interpolate
  user input into a query string.
- **Idempotent writes.** Every collection/table has a natural unique key; use upserts / `ReplacingMergeTree`.
  Re-running a stage must not create duplicates.
- **Nulls stay null.** Missing measurements are `null`, never `0`.
- **Times are UTC** in storage (`Date` in Mongo, `DateTime('UTC')` in ClickHouse). Convert to local time only for display.
- **Always close clients** in `finally` blocks.
- External HTTP goes through `src/lib/http.js` (retry with backoff, rate limit, `User-Agent` header).
- No team/author names in code or data; use `PIPELINE_NAME` for pipeline identity.
- Small commits with clear messages.
