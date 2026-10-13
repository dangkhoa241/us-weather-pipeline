import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OPS_NOW, opsStatus } from "@/test/opsFixtures";
import type { OpsStatus } from "@/lib/ops";

// Live status.json (CloudFront) is controlled here; the bundled fallback goes through a stubbed fetch.
const live = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/snapshot", () => ({ fetchLive: vi.fn(async () => live.value), accuracyAsOf: () => "2026-10-02" }));
const { OpsPage } = await import("@/pages/OpsPage");

function show(status: OpsStatus | null, { bundled = opsStatus(), now = OPS_NOW } = {}) {
  live.value = status;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(bundled), { status: 200 })));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><OpsPage now={now} /></QueryClientProvider>);
}
const job = (id: string) => document.querySelector(`[data-job="${id}"]`) as HTMLElement;
const withJob = (id: string, patch: Partial<OpsStatus["jobs"][number]>) =>
  opsStatus({ jobs: opsStatus().jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) });

beforeEach(() => vi.unstubAllGlobals());

describe("OpsPage", () => {
  it("ok: three job cards with schedule, last run, duration and a text label next to the dot", async () => {
    show(opsStatus());
    expect(await screen.findByText("All jobs ok on their last run")).toBeInTheDocument();
    expect(document.querySelector("[data-ops-source]")).toHaveTextContent("Live");
    expect(document.querySelector("[data-ops-stale]")).toBeNull();
    const forecast = within(job("forecast"));
    expect(forecast.getByText("Forecast collector")).toBeInTheDocument();
    expect(forecast.getByText("Every 3 hours at :07 UTC")).toBeInTheDocument();
    expect(forecast.getByText("OK")).toBeInTheDocument();   // the dot is never the only signal
    expect(job("forecast")).toHaveTextContent("Oct 8, 12:07 PM UTC (53 min ago)");
    expect(job("forecast")).toHaveTextContent("1 min 36 s");
    expect(job("forecast")).toHaveTextContent("53 of 56 runs ok");
    expect(job("publisher")).toHaveTextContent("Last completed run");
    // freshness, with accuracy labelled as coming from the snapshot
    expect(document.querySelector("[data-ops-freshness]")).toHaveTextContent("History throughOct 3");
    expect(document.querySelector("[data-ops-freshness]")).toHaveTextContent("Forecast updated atOct 8, 12:36 PM UTC");
    expect(document.querySelector("[data-ops-scored]")).toHaveTextContent("Oct 2 (from the bundled snapshot, not live)");
    // alerts and performance
    expect(document.querySelector("[data-ops-alerts]")).toHaveTextContent(/Sent4.*Skipped by cooldown2.*Skipped as not new11/);
    expect(document.querySelector("[data-ops-performance]")).toHaveTextContent("35.4 → 2.9 ms (about 12× faster)");
    expect(document.querySelector("[data-ops-performance]")).toHaveTextContent("docs/analysis/caching.md");
    expect(screen.getByText("Kansas City, MO: NWS error, recovered after 3 runs")).toBeInTheDocument();
  });

  it("partial: amber label with the 'partial run' tooltip", async () => {
    const user = userEvent.setup();
    show(withJob("forecast", { lastStatus: "partial" }));
    expect(await screen.findByText("1 job had a partial last run")).toBeInTheDocument();
    expect(job("forecast").querySelector("[data-status]")).toHaveAttribute("data-status", "partial");
    await user.hover(within(job("forecast")).getByText("Partial"));
    expect(screen.getByRole("tooltip")).toHaveTextContent(/some cities or files failed/);
  });

  it("failed: the headline and the job say so in words", async () => {
    show(withJob("publisher", { lastStatus: "failed" }));
    expect(await screen.findByText("1 job failed on the last run")).toBeInTheDocument();
    expect(document.querySelector("[data-ops-overall]")).toHaveAttribute("data-ops-overall", "failed");
    expect(within(job("publisher")).getByText("Failed")).toBeInTheDocument();
  });

  it("empty: no incidents and no alert counts recorded yet", async () => {
    show(opsStatus({ incidents: [], alerts7d: { sent: null, skippedCooldown: null, skippedNotNew: null, runsCounted: 0 } }));
    expect(await screen.findByText("No incidents in the last 7 days")).toBeInTheDocument();
    expect(document.querySelector("[data-ops-alerts]")?.textContent).toMatch(/(Not recorded yet.*){3}/);
  });

  it("snapshot fallback: live unreachable → bundled status, labelled Snapshot, with the stale banner", async () => {
    show(null, { bundled: opsStatus({ generatedAt: "2026-10-05T20:00:00.000Z" }) });
    expect(await screen.findByText("Status is stale")).toBeInTheDocument();
    expect(document.querySelector("[data-ops-source]")).toHaveTextContent("Snapshot");
    expect(document.querySelector("[data-ops-stale]")).toHaveTextContent("from 3 days ago");
    expect(document.querySelector("[data-ops-stale]")).toHaveTextContent("copy bundled with this build");
  });

  it("stale live status (older than 6 h) also shows the banner", async () => {
    show(opsStatus(), { now: Date.parse("2026-10-08T19:00:00Z") });
    expect(await screen.findByText("Status is stale")).toBeInTheDocument();
    expect(document.querySelector("[data-ops-stale]")).toHaveTextContent("the publisher may have stopped");
  });

  it("neither live nor bundled: a clear error, no crash", async () => {
    live.value = null;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><OpsPage now={OPS_NOW} /></QueryClientProvider>);
    expect(await screen.findByText("Pipeline status unavailable")).toBeInTheDocument();
  });
});
