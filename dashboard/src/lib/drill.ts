// City drill-down (years → months of a year → days of a month) and period labels for the trend chart.
// Slots without data stay null (never 0), so future months and gaps render as empty.
import type { StatsRow } from "@/lib/api";
import { dayMs, latestDataDay, toDay } from "@/lib/dates";
import type { ChartPoint } from "@/components/chart/types";

export type DrillLevel = "years" | "months" | "days";
export const MAX_RANGE_DAYS = 4000;   // the API's longest allowed range

export function drillLevel(year: string, month: string): DrillLevel {
  if (month) return "days";
  return year === "all" ? "years" : "months";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthName = (mm: string) => MONTHS[Number(mm) - 1];
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (n: number) => String(n).padStart(2, "0");

const toPoint = (key: string, label: string, row: StatsRow | undefined): ChartPoint =>
  ({ key, label, min: row?.min ?? null, max: row?.max ?? null, avg: row?.avg ?? null, sum: row?.sum ?? null });

/** The widest range the API allows, ending at the latest data day: used to find the years with data. */
export function allYearsRange(now = Date.now()) {
  const to = latestDataDay(now);
  return { from: toDay(dayMs(to) - (MAX_RANGE_DAYS - 1) * 86_400_000), to };
}

/** Years that have at least one value, newest first (period=year rows). */
export const yearsWithData = (yearRows: StatsRow[]) =>
  yearRows.filter((r) => r.n_values > 0).map((r) => r.period_start.slice(0, 4)).sort().reverse();

/** Range of a year or a month, cut at the latest data day (later days don't exist yet). */
export function rangeFor(year: string, month = "", now = Date.now()) {
  const last = latestDataDay(now);
  const from = month ? `${year}-${month}-01` : `${year}-01-01`;
  const end = month ? `${year}-${month}-${pad(daysIn(Number(year), Number(month)))}` : `${year}-12-31`;
  return { from, to: end < last ? end : last };
}

/** One point per year with data (period=year rows). */
export const yearPoints = (yearRows: StatsRow[]): ChartPoint[] =>
  [...yearRows].sort((a, b) => a.period_start.localeCompare(b.period_start))
    .map((r) => toPoint(r.period_start.slice(0, 4), r.period_start.slice(0, 4), r));

/** Always 12 points (Jan..Dec); months without rows (future, or no data) are null. */
export function monthPoints(monthRows: StatsRow[]): ChartPoint[] {
  const byMonth = new Map(monthRows.map((r) => [r.period_start.slice(5, 7), r]));
  return MONTHS.map((name, i) => toPoint(pad(i + 1), name, byMonth.get(pad(i + 1))));
}

/** One point per calendar day of the month; days without rows are null. */
export function dayPoints(year: string, month: string, dayRows: StatsRow[]): ChartPoint[] {
  const byDay = new Map(dayRows.map((r) => [r.period_start.slice(8, 10), r]));
  return Array.from({ length: daysIn(Number(year), Number(month)) }, (_, i) => toPoint(pad(i + 1), String(i + 1), byDay.get(pad(i + 1))));
}

/** Label for a period start date (trend chart). */
export function periodLabel(start: string, period: string): string {
  const [y, m] = [start.slice(0, 4), Number(start.slice(5, 7))];
  switch (period) {
    case "week": return `${monthName(pad(m))} ${Number(start.slice(8, 10))}`;
    case "month": return `${monthName(pad(m))} ${y}`;
    case "quarter": return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
    case "half": return `H${m <= 6 ? 1 : 2} ${y}`;
    case "year": return y;
    default: return start;
  }
}
