import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatsChart } from "@/components/chart/StatsChart";
import { monthPoints } from "@/lib/drill";
import type { StatsRow } from "@/lib/api";

const row = (period_start: string, avg: number | null, sum: number | null = null): StatsRow => ({
  location_id: "stockton-ca", period_start, min: avg == null ? null : avg - 5, max: avg == null ? null : avg + 5,
  avg, sum, n_values: avg == null && sum == null ? 0 : 24, n_hours: 24,
});
// Jan–Mar have data, the rest of the year is in the future (no rows).
const months = monthPoints([row("2026-01-01", 10), row("2026-02-01", 12), row("2026-03-01", 15)]);

describe("StatsChart (d3)", () => {
  it("makes only buckets with data selectable, labelled in display units", () => {
    render(<StatsChart points={months} metric="temp_c" unit="F" title="Temperature per month" onSelect={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Jan: average 50.0°F, min 41.0, max 59.0. Show details" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Temperature per month" })).toHaveAttribute("data-points", "12");
  });

  it("selects a bucket with the keyboard and the mouse", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<StatsChart points={months} metric="temp_c" unit="C" title="t" onSelect={onSelect} />);
    screen.getByRole("button", { name: /^Feb:/ }).focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: /^Mar:/ }));
    expect(onSelect.mock.calls).toEqual([["02"], ["03"]]);
  });

  it("draws precipitation as bars and leaves missing values empty (not 0)", () => {
    const rain = monthPoints([row("2026-01-01", null, 30), row("2026-02-01", null, 0)]);
    const { container } = render(<StatsChart points={rain} metric="precip_mm" unit="C" title="Rain" />);
    // 2 value bars (Jan 30 mm, Feb 0 mm) + 12 hit rects; no buttons without onSelect.
    const bars = container.querySelectorAll('rect[fill="#2171b5"]');
    expect(bars).toHaveLength(2);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(container.querySelector("title")?.textContent).toBe("Jan: 30.0 mm");
  });
});
