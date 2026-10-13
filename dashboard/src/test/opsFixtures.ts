import type { OpsStatus } from "@/lib/ops";

/** A status.json as the publisher writes it (generated 2026-10-08 12:40 UTC). `patch` overrides top-level fields. */
export function opsStatus(patch: Partial<OpsStatus> = {}): OpsStatus {
  return {
    format: 1,
    generatedAt: "2026-10-08T12:40:00.000Z",
    windowDays: 7,
    jobs: [
      { id: "alerts", name: "Alerts collector", schedule: "Every hour at :23 UTC", lastRunAt: "2026-10-08T12:23:00.000Z", lastStatus: "ok", lastDurationMs: 2491, runs7d: 168, okRuns7d: 168 },
      { id: "forecast", name: "Forecast collector", schedule: "Every 3 hours at :07 UTC", lastRunAt: "2026-10-08T12:07:00.000Z", lastStatus: "ok", lastDurationMs: 95712, runs7d: 56, okRuns7d: 53 },
      { id: "publisher", name: "Dashboard publisher", schedule: "Every 3 hours at :35 UTC (history once a day, 06:35)", lastRunAt: "2026-10-08T09:35:00.000Z", lastStatus: "ok", lastDurationMs: 40000, runs7d: 40, okRuns7d: 40 },
    ],
    freshness: { historyThrough: "2026-10-03", forecastUpdatedAt: "2026-10-08T12:36:00.000Z" },
    incidents: [
      { at: "2026-10-07T00:07:07.000Z", job: "forecast", city: "Kansas City, MO", category: "NWS error", runs: 3, recovered: true, text: "Kansas City, MO: NWS error, recovered after 3 runs" },
    ],
    alerts7d: { sent: 4, skippedCooldown: 2, skippedNotNew: 11, runsCounted: 168 },
    performance: { redisWarmP95: { beforeMs: 35.4, afterMs: 2.9, speedup: 12, source: "Stage 3 cache benchmark, 10 dashboard queries on local Docker (docs/analysis/caching.md)" } },
    ...patch,
  };
}

/** 2026-10-08 13:00 UTC: 20 minutes after the fixture was generated. */
export const OPS_NOW = Date.parse("2026-10-08T13:00:00Z");
