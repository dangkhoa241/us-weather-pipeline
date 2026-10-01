// Date ranges for the filter bar. Days are YYYY-MM-DD (local calendar days of the selected city, as in the API).

const DAY_MS = 86_400_000;
export const ARCHIVE_LAG_DAYS = 5;   // observations lag ~5 days (Open-Meteo archive), like the API's default range

export const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** Last day with complete observations. */
export const latestDataDay = (now = Date.now()) => toDay(now - ARCHIVE_LAG_DAYS * DAY_MS);

export const PRESETS = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  "365d": "Last 12 months",
  ytd: "Year to date",
  custom: "Custom",
} as const;
export type Preset = keyof typeof PRESETS;

export function presetRange(preset: Exclude<Preset, "custom">, now = Date.now()) {
  const to = latestDataDay(now);
  if (preset === "ytd") return { from: `${to.slice(0, 4)}-01-01`, to };
  const days = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 }[preset];
  return { from: toDay(dayMs(to) - (days - 1) * DAY_MS), to };
}

export type Compare = "none" | "previous" | "last_year";

/** The comparison range, computed like the API does (previous period of equal length, or one year earlier). */
export function compareRange({ from, to }: { from: string; to: string }, compare: Exclude<Compare, "none">) {
  if (compare === "last_year") {
    const back = (day: string) => `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`.replace(/-02-29$/, "-02-28");
    return { from: back(from), to: back(to) };
  }
  const days = (dayMs(to) - dayMs(from)) / DAY_MS + 1;
  return { from: toDay(dayMs(from) - days * DAY_MS), to: toDay(dayMs(from) - DAY_MS) };
}
