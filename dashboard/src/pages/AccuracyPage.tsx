// Forecast accuracy (filled in by the accuracy part).
import { FilterBar } from "@/components/FilterBar";

export function AccuracyPage() {
  return <FilterBar fields={["area", "range", "lead", "unit"]} />;
}
