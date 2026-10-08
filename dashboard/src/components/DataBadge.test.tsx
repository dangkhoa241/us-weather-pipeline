import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DataBadge } from "@/components/DataBadge";
import { DEFAULTS, useFilters } from "@/store/filters";

// Fixed dates: history through Oct 2, NWS forecast for Los Angeles issued 2026-10-07 19:50 UTC (12:50 PM PDT),
// the latest NWS issue time across cities 2026-10-07 23:52 UTC, accuracy scored through Sep 30.
const snap = vi.hoisted(() => ({
  source: { kind: "live", data_as_of: "2026-10-02", generated_at: "2026-10-08T00:35:10Z" } as { kind: "live" | "snapshot"; data_as_of: string; generated_at: string },
}));
vi.mock("@/lib/snapshot", () => ({
  snapshotManifest: () => ({ format: 1, snapshot: "snapshot-2026-10-02", data_as_of: "2026-10-02", window: { from: "2023-01-01", to: "2026-10-02" }, generated_at: "2026-10-07T20:32:55Z" }),
  dataSource: () => snap.source,
  accuracyAsOf: () => "2026-09-30",
  latestNwsIssued: async () => "2026-10-07 23:52:50",
}));
vi.mock("@/lib/api", () => ({
  api: {
    locations: async () => ({ data: [{ id: "los-angeles-ca", name: "Los Angeles", state: "CA", region: "West", lat: 34.05, lon: -118.24, timezone: "America/Los_Angeles" }] }),
    forecast: async () => ({ data: [{ model: "nws", issued_at: "2026-10-07 19:50:00", target_time: "2026-10-07 20:00:00", temp_c: 30, precip_mm: null, precip_prob_pct: 0, wind_speed_ms: null }] }),
    forecastPeriods: async () => ({ data: [] }),
  },
}));

const renderBadge = () =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><DataBadge /></QueryClientProvider>);
const badge = () => document.querySelector("[data-source]");

describe("DataBadge (page-aware)", () => {
  beforeEach(() => {
    snap.source = { ...snap.source, kind: "live" };
    useFilters.setState({ ...DEFAULTS });
  });

  it("Overview: Live · history through Oct 2, the date explains the archive delay", async () => {
    const user = userEvent.setup();
    renderBadge();
    expect(badge()).toHaveTextContent(/^Live · history through Oct 2$/);
    expect(badge()).toHaveAttribute("data-source", "live");
    await user.hover(screen.getByText("Oct 2"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Open-Meteo's archive, which publishes about 5 days late. Forecasts and alerts are current.");
  });

  it("Forecast: the selected city's NWS issue time in its time zone", async () => {
    useFilters.setState({ ...DEFAULTS, page: "forecast", city: "los-angeles-ca" });
    renderBadge();
    expect(await screen.findByText(/forecast updated Oct 7, 12:50 PM/)).toBeInTheDocument();
    expect(badge()).toHaveTextContent(/^Live · forecast updated Oct 7, 12:50 PM$/);
  });

  it("Forecast without a city: the latest NWS issue time across cities", async () => {
    useFilters.setState({ ...DEFAULTS, page: "forecast" });
    renderBadge();
    expect(await screen.findByText(/forecast updated Oct 7, /)).toBeInTheDocument();
  });

  it("Accuracy: Live · scored through the last scored day", () => {
    useFilters.setState({ ...DEFAULTS, page: "accuracy" });
    renderBadge();
    expect(badge()).toHaveTextContent(/^Live · scored through Sep 30$/);
  });

  it("falls back to Snapshot with the same page-aware wording", async () => {
    snap.source = { kind: "snapshot", data_as_of: "2026-10-02", generated_at: "2026-10-07T20:32:55Z" };
    const { unmount } = renderBadge();
    expect(badge()).toHaveTextContent(/^Snapshot · history through Oct 2$/);
    expect(badge()).toHaveAttribute("data-source", "snapshot");
    unmount();
    useFilters.setState({ ...DEFAULTS, page: "forecast", city: "los-angeles-ca" });
    renderBadge();
    expect(await screen.findByText(/^Snapshot · forecast updated Oct 7, 12:50 PM$/)).toBeInTheDocument();
  });
});
