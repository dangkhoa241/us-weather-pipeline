// Typed API client. Types and response validation come from the backend's own schemas (src/api/schemas.js),
// so the dashboard and the API share one definition instead of copies.
import type { z } from "zod";
import { RESPONSE, ROW, errorResponse } from "@shared/schemas.js";
import { snapshotApi } from "@/lib/snapshot";

export type LocationRow = z.infer<typeof ROW.location>;
export type StatsRow = z.infer<typeof ROW.stats>;
export type MapRow = z.infer<typeof ROW.map>;
export type AccuracyRow = z.infer<typeof ROW.accuracy>;
export type StatsResponse = z.infer<typeof RESPONSE.stats>;
export type ForecastRow = z.infer<typeof ROW.forecast>;
export type PeriodRow = z.infer<typeof ROW.period>;
export type AlertRow = z.infer<typeof ROW.alert>;
export type AccuracyStateRow = z.infer<typeof ROW.accuracyState>;
export type AccuracyMonthRow = z.infer<typeof ROW.accuracyMonth>;
export type MissRow = z.infer<typeof ROW.miss>;
export type MatchedRow = z.infer<typeof ROW.accuracyMatched>;
/** Accuracy area: all US (both empty), one state or one city. */
export type AreaParams = { from: string; to: string; location?: string; state?: string };

export class ApiRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Params = Record<string, string | number | undefined>;

async function get<S extends z.ZodType>(path: string, params: Params, schema: S): Promise<z.infer<S>> {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") query.set(k, String(v));
  const qs = query.toString();
  const res = await fetch(`/api/v1${path}${qs ? `?${qs}` : ""}`, { headers: { Accept: "application/json" } });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = errorResponse.safeParse(body);
    throw new ApiRequestError(res.status, parsed.success ? parsed.data.error.message : `Request failed (${res.status})`);
  }
  const parsed = schema.safeParse(body);   // catches API/dashboard contract drift early
  if (!parsed.success) throw new ApiRequestError(500, "Unexpected response from the API");
  return parsed.data;
}

/** Live API (local dev and any deployment with a backend). */
export const liveApi = {
  locations: () => get("/locations", {}, RESPONSE.locations),
  stats: (p: { locations: string; metric: string; period: string; from: string; to: string; compare?: string }) =>
    get("/stats", p, RESPONSE.stats),
  map: (p: { from: string; to: string }) => get("/map", p, RESPONSE.map),
  accuracy: (p: AreaParams) => get("/accuracy", p, RESPONSE.accuracy),
  accuracyStates: (p: { from: string; to: string; lead: number }) => get("/accuracy/states", p, RESPONSE.accuracyStates),
  accuracyMatched: (p: { from: string; to: string; lead: number; model: string }) => get("/accuracy/matched", p, RESPONSE.accuracyMatched),
  accuracyMonths: (p: AreaParams & { lead: number }) => get("/accuracy/months", p, RESPONSE.accuracyMonths),
  accuracyMisses: (p: AreaParams & { lead: number; limit?: number }) => get("/accuracy/misses", p, RESPONSE.misses),
  forecast: (locationId: string, days = 8) => get(`/forecast/${encodeURIComponent(locationId)}`, { days }, RESPONSE.forecast),
  forecastPeriods: (locationId: string) => get(`/forecast/${encodeURIComponent(locationId)}/periods`, {}, RESPONSE.periods),
  alerts: (state?: string) => get("/alerts", { state }, RESPONSE.alerts),
};

/** Static demo build (VITE_DATA_MODE=snapshot) reads the exported JSON snapshot instead of /api. */
export const isSnapshot = import.meta.env.VITE_DATA_MODE === "snapshot";
export const api: typeof liveApi = isSnapshot ? snapshotApi : liveApi;
