// What the KPIs and the trend describe: "All US · 53 cities" (US-wide average) or "Stockton, CA".
import { useQuery } from "@tanstack/react-query";
import { api, type StatsRow } from "@/lib/api";
import { ALL_US, useFilters } from "@/store/filters";

/** "All US · N cities" from US-wide rows (N = the most cities with data in any period of the range). */
export function allUsLabel(rows: StatsRow[]): string {
  const n = rows.reduce((a, r) => Math.max(a, r.cities ?? 0), 0);
  return n ? `All US · ${n} ${n === 1 ? "city" : "cities"}` : "All US";
}

/** Returns a function: stats rows of the current Location → its label. */
export function useSubject() {
  const location = useFilters((s) => s.location);
  const locations = useQuery({ queryKey: ["locations"], queryFn: api.locations, staleTime: Infinity });
  return (rows: StatsRow[]) => {
    if (location === ALL_US) return allUsLabel(rows);
    const c = locations.data?.data.find((l) => l.id === location);
    return c ? `${c.name}, ${c.state}` : location;
  };
}
