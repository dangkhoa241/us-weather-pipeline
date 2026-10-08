// Header badge wording per page, from the dates in the loaded data (never the clock):
// Overview "history through Oct 2", Forecast "forecast updated Oct 7, 12:50 PM", Accuracy "scored through Oct 2".
import type { Page } from "@/store/filters";

export type BadgeDates = { history: string | null; forecast: { issued: string; tz?: string } | null; scored: string | null };
export type BadgeParts = { label: string; date: string | null };

/** "2026-10-02" → "Oct 2". */
export const shortDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "2026-10-07 19:50:00" (UTC) → "Oct 7, 12:50 PM" in `tz` (the viewer's time zone when absent). */
export function shortTime(utc: string, tz?: string) {
  const d = new Date(`${utc.replace(" ", "T").replace(/Z?$/, "Z")}`);
  const opts = { timeZone: tz } as const;
  return `${d.toLocaleDateString("en-US", { ...opts, month: "short", day: "numeric" })}, ${d.toLocaleTimeString("en-US", { ...opts, hour: "numeric", minute: "2-digit" })}`;
}

/** The label after "Live · " / "Snapshot · " and its date (null while the page's data is loading). */
export function badgeParts(page: Page, dates: BadgeDates): BadgeParts {
  if (page === "forecast") return { label: "forecast updated", date: dates.forecast && shortTime(dates.forecast.issued, dates.forecast.tz) };
  if (page === "accuracy") return { label: "scored through", date: dates.scored && shortDay(dates.scored) };
  return { label: "history through", date: dates.history && shortDay(dates.history) };
}
