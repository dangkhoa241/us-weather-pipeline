// Global filters (Zustand) kept in sync with the URL query string, so links are shareable and back/forward work.
// Only non-default values go into the URL; invalid values in a URL fall back to the defaults.
import { create } from "zustand";
import { locationId, isoDate } from "@shared/schemas.js";
import { PRESETS, presetRange, type Compare, type Preset } from "@/lib/dates";
import type { TempUnit } from "@/lib/units";

export const PERIODS = { week: "Week", month: "Month", quarter: "Quarter", half: "Half-Year", year: "Year" } as const;
export type Period = keyof typeof PERIODS;
export const METRICS = { temp_c: "Temperature", precip_mm: "Precipitation" } as const;
export type Metric = keyof typeof METRICS;
export const COMPARES: Record<Compare, string> = { none: "No comparison", previous: "Previous period", last_year: "Same period last year" };

export type Filters = {
  location: string;
  period: Period;
  preset: Preset;
  from: string;   // used when preset = "custom"
  to: string;
  metric: Metric;
  unit: TempUnit;
  compare: Compare;
  // City drill-down (DrillDownPanel): year "" = latest year with data (months), "YYYY" = that year's months,
  // "all" = one value per year; month "MM" = the days of that month (needs a year).
  year: string;
  month: string;
  // City whose history is open ("" = the drill-down section is closed). Separate from `location`, which feeds the KPIs.
  city: string;
};

export const DEFAULTS: Filters = {
  location: "stockton-ca", period: "week", preset: "90d", from: "", to: "",
  metric: "temp_c", unit: "F", compare: "previous", year: "", month: "", city: "",
};

const URL_KEYS: Record<keyof Filters, string> = {
  location: "loc", period: "period", preset: "range", from: "from", to: "to", metric: "metric", unit: "unit", compare: "compare",
  year: "year", month: "month", city: "city",
};

const oneOf = <T extends string>(value: string | null, allowed: Record<T, unknown>, fallback: T): T =>
  value != null && Object.hasOwn(allowed, value) ? (value as T) : fallback;

/** URL query string → filters (anything invalid falls back to the default). */
export function parseFilters(search: string): Filters {
  const q = new URLSearchParams(search);
  const get = (k: keyof Filters) => q.get(URL_KEYS[k]);
  const loc = get("location");
  let preset = oneOf<Preset>(get("preset"), PRESETS, DEFAULTS.preset);
  let from = get("from") ?? "";
  let to = get("to") ?? "";
  if (preset === "custom" && !(isoDate.safeParse(from).success && isoDate.safeParse(to).success && from <= to)) {
    preset = DEFAULTS.preset;
  }
  if (preset !== "custom") from = to = "";
  const cityParam = get("city");
  const yearParam = get("year") ?? "";
  const year = yearParam === "all" || (/^\d{4}$/.test(yearParam) && Number(yearParam) >= 1990 && Number(yearParam) <= 2100) ? yearParam : "";
  const monthParam = get("month") ?? "";
  const month = /^\d{4}$/.test(year) && /^(0[1-9]|1[0-2])$/.test(monthParam) ? monthParam : "";
  return {
    location: loc && locationId.safeParse(loc).success ? loc : DEFAULTS.location,
    period: oneOf<Period>(get("period"), PERIODS, DEFAULTS.period),
    preset,
    from,
    to,
    metric: oneOf<Metric>(get("metric"), METRICS, DEFAULTS.metric),
    unit: oneOf<TempUnit>(get("unit"), { F: 1, C: 1 }, DEFAULTS.unit),
    compare: oneOf<Compare>(get("compare"), COMPARES, DEFAULTS.compare),
    year,
    month,
    city: cityParam && locationId.safeParse(cityParam).success ? cityParam : "",
  };
}

/** Filters → URL query string ("" when everything is default). */
export function toSearch(f: Filters): string {
  const q = new URLSearchParams();
  for (const key of Object.keys(URL_KEYS) as (keyof Filters)[]) {
    if ((key === "from" || key === "to") && f.preset !== "custom") continue;
    if (f[key] !== DEFAULTS[key]) q.set(URL_KEYS[key], f[key]);
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** The date range the filters select. */
export const selectedRange = (f: Filters, now = Date.now()) =>
  f.preset === "custom" ? { from: f.from, to: f.to } : presetRange(f.preset, now);

type FilterStore = Filters & { setFilters: (patch: Partial<Filters>) => void };

export const createFilterStore = (initial: Filters) =>
  create<FilterStore>()((set) => ({ ...initial, setFilters: (patch) => set(patch) }));

export const useFilters = createFilterStore(typeof window === "undefined" ? DEFAULTS : parseFilters(window.location.search));

const pick = (s: FilterStore): Filters => ({
  location: s.location, period: s.period, preset: s.preset, from: s.from, to: s.to, metric: s.metric, unit: s.unit, compare: s.compare,
  year: s.year, month: s.month, city: s.city,
});

/**
 * Keep store and URL in sync: filter changes push a history entry; back/forward (popstate) restores the filters.
 * @returns a function that stops syncing
 */
export function startUrlSync(store = useFilters, win: Window = window) {
  let restoring = false;
  const url = (search: string) => `${win.location.pathname}${search}${win.location.hash}`;
  win.history.replaceState(null, "", url(toSearch(pick(store.getState()))));   // normalize the initial URL
  const unsubscribe = store.subscribe((state) => {
    if (restoring) return;
    const search = toSearch(pick(state));
    if (search !== win.location.search) win.history.pushState(null, "", url(search));
  });
  const onPopState = () => {
    restoring = true;
    store.setState(parseFilters(win.location.search));
    restoring = false;
  };
  win.addEventListener("popstate", onPopState);
  return () => {
    unsubscribe();
    win.removeEventListener("popstate", onPopState);
  };
}
