# Public email sign-ups for NWS alerts (design only, Stage A)

Goal: a visitor picks one city and one or more alert types on the dashboard and gets NWS alerts for them by email.
Nothing is sent until they confirm the email address (SNS double opt-in), and every email has an unsubscribe link.

Constraints: $0 (CLAUDE.md cost rule + AWS cost guard), Free plan account until 2027-04-02, us-east-2,
tag `Project=us-weather-pipeline`, everything in `infra/template.yaml` so `npm run aws:teardown` removes it.
Facts checked 2026-10-08. Measurements come from a read-only replay of the 2,940 NWS alerts in Atlas
(2026-09-30 → 2026-10-08).

**Status: built on branch `feature/email-signups` (Stage B, 2026-10-08), not deployed.** Decisions taken (owner,
2026-10-08): 24 h public cooldown per city + category (Upgraded always sent): yes. Subscriber cap: **100**. One
implementation. Reserved concurrency: **off** for now (account limit 10, increase requested), switchable with the
stack parameter `SignupReservedConcurrency`. The **[decide]** marks below are the original questions, kept for the record.
See "As built" at the end for what changed from this design.

## Summary

| Piece | Choice |
|---|---|
| Topics | Existing `weather-pipeline-alerts` stays private (ops + your heat emails). New `weather-pipeline-public-alerts` for subscribers only |
| Categories | heat, flood, wind/storm, winter, fire & air quality, tropical (exact NWS event names); everything else is "other", never emailed |
| Notify rule | Same New / Upgraded / Extended rule as now, per (city, category); **[decide]** plus a 24 h cooldown per (city, category) on public emails |
| Publishing | Collector Lambda (alerts run, hourly): one SNS message per (city, category, alert), message attributes `city` + `category` |
| Subscriptions | One per email: one city + its categories, as an SNS filter policy on both attributes |
| Sign-up | New Lambda `weather-pipeline-signup` with a Function URL (no API Gateway); Turnstile verified server-side |
| Counters | DynamoDB table, provisioned 2 RCU / 2 WCU (always free), TTL on rate-limit items |
| Caps | 195 public subscriptions (topic limit 200); 900 public emails / month; 5 attempts / IP / hour; 20 new subscriptions / day |
| Cost | $0: everything stays inside always-free allowances (table below) |

## 1. Two SNS topics

| Topic | Who subscribes | What is published | Who publishes |
|---|---|---|---|
| `weather-pipeline-alerts` (existing, unchanged) | You only (`AlertEmail`, CloudFormation) | Pipeline failures, partial runs, your heat emails, the new "public emails paused" notice | `SnsNotifier` (collector, publisher, local runs) |
| `weather-pipeline-public-alerts` (new) | Visitors through the sign-up Lambda | One alert per message: city, category, event; nothing else | New `SnsAlertPublisher` (collector only) |

How ops messages are kept off the public topic (each layer is tested in Stage B):
- **Different code paths.** `SnsNotifier` (ops) only ever gets `SNS_TOPIC_ARN`. The new `SnsAlertPublisher` only gets
  `PUBLIC_SNS_TOPIC_ARN`, and its constructor throws if that equals `SNS_TOPIC_ARN`.
- **Typed input.** The public publisher accepts a structured alert object (`{ city, category, reason, alert }`) and
  builds the text itself. It has no `notify(title, message)` method, so a failure message can't be passed to it.
- **No shared factory.** `createNotifier()` never returns the public publisher. A separate `createAlertPublisher()`
  (`PUBLIC_ALERTS=off|sns`, default `off`) is used only by the alerts mode.
- **Only the collector can publish.** The dashboard publisher Lambda and the local `weather-runtime` user get no
  permission on the public topic.
- **Test.** Run a failing alerts run and a partial forecast run against mocked SNS clients, then assert that no
  `PublishCommand` targets the public ARN and that every public message has `city` and `category` attributes.

Public topic policy:
- Own account only.
- HTTPS only, the same as the private topic.
- `Deny sns:Subscribe` unless `sns:Protocol` is `email`. SMS and HTTP subscriptions can never be added, and SMS is
  the one SNS feature that costs money.

`DisplayName: US Weather Alerts` is the sender name subscribers see.

## 2. Alert categories

The mapping uses exact NWS event names, so it can be tested and reviewed.
- An unknown name maps to `other` and is logged once per run (`[alerts] unmapped event: …`), so a new NWS product
  shows up in the logs instead of being emailed by accident.
- Mapping file: `src/stage1/alertCategories.js` (pure, shared by the collector, the sign-up Lambda's allowlist and
  the dashboard).

| Category (`category` attribute) | NWS events |
|---|---|
| `heat` | Extreme Heat Warning / Watch, Excessive Heat Warning / Watch (older names), Heat Advisory |
| `flood` | Flood Warning / Watch / Advisory / Statement, Flash Flood Warning / Watch / Statement, Coastal Flood Warning / Watch / Advisory / Statement, Lakeshore Flood Warning / Watch / Advisory / Statement, Hydrologic Advisory |
| `wind_storm` | Tornado Warning / Watch, Severe Thunderstorm Warning / Watch, Severe Weather Statement, Extreme Wind Warning, High Wind Warning / Watch, Wind Advisory, Lake Wind Advisory, Dust Storm Warning, Dust Advisory, Blowing Dust Warning / Advisory |
| `winter` | Winter Storm Warning / Watch, Winter Weather Advisory, Blizzard Warning, Ice Storm Warning, Lake Effect Snow Warning / Watch, Snow Squall Warning, Freeze Warning / Watch, Hard Freeze Warning / Watch, Frost Advisory, Cold Weather Advisory, Extreme Cold Warning / Watch, Freezing Fog Advisory |
| `fire_air` | Red Flag Warning, Fire Weather Watch, Fire Warning, Extreme Fire Danger, Air Quality Alert, Air Stagnation Advisory, Dense Smoke Advisory, Ashfall Warning / Advisory |
| `tropical` | Hurricane Warning / Watch, Tropical Storm Warning / Watch, Storm Surge Warning / Watch, Typhoon Warning / Watch, Tropical Cyclone Local Statement |
| `test` | No NWS event. Owner-only test messages (Stage C); not in the public allowlist |

**Other (stored and shown on the dashboard, never emailed):**
- Beach and surf: Rip Current Statement, Beach Hazards Statement, High Surf Advisory / Warning.
- Marine: Small Craft Advisory, Gale / Storm / Hurricane Force Wind Warning (marine), Hazardous Seas, Special Marine
  Warning, Marine Weather Statement, Brisk Wind Advisory, Heavy Freezing Spray, Low Water Advisory.
- Fog: Dense Fog Advisory.
- Vague or catch-all: Special Weather Statement, Hazardous Weather Outlook, Hydrologic Outlook, Short Term Forecast.
- Non-weather: Test Message, Administrative Message.
- Civil and other emergencies: Tsunami, Earthquake, Avalanche, Volcano, Child Abduction, Civil Danger, Evacuation
  Immediate, Shelter in Place, Law Enforcement, Hazardous Materials, Nuclear Power Plant, Radiological Hazard,
  911 Telephone Outage, Local Area Emergency, Blue Alert.

Life-safety civil alerts are left out on purpose. An hourly email is the wrong channel for them, and the disclaimer
sends people to official alerts.

In the replay, 4 of the 39 event names seen were "other" for tracked cities: Rip Current Statement, Dense Fog
Advisory, Special Weather Statement and High Surf Advisory.

## 3. Generalized notify rule

`heatChanges(fresh, prior)` becomes `alertChanges(fresh, prior)`. The logic is the same, but "same event" now means
the **same city and the same category**, instead of "heat" only:
- **New:** no alert of that category is still in effect for the city.
- **Upgraded:** a higher severity or product than any active alert of that category (e.g. Flood Watch → Flash Flood
  Warning).
- **Extended:** a later end time than the latest active one.
- **Re-issue:** anything else. It is stored and not emailed.

Cancellations are excluded, as today.

Two consumers:
- **Your private email: unchanged.** `heatAlertEvent()` keeps its current text and gets only the `heat` changes
  (same subject, one email per run). The existing heat tests stay as they are.
- **Public: one message per (city, category, alert)** from the same `alertChanges()` output.

**[decide] 24 h public cooldown.** The replay shows that the rule alone is noisy for coastal cities. NWS issues a new
Coastal Flood Advisory nearly every day, and each one either follows an expired alert ("New") or ends a few hours
later ("Extended"). Proposal: at most one public email per (city, category) per 24 h, but an **Upgraded** event is
always sent. A grace window (an alert that ended < 24 h ago counts as still active) was also tested and barely helps,
because those alerts then just become "Extended".

Replay, 6 counted days (the first day is warm-up, scaled to 30 days):

| Rule | Emails / 30 days, all 53 cities, all categories | Mean per city | Worst city |
|---|---|---|---|
| New / Upgraded / Extended | 225 | 4.25 | Charleston, SC: 55 (flood 55) |
| + 24 h cooldown (Upgraded exempt) | 145 | 2.74 | Jacksonville, FL: 25 |

By category with the cooldown (sum over cities): flood 100, wind/storm 15, winter 15, heat 5, fire & air 5,
tropical 5. Your private heat emails are not affected.

The cooldown state is one DynamoDB item per (city, category) with a 24 h TTL (see 6).

## 4. Publishing and filter policies

Where: the collector's alerts mode (hourly, already computing the changes). After the upsert:
1. `alertChanges()` → the public changes (cooldown applied) and the private heat changes.
2. **Cost guard (7):** for each public message, reserve the expected deliveries on the monthly counter. If the
   counter would pass 900, publish nothing more this month.
3. Publish each public message:
   - `MessageAttributes`: `city` (e.g. `stockton-ca`) and `category` (e.g. `heat`), both `String`.
   - `Subject`: ASCII, ≤ 100 characters, e.g. `Stockton, CA: Heat Advisory (extended to Oct 10, 10 PM PDT)`.
   - `Message`: event, severity, the city's local time and UTC, the NWS headline, the instruction (≤ 1,000 chars),
     links to weather.gov for the city and the dashboard's Forecast page, why they got it, and the disclaimer (8).
   - SNS adds the unsubscribe link.
4. A failed publish is logged and swallowed, with no retry (so no duplicate emails), the same as `SnsNotifier`.

Subscription filter policy (`FilterPolicyScope: MessageAttributes`), built by a pure `filterPolicyFor(city, categories)`:

```json
{ "city": ["stockton-ca"], "category": ["heat", "flood"] }
```

- Both keys must match. Within a key, any value matches. That's 1 × ≤ 6 = ≤ 6 value combinations, far below SNS's
  limit of 150.
- **One city per email address.** SNS allows one subscription per (topic, email). Several cities with different
  categories per city can't be expressed in one policy. To change a choice, the visitor unsubscribes (email link) and
  signs up again.
- **Cap:** SNS allows 200 filter policies per topic (default, adjustable but kept). Public sign-ups stop at **195**,
  counting pending ones (`ListSubscriptionsByTopic`, ≤ 2 pages of 100). That leaves 5 for your own test
  subscription.
- **Pending subscriptions count for 30 days.** SNS deletes unconfirmed *email* subscriptions after 30 days (other
  protocols after 48 h), so fake sign-ups would hold places for a month. The daily and per-IP limits in 6 keep that
  small: at most 20 new subscriptions a day.

## 5. Sign-up endpoint

Lambda `weather-pipeline-signup`:
- Node 22, arm64, 128 MB, 10 s timeout, esbuild bundle.
- **Function URL** with `AuthType: NONE` and `InvokeMode: BUFFERED`. SAM adds the resource policy. Since Oct 2025 a
  new public function URL needs both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`; SAM creates both, to be
  checked in the change set.
- Function URL CORS:
  - `AllowOrigins`: the Vercel origin, `http://localhost:5173` and `http://localhost:4173`.
  - `AllowMethods`: `POST`. `AllowHeaders`: `content-type`. `MaxAge`: 600. No credentials.
  - CORS is not a security boundary (curl ignores it); the checks below are.

Request: `POST {"email": "...", "city": "stockton-ca", "categories": ["heat"], "turnstileToken": "..."}`

Order of checks (cheap first; nothing reaches SNS without passing all of them):

| # | Check | Failure response |
|---|---|---|
| 1 | Method `POST`, `content-type: application/json`, body ≤ 2 KB (checked before `JSON.parse`), valid JSON, no unknown keys | 400 `Invalid request.` |
| 2 | Email: trimmed, lowercased, ≤ 254 chars, one `@`, simple RFC 5322 subset, no spaces or control characters. City: one of the 53 ids from `src/locations/cities.js`. Categories: 1–6 unique, from the public allowlist (`test` excluded) | 400 with the field name only (`Choose a city.`) |
| 3 | Per-IP rate limit: 5 attempts / hour. The IP comes from `requestContext.http.sourceIp`, which the client can't spoof (unlike `X-Forwarded-For`) | 429 `Too many attempts. Try again later.` |
| 4 | Turnstile: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with secret, token and `remoteip`, 3 s timeout. Requires `success`, `hostname` in the allowlist and `action === "signup"`. Token ≤ 2,048 chars | 400 `Verification failed. Please try again.` |
| 5 | Global limit: 20 new subscriptions / UTC day; monthly email budget not exhausted (each confirmation is reserved on the counter) | 503 `Sign-ups are paused for today. Try again tomorrow.` |
| 6 | Subscriber cap: < 195 subscriptions on the topic | 503 `Sign-ups are full right now.` |
| 7 | Per-email cooldown: one sign-up per address per 24 h (key = HMAC of the address) | **generic 200** (doesn't reveal anything) |
| 8 | `sns:Subscribe` (email, filter policy, `ReturnSubscriptionArn`), then record subscription ARN → city + categories (no email) for the cost guard | **generic 200**, including "already subscribed" (SNS returns the existing ARN or an `InvalidParameter` "different attributes" error; both are swallowed) |

Generic response, always the same text for every outcome of 7–8: **"Check your inbox to confirm."**
- Responses 5 and 6 don't depend on the email, so they reveal nothing about who has subscribed.
- Small timing differences remain (SNS call or not). Accepted: the 24 h cooldown and the IP limit make probing slow.
- An existing subscription is never changed (no `SetSubscriptionAttributes`). Otherwise anyone could rewrite someone
  else's choices.

Turnstile:
- Secret in SSM SecureString `/weather-pipeline/turnstile-secret` (`aws/ssm` key), read at cold start and cached.
- The site key is public and goes in the dashboard config.

## 6. Abuse limits and where counters live

| Limit | Value | Why |
|---|---|---|
| Per IP | 5 attempts / hour (every request after step 2 counts) | Slows bots and mail-bombing of third parties |
| Global new subscriptions | 20 / UTC day | Caps confirmation emails (≤ 600 / month worst case, but each is also reserved on the 900 budget) and pending places |
| Per email | 1 sign-up / 24 h | No repeated confirmation emails to one person |
| Subscriber cap | 195 (topic limit 200) | Filter-policy quota |
| Reserved concurrency | 2 | A flood of requests can't use the account's concurrency or run up GB-s. **Needs an account limit > 12**: new accounts can be limited to 10, and Lambda keeps 10 unreserved (to check by hand, 11) |
| Request size | ≤ 2 KB body, ≤ 2,048-char token | Function URL accepts 6 MB; reject before parsing |
| Timeout / memory | 10 s / 128 MB | Bounded cost per request |

Counter store options:

| | **DynamoDB, provisioned (chosen)** | MongoDB Atlas (existing `api_usage` ledger) | Upstash Redis free | In-memory per Lambda instance |
|---|---|---|---|---|
| Free limit | Always free: 25 GB, 25 RCU + 25 WCU (provisioned only; on-demand would use the Free plan credits) | M0: 512 MB, ~72% used; 500 connections | 10,000 commands / day, 256 MB | Free |
| Atomic counter + expiry | `UpdateItem ADD` + condition; TTL deletes for free | `$inc` + TTL index | `INCR` + `EXPIRE` | Yes, but lost on cold start, per instance |
| Blast radius of the public Lambda | Its own table, `UpdateItem` / `PutItem` only | Needs the Atlas URI = read/write to the whole `weather` DB (one DB user) | A new third-party secret | None |
| New service / secret | No (AWS, IaC, teardown) | No | Yes (new provider, new secret, ROADMAP entry) | No |
| Cold start | ~50 ms (SDK in runtime) | ~1 s TLS + auth to Atlas | ~100 ms | 0 |
| Verdict | ✔ | ✘ public endpoint must not hold the DB credentials | ✘ extra provider for no gain | ✘ not a real limit |

Table `weather-pipeline-signups`:
- One table with key `pk` (string), `PROVISIONED` 2 RCU / 2 WCU, no autoscaling, TTL attribute `expires_at`,
  SSE with the AWS-owned key (default, free), point-in-time recovery off.
- At 2 WCU a burst throttles and gets a 503: acceptable.

| `pk` | Fields | TTL | Written by |
|---|---|---|---|
| `ip#<hmac>#<yyyymmddhh>` | `n` | 2 h | sign-up |
| `email#<hmac>` | — | 24 h | sign-up |
| `day#<yyyymmdd>` | `n` | 2 days | sign-up |
| `sub#<subscription-arn>` | `city`, `categories` | none (pruned, below) | sign-up |
| `emails#<yyyy-mm>` | `n` | 40 days | sign-up (confirmations) and collector (alerts) |
| `paused#<yyyy-mm>` | — | 40 days | collector (one private notice per month) |
| `cool#<city>#<category>` | — | 24 h | collector |

- HMAC key: SSM SecureString `/weather-pipeline/signup-hmac-key` (32 random bytes). Without it, a SHA-256 of an
  email address or IP is easy to reverse by guessing.
- No raw email address or IP is ever stored outside SNS.
- Pruning `sub#`: on each alerts run with public changes, the collector lists the topic's subscriptions and deletes
  `sub#` items whose ARN is gone (unsubscribed or expired). Deleting items is free.

Expected use: < 1,000 reads/writes a day, far below 2 RCU / 2 WCU sustained (~170,000 / day each). Storage < 1 MB.

## 7. Cost guard: 1,000 free SNS emails per month

SNS always free: 1,000 email deliveries / month for the whole account, shared by both topics.
- **Public budget: 900.** The other 100 are reserved for your private emails (measured: 5 emails on 2026-10-07, a
  normal day 0–1; expect < 60 / month).
- Private emails are never paused: ops emails must arrive.
- Counter `emails#<yyyy-mm>`:
  - before each public publish, the collector adds the number of matching subscriptions (`sub#` items whose city
    and categories match), with a condition `n + k ≤ 900`;
  - each sign-up adds 1 for its confirmation email.
- If the condition fails, nothing more is published publicly that month, and one private warn email is sent
  (`paused#` stops repeats): "Public alert emails paused for 2026-10: 900-email budget reached."
- It counts pending subscriptions as if they would receive email, so it can only over-count, which is safe.
- A message that fails to publish after the reservation stays counted (also safe).

Expected public emails / month. Measured with the cooldown, at 2.74 alert emails per subscriber per month (city
uniform across the 53, all 6 categories), plus one confirmation per new sign-up. Early October was quiet (no
tracked-city hurricane or winter storm), so the seasonal column doubles it.

| Subscribers | Measured month | Busy season (×2) | All in the worst city (Jacksonville, flood, 25 / month) |
|---|---|---|---|
| 10 | 27 alerts + 10 confirmations ≈ **37** | ≈ 65 | 260 |
| 50 | 137 + 50 ≈ **187** | ≈ 325 | 1,260 → stops at 900 |
| 200 (cap 195) | 535 + 195 ≈ **730** | ≈ 1,265 → stops at 900 | 4,900 → stops at 900 |

Without the cooldown: 4.25 per subscriber, so 200 subscribers ≈ 1,045 / month even in the quiet week.

**[decide]** The 900 budget, not the 200 filter policies, is the real limit. With 200 subscribers and a busy month,
public emails would stop in the last week or so. Options:
- (a) keep 195 and accept pauses;
- (b) start with a cap of **100** (≈ 375 / month quiet, ≈ 650 busy) and raise it if the counter stays low.

I recommend (b). It is one config value (`PUBLIC_SUBSCRIBER_CAP`).

Other free-tier use:

| Service | Free | Expected |
|---|---|---|
| SNS publishes | 1 M / month | < 300 public + < 100 private |
| SNS API (Subscribe, List…) | not charged | < 2,000 / month |
| Lambda sign-up | 1 M requests + 400,000 GB-s (shared) | < 1,000 requests, < 100 GB-s |
| Lambda collector (extra work) | same | + ~1 s per alerts run with changes, < 1% more |
| DynamoDB | 25 GB + 25 RCU / 25 WCU always free (provisioned) | 2 RCU / 2 WCU, < 1 MB |
| SSM | standard parameters free; KMS 20,000 requests | +2 parameters, reads only at cold start |
| CloudWatch Logs | 5 GB | + < 10 MB / month (7-day retention) |
| Cloudflare Turnstile | Free plan: unlimited verifications, up to 20 widgets, **no card** | 1 widget, < 1,000 / month |

To add to the ROADMAP free-tier table in Stage B (CLAUDE.md rule): DynamoDB, Turnstile and the Function URL.

## 8. Privacy and safety

Logging:
- Email addresses are masked, keeping the first character of each part: `d***@g***.com`. No IP, token, HMAC or raw
  body is logged.
- Log lines record only the outcome: `[signup] ok city=stockton-ca categories=heat`, `[signup] rate_limited`,
  `[signup] captcha_failed (timeout-or-duplicate)`.
- The collector logs subscription counts, never endpoints.
- A test checks that no log line contains `@` followed by the full domain, or the test IP.

Privacy note on the form: "Your email address is stored only by Amazon SNS to send these alerts. It isn't shared or
used for anything else. Your IP address is used in hashed form for one hour to block abuse. Unsubscribe with the link
in any email."

Disclaimer on the form and at the top and bottom of every email: **"Not an official warning service. For
emergencies, use weather.gov and your phone's emergency alerts."**

Accepted, and to note under ROADMAP Known limitations:
- **Account ID visible.** The SNS confirmation email shows the topic ARN, which includes the AWS account ID. AWS
  doesn't treat account IDs as secret.
- **Unsubscribe link.** Whoever has the email can unsubscribe (standard SNS behaviour).
- **Delay.** Alerts are checked hourly, so emails arrive up to ~1 h after NWS issues an alert.
- **Coverage.** Matching uses the city's forecast zone and county only.

## 9. Front end

- **Where.** There is no separate city page. A city opens in the Overview drill-down panel (`DrillDownPanel`) and
  on the Forecast page (`?city=`). Both get a **"Get alerts"** button next to the city name. It opens a small dialog
  (shadcn `Dialog`), pre-filled with the city.
- **Form.**
  - Email field.
  - 6 category checkboxes, each label a `<Term k="Heat alerts" />` etc. (6 new glossary entries listing the main
    NWS events).
  - The Turnstile widget, rendered explicitly when the dialog opens. The script is loaded only then, with
    `action: "signup"`.
  - The privacy note, the disclaimer and a submit button.
  - The answer goes in an inline status (`role="status"`), not `alert()`. The submit button is disabled while
    sending, and the Turnstile widget resets after each attempt (tokens are single-use).
- **Config.** `VITE_SIGNUP_URL` and `VITE_TURNSTILE_SITE_KEY` are set in `vite.config.ts` like `LIVE_DATA_URL`
  (public values). The button is hidden when they are missing, e.g. in local dev without AWS.
- **CSP** (`dashboard/vercel.json`), only these additions:
  - `script-src 'self' https://challenges.cloudflare.com`
  - `frame-src https://challenges.cloudflare.com` (new directive; today `default-src 'self'` covers frames)
  - `connect-src` adds `https://<url-id>.lambda-url.us-east-2.on.aws` (the exact Function URL host)
  - `form-action 'none'` stays (the form uses `fetch`), and `frame-ancestors 'none'` stays.

  Checked against Cloudflare's Turnstile CSP page (script-src + frame-src); pre-clearance mode isn't used.
- **Tests.** Dashboard Vitest for the form (validation messages, disabled states, the generic answer). The demo
  checks get a "0 CSP violations with the dialog open" case.

## 10. New AWS resources and IAM permissions

New resources (all tagged `Project=us-weather-pipeline`, all in the SAM stack):

| Resource | Notes |
|---|---|
| `AWS::SNS::Topic` `weather-pipeline-public-alerts` | No KMS (public NWS text), `DisplayName` |
| `AWS::SNS::TopicPolicy` | Own account; deny non-HTTPS; deny `Subscribe` unless `sns:Protocol = email` |
| `AWS::DynamoDB::Table` `weather-pipeline-signups` | Provisioned 2/2, TTL `expires_at`, `DeletionPolicy: Delete` |
| `AWS::Serverless::Function` `weather-pipeline-signup` | 128 MB, 10 s, reserved concurrency 2, `FunctionUrlConfig` (NONE, CORS above) |
| `AWS::Lambda::Permission` × 2 (SAM-generated) | `InvokeFunctionUrl` and `InvokeFunction` for `*`, `FunctionUrlAuthType: NONE` |
| `AWS::Logs::LogGroup` `/aws/lambda/weather-pipeline-signup` | 7 days |
| `AWS::IAM::Role` `SignupRole` | With the permissions boundary |

Changed: the collector role and environment (public topic ARN, table name, caps).

Sign-up role (only):
- `logs:CreateLogStream`, `logs:PutLogEvents` on its log group.
- `ssm:GetParameter` on exactly the two parameters, `/weather-pipeline/turnstile-secret` and
  `/weather-pipeline/signup-hmac-key`.
- `dynamodb:UpdateItem`, `dynamodb:PutItem` on the table, with `dynamodb:LeadingKeys` limited to `ip#*`, `email#*`,
  `day#*`, `sub#*` and `emails#*`. It can't touch `cool#` or `paused#`, and can't read or scan.
- `sns:Subscribe` on the public topic, with `sns:Protocol = email`.
- `sns:ListSubscriptionsByTopic` on the public topic (for the cap).

Collector role (additions):
- `sns:Publish` on the public topic.
- `sns:ListSubscriptionsByTopic` on the public topic (pruning).
- `dynamodb:GetItem`, `dynamodb:Query`, `dynamodb:UpdateItem`, `dynamodb:PutItem`, `dynamodb:DeleteItem` on the
  table. `Query` reads `sub#` items through a scan-free key design, decided in Stage B; if it needs a `Scan` of a
  ≤ 200-item table, that is `dynamodb:Scan` on this table only.

Changes to the permissions boundary `weather-pipeline-boundary` (by hand, like before):
- `dynamodb:GetItem` / `PutItem` / `UpdateItem` / `DeleteItem` / `Query` / `Scan` on `table/weather-pipeline-*`.
- `sns:Subscribe` / `sns:ListSubscriptionsByTopic` on `weather-pipeline-*`.

Changes to the deploy policy `weather-dev` (by hand):
- DynamoDB on `table/weather-pipeline-*`: `CreateTable`, `DeleteTable`, `DescribeTable`, `UpdateTable`,
  `UpdateTimeToLive`, `DescribeTimeToLive`, `TagResource`, `UntagResource`, `ListTagsOfResource`,
  `DescribeContinuousBackups`.
- Lambda on `function:weather-pipeline-*`: `CreateFunctionUrlConfig`, `GetFunctionUrlConfig`,
  `UpdateFunctionUrlConfig`, `DeleteFunctionUrlConfig`, `PutFunctionConcurrency`, `DeleteFunctionConcurrency`.
- `lambda:GetAccountSettings` (read-only, `*`), to check concurrency.
- SNS on `weather-pipeline-*`: `SetSubscriptionAttributes`, so you can add `test` to your own subscription in
  Stage C. `Subscribe` / `Unsubscribe` are already there.
- No CloudWatch metrics permission is needed (the counter replaces it).

Local `weather-runtime` user: no change (it never touches the public topic or the table).

## 11. What you do by hand

1. **Cloudflare Turnstile** (free, no card):
   - create a Cloudflare account if needed;
   - add a Turnstile widget in Managed mode, with hostnames `us-weather-pipeline.vercel.app` and `localhost`;
   - send me the **site key** (public);
   - keep the secret key for step 2.
2. **SSM secret** (don't paste it into chat):
   `aws ssm put-parameter --profile weather-dev --region us-east-2 --type SecureString --name /weather-pipeline/turnstile-secret --value <secret>`
   (Git Bash: `MSYS_NO_PATHCONV=1`).
3. **HMAC key:** the same command with `--name /weather-pipeline/signup-hmac-key` and a value from
   `openssl rand -hex 32`.
4. **IAM (console):** update `weather-pipeline-boundary` and the `weather-dev` policy with the JSON I'll put in
   `infra/iam/` in Stage B.
5. **Check limits:**
   - Lambda console → Account-level concurrency. If it is 10, reserved concurrency is impossible. Either request a
     free quota increase (Service Quotas → Lambda → Concurrent executions) or I drop reserved concurrency and rely
     on the rate limits.
   - Service Quotas → SNS → "Filter policies per topic" should be 200.
6. **[decide]** the points marked above: the 24 h public cooldown, and the subscriber cap (195 or 100).
7. **Stage C:**
   - approve the change set;
   - sign up for Stockton + heat on the live form and click the SNS confirmation email;
   - I'll then add `test` to your subscription's filter policy (`SetSubscriptionAttributes`) and send one
     `category=test` message. No public subscription can have `test`: it is outside the sign-up allowlist.

## Stage B plan (after approval)

New and changed files:
- `src/stage1/alertCategories.js`
- `alertChanges()` in `src/stage1/nwsAlerts.js`
- `src/adapters/notifier/snsAlertPublisher.js` + `createAlertPublisher()`
- `src/adapters/counterStore/` (`dynamoCounterStore.js` + `memoryCounterStore.js`)
- `src/lambda/signup.js`
- `src/config.js` + `.env.example` variables
- `infra/template.yaml`, `infra/iam/*.json`
- dashboard dialog, glossary entries, `vercel.json` CSP

Tests use fixed dates, in the areas the task lists (validation, CAPTCHA failure, rate limit, cap, generic response,
filter policy, mapping, per-category rule with re-issue / extension / upgrade / new, 900 guard, ops isolation).

Then `/security-review`, fixes, `npm test`, `npm run check:secrets`, and a commit. No deploy.

## As built (Stage B) — differences from the design above

- **Counters:** DynamoDB provisioned **1 RCU / 1 WCU** (minimal), no auto scaling, no PITR, no streams, TTL on.
  The collector reads subscriptions with a `Scan` of this small table (no `Query`).
- **Turnstile hostnames:** the deployed endpoint accepts tokens from the Vercel hostname only (security review); `localhost`
  is only in the local default (`.env.example`).
- **Function URL permissions:** SAM (translator 1.113) generates both `lambda:InvokeFunctionUrl` and
  `lambda:InvokeFunction` (`InvokedViaFunctionUrl: true`); checked with a local transform.
- **Shared concurrency:** the account limit is 10 for all Lambdas. Scheduled functions got an explicit
  `EventInvokeConfig` (MaximumEventAgeInSeconds 3000, MaximumRetryAttempts 0) and EventBridge `RetryPolicy`
  (4 attempts, 900 s). A throttled scheduled event waits in Lambda's async queue and is retried for up to 50 min.
- **Deploy permissions:** the `weather-dev` policy would pass IAM's 6,144-character limit, so the new deploy
  permissions are a separate policy, `infra/iam/weather-dev-signups-policy.json` (like `weather-dev-cloudfront`).
- **Dashboard:** native `<dialog>` (no new dependency); `SIGNUP_URL` and `TURNSTILE_SITE_KEY` in
  `dashboard/vite.config.ts` stay empty until Stage C, which keeps the button hidden; CSP already allows Turnstile
  (`script-src` + `frame-src https://challenges.cloudflare.com`); the Function URL host is added to `connect-src` in Stage C.

## Manual steps before Stage C (owner)

1. **Cloudflare Turnstile widget** (free, no card): dash.cloudflare.com → Turnstile → Add widget.
   - Name: `us-weather-pipeline sign-ups`. Hostname: `us-weather-pipeline.vercel.app` (add `localhost` only if you want
     to try the form locally; the deployed endpoint rejects localhost tokens anyway).
   - Widget mode: **Managed**. Pre-clearance: **No**.
   - Send me the **site key** (public). Keep the **secret key** for step 2 (never paste it into chat).
2. **SSM SecureStrings** (Git Bash, deploy profile; the secret is typed, not stored in shell history):
   ```bash
   read -rs -p "Turnstile secret key: " TS; echo
   MSYS_NO_PATHCONV=1 aws ssm put-parameter --profile weather-dev --region us-east-2      --name /weather-pipeline/turnstile-secret --type SecureString      --tags Key=Project,Value=us-weather-pipeline --value "$TS"; unset TS
   MSYS_NO_PATHCONV=1 aws ssm put-parameter --profile weather-dev --region us-east-2      --name /weather-pipeline/signup-hmac-key --type SecureString      --tags Key=Project,Value=us-weather-pipeline --value "$(openssl rand -hex 32)"
   # check (names only, no values):
   MSYS_NO_PATHCONV=1 aws ssm describe-parameters --profile weather-dev --region us-east-2      --parameter-filters "Key=Name,Values=/weather-pipeline/turnstile-secret,/weather-pipeline/signup-hmac-key"      --query "Parameters[].[Name,Type]" --output table
   ```
3. **IAM (console, as your admin user)**. In both files replace `<ACCOUNT_ID>` with your 12-digit account ID first.
   - Policies → `weather-pipeline-boundary` → Edit → JSON → paste `infra/iam/weather-pipeline-boundary.json` → Save.
     (IAM keeps 5 versions; delete the oldest non-default version first if it refuses.)
   - Policies → Create policy → JSON → paste `infra/iam/weather-dev-signups-policy.json` → name `weather-dev-signups`
     → Create; then Users → `weather-dev` → Add permissions → Attach policies directly → `weather-dev-signups`.
4. **Later, once the concurrency increase is granted:** deploy with `SignupReservedConcurrency=2`.
