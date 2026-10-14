# NWS collector (Lambda + EventBridge + Atlas buffer)

Rebuild steps: [SETUP_AWS.md](../SETUP_AWS.md) (step 10) and [SETUP_CLOUD_COLLECTION.md](../SETUP_CLOUD_COLLECTION.md).

## Purpose

Collect National Weather Service (NWS) forecasts and active alerts on a fixed schedule, whether or not the laptop
is on. NWS data can only be collected live: the API serves the current forecast and the current alerts, so a missed
run is lost for good. The collector stores what it fetches in a free MongoDB Atlas cluster, which works as a 7-day
buffer, and the local stack copies the buffer home with `sync-atlas`.

## Requirements

- Run on time: alerts every hour, forecasts every 3 hours, for all 53 tracked cities.
- Keep running while the laptop is off: up to 7 days with no action (the Atlas buffer), up to 30 days with a restore
  from the S3 raw archive.
- Stay inside the AWS Free plan and the Atlas M0 free tier (512 MB), with no VPC and so no NAT Gateway.
- Send the NWS API a `User-Agent` with a contact, as NWS requires.
- Never send the same failure email twice for one run.
- Write idempotently: re-running a collection must not create duplicates.

## Design

```
EventBridge rule (cron) ──► Lambda weather-pipeline-nws-collector ──► NWS API
                                   │
                                   ├─► MongoDB Atlas M0 (forecast_snapshots, alerts, pipeline_runs; 7-day TTL)
                                   ├─► S3 raw archive (nws-forecast/, nws-alerts/; 30-day lifecycle)
                                   ├─► SNS owner topic (failures, new heat alerts)
                                   └─► SNS subscriber topic (alerts mode only; see alerts-and-signups.md)

Laptop (when on): fetcher container ── sync-atlas ──► local MongoDB raw store
```

- **Schedules.** Two EventBridge rules invoke one function with a mode in the event:
  `cron(23 * * * ? *)` with `{"mode":"alerts"}`, and `cron(7 0/3 * * ? *)` with `{"mode":"forecast"}`.
- **Function.** Node.js 22 on arm64, 256 MB, 300 s timeout, no VPC, bundled with esbuild (AWS SDK v3 left external
  because the runtime ships it).
- **One code path with the local fetcher.** The handler calls the same `runMode()` as `fetchWeather.js`, so the
  Lambda and the laptop share the NWS parsing, the run log (`pipeline_runs`) and the partial-run rules.
- **Forecasts.** For each city, two NWS endpoints: hourly (1-hour periods, ~7 days) and 12-hour day/night periods.
  Each period becomes one `forecast_snapshots` document keyed by
  `(location_id, model, kind, issued_at, target_time)`, so the history of forecasts is kept for accuracy scoring.
- **Alerts.** One request to `/alerts/active`. Each alert is upserted by its NWS id and linked to tracked cities
  through its forecast zones and counties.
- **Buffer and retention.** The function runs with `RAW_RETENTION_DAYS=7`. Collections with a retention field get a
  TTL index, so Atlas deletes documents after 7 days.
- **Raw archive.** Each run's raw responses are gzipped into one NDJSON object per source and uploaded to S3.
  Alerts are archived once per 3-hour UTC slot, not every hour.
- **Restore from the archive.** `npm run restore:nws -- --from <time> --to <time>` rebuilds the documents of a window
  that never reached the laptop from the S3 raw archive, with the collector's own transforms (`toSnapshot`, `toAlert`),
  and inserts only the ones missing locally (insert-only by natural key, so a second run changes nothing). It is a dry
  run unless `--apply` is given. Alerts can only come back for the 3-hour slots that were archived.
- **Sync home.** On the laptop, `sync-atlas` copies `forecast_snapshots`, `alerts` and finished `pipeline_runs` from
  Atlas into the local MongoDB. It runs as the first step of `pipeline.js` (default `PIPELINE_CRON` every 3 hours at
  :50) and once at watcher startup. It is incremental (a marker per collection) and upserts by natural key.
- **Local NWS jobs off.** `docker-compose.yml` sets `ALERTS_CRON` and `FORECAST_CRON` to `"off"` for the fetcher, so
  only the Lambda calls NWS. Running alerts locally too would email each new heat alert twice.
- **Manual fallback.** The GitHub Actions workflows `nws-forecasts.yml` and `nws-alerts.yml` collect into the same
  Atlas collections. They are `workflow_dispatch` only.

## Alternatives considered

See [decision 2](../DESIGN_DECISIONS.md#2-collect-nws-data-in-the-cloud-buffer-it-in-atlas-keep-the-rest-local):
GitHub Actions cron (the first cloud collector, now a manual fallback), collecting only on the laptop, and moving the
whole pipeline to the cloud (too big for the free tiers). The free-tier constraint behind it is
[decision 1](../DESIGN_DECISIONS.md#1-a-0-budget-free-tiers-only).

## Failure handling

- **The handler never throws.** Every error is caught, logged (redacted) and emailed through SNS, and the function
  returns `{ status: "failed" }`. With `MaximumRetryAttempts: 0`, Lambda never repeats a failed run, so one failure
  sends one email.
- **Throttling.** All Lambdas share the account's 10 concurrent executions. A throttled scheduled event waits in
  Lambda's async queue and is retried for up to 50 minutes (`MaximumEventAgeInSeconds: 3000`), less than the hourly
  alerts interval. EventBridge retries a failed hand-off up to 4 times within 15 minutes.
- **NWS errors.** HTTP calls retry network errors and 408/429/5xx with exponential backoff and jitter (4 retries by
  default, `Retry-After` honoured, 30 s timeout per request). A city that still fails is recorded as an error in the
  run, and the run is `partial`.
- **Partial forecast runs.** NWS sometimes answers 500 for one grid point for a few hours. Every partial run stays
  in `pipeline_runs`, but the email goes out only when a city has failed 2 runs in a row, once per failure streak.
- **Bad event.** An unknown mode is emailed as an error and nothing runs.
- **Rotated Atlas password.** The connection string is cached across warm invocations and dropped after any failure,
  so the next run reads SSM again.
- **Archive failures.** A failed S3 upload only logs a warning; the run goes on.
- **Laptop off too long.** At startup the watcher warns (log, email, and a `sync_stale` entry in `pipeline_runs`)
  when the last successful sync is older than `SYNC_WARN_DAYS` (4). Data older than 7 days that was never synced is
  deleted from Atlas but stays in the S3 archive for 30 days: `npm run restore:nws` brings it back (all forecast runs;
  alerts only from the 3-hourly archived slots, so alerts that started and ended between two slots stay lost).

## Security

- **Role.** The function's role carries the `weather-pipeline-boundary` permissions boundary and may only:
  `ssm:GetParameter` on the Atlas parameter, `s3:PutObject` on `nws-*` in the bucket, `sns:Publish` on the owner topic,
  `sns:Publish` and `sns:ListSubscriptionsByTopic` on the subscriber topic, read and write the sign-up table, and write
  its own logs.
- **Secrets.** The Atlas connection string is an SSM SecureString (AWS-managed key `aws/ssm`), read at cold start. The
  template holds only the parameter name, and the code accepts only names under `/weather-pipeline/`.
- **Redaction.** Error messages pass through `redact()` before they are logged or emailed.
- **Atlas access.** A database user with `readWrite` on the `weather` database only. Network access is `0.0.0.0/0`
  because Lambda and GitHub runners have changing IPs; TLS is always on with `mongodb+srv://`.
- **Logs.** 7-day retention on `/aws/lambda/weather-pipeline-nws-collector`.
- **Restore reads.** The runtime user may only write to the archive bucket, so `restore:nws` reads it with the deploy
  profile (`AWS_DEPLOY_PROFILE`, `~/.aws`), as `aws:deploy` does: it only lists and gets objects. It never writes to AWS.
  Source names are checked against `^[a-z0-9-]+$` before they become an S3 prefix.

## Numbers

| Number | Source |
|---|---|
| Alerts run ~8 s / 158 MB, forecast run ~88 s / 168 MB (measured 2026-10-02) | [ROADMAP.md](../ROADMAP.md), free-tier table |
| ~960 invocations and ~6,800 GB-s a month, about 2% of the 400,000 free GB-s | [ROADMAP.md](../ROADMAP.md), free-tier table |
| A forecast run makes 106 NWS requests and writes ~9,000 rows | [README.md](../../README.md), "By the numbers" |
| Atlas buffer ~370 MB with indexes of the 512 MB free (72%), ~48 MB a day | [ROADMAP.md](../ROADMAP.md), free-tier table |
| S3 archive cap: 16 PUTs a day (8 alerts slots + 8 forecast runs) | `infra/template.yaml` (`RAW_ARCHIVE_MAX_PUTS_PER_DAY`) |
| GitHub Actions cron on the first night: 5 of ~7 forecast runs and 4 of ~20 alert runs happened | [DESIGN_DECISIONS.md](../DESIGN_DECISIONS.md), decision 2 |
| Restore of the 2026-10-06 03:07 → 10-07 09:23 gap: 11 forecast runs → 59,431 forecast documents, 11 alert slots → 184 alerts; ~18% of alert ids are only seen between slots | [ROADMAP.md](../ROADMAP.md), Known limitations |

## Where in the code

| What | File |
|---|---|
| Lambda handler | `src/lambda/nwsCollector.js` |
| SSM read | `src/lambda/ssmParameter.js` |
| Mode runner shared with the local fetcher | `src/stage1/runMode.js` |
| NWS forecasts, partial-run email rule | `src/stage1/nwsForecast.js` |
| NWS alerts, New / Upgraded / Extended rule | `src/stage1/nwsAlerts.js` |
| HTTP retry, rate limit, User-Agent | `src/lib/http.js` |
| Collections, unique keys, TTL indexes | `src/collections.js` |
| Atlas → local copy, stale-sync warning | `src/stage1/atlasSync.js` |
| S3 archive copy, and its read methods for restores | `src/adapters/rawStore/s3RawArchive.js` |
| Restore from the archive (insert-only) | `src/stage1/nwsRestore.js`, `scripts/restoreNws.js` |
| Archive reader with the deploy profile | `src/adapters/rawStore/archiveReader.js` |
| Function, role, schedules, log group | `infra/template.yaml` (`NwsCollector*`) |
| Manual fallback workflows | `.github/workflows/nws-forecasts.yml`, `.github/workflows/nws-alerts.yml` |
