// Global filters. Every control writes to the Zustand store, which keeps the URL in sync.
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PRESETS, type Preset } from "@/lib/dates";
import { COMPARES, METRICS, PERIODS, selectedRange, useFilters, type Metric, type Period } from "@/store/filters";
import type { Compare } from "@/lib/dates";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      {children}
    </label>
  );
}

export function FilterBar() {
  const f = useFilters();
  const locations = useQuery({ queryKey: ["locations"], queryFn: api.locations, staleTime: Infinity });
  const range = selectedRange(f);

  return (
    <section aria-label="Filters" className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-3">
      <Field label="Location">
        <Select value={f.location} onValueChange={(location) => f.setFilters({ location })}>
          <SelectTrigger className="w-48" aria-label="Location"><SelectValue placeholder="Location" /></SelectTrigger>
          <SelectContent>
            {(locations.data?.data ?? []).map((l) => (
              <SelectItem key={l.id} value={l.id}>{l.name}, {l.state}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Period">
        <ToggleGroup type="single" variant="outline" size="sm" value={f.period} aria-label="Period"
          onValueChange={(v) => v && f.setFilters({ period: v as Period })}>
          {Object.entries(PERIODS).map(([value, label]) => <ToggleGroupItem key={value} value={value}>{label}</ToggleGroupItem>)}
        </ToggleGroup>
      </Field>

      <Field label="Date range">
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
      </Field>

      <Field label="Metric">
        <Select value={f.metric} onValueChange={(v) => f.setFilters({ metric: v as Metric })}>
          <SelectTrigger className="w-36" aria-label="Metric"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(METRICS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Units">
        <ToggleGroup type="single" variant="outline" size="sm" value={f.unit} aria-label="Temperature unit"
          onValueChange={(v) => v && f.setFilters({ unit: v as "F" | "C" })}>
          <ToggleGroupItem value="F">°F</ToggleGroupItem>
          <ToggleGroupItem value="C">°C</ToggleGroupItem>
        </ToggleGroup>
      </Field>

      <Field label="Compare with">
        <Select value={f.compare} onValueChange={(v) => f.setFilters({ compare: v as Compare })}>
          <SelectTrigger className="w-48" aria-label="Compare with"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(COMPARES).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
    </section>
  );
}
