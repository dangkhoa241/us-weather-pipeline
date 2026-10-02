# AWS setup (Stage 6a): manual steps

These are the one-time steps **you** do in the AWS console and on your Windows PC before anything is deployed.
They are written for this account:
- a new 2026 **Free plan** account (until 2027-04-02);
- sign-in with **AWS Builder ID** (MFA on the Builder ID);
- **centralized root access** (no root password to manage);
- a zero-spend budget alert;
- region **us-east-2 (Ohio)**.

When you're done, tell Claude Code and it will deploy Part 1 with `npm run aws:deploy`.

## 0. Before you start: Free plan facts

- **No charges on the Free plan.** Always-free allowances are used first. Anything above them is paid from the
  sign-up credits, never billed to a card.
- **The account closes automatically** when the plan ends (2027-04-02) or the credits run out, unless you upgrade
  to a paid plan. AWS keeps the data for 90 days, then deletes it. That's why the local Docker stack stays the
  primary system: AWS only gets *copies* (SNS emails, an S3 archive with 30-day retention, one Lambda). The
  infrastructure is code (`infra/template.yaml`), so it can be redeployed into a new account.
- **Every planned service is on the Free plan.** AWS lists all of them in
  [Supported AWS services for Sign up for AWS (new)](https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html):

| Service | Used for | On the Free plan? | Free-plan restriction (none affect us) |
|---|---|---|---|
| Amazon SNS | Part 1: email alerts | ✅ listed | — |
| Amazon S3 | Part 2: raw archive, SAM artifacts | ✅ listed | no Cross-Region Replication, Multi-Region Access Points or Access Grants |
| AWS Lambda | Part 3: NWS alerts + forecasts collector | ✅ listed | no Lambda@Edge |
| Amazon EventBridge | Part 3: hourly + every-3-hours schedules | ✅ listed | — |
| Amazon CloudWatch Logs | Part 3: Lambda logs (7-day retention) | ✅ listed | (CloudWatch: no cross-account / cross-Region dashboards) |
| AWS CloudFormation | AWS SAM deploys through it | ✅ listed | no StackSets |
| AWS IAM, AWS STS | the `weather-dev` user, `aws sts get-caller-identity` | ✅ listed | — |
| AWS Systems Manager (Parameter Store) | Part 3: config/secrets (standard parameters) | ✅ listed | (multi-account multi-Region data syncs) |

Not on the new experience: IAM Identity Center, IAM Access Analyzer and AWS Organizations. That's why this guide
uses a plain IAM user with an access key for the CLI. Joining AWS Organizations would also switch the account to
a paid plan, so don't.

## 1. Find your account ID

Open the account menu (top right of the console) and copy the 12-digit **Account ID**. You'll paste it into the
policy in the next step. It isn't a secret, but it stays out of the repository: the repo only has `<ACCOUNT_ID>`.

## 2. Create three policies (boundary, deploy, runtime)

Everything is limited to **us-east-2** and to resources named `weather-pipeline-*` (plus the bucket AWS SAM creates
for uploads). The policies cover Parts 1–3, so you only set them up once.

| Policy (file in `infra/iam/`) | Attached to | What it allows |
|---|---|---|
| **`weather-pipeline-boundary`** ([json](../infra/iam/weather-pipeline-boundary.json)) | every role the stack creates (permissions boundary) | the most a Lambda role can ever do: write its logs, publish to the alerts topic, read/write archive objects, read `/weather-pipeline/` parameters |
| **`weather-dev-pipeline`** ([json](../infra/iam/weather-dev-policy.json)) | user `weather-dev` (deploys) | deploy/delete the stack with SAM; create roles **only with the boundary attached**; pass roles only to Lambda |
| **`weather-runtime-pipeline`** ([json](../infra/iam/weather-runtime-policy.json)) | user `weather-runtime` (the app) | `sns:Publish` on the alerts topic; `s3:PutObject` to the archive (Part 2). Nothing else. |

Why the boundary: without it, a leaked deploy key could create a `weather-pipeline-*` role with an admin inline policy
and take over the account. With it, every such role is capped by `weather-pipeline-boundary`. The deploy user
can't change or remove the boundary.

Steps (repeat for each file, **boundary first**, because the deploy policy refers to it):
1. Open the JSON file and replace every `<ACCOUNT_ID>` with your account ID. Do this in a copy outside the repo,
   or undo it before committing.
2. Console → **IAM → Policies → Create policy → JSON**. Paste the edited JSON, then choose **Next**.
3. Name it exactly as in the table (`weather-pipeline-boundary`, `weather-dev-pipeline`, `weather-runtime-pipeline`),
   then choose **Create policy**.

## 3. Create two IAM users and block public S3 access

1. **IAM → Users → Create user**: **`weather-dev`**. Leave "Provide user access to the AWS Management Console"
   **unchecked** (CLI only). **Attach policies directly** → only **`weather-dev-pipeline`** → **Create user**.
2. Again for **`weather-runtime`** with only **`weather-runtime-pipeline`**.
3. **S3 → Block Public Access settings for this account → Edit** → tick **Block all public access → Save**.
   It's free, and it means no bucket in this account can ever be made public by mistake.

## 4. Create an access key for each user

1. **IAM → Users → weather-dev → Security credentials → Create access key** → use case
   **Command Line Interface (CLI)** → tick the confirmation → **Create access key**.
2. Keep the page open for step 6. **Don't download the .csv** (if you did, delete it after step 6). The secret is
   shown only once; if it's lost, deactivate the key and create a new one.
3. Repeat for **weather-runtime** when you get to step 6.

## 5. Install the AWS CLI and AWS SAM CLI on Windows

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

## 6. `aws configure` (credentials stay outside the repo)

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

Then add these lines to your local **`.env`**. It is git-ignored and holds no secrets, only names and paths:

```dotenv
AWS_PROFILE=weather-runtime
AWS_SHARED_CREDENTIALS_FILE=C:/Users/<you>/.aws-runtime/credentials
AWS_CONFIG_FILE=C:/Users/<you>/.aws-runtime/config
AWS_DEPLOY_PROFILE=weather-dev            # npm run aws:deploy / aws:teardown use ~/.aws with this profile
AWS_REGION=us-east-2
ALERT_EMAIL=<your email for SNS alerts>
AWS_CONFIG_DIR=C:/Users/<you>/.aws-runtime   # mounted read-only into the Docker fetcher
```

## 7. Credential rules (enforced)

- Keys live **only** in `~/.aws` (deploy) and `~/.aws-runtime` (runtime). Never put them in `.env`, code, docs,
  CI or chat.
- `npm run check:secrets` fails on AWS access key IDs (`AKIA…`, `ASIA…`), secret access keys and session tokens
  anywhere in the git history or working tree.
- `.gitignore` covers `.aws/`, `*accessKeys*.csv` (the console download) and `.aws-sam/` (SAM build output).
- The Docker fetcher gets only `~/.aws-runtime`, read-only, and only when `AWS_CONFIG_DIR` is set. `scripts/aws.js`
  removes the runtime variables before calling SAM, so deploys always use `weather-dev` from `~/.aws`.
- **Rotate** both keys every 90 days: create a new key, run `aws configure` for that profile, then deactivate and
  delete the old key. If a key ever leaks, deactivate it first, then check CloudTrail **Event history**.

## 8. Done? Tell Claude Code

Claude Code will then:
1. run `npm run aws:validate` (template lint, no AWS changes);
2. run `npm run aws:deploy`, which creates the `weather-pipeline` stack (Part 1: the SNS topic and your email subscription);
3. ask you to **confirm the subscription** from the email AWS sends ("AWS Notification - Subscription Confirmation");
4. set `NOTIFIER=sns` and `SNS_TOPIC_ARN=<stack output>` in `.env`, and send a test alert (as `weather-runtime`).

## 9. Part 2: S3 raw archive

The stack adds a private bucket `weather-pipeline-raw-<ACCOUNT_ID>`: Block Public Access on, ACLs disabled, SSE-S3,
HTTPS only, versioning off, objects deleted after 30 days. Stage 1 uploads one gzipped NDJSON file per source and run
(`<source>/<yyyy>/<mm>/<dd>/<HHMMSS>Z-<batch>.json.gz`, one `{ url, fetched_at, body }` per line). The bulk
`om-backfill` catch-up is not archived.

1. **Update two policies by hand** (IAM → Policies → the policy → **Edit** → JSON; replace `<ACCOUNT_ID>` as in step 2):
   - `weather-dev-pipeline`: the Part 2 statement now also allows `s3:DeleteObject`, so `npm run aws:teardown` can
     empty the bucket before deleting it.
   - `weather-runtime-pipeline`: `s3:PutObject` is narrowed from `weather-pipeline-raw-*/*` to your bucket
     `weather-pipeline-raw-<ACCOUNT_ID>/*`.
2. `npm run aws:deploy` (review the change set, then `y`).
3. In `.env`: `RAW_ARCHIVE=s3` and `RAW_ARCHIVE_BUCKET=<RawArchiveBucketName output>`; restart the fetcher
   (`docker compose up -d fetcher`).
4. After the next forecast run, the log shows `[archive:s3] nws-forecast/... : 106 response(s), ... KB`. A failed
   upload only logs a warning; the pipeline goes on.

## 10. Part 3: NWS collection on Lambda (replaces the GitHub Actions schedules)

GitHub skips or delays scheduled workflows, so NWS collection moves to a Lambda `weather-pipeline-nws-collector`
(Node.js 22, arm64, 256 MB, 5 min timeout, **no VPC**, so no NAT Gateway). Two EventBridge rules invoke it:
`weather-pipeline-nws-alerts` (hourly at :23, `{"mode":"alerts"}`) and `weather-pipeline-nws-forecasts`
(every 3 h at :07, `{"mode":"forecast"}`). It writes to the same Atlas collections as the workflows (7-day TTL),
archives the raw responses to `s3://weather-pipeline-raw-<ACCOUNT_ID>/nws-*`, and emails a failed run through SNS.
Logs: `/aws/lambda/weather-pipeline-nws-collector`, kept 7 days. The function's role (with the boundary) may only:
`ssm:GetParameter` on the Atlas parameter, `s3:PutObject` on `nws-*` in the bucket, `sns:Publish` on the alerts topic,
and write its own logs.

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

   (The console keeps it out of your shell history. Rotating the Atlas password later: edit the value; the Lambda
   picks it up on its next cold start or after the next failed run.)
3. **Atlas network access** must allow Lambda's changing IPs: `0.0.0.0/0` is already there for GitHub Actions
   (docs/SETUP_CLOUD_COLLECTION.md); keep it.
4. **`.env`**: `NWS_USER_AGENT` must have your contact (it's passed to the Lambda as a stack parameter).
5. `npm run aws:deploy` (it bundles the function with esbuild, then shows the change set; review it, then `y`).
6. **Test** (as `weather-dev`):

   ```powershell
   aws lambda invoke --function-name weather-pipeline-nws-collector --payload '{\"mode\":\"alerts\"}' `
     --cli-binary-format raw-in-base64-out --profile weather-dev --region us-east-2 out.json; Get-Content out.json
   aws logs tail /aws/lambda/weather-pipeline-nws-collector --since 15m --profile weather-dev --region us-east-2
   ```

   Expect `"status":"success"` and `[archive:s3] nws-alerts/...` in the log. Do the same with `forecast`, then
   check that `npm run sync:atlas` brings the new rows home. Delete `out.json`.
7. **After a day of good scheduled runs**, turn off the GitHub schedules: remove the `schedule:` block from
   `.github/workflows/nws-alerts.yml` and `nws-forecasts.yml` (keep `workflow_dispatch` as a manual fallback).
8. **S3 PUTs:** the Lambda archives up to 16 objects / day (alerts once per 3-hour UTC slot + 8 forecast runs; its own
   cap, ledger in Atlas). Keep the local cap in `.env` at `RAW_ARCHIVE_MAX_PUTS_PER_DAY=20` (~14 / day expected):
   ~900 PUTs / month expected (45%), ≤ 1,116 even at both caps (56% of the free 2,000).

## Remove everything: `npm run aws:teardown`

Empties the raw archive bucket (`aws s3 rm --recursive`; CloudFormation can't delete a non-empty bucket), then runs
`sam delete` for the `weather-pipeline` stack (it asks for confirmation). This deletes every resource the
stack created, plus the code SAM uploaded. The SSM parameter (step 10) is manual: delete it by hand. All resources carry the tag `Project=us-weather-pipeline`, so leftovers
are easy to find in **Resource Groups & Tag Editor**. The IAM users, policies and access keys are manual (steps 2–4):
delete them by hand if you're done with AWS.

## Cost guard (also in CLAUDE.md)

- Free plan only; anything that needs a paid plan → stop and ask.
- Never: NAT Gateway, EC2, public IPv4 / Elastic IPs, load balancers, RDS, KMS customer-managed keys, Secrets Manager,
  more than 10 CloudWatch custom metrics, or anything without a free tier.
- Always: S3 with SSE-S3 + a lifecycle rule; SSM Parameter Store (standard); 7-day log retention; Lambda 128–256 MB
  with short timeouts; EventBridge at most hourly; tag `Project=us-weather-pipeline`.
- Before every `sam deploy`: a list of the resources, their free-tier limits and the expected monthly use, and your OK.
