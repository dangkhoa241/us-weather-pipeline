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

## AWS cost guard (follow in every AWS task)

The AWS account is on the **Free plan** (until 2027-04-02; setup: `docs/SETUP_AWS.md`).
- Never suggest or require upgrading to a paid plan. If a service needs a paid plan, stop and ask me.
- Never use: NAT Gateway, EC2, public IPv4/Elastic IPs, Load Balancers, RDS, KMS customer-managed keys,
  Secrets Manager, CloudWatch custom metrics beyond the free 10, or anything without a free tier.
- Use: S3 with SSE-S3 encryption + lifecycle rule; SSM Parameter Store (standard) for config;
  CloudWatch log retention 7 days; Lambda memory 128–256 MB with short timeouts; EventBridge rules at most hourly.
- Tag every resource `Project=us-weather-pipeline`. `npm run aws:teardown` (sam delete) removes everything.
- Before every `sam deploy`, list the resources it will create with their free-tier limits and expected monthly
  usage, and wait for my OK.
- Windows / Git Bash: prefix AWS CLI commands that take `/aws/...` paths with `MSYS_NO_PATHCONV=1` (otherwise Git Bash
  rewrites them to `C:/Program Files/Git/...` and AWS answers a misleading AccessDenied), and force UTF-8 output with
  `PYTHONIOENCODING=utf-8` (log lines with "→" crash the CLI otherwise). Details: `docs/SETUP_AWS.md`.

## Flow (keep these script names)

```
fetchWeather.js      APIs (NWS, Open-Meteo) → MongoDB      Stage 1
etlToClickHouse.js   MongoDB → ClickHouse                  Stage 2
clickhouseToRedis.js ClickHouse → Redis                    Stage 3
backend/             Hono API (reads Redis, falls back to ClickHouse)      Stage 4
dashboard/           UI (to be rebuilt with React, see below)               Stage 5
```

Every stage loops over the `locations` collection/table; nothing is hard-coded to one city.

Stage 5 dashboard stack (not built yet): React + TypeScript + Vite, echarts-for-react, TanStack Query,
TanStack Table, Zustand (filters synced to the URL), Tailwind CSS + shadcn/ui. All free / open source.

## Commands

```bash
docker compose up -d        # MongoDB :27017, ClickHouse :8123, Redis :6379, fetcher (Stage 1 watcher)
docker compose logs -f fetcher   # watcher logs; `docker compose up -d --build fetcher` after code changes
npm install
npm run seed:locations      # upsert cities + resolve NWS grid points
npm run fetch               # Stage 1 (all modes); see `node fetchWeather.js --help`
npm run fetch:watch         # Stage 1 watcher outside Docker (don't run it while the fetcher container runs)
npm run sync:atlas          # copy NWS data collected by GitHub Actions on Atlas (setup: docs/SETUP_CLOUD_COLLECTION.md)
npm run check:secrets       # pre-push check: secrets in history/working tree, tracked .env, commit emails
npm run etl:clickhouse      # Stage 2
npm run etl:redis           # Stage 3
npm start                   # API on 127.0.0.1:3000 (OpenAPI docs at /docs)
npm test                    # Vitest unit tests (cache + API; no Docker needed)
```

## Conventions

- **Good enough beats perfect.** This is a personal project. Don't investigate small data-accuracy details, edge cases
  or proofs unless they break something visible. Note them in `docs/ROADMAP.md` under "Known limitations" and move on.
  Time-box any investigation to ~15 minutes, then pick the simple option and tell me.
- **ESM only** (`import`/`export`, `"type": "module"`). **Node 18+** (uses global `fetch`).
- **Config:** read environment variables only in `src/config.js`. Every variable must be listed in `.env.example`.
- **Adapter rule:** never import `mongodb`, `redis`, `@clickhouse/client`, `node-cron`, or a notification SDK directly in
  pipeline or API code. Go through `src/adapters/` (`RawStore`, `CacheStore`, `Warehouse`, `Scheduler`, `Notifier`).
  The implementation is picked by `.env` (`RAW_STORE=mongo`, `CACHE_STORE=redis`, `WAREHOUSE=clickhouse`, …) so cloud versions (S3, DynamoDB,
  BigQuery, EventBridge, SNS) can be added later as one new file per adapter. All SQL (table creation, inserts, queries,
  the period builder) lives inside the warehouse adapter, e.g. `src/adapters/warehouse/clickhouseWarehouse.js`.
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

## Compare & review (key features only)

Key features: Stage 3 caching, Stage 4 API layer, Stage 5 map/drill-down.

1. Build 3 implementations in parallel branches `feature/<name>-v1`, `-v2`, `-v3` (one git worktree each).
2. Write `docs/analysis/<feature>.md` comparing the versions on: files changed, architecture, complexity, error handling,
   security considerations, performance (measured numbers), extensibility. End with a summary table and an
   "adopt or combine" decision.
3. Merge the winner, fix the security issues the comparison surfaced, and add Vitest unit tests for the chosen version.
4. Run `/security-review` and `npm run check:secrets` before pushing.

Everything else: good enough beats perfect (one simple implementation).

## Git workflow

Public repository: <https://github.com/dangkhoa241/us-weather-pipeline>. At the end of each stage, and at least once a day:

1. Run the tests, if there are any (`npm test`).
2. Update `docs/ROADMAP.md` (tick finished items, add known limitations).
3. Commit (small commits, clear messages).
4. Run the secret check: `npm run check:secrets` (history + working tree, `.env` not tracked, noreply email on every commit).
   Push only when it passes, and look at any untracked files it lists (a bare password in a text file has no pattern).
5. `git push`.

Never push `.env` (or any file with real credentials), and never force-push `main`.
