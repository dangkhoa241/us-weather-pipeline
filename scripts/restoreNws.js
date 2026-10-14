// scripts/restoreNws.js
// Restore NWS forecasts and alerts for a window from the S3 raw archive into the local raw store (src/stage1/nwsRestore.js).
// Dry run by default: lists what it would insert. --apply inserts the missing documents (insert-only: nothing stored
// is changed, so a second run inserts nothing). Then run `npm run etl:clickhouse` to load them into the warehouse.
// Reads the archive with AWS_DEPLOY_PROFILE from ~/.aws (list + get only; the runtime user may only write).
// Usage: npm run restore:nws -- --from 2026-10-06T03:07Z --to 2026-10-07T09:23Z [--apply]

import { parseArgs } from "node:util";
import { config } from "../src/config.js";
import { ensureCollections } from "../src/collections.js";
import { createRawStore } from "../src/adapters/rawStore/index.js";
import { createRawArchiveReader } from "../src/adapters/rawStore/archiveReader.js";
import { RunLog } from "../src/lib/runLog.js";
import { loadLocations } from "../src/stage1/runMode.js";
import { restoreNws } from "../src/stage1/nwsRestore.js";

const DAY_MS = 86_400_000;
const MAX_DAYS = 31;   // the archive keeps 30 days
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

/** "2026-10-06" (start of day, or end of day for --to) or "2026-10-06T03:07Z" (UTC). */
function parseTime(text, name, endOfDay) {
  if (DAY_ONLY.test(text ?? "")) return new Date(Date.parse(`${text}T00:00:00Z`) + (endOfDay ? DAY_MS - 1 : 0));
  if (DATE_TIME.test(text ?? "") && !Number.isNaN(Date.parse(text))) return new Date(text);
  throw new Error(`--${name} must be a UTC date or time like 2026-10-06 or 2026-10-06T03:07Z`);
}

function parseCli() {
  const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" }, apply: { type: "boolean", default: false } } });
  const from = parseTime(values.from, "from", false);
  const to = parseTime(values.to, "to", true);
  if (from > to) throw new Error("--from is after --to");
  if (to - from > MAX_DAYS * DAY_MS) throw new Error(`the window is longer than ${MAX_DAYS} days (the archive keeps 30)`);
  return { from, to, apply: values.apply };
}

let opts;
try {
  opts = parseCli();
  if (!config.aws.rawArchiveBucket) throw new Error("RAW_ARCHIVE_BUCKET is not set (the stack output RawArchiveBucketName)");
} catch (err) {
  console.error(`[restore:nws] ${err.message}`);
  process.exit(1);
}
const store = createRawStore("mongo", {}, { archive: false });
const archive = createRawArchiveReader();
try {
  await store.connect();
  await ensureCollections(store);
  const locations = await loadLocations(store);
  const run = opts.apply ? await new RunLog(store, { stage: "stage1", mode: "restore-nws" }).start() : null;
  console.log(`[restore:nws] ${opts.apply ? "APPLY" : "dry run"}: s3://${config.aws.rawArchiveBucket} fetches ${opts.from.toISOString()} → ${opts.to.toISOString()}`);
  let report;
  try {
    report = await restoreNws(store, archive, locations, { ...opts, batchId: run?.etlBatchId ?? "restore-nws-dry-run" });
  } catch (err) {
    await run?.finish(err);
    throw err;
  }
  if (run) {
    for (const r of Object.values(report)) run.add(r.documents, { inserted: r.inserted, unchanged: r.already_stored });
    run.set({ window: { from: opts.from, to: opts.to }, restore: report });
    await run.finish();
  }
  console.table(Object.fromEntries(Object.entries(report).map(([name, r]) => [name, {
    "archive objects": r.objects, responses: r.responses, documents: r.documents, "already stored": r.already_stored,
    missing: r.missing, inserted: r.inserted,
  }])));
  for (const [name, r] of Object.entries(report)) {
    console.log(`[restore:nws] ${name} missing by fetch day:`, r.missing_by_day);
    if (r.unknown_urls.length) console.warn(`[restore:nws] ${name}: ${r.unknown_urls.length} response(s) for URLs no location has (skipped):`, r.unknown_urls.slice(0, 5));
  }
  const missing = Object.values(report).reduce((a, r) => a + r.missing, 0);
  if (!opts.apply) console.log(`[restore:nws] dry run: nothing written. Re-run with --apply to insert ${missing} document(s).`);
  else console.log("[restore:nws] done. Load them into the warehouse with: npm run etl:clickhouse");
} catch (err) {
  console.error(`[restore:nws] failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  archive.close();
  await store.close();
}
