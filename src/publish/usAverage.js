// src/publish/usAverage.js
// "All US" rows (`locations=all` in the API, daily-all.json in the dashboard snapshot). Shared by the API and the
// dashboard publisher Lambda, so it lives outside src/api (whose service pulls in the cache and warehouse).

/** `locations=all`: every tracked city, averaged per period (see usAverage). */
export const ALL_LOCATIONS = "all";

/**
 * US-wide rows: per period, the mean of each value over the cities that have it (nulls ignored, never 0);
 * n_values / n_hours are summed and `cities` counts the cities with data in that period.
 */
export function usAverage(rows) {
  const groups = new Map();
  for (const r of rows) groups.set(r.period_start, [...(groups.get(r.period_start) ?? []), r]);
  const mean = (g, f) => {
    const v = g.map((r) => r[f]).filter((x) => x != null);
    return v.length ? Math.round((v.reduce((a, x) => a + x, 0) / v.length) * 1000) / 1000 : null;
  };
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([period_start, g]) => ({
    location_id: ALL_LOCATIONS, period_start,
    min: mean(g, "min"), max: mean(g, "max"), avg: mean(g, "avg"), sum: mean(g, "sum"),
    n_values: g.reduce((a, r) => a + r.n_values, 0), n_hours: g.reduce((a, r) => a + r.n_hours, 0),
    cities: g.filter((r) => r.n_values > 0).length,
  }));
}
