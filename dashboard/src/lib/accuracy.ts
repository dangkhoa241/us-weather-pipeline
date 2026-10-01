// Forecast accuracy helpers. Errors and biases are temperature DIFFERENCES: °C → °F multiplies by 1.8 only
// (no +32 offset, which applies to absolute temperatures).
import type { TempUnit } from "@/lib/units";
import { MODELS, MODEL_BY_ID } from "@/lib/models";

export const LEAD_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const MIN_SAMPLES = 100;   // fewer hourly pairs than this: not ranked (too noisy)

/** An error or bias in °C → display unit (×1.8 for °F, never +32). */
export const errorToUnit = (c: number | null | undefined, unit: TempUnit) => (c == null ? null : unit === "F" ? c * 1.8 : c);

type SummaryRow = { model: string; lead_days: number; n: number; mae_c: number | null; bias_c: number | null };

export type LeaderRow = {
  model: string;
  name: string;
  baseline: boolean;
  mae: (number | null)[];       // display unit, index 0 = lead day 1
  bias: number | null;          // display unit, at the selected lead day (+ = too warm)
  n: number;                    // samples at the selected lead day
  rank: number | null;          // by error at the selected lead day; null = not ranked (baseline or too few samples)
};

/** Leaderboard: one row per known model, ranked by average error at `lead` (lower is better). */
export function leaderboard(rows: SummaryRow[], lead: number, unit: TempUnit): LeaderRow[] {
  const out: LeaderRow[] = [];
  for (const m of MODELS) {
    const mine = rows.filter((r) => r.model === m.id);
    if (!mine.length) continue;
    const at = (d: number) => mine.find((r) => r.lead_days === d);
    out.push({
      model: m.id, name: m.name, baseline: Boolean(m.baseline),
      mae: LEAD_DAYS.map((d) => errorToUnit(at(d)?.mae_c, unit)),
      bias: errorToUnit(at(lead)?.bias_c, unit),
      n: at(lead)?.n ?? 0,
      rank: null,
    });
  }
  const rankable = out.filter((r) => !r.baseline && r.n >= MIN_SAMPLES && r.mae[lead - 1] != null)
    .sort((a, b) => (a.mae[lead - 1] as number) - (b.mae[lead - 1] as number));
  rankable.forEach((r, i) => { r.rank = i + 1; });
  return out.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.name.localeCompare(b.name));
}

/** "ECMWF is the most accurate model: 2.1°F average error 1 day ahead." (null when nothing is ranked) */
export function heroLine(board: LeaderRow[], lead: number, unit: TempUnit): string | null {
  const best = board.find((r) => r.rank === 1);
  if (!best) return null;
  const v = best.mae[lead - 1] as number;
  return `${best.name} is the most accurate model: ${v.toFixed(1)}°${unit} average error ${lead} day${lead === 1 ? "" : "s"} ahead.`;
}

export const biasWord = (bias: number | null) => (bias == null ? "" : Math.abs(bias) < 0.05 ? "no bias" : bias > 0 ? "too warm" : "too cold");

type StateRow = { state: string; model: string; n: number; mae_c: number | null };

/** Best (lowest error) known, non-baseline model per state, among models with enough samples. */
export function bestModelByState(rows: StateRow[], minSamples = MIN_SAMPLES): Map<string, { model: string; mae_c: number }> {
  const best = new Map<string, { model: string; mae_c: number }>();
  for (const r of rows) {
    const m = MODEL_BY_ID.get(r.model);
    if (!m || m.baseline || r.mae_c == null || r.n < minSamples) continue;
    const cur = best.get(r.state);
    if (!cur || r.mae_c < cur.mae_c) best.set(r.state, { model: r.model, mae_c: r.mae_c });
  }
  return best;
}

/** "2026-07-01" → "Jul 2026" */
export const monthLabel = (m: string) => new Date(`${m.slice(0, 7)}-15T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
