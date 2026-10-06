// KPI cards for the selected location and range, with the change vs the comparison period and a sparkline.
import { useQuery } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { api, type StatsRow } from "@/lib/api";
import { compareRange } from "@/lib/dates";
import { computeKpis, delta, type Delta, type Kpis } from "@/lib/kpi";
import { deltaToUnit, fmt, toUnit } from "@/lib/units";
import { ALL_US, COMPARES, selectedRange, useFilters } from "@/store/filters";
import { useSubject } from "@/lib/subject";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Term } from "@/components/Term";
import { Sparkline } from "@/components/Sparkline";

function useKpiData() {
  const f = useFilters();
  const range = selectedRange(f);
  const compare = f.compare === "none" ? undefined : f.compare;
  const base = { locations: f.location, period: "day", ...range, compare };
  const temp = useQuery({ queryKey: ["stats", { ...base, metric: "temp_c" }], queryFn: () => api.stats({ ...base, metric: "temp_c" }) });
  const rain = useQuery({ queryKey: ["stats", { ...base, metric: "precip_mm" }], queryFn: () => api.stats({ ...base, metric: "precip_mm" }) });
  const location = f.location === ALL_US ? undefined : f.location;   // all US: accuracy over every city
  const acc = useQuery({ queryKey: ["accuracy", { location, ...range }], queryFn: () => api.accuracy({ location, ...range }) });
  const prevRange = compare ? compareRange(range, compare) : null;
  const prevAcc = useQuery({
    queryKey: ["accuracy", { location, ...prevRange }],
    queryFn: () => api.accuracy({ location, ...prevRange! }),
    enabled: prevRange != null,
  });
  return { f, temp, rain, acc, prevAcc, prevRange };
}

function DeltaLine({ d, unit, compareLabel }: { d: Delta | null; unit: string; compareLabel: string }) {
  if (!d) return <p className="text-xs text-muted-foreground">No comparison data</p>;
  const Icon = d.direction === "up" ? ArrowUpRight : d.direction === "down" ? ArrowDownRight : Minus;
  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground">
      <Icon className="size-3.5" aria-hidden />
      <span>{d.abs > 0 ? "+" : ""}{fmt(d.abs)}{unit}{d.pct != null ? ` (${d.abs > 0 ? "+" : ""}${fmt(d.pct, 0)}%)` : ""}</span>
      <span>vs {compareLabel.toLowerCase()}</span>
    </p>
  );
}

type CardSpec = { key: keyof Kpis; title: string; heading?: React.ReactNode; value: (k: Kpis) => number | null; unit: string;
  deltaOf: (cur: Kpis, prev: Kpis) => Delta | null; series?: (number | null)[]; digits?: number; color?: string };

export function KpiCards() {
  const { f, temp, rain, acc, prevAcc, prevRange } = useKpiData();
  const subjectOf = useSubject();
  const loading = temp.isPending || rain.isPending || acc.isPending;
  const error = temp.error ?? rain.error ?? acc.error;

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load the <Term k="KPI">KPIs</Term></AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }
  if (loading) {
    return <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-32" />)}</div>;
  }

  const tempRows = temp.data?.data ?? [];
  const subject = subjectOf(tempRows);
  const rainRows = rain.data?.data ?? [];
  if (!tempRows.length && !rainRows.length) {
    return <Alert><AlertTitle>No data for this range</AlertTitle><AlertDescription>Pick another date range or location.</AlertDescription></Alert>;
  }
  const cur = computeKpis(tempRows, rainRows, acc.data?.data ?? []);
  const prev = prevRange
    ? computeKpis(temp.data?.compare?.data ?? [], rain.data?.compare?.data ?? [], prevAcc.data?.data ?? [])
    : null;
  const deg = `°${f.unit}`;
  // Temperatures: absolute change only (a percentage of a temperature depends on the scale and means nothing).
  const t = (k: keyof Kpis) => (cur: Kpis, p: Kpis) => {
    const d = delta(cur[k], p[k]);
    return d && { ...d, abs: deltaToUnit(d.abs, f.unit) as number, pct: null };
  };
  const plain = (k: keyof Kpis) => (cur: Kpis, p: Kpis) => delta(cur[k], p[k]);
  const avgSeries = tempRows.map((r: StatsRow) => toUnit(r.avg, f.unit));
  const rainSeries = rainRows.map((r: StatsRow) => r.sum);

  const cards: CardSpec[] = [
    { key: "tempAvg", title: "Avg temperature", value: (k) => toUnit(k.tempAvg, f.unit), unit: deg, deltaOf: t("tempAvg"), series: avgSeries },
    { key: "tempMax", title: "Max temperature", value: (k) => toUnit(k.tempMax, f.unit), unit: deg, deltaOf: t("tempMax"),
      series: tempRows.map((r) => toUnit(r.max, f.unit)), color: "--c-hot" },
    { key: "tempMin", title: "Min temperature", value: (k) => toUnit(k.tempMin, f.unit), unit: deg, deltaOf: t("tempMin"),
      series: tempRows.map((r) => toUnit(r.min, f.unit)), color: "--c-cool" },
    { key: "rainTotal", title: "Total rain", value: (k) => k.rainTotal, unit: " mm", deltaOf: plain("rainTotal"), series: rainSeries, color: "--c-rain" },
    { key: "rainyDays", title: "Rainy days (≥ 1 mm)", heading: <>Rainy days (≥ 1 <Term k="mm" />)</>, value: (k) => k.rainyDays, unit: "", deltaOf: plain("rainyDays"), digits: 0 },
    { key: "forecastMae", title: "Forecast error (day 1)", heading: <>Forecast error (<Term k="Lead day">day 1</Term>)</>, value: (k) => deltaToUnit(k.forecastMae, f.unit), unit: deg,
      deltaOf: t("forecastMae") },
  ];

  return (
    <section aria-label="Key figures" className="flex flex-col gap-2">
    <p className="px-1 text-sm font-medium text-muted-foreground" data-kpi-subject>{subject}</p>
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {cards.map((c) => (
        <Card key={c.key} size="sm" className="gap-1">
          <CardHeader><CardTitle className="text-xs font-medium text-muted-foreground">{c.heading ?? c.title}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-1">
            <p className="text-2xl font-semibold tabular-nums">{fmt(c.value(cur), c.digits ?? 1)}{c.value(cur) == null ? "" : c.unit}</p>
            {prev && <DeltaLine d={c.deltaOf(cur, prev)} unit={c.unit} compareLabel={COMPARES[f.compare]} />}
            {c.series && <Sparkline values={c.series} color={c.color} label={`${c.title}, daily values`} />}
          </CardContent>
        </Card>
      ))}
    </div>
    </section>
  );
}
