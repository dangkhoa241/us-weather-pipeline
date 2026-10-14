# Security (cross-cutting)

Rebuild steps for the AWS identities and policies: [SETUP_AWS.md](../SETUP_AWS.md) (steps 1–7).
Component-level details sit in each doc's Security section; this page covers what spans all of them.

## Purpose

Keep a public repository and a public site safe on a $0 budget: no leaked credentials, the least privilege for every
identity, nothing internal in public files, and no input that reaches a query unchecked.

## Requirements

- The repository is public: no secret may ever be committed, in the history or the working tree.
- A leaked deploy key must not be able to take over the AWS account.
- Public files and pages must not expose account IDs, resource names, hosts or connection strings that are not
  already meant to be public.
- Only free tooling: no paid secret manager, WAF or customer-managed KMS key.

## Design

- **Secret scanning.** `npm run check:secrets` runs before every push. It scans the git history and the working tree
  for connection strings with passwords, password assignments, GitHub tokens, AWS access key IDs, secret keys and
  session tokens; checks that `.env` is not tracked; checks that every commit uses the GitHub noreply email; and
  lists untracked files to look at. It exits 1 on any finding.
- **AWS identities.**
  - `weather-dev` (CLI only, no console) deploys the stack. Its policy lets it create roles only with the
    `weather-pipeline-boundary` permissions boundary attached, and pass roles only to Lambda.
  - `weather-runtime` (used by the local fetcher) may only publish to the owner SNS topic and write archive objects.
  - Keys live only in `~/.aws` (deploy) and `~/.aws-runtime` (runtime), never in `.env`, code or CI; they are rotated
    every 90 days.
- **Permissions boundary.** Every role the stack creates carries `weather-pipeline-boundary`, which caps it at:
  writing its logs, publishing to the alerts topics, reading and writing archive objects, reading
  `/weather-pipeline/` parameters, and the sign-up counter and subscription rights.
- **Per-function roles.** Each Lambda role lists exact actions on exact resources (see [NWS collector](nws-collector.md),
  [live publishing](live-publishing.md), [alerts and sign-ups](alerts-and-signups.md)).
- **Secrets at runtime.** The Atlas URI, the Turnstile secret and the HMAC key are SSM SecureStrings with the
  AWS-managed key `aws/ssm`, read at cold start. The template holds only their names.
- **Storage.** Account-wide S3 Block Public Access; the bucket has ACLs disabled, SSE-S3, an HTTPS-only policy, and
  only CloudFront (through Origin Access Control) may read `dashboard/*`.
- **Local services.** MongoDB, ClickHouse, Redis and the API listen on `127.0.0.1` only.
- **Input handling.** ClickHouse `query_params` for every value; strict Zod schemas on every API route; the sign-up
  function validates before any network call.
- **Public-data checks.** The snapshot export and the publisher refuse files that match the `FORBIDDEN` pattern; a
  dashboard test scans the How it works data for account IDs, ARNs, resource names, hosts and email addresses.
- **CI.** GitHub Actions workflows have `contents: read`, secrets only on the steps that need them, and
  `npm ci --ignore-scripts`.
- **Review routine.** A `/security-review` at the end of every stage; low findings go to the ROADMAP's Known
  limitations.

## Alternatives considered

- Paid or extra-cost controls (Secrets Manager, customer-managed KMS keys, AWS WAF, a custom domain) are ruled out by
  the cost guard: [decision 1](../DESIGN_DECISIONS.md#1-a-0-budget-free-tiers-only). AWS WAF is listed under "What I
  would add with a budget" in the README.
- A live public API for the site, which would need its own rate limiting and auth, was rejected for static files:
  [decision 6](../DESIGN_DECISIONS.md#6-the-public-site-reads-static-json-from-s3--cloudfront-not-a-live-api).

## Failure handling

- A failed `check:secrets` blocks the push; the git workflow in `CLAUDE.md` requires a passing run.
- A key that leaks is deactivated first, then CloudTrail Event history is checked.
- A public file that fails the `FORBIDDEN` check is not written or uploaded at all.

## Security

This page is the security overview. Known, accepted gaps:
- the API rate limiter keys on the socket address (fine locally, needs trusted-proxy handling behind a proxy);
- the SNS confirmation email shows the topic ARN, which includes the account ID;
- `style-src 'unsafe-inline'` on the dashboard, for inline `style` attributes on SVG charts.

## Numbers

| Number | Source |
|---|---|
| API security probe: 22/22 checks | [analysis/api-layer.md](../analysis/api-layer.md) |
| Demo build: 0 CSP violations under the strict policy | [ROADMAP.md](../ROADMAP.md), "Resume numbers" |
| Key rotation every 90 days | [SETUP_AWS.md](../SETUP_AWS.md), credential rules |
| `weather-dev-pipeline` is at IAM's 6,144-character policy limit, so CloudFront and sign-up deploy rights are separate policies | [SETUP_AWS.md](../SETUP_AWS.md) |

## Where in the code

| What | File |
|---|---|
| Secret scan | `scripts/checkSecrets.js` |
| IAM policies (with `<ACCOUNT_ID>` placeholders) | `infra/iam/` |
| Roles, bucket policy, topic policies | `infra/template.yaml` |
| SSM read | `src/lambda/ssmParameter.js` |
| Redaction of error text | `src/adapters/notifier/snsNotifier.js` (`redact`) |
| `FORBIDDEN` pattern | `src/publish/snapshotFormat.js` |
| How it works leak scan | `dashboard/src/lib/howItWorks.test.ts` |
| API probe | `scripts/probeApi.js` |
| CI permissions | `.github/workflows/ci.yml` |
