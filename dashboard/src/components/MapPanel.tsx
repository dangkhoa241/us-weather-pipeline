// US map for the selected range and metric, next to a sortable table of the same values (also a text alternative).
// Desktop: map ~60% / table ~40% at the same height. Hovering a table row highlights the state; clicking it zooms.
import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from "@tanstack/react-table";
import { api, type MapRow } from "@/lib/api";
import { cityValues } from "@/lib/cityValues";
import { fmt } from "@/lib/units";
import { selectedRange, useFilters } from "@/store/filters";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { UsMap } from "@/components/map/UsMap";
import { metricLabel, stateValue } from "@/components/map/types";

type Row = MapRow & { value: number | null };
const column = createColumnHelper<Row>();
const RIGHT = new Set(["cities", "value"]);

function StatesTable({ rows, valueLabel, hovered, zoomed, onHover, onZoom }: {
  rows: Row[]; valueLabel: string; hovered: string | null; zoomed: string | null;
  onHover: (code: string | null) => void; onZoom: (code: string) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "value", desc: true }]);
  const columns = useMemo(() => [
    column.accessor("state", { header: "State" }),
    column.accessor("region", { header: "Region" }),
    column.accessor("cities", { header: "Cities" }),
    column.accessor("value", { header: valueLabel, cell: (c) => fmt(c.getValue()), sortUndefined: "last" }),
  ], [valueLabel]);
  const table = useReactTable({
    data: rows, columns, state: { sorting }, onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
  });
  return (
    <table className="w-full caption-bottom text-sm" data-states-table>
      <caption className="sr-only">{valueLabel} by state</caption>
      <thead>
        {table.getHeaderGroups().map((g) => (
          <tr key={g.id}>
            {g.headers.map((h) => (
              <th key={h.id} scope="col" aria-sort={h.column.getIsSorted() === "asc" ? "ascending" : h.column.getIsSorted() === "desc" ? "descending" : "none"}
                className={`sticky top-0 z-10 border-b bg-card px-2 py-2 font-medium ${RIGHT.has(h.column.id) ? "text-right" : "text-left"}`}>
                <button type="button" className="font-medium" onClick={h.column.getToggleSortingHandler()}>
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: " ▲", desc: " ▼" }[h.column.getIsSorted() as string] ?? ""}
                </button>
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((r) => {
          const code = r.original.state;
          return (
            <tr key={r.id} data-row-state={code} aria-selected={zoomed === code} onMouseEnter={() => onHover(code)} onMouseLeave={() => onHover(null)}
              onClick={() => onZoom(code)}
              className={`cursor-pointer border-b transition-colors last:border-0 hover:bg-muted ${hovered === code ? "bg-muted" : ""} ${zoomed === code ? "font-medium" : ""}`}>
              {r.getVisibleCells().map((c) => (
                <td key={c.id} className={`px-2 py-1.5 ${RIGHT.has(c.column.id) ? "text-right tabular-nums" : ""}`}>
                  {c.column.id === "state"
                    ? <button type="button" className="underline-offset-2 hover:underline focus-visible:underline" onFocus={() => onHover(code)} onBlur={() => onHover(null)}>{code}</button>
                    : flexRender(c.column.columnDef.cell, c.getContext())}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const chunk = <T,>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

export function MapPanel() {
  const f = useFilters();
  const range = selectedRange(f);
  const map = useQuery({ queryKey: ["map", range], queryFn: () => api.map(range) });
  const locations = useQuery({ queryKey: ["locations"], queryFn: api.locations, staleTime: Infinity });
  const [zoom, setZoom] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const label = metricLabel(f.metric, f.unit);
  const rows = (map.data?.data ?? []).map((r) => ({ ...r, value: stateValue(r, f.metric, f.unit) }));

  // One value per city for the dots: yearly stats rows over the range, in groups of 25 (the API's limit per request).
  const ids = (locations.data?.data ?? []).map((l) => l.id);
  const cityQueries = useQueries({
    queries: chunk(ids, 25).map((group) => {
      const p = { locations: group.join(","), metric: f.metric, period: "year", ...range };
      return { queryKey: ["stats", "cities", p], queryFn: () => api.stats(p) };
    }),
  });
  const cityRows = cityQueries.flatMap((q) => q.data?.data ?? []);
  const dotValues = cityValues(cityRows, f.metric, f.unit);

  return (
    <Card>
      <CardHeader>
        <CardTitle>United States</CardTitle>
        <CardDescription>{label}, {range.from} – {range.to}. Click a state to zoom in, a city dot to open its history.</CardDescription>
      </CardHeader>
      <CardContent>
        {map.error ? (
          <Alert variant="destructive"><AlertTitle>Could not load the map</AlertTitle><AlertDescription>{map.error.message}</AlertDescription></Alert>
        ) : map.isPending || locations.isPending ? (
          <Skeleton className="h-80" />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
            <UsMap states={map.data?.data ?? []} locations={locations.data?.data ?? []} metric={f.metric} unit={f.unit}
              selectedLocation={f.location} onSelectLocation={(location) => f.setFilters({ location, city: location, month: "" })}
              cityValues={dotValues} zoomState={zoom} onZoomState={setZoom} hoveredState={hover} onHoverState={setHover} />
            <div className="relative max-h-96 min-h-64 overflow-auto rounded-lg border lg:max-h-none">
              <div className="lg:absolute lg:inset-0 lg:overflow-auto">
                <StatesTable rows={rows} valueLabel={label} hovered={hover} zoomed={zoom} onHover={setHover} onZoom={setZoom} />
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
