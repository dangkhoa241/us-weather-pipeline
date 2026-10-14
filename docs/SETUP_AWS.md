# AWS setup (Stage 6a)

Rebuild guide: how to deploy this part of the project from scratch. For how it works and why, see [docs/architecture/nws-collector.md](architecture/nws-collector.md), [live-publishing.md](architecture/live-publishing.md), [alerts-and-signups.md](architecture/alerts-and-signups.md) and [security.md](architecture/security.md).

## Objective

Deploy the `weather-pipeline` SAM stack (`infra/template.yaml`) to region **us-east-2 (Ohio)** on the AWS **Free plan**,
in five parts:

| Part | Step | What it adds |
|---|---|---|
| 1 | 8 | SNS topic `weather-pipeline-alerts` with an email subscription (pipeline failures, heat alerts) |
| 2 | 9 | Private S3 bucket `weather-pipeline-raw-<ACCOUNT_ID>`: 30-day raw archive |
| 3 | 10 | Lambda `weather-pipeline-nws-collector` on two EventBridge schedules (replaces the GitHub Actions schedules) |
| 4 | 11 | Lambda `weather-pipeline-dashboard-publisher`, live dashboard files in S3, CloudFront distribution |
| 5 | 12 | Public email sign-ups: Lambda `weather-pipeline-signup` with a Function URL, SNS topic `weather-pipeline-public-alerts`, DynamoDB table `weather-pipeline-signups` |

Steps 1–7 are one-time account set-up (identities, policies, tools) done before the first deploy.

## Prerequisites

### Account

These steps were written for this account:
- a new 2026 **Free plan** account (until 2027-04-02);
- sign-in with **AWS Builder ID** (MFA on the Builder ID);
- **centralized root access** (no root password to manage);
- a zero-spend budget alert;
- region **us-east-2 (Ohio)**.

Other prerequisites:
- the Atlas cluster and database user from [SETUP_CLOUD_COLLECTION.md](SETUP_CLOUD_COLLECTION.md) (steps 1–4), for
  Part 3;
- a Cloudflare account (free, no card) for the Turnstile widget, for Part 5;
- Windows with PowerShell or Git Bash (the commands below are written for both; see [Troubleshooting](#troubleshooting)).

### Free plan facts

- **No charges on the Free plan.** Always-free allowances are used first. Anything above them is paid from the
  sign-up credits, never billed to a card.
- **The account closes automatically** when the plan ends (2027-04-02) or the credits run out, unless it is upgraded
  to a paid plan. AWS keeps the data for 90 days, then deletes it. That is why the local Docker stack stays the
  primary system: AWS only holds *copies* (SNS emails, an S3 archive with 30-day retention, the Lambdas). The
  infrastructure is code (`infra/template.yaml`), so it can be redeployed into a new account.
- **Every service used is on the Free plan.** AWS lists all of them in
  [Supported AWS services for Sign up for AWS (new)](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html):

| Service | Used for | On the Free plan? | Free-plan restriction (none affect us) |
|---|---|---|---|
| Amazon SNS | Part 1: email alerts; Part 5: subscriber emails | ✅ listed | — |
| Amazon S3 | Part 2: raw archive, SAM artifacts | ✅ listed | no Cross-Region Replication, Multi-Region Access Points or Access Grants |
| AWS Lambda | Part 3: NWS alerts + forecasts collector; Parts 4–5 | ✅ listed | no Lambda@Edge |
| Amazon EventBridge | Part 3: hourly + every-3-hours schedules | ✅ listed | — |
| Amazon CloudWatch Logs | Part 3: Lambda logs (7-day retention) | ✅ listed | (CloudWatch: no cross-account / cross-Region dashboards) |
| Amazon CloudFront | Part 4: serves the live dashboard JSON (OAC, PriceClass_100) | ✅ listed (checked 2026-10-02) | no Lambda@Edge (not used) |
| AWS CloudFormation | AWS SAM deploys through it | ✅ listed | no StackSets |
| AWS IAM, AWS STS | the `weather-dev` user, `aws sts get-caller-identity` | ✅ listed | — |
| AWS Systems Manager (Parameter Store) | Parts 3 and 5: config/secrets (standard parameters) | ✅ listed | (multi-account multi-Region data syncs) |

DynamoDB (Part 5) uses its always-free provisioned capacity; see the free-tier table in [ROADMAP.md](ROADMAP.md).

Not on the new sign-up experience: IAM Identity Center, IAM Access Analyzer and AWS Organizations. That is why this
guide uses a plain IAM user with an access key for the CLI. Joining AWS Organizations would also switch the account to
a paid plan, so don't.

### Cost guard (also in CLAUDE.md)

- Free plan only; anything that needs a paid plan → stop and ask.
- Never: NAT Gateway, EC2, public IPv4 / Elastic IPs, load balancers, RDS, KMS customer-managed keys, Secrets Manager,
  more than 10 CloudWatch custom metrics, or anything without a free tier.
- Always: S3 with SSE-S3 + a lifecycle rule; SSM Parameter Store (standard); 7-day log retention; Lambda 128–256 MB
  with short timeouts; EventBridge at most hourly; tag `Project=us-weather-pipeline`.
- Before every `sam deploy`: a list of the resources, their free-tier limits and the expected monthly use, and the
  owner's OK.

## Procedure

### Step 1. Find the account ID

Open the account menu (top right of the console) and copy the 12-digit **Account ID**. It goes into the policies in
step 2. It isn't a secret, but it stays out of the repository: the repo only has `<ACCOUNT_ID>`.

### Step 2. Create the policies (boundary, deploy, runtime)

Everything is limited to **us-east-2** and to resources named `weather-pipeline-*` (plus the bucket AWS SAM creates
for uploads). Three policies are created now and cover Parts 1–3; a fourth is added in step 11 and a fifth in step 12.

| Policy (file in `infra/iam/`) | Attached to | What it allows |
|---|---|---|
| **`weather-pipeline-boundary`** ([json](../infra/iam/weather-pipeline-boundary.json)) | every role the stack creates (permissions boundary) | the most a Lambda role can ever do: write its logs, publish to the alerts topic, read/write archive objects, read `/weather-pipeline/` parameters (plus the sign-up rights added in step 12) |
| **`weather-dev-pipeline`** ([json](../infra/iam/weather-dev-policy.json)) | user `weather-dev` (deploys) | deploy/delete the stack with SAM; create roles **only with the boundary attached**; pass roles only to Lambda |
| **`weather-dev-cloudfront`** ([json](../infra/iam/weather-dev-cloudfront-policy.json)) | user `weather-dev` (Part 4, step 11) | create/update/delete the dashboard's CloudFront distribution, origin access control and response headers policy (separate because `weather-dev-pipeline` is at IAM's 6,144-character limit) |
| **`weather-dev-signups`** ([json](../infra/iam/weather-dev-signups-policy.json)) | user `weather-dev` (Part 5, step 12) | the sign-up DynamoDB table, Function URL and related Lambda settings |
| **`weather-runtime-pipeline`** ([json](../infra/iam/weather-runtime-policy.json)) | user `weather-runtime` (the app) | `sns:Publish` on the alerts topic; `s3:PutObject` to the archive (Part 2). Nothing else. |

Why the boundary: without it, a leaked deploy key could create a `weather-pipeline-*` role with an admin inline policy
and take over the account. With it, every such role is capped by `weather-pipeline-boundary`. The deploy user
can't change or remove the boundary.

For each of the first three files, **boundary first** (the deploy policy refers to it):
1. Open the JSON file and replace every `<ACCOUNT_ID>` with the account ID. Do this in a copy outside the repo,
   or undo it before committing.
2. Console → **IAM → Policies → Create policy → JSON**. Paste the edited JSON, then choose **Next**.
3. Name it exactly as in the table (`weather-pipeline-boundary`, `weather-dev-pipeline`, `weather-runtime-pipeline`),
   then choose **Create policy**.

### Step 3. Create two IAM users and block public S3 access

1. **IAM → Users → Create user**: **`weather-dev`**. Leave "Provide user access to the AWS Management Console"
   **unchecked** (CLI only). **Attach policies directly** → only **`weather-dev-pipeline`** → **Create user**.
2. Again for **`weather-runtime`** with only **`weather-runtime-pipeline`**.
3. **S3 → Block Public Access settings for this account → Edit** → tick **Block all public access → Save**.
   It's free, and no bucket in this account can then be made public by mistake.

### Step 4. Create an access key for each user

1. **IAM → Users → weather-dev → Security credentials → Create access key** → use case
   **Command Line Interface (CLI)** → tick the confirmation → **Create access key**.
2. Keep the page open for step 6. **Don't download the .csv** (if it was downloaded, delete it after step 6). The
   secret is shown only once; if it's lost, deactivate the key and create a new one.
3. Repeat for **weather-runtime** when step 6 needs it.

### Step 5. Install the AWS CLI and AWS SAM CLI

In PowerShell:

```powershell
winget install -e --id Amazon.AWSCLI
winget install -e --id Amazon.SAM-CLI
```

(Or use the MSI installers: [AWS CLI v2](https://awscli.amazonaws.com/AWSCLIV2.msi) and
[AWS SAM CLI](https://github.com/aws/aws-sam-cli/releases/latest/download/AWS_SAM_CLI_64_PY3.msi).)

Open a **new** terminal, then check both:

```powershell
aws --version     # aws-cli/2.x
sam --version     # SAM CLI, version 1.x
```

Git Bash users: read [Troubleshooting](#troubleshooting) before running `aws` commands with `/aws/...` arguments.

### Step 6. Configure the two CLI profiles (credentials stay outside the repo)

**Deploy profile** (in the default `~/.aws`):

```powershell
aws configure --profile weather-dev
#   AWS Access Key ID / Secret Access Key: <from step 4, weather-dev>
#   Default region name:    us-east-2
#   Default output format:  json
aws sts get-caller-identity --profile weather-dev     # ...:user/weather-dev
```

**Runtime profile**, in its own folder `~/.aws-runtime`, so the app and the Docker fetcher never see the deploy keys:

```powershell
$env:AWS_SHARED_CREDENTIALS_FILE = "$HOME\.aws-runtime\credentials"
$env:AWS_CONFIG_FILE = "$HOME\.aws-runtime\config"
aws configure --profile weather-runtime               # keys from step 4 (weather-runtime), us-east-2, json
aws sts get-caller-identity --profile weather-runtime # ...:user/weather-runtime
Remove-Item Env:AWS_SHARED_CREDENTIALS_FILE, Env:AWS_CONFIG_FILE
```

Then add these lines to the local **`.env`**. It is git-ignored and holds no secrets, only names and paths:

```dotenv
AWS_PROFILE=weather-runtime
AWS_SHARED_CREDENTIALS_FILE=C:/Users/<you>/.aws-runtime/credentials
AWS_CONFIG_FILE=C:/Users/<you>/.aws-runtime/config
AWS_DEPLOY_PROFILE=weather-dev            # npm run aws:deploy / aws:teardown use ~/.aws with this profile
AWS_REGION=us-east-2
ALERT_EMAIL=<email address for SNS alerts>
AWS_CONFIG_DIR=C:/Users/<you>/.aws-runtime   # mounted read-only into the Docker fetcher
```

### Step 7. Credential rules (enforced)

- Keys live **only** in `~/.aws` (deploy) and `~/.aws-runtime` (runtime). Never put them in `.env`, code, docs,
  CI or chat.
- `npm run check:secrets` fails on AWS access key IDs (`AKIA…`, `ASIA…`), secret access keys and session tokens
  anywhere in the git history or working tree.
- `.gitignore` covers `.aws/`, `*accessKeys*.csv` (the console download) and `.aws-sam/` (SAM build output).
- The Docker fetcher gets only `~/.aws-runtime`, read-only, and only when `AWS_CONFIG_DIR` is set. `scripts/aws.js`
  removes the runtime variables before calling SAM, so deploys always use `weather-dev` from `~/.aws`.
- **Rotate** both keys every 90 days: create a new key, run `aws configure` for that profile, then deactivate and
  delete the old key. If a key ever leaks, deactivate it first, then check CloudTrail **Event history**.

### Step 8. Part 1: SNS alerts topic

1. `npm run aws:validate` (template lint, no AWS changes).
2. `npm run aws:deploy`. It creates the `weather-pipeline` stack: the SNS topic and the email subscription for
   `ALERT_EMAIL`.
3. **Confirm the subscription** from the email AWS sends ("AWS Notification - Subscription Confirmation").
4. Set `NOTIFIER=sns` and `SNS_TOPIC_ARN=<AlertsTopicArn stack output>` in `.env`.
5. Verify: [Verification, Part 1](#part-1-sns).

### Step 9. Part 2: S3 raw archive

The stack adds a private bucket `weather-pipeline-raw-<ACCOUNT_ID>`: Block Public Access on, ACLs disabled, SSE-S3,
HTTPS only, versioning off, objects deleted after 30 days. Stage 1 uploads one gzipped NDJSON file per source and run
(`<source>/<yyyy>/<mm>/<dd>/<HHMMSS>Z-<batch>.json.gz`, one `{ url, fetched_at, body }` per line). The bulk
`om-backfill` catch-up is not archived.

1. **Update two policies by hand** (IAM → Policies → the policy → **Edit** → JSON; replace `<ACCOUNT_ID>` as in step 2):
   - `weather-dev-pipeline`: the Part 2 statement now also allows `s3:DeleteObject`, so `npm run aws:teardown` can
     empty the bucket before deleting it.
   - `weather-runtime-pipeline`: `s3:PutObject` is narrowed from `weather-pipeline-raw-*/*` to the bucket
     `weather-pipeline-raw-<ACCOUNT_ID>/*`.
2. `npm run aws:deploy` (review the change set, then `y`).
3. In `.env`: `RAW_ARCHIVE=s3` and `RAW_ARCHIVE_BUCKET=<RawArchiveBucketName output>`; restart the fetcher
   (`docker compose up -d fetcher`).
4. Verify: [Verification, Part 2](#part-2-s3-raw-archive).

### Step 10. Part 3: NWS collection on Lambda (replaces the GitHub Actions schedules)

GitHub skips or delays scheduled workflows, so NWS collection runs on a Lambda, `weather-pipeline-nws-collector`
(Node.js 22, arm64, 256 MB, 5 min timeout, **no VPC**, so no NAT Gateway). Two EventBridge rules invoke it:
`weather-pipeline-nws-alerts` (hourly at :23, `{"mode":"alerts"}`) and `weather-pipeline-nws-forecasts`
(every 3 h at :07, `{"mode":"forecast"}`). It writes to the same Atlas collections as the workflows (7-day TTL),
archives the raw responses to `s3://weather-pipeline-raw-<ACCOUNT_ID>/nws-*`, and emails a failed run through SNS.
Logs: `/aws/lambda/weather-pipeline-nws-collector`, kept 7 days. The function's role (with the boundary) may only:
`ssm:GetParameter` on the Atlas parameter, `s3:PutObject` on `nws-*` in the bucket, `sns:Publish` on the alerts topic,
and write its own logs (Part 5 adds the subscriber-topic and sign-up-table rights).

1. **Update `weather-dev-pipeline`** (IAM → Policies → Edit → JSON, `<ACCOUNT_ID>` replaced as in step 2). New:
   `s3:GetObjectVersion` (SAM artifacts), `lambda:GetPolicy`, `lambda:ListVersionsByFunction`,
   `lambda:GetRuntimeManagementConfig`, `lambda:GetFunctionCodeSigningConfig`, `iam:ListRolePolicies`,
   `iam:ListAttachedRolePolicies`, `events:ListTargetsByRule`, `logs:TagLogGroup`, `logs:ListTagsLogGroup`.
   The boundary and runtime policies don't change.
2. **Store the Atlas URI in SSM** (the same value as the GitHub secret `ATLAS_MONGO_URI`). Console → **Systems
   Manager → Parameter Store → Create parameter**:
   - Name `/weather-pipeline/atlas-mongo-uri`, Tier **Standard**, Type **SecureString**,
     KMS key source **My current account**, KMS key ID **`alias/aws/ssm`** (the AWS-managed key: free, no customer key);
   - Value: the `mongodb+srv://...` string; Tags: `Project` = `us-weather-pipeline` → **Create parameter**.

   The console keeps the value out of shell history. To rotate the Atlas password later, edit the value; the Lambda
   picks it up on its next cold start or after the next failed run.
3. **Atlas network access** must allow Lambda's changing IPs: `0.0.0.0/0` is already there for GitHub Actions
   ([SETUP_CLOUD_COLLECTION.md](SETUP_CLOUD_COLLECTION.md), step 3); keep it.
4. **`.env`**: `NWS_USER_AGENT` must contain a contact (it is passed to the Lambda as a stack parameter).
5. `npm run aws:deploy` (it bundles the function with esbuild, then shows the change set; review it, then `y`).
6. Verify: [Verification, Part 3](#part-3-nws-collector).
7. **After a day of good scheduled runs**, turn off the GitHub schedules: remove the `schedule:` block from
   `.github/workflows/nws-alerts.yml` and `nws-forecasts.yml` (keep `workflow_dispatch` as a manual fallback).
8. **S3 PUT cap for the local fetcher.** The Lambda archives up to 16 objects a day (alerts once per 3-hour UTC slot +
   8 forecast runs; its own cap, ledger in Atlas). The local fetcher no longer runs NWS alerts or forecasts
   (`ALERTS_CRON` and `FORECAST_CRON` are `"off"` in docker-compose; both arrive through sync-atlas), so set its cap
   in `.env` to `RAW_ARCHIVE_MAX_PUTS_PER_DAY=10` (~6 a day expected: Open-Meteo forecast 4, history 1, baseline 1).
   For the archive alone that is ~660 PUTs a month expected (33%), ≤ 806 even at both caps (40% of the free 2,000).
   The whole-account budget, with Part 4, is in the table below.

**S3 PUT budget (free tier: 2,000 a month, shared by everything in the account)**

| Writer | Per day | Expected / month | Hard cap / day → month |
|---|---|---|---|
| NWS collector Lambda (archive: alerts every 3 h + 8 forecast runs) | 16 | 480 | 16 → 496 (`RAW_ARCHIVE_MAX_PUTS_PER_DAY` in the template) |
| Local fetcher (archive: Open-Meteo forecast 4, history 1, baseline 1) | ~6 | ~180 | 10 → 310 (`.env`) |
| Dashboard publisher Lambda (Part 4: 8 runs × 2 files + `recent.json` once) | 17 | 510 | 17 → 527 (`DASHBOARD_MAX_PUTS_PER_DAY`) |
| Dashboard publisher Lambda (`status.json`, every run, since 2026-10-13) | 8 | 240 | 10 → 310 (`STATUS_MAX_PUTS_PER_DAY` in `src/lambda/dashboardPublisher.js`) |
| **Total** | ~47 | **~1,410 (71%)** | **≤ 1,643 (82%)** |

Each cap is a ledger in MongoDB (Atlas for the Lambdas, local for the fetcher). Past it, uploads are skipped and
logged, and the publisher sends an SNS email. S3 GETs: only CloudFront cache misses read the dashboard files,
at most a few per edge location every 30 min (~3,000 a month expected, 15% of the free 20,000).

### Step 11. Part 4: live dashboard data (S3 + CloudFront, design B)

**Status: live since 2026-10-07** (`DashboardDataUrl` = `https://d1dl5jm7af48m2.cloudfront.net`). The first deploy
(2026-10-02) was refused because new accounts must be verified for CloudFront; see [Troubleshooting](#troubleshooting).

A second Lambda, `weather-pipeline-dashboard-publisher` (Node.js 22, arm64, 256 MB, 4 min timeout, no VPC), writes four
JSON files to `s3://weather-pipeline-raw-<ACCOUNT_ID>/dashboard/`. A CloudFront distribution serves **only that prefix**.
CloudFront signs its requests with Origin Access Control, and the bucket policy allows `s3:GetObject` on `dashboard/*`
only from that one distribution (`AWS:SourceArn`). The bucket stays private and Block Public Access stays fully on.
The raw archive (`nws-*/`, `open-meteo-*/`) can't be read through CloudFront.

| File | Content | Written | `Cache-Control` |
|---|---|---|---|
| `recent.json` | last 60 days of daily temperature/precipitation per city + All US (Open-Meteo archive) | daily 06:35 UTC | `max-age=900, s-maxage=10800` |
| `forecasts.json` | latest hourly forecast per model (NWS from Atlas, 4 Open-Meteo models) + NWS day/night periods | every 3 h at :35 | `max-age=300, s-maxage=1800` |
| `alerts.json` | active NWS alerts (from Atlas) | every 3 h at :35 | `max-age=300, s-maxage=1800` |
| `status.json` | job health, freshness and incidents of the last 7 days (Ops page) | every 3 h at :35 | `max-age=300, s-maxage=1800` |

The cache times follow the schedule. CloudFront keeps a file for at most about 1/6 of the time until the next upload
(30 min of a 3-hour cycle, 3 h of a day), and the browser keeps it for 5–15 min. There are no invalidations, so no
extra requests are needed.

The dashboard (Vercel) loads its bundled snapshot first, then tries `recent.json` from CloudFront (4 s timeout,
validated with Zod). The live days are laid over the bundled daily files, and the header shows **Live · history through
…** (Forecast page: "forecast updated …", Accuracy page: "scored through …"). If CloudFront fails, times out or
returns something unexpected, the bundled data stays and the header shows **Snapshot · …** with the same wording.
Forecasts and alerts fall back on their own in the same way. Forecast accuracy always comes from the bundled snapshot
(it needs the local ClickHouse history).

CloudFront settings: PriceClass_100, the default `*.cloudfront.net` certificate, `https-only`, GET/HEAD only,
compression on, and the managed `CachingOptimized` cache policy. There is no WAF, no custom domain, no Route 53, no
access or real-time logs, and no Lambda@Edge or CloudFront Functions. CORS comes from a response headers policy (a
custom one, because the AWS-managed CORS policies allow every origin). It allows only `https://us-weather-pipeline.vercel.app`
(stack parameter `DashboardOrigin`), `http://localhost:5173` and `http://localhost:4173`, with no credentials, and adds
`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and HSTS.

The function's role (with the boundary) may only call `ssm:GetParameter` on the Atlas parameter, `s3:PutObject` on
`dashboard/*` (no read, list or delete), `sns:Publish` on the alerts topic, and write its own logs. The boundary and
runtime policies don't change.

1. **Create the fourth policy, `weather-dev-cloudfront`, and attach it to `weather-dev`.** `weather-dev-pipeline` is
   at IAM's 6,144-character limit for a managed policy, so the CloudFront permissions live in their own file,
   [weather-dev-cloudfront-policy.json](../infra/iam/weather-dev-cloudfront-policy.json).
   - IAM → Policies → Create policy → JSON, with `<ACCOUNT_ID>` replaced as in step 2.
   - Name it `weather-dev-cloudfront`.
   - IAM → Users → weather-dev → Add permissions → Attach policies directly.

   It covers create/read/update/delete/tag for CloudFront distributions, origin access controls and response headers
   policies in this account: the permissions CloudFormation's handlers use for these three resource types. The schema
   also lists `cloudfront:CreateDistributionWithTags`, but the IAM console flags it as invalid, so it's left out
   (`CreateDistribution` + `TagResource` cover it).

   The same file has a second statement, `ReadLambdaLogs`: `logs:FilterLogEvents` and `logs:GetLogEvents` on
   `/aws/lambda/weather-pipeline-*` (used by `aws logs tail`). It is redundant, because `weather-dev-pipeline`
   already grants both actions, but harmless. It was added while chasing an AccessDenied that turned out to be Git
   Bash rewriting the log group path (see [Troubleshooting](#troubleshooting)).
2. `npm run aws:deploy` (review the change set, then `y`). Creating a distribution takes ~5 min.
3. Verify: [Verification, Part 4](#part-4-live-dashboard-data).
4. Put the stack output `DashboardDataUrl` in `dashboard/vite.config.ts` (`LIVE_DATA_URL`) and add it to `connect-src`
   in `dashboard/vercel.json`, then push (Vercel rebuilds). The header should then show **Live**.

### Step 12. Part 5: public email sign-ups

**Status: deployed 2026-10-08.** Design and limits: [analysis/email-signups.md](analysis/email-signups.md).
Visitors sign up on the dashboard. A Lambda behind a **Function URL** (`weather-pipeline-signup`, 128 MB, 8 s, no VPC,
no API Gateway) checks the request, verifies Cloudflare Turnstile and subscribes the email to a separate SNS topic,
`weather-pipeline-public-alerts`, with a filter policy (`city` + `category`). The collector publishes subscriber
alerts there; pipeline failures stay on `weather-pipeline-alerts`. Counters live in the DynamoDB table
`weather-pipeline-signups` (provisioned 1/1, TTL on, no auto scaling, PITR or streams).

1. **Turnstile widget** (free, no card): dash.cloudflare.com → Turnstile → Add widget; hostname
   `us-weather-pipeline.vercel.app`, mode Managed, pre-clearance No. The **site key** is public (it goes in
   `dashboard/vite.config.ts`); the **secret key** goes only into SSM (next step).
2. **SSM SecureStrings** (Git Bash; the secret is typed, not kept in shell history):

   ```bash
   read -rs -p "Turnstile secret key: " TS; echo
   MSYS_NO_PATHCONV=1 aws ssm put-parameter --profile weather-dev --region us-east-2 \
     --name /weather-pipeline/turnstile-secret --type SecureString \
     --tags Key=Project,Value=us-weather-pipeline --value "$TS"; unset TS
   MSYS_NO_PATHCONV=1 aws ssm put-parameter --profile weather-dev --region us-east-2 \
     --name /weather-pipeline/signup-hmac-key --type SecureString \
     --tags Key=Project,Value=us-weather-pipeline --value "$(openssl rand -hex 32)"
   ```
3. **IAM (console):** add the three `PublicSignups*` statements of
   [weather-pipeline-boundary.json](../infra/iam/weather-pipeline-boundary.json) to the boundary (the SNS rights name
   the public topic exactly), and create and attach the fifth deploy policy, `weather-dev-signups`
   ([weather-dev-signups-policy.json](../infra/iam/weather-dev-signups-policy.json): DynamoDB table, Function URL,
   concurrency and async-invoke settings, `lambda:GetAccountSettings`, and `SetSubscriptionAttributes` on the public
   topic for the owner's test subscription). Replace `<ACCOUNT_ID>` as in step 2.
4. `npm run aws:deploy -- --no-execute-changeset`, review, then execute. Put the stack output `SignupUrl` in
   `dashboard/vite.config.ts` (`SIGNUP_URL`, next to `TURNSTILE_SITE_KEY`) and its host in `connect-src` in
   `dashboard/vercel.json`, then push (Vercel rebuilds; the "Get alerts" button appears).
5. Verify: [Verification, Part 5](#part-5-email-sign-ups).
6. **Shared Lambda concurrency:** the account limit was 10 at deploy time (Lambda keeps 10 unreserved), so the sign-up
   function has no reserved concurrency. After a quota increase, deploy with `SignupReservedConcurrency=2` added to
   the parameter overrides. Scheduled Lambdas retry throttled events from the async queue for up to 50 min
   (`EventInvokeConfig`).

## Verification

Run the checks as `weather-dev`. In Git Bash, prefix commands that take `/aws/...` paths with
`MSYS_NO_PATHCONV=1 PYTHONUTF8=1` (see [Troubleshooting](#troubleshooting)).

### Part 1: SNS

- `aws sts get-caller-identity --profile weather-dev` and `--profile weather-runtime` print the two users.
- The subscription is confirmed, and a test alert sent as `weather-runtime` arrives by email.

### Part 2: S3 raw archive

After the next forecast run, the fetcher log shows `[archive:s3] nws-forecast/... : 106 response(s), ... KB`. A failed
upload only logs a warning; the pipeline goes on.

### Part 3: NWS collector

```powershell
aws lambda invoke --function-name weather-pipeline-nws-collector --payload '{\"mode\":\"alerts\"}' `
  --cli-binary-format raw-in-base64-out --profile weather-dev --region us-east-2 out.json; Get-Content out.json
aws logs tail /aws/lambda/weather-pipeline-nws-collector --since 15m --profile weather-dev --region us-east-2
```

Expect `"status":"success"` and `[archive:s3] nws-alerts/...` in the log. Do the same with `forecast`, then check that
`npm run sync:atlas` brings the new rows home. Delete `out.json`.

### Part 4: live dashboard data

```powershell
aws lambda invoke --function-name weather-pipeline-dashboard-publisher --payload '{\"parts\":[\"history\",\"forecasts\",\"alerts\"]}' `
  --cli-binary-format raw-in-base64-out --profile weather-dev --region us-east-2 out.json; Get-Content out.json
curl.exe -sI https://<DashboardDataUrl>/recent.json -H "Origin: https://us-weather-pipeline.vercel.app"
```

Expect `"status":"success"`, then `200`, `access-control-allow-origin: https://us-weather-pipeline.vercel.app` and
the `cache-control` from the table in step 11. `https://<DashboardDataUrl>/../nws-alerts/` and other prefixes must
return `403`. Delete `out.json`. After step 11.4, the dashboard header shows **Live**.

### Part 5: email sign-ups

No subscription is created by these checks:

```bash
U=<SignupUrl>
curl -s -w ' %{http_code}\n' "$U"                                                              # 405
curl -s -w ' %{http_code}\n' -X POST -H 'content-type: application/json' --data '{nope' "$U"   # 400
MSYS_NO_PATHCONV=1 PYTHONUTF8=1 aws logs tail /aws/lambda/weather-pipeline-signup --since 15m --profile weather-dev --region us-east-2
```

Logs show outcome codes only (`[signup] invalid`, `captcha_failed (...)`, `ok v***@e***.com ...`), never an address
or IP.

## Rollback

There is no per-part rollback: Parts 1–5 are one CloudFormation stack. Every `npm run aws:deploy` shows a change set
before anything changes, so a deploy can be stopped there. To remove the deployment:

**`npm run aws:teardown`** empties the raw archive bucket (`aws s3 rm --recursive`; CloudFormation can't delete a
non-empty bucket), then runs `sam delete` for the `weather-pipeline` stack (it asks for confirmation). This deletes
every resource the stack created, plus the code SAM uploaded. Versioning is off, so the deleted archive objects are
gone.

Not removed by teardown (manual, delete by hand when done with AWS):
- the three SSM parameters `/weather-pipeline/atlas-mongo-uri`, `/weather-pipeline/turnstile-secret` and
  `/weather-pipeline/signup-hmac-key` (steps 10 and 12);
- the IAM users, policies and access keys (steps 2–4, 11 and 12);
- the Turnstile widget in Cloudflare (step 12).

All stack resources carry the tag `Project=us-weather-pipeline`, so leftovers are easy to find in
**Resource Groups & Tag Editor**.

After teardown, `.env` still names the deleted topic and bucket (`NOTIFIER=sns`, `SNS_TOPIC_ARN`, `RAW_ARCHIVE=s3`,
`RAW_ARCHIVE_BUCKET` from steps 8 and 9); remove those lines to go back to the local defaults. NWS collection stops
with the Lambda; the GitHub workflows only run on demand unless their `schedule:` blocks (removed in step 10.7) are
restored.

## Troubleshooting

### Windows / Git Bash

Two things break AWS CLI commands in Git Bash:
- **Path rewriting.** Git Bash turns arguments that start with `/` into Windows paths, so `/aws/lambda/...` reaches
  AWS as `C:/Program Files/Git/aws/lambda/...`. The command then fails with a misleading `AccessDenied` on that wrong
  resource. Set `MSYS_NO_PATHCONV=1` for commands that take `/aws/...` (or other `/...`) arguments. PowerShell is not
  affected.
- **Output encoding.** The CLI prints with the Windows code page and crashes on characters like "→" in log lines
  (`'charmap' codec can't encode character`). Force UTF-8 mode with `PYTHONUTF8=1`. `PYTHONIOENCODING=utf-8` alone
  is not enough: `aws logs tail` still crashed with it on 2026-10-07, in PowerShell too; `PYTHONUTF8=1` fixed it.

```bash
MSYS_NO_PATHCONV=1 PYTHONUTF8=1 aws logs tail /aws/lambda/weather-pipeline-nws-collector --since 1h \
  --profile weather-dev --region us-east-2
```

`scripts/aws.js` needs neither: it runs `aws`/`sam` without a shell, so nothing rewrites its arguments, and it runs
no `aws logs` commands.

### CloudFront: "Your account must be verified before you can add new CloudFront resources"

New accounts must be verified for CloudFront. The first Part 4 deploy (2026-10-02) was refused with this message; a
free AWS Support case (Account and billing) lifted the restriction. Open the case, and redeploy once it's resolved.

### Sign-up logs show `captcha_failed (not_success:invalid-input-secret)`

The Turnstile secret in SSM is wrong. Put the correct value in `/weather-pipeline/turnstile-secret`; the function
drops its cached secrets after this error and reads SSM again on the next request.

### IAM refuses to save a policy edit

IAM keeps 5 versions of a managed policy. Delete the oldest non-default version first
([analysis/email-signups.md](analysis/email-signups.md), manual steps).

### Sign-up function has no reserved concurrency

Expected while the account's concurrency limit is 10 (see step 12.6).
