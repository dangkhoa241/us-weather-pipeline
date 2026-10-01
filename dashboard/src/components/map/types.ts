// Contract for the US map. The three candidate implementations (feature/map-v1..v3) all implement UsMap with
// these props, so they get exactly the same data and can be swapped.
import type { LocationRow, MapRow } from "@/lib/api";
import type { TempUnit } from "@/lib/units";

export type MapMetric = "temp_c" | "precip_mm";

export type MapProps = {
  states: MapRow[];                  // per-state values from /api/v1/map for the selected range
  locations: LocationRow[];          // tracked cities (markers when a state is selected)
  metric: MapMetric;
  unit: TempUnit;
  selectedLocation: string;
  onSelectLocation: (id: string) => void;
};

/** The value a state is colored by, in display units. */
export function stateValue(row: MapRow | undefined, metric: MapMetric, unit: TempUnit): number | null {
  if (!row) return null;
  if (metric === "precip_mm") return row.precip_mm_per_city;
  return row.temp_avg_c == null ? null : unit === "F" ? (row.temp_avg_c * 9) / 5 + 32 : row.temp_avg_c;
}

export const metricLabel = (metric: MapMetric, unit: TempUnit) =>
  metric === "precip_mm" ? "Precipitation per city (mm)" : `Average temperature (°${unit})`;
