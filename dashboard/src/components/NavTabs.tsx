// Page tabs. Real links (open in a new tab, copy link), handled in-app: the store changes the page and the URL sync
// pushes /forecast?… so Back/Forward work. The filters in the query string are kept across pages.
import { PAGES, pageHref, useFilters, type Page } from "@/store/filters";

export function NavTabs() {
  const f = useFilters();
  return (
    <nav aria-label="Pages" className="flex gap-1 rounded-full bg-muted p-1">
      {(Object.keys(PAGES) as Page[]).map((p) => (
        <a key={p} href={pageHref(f, p)} aria-current={f.page === p ? "page" : undefined}
          className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${f.page === p ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;   // let the browser open new tabs
            e.preventDefault();
            f.setFilters({ page: p });
            window.scrollTo({ top: 0 });
          }}>
          {PAGES[p]}
        </a>
      ))}
    </nav>
  );
}
