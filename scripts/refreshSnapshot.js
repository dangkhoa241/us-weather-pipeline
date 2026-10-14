// scripts/refreshSnapshot.js
// The weekly refresh in one command: local stack → bundled dashboard snapshot (docs/ROADMAP.md, "Weekly refresh").
// Steps, in order; the first failure stops the run with the step's name and exit code:
//   1. Docker services MongoDB, ClickHouse and Redis are running
//   2. node pipeline.js        Stage 1 catch-up (sync-atlas, incremental history) → Stage 2 ETL → Stage 3 cache
//   3. the API on 127.0.0.1    reused if it already answers, else started here and stopped at the end
//   4. export:snapshot         dashboard/public/data/<snapshot>/ + manifest.json (from the API)
//   5. export:status           dashboard/public/data/status.json (from Atlas)
//   6. build:snapshot          the static demo build
//   7. check:demo              the 26 demo-build checks
// At the end it prints the new "data as of" dates. It never commits or pushes: review the diff, then commit.
// Usage: npm run refresh:snapshot

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { config } from "../src/config.js";

const ROOT = new URL("../", import.meta.url);
const DATA = new URL("dashboard/public/data/", ROOT);
const API = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}/api/v1`;
const REQUIRED_SERVICES = ["mongo", "clickhouse", "redis"];
const API_START_TIMEOUT_MS = 60_000;

// npm itself, run by the current Node (no shell): set when this script runs through `npm run`.
const NPM = process.env.npm_execpath;
const npmArgs = (...args) => (NPM ? [process.execPath, [NPM, ...args]] : ["npm", args]);

const timings = [];
const fmt = (ms) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

class StepFailed extends Error {}

/** Run one command with inherited output; resolves its captured stdout when asked, rejects on a non-zero exit. */
function exec(cmd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.on("error", (err) => reject(new StepFailed(`could not start ${cmd}: ${err.message}`)));
    child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new StepFailed(`exited with code ${code}`))));
  });
}

async function step(n, name, fn) {
  console.log(`\n[refresh] ${n}/7 ${name}`);
  const t0 = Date.now();
  try {
    await fn();
  } catch (err) {
    timings.push({ step: `${n}. ${name}`, result: "FAILED", time: fmt(Date.now() - t0) });
    console.table(timings);
    console.error(`\n[refresh] FAILED at step ${n}/7 (${name}): ${err.message}`);
    console.error("[refresh] Stopped. Nothing was committed or pushed; fix the step above and run npm run refresh:snapshot again.");
    throw err;
  }
  timings.push({ step: `${n}. ${name}`, result: "ok", time: fmt(Date.now() - t0) });
}

const apiUp = () => fetch(`${API}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok).catch(() => false);

let api = null;   // the API process this script started, if any
const t0 = Date.now();
try {
  await step(1, "Docker services running", async () => {
    const running = (await exec("docker", ["compose", "ps", "--services", "--status", "running"], { capture: true })).split(/\s+/).filter(Boolean);
    const missing = REQUIRED_SERVICES.filter((s) => !running.includes(s));
    if (missing.length) throw new StepFailed(`not running: ${missing.join(", ")} (start Docker Desktop, then: docker compose up -d)`);
    console.log(`[refresh] running: ${running.join(", ")}`);
  });
  await step(2, "pipeline: sync-atlas + history → ETL → cache", () => exec(process.execPath, ["pipeline.js"]));
  await step(3, "API up", async () => {
    if (await apiUp()) { console.log(`[refresh] reusing the API already answering at ${API}`); return; }
    api = spawn(process.execPath, ["backend/server.js"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], windowsHide: true });
    api.on("exit", (code) => { if (code && api) console.error(`[refresh] API exited with code ${code}`); });
    const until = Date.now() + API_START_TIMEOUT_MS;
    while (!(await apiUp())) {
      if (Date.now() > until) throw new StepFailed(`the API did not answer ${API}/health within ${API_START_TIMEOUT_MS / 1000} s`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`[refresh] API started at ${API}`);
  });
  await step(4, "export:snapshot", () => exec(process.execPath, ["scripts/exportSnapshot.js"]));
  await step(5, "export:status", () => exec(process.execPath, ["scripts/exportStatus.js"]));
  await step(6, "build:snapshot", () => exec(...npmArgs("--prefix", "dashboard", "run", "build:snapshot")));
  await step(7, "check:demo", () => exec(...npmArgs("--prefix", "dashboard", "run", "check:demo")));

  const manifest = JSON.parse(readFileSync(new URL("manifest.json", DATA), "utf8"));
  const status = JSON.parse(readFileSync(new URL("status.json", DATA), "utf8"));
  const forecasts = JSON.parse(readFileSync(new URL(`${manifest.snapshot}/forecasts.json`, DATA), "utf8"));
  const nwsIssued = Object.values(forecasts).map((m) => m.nws?.issued_at).filter(Boolean).sort().at(-1) ?? "none";
  console.table(timings);
  console.log(`\n[refresh] done in ${fmt(Date.now() - t0)}. New data as of:`);
  console.log(`  history through       ${manifest.data_as_of}   (snapshot ${manifest.snapshot}, generated ${manifest.generated_at})`);
  console.log(`  accuracy scored through ${manifest.data_as_of}`);
  console.log(`  latest NWS forecast   ${nwsIssued} UTC`);
  console.log(`  status.json           generated ${status.generatedAt}`);
  console.log("[refresh] Nothing was committed: review `git status`, then commit and push (docs/ROADMAP.md, Weekly refresh).");
} catch (err) {
  if (!(err instanceof StepFailed)) console.error(`[refresh] unexpected error: ${err?.stack ?? err}`);
  process.exitCode = 1;
} finally {
  if (api) { const p = api; api = null; p.kill(); }
}
