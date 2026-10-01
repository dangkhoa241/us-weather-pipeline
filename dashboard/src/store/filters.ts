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

// Pages have real paths (/forecast, /accuracy); the filters stay in the query string on every page.
export const PAGES = { overview: "Overview", forecast: "Forecast", accuracy: "Accuracy" } as const;
export type Page = keyof typeof PAGES;
export const PAGE_PATH: Record<Page, string> = { overview: "/", forecast: "/forecast", accuracy: "/accuracy" };
export const pageFromPath = (pathname: string): Page =>
  (Object.keys(PAGE_PATH) as Page[]).find((p) => p !== "overview" && pathname.replace(/\/+$/, "") === PAGE_PATH[p]) ?? "overview";

/** Location value for the US-wide view (average across all cities with data); the default. */
export const ALL_US = "all";

export type Filters = {
  page: Page;
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
  // Accuracy page: area "" = all US, "CA" = a state, "stockton-ca" = a city; lead = forecast lead day "1".."7".
  area: string;
  lead: string;
};

export const DEFAULTS: Filters = {
  page: "overview", area: "", lead: "1", location: ALL_US, period: "week", preset: "90d", from: "", to: "",
  metric: "temp_c", unit: "F", compare: "previous", year: "", month: "", city: "",
};

const URL_KEYS: Record<Exclude<keyof Filters, "page">, string> = {
  area: "area", lead: "lead",
  location: "loc", period: "period", preset: "range", from: "from", to: "to", metric: "metric", unit: "unit", compare: "compare",
  year: "year", month: "month", city: "city",
};

const oneOf = <T extends string>(value: string | null, allowed: Record<T, unknown>, fallback: T): T =>
  value != null && Object.hasOwn(allowed, value) ? (value as T) : fallback;

/** URL query string → filters (anything invalid falls back to the default). */
export function parseFilters(search: string, pathname = "/"): Filters {
  const q = new URLSearchParams(search);
  const get = (k: keyof typeof URL_KEYS) => q.get(URL_KEYS[k]);
  const loc = get("location");
  let preset = oneOf<Preset>(get("preset"), PRESETS, DEFAULTS.preset);
  let from = get("from") ?? "";
  let to = get("to") ?? "";
  if (preset === "custom" && !(isoDate.safeParse(from).success && isoDate.safeParse(to).success && from <= to)) {
    preset = DEFAULTS.preset;
  }
  if (preset !== "custom") from = to = "";
  const cityParam = get("city");
  const areaParam = get("area") ?? "";
  const leadParam = get("lead") ?? "";
  const yearParam = get("year") ?? "";
  const year = yearParam === "all" || (/^\d{4}$/.test(yearParam) && Number(yearParam) >= 1990 && Number(yearParam) <= 2100) ? yearParam : "";
  const monthParam = get("month") ?? "";
  const month = /^\d{4}$/.test(year) && /^(0[1-9]|1[0-2])$/.test(monthParam) ? monthParam : "";
  return {
    page: pageFromPath(pathname),
    area: /^[A-Z]{2}$/.test(areaParam) || (areaParam && locationId.safeParse(areaParam).success) ? areaParam : "",
    lead: /^[1-7]$/.test(leadParam) ? leadParam : DEFAULTS.lead,
    // Old links (?city=… without loc) open that city for the KPIs too.
    location: loc && locationId.safeParse(loc).success ? loc
      : !loc && cityParam && locationId.safeParse(cityParam).success ? cityParam : DEFAULTS.location,
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

/** Link to a page with the current filters (for nav tabs: real URLs that also open in a new tab). */
export const pageHref = (f: Filters, page: Page) => `${PAGE_PATH[page]}${toSearch({ ...f, page })}`;

/** Filters → URL query string ("" when everything is default). */
export function toSearch(f: Filters): string {
  const q = new URLSearchParams();
  for (const key of Object.keys(URL_KEYS) as (keyof typeof URL_KEYS)[]) {
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

export const useFilters = createFilterStore(typeof window === "undefined" ? DEFAULTS : parseFilters(window.location.search, window.location.pathname));

const pick = (s: FilterStore): Filters => ({
  page: s.page, area: s.area, lead: s.lead,
  location: s.location, period: s.period, preset: s.preset, from: s.from, to: s.to, metric: s.metric, unit: s.unit, compare: s.compare,
  year: s.year, month: s.month, city: s.city,
});

/**
 * Keep store and URL in sync: filter changes push a history entry; back/forward (popstate) restores the filters.
 * @returns a function that stops syncing
 */
export function startUrlSync(store = useFilters, win: Window = window) {
  let restoring = false;
  const target = (f: Filters) => `${PAGE_PATH[f.page]}${toSearch(f)}`;
  win.history.replaceState(null, "", `${target(pick(store.getState()))}${win.location.hash}`);   // normalize the initial URL
  const unsubscribe = store.subscribe((state) => {
    if (restoring) return;
    const next = target(pick(state));
    if (next !== `${win.location.pathname}${win.location.search}`) win.history.pushState(null, "", next);
  });
  const onPopState = () => {
    restoring = true;
    store.setState(parseFilters(win.location.search, win.location.pathname));
    restoring = false;
  };
  win.addEventListener("popstate", onPopState);
  return () => {
    unsubscribe();
    win.removeEventListener("popstate", onPopState);
  };
}
