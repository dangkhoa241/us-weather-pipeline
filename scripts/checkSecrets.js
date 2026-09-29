// scripts/checkSecrets.js
// Pre-push check: secrets in git history or the working tree, a tracked .env, and commit emails.
// Usage: npm run check:secrets   (exit code 1 when something is found)

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const NOREPLY = "64240183+dangkhoa241@users.noreply.github.com";

// Placeholders and local development defaults that are fine to publish.
const ALLOWED_PASSWORDS = new Set(["weather", "...", "password", "<db_password>", "<password>"]);
// Also references instead of values: ${VAR}, ${VAR:-default}, env.VAR, process.env.VAR, secrets.X.
const isPlaceholder = (value) =>
  ALLOWED_PASSWORDS.has(value) || /^<.*>$/.test(value) || /^\$\{/.test(value) || /^(process\.)?env\.|^secrets\./.test(value);

const RULES = [
  { name: "connection string with password", re: /\b(?:mongodb(?:\+srv)?|redis|postgres(?:ql)?|mysql|clickhouse):\/\/[^\s:@/"'`]+:([^\s@/"'`]+)@/g, secretGroup: 1 },
  { name: "password assignment", re: /\b\w*PASSWORD\w*\s*[:=]\s*["']?([^\s"'#]+)/gi, secretGroup: 1 },
  { name: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "Discord webhook URL", re: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/g },
  { name: "private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: "personal email", re: /\b[\w.+-]+@gmail\.com\b/gi },
];

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const problems = [];

function scanText(text, where) {
  text.split("\n").forEach((line, i) => {
    for (const { name, re, secretGroup } of RULES) {
      for (const match of line.matchAll(re)) {
        if (secretGroup && isPlaceholder(match[secretGroup])) continue;
        problems.push(`${where}${where.includes("commit") ? "" : `:${i + 1}`}  ${name}: ${line.trim().slice(0, 120)}`);
      }
    }
  });
}

// 1. Every line ever added in any commit (removed-later secrets are still in history).
let commit = "";
for (const line of git("log", "--all", "-p", "--no-color", "--format=commit %h", "--", ".", ":!package-lock.json", ":!scripts/checkSecrets.js").split("\n")) {
  if (line.startsWith("commit ")) commit = line.slice(7);
  else if (line.startsWith("+") && !line.startsWith("+++")) scanText(line.slice(1), `history (commit ${commit})`);
}

// 2. Current files: tracked plus untracked-but-not-ignored (what `git add -A` would pick up).
const files = [...new Set([...git("ls-files").split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")])]
  .filter((f) => f && existsSync(f) && f !== "package-lock.json" && f !== "scripts/checkSecrets.js");
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (!text.includes("\0")) scanText(text, file);
}

// 3. .env must never be tracked or pushable.
for (const f of files) if (/(^|\/)\.env(\.[^/]*)?$/.test(f) && !f.endsWith(".env.example")) problems.push(`${f}  .env file is tracked or not ignored`);

// 4. Every commit authored and committed with the noreply address.
for (const line of git("log", "--all", "--format=%h %ae %ce").trim().split("\n")) {
  const [hash, author, committer] = line.split(" ");
  if (author !== NOREPLY || committer !== NOREPLY) problems.push(`commit ${hash}  email is not the noreply address (${author} / ${committer})`);
}

// 5. Untracked, non-ignored files: one `git add -A` away from being pushed. Patterns can't recognize a bare
//    password in a text file, so list them for a human look (warning only).
const untracked = git("ls-files", "--others", "--exclude-standard").split("\n").filter(Boolean);
if (untracked.length) {
  console.warn(`check:secrets WARNING - ${untracked.length} untracked file(s) not in .gitignore; make sure none holds a secret:`);
  for (const f of untracked) console.warn(`  ${f}`);
}

const commits = git("rev-list", "--all", "--count").trim();
if (problems.length) {
  console.error(`check:secrets FAILED - ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exitCode = 1;
} else {
  console.log(`check:secrets OK - ${commits} commits and ${files.length} files scanned; no secrets, .env not tracked, all commits use ${NOREPLY}`);
}
