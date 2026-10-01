// Overview: the original dashboard (KPIs, map + states table, city history, trend).
import { FilterBar } from "@/components/FilterBar";
import { KpiCards } from "@/components/KpiCards";
import { MapPanel } from "@/components/MapPanel";
import { DrillDownPanel } from "@/components/DrillDownPanel";
import { TrendPanel } from "@/components/TrendPanel";

export function OverviewPage() {
  return (
    <>
      <FilterBar />
      <KpiCards />
      <MapPanel />
      <DrillDownPanel />
      <TrendPanel />
    </>
  );
}
