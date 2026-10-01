import { describe, it, expect } from "vitest";
import { aggregate, periodStart } from "@/lib/snapshot";
import type { StatsRow } from "@/lib/api";

describe("periodStart (same rules as the API's period builder)", () => {
  it.each([
    ["2026-07-08", "week", "2026-07-06"],      // Wednesday → Monday
    ["2026-07-06", "week", "2026-07-06"],
    ["2026-07-05", "week", "2026-06-29"],      // Sunday belongs to the week starting the Monday before
    ["2026-08-31", "month", "2026-08-01"],
    ["2026-08-31", "quarter", "2026-07-01"],
    ["2026-06-30", "half", "2026-01-01"],
    ["2026-07-01", "half", "2026-07-01"],
    ["2026-12-31", "year", "2026-01-01"],
    ["2026-12-31", "day", "2026-12-31"],
  ])("%s / %s → %s", (day, period, start) => {
    expect(periodStart(day, period)).toBe(start);
  });
});

describe("aggregate", () => {
  const row = (day: string, v: Partial<StatsRow>): StatsRow =>
    ({ location_id: "x", period_start: day, min: null, max: null, avg: null, sum: null, n_values: 24, n_hours: 24, ...v });

  it("combines days into periods: min of mins, max of maxes, hour-weighted mean, sum of sums", () => {
    const rows = [
      row("2026-07-01", { min: 10, max: 20, avg: 15, n_values: 24 }),
      row("2026-07-02", { min: 12, max: 30, avg: 21, n_values: 12 }),   // half a day of data weighs half
      row("2026-08-01", { min: 5, max: 9, avg: 7 }),
    ];
    expect(aggregate(rows, "month")).toEqual([
      { location_id: "x", period_start: "2026-07-01", min: 10, max: 30, avg: 17, sum: null, n_values: 36, n_hours: 48 },
      { location_id: "x", period_start: "2026-08-01", min: 5, max: 9, avg: 7, sum: null, n_values: 24, n_hours: 24 },
    ]);
  });

  it("keeps nulls when a period has no values (never 0)", () => {
    expect(aggregate([row("2026-07-01", { sum: null })], "year")[0]).toMatchObject({ sum: null, avg: null, min: null });
    expect(aggregate([row("2026-07-01", { sum: 0 }), row("2026-07-02", { sum: 2.5 })], "year")[0].sum).toBe(2.5);
  });

  it("returns daily rows unchanged for period=day", () => {
    const rows = [row("2026-07-01", { avg: 1 })];
    expect(aggregate(rows, "day")).toBe(rows);
  });
});
