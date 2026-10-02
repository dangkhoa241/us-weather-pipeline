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
| AWS Lambda | Part 3: alerts fetcher | ✅ listed | no Lambda@Edge |
| Amazon EventBridge | Part 3: hourly schedule | ✅ listed | — |
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

## 2. Create the least-privilege policy

The policy allows exactly what this project uses, only in **us-east-2**, and only on resources named
`weather-pipeline-*` (plus the bucket AWS SAM creates for uploads). It covers Parts 1–3, so you only set it up once:

| Statement | Why |
|---|---|
| `IdentityAndTemplateChecks` | `aws sts get-caller-identity`, `sam validate`, listing stacks and log groups |
| `CloudFormationStacks`, `SamTransform` | deploy and delete the `weather-pipeline` stack (and SAM's own helper stack) |
| `SamArtifactBucket` | the `aws-sam-cli-managed-default-*` bucket where SAM uploads code |
| `Part1SnsAlertsTopic` | create the alerts topic and email subscription; **publish** alerts |
| `Part2RawArchiveBucket` | create the private, encrypted archive bucket with a 30-day lifecycle; **write** raw responses |
| `Part3Lambda*`, `Part3ScheduleRules`, `Part3LambdaLogs` | the scheduled Lambda, its role (can only get the AWS logging policy, can only be passed to Lambda), the hourly rule and its log group |
| `Part3ConfigParameters` | SSM Parameter Store (standard, free) under `/weather-pipeline/` for the Lambda's config, e.g. the Atlas URI as a SecureString |

Steps:
1. Open [`infra/iam/weather-dev-policy.json`](../infra/iam/weather-dev-policy.json) and replace every `<ACCOUNT_ID>`
   with your account ID. Do this in a copy outside the repo, or undo it before committing.
2. Console → **IAM → Policies → Create policy → JSON**. Paste the edited JSON and choose **Next**.
3. Name it **`weather-dev-pipeline`**, then choose **Create policy**.

## 3. Create the IAM user `weather-dev`

1. **IAM → Users → Create user**. User name: **`weather-dev`**.
   Leave "Provide user access to the AWS Management Console" **unchecked**: this user is for the CLI only.
2. **Permissions → Attach policies directly**, tick **`weather-dev-pipeline`** (only this one), then
   **Next → Create user**.

## 4. Create an access key (for the CLI)

1. **IAM → Users → weather-dev → Security credentials → Create access key**.
2. Use case: **Command Line Interface (CLI)**. Tick the confirmation, then choose **Next → Create access key**.
3. Keep the page open for step 6. **Don't download the .csv** (if you did, delete it after step 6). The secret
   is shown only once. If you lose it, deactivate the key and create a new one.

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

## 6. `aws configure` (credentials stay in `~/.aws`)

Use a named profile so these keys are only used when asked for:

```powershell
aws configure --profile weather-dev
#   AWS Access Key ID:      <paste from step 4>
#   AWS Secret Access Key:  <paste from step 4>
#   Default region name:    us-east-2
#   Default output format:  json
```

This writes `%USERPROFILE%\.aws\credentials` and `%USERPROFILE%\.aws\config`, **outside the repository**. Check it:

```powershell
aws sts get-caller-identity --profile weather-dev
# "Arn": "arn:aws:iam::<ACCOUNT_ID>:user/weather-dev"
```

Then add these lines to your local **`.env`**. It is git-ignored and holds no secrets; the AWS SDK reads the keys
from `~/.aws`:

```dotenv
AWS_PROFILE=weather-dev
AWS_REGION=us-east-2
ALERT_EMAIL=<your email for SNS alerts>
# Only if the Docker fetcher should send alerts too: mounts ~/.aws read-only into the container
AWS_CONFIG_DIR=C:/Users/<you>/.aws
```

## 7. Credential rules (enforced)

- Keys live **only** in `~/.aws`. Never put them in `.env`, code, docs, CI or chat.
- `npm run check:secrets` fails on AWS access key IDs (`AKIA…`, `ASIA…`) and on `aws_secret_access_key` values
  anywhere in the git history or working tree.
- `.gitignore` covers `.aws/`, `*accessKeys*.csv` (the console download) and `.aws-sam/` (SAM build output).
- The Docker fetcher sees `~/.aws` only when `AWS_CONFIG_DIR` is set, and only **read-only**.
- **Rotate** the key every 90 days: create a new key, run `aws configure --profile weather-dev`, then deactivate
  and delete the old one. If a key ever leaks, deactivate it first, then check CloudTrail **Event history**.

## 8. Done? Tell Claude Code

Claude Code will then:
1. run `npm run aws:validate` (template lint, no AWS changes);
2. run `npm run aws:deploy`, which creates the `weather-pipeline` stack (Part 1: the SNS topic and your email subscription);
3. ask you to **confirm the subscription** from the email AWS sends ("AWS Notification - Subscription Confirmation");
4. set `NOTIFIER=sns` and `SNS_TOPIC_ARN=<stack output>` in `.env`, and send a test alert.

## Remove everything: `npm run aws:teardown`

Runs `sam delete` for the `weather-pipeline` stack (it asks for confirmation). This deletes every resource the
stack created, plus the code SAM uploaded. All resources carry the tag `Project=us-weather-pipeline`, so leftovers
are easy to find in **Resource Groups & Tag Editor**. The IAM user, policy and access key are manual (steps 2–4):
delete them by hand if you're done with AWS.

## Cost guard (also in CLAUDE.md)

- Free plan only; anything that needs a paid plan → stop and ask.
- Never: NAT Gateway, EC2, public IPv4 / Elastic IPs, load balancers, RDS, KMS customer-managed keys, Secrets Manager,
  more than 10 CloudWatch custom metrics, or anything without a free tier.
- Always: S3 with SSE-S3 + a lifecycle rule; SSM Parameter Store (standard); 7-day log retention; Lambda 128–256 MB
  with short timeouts; EventBridge at most hourly; tag `Project=us-weather-pipeline`.
- Before every `sam deploy`: a list of the resources, their free-tier limits and the expected monthly use, and your OK.
