import { FilterBar } from "@/components/FilterBar";
import { KpiCards } from "@/components/KpiCards";
import { MapPanel } from "@/components/MapPanel";
import { DrillDownPanel } from "@/components/DrillDownPanel";
import { TrendPanel } from "@/components/TrendPanel";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { isSnapshot } from "@/lib/api";
import { snapshotManifest } from "@/lib/snapshot";

export default function App() {
  const snapshot = isSnapshot ? snapshotManifest() : null;
  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">US Weather Pipeline</h1>
          {snapshot && (
            <Badge variant="secondary" title={`Static snapshot ${snapshot.snapshot}, generated ${snapshot.generated_at}`}>
              Demo data as of {snapshot.data_as_of}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          {!isSnapshot && <a className="text-sm text-muted-foreground underline" href="/docs">API docs</a>}
          <ThemeToggle />
        </div>
      </header>
      <FilterBar />
      <KpiCards />
      <MapPanel />
      <DrillDownPanel />
      <TrendPanel />
    </div>
  );
}
