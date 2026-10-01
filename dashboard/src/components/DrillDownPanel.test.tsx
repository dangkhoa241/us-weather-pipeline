import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DrillDownPanel } from "@/components/DrillDownPanel";
import { DEFAULTS, useFilters } from "@/store/filters";
import type { StatsRow } from "@/lib/api";

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

  it("close (×) hides it and clears city, year and month (KPI location stays)", async () => {
    const user = userEvent.setup();
    useFilters.setState({ ...DEFAULTS, location: "miami-fl", city: "stockton-ca", year: "2025", month: "07" });
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Close city history" }));
    expect(useFilters.getState()).toMatchObject({ city: "", year: "", month: "", location: "miami-fl" });
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
});
