// One value per city for the map dots, from period=year stats rows over the selected range.
// Temperature: hour-weighted mean of the yearly means; precipitation: sum. A city without values is null (loading).
import type { StatsRow } from "@/lib/api";
import type { TempUnit } from "@/lib/units";

export function cityValues(rows: StatsRow[], metric: "temp_c" | "precip_mm", unit: TempUnit): Map<string, number | null> {
  const acc = new Map<string, { sum: number; weighted: number; n: number }>();
  for (const r of rows) {
    const a = acc.get(r.location_id) ?? { sum: 0, weighted: 0, n: 0 };
    if (metric === "precip_mm") {
      if (r.sum != null) { a.sum += r.sum; a.n += r.n_values; }
    } else if (r.avg != null) {
      a.weighted += r.avg * r.n_values; a.n += r.n_values;
    }
    acc.set(r.location_id, a);
  }
  const out = new Map<string, number | null>();
  for (const [id, a] of acc) {
    if (!a.n) { out.set(id, null); continue; }
    const v = metric === "precip_mm" ? a.sum : a.weighted / a.n;
    out.set(id, metric === "temp_c" && unit === "F" ? (v * 9) / 5 + 32 : v);
  }
  return out;
}
