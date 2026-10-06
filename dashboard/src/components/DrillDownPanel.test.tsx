import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DrillDownPanel } from "@/components/DrillDownPanel";
import { DEFAULTS, useFilters } from "@/store/filters";
import type { StatsRow } from "@/lib/api";
import { NOW, openMeteoFetch } from "@/test/replayFixtures";

const row = (period_start: string, avg: number, metric: string): StatsRow => metric === "precip_mm"
  ? { location_id: "stockton-ca", period_start, min: null, max: null, avg: null, sum: avg / 10, n_values: 24, n_hours: 24 }
  : { location_id: "stockton-ca", period_start, min: avg - 5, max: avg + 5, avg, sum: null, n_values: 24, n_hours: 24 };

vi.mock("@/lib/api", () => ({
  api: {
    locations: async () => ({ data: [{ id: "stockton-ca", name: "Stockton", state: "CA", region: "West", lat: 37.96, lon: -121.29, timezone: "America/Los_Angeles" }] }),
    stats: async (p: { period: string; from: string; metric: string }) => {
      if (p.period === "year") return { data: [row("2024-01-01", 16, p.metric), row("2025-01-01", 17, p.metric)] };
      if (p.period === "month") return { data: [row(`${p.from.slice(0, 4)}-07-01`, 25, p.metric), row(`${p.from.slice(0, 4)}-08-01`, 26, p.metric)] };
      return { data: [row(`${p.from.slice(0, 7)}-01`, 24, p.metric)] };
    },
  },
}));

const renderPanel = () =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DrillDownPanel /></QueryClientProvider>);
const chart = (name: RegExp) => screen.getByRole("group", { name });

describe("DrillDownPanel", () => {
  beforeEach(() => useFilters.setState({ ...DEFAULTS, city: "stockton-ca", year: "2025", month: "" }));

  it("is hidden by default: no city → only a placeholder", () => {
    useFilters.setState({ ...DEFAULTS });
    renderPanel();
    expect(screen.getByText("Click a city on the map to see its monthly history.")).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("close (×) hides it, clears city, year and month, and goes back to All US", async () => {
    const user = userEvent.setup();
    useFilters.setState({ ...DEFAULTS, location: "miami-fl", city: "stockton-ca", year: "2025", month: "07" });
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Close city history" }));
    expect(useFilters.getState()).toMatchObject({ city: "", year: "", month: "", location: "all" });
    expect(screen.getByText("Click a city on the map to see its monthly history.")).toBeInTheDocument();
  });

  it("shows temperature and rain side by side; drilling on the rain chart drills both", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findAllByRole("button", { name: /^Jul:/ });
    expect(chart(/^Temperature in Stockton, CA per month, 2025/)).toHaveAttribute("data-points", "12");
    expect(chart(/^Rain in Stockton, CA per month, 2025/)).toHaveAttribute("data-points", "12");
    expect(screen.queryByRole("button", { name: /^Jan:/ })).not.toBeInTheDocument();   // no data → not selectable

    await user.click(within(chart(/^Rain in/)).getByRole("button", { name: /^Jul:/ }));
    expect(useFilters.getState()).toMatchObject({ year: "2025", month: "07" });
    expect(await screen.findByRole("group", { name: /^Temperature in .* per day, Jul 2025/ })).toHaveAttribute("data-points", "31");
    expect(chart(/^Rain in .* per day, Jul 2025/)).toHaveAttribute("data-points", "31");
    expect(screen.getByText("Jul")).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("button", { name: "2025" }));
    expect(useFilters.getState()).toMatchObject({ year: "2025", month: "" });
    await user.click(await screen.findByRole("button", { name: "Stockton, CA" }));
    expect(useFilters.getState().year).toBe("all");
    expect((await screen.findAllByRole("button", { name: /^2024:/ })).length).toBe(2);   // years level, both charts
  });

  it("syncs the crosshair: hovering a month on one chart shows it on the other", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    await screen.findAllByRole("button", { name: /^Jul:/ });
    await user.hover(within(chart(/^Temperature/)).getByRole("button", { name: /^Aug:/ }));
    expect(container.querySelectorAll("[data-crosshair]")).toHaveLength(2);
    expect(within(chart(/^Rain in/)).getByText("Aug", { selector: "[data-tooltip] div" })).toBeInTheDocument();
  });

  it("points to the forecast replay in the year view only (not in the all-years or month view)", async () => {
    const hint = () => document.querySelector("[data-drill-hint]");
    const { unmount } = renderPanel();   // year view: 12 months of 2025
    await screen.findAllByRole("button", { name: /^Jul:/ });
    expect(hint()).toHaveTextContent("Select a month on either chart to drill down. Open a month, then use Replay forecasts to see how each model's forecast changed.");
    expect(within(hint() as HTMLElement).getByText("Replay forecasts")).toHaveClass("text-cta");
    expect(screen.queryByRole("button", { name: "Replay forecasts" })).not.toBeInTheDocument();
    unmount();

    useFilters.setState({ ...DEFAULTS, city: "stockton-ca", year: "all", month: "" });
    const years = renderPanel();          // all years: only the year hint
    await screen.findAllByRole("button", { name: /^2024:/ });
    expect(hint()).toHaveTextContent(/^Select a year on either chart to drill down\.$/);
    years.unmount();

    useFilters.setState({ ...DEFAULTS, city: "stockton-ca", year: "2025", month: "07" });
    renderPanel();                        // month view: the button instead of the hint
    expect(await screen.findByRole("button", { name: "Replay forecasts" })).toBeInTheDocument();
    expect(hint()).toBeNull();
    expect(screen.queryByText(/Open a month, then use/)).not.toBeInTheDocument();
  });

  it("opens the forecast replay only on request at the days level, and returns focus when it closes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);   // fixed clock: replayable days end 2026-09-28
    const f = openMeteoFetch();
    vi.stubGlobal("fetch", f);
    const user = userEvent.setup();
    useFilters.setState({ ...DEFAULTS, city: "stockton-ca", year: "2025", month: "07" });
    renderPanel();
    const open = await screen.findByRole("button", { name: "Replay forecasts" });
    expect(open).toHaveClass("bg-cta", "text-cta-foreground");   // primary look, same accessible name
    expect(open).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("[data-drill-hint]")).toBeNull();
    expect(f).not.toHaveBeenCalled();
    await user.click(open);
    expect(screen.getByRole("heading", { name: "Forecast replay" })).toHaveFocus();
    expect(await screen.findByText(/^ECMWF was off by/)).toBeInTheDocument();
    expect(f).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Close forecast replay" }));
    expect(screen.queryByRole("heading", { name: "Forecast replay" })).not.toBeInTheDocument();
    expect(open).toHaveFocus();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
