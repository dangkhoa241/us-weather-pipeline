// Forecast accuracy helpers. Errors and biases are temperature DIFFERENCES: °C → °F multiplies by 1.8 only
// (no +32 offset, which applies to absolute temperatures).
import type { TempUnit } from "@/lib/units";
import { MODELS, MODEL_BY_ID } from "@/lib/models";

export const LEAD_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const MIN_SAMPLES = 100;   // fewer hourly pairs than this: not ranked (too noisy)
// Fewer scored days than this at the selected lead day: shown as "not enough data yet", not ranked. A model with a
// short history (e.g. NWS, scored only since collection started) is compared over different weather than the others.
export const MIN_DAYS = 30;

/** An error or bias in °C → display unit (×1.8 for °F, never +32). */
export const errorToUnit = (c: number | null | undefined, unit: TempUnit) => (c == null ? null : unit === "F" ? c * 1.8 : c);

type SummaryRow = { model: string; lead_days: number; n: number; days: number; mae_c: number | null; bias_c: number | null };

export type LeaderRow = {
  model: string;
  name: string;
  baseline: boolean;
  mae: (number | null)[];       // display unit, index 0 = lead day 1
  bias: number | null;          // display unit, at the selected lead day (+ = too warm)
  n: number;                    // samples at the selected lead day
  days: number;                 // days with scores at the selected lead day
  shortHistory: boolean;        // not a baseline, but fewer than MIN_DAYS days: "not enough data yet"
  rank: number | null;          // by error at the selected lead day; null = not ranked (baseline, short history, few samples)
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
      days: at(lead)?.days ?? 0,
      shortHistory: !m.baseline && (at(lead)?.days ?? 0) < MIN_DAYS,
      rank: null,
    });
  }
  const rankable = out.filter((r) => !r.baseline && !r.shortHistory && r.n >= MIN_SAMPLES && r.mae[lead - 1] != null)
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

/**
 * "Small sample: NWS has 3 days of scores so far. On the 1,234 city-hours both were scored on, ECMWF missed by 1.54°F
 * on average and NWS by 1.98°F." Head-to-head rows come from /accuracy/matched; null when there is nothing to say.
 */
export function headToHeadNote(target: LeaderRow, leader: LeaderRow | undefined,
  rows: { model: string; n: number; mae_c: number | null; target_mae_c: number | null }[], unit: TempUnit): string | null {
  if (!leader) return null;
  const r = rows.find((x) => x.model === leader.model);
  if (!r || !r.n || r.mae_c == null || r.target_mae_c == null) return null;
  const v = (c: number) => `${(errorToUnit(c, unit) as number).toFixed(2)}°${unit}`;
  return `Small sample: ${target.name} has ${target.days} day${target.days === 1 ? "" : "s"} of scores so far. On the ${r.n.toLocaleString("en-US")} ` +
    `city-hours both were scored on, ${leader.name} missed by ${v(r.mae_c)} on average and ${target.name} by ${v(r.target_mae_c)}.`;
}

type StateRow = { state: string; model: string; n: number; days: number; mae_c: number | null };

/** Best (lowest error) known, non-baseline model per state, among models with enough samples and days. */
export function bestModelByState(rows: StateRow[], minSamples = MIN_SAMPLES): Map<string, { model: string; mae_c: number }> {
  const best = new Map<string, { model: string; mae_c: number }>();
  for (const r of rows) {
    const m = MODEL_BY_ID.get(r.model);
    if (!m || m.baseline || r.mae_c == null || r.n < minSamples || r.days < MIN_DAYS) continue;
    const cur = best.get(r.state);
    if (!cur || r.mae_c < cur.mae_c) best.set(r.state, { model: r.model, mae_c: r.mae_c });
  }
  return best;
}

/** "2026-07-01" → "Jul 2026" */
export const monthLabel = (m: string) => new Date(`${m.slice(0, 7)}-15T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
