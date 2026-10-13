// Pipeline Ops: "is the pipeline healthy right now?" from status.json (lib/ops.ts): one card per job, data freshness,
// incidents and alert-email counts of the last 7 days, and the cache benchmark. Status is never shown by color alone:
// every dot has a text label. `now` is injectable for tests (stale banner, "… ago").
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Term } from "@/components/Term";
import { shortDay } from "@/lib/badge";
import { accuracyAsOf } from "@/lib/snapshot";
import { ago, alertsCountingSince, formatDuration, isStale, loadOpsStatus, overall, utcTime, type OpsJob } from "@/lib/ops";

type Level = OpsJob["lastStatus"] | "unknown";
const LEVELS: Record<NonNullable<Level>, { dot: string; label: string }> = {
  ok: { dot: "bg-emerald-500", label: "OK" },
  partial: { dot: "bg-amber-500", label: "Partial" },
  failed: { dot: "bg-red-600", label: "Failed" },
  unknown: { dot: "bg-muted-foreground/50", label: "No run recorded" },
};

function StatusLabel({ level, text }: { level: Level; text?: string }) {
  const l = LEVELS[level ?? "unknown"];
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium" data-status={level ?? "unknown"}>
      <span className={`size-2.5 rounded-full ${l.dot}`} aria-hidden />
      {text ?? (level === "partial" ? <Term k="Partial run">{l.label}</Term> : l.label)}
    </span>
  );
}

function JobCard({ job, now }: { job: OpsJob; now: number }) {
  const publisher = job.id === "publisher";
  return (
    <Card data-job={job.id}>
      <CardHeader>
        <CardTitle>{job.name}</CardTitle>
        <CardDescription>{job.schedule}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-muted-foreground">Status</dt>
          <dd><StatusLabel level={job.lastStatus} /></dd>
          <dt className="text-muted-foreground">{publisher ? "Last completed run" : "Last run"}</dt>
          <dd>{job.lastRunAt ? <>{utcTime(job.lastRunAt)} <span className="text-muted-foreground">({ago(job.lastRunAt, now)})</span></> : "–"}</dd>
          <dt className="text-muted-foreground">Duration</dt>
          <dd>{formatDuration(job.lastDurationMs)}</dd>
          <dt className="text-muted-foreground">Last 7 days</dt>
          <dd>{job.runs7d ? `${job.okRuns7d} of ${job.runs7d} runs ok` : "no runs"}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}

const num = (v: number | null) => (v == null ? "Not recorded yet" : v.toLocaleString("en-US"));

export function OpsPage({ now: fixedNow }: { now?: number }) {
  const [now] = useState(() => fixedNow ?? Date.now());   // read once per visit, not on every render
  const q = useQuery({ queryKey: ["ops-status"], queryFn: loadOpsStatus, staleTime: 5 * 60_000 });
  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.isError) {
    return (
      <Alert variant="destructive" data-ops-error>
        <AlertTitle>Pipeline status unavailable</AlertTitle>
        <AlertDescription>{q.error.message}</AlertDescription>
      </Alert>
    );
  }
  const { kind, status } = q.data;
  // Stale warning for live data only; the bundled copy is old by nature and gets a neutral note instead.
  const stale = kind === "live" && isStale(status.generatedAt, now);
  const countingSince = alertsCountingSince(status);
  const head = overall(status.jobs);
  const { freshness, alerts7d, incidents } = status;
  const perf = status.performance.redisWarmP95;
  const scored = accuracyAsOf();

  return (
    <>
      <Card className="bg-gradient-to-br from-card to-muted/60">
        <CardHeader>
          <CardDescription className="flex flex-wrap items-center gap-2">
            Pipeline status
            <Badge variant="secondary" data-ops-source={kind}
              title={kind === "live" ? "status.json from AWS (CloudFront), written by the dashboard publisher" : "status.json bundled with this build"}>
              {kind === "live" && <span className="size-2 rounded-full bg-emerald-500" aria-hidden />}
              {kind === "live" ? "Live" : "Snapshot"}
            </Badge>
          </CardDescription>
          <CardTitle className="flex items-center gap-2 text-2xl leading-tight" data-ops-overall={head.level}>
            <span className={`size-3 shrink-0 rounded-full ${LEVELS[head.level].dot}`} aria-hidden />
            {head.text}
          </CardTitle>
          <CardDescription>
            Updated {utcTime(status.generatedAt)} ({ago(status.generatedAt, now)}). Rewritten every 3 hours by the dashboard publisher from
            the last {status.windowDays} days of run records.
          </CardDescription>
        </CardHeader>
      </Card>

      {kind === "snapshot" && (
        <p className="text-sm text-muted-foreground" data-ops-snapshot-note>
          Snapshot from {utcTime(status.generatedAt)}. Live status unavailable.
        </p>
      )}
      {stale && (
        <Alert variant="destructive" data-ops-stale>
          <AlertTitle>Status is stale</AlertTitle>
          <AlertDescription>
            This status is from {ago(status.generatedAt, now)} (it should be at most 3 hours old): the publisher may have
            stopped. Jobs may have run since.
          </AlertDescription>
        </Alert>
      )}

      <section aria-label="Jobs" className="grid gap-4 md:grid-cols-3">
        {status.jobs.map((j) => <JobCard key={j.id} job={j} now={now} />)}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <Card data-ops-freshness>
          <CardHeader><CardTitle>Data freshness</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              <dt className="text-muted-foreground"><Term k="History">History through</Term></dt>
              <dd>{freshness.historyThrough ? shortDay(freshness.historyThrough) : "–"}</dd>
              <dt className="text-muted-foreground">Forecast updated at</dt>
              <dd>{freshness.forecastUpdatedAt ? utcTime(freshness.forecastUpdatedAt) : "–"}</dd>
              <dt className="text-muted-foreground">Accuracy scored through</dt>
              <dd data-ops-scored>{scored ? shortDay(scored) : "–"} <span className="text-muted-foreground">(from the bundled snapshot, not live)</span></dd>
            </dl>
          </CardContent>
        </Card>

        <Card data-ops-alerts>
          <CardHeader>
            <CardTitle>Alert emails, last {status.windowDays} days</CardTitle>
            <CardDescription>
              Counted per city and alert category, not per recipient.
              {countingSince && <span className="ml-1 font-medium text-foreground" data-ops-counting-since>({countingSince})</span>}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-3 gap-3">
              {([["Sent", alerts7d.sent, null], ["Skipped by cooldown", alerts7d.skippedCooldown, "Cooldown"], ["Skipped as not new", alerts7d.skippedNotNew, "Not new"]] as const)
                .map(([label, value, term]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{term ? <Term k={term}>{label}</Term> : label}</dt>
                    <dd className={value == null ? "text-sm text-muted-foreground" : "text-2xl font-semibold tabular-nums"}>{num(value)}</dd>
                  </div>
                ))}
            </dl>
          </CardContent>
        </Card>
      </div>

      <Card data-ops-incidents>
        <CardHeader>
          <CardTitle><Term k="Incident">Recent incidents</Term>, last {status.windowDays} days</CardTitle>
        </CardHeader>
        <CardContent>
          {incidents.length ? (
            <ul className="divide-y">
              {incidents.map((i) => (
                <li key={`${i.at}-${i.job}-${i.city}`} className="flex flex-wrap items-baseline justify-between gap-2 py-2" data-incident>
                  <span><StatusLabel level={i.recovered ? "ok" : "failed"} text={i.recovered ? "Recovered" : "Ongoing"} /> <span className="ml-1">{i.text}</span></span>
                  <span className="text-xs text-muted-foreground">{utcTime(i.at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground" data-ops-no-incidents>No incidents in the last {status.windowDays} days</p>
          )}
        </CardContent>
      </Card>

      <Card data-ops-performance>
        <CardHeader>
          <CardTitle>Performance</CardTitle>
          <CardDescription>Static benchmark, not live: {perf.source}.</CardDescription>
        </CardHeader>
        <CardContent>
          <p>
            Redis <Term k="Warm cache">warm</Term> <Term k="p95">p95</Term>: <span className="font-semibold tabular-nums">{perf.beforeMs} → {perf.afterMs} ms</span>{" "}
            (about {perf.speedup}× faster)
          </p>
        </CardContent>
      </Card>
    </>
  );
}
