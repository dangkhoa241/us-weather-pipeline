import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatsChart } from "@/components/chart/StatsChart";
import { csvOf } from "@/components/chart/exportChart";
import { monthPoints } from "@/lib/drill";
import type { StatsRow } from "@/lib/api";

const row = (period_start: string, avg: number | null, sum: number | null = null): StatsRow => ({
  location_id: "stockton-ca", period_start, min: avg == null ? null : avg - 5, max: avg == null ? null : avg + 5,
  avg, sum, n_values: avg == null && sum == null ? 0 : 24, n_hours: 24,
});
// Jan–Mar have data, the rest of the year is in the future (no rows).
const months = monthPoints([row("2026-01-01", 10), row("2026-02-01", 12), row("2026-03-01", 15)]);
const buckets = () => screen.getAllByRole("button").filter((b) => b.hasAttribute("data-key"));

describe("StatsChart (d3)", () => {
  it("makes only buckets with data selectable, labelled in display units", () => {
    render(<StatsChart points={months} metric="temp_c" unit="F" title="Temperature per month" onSelect={vi.fn()} />);
    expect(buckets()).toHaveLength(3);
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

  it("draws overlays: moving average, dashed mean with its value, max and min markers", () => {
    const { container } = render(<StatsChart points={months} metric="temp_c" unit="C" title="t" />);
    expect(container.querySelector("[data-ma]")?.getAttribute("d")).toMatch(/^M/);
    expect(container.querySelector("[data-mean]")?.textContent).toBe("avg 12.3°C");
    expect(container.querySelector('[data-marker="max"]')?.textContent).toBe("▲ 20.0");   // Mar max (15 + 5)
    expect(container.querySelector('[data-marker="min"]')?.textContent).toBe("▼ 5.0");    // Jan min (10 − 5)
  });

  it("draws rain as bars, leaves missing values empty (not 0), and exports them as empty CSV cells", () => {
    const rain = monthPoints([row("2026-01-01", null, 30), row("2026-02-01", null, 4)]);
    const { container } = render(<StatsChart points={rain} metric="precip_mm" unit="C" title="Rain" />);
    expect(container.querySelectorAll("[data-bar]")).toHaveLength(2);
    expect(buckets()).toHaveLength(0);   // no drill-down without onSelect
    expect(csvOf(rain, "precip_mm", "C").split("\n").slice(0, 4)).toEqual(["bucket,label,precip_mm", "01,Jan,30", "02,Feb,4", "03,Mar,"]);
  });

  it("shows rain chance in percent: a fixed 0–100% axis, values, markers and tooltip in whole percents", () => {
    const chance = monthPoints([row("2026-01-01", null, 20), row("2026-02-01", null, 65)]);
    const { container } = render(<StatsChart points={chance} metric="precip_mm" rainUnit="%" unit="F" title="Rain chance" hoverKey="02" />);
    const ticks = [...container.querySelectorAll("text[x='40']")].map((t) => t.textContent);   // y-axis labels (x = left margin − 6)
    expect(ticks[0]).toBe("0%");
    expect(ticks.at(-1)).toBe("100%");
    expect(container.querySelector('[data-marker="max"]')?.textContent).toBe("▲ 65%");
    expect(container.querySelector("[data-mean]")?.textContent).toBe("avg 43%");
    expect(container.querySelector("[data-tooltip]")?.textContent).toContain("65%");
    expect(container.querySelector("[data-tooltip]")?.textContent).not.toContain("65.0");
  });

  it("follows a hover key from outside (synced crosshair) and reports its own hover", async () => {
    const user = userEvent.setup();
    const onHoverKey = vi.fn();
    const { container, rerender } = render(<StatsChart points={months} metric="temp_c" unit="C" title="t" hoverKey={null} onHoverKey={onHoverKey} onSelect={vi.fn()} />);
    expect(container.querySelector("[data-crosshair]")).toBeNull();
    await user.hover(screen.getByRole("button", { name: /^Feb:/ }));
    expect(onHoverKey).toHaveBeenCalledWith("02");
    rerender(<StatsChart points={months} metric="temp_c" unit="C" title="t" hoverKey="03" onHoverKey={onHoverKey} />);
    expect(container.querySelector("[data-crosshair]")).toBeInTheDocument();
    expect(container.querySelector("[data-tooltip]")?.textContent).toContain("Mar");
  });

  it("opens a menu to download PNG or CSV", async () => {
    const user = userEvent.setup();
    render(<StatsChart points={months} metric="temp_c" unit="C" title="t" />);
    await user.click(screen.getByRole("button", { name: "Chart menu" }));
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Download PNG", "Download CSV"]);
  });
});
