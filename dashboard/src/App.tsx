import { DataBadge } from "@/components/DataBadge";
import { NavTabs } from "@/components/NavTabs";
import { ThemeToggle } from "@/components/ThemeToggle";
import { isSnapshot } from "@/lib/api";
import { useFilters } from "@/store/filters";
import { OverviewPage } from "@/pages/OverviewPage";
import { ForecastPage } from "@/pages/ForecastPage";
import { AccuracyPage } from "@/pages/AccuracyPage";

export default function App() {
  const page = useFilters((s) => s.page);
  return (
    <div className="mx-auto flex min-h-screen max-w-7xl flex-col gap-5 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">US Weather Pipeline</h1>
          <DataBadge />
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
