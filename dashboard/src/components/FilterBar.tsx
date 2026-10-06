// Global filters. Every control writes to the Zustand store, which keeps the URL in sync.
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PRESETS, type Preset } from "@/lib/dates";
import { ALL_US, COMPARES, METRICS, PERIODS, selectedRange, useFilters, type Metric, type Period } from "@/store/filters";
import type { Compare } from "@/lib/dates";
import { Term } from "@/components/Term";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

function useCities() {
  return useQuery({ queryKey: ["locations"], queryFn: api.locations, staleTime: Infinity }).data?.data ?? [];
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

export type FilterField = "location" | "period" | "range" | "metric" | "unit" | "compare" | "city" | "area" | "lead";
const ALL: FilterField[] = ["location", "period", "range", "metric", "unit", "compare"];

/** The global filters; each page shows the ones that make sense for it (`fields`). */
export function FilterBar({ fields = ALL }: { fields?: FilterField[] }) {
  const f = useFilters();
  const show = (k: FilterField) => fields.includes(k);
  const cities = useCities();
  const range = selectedRange(f);

  return (
    <section aria-label="Filters" className="flex flex-wrap items-end gap-3 rounded-xl bg-card p-4 shadow-sm shadow-black/5 ring-1 ring-foreground/10">
      {show("location") && <Field label="Location">
        <Select value={f.location} onValueChange={(location) => f.setFilters(location === ALL_US
          ? { location, city: "", year: "", month: "" }       // back to US-wide: the city history closes
          : { location, city: location, month: "" })}>
          <SelectTrigger className="w-48" aria-label="Location"><SelectValue placeholder="Location" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_US}>All US</SelectItem>
            {cities.map((l) => (
              <SelectItem key={l.id} value={l.id}>{l.name}, {l.state}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>}

      {show("period") && <Field label="Period">
        <ToggleGroup type="single" variant="outline" size="sm" value={f.period} aria-label="Period"
          onValueChange={(v) => v && f.setFilters({ period: v as Period })}>
          {Object.entries(PERIODS).map(([value, label]) => <ToggleGroupItem key={value} value={value}>{label}</ToggleGroupItem>)}
        </ToggleGroup>
      </Field>}

      {show("range") && <Field label="Date range">
        <div className="flex items-center gap-2">
          <Select value={f.preset} onValueChange={(v) => f.setFilters(v === "custom" ? { preset: "custom", ...range } : { preset: v as Preset })}>
            <SelectTrigger className="w-40" aria-label="Date range preset"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(PRESETS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
            </SelectContent>
          </Select>
          <input type="date" aria-label="From" className="h-8 rounded-md border px-2 text-sm text-foreground" value={range.from}
            max={range.to} onChange={(e) => e.target.value && f.setFilters({ preset: "custom", from: e.target.value, to: range.to })} />
          <input type="date" aria-label="To" className="h-8 rounded-md border px-2 text-sm text-foreground" value={range.to}
            min={range.from} onChange={(e) => e.target.value && f.setFilters({ preset: "custom", from: range.from, to: e.target.value })} />
        </div>
      </Field>}

      {show("metric") && <Field label="Metric">
        <Select value={f.metric} onValueChange={(v) => f.setFilters({ metric: v as Metric })}>
          <SelectTrigger className="w-36" aria-label="Metric"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(METRICS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>}

      {show("unit") && <Field label="Units">
        <ToggleGroup type="single" variant="outline" size="sm" value={f.unit} aria-label="Temperature unit"
          onValueChange={(v) => v && f.setFilters({ unit: v as "F" | "C" })}>
          <ToggleGroupItem value="F">°F</ToggleGroupItem>
          <ToggleGroupItem value="C">°C</ToggleGroupItem>
        </ToggleGroup>
      </Field>}

      {show("compare") && <Field label="Compare with">
        <Select value={f.compare} onValueChange={(v) => f.setFilters({ compare: v as Compare })}>
          <SelectTrigger className="w-48" aria-label="Compare with"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(COMPARES).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>}
      {show("city") && <Field label="City">
        <Select value={f.city || undefined} onValueChange={(city) => f.setFilters({ city, location: city })}>
          <SelectTrigger className="w-48" aria-label="City"><SelectValue placeholder="Pick a city" /></SelectTrigger>
          <SelectContent>{cities.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}, {l.state}</SelectItem>)}</SelectContent>
        </Select>
      </Field>}

      {show("area") && <Field label="Location">
        <Select value={f.area || "us"} onValueChange={(v) => f.setFilters({ area: v === "us" ? "" : v })}>
          <SelectTrigger className="w-52" aria-label="Area"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="us">All US</SelectItem>
            {[...new Set(cities.map((l) => l.state))].sort().map((st) => <SelectItem key={st} value={st}>State: {st}</SelectItem>)}
            {cities.map((l) => <SelectItem key={l.id} value={l.id}>{l.name}, {l.state}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>}

      {show("lead") && <Field label={<Term k="Lead day" />}>
        <ToggleGroup type="single" variant="outline" size="sm" value={f.lead} aria-label="Lead day"
          onValueChange={(v) => v && f.setFilters({ lead: v })}>
          {["1", "2", "3", "4", "5", "6", "7"].map((d) => <ToggleGroupItem key={d} value={d} aria-label={`${d} day${d === "1" ? "" : "s"} ahead`}>{d}</ToggleGroupItem>)}
        </ToggleGroup>
      </Field>}
    </section>
  );
}
