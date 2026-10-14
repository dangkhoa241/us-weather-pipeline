// "How it works": the whole project in one interactive diagram (Data flow / AWS views), a details panel per part
// (side panel on desktop, bottom sheet on phones), live "last run" badges from status.json (lib/ops.ts, hidden when
// unavailable) and a plain-text summary. Lazy-loaded (App.tsx), so the main bundle doesn't grow. `now` is for tests.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Term } from "@/components/Term";
import { FlowDiagram, type NodeBadges } from "@/components/FlowDiagram";
import { isGlossaryKey } from "@/lib/glossary";
import { NODES, VIEWS, WHERE, lastRuns, parseTerms, repoLink, type NodeId, type ViewId, type Where } from "@/lib/howItWorks";
import { ago, loadOpsStatus, utcTime, type OpsData } from "@/lib/ops";
import { useMediaQuery } from "@/lib/useMediaQuery";

/** Text with {Term} tokens → text with glossary tooltips. */
function Rich({ text }: { text: string }) {
  return <>{parseTerms(text).map((p, i) => (p.term && isGlossaryKey(p.term) ? <Term key={i} k={p.term}>{p.text}</Term> : <span key={i}>{p.text}</span>))}</>;
}

function Swatch({ where }: { where: Where }) {
  return (
    <svg width="28" height="14" aria-hidden className="shrink-0">
      <rect x="1" y="1" width="26" height="12" rx="3" className="fill-card stroke-foreground" strokeWidth={where === "aws" ? 2 : 1.6}
        strokeDasharray={WHERE[where].dash || undefined} />
    </svg>
  );
}

function Panel({ id, viewId, onClose, run, kind, now }: {
  id: NodeId; viewId: ViewId; onClose: () => void; run: string | null; kind: OpsData["kind"] | null; now: number;
}) {
  const n = NODES[id];
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { close.current?.focus(); }, [id]);
  const view = VIEWS[viewId];
  const from = view.edges.filter((e) => e.to === id).map((e) => `${NODES[e.from].label}${e.label ? ` (${e.label})` : ""}`);
  const to = view.edges.filter((e) => e.from === id).map((e) => `${NODES[e.to].label}${e.label ? ` (${e.label})` : ""}`);
  return (
    <aside role="dialog" aria-modal="false" aria-labelledby="flow-panel-title" data-flow-panel={id}
      className="fixed inset-x-0 bottom-0 z-40 max-h-[65vh] overflow-y-auto rounded-t-2xl border bg-popover p-5 text-sm text-popover-foreground shadow-xl lg:inset-x-auto lg:bottom-auto lg:right-6 lg:top-24 lg:max-h-[calc(100vh-8rem)] lg:w-96 lg:rounded-2xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-xs text-muted-foreground"><Swatch where={n.where} />{WHERE[n.where].label}</p>
          <h3 id="flow-panel-title" className="mt-1 text-lg font-semibold">{n.label} <span className="text-sm font-normal text-muted-foreground">· {n.sub}</span></h3>
        </div>
        <button ref={close} type="button" onClick={onClose} aria-label="Close details"
          className="rounded-md px-2 py-1 text-lg leading-none text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">×</button>
      </div>
      <dl className="mt-3 space-y-3">
        <div><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">What it does</dt><dd><Rich text={n.what} /></dd></div>
        <div><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Why this choice</dt><dd><Rich text={n.why} /></dd></div>
        {n.note && <div><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Note</dt><dd>{n.note}</dd></div>}
        {n.number && (
          <div data-flow-number>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">In numbers</dt>
            <dd><span className="font-semibold"><Rich text={n.number.value} /></span> <span className="text-xs text-muted-foreground">(source: {n.number.source})</span></dd>
          </div>
        )}
        {n.badge && run && (
          <div data-flow-panel-run>
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Last run</dt>
            <dd>{utcTime(run)} ({ago(run, now)}, {kind === "live" ? "live status" : "bundled snapshot"})</dd>
          </div>
        )}
        {from.length > 0 && <div><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Gets data from</dt><dd>{from.join(", ")}</dd></div>}
        {to.length > 0 && <div><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sends data to</dt><dd>{to.join(", ")}</dd></div>}
      </dl>
      {n.doc && (
        <a href={repoLink(n.doc)} target="_blank" rel="noopener noreferrer" data-flow-doc className="mt-4 inline-block text-sm font-medium underline underline-offset-2">
          Read more: {n.doc} ↗
        </a>
      )}
    </aside>
  );
}

const AWS_ONLY: NodeId[] = VIEWS.aws.nodes.filter((id) => !VIEWS.flow.nodes.includes(id) && id !== "awsPublisher");

export default function HowItWorksPage({ now: fixedNow }: { now?: number }) {
  const [now] = useState(() => fixedNow ?? Date.now());
  const [viewId, setViewId] = useState<ViewId>("flow");
  const [open, setOpen] = useState<NodeId | null>(null);
  const desktop = useMediaQuery("(min-width: 1024px)", true);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const nodeEls = useRef(new Map<NodeId, SVGGElement>());
  const status = useQuery({ queryKey: ["ops-status"], queryFn: loadOpsStatus, staleTime: 5 * 60_000 });
  const view = VIEWS[viewId];

  // Live badges: hidden when the status file is unavailable (the page itself never depends on it).
  const runs = lastRuns(status.data);
  const kind = status.data?.kind ?? null;
  const badgeText = (t: string | null) => (t ? `last run ${ago(t, now)}${kind === "snapshot" ? " (snapshot)" : ""}` : undefined);
  const badges: NodeBadges = {};
  for (const id of view.nodes) {
    const b = NODES[id].badge;
    const text = b && badgeText(runs[b]);
    if (text) badges[id] = text;
  }

  const close = () => {
    const id = open;
    setOpen(null);
    if (id) nodeEls.current.get(id)?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  });

  return (
    <>
      <Card className="bg-gradient-to-br from-card to-muted/60">
        <CardHeader>
          <CardDescription>How it works</CardDescription>
          <CardTitle className="text-2xl leading-tight">From free weather APIs to this page, on a $0 budget</CardTitle>
          <CardDescription>{view.intro} Select any part for details: what it does, why it was chosen, and one measured number.</CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div role="group" aria-label="Diagram view" className="flex gap-1 rounded-full bg-muted p-1">
              {(Object.keys(VIEWS) as ViewId[]).map((v) => (
                <button key={v} type="button" aria-pressed={viewId === v} data-flow-toggle={v}
                  onClick={() => { setOpen(null); setViewId(v); }}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium ${viewId === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                  {VIEWS[v].title}
                </button>
              ))}
            </div>
            <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-flow-legend>
              {(Object.keys(WHERE) as Where[]).map((w) => (
                <li key={w} className="flex items-center gap-1.5"><Swatch where={w} />{WHERE[w].label}</li>
              ))}
              {!reducedMotion && <li className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-primary" aria-hidden />data moving</li>}
            </ul>
          </div>
          <FlowDiagram view={view} desktop={desktop} reducedMotion={reducedMotion} badges={badges} selected={open}
            onOpen={setOpen} nodeRef={(id, el) => { if (el) nodeEls.current.set(id, el); else nodeEls.current.delete(id); }} />
          {!desktop && <p className="text-xs text-muted-foreground">On small screens only the main connections are drawn; each part's details list all of them.</p>}
        </CardContent>
      </Card>

      {open && view.nodes.includes(open) && (
        <Panel id={open} viewId={viewId} onClose={close} run={NODES[open].badge ? runs[NODES[open].badge!] : null} kind={kind} now={now} />
      )}

      <Card data-flow-summary>
        <CardHeader><CardTitle>In words</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed">
          <p>
            NWS forecasts and alerts are collected on AWS by a <Term k="Serverless function">serverless function</Term> and buffered in
            MongoDB Atlas. The Docker stack on the laptop copies them home, adds Open-Meteo history and model forecasts, loads everything
            into ClickHouse (<Term k="ETL">ETL</Term>), caches the answers in Redis and serves them through an API. This site ships a
            snapshot exported from that API when it is redeployed; a publisher on AWS refreshes forecasts, alerts and pipeline status
            every 3 hours and recent history once a day, served by CloudFront (a <Term k="CDN">CDN</Term>).
          </p>
          <h3 className="font-semibold">Data flow, step by step</h3>
          <ol className="list-decimal space-y-1 pl-5">
            {VIEWS.flow.nodes.map((id) => (
              <li key={id}><strong>{NODES[id].label}</strong> ({WHERE[NODES[id].where].short}): <Rich text={NODES[id].what} /></li>
            ))}
          </ol>
          <h3 className="font-semibold">Also on AWS</h3>
          <ul className="list-disc space-y-1 pl-5">
            {AWS_ONLY.map((id) => (
              <li key={id}><strong>{NODES[id].label}</strong> ({WHERE[NODES[id].where].short}): <Rich text={NODES[id].what} /></li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
