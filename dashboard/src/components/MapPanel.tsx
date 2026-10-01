// US map for the selected range and metric, plus a sortable table of the same values (also a text alternative).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createColumnHelper, flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type SortingState } from "@tanstack/react-table";
import { api, type MapRow } from "@/lib/api";
import { fmt } from "@/lib/units";
import { selectedRange, useFilters } from "@/store/filters";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { UsMap } from "@/components/map/UsMap";
import { metricLabel, stateValue } from "@/components/map/types";

const column = createColumnHelper<MapRow & { value: number | null }>();

function StatesTable({ rows, valueLabel }: { rows: (MapRow & { value: number | null })[]; valueLabel: string }) {
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
    <Table>
      <caption className="sr-only">{valueLabel} by state</caption>
      <TableHeader>
        {table.getHeaderGroups().map((g) => (
          <TableRow key={g.id}>
            {g.headers.map((h) => (
              <TableHead key={h.id} aria-sort={h.column.getIsSorted() === "asc" ? "ascending" : h.column.getIsSorted() === "desc" ? "descending" : "none"}>
                <button type="button" className="font-medium" onClick={h.column.getToggleSortingHandler()}>
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: " ▲", desc: " ▼" }[h.column.getIsSorted() as string] ?? ""}
                </button>
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((r) => (
          <TableRow key={r.id}>
            {r.getVisibleCells().map((c) => <TableCell key={c.id}>{flexRender(c.column.columnDef.cell, c.getContext())}</TableCell>)}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function MapPanel() {
  const f = useFilters();
  const range = selectedRange(f);
  const map = useQuery({ queryKey: ["map", range], queryFn: () => api.map(range) });
  const locations = useQuery({ queryKey: ["locations"], queryFn: api.locations, staleTime: Infinity });
  const label = metricLabel(f.metric, f.unit);
  const rows = (map.data?.data ?? []).map((r) => ({ ...r, value: stateValue(r, f.metric, f.unit) }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>United States</CardTitle>
        <CardDescription>{label}, {range.from} – {range.to}. Click a state, then a city to select it.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {map.error ? (
          <Alert variant="destructive"><AlertTitle>Could not load the map</AlertTitle><AlertDescription>{map.error.message}</AlertDescription></Alert>
        ) : map.isPending || locations.isPending ? (
          <Skeleton className="h-80" />
        ) : (
          <>
            <UsMap states={map.data?.data ?? []} locations={locations.data?.data ?? []} metric={f.metric} unit={f.unit}
              selectedLocation={f.location} onSelectLocation={(location) => f.setFilters({ location, month: "" })} />
            <StatesTable rows={rows} valueLabel={label} />
          </>
        )}
      </CardContent>
    </Card>
  );
}
