// Fake Open-Meteo answers for the forecast replay tests (no network). Shapes copied from real responses
// (timezone=GMT, 3 UTC days = 72 hours). Stockton is UTC−7 in September, so its local day D is UTC hours
// D 07:00 … D+1 06:00 = indexes 31…54.
import { vi } from "vitest";

export const NOW = Date.parse("2026-10-05T12:00:00Z");   // fixed clock: replayable days end 2026-09-28
export const LOCAL = { first: 31, last: 54 };

const hours = (day: string) =>
  Array.from({ length: 72 }, (_, i) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000 + i * 3_600_000).toISOString().slice(0, 16));

/** 72 values: 15 °C everywhere, `high` at one hour inside the local day, and a decoy 40 °C outside it. */
export function series(high: number | null): (number | null)[] {
  const v: (number | null)[] = Array.from({ length: 72 }, () => (high == null ? null : 15));
  if (high != null) { v[40] = high; v[10] = 40; v[60] = 40; }
  return v;
}

/** Forecast highs (°C) per model and lead day. ICON has no lead 7, HRRR only lead 1, best match has a gap at lead 3. */
export const HIGHS: Record<string, Record<number, number>> = {
  ecmwf_ifs025: { 7: 31.5, 6: 31, 5: 30.5, 4: 30, 3: 29.5, 2: 29, 1: 28.5 },
  gfs_global: { 7: 36, 6: 35, 5: 34, 4: 33, 3: 32, 2: 31, 1: 30 },
  icon_global: { 6: 28.8, 5: 28.5, 4: 28.2, 3: 27.9, 2: 27.6, 1: 27.3 },
  gfs_hrrr: { 1: 28.2 },
  best_match: { 7: 36, 6: 35, 5: 34, 4: 33, 3: 32, 2: 31, 1: 28.6 },
};
export const OBSERVED = 28.1;

export function previousRunsBody(day: string) {
  const hourly: Record<string, unknown> = { time: hours(day) };
  for (const [model, byLead] of Object.entries(HIGHS)) {
    for (let lead = 1; lead <= 7; lead++) {
      const s = series(byLead[lead] ?? null);
      if (model === "best_match" && lead === 3) s[45] = null;   // one missing hour → that lead is left out
      hourly[`temperature_2m_previous_day${lead}_${model}`] = s;
    }
  }
  return { latitude: 38, longitude: -121.25, timezone: "GMT", utc_offset_seconds: 0, hourly };
}

export const archiveBody = (day: string) => ({ latitude: 37.93, longitude: -121.29, timezone: "GMT", hourly: { time: hours(day), temperature_2m: series(OBSERVED) } });

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fetch mock answering Open-Meteo by host, plus optional extra routes (e.g. the bundled sample). */
export function openMeteoFetch(extra: Record<string, () => Response | Promise<Response>> = {}) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const day = url.searchParams.get("start_date");
    const center = day ? new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : "";
    if (url.host === "previous-runs-api.open-meteo.com") return json(previousRunsBody(center));
    if (url.host === "archive-api.open-meteo.com") return json(archiveBody(center));
    const route = extra[url.pathname];
    if (route) return route();
    return new Response("not found", { status: 404 });
  });
}
