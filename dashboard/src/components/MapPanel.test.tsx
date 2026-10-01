import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MapPanel } from "@/components/MapPanel";
import { DEFAULTS, useFilters } from "@/store/filters";

vi.mock("@/lib/api", () => ({
  api: {
    map: async () => ({ data: [
      { state: "CA", region: "West", cities: 1, temp_avg_c: 24.6, temp_max_c: 40, precip_mm_per_city: 1.2 },
      { state: "TX", region: "South", cities: 1, temp_avg_c: 29.3, temp_max_c: 41, precip_mm_per_city: 0 },
    ] }),
    locations: async () => ({ data: [
      { id: "stockton-ca", name: "Stockton", state: "CA", region: "West", lat: 37.96, lon: -121.29, timezone: "America/Los_Angeles" },
      { id: "houston-tx", name: "Houston", state: "TX", region: "South", lat: 29.76, lon: -95.37, timezone: "America/Chicago" },
    ] }),
    stats: async () => ({ data: [{ location_id: "stockton-ca", period_start: "2026-01-01", min: 10, max: 30, avg: 20, sum: null, n_values: 24, n_hours: 24 }] }),
  },
}));

const renderPanel = () =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MapPanel /></QueryClientProvider>);

describe("MapPanel: map and table are linked", () => {
  beforeEach(() => useFilters.setState({ ...DEFAULTS }));

  it("hovering a table row highlights the state; hovering the state highlights the row", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    const row = await screen.findByRole("row", { name: /^TX South/ });
    await user.hover(row);
    expect(container.querySelector('[data-state="TX"]')).toHaveAttribute("data-hover", "true");
    await user.unhover(row);
    await user.hover(screen.getByRole("button", { name: /^California:/ }));
    expect(container.querySelector('[data-row-state="CA"]')?.className).toContain("bg-muted");
  });

  it("clicking a row zooms the map like clicking the state", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("row", { name: /^TX South/ }));
    expect(screen.getByRole("group", { name: /US map/ })).toHaveAttribute("data-map-level", "state");
    expect(screen.getByRole("row", { name: /^TX South/ })).toHaveAttribute("aria-selected", "true");
  });

  it("clicking a city dot opens its history (city in the filters)", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: /^Select Stockton, CA: 68\.0 °F/ }));
    expect(useFilters.getState()).toMatchObject({ city: "stockton-ca", location: "stockton-ca" });
    expect(screen.getByRole("button", { name: /^Select Houston, TX: data loading/ })).toBeInTheDocument();
  });
});
