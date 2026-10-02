// Amazon S3 raw archive (RAW_ARCHIVE=s3, Stage 6a part 2): an extra copy of the raw API responses, kept 30 days
// by the bucket's lifecycle rule. MongoDB stays the primary raw store.
// Each Stage 1 run collects its responses per source and uploads ONE gzipped NDJSON object per source:
//   s3://<bucket>/<source>/<yyyy>/<mm>/<dd>/<HHMMSS>Z-<batch>.json.gz   (one line: { url, fetched_at, body })
// One object per run instead of per response keeps PUT requests far below the S3 free tier (2,000 / month):
// at most one upload per source per UTC hour (NWS alerts: per 3-hour UTC slot), and RAW_ARCHIVE_MAX_PUTS_PER_DAY
// overall (ledger in api_usage).
// Credentials come from the AWS SDK's default chain (AWS_PROFILE → ~/.aws). A failed upload is logged and
// swallowed: the archive must never break the pipeline.

import { gzipSync } from "node:zlib";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ApiBudget, BudgetExceeded } from "../../lib/apiBudget.js";
import { redact } from "../notifier/snsNotifier.js";

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const SOURCE = /^[a-z0-9-]+$/;
const MAX_RUN_BYTES = 32 * 1024 * 1024;   // per source and run (uncompressed); a big history catch-up is cut here
// Sources archived less often than hourly: only runs in UTC hours divisible by N (alerts run hourly on Lambda).
const EVERY_HOURS = { "nws-alerts": 3 };

/** S3 key for one run of one source, from the UTC upload time. */
export function objectKey(source, batchId, now = new Date()) {
  const iso = now.toISOString();   // 2026-10-01T20:42:39.123Z
  const safeBatch = String(batchId ?? "run").replace(/[^A-Za-z0-9-]/g, "").slice(-60);
  return `${source}/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(11, 19).replace(/:/g, "")}Z-${safeBatch}.json.gz`;
}

export class S3RawArchive {
  /**
   * @param {{ bucket: string, region: string, maxPutsPerDay?: number, client?: { send: Function } }} options
   *        client: injectable for tests
   */
  constructor({ bucket, region, maxPutsPerDay = 50, client }) {
    if (!BUCKET.test(bucket ?? "")) throw new Error("RAW_ARCHIVE=s3 needs RAW_ARCHIVE_BUCKET (the stack output RawArchiveBucketName)");
    this.bucket = bucket;
    this.maxPutsPerDay = maxPutsPerDay;
    this.client = client ?? new S3Client({ region, maxAttempts: 3 });
    this.buffers = new Map();   // source → { lines: string[], bytes: number, full: boolean }
  }

  /** Keep one raw response in memory until the run's flush(). */
  add(source, url, body, fetchedAt = new Date()) {
    if (!SOURCE.test(source)) throw new Error(`invalid archive source "${source}"`);
    const buf = this.buffers.get(source) ?? { lines: [], bytes: 0, full: false };
    this.buffers.set(source, buf);
    if (buf.full) return;
    const line = JSON.stringify({ url: String(url), fetched_at: fetchedAt.toISOString(), body });
    if (buf.bytes + line.length > MAX_RUN_BYTES) {
      buf.full = true;
      console.warn(`[archive:s3] ${source}: over ${MAX_RUN_BYTES / 1024 / 1024} MB in this run; later responses are not archived`);
      return;
    }
    buf.lines.push(line);
    buf.bytes += line.length;
  }

  /**
   * Upload one object per buffered source, then clear the buffers. Never throws.
   * @param {import("./RawStore.js").RawStore} store  holds the api_usage ledger for the PUT caps
   */
  async flush(store, batchId, now = new Date()) {
    const pending = [...this.buffers].filter(([, buf]) => buf.lines.length);
    this.buffers.clear();
    for (const [source, { lines }] of pending) {
      const every = EVERY_HOURS[source] ?? 1;
      if (now.getUTCHours() % every !== 0) {
        console.log(`[archive:s3] ${source}: skipped (archived every ${every} h)`);
        continue;
      }
      try {
        // At most one object per source per UTC hour (alerts run every 15 min locally), and a daily cap overall.
        await new ApiBudget(store, `s3-archive:${source}`, { perHour: 1, perDay: Infinity }).reserve(1, now);
        await new ApiBudget(store, "s3-archive", { perHour: Infinity, perDay: this.maxPutsPerDay }).reserve(1, now);
        const key = objectKey(source, batchId, now);
        const body = gzipSync(`${lines.join("\n")}\n`);
        await this.client.send(new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: "application/gzip",
          ServerSideEncryption: "AES256",   // SSE-S3 (also the bucket default)
        }));
        console.log(`[archive:s3] ${key}: ${lines.length} response(s), ${(body.length / 1024).toFixed(0)} KB`);
      } catch (err) {
        if (err instanceof BudgetExceeded) console.log(`[archive:s3] ${source}: skipped (${err.message})`);
        else console.warn(`[archive:s3] ${source}: upload failed (${err.name ?? "Error"}): ${redact(err.message)}`);
      }
    }
  }

  close() {
    this.buffers.clear();
    this.client.destroy?.();
  }
}
