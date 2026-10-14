# Live publishing: publisher Lambda, S3 and CloudFront

Rebuild steps: [SETUP_AWS.md](../SETUP_AWS.md) (steps 9 and 11). Design comparison:
[analysis/live-dashboard.md](../analysis/live-dashboard.md).

## Purpose

Keep the public dashboard current while the laptop is off. A scheduled Lambda writes recent history, forecasts,
alerts and pipeline status as static JSON files to a private S3 bucket, and CloudFront serves them. The same bucket
also holds the 30-day raw archive.

## Requirements

- No code runs per page view: nothing to rate-limit, secure or cold-start on the request path.
- The bucket stays private, with Block Public Access fully on; only the live-files prefix is readable, and only
  through CloudFront.
- Nothing internal (hosts, connection strings, run ids) may reach a public file.
- Stay inside the S3 free tier (2,000 PUTs a month, shared with the raw archive) and the CloudFront free tier.

## Design

- **Schedules.** Two EventBridge rules run `weather-pipeline-dashboard-publisher` after the collector:
  - `cron(35 6 * * ? *)`: history, forecasts and alerts, once a day;
  - `cron(35 0,3,9,12,15,18,21 * * ? *)`: forecasts and alerts.

  Together that is one run every 3 hours, 8 a day.
- **Function.** Node.js 22 on arm64, 256 MB, 240 s timeout, no VPC. It reads NWS data from Atlas and fetches Open-Meteo
  itself, with its own Open-Meteo ledger (1,000 an hour, 2,000 a day) because Lambda IPs are not the laptop's.
- **Files** under `dashboard/` in the bucket:

  | File | Content | `Cache-Control` |
  |---|---|---|
  | `recent.json` | last 60 days of daily temperature and precipitation per city + All US (Open-Meteo archive) | `max-age=900, s-maxage=10800` |
  | `forecasts.json` | latest hourly forecast per model (NWS from Atlas, 4 Open-Meteo models) + NWS day/night periods | `max-age=300, s-maxage=1800` |
  | `alerts.json` | active NWS alerts from Atlas (at most 200) | `max-age=300, s-maxage=1800` |
  | `status.json` | job health, freshness and incidents of the last 7 days for the Ops page, from `pipeline_runs` | `max-age=300, s-maxage=1800` |

  CloudFront keeps a file for at most about 1/6 of the time until the next upload, so no invalidations are needed.
  `status.json` is written last in every run so it reports that run's files.
- **Bucket.** `weather-pipeline-raw-<account>`: Block Public Access on, ACLs disabled, SSE-S3, HTTPS-only bucket
  policy, versioning off, a lifecycle rule that deletes objects after 30 days. The raw archive (`nws-*/`,
  `open-meteo-*/`) lives in the same bucket, see [ingestion](ingestion.md) and [NWS collector](nws-collector.md).
- **CloudFront.** Origin path `/dashboard`, Origin Access Control (SigV4, always signed), `https-only`, GET/HEAD,
  compression, the managed `CachingOptimized` policy, PriceClass_100, the default `*.cloudfront.net` certificate,
  HTTP/2 and HTTP/3. A custom response headers policy sets CORS for the dashboard origin and the two local Vite ports
  only, plus `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and HSTS.
- **Run log.** Each run is recorded in Atlas `pipeline_runs` (stage `publish`, mode `dashboard`), which feeds
  `status.json` and the Ops page.

## Alternatives considered

See [decision 6](../DESIGN_DECISIONS.md#6-the-public-site-reads-static-json-from-s3--cloudfront-not-a-live-api): a
DynamoDB table behind a Lambda Function URL API (design A in [analysis/live-dashboard.md](../analysis/live-dashboard.md)),
which means a public, unauthenticated API to secure.

## Failure handling

- **The handler never throws**, and `MaximumRetryAttempts: 0` means no retry after a function error (a retry would
  spend the PUT caps twice). Throttled events wait in the async queue for up to 50 minutes; EventBridge retries a failed
  hand-off up to 4 times.
- **Per-file isolation.** Each part is built and uploaded on its own. If some files fail the run is `partial`; if no
  data file went up it is `failed`. Either way the owner gets one SNS email listing the failures.
- **Safety check before upload.** Every file passes the `FORBIDDEN` pattern check (hosts, connection strings,
  passwords, run ids); `status.json` is also rebuilt from a whitelist and scanned for leaks. A match throws and
  nothing is uploaded.
- **Caps.** PUTs are reserved on a daily ledger in Atlas before each upload: 17 a day for the data files and 10 a day
  for `status.json`. Past a cap the upload is skipped and reported.
- **Run record** writes are best effort: a failing record never stops publishing.
- **On the site.** If CloudFront fails, times out (4 s) or returns something that doesn't validate, the dashboard
  keeps its bundled snapshot (see [dashboard](dashboard.md)).

## Security

- **Role** (with the permissions boundary): `ssm:GetParameter` on the Atlas parameter, `s3:PutObject` on
  `dashboard/*` only (no read, list or delete), `sns:Publish` on the owner topic, and its own logs.
- **Bucket policy:** `s3:GetObject` on `dashboard/*` only for this distribution (`AWS:SourceArn`); every other prefix
  returns 403 through CloudFront. Non-HTTPS requests are denied.
- **No extras that widen exposure:** no WAF, custom domain, access logs, Lambda@Edge or CloudFront Functions.

## Numbers

| Number | Source |
|---|---|
| 8 runs a day | `infra/template.yaml` (the two dashboard schedules) |
| PUT caps: 17 a day for data files, 10 a day for `status.json` | `infra/template.yaml` (`DASHBOARD_MAX_PUTS_PER_DAY`), `src/lambda/dashboardPublisher.js` (`STATUS_MAX_PUTS_PER_DAY`) |
| S3: ~1,410 PUTs a month expected for the whole account (~71% of 2,000; ≤ 82% by the hard caps); ~175 MB stored | [README.md](../../README.md), AWS deployment table |
| CloudFront: about 3% of the free requests (30,000 a month at 100 visits a day) | [analysis/live-dashboard.md](../analysis/live-dashboard.md) |
| S3 GETs from CloudFront misses: ~3,000 a month (15% of 20,000) | [SETUP_AWS.md](../SETUP_AWS.md), S3 PUT budget section |

## Where in the code

| What | File |
|---|---|
| Publisher Lambda | `src/lambda/dashboardPublisher.js` |
| File formats, `FORBIDDEN` check | `src/publish/snapshotFormat.js` |
| `status.json` builder and leak scan | `src/publish/opsStatus.js` |
| All-US average | `src/publish/usAverage.js` |
| Function, bucket, OAC, distribution, headers policy | `infra/template.yaml` (`DashboardPublisher*`, `RawArchiveBucket*`, `Dashboard*`) |
| Tests | `tests/dashboardPublisher.test.js`, `tests/opsStatus.test.js` |
