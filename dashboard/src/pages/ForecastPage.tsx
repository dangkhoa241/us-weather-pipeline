// Forecast for one city (filled in by the forecast part).
import { FilterBar } from "@/components/FilterBar";

export function ForecastPage() {
  return <FilterBar fields={["city", "unit"]} />;
}
