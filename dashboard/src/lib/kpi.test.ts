import { describe, it, expect } from "vitest";
import { computeKpis, delta } from "@/lib/kpi";
import { compareRange } from "@/lib/dates";
import type { AccuracyRow, StatsRow } from "@/lib/api";

const day = (period_start: string, v: Partial<StatsRow>): StatsRow =>
  ({ location_id: "x", period_start, min: null, max: null, avg: null, sum: null, n_values: 24, n_hours: 24, ...v });

describe("computeKpis", () => {
  const temp = [day("2026-07-01", { avg: 20, max: 30, min: 10 }), day("2026-07-02", { avg: 24, max: 35, min: 12 }), day("2026-07-03", {})];
  const rain = [day("2026-07-01", { sum: 0 }), day("2026-07-02", { sum: 5.5 }), day("2026-07-03", { sum: 1 }), day("2026-07-04", { sum: null })];
  const acc: AccuracyRow[] = [
    { model: "a", lead_days: 1, n: 100, days: 90, mae_c: 1, bias_c: 0 },
    { model: "b", lead_days: 1, n: 300, days: 90, mae_c: 2, bias_c: 0 },
    { model: "a", lead_days: 3, n: 100, days: 90, mae_c: 9, bias_c: 0 },
  ];

  it("aggregates daily rows and skips missing values instead of counting them as 0", () => {
    expect(computeKpis(temp, rain, acc)).toEqual({
      tempAvg: 22, tempMax: 35, tempMin: 10,
      rainTotal: 6.5, rainyDays: 2,           // 5.5 and 1.0 mm; the null day is not a dry day
      forecastMae: 1.75,                      // day-1 only, weighted by n: (1·100 + 2·300) / 400
    });
  });

  it("returns null (not 0) when there is no data", () => {
    expect(computeKpis([day("2026-07-01", {})], [day("2026-07-01", { sum: null })], [])).toEqual({
      tempAvg: null, tempMax: null, tempMin: null, rainTotal: null, rainyDays: null, forecastMae: null,
    });
  });

  it("counts a 0 mm day as dry but still as data", () => {
    expect(computeKpis([], [day("2026-07-01", { sum: 0 })], [])).toMatchObject({ rainTotal: 0, rainyDays: 0 });
  });
});

describe("delta", () => {
  it("computes absolute and percent change with a direction", () => {
    expect(delta(12, 10)).toEqual({ abs: 2, pct: 20, direction: "up" });
    expect(delta(5, 10)).toEqual({ abs: -5, pct: -50, direction: "down" });
    expect(delta(-5, -10)).toEqual({ abs: 5, pct: 50, direction: "up" });
  });

  it("is flat for no change and has no percent when the previous value is 0", () => {
    expect(delta(3, 3)).toEqual({ abs: 0, pct: 0, direction: "flat" });
    expect(delta(4, 0)).toEqual({ abs: 4, pct: null, direction: "up" });
  });

  it("is null when either side is missing", () => {
    expect(delta(null, 3)).toBeNull();
    expect(delta(3, null)).toBeNull();
  });
});

describe("compareRange", () => {
  it("gives the previous period of equal length", () => {
    expect(compareRange({ from: "2026-07-01", to: "2026-07-30" }, "previous")).toEqual({ from: "2026-06-01", to: "2026-06-30" });
  });
  it("gives the same period last year (Feb 29 → Feb 28)", () => {
    expect(compareRange({ from: "2024-02-01", to: "2024-02-29" }, "last_year")).toEqual({ from: "2023-02-01", to: "2023-02-28" });
  });
});
