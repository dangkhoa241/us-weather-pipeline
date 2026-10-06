import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ForecastReplayPanel } from "@/components/replay/ForecastReplayPanel";
import sample from "../../../public/data/replay-sample.json?raw";
import { NOW, openMeteoFetch } from "@/test/replayFixtures";

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const panel = (qc: QueryClient, props: Partial<React.ComponentProps<typeof ForecastReplayPanel>> = {}) => (
  <QueryClientProvider client={qc}>
    <ForecastReplayPanel city="stockton-ca" cityName="Stockton" year="2026" month="09" unit="F" now={NOW} onClose={() => {}} onJump={() => {}} {...props} />
  </QueryClientProvider>
);

afterEach(() => vi.unstubAllGlobals());

describe("ForecastReplayPanel", () => {
  it("replays the month's last replayable day live, with label, insight, attribution and focus", async () => {
    const f = openMeteoFetch();
    vi.stubGlobal("fetch", f);
    render(panel(client()));
    expect(screen.getByRole("heading", { name: "Forecast replay" })).toHaveFocus();
    expect(await screen.findByText(/^ECMWF was off by 6\.1°F seven days ahead and by 0\.7°F one day ahead\./)).toBeInTheDocument();
    expect(screen.getByText("Live · Open-Meteo previous runs")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /^Forecasts of the high for Stockton on Mon, Sep 28, 2026/ })).toHaveAttribute("data-series", "5");
    expect(screen.getByRole("link", { name: "Open-Meteo.com" })).toHaveAttribute("href", "https://open-meteo.com/");
    expect(screen.getByRole("link", { name: "CC BY 4.0" })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/^ICON: 83\.8°F six days ahead/)).toBeInTheDocument();   // text, not only colors
    const days = f.mock.calls.map(([u]) => new URL(String(u)).searchParams.get("start_date"));
    expect(days).toEqual(["2026-09-27", "2026-09-27"]);
  });

  it("never sends a second request for the same city and day (closing and reopening uses the cache)", async () => {
    const f = openMeteoFetch();
    vi.stubGlobal("fetch", f);
    const qc = client();
    const first = render(panel(qc));
    await screen.findByText(/^ECMWF was off/);
    first.unmount();
    render(panel(qc));
    expect(screen.getByText(/^ECMWF was off/)).toBeInTheDocument();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("says live data is unavailable and shows the bundled sample, without retrying", async () => {
    const f = openMeteoFetch({ "/data/replay-sample.json": () => new Response(sample) });
    const failing = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("open-meteo.com")) throw new TypeError("Failed to fetch");
      return f(input, init);
    });
    vi.stubGlobal("fetch", failing);
    const qc = client();
    const first = render(panel(qc, { city: "boise-id", cityName: "Boise" }));
    expect(await screen.findByText(/Showing a bundled sample instead: Stockton, Sun, Sep 20, 2026\./)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Live data unavailable. Open-Meteo can't be reached.");
    expect(screen.getByText("Sample · bundled, not live")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /^Forecasts of the high for Stockton on Sun, Sep 20, 2026/ })).toHaveAttribute("data-series", "5");
    first.unmount();
    render(panel(qc, { city: "boise-id", cityName: "Boise" }));
    await screen.findByText(/Showing a bundled sample/);
    expect(failing.mock.calls.filter(([u]) => String(u).includes("open-meteo.com"))).toHaveLength(2);   // one pair, not retried
  });

  it("explains the range for a month without replayable days and offers the latest month", async () => {
    const f = openMeteoFetch();
    vi.stubGlobal("fetch", f);
    const onJump = vi.fn();
    const user = userEvent.setup();
    render(panel(client(), { month: "10", onJump }));
    expect(screen.getByText(/Forecast replay covers Fri, Mar 1, 2024 – Mon, Sep 28, 2026/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show Sep 2026" }));
    expect(onJump).toHaveBeenCalledWith("2026", "09");
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a location that isn't one of the 53 cities without calling the network", () => {
    const f = openMeteoFetch();
    vi.stubGlobal("fetch", f);
    render(panel(client(), { city: "all", cityName: "All US" }));
    expect(screen.getByText("Forecast replay isn't available for this location.")).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });
});
