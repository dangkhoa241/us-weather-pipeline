import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DrillDownPanel } from "@/components/DrillDownPanel";
import { DEFAULTS, useFilters } from "@/store/filters";
import type { StatsRow } from "@/lib/api";

const row = (period_start: string, avg: number): StatsRow => ({
  location_id: "stockton-ca", period_start, min: avg - 5, max: avg + 5, avg, sum: null, n_values: 24, n_hours: 24,
});

vi.mock("@/lib/api", () => ({
  api: {
    locations: async () => ({ data: [{ id: "stockton-ca", name: "Stockton", state: "CA", region: "West", lat: 37.96, lon: -121.29, timezone: "America/Los_Angeles" }] }),
    stats: async (p: { period: string; from: string }) => {
      if (p.period === "year") return { data: [row("2024-01-01", 16), row("2025-01-01", 17)] };
      if (p.period === "month") return { data: [row(`${p.from.slice(0, 4)}-07-01`, 25), row(`${p.from.slice(0, 4)}-08-01`, 26)] };
      return { data: [row(`${p.from.slice(0, 7)}-01`, 24)] };
    },
  },
}));

const renderPanel = () =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DrillDownPanel /></QueryClientProvider>);

describe("DrillDownPanel", () => {
  beforeEach(() => useFilters.setState({ ...DEFAULTS, location: "stockton-ca", year: "2025", month: "" }));

  it("drills from 12 months to the days of a month and back via the breadcrumb", async () => {
    const user = userEvent.setup();
    renderPanel();
    const july = await screen.findByRole("button", { name: /^Jul:/ });
    expect(screen.getByRole("group", { name: /per month, 2025/ })).toHaveAttribute("data-points", "12");
    expect(screen.queryByRole("button", { name: /^Jan:/ })).not.toBeInTheDocument();   // no data → not selectable

    await user.click(july);
    expect(useFilters.getState()).toMatchObject({ year: "2025", month: "07" });
    expect(await screen.findByRole("group", { name: /per day, Jul 2025/ })).toHaveAttribute("data-points", "31");
    expect(screen.getByText("Jul")).toHaveAttribute("aria-current", "page");

    await user.click(screen.getByRole("button", { name: "2025" }));
    expect(useFilters.getState()).toMatchObject({ year: "2025", month: "" });
    await user.click(await screen.findByRole("button", { name: "Stockton, CA" }));
    expect(useFilters.getState().year).toBe("all");
    expect(await screen.findByRole("button", { name: /^2024:/ })).toBeInTheDocument();   // years level lists years with data
  });
});
