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
const sam = (args) => {
  const res = spawnSync("sam", args, { cwd: INFRA, stdio: "inherit", shell: process.platform === "win32", env: deployEnv });
  if (res.error) throw new Error(`could not run the SAM CLI (${res.error.message}); install it: docs/SETUP_AWS.md step 5`);
  if (res.status !== 0) process.exit(res.status ?? 1);
};

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
    console.log("[aws] deployed. Confirm the subscription email, then set NOTIFIER=sns and SNS_TOPIC_ARN (stack output) in .env.");
    break;
  }
  case "teardown":
    // sam delete asks for confirmation; it removes the stack and SAM's uploaded artifacts.
    sam(["delete", "--stack-name", config.aws.stackName, ...common]);
    break;
  default:
    console.error("Usage: node scripts/aws.js validate|deploy|teardown");
    process.exitCode = 1;
}
