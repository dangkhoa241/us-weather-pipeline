// Header badge: where the data comes from (Live = CloudFront, Snapshot = bundled files) and how recent the page's data
// is: history on Overview, the NWS issue time on Forecast (the selected city's, in its time zone, as the page shows it;
// without a city the latest across all cities, in the viewer's time zone), the last scored day on Accuracy.
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Term } from "@/components/Term";
import { api } from "@/lib/api";
import { badgeParts, type BadgeDates } from "@/lib/badge";
import { accuracyAsOf, dataSource, latestNwsIssued, snapshotManifest } from "@/lib/snapshot";
import { useFilters } from "@/store/filters";

function useForecastIssued(enabled: boolean): BadgeDates["forecast"] {
  const city = useFilters((s) => s.city);
  const withCity = enabled && !!city;
  const locations = useQuery({ queryKey: ["locations"], queryFn: api.locations, staleTime: Infinity, enabled: withCity });
  const hourly = useQuery({ queryKey: ["forecast", city], queryFn: () => api.forecast(city), enabled: withCity });
  const periods = useQuery({ queryKey: ["periods", city], queryFn: () => api.forecastPeriods(city), enabled: withCity });
  const latest = useQuery({ queryKey: ["nws-latest"], queryFn: latestNwsIssued, staleTime: Infinity, enabled: enabled && !city });
  if (!withCity) return latest.data ? { issued: latest.data } : null;
  const tz = locations.data?.data.find((l) => l.id === city)?.timezone;
  const issued = hourly.data?.data.find((r) => r.model === "nws")?.issued_at ?? periods.data?.data[0]?.issued_at;
  return issued && tz ? { issued, tz } : null;
}

export function DataBadge() {
  const page = useFilters((s) => s.page);
  const snapshot = snapshotManifest();
  const source = dataSource();
  const forecast = useForecastIssued(!!snapshot && page === "forecast");
  if (!snapshot || !source) return null;
  const live = source.kind === "live";
  const { label, date } = badgeParts(page, { history: source.data_as_of, forecast, scored: accuracyAsOf() });
  return (
    <Badge variant="secondary" data-source={source.kind}
      title={live ? `Live data from AWS (CloudFront), published ${source.generated_at}` : `Static snapshot ${snapshot.snapshot}, generated ${snapshot.generated_at}`}>
      {live && <span className="size-2 rounded-full bg-emerald-500" aria-hidden />}
      {live ? "Live" : "Snapshot"} · {label} {date == null ? "…" : page === "overview" ? <Term k="History">{date}</Term> : date}
    </Badge>
  );
}
