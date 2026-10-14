import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OPS_NOW, opsStatus } from "@/test/opsFixtures";

// Live status.json (CloudFront) is controlled here; the bundled fallback goes through a stubbed fetch.
const live = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/snapshot", () => ({ fetchLive: vi.fn(async () => live.value) }));
const { default: HowItWorksPage } = await import("@/pages/HowItWorksPage");

// matchMedia: desktop width and reduced motion are switchable per test.
const media = { desktop: true, reduce: false };
function stubMedia() {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("reduced-motion") ? media.reduce : q.includes("min-width") ? media.desktop : false,
    media: q, addEventListener: () => {}, removeEventListener: () => {},
  }));
}

function show({ status = "live" as "live" | "snapshot" | "missing" } = {}) {
  live.value = status === "live" ? opsStatus() : null;
  vi.stubGlobal("fetch", vi.fn(async () => (status === "snapshot"
    ? new Response(JSON.stringify(opsStatus()), { status: 200 }) : new Response("", { status: 404 }))));
  stubMedia();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><HowItWorksPage now={OPS_NOW} /></QueryClientProvider>);
}
const node = (id: string) => document.querySelector(`[data-flow-node="${id}"]`) as SVGGElement;
const badge = (id: string) => document.querySelector(`[data-flow-badge="${id}"]`);

beforeEach(() => {
  vi.unstubAllGlobals();
  media.desktop = true;
  media.reduce = false;
});

describe("HowItWorksPage", () => {
  it("Data flow: 10 labelled parts, a legend in words, and the plain-text summary", () => {
    show();
    expect(document.querySelectorAll("[data-flow-node]")).toHaveLength(10);
    expect(node("redis")).toHaveAccessibleName(/^Redis \(Stage 3 cache\), Local laptop \(Docker\)\. Show details\.$/);
    const legend = screen.getByRole("list", { name: "Legend" });
    for (const label of ["External service", "AWS (production)", "Local laptop (Docker)"]) expect(within(legend).getByText(label)).toBeInTheDocument();
    const summary = document.querySelector("[data-flow-summary]") as HTMLElement;
    expect(within(summary).getAllByRole("listitem").length).toBe(10 + 8);
    expect(summary).toHaveTextContent("snapshot exported from that API when it is redeployed");
  });

  it("keyboard: Enter opens the details panel (focus on Close), Escape closes it and returns focus to the part", async () => {
    const user = userEvent.setup();
    show();
    node("redis").focus();
    await user.keyboard("{Enter}");
    const panel = screen.getByRole("dialog", { name: /Redis/ });
    expect(panel).toHaveTextContent("Keeps the answers to the dashboard's queries");
    expect(panel).toHaveTextContent("35.4 → 2.9 ms");
    expect(panel).toHaveTextContent("source: docs/analysis/caching.md");
    expect(panel).toHaveTextContent("Gets data fromClickHouse");
    const link = within(panel).getByRole("link", { name: /Read more/ });
    expect(link).toHaveAttribute("href", "https://github.com/dangkhoa241/us-weather-pipeline/blob/main/docs/analysis/caching.md");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
    expect(within(panel).getByRole("button", { name: "Close details" })).toHaveFocus();
    expect(node("redis")).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(node("redis")).toHaveFocus();
    expect(node("redis")).toHaveAttribute("aria-expanded", "false");
  });

  it("Space and click open a part too; the Close button closes", async () => {
    const user = userEvent.setup();
    show();
    node("atlas").focus();
    await user.keyboard(" ");
    expect(screen.getByRole("dialog", { name: /MongoDB Atlas/ })).toHaveTextContent("off for up to a week without losing NWS data");
    await user.click(screen.getByRole("button", { name: "Close details" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(node("api"));
    expect(screen.getByRole("dialog", { name: /Hono API/ })).toBeInTheDocument();
  });

  it.each([["desktop side panel", true], ["phone bottom sheet", false]])(
    "%s: clicking the open part, or pressing Enter on it, closes the panel and keeps focus on the part", async (_, isDesktop) => {
      media.desktop = isDesktop;
      const user = userEvent.setup();
      show();
      await user.click(node("redis"));
      expect(screen.getByRole("dialog", { name: /Redis/ })).toBeInTheDocument();
      await user.click(node("redis"));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(node("redis")).toHaveFocus();
      expect(node("redis")).toHaveAttribute("aria-expanded", "false");

      node("redis").focus();
      await user.keyboard("{Enter}");
      expect(screen.getByRole("dialog", { name: /Redis/ })).toBeInTheDocument();
      node("redis").focus();
      await user.keyboard("{Enter}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(node("redis")).toHaveFocus();

      // Space toggles too; another part switches the panel instead of closing it.
      await user.keyboard(" ");
      expect(screen.getByRole("dialog", { name: /Redis/ })).toBeInTheDocument();
      await user.click(node("api"));
      expect(screen.getByRole("dialog", { name: /Hono API/ })).toBeInTheDocument();
      node("api").focus();
      await user.keyboard(" ");
      expect(screen.queryByRole("dialog")).toBeNull();
    });

  it.each([["desktop side panel", true], ["phone bottom sheet", false]])(
    "%s: a click on empty diagram space or an edge closes the panel and returns focus; Escape still works", async (_, isDesktop) => {
      media.desktop = isDesktop;
      const user = userEvent.setup();
      show();
      const svg = document.querySelector("[data-flow-view]") as SVGSVGElement;
      await user.click(node("atlas"));
      await user.click(svg);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(node("atlas")).toHaveFocus();

      await user.click(node("atlas"));
      await user.click(svg.querySelector("[data-flow-edge]")!);
      expect(screen.queryByRole("dialog")).toBeNull();

      await user.click(node("atlas"));
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(node("atlas")).toHaveFocus();

      // With nothing open, a background click does nothing (no error, focus not moved to a node).
      await user.click(svg);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

  it("a click inside the open panel does not close it", async () => {
    const user = userEvent.setup();
    show();
    await user.click(node("redis"));
    const panel = screen.getByRole("dialog", { name: /Redis/ });
    await user.click(within(panel).getByText("What it does"));
    expect(screen.getByRole("dialog", { name: /Redis/ })).toBeInTheDocument();
  });

  it("the AWS view shows its 12 parts and closes an open panel", async () => {
    const user = userEvent.setup();
    show();
    await user.click(node("redis"));
    await user.click(screen.getByRole("button", { name: "AWS" }));
    expect(screen.getByRole("button", { name: "AWS" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelectorAll("[data-flow-node]")).toHaveLength(12);
    expect(node("cloudfront")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("animated: dots move along every drawn edge", () => {
    show();
    const svg = document.querySelector("[data-flow-view]")!;
    expect(svg).toHaveAttribute("data-motion", "animated");
    expect(svg.querySelectorAll("[data-flow-dot] animateMotion").length).toBe(svg.querySelectorAll("[data-flow-edge]").length);
  });

  it("reduced motion: no moving dots, static arrows only", () => {
    media.reduce = true;
    show();
    const svg = document.querySelector("[data-flow-view]")!;
    expect(svg).toHaveAttribute("data-motion", "reduced");
    expect(svg.querySelectorAll("[data-flow-dot], animateMotion")).toHaveLength(0);
    const edges = svg.querySelectorAll("[data-flow-edge]");
    expect(edges.length).toBeGreaterThan(10);
    for (const e of edges) expect(e.getAttribute("marker-end")).toMatch(/^url\(#.+-arrow\)$/);
    expect(screen.queryByText("data moving")).toBeNull();
  });

  it("phone width: the stacked layout, side connections listed in the panel instead", async () => {
    media.desktop = false;
    const user = userEvent.setup();
    show();
    expect(document.querySelector("[data-flow-view]")).toHaveAttribute("data-flow-layout", "mobile");
    expect(document.querySelector('[data-flow-edge="openmeteo>publisher"]')).toBeNull();
    await user.click(node("publisher"));
    expect(screen.getByRole("dialog", { name: /Publisher/ })).toHaveTextContent("Gets data fromMongoDB Atlas (NWS forecasts + alerts), Open-Meteo (history + 4 models)");
  });

  it("live status: 'last run' badges on the collector and publisher (newest collector job), from fixed dates", async () => {
    show({ status: "live" });
    // alerts 12:23, forecast 12:07 → the collector's newest run 12:23; publisher 09:35; now 13:00
    expect(await screen.findByText("last run 37 min ago")).toBeInTheDocument();
    expect(badge("collector")).toHaveTextContent("last run 37 min ago");
    expect(badge("publisher")).toHaveTextContent("last run 3 h ago");
    expect(node("collector")).toHaveAccessibleName(/, last run 37 min ago\. Show details\.$/);
    expect(document.querySelectorAll("[data-flow-badge]")).toHaveLength(2);
  });

  it("snapshot status: the badges say so", async () => {
    show({ status: "snapshot" });
    expect(await screen.findByText("last run 37 min ago (snapshot)")).toBeInTheDocument();
    expect(badge("publisher")).toHaveTextContent("last run 3 h ago (snapshot)");
  });

  it("status unavailable: no badges, and the page still works", async () => {
    const user = userEvent.setup();
    show({ status: "missing" });
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelectorAll("[data-flow-badge]")).toHaveLength(0);
    await user.click(node("collector"));
    const panel = screen.getByRole("dialog", { name: /NWS collector/ });
    expect(panel).toHaveTextContent("about 1.5 min per forecast run");
    expect(panel.querySelector("[data-flow-panel-run]")).toBeNull();
  });
});
