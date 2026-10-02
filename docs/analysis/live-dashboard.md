# Live dashboard without the laptop (Stage 6a part 4, design only)

Goal: the Vercel dashboard shows data that stays fresh while the local Docker stack is off. Today it shows a static
snapshot (`dashboard/public/data/`, ~3.1 MB raw / ~0.4 MB gzipped, 60 files) that `npm run export:snapshot` writes
from the local API and a git push deploys.

Constraints: AWS cost guard (CLAUDE.md), Free plan account until 2027-04-02, us-east-2, tag `Project=us-weather-pipeline`,
`npm run aws:teardown` removes everything. Free-tier numbers checked 2026-10-01 on the AWS pricing pages.

## What both designs share

| Data | How it gets to the cloud | Freshness |
|---|---|---|
| Daily history (53 cities + "All US") | **Daily Lambda** `history-updater` (EventBridge, 07:15 UTC): one Open-Meteo archive request per city for the last 7 days (the archive lags ~2–5 days, so each day re-fills the lag window), aggregates hourly → daily with the same functions as the local export (moved to a shared module `src/publish/`) | daily |
| One-time backfill (2023-01 → today) | **Local script** `npm run publish:backfill`: reads the local API like `export:snapshot` does, writes to the cloud store once | once |
| Forecasts (NWS + 4 Open-Meteo models) | NWS: the existing collector Lambda already fetches every 3 h; it also writes the published forecast. Open-Meteo models: a 6-hourly run in the same updater Lambda | 3–6 h |
| Alerts | The existing collector Lambda (hourly) also writes the published alerts | 1–3 h |
| Forecast accuracy | **Stays local** (needs ClickHouse forecast history). `npm run publish:accuracy` uploads `accuracy*.json` when the laptop is on; the dashboard shows "accuracy as of <date>" | when I run it |

Open-Meteo: +~110 weighted calls/day for history, +~1,270/day if the cloud also fetches model forecasts (local keeps
fetching them for accuracy) → ~3,800/day of 10,000 (38%). Risk: Lambda shares AWS IPs, so Open-Meteo's per-IP
limit can return 429; the handler logs it, sends SNS warn, and the next run fills the gap (7-day window).

Fallback for both: the dashboard keeps the bundled Vercel snapshot. If the cloud source fails (or the AWS account
closes at the end of the Free plan), it shows the bundled data with the current "Demo data as of" badge.

## A) DynamoDB + Lambda Function URL API

**Store.** One table `weather-dashboard`, **provisioned capacity** (the always-free 25 GB + 25 WCU + 25 RCU per region
applies only to provisioned mode, Standard table class; **on-demand is not in the always-free tier**). Set 5 RCU /
5 WCU, no auto scaling (it creates CloudWatch alarms). Items:

| PK | SK | Content |
|---|---|---|
| `DAILY#<city>` | `<yyyy-mm>` | that month's daily min/max/avg/precip/n arrays (~1–3 KB) |
| `FORECAST#<city>` | `latest` | hours per model (~10 KB; the 498 KB file is split per city, item limit 400 KB) |
| `ALERTS` / `ACCURACY#<range>` / `META` | `latest` | alerts, accuracy, data-as-of |

~2,500 items, ~10 MB. Backfill at 5 WCU ≈ 15 min with 3 KB items (raise to 20 WCU during the backfill, then lower).

**API.** Lambda `dashboard-api` (128 MB, 5 s timeout, Node 22) behind a **Function URL** (`AuthType NONE`). Routes
return the same shapes as today's snapshot files, so `dashboard/src/lib/snapshot.ts` only needs a base URL:
`/manifest`, `/locations`, `/daily/<city>?from&to` (Query by month), `/forecasts/<city>`, `/alerts`, `/accuracy`.
Function URL CORS: `AllowOrigins = https://<project>.vercel.app` only, `GET` only. `Cache-Control: public,
max-age=300` (history: 3600), gzipped body. IAM: `dynamodb:GetItem/Query` on this table only; writers get `PutItem/UpdateItem`.

**Reserved concurrency** (e.g. 2) caps abuse. Catch: new accounts often have an account limit of 10 and AWS requires
10 unreserved, which blocks any reservation. Check `aws lambda get-account-settings`; if 10, request a free quota
increase, or ship without it (provisioned DynamoDB throttles instead of billing, and Lambda's 1 M free requests absorb a lot).

**CSP:** `connect-src 'self' https://<id>.lambda-url.us-east-2.on.aws`.

## B) Scheduled Lambda writes the snapshot JSON to S3, served by CloudFront

**Files.** The same format as today with two changes so each run uploads only what changed:
- Per-city history files `daily-<city>.json` cover up to the end of last month (rewritten monthly), plus one
  `recent.json` with the current month for all cities (rewritten daily). The dashboard merges them.
- Mutable files (`recent.json`, `forecasts.json`, `alerts.json`, `manifest.json`) keep fixed names with
  `Cache-Control: max-age=300`; monthly files are content-hashed and `immutable`. A lifecycle rule expires old
  hashed files after 30 days.

**Writers.** `history-updater` (daily: GET `recent.json`, append, PUT it + `daily-all.json` + `manifest.json`;
on the 1st also roll the month into the 53 city files), the collector (alerts/NWS forecast), and the local
`publish:accuracy`. Runtime role: `s3:GetObject/PutObject` on prefix `dashboard/*` only. The export's `FORBIDDEN`
check (no hostnames, connection strings, run ids) runs before every upload.

**Serving.** New private bucket (or prefix in the existing one), Block Public Access, SSE-S3, HTTPS only, readable
**only by the CloudFront distribution via Origin Access Control**. CloudFront: default `*.cloudfront.net`
certificate, compression on, response headers policy with CORS for the Vercel origin + `nosniff`. Prefer the
**flat-rate Free plan** ($0, 1 M requests + 100 GB/month, no overage charges) if it can be attached to this
distribution on our account (verify at setup); otherwise pay-as-you-go with the always-free 1 TB + 10 M requests.

**CSP:** `connect-src 'self' https://<dist>.cloudfront.net`. (Alternative without CSP/CORS changes: a Vercel
rewrite `/live/*` → CloudFront; costs Vercel bandwidth instead.)

## Free-tier usage (assumes 100 visits/day, ~10 requests per visit)

| Service | Free limit | A: expected / month | B: expected / month |
|---|---|---|---|
| DynamoDB (provisioned) | always free: 25 GB, 25 RCU, 25 WCU | 10 MB; 5 RCU / 5 WCU reserved (20%) | — |
| Lambda requests | always free: 1 M + 400,000 GB-s | API ~30k + updater ~150 (3%); ~1,000 GB-s | updater ~150; ~1,500 GB-s |
| Lambda Function URL | no extra charge (Lambda pricing) | included above | — |
| S3 PUT | 12-month: 2,000 / month, **shared with the raw archive (1,140)** | ~10 (backfill only, accuracy) | ~400 (daily 90, 6-hourly forecasts/alerts 240, monthly 60, accuracy ~10) → 1,540 (77%); cut archive alerts to every 3 h (-640) → ~900 (45%) |
| S3 GET | 12-month: 20,000 / month | — | CloudFront misses + updater: ~3,000 (15%) |
| S3 storage | 12-month: 5 GB | — | < 10 MB |
| CloudFront | Free plan: 1 M req + 100 GB; or always free 1 TB + 10 M req | — | 30k req (3%), ~1.2 GB (1%) |
| Data transfer out | always free 100 GB / month (all services) | ~1 GB (1%) | via CloudFront (S3 → CloudFront is free) |
| EventBridge schedules | free | +2 rules | +2 rules |
| CloudWatch Logs | 5 GB, 7-day retention | +~20 MB | +~5 MB |
| Open-Meteo | 10,000 weighted / day | ~3,800 (38%) | same |

When exceeded: Free plan pays from credits (never billed); DynamoDB provisioned throttles instead; the CloudFront
Free plan has no overage charges.

## Comparison

| | A: DynamoDB + Function URL | B: S3 + CloudFront static files |
|---|---|---|
| New AWS resources | table, API Lambda + URL, updater Lambda, 2 log groups | bucket (or prefix), CloudFront + OAC, updater Lambda, log group |
| Request path | browser → Lambda → DynamoDB (cold start ~300 ms) | browser → CDN edge (cached, ~20–50 ms) |
| Traffic spike / abuse | each request runs code; capped by concurrency + RCU | nothing runs per request; CDN absorbs it |
| Attack surface | public unauthenticated API: input validation, rate cap, error handling, CORS (not access control) | read-only static files; only the writer roles can change data |
| Dashboard change | base URL + small route mapping | base URL + merge `recent.json` |
| Tight limit | reserved concurrency may be blocked (account limit 10) | S3 PUTs shared with the archive (fix: lower archive cadence) |
| Effort | ~4–5 days (table model, API, updater, backfill, tests) | ~2–3 days (updater, publisher, CloudFront in SAM, tests) |
| Resume value | higher on paper: "DynamoDB single-table design, serverless REST API" | good: "static data publishing on S3 + CloudFront (OAC, immutable hashed caching), $0 at any traffic" |
| Extensibility | easy to add query-style endpoints later | new views need new pre-built files |

## Recommendation: B

B is less work and has no code running on the request path, so nothing to rate-limit, nothing to cold-start and no
public API to secure. It reuses the snapshot format the dashboard already reads. Its one tight spot (S3 PUTs) can be
fixed by lowering the archive's alerts cadence. A has more resume value, but it adds a public API whose only job is
to serve the same files. That API could be added later on top of B's data if a query-style endpoint is ever needed.

**Decision (2026-10-01): B.** The raw archive stores NWS alerts every 3 h instead of hourly, so S3 PUTs stay at
~900 / month (~45% of 2,000). Not built yet.
