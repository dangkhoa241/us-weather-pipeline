import { FilterBar } from "@/components/FilterBar";
import { KpiCards } from "@/components/KpiCards";
import { MapPanel } from "@/components/MapPanel";

export default function App() {
  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-4 p-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">US Weather Pipeline</h1>
        <a className="text-sm text-muted-foreground underline" href="/docs">API docs</a>
      </header>
      <FilterBar />
      <KpiCards />
      <MapPanel />
    </div>
  );
}
