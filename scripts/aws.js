// scripts/aws.js
// Thin wrapper around the AWS SAM CLI for the weather-pipeline stack (infra/template.yaml, infra/samconfig.toml).
// Usage: npm run aws:validate | aws:deploy | aws:teardown
// Credentials: the deploy profile AWS_DEPLOY_PROFILE (default weather-dev) from ~/.aws; nothing secret is passed or stored here.
// Cost guard (CLAUDE.md): before every deploy, list the resources with their free-tier limits and get an OK.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { config } from "../src/config.js";

const INFRA = new URL("../infra/", import.meta.url);
const EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;   // also keeps shell metacharacters out (Windows runs sam via cmd)

const common = ["--profile", config.aws.deployProfile, "--region", config.aws.region];
// Deploys use the deploy profile from ~/.aws: drop the app's runtime credential settings loaded from .env.
const { AWS_PROFILE, AWS_SHARED_CREDENTIALS_FILE, AWS_CONFIG_FILE, ...deployEnv } = process.env;
const run = (cmd, args, { capture = false } = {}) => {
  const res = spawnSync(cmd, args, {
    cwd: INFRA, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8",
    shell: process.platform === "win32", env: deployEnv,
  });
  if (res.error) throw new Error(`could not run the ${cmd} CLI (${res.error.message}); install it: docs/SETUP_AWS.md step 5`);
  if (res.status !== 0) process.exit(res.status ?? 1);
  return capture ? res.stdout.trim() : undefined;
};
const sam = (args) => run("sam", args);

const command = process.argv[2];
switch (command) {
  case "validate":
    sam(["validate", "--lint", ...common]);
    break;
  case "deploy": {
    const email = config.aws.alertEmail;
    if (!email || !EMAIL.test(email)) throw new Error("set ALERT_EMAIL in .env (docs/SETUP_AWS.md step 6)");
    // Only templates with Lambda functions need a build (Part 1 has none).
    if (readFileSync(new URL("template.yaml", INFRA), "utf8").includes("AWS::Serverless::Function")) sam(["build", "--cached"]);
    sam(["deploy", ...common, "--parameter-overrides", `AlertEmail=${email}`]);
    console.log("[aws] deployed. Stack outputs → .env: SNS_TOPIC_ARN (NOTIFIER=sns), RAW_ARCHIVE_BUCKET (RAW_ARCHIVE=s3).");
    break;
  }
  case "teardown": {
    // CloudFormation cannot delete a non-empty bucket: empty the raw archive first (versioning is off).
    const bucket = run("aws", ["cloudformation", "describe-stacks", "--stack-name", config.aws.stackName, ...common,
      "--query", "Stacks[0].Outputs[?OutputKey=='RawArchiveBucketName'].OutputValue", "--output", "text"], { capture: true });
    if (/^weather-pipeline-raw-\d{12}$/.test(bucket)) run("aws", ["s3", "rm", `s3://${bucket}`, "--recursive", ...common]);
    // sam delete asks for confirmation; it removes the stack and SAM's uploaded artifacts.
    sam(["delete", "--stack-name", config.aws.stackName, ...common]);
    break;
  }
  default:
    console.error("Usage: node scripts/aws.js validate|deploy|teardown");
    process.exitCode = 1;
}
