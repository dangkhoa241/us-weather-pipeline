import { Badge } from "@/components/ui/badge";
import { NavTabs } from "@/components/NavTabs";
import { ThemeToggle } from "@/components/ThemeToggle";
import { isSnapshot } from "@/lib/api";
import { dataSource, snapshotManifest } from "@/lib/snapshot";
import { useFilters } from "@/store/filters";
import { OverviewPage } from "@/pages/OverviewPage";
import { ForecastPage } from "@/pages/ForecastPage";
import { AccuracyPage } from "@/pages/AccuracyPage";

export default function App() {
  const snapshot = isSnapshot ? snapshotManifest() : null;
  const source = isSnapshot ? dataSource() : null;
  const page = useFilters((s) => s.page);
  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">US Weather Pipeline</h1>
          {snapshot && source?.kind === "live" && (
            <Badge variant="secondary" data-source="live" title={`Live data from AWS (CloudFront), published ${source.generated_at}`}>
              <span className="size-2 rounded-full bg-emerald-500" aria-hidden /> Live · data as of {source.data_as_of}
            </Badge>
          )}
          {snapshot && source?.kind !== "live" && (
            <Badge variant="secondary" data-source="snapshot" title={`Static snapshot ${snapshot.snapshot}, generated ${snapshot.generated_at}`}>
              Snapshot · data as of {snapshot.data_as_of}
            </Badge>
          )}
        </div>
        <NavTabs />
        <div className="flex items-center gap-3">
          {!isSnapshot && <a className="text-sm text-muted-foreground underline" href="/docs">API docs</a>}
          <ThemeToggle />
        </div>
      </header>
      <main className="flex flex-col gap-5" data-page={page}>
        {page === "forecast" ? <ForecastPage /> : page === "accuracy" ? <AccuracyPage /> : <OverviewPage />}
      </main>
    </div>
  );
}
