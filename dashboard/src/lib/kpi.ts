// KPI calculations from API rows (metric units). Missing data stays null: never counted as 0.
import type { AccuracyRow, StatsRow } from "@/lib/api";

export const RAINY_DAY_MM = 1.0;   // a day with at least 1 mm of precipitation counts as rainy

export type Kpis = {
  tempAvg: number | null;
  tempMax: number | null;
  tempMin: number | null;
  rainTotal: number | null;
  rainyDays: number | null;
  forecastMae: number | null;   // day-1 temperature MAE across models, weighted by sample count
};

const present = (values: (number | null)[]) => values.filter((v): v is number => v != null && !Number.isNaN(v));

/**
 * @param tempDaily  /stats rows for temp_c, period=day (one per local day)
 * @param rainDaily  /stats rows for precip_mm, period=day
 * @param accuracy   /accuracy rows (per model and lead day)
 */
export function computeKpis(tempDaily: StatsRow[], rainDaily: StatsRow[], accuracy: AccuracyRow[]): Kpis {
  const avgs = present(tempDaily.map((r) => r.avg));
  const maxes = present(tempDaily.map((r) => r.max));
  const mins = present(tempDaily.map((r) => r.min));
  const rain = present(rainDaily.map((r) => r.sum));
  const day1 = accuracy.filter((r) => r.lead_days === 1 && r.mae_c != null && r.n > 0);
  const n = day1.reduce((a, r) => a + r.n, 0);
  return {
    tempAvg: avgs.length ? avgs.reduce((a, v) => a + v, 0) / avgs.length : null,
    tempMax: maxes.length ? Math.max(...maxes) : null,
    tempMin: mins.length ? Math.min(...mins) : null,
    rainTotal: rain.length ? rain.reduce((a, v) => a + v, 0) : null,
    rainyDays: rain.length ? rain.filter((v) => v >= RAINY_DAY_MM).length : null,
    forecastMae: n ? day1.reduce((a, r) => a + (r.mae_c as number) * r.n, 0) / n : null,
  };
}

export type Delta = { abs: number; pct: number | null; direction: "up" | "down" | "flat" };

/** Change from `previous` to `current`; null when either side is missing. pct is null when previous is 0. */
export function delta(current: number | null, previous: number | null): Delta | null {
  if (current == null || previous == null) return null;
  const abs = current - previous;
  const direction = Math.abs(abs) < 1e-9 ? "flat" : abs > 0 ? "up" : "down";
  return { abs, pct: previous === 0 ? null : (abs / Math.abs(previous)) * 100, direction };
}
