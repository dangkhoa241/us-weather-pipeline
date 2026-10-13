// Pipeline Ops page data (docs/analysis/pipeline-ops.md): status.json from CloudFront (written by the dashboard
// publisher every 3 hours), else the copy bundled with the build (npm run export:status). Same live-first pattern
// as the other live files: a live file that fails, times out or doesn't validate falls back to the bundled one.
import { z } from "zod";
import { fetchLive } from "@/lib/snapshot";

const STATUS_FORMAT = 1;
/** status.json is rewritten every 3 hours; older than this, the page says it is stale. */
export const STALE_MS = 6 * 3_600_000;

const isoTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
const count = z.number().int().min(0).nullable();
const jobSchema = z.object({
  id: z.enum(["alerts", "forecast", "publisher"]), name: z.string(), schedule: z.string(),
  lastRunAt: isoTime.nullable(), lastStatus: z.enum(["ok", "partial", "failed"]).nullable(), lastDurationMs: count,
  runs7d: z.number().int().min(0), okRuns7d: z.number().int().min(0),
});
export const statusSchema = z.object({
  format: z.literal(STATUS_FORMAT),
  generatedAt: isoTime,
  windowDays: z.number().int().min(1),
  jobs: z.array(jobSchema),
  freshness: z.object({ historyThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), forecastUpdatedAt: isoTime.nullable() }),
  incidents: z.array(z.object({ at: isoTime, job: z.string(), city: z.string().nullable(), category: z.string(), runs: z.number().int(), recovered: z.boolean(), text: z.string() })),
  alerts7d: z.object({ sent: count, skippedCooldown: count, skippedNotNew: count, runsCounted: z.number().int().min(0), since: isoTime.nullable().optional() }),
  performance: z.object({ redisWarmP95: z.object({ beforeMs: z.number(), afterMs: z.number(), speedup: z.number(), source: z.string() }) }),
});
export type OpsStatus = z.infer<typeof statusSchema>;
export type OpsJob = OpsStatus["jobs"][number];
export type OpsData = { kind: "live" | "snapshot"; status: OpsStatus };

/** Live status.json, else the bundled one; throws when neither is available. */
export async function loadOpsStatus(): Promise<OpsData> {
  const live = await fetchLive("status.json", statusSchema);
  if (live) return { kind: "live", status: live };
  const res = await fetch("/data/status.json", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Pipeline status not available (${res.status})`);
  const parsed = statusSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("Pipeline status file is invalid");
  return { kind: "snapshot", status: parsed.data };
}

export const isStale = (generatedAt: string, now: number) => now - Date.parse(generatedAt) > STALE_MS;

// Alerts run hourly: a first counted run within 2 h of the window's start means the window is full.
const FULL_WINDOW_SLACK_MS = 2 * 3_600_000;

/** "counting since Oct 14" while the alert counts cover less than the full window, else null. */
export function alertsCountingSince(s: Pick<OpsStatus, "alerts7d" | "generatedAt" | "windowDays">) {
  const since = s.alerts7d.since;
  if (!since) return null;
  const windowStart = Date.parse(s.generatedAt) - s.windowDays * 86_400_000;
  if (Date.parse(since) <= windowStart + FULL_WINDOW_SLACK_MS) return null;
  return `counting since ${new Date(since).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" })}`;
}

/** 2491 → "2.5 s", 95712 → "1 min 36 s". */
export function formatDuration(ms: number | null) {
  if (ms == null) return "–";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** Time since `iso`: "just now", "17 min ago", "5 h ago", "2 days ago". */
export function ago(iso: string, now: number) {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** "2026-10-13T20:23:10Z" → "Oct 13, 8:23 PM UTC" (the schedules are in UTC too). */
export const utcTime = (iso: string) =>
  `${new Date(iso).toLocaleString("en-US", { timeZone: "UTC", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} UTC`;

/** Headline for the whole pipeline from the jobs' last runs. */
export function overall(jobs: OpsJob[]): { level: "ok" | "partial" | "failed" | "unknown"; text: string } {
  const failed = jobs.filter((j) => j.lastStatus === "failed").length;
  const partial = jobs.filter((j) => j.lastStatus === "partial").length;
  const unknown = jobs.filter((j) => j.lastStatus == null).length;
  const n = (k: number) => `${k} ${k === 1 ? "job" : "jobs"}`;
  if (failed) return { level: "failed", text: `${n(failed)} failed on the last run` };
  if (partial) return { level: "partial", text: `${n(partial)} had a partial last run` };
  if (unknown === jobs.length) return { level: "unknown", text: "No runs recorded yet" };
  if (unknown) return { level: "ok", text: `All recorded jobs ok (${n(unknown)} with no run recorded yet)` };
  return { level: "ok", text: "All jobs ok on their last run" };
}
