// scripts/aws.js
// Thin wrapper around the AWS SAM CLI for the weather-pipeline stack (infra/template.yaml, infra/samconfig.toml).
// Usage: npm run aws:validate | aws:deploy | aws:teardown
// Credentials: the deploy profile AWS_DEPLOY_PROFILE (default weather-dev) from ~/.aws; nothing secret is passed or stored here.
// Cost guard (CLAUDE.md): before every deploy, list the resources with their free-tier limits and get an OK.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";

const INFRA = new URL("../infra/", import.meta.url);
const EMAIL = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;   // passed as one argument (no shell)
const USER_AGENT = /^[A-Za-z0-9 ._\/:@()+,;-]{10,200}$/;          // no quotes (SAM parses the quoted value)

const common = ["--profile", config.aws.deployProfile, "--region", config.aws.region];
// Deploys use the deploy profile from ~/.aws: drop the app's runtime credential settings loaded from .env.
const { AWS_PROFILE, AWS_SHARED_CREDENTIALS_FILE, AWS_CONFIG_FILE, ...deployEnv } = process.env;
// `sam build` installs production dependencies only, so it finds esbuild (a devDependency) on PATH.
const pathKey = Object.keys(deployEnv).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
deployEnv[pathKey] = [fileURLToPath(new URL("../node_modules/.bin", import.meta.url)), deployEnv[pathKey]].join(delimiter);
// No shell (DEP0190): args go to the CLI as an array. Windows can't spawn a .cmd without a shell, so find the real
// executable on PATH: aws.exe, or for sam.cmd the bundled Python it wraps (`../runtime/python.exe -m samcli`).
function resolve(cmd) {
  if (process.platform !== "win32") return { file: cmd, prefix: [] };
  for (const dir of deployEnv[pathKey].split(delimiter).filter(Boolean)) {
    if (existsSync(join(dir, `${cmd}.exe`))) return { file: join(dir, `${cmd}.exe`), prefix: [] };
    const python = join(dir, "..", "runtime", "python.exe");
    if (cmd === "sam" && existsSync(join(dir, "sam.cmd")) && existsSync(python)) return { file: python, prefix: ["-m", "samcli"] };
  }
  return { file: cmd, prefix: [] };   // not found: spawnSync reports ENOENT below
}
const run = (cmd, args, { capture = false } = {}) => {
  const { file, prefix } = resolve(cmd);
  const res = spawnSync(file, [...prefix, ...args], {
    cwd: INFRA, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8", env: deployEnv,
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
    const userAgent = config.http.nwsUserAgent;
    if (!USER_AGENT.test(userAgent)) {
      throw new Error('set NWS_USER_AGENT in .env with a contact, e.g. "us-weather-pipeline/1.0 (contact: you@example.com)"');
    }
    // Only templates with Lambda functions need a build (Part 3 bundles the NWS collector with esbuild).
    if (readFileSync(new URL("template.yaml", INFRA), "utf8").includes("AWS::Serverless::Function")) sam(["build", "--cached"]);
    sam(["deploy", ...common, "--parameter-overrides", `AlertEmail=${email}`, `NwsUserAgent="${userAgent}"`]);
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
