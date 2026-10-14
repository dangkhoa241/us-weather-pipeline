# Alerts and sign-ups: SNS topics, sign-up function, DynamoDB, Turnstile

Rebuild steps: [SETUP_AWS.md](../SETUP_AWS.md) (steps 8 and 12). Full design:
[analysis/email-signups.md](../analysis/email-signups.md).

## Purpose

Two kinds of email:
- **Owner emails:** failed or partial pipeline runs, a stale Atlas sync, and new, upgraded or extended heat alerts.
- **Subscriber emails:** visitors sign up on the dashboard for one city and some alert categories (heat, flood,
  wind/storm, winter, fire & air quality, tropical), and get an email when NWS issues a real change for them.

## Requirements

- Email only on a real change, not on every NWS re-issue.
- Owner and subscriber emails never mix, and owner emails are never paused.
- Stay inside SNS's 1,000 free emails a month, shared by both topics.
- A public sign-up endpoint that resists bots, mail-bombing and enumeration, and stores no email address or IP
  outside SNS.

## Design

- **Notifier adapter.** Pipeline code sends events through `Notifier` (console locally, SNS with `NOTIFIER=sns`).
  `SNS_MIN_LEVEL=warn` on the Lambdas: only warnings and errors are emailed.
- **Two topics.** `weather-pipeline-alerts` (owner) and `weather-pipeline-public-alerts` (subscribers).
- **Notify rule.** On each alerts run, a new alert is compared with the city's alerts of the same group still in
  effect: none → "New"; a higher severity or product (Watch → Advisory → Warning) → "Upgraded"; a later end time →
  "Extended"; anything else is a re-issue, stored but not emailed.
- **Subscriber publishing** (collector, alerts mode only): one message per city, category and alert, with `city` and
  `category` message attributes; each subscription's SNS filter policy picks the recipients. At most one email per
  city and category per 24 hours, unless upgraded.
- **Monthly budget.** Before each public publish, the collector reserves the number of matching subscriptions on a
  DynamoDB counter (`emails#<yyyy-mm>`) with the condition that the total stays ≤ 900. Each sign-up reserves one
  confirmation email. When the budget is reached, public emails stop until next month and the owner is told once.
- **Sign-up function.** `weather-pipeline-signup` behind a Function URL (`AuthType NONE`, no API Gateway), 128 MB, 8 s
  timeout. Checks, cheapest first: method → body size (≤ 2 KB) → JSON → field validation (no network) → per-IP
  limit (5 an hour) → Turnstile → subscriber cap (100) → daily limit (20 new a day) → monthly email budget →
  per-email cooldown (24 h) → `sns:Subscribe` with a filter policy. SNS then sends its own confirmation email (double
  opt-in).
- **Counters.** DynamoDB table `weather-pipeline-signups`, provisioned 1 RCU / 1 WCU, TTL on `expires_at`. Keys hold
  HMACs of IPs and emails (key in SSM), subscription ARNs and counters; no raw address.
- **Turnstile.** Cloudflare's bot check on the form; the function verifies each token server-side (3 s timeout) and
  accepts only the dashboard hostname and the `signup` action.

## Alternatives considered

See [decision 9](../DESIGN_DECISIONS.md#9-alert-emails-only-on-a-real-change-on-separate-topics-with-a-hard-cap):
emailing every new alert id (the first version); for the counters, MongoDB Atlas (the public function would hold the
database credentials), Upstash Redis (an extra provider) or in-memory counters (lost on a cold start). The adapter
pattern behind `Notifier` and `CounterStore` is
[decision 8](../DESIGN_DECISIONS.md#8-every-external-service-sits-behind-an-adapter-chosen-by-env).

## Failure handling

- A failed public publish is logged, not retried (no duplicate emails); its reservation stays counted, which can only
  over-count.
- The collector Lambda never retries a run, so one alert produces one email.
- A throttled DynamoDB write makes the sign-up answer "try again later" (provisioned capacity throttles, it is never
  billed).
- A wrong Turnstile secret shows up in the logs as `captcha_failed (not_success:invalid-input-secret)`, and the cached
  secrets are dropped so the next request reads SSM again.
- The collector prunes `sub#` registry items whose SNS subscription is gone.

## Security

- **No enumeration.** After the CAPTCHA, every outcome that depends on the email returns the same text: "Check your
  inbox to confirm." Existing subscriptions are never changed.
- **Topic policies.** Own account only, HTTPS only; the subscriber topic denies any protocol but `email` (no SMS,
  HTTP, Lambda or SQS subscriptions).
- **Sign-up role** (with the boundary): read exactly two SSM parameters; DynamoDB `UpdateItem`/`PutItem` only on its own
  key prefixes (`ip#`, `day#`, `emails#`, `email#`, `sub#`); `sns:Subscribe` with protocol `email` and
  `ListSubscriptionsByTopic` on the subscriber topic. No read, scan or delete.
- **IP source.** The per-IP limit uses `requestContext.http.sourceIp`, which the client cannot spoof.
- **Logs.** Outcome codes, city and categories only; emails masked (`d***@g***.com`); never IPs, tokens, hashes or the
  raw body. 7-day retention.
- **CORS** on the Function URL allows the dashboard origin and the local Vite ports, `POST` only, no credentials. CORS
  only limits browsers; the function's own checks are the boundary.
- Accepted: the SNS confirmation email shows the topic ARN, which contains the account ID
  ([analysis/email-signups.md](../analysis/email-signups.md), section 8).

## Numbers

| Number | Source |
|---|---|
| Replaying 17 stored heat alerts (2026-09-30 to 10-07) gives 5 emails instead of 17 | [DESIGN_DECISIONS.md](../DESIGN_DECISIONS.md), decision 9 |
| Owner emails: under 150 a month | [ROADMAP.md](../ROADMAP.md), free-tier table |
| Public emails: hard cap 900 a month of the shared 1,000; measured ~2.7 alert emails per subscriber per month (Oct 1–8) | [ROADMAP.md](../ROADMAP.md), free-tier table |
| Limits: 5 attempts per IP per hour, 20 new subscriptions a day, 100 subscriptions, 24 h cooldowns | `infra/template.yaml` (`SignupFunction` environment) |
| DynamoDB 1 RCU / 1 WCU, < 1 MB | [ROADMAP.md](../ROADMAP.md), free-tier table |

## Where in the code

| What | File |
|---|---|
| Sign-up function | `src/lambda/signup.js` |
| Turnstile check | `src/lib/turnstile.js` |
| Subscriber publishing, cooldown, budget | `src/stage1/publicAlerts.js` |
| Notify rule, categories | `src/stage1/nwsAlerts.js`, `src/stage1/alertCategories.js` |
| SNS adapters | `src/adapters/notifier/snsNotifier.js`, `src/adapters/notifier/snsPublicTopic.js` |
| Counter store | `src/adapters/counterStore/dynamoCounterStore.js` |
| Sign-up dialog | `dashboard/src/components/SignupDialog.tsx` |
| Topics, table, function, roles | `infra/template.yaml` (`AlertsTopic*`, `PublicAlertsTopic*`, `SignupTable`, `Signup*`) |
| Tests | `tests/signup.test.js`, `tests/publicAlerts.test.js`, `tests/heatAlerts.test.js`, `tests/snsNotifier.test.js` |
