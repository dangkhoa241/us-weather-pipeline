# Pipeline Ops page

A public status page at `/ops` that answers one question: **is the pipeline healthy right now?** It uses the run
records the jobs already write. It adds no new service and costs nothing extra.

## What it shows

| Section | Content | Source |
|---|---|---|
| Headline | "All jobs ok on their last run", or how many jobs failed or ran partially | the job cards below |
| Job cards | Alerts collector, forecast collector, dashboard publisher: schedule (UTC), last run, status (dot **and** text: OK / Partial / Failed / No run recorded), duration, ok runs in the last 7 days | `pipeline_runs` in Atlas |
| Data freshness | History through (day), forecast updated at (UTC), accuracy scored through | publisher run records; accuracy from the bundled snapshot (labelled "not live") |
| Recent incidents | Last 7 days, one line per failure streak: "Kansas City, MO: NWS error, recovered after 3 runs" | `pipeline_runs.errors`, mapped to categories |
| Alert emails | Sent, skipped by cooldown, skipped as not new, counted per city + category (not per recipient); "counting since <first run>" until 7 full days are recorded | `public_alerts` on alerts runs |
| Performance | Redis warm p95 35.4 → 2.9 ms (about 12×) | static, from [caching.md](caching.md) |

A **stale warning** appears when the **live** `generatedAt` is more than 6 hours old. The file is rewritten every
3 hours, so a stale file means the publisher missed at least one run. The bundled copy is old by nature, so it gets a
neutral note instead of the warning: "Snapshot from <date>. Live status unavailable."

**Live / Snapshot:** the page loads `status.json` from CloudFront first. If that fails, times out or doesn't
validate, it shows `/data/status.json`, which is bundled with the build (`npm run export:status`), and labels it
"Snapshot". This is the same pattern as the other live files.

## How it is produced

```
collectors (Lambda) ─▶ pipeline_runs (Atlas, 7-day TTL) ─▶ publisher: buildStatus → sanitizeStatus → leak check ─▶ S3 dashboard/status.json ─▶ CloudFront ─▶ /ops
```

- The dashboard publisher writes `status.json` **last** in every run (8 a day), so it can report the files that run
  just published. Its own record is not finished at that point, so its card shows the **last completed run**.
- New run-record fields:
  - the publisher's own run (`stage: "publish"`, `mode: "dashboard"`, with `history_as_of` and `forecasts_generated_at`);
  - `public_alerts` on alerts runs (`sent`, `cooldown`, `not_new`, `failed`).
- `status.json` has its own S3 PUT cap of 10 a day. That is 8 extra PUTs a day, about 12% of the free 2,000 a
  month. No IAM change was needed: the publisher already read and wrote Atlas.
- The Content-Security-Policy is unchanged: the CloudFront host was already in `connect-src`.

### How freshness is computed

- **History through:** `data_as_of` of the latest `recent.json`. That is the last day with values from Open-Meteo's
  archive, about 5 days behind. It comes from this run when it published history (once a day). Otherwise it comes
  from the newest publisher run record that has one.
- **Forecast updated at:** `generated_at` of the latest `forecasts.json` (every run).
- Both come from the `recent.json` / `forecasts.json` the publisher uploaded **in the same run**, never from bundled
  files (test: "freshness comes from the recent.json and forecasts.json uploaded in the same run").
- **Accuracy scored through:** `data_as_of` of the bundled snapshot, read in the browser. Accuracy is scored on the
  local pipeline only, so it is never live.
- The bundled fallback uses the snapshot's own dates instead (history through, latest NWS issue), because that is
  what the dashboard shows when CloudFront is unreachable.

### Incidents

Incidents are grouped per job and per city. A city that fails in several runs in a row becomes one incident: "recovered
next run", "recovered after N runs" or "not recovered yet". Errors without a city (the whole run failed) are named
after the job. A run left as `running` for more than 30 minutes counts as failed with category "timeout", because the
Lambda was stopped before it finished.

## What is deliberately hidden

The file is public, so it is built from a whitelist, never by copying run documents:

- **Raw error text is never copied.** Each error is mapped to one fixed category: NWS error, Open-Meteo error,
  timeout, rate limited, API budget reached, storage error, upload error, blocked by safety check, setup error, or
  other error. This drops URLs, HTTP bodies, stack traces and connection strings.
- **Built only from fixed values.** Incident lines come from fixed job names, the category, and city names from
  `locations`. Unknown fields and job ids are dropped.
- **No subscriber data:** no per-city subscriber counts. Alert counts are pipeline-wide totals of city + category
  messages, not emails per recipient.
- **No identifiers:** no emails, account IDs, ARNs, bucket names, SSM parameter names or batch ids.

**Second net:** `assertPublicStatus()` refuses to write a file that still matches any of these:
- an email address, an ARN, a 12-digit number, a bucket name or `s3://`;
- `ssm` or a parameter path;
- a stack-trace frame, `Error:`, `HTTP nnn` or a URL;
- `subscri`;
- the snapshot `FORBIDDEN` rule (localhost, `mongodb`, `atlas`, credentials in URLs, …).

The error it raises names the kind of leak, never the value. Tests cover both layers (`tests/opsStatus.test.js`)
with a worst-case run history.

## Tests

- **Backend (`tests/opsStatus.test.js`, `tests/dashboardPublisher.test.js`, `tests/alertRunCounts.test.js`):**
  - `buildStatus` with fixed dates and an injected clock;
  - error-to-category mapping;
  - incident streaks;
  - the sanitizer and the leak check;
  - the publisher writing `status.json` last and recording its run;
  - the alert counters.
- **Dashboard (`src/lib/ops.test.ts`, `src/pages/OpsPage.test.tsx`):**
  - the stale-banner rule (6 h);
  - live-first loading with the bundled fallback;
  - rendering for ok, partial, failed, empty, snapshot fallback, stale and unavailable.
- **Demo build (`check:demo`):** with live data blocked, `/ops` shows the bundled status labelled "Snapshot" with 3
  labelled job cards.
