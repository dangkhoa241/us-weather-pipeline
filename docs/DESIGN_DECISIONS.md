# Design decisions

The 10 decisions that shaped this project. Each one gives the context, the alternatives I considered, the trade-off I
accepted, and one measured number with the file it comes from. The README has a short summary. The interactive
diagram is at [/how-it-works](https://us-weather-pipeline.vercel.app/how-it-works).

How the decisions were made: I designed the product and its features, and Claude Code implemented them under my
direction. For each key feature it built 3 implementations on separate branches, and I compared them with measured
numbers before merging the winner (the compare-3-and-review process from my earlier ExpenseTracker project).

---

## 1. A $0 budget: free tiers only

- **Decision:** only free tools, free APIs and free tiers. The data stack is self-hosted in Docker, and AWS runs only
  inside the Free plan.
- **Context:** this is a personal portfolio project. Nothing may need a paid plan or a credit card to keep working.
- **Alternatives considered:**
  - managed services: ClickHouse Cloud (trial only), paid EC2 or RDS;
  - an always-free VM: Oracle Cloud Always Free requires a credit card to sign up.
- **Trade-off:** the warehouse, cache and API live on a laptop, so Open-Meteo collection and ETL run only while the
  laptop is on. Every service needs its own usage caps so it can never outgrow its free tier.
- **Evidence:** the NWS collector uses about **2% of Lambda's free GB-seconds** (~6,800 of 400,000 a month), with
  $0.00 billed. Source: [ROADMAP.md](ROADMAP.md), free-tier table.

## 2. Collect NWS data in the cloud, buffer it in Atlas, keep the rest local

- **Decision:**
  - a scheduled Lambda (EventBridge) collects NWS forecasts and alerts into a free MongoDB Atlas cluster that keeps 7 days;
  - the local stack copies the data home (`sync-atlas`) whenever the laptop is on.
- **Context:** NWS forecasts and alerts can only be collected live; a missed run is lost for good. The rest of the
  pipeline can wait until the laptop is on.
- **Alternatives considered:**
  - GitHub Actions cron, which was the first cloud collector and is now a manual-only fallback;
  - collecting only on the laptop;
  - moving the whole pipeline to the cloud, which the free tiers can't hold: Atlas M0 has 512 MB and ClickHouse Cloud is
    trial only.
- **Trade-off:** two copies of the NWS data, and a sync step. The laptop can be off for up to a week without losing
  data, but not longer.
- **Evidence:**
  - GitHub Actions cron runs started 10–30+ minutes late or were skipped: on the first night, 5 of ~7 forecast runs and
    4 of ~20 alert runs happened. EventBridge now starts the Lambda on schedule. Source: [ROADMAP.md](ROADMAP.md),
    known limitations.
  - The 7-day buffer uses ~370 MB of Atlas's 512 MB (72%). Source: [ROADMAP.md](ROADMAP.md), free-tier table.

## 3. ClickHouse as the warehouse, with incremental, idempotent loads

- **Decision:** raw documents in MongoDB, analytics in ClickHouse.
  - `ReplacingMergeTree` tables, so re-running a load never creates duplicates;
  - a watermark, so each ETL run loads only new rows;
  - daily and monthly rollups in each city's local time.
- **Context:** the dashboard aggregates years of hourly data per city, state and period. The original course project
  loaded everything on every run and stored nulls as 0.
- **Alternatives considered:**
  - querying MongoDB directly;
  - BigQuery's free tier, kept as a later adapter: its sandbox expires tables after 60 days;
  - ClickHouse Cloud: trial only.
- **Trade-off:** ClickHouse is self-hosted, so the warehouse is not reachable from the public site. That is why the
  public site reads static files (decision 6).
- **Evidence:** as of 2026-10-09, **1.75 M** hourly observations (53 cities, from 2023-01-01) and **3.42 M** forecast
  snapshots are loaded incrementally. Source: [README.md](../README.md), "By the numbers".

## 4. Redis cache: versioned cache-aside plus a small pre-warm list

- **Decision:**
  - read-through cache with versioned keys, so one pointer switch invalidates everything after a load;
  - only the national queries are pre-warmed;
  - single-flight, so a burst of identical misses runs only one warehouse query.
- **Context:** the same dashboard queries repeat on every visit, and the landing page should be fast right after each
  data load.
- **Alternatives considered:** no cache; pure cache-aside; pre-warming everything (3 branches compared).
- **Trade-off:**
  - a cold query still goes to ClickHouse, and the pre-warm list is one more thing to maintain;
  - it now fails fast when Redis is down: the comparison found that a down Redis made requests hang.
- **Evidence:**
  - warm p95 **35.4 → 2.9 ms** (12× faster), and cold p95 62.2 → 32.3 ms;
  - **373 KB** of Redis, against 3.2 MB for pre-warming everything.
  - Source: [analysis/caching.md](analysis/caching.md).

## 5. Hono + zod-openapi for the API

- **Decision:** Hono with one Zod definition per route. That definition drives request validation, the OpenAPI docs
  and the dashboard's TypeScript types.
- **Context:** the API needed strict input validation (a legacy endpoint had SQL injection, and the Express branch
  of the comparison allowed NoSQL operator injection), docs, and types the dashboard can share.
- **Alternatives considered:** Express + Zod; Fastify + JSON Schema (3 branches compared).
- **Trade-off:** a smaller ecosystem than Express. Throughput was a tie, so the choice rests on memory, dependencies
  and code size.
- **Evidence:**
  - peak memory **~150 MB** against up to 282 MB (Fastify);
  - **116** packages against 168–174;
  - **1,617 requests/s** at p95 **12.7 ms** after the merge (10 connections, 15 s, 0 errors; measured 2026-09-30 with
    `node scripts/loadTestApi.js final`, data in `analysis/data/api-final-load.json`).
  - Source: [analysis/api-layer.md](analysis/api-layer.md).

## 6. The public site reads static JSON from S3 + CloudFront, not a live API

- **Decision:** the dashboard on Vercel ships a data snapshot, exported from the local API when I redeploy. Every
  3 hours, a scheduled publisher Lambda writes fresh forecasts, alerts, pipeline status and recent history as JSON to
  S3, and CloudFront serves those files.
- **Context:** the warehouse is local (decision 3), but the site should show current data when the laptop is off.
- **Alternatives considered:** a DynamoDB table behind a Lambda Function URL API, compared in
  [analysis/live-dashboard.md](analysis/live-dashboard.md). That design has more resume value on paper but means a
  public, unauthenticated API to secure.
- **Trade-off:**
  - small attack surface: static files only, no code runs per page view, nothing to rate-limit or cold-start;
  - the live data is up to 3 hours old;
  - forecast accuracy stays as of the bundled snapshot;
  - new views need new pre-built files.
- **Evidence:** CloudFront is expected to use about **3%** of its free requests (30,000 a month at 100 visits a day).
  Source: [analysis/live-dashboard.md](analysis/live-dashboard.md).

## 7. Hand-rolled d3 for the map and charts

- **Decision:** the US map is drawn with d3-geo, and the drill-down charts with d3-scale and d3-shape. ECharts stays
  only for the small sparklines.
- **Context:** every state and chart point had to be keyboard-accessible, and the bundle had to stay small.
- **Alternatives considered:**
  - for the map: ECharts and react-simple-maps;
  - for the charts: ECharts and Recharts (3 branches each).
- **Trade-off:** more of my own chart code to maintain. In return there are no library tooltips that build HTML from
  data: the ECharts version's tooltip was an XSS risk.
- **Evidence:**
  - map **+47 KB** gzipped, against +71 KB and +83 KB;
  - drill-down chart **+10 KB**, against +17 KB (ECharts) and +108 KB (Recharts).
  - Sources: [analysis/map-drilldown.md](analysis/map-drilldown.md), [analysis/drilldown-chart.md](analysis/drilldown-chart.md).

## 8. Every external service sits behind an adapter chosen by `.env`

- **Decision:** pipeline and API code never import a database or cloud SDK directly. They go through
  small interfaces (`RawStore`, `CacheStore`, `Warehouse`, `Scheduler`, `Notifier`, `CounterStore`), and `.env` picks
  the implementation.
- **Context:** the project started local-only and moved parts to AWS later. Each move had to be one new file, not a
  rewrite.
- **Alternatives considered:** calling the SDKs directly, which is less code at first.
- **Trade-off:** an extra layer, and each interface has to stay small enough to implement twice.
- **Evidence:** the AWS implementations each arrived as a new adapter file: SNS notifier, S3 archive copy and DynamoDB
  counter store. EventBridge replaced the scheduler for NWS collection through infrastructure-as-code. That makes
  **4 of the 6** interfaces with a deployed AWS counterpart (`CacheStore` and `Warehouse` have none). Source:
  [README.md](../README.md), adapter table.

## 9. Alert emails: only on a real change, on separate topics, with a hard cap

- **Decision:**
  - an email goes out only when an alert is new for a city, upgraded (higher severity or product), or extended
    (a later end time);
  - public subscriber emails use their own SNS topic, apart from the owner's pipeline emails;
  - a counter in DynamoDB stops them at 900 a month;
  - sign-ups are protected by Cloudflare Turnstile and rate limits.
- **Context:** NWS re-issues alerts about daily with new ids and usually nothing changed, so emailing every new id
  floods inboxes. The SNS free tier is 1,000 emails a month, shared by both topics.
- **Alternatives considered:**
  - emailing every new alert id, which was the first version;
  - for the counters, compared in [analysis/email-signups.md](analysis/email-signups.md): MongoDB Atlas (the public
    function would hold the database credentials), Upstash Redis (an extra provider), or in-memory counters (lost on a
    cold start).
- **Trade-off:**
  - a re-issue that changes nothing sends nothing;
  - once 900 emails are used, subscriber emails pause until the next month (the owner is told once).
- **Evidence:** replaying the 17 stored heat alerts from 2026-09-30 to 10-07 gives **5 emails instead of 17**. Source:
  [ROADMAP.md](ROADMAP.md), heat-alert fatigue fix.

## 10. Rank a forecast model only after 30 days of scores

- **Decision:** the accuracy leaderboard ranks a model only after 30 days of scores (and 100 forecast–observation
  pairs) at the selected lead day. A newer model gets a head-to-head comparison on the city-hours both were scored on.
- **Context:** a few days of scores can make a model look better or worse than it is. NWS forecasts have been scored
  only since 2026-09-29.
- **Alternatives considered:** ranking every model from day one; hiding new models until they qualify.
- **Trade-off:** NWS, the official forecast, isn't ranked yet. The head-to-head note shows how it compares without
  claiming a rank.
- **Evidence:** as of 2026-10-09, NWS had **11** scored days, under the 30 needed. On the **3,224** city-hours both
  were scored on, ECMWF missed by 1.58 °F and NWS by 1.94 °F. Source: [ROADMAP.md](ROADMAP.md), resume numbers.

---

## Left out (no verifiable number)

These shaped the product, but I have no measured number for them, so they are design choices rather than decisions
with evidence:
- the linked map and state table;
- twin temperature and rain charts;
- charts only after a city is clicked;
- the period filters;
- the largest city in each state, plus DC, Stockton, Miami, San Francisco and San Jose.

They are listed in the README's Features section.
