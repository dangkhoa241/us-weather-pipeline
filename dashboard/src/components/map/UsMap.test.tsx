import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UsMap } from "@/components/map/UsMap";
import type { LocationRow, MapRow } from "@/lib/api";

const states: MapRow[] = [
  { state: "CA", region: "West", cities: 2, temp_avg_c: 24.6, temp_max_c: 40, precip_mm_per_city: 1.2 },
  { state: "TX", region: "South", cities: 1, temp_avg_c: 29.3, temp_max_c: 41, precip_mm_per_city: null },
];
const locations: LocationRow[] = [
  { id: "los-angeles-ca", name: "Los Angeles", state: "CA", region: "West", lat: 34.05, lon: -118.24, timezone: "America/Los_Angeles" },
  { id: "stockton-ca", name: "Stockton", state: "CA", region: "West", lat: 37.96, lon: -121.29, timezone: "America/Los_Angeles" },
  { id: "houston-tx", name: "Houston", state: "TX", region: "South", lat: 29.76, lon: -95.37, timezone: "America/Chicago" },
];

const renderMap = (onSelectLocation = vi.fn()) =>
  render(<UsMap states={states} locations={locations} metric="temp_c" unit="F" selectedLocation="stockton-ca" onSelectLocation={onSelectLocation} />);

const cityValues = new Map<string, number | null>([["los-angeles-ca", 22], ["stockton-ca", 18]]);   // Houston: still loading

describe("UsMap (d3-geo)", () => {
  it("shows every city as a dot: colored with a value, hollow grey while data is loading", () => {
    render(<UsMap states={states} locations={locations} metric="temp_c" unit="C" selectedLocation="" onSelectLocation={vi.fn()} cityValues={cityValues} />);
    expect(screen.getByRole("button", { name: "Select Los Angeles, CA: 22.0 °C" })).not.toHaveAttribute("data-loading");
    const houston = screen.getByRole("button", { name: "Select Houston, TX: data loading" });
    expect(houston).toHaveAttribute("data-loading", "true");
    expect(houston.querySelector("title")?.textContent).toBe("Houston, TX: Data loading");
    expect(screen.getAllByRole("button", { name: /^Select / })).toHaveLength(3);
  });

  it("fills states without data with the hatch pattern", () => {
    const { container } = renderMap();
    expect(container.querySelector('[data-state="NV"]')).toHaveAttribute("fill", "url(#map-nodata-hatch)");
    expect(container.querySelector('[data-state="CA"]')?.getAttribute("fill")).toMatch(/^rgb/);
  });

  it("can be controlled: hovering a state reports it, and a hovered state from outside is highlighted", async () => {
    const user = userEvent.setup();
    const onHover = vi.fn();
    const { container, rerender } = render(<UsMap states={states} locations={locations} metric="temp_c" unit="F" selectedLocation=""
      onSelectLocation={vi.fn()} onHoverState={onHover} hoveredState={null} />);
    await user.hover(screen.getByRole("button", { name: /^Texas:/ }));
    expect(onHover).toHaveBeenCalledWith("TX");
    rerender(<UsMap states={states} locations={locations} metric="temp_c" unit="F" selectedLocation="" onSelectLocation={vi.fn()} hoveredState="CA" />);
    expect(container.querySelector('[data-state="CA"]')).toHaveAttribute("data-hover", "true");
    expect(container.querySelector("[data-hover-outline]")).toBeInTheDocument();
  });

  it("zooms to an externally chosen state (table row click) and loads its counties lazily", async () => {
    const { container, rerender } = render(<UsMap states={states} locations={locations} metric="temp_c" unit="F" selectedLocation=""
      onSelectLocation={vi.fn()} zoomState={null} />);
    expect(container.querySelectorAll("[data-county]")).toHaveLength(0);   // no county data on first load
    rerender(<UsMap states={states} locations={locations} metric="temp_c" unit="F" selectedLocation="" onSelectLocation={vi.fn()} zoomState="CA" />);
    expect(screen.getByRole("group", { name: /US map/ })).toHaveAttribute("data-map-level", "state");
    await waitFor(() => expect(container.querySelectorAll("[data-county]").length).toBeGreaterThan(40));   // California has 58 counties
    expect(screen.getByText("Stockton")).toBeInTheDocument();   // city names appear when zoomed
  });

  it("renders every state as a labelled button with its value in display units", () => {
    renderMap();
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(50);
    expect(screen.getByRole("button", { name: "California: 76.3 °F, 2 tracked cities" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Nevada: no data$/ })).toBeInTheDocument();   // missing data is not 0
  });

  it("drills into a state with the keyboard and shows only that state's cities", async () => {
    const user = userEvent.setup();
    renderMap();
    screen.getByRole("button", { name: /^California:/ }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("group", { name: /US map/ })).toHaveAttribute("data-map-level", "state");
    expect(screen.getByRole("button", { name: /^Select Los Angeles, CA/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Select Stockton, CA/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /^Select Houston, TX/ })).not.toBeInTheDocument();
  });

  it("selects a city and can go back to the whole US", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderMap(onSelect);
    await user.click(screen.getByRole("button", { name: /^California:/ }));
    await user.click(screen.getByRole("button", { name: /^Select Los Angeles, CA/ }));
    expect(onSelect).toHaveBeenCalledWith("los-angeles-ca");
    await user.click(screen.getByRole("button", { name: "← United States" }));
    expect(screen.getByRole("group", { name: /US map/ })).toHaveAttribute("data-map-level", "us");
  });
});
