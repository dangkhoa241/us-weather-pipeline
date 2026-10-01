// Typed API client. Types and response validation come from the backend's own schemas (src/api/schemas.js),
// so the dashboard and the API share one definition instead of copies.
import type { z } from "zod";
import { RESPONSE, ROW, errorResponse } from "@shared/schemas.js";

export type LocationRow = z.infer<typeof ROW.location>;
export type StatsRow = z.infer<typeof ROW.stats>;
export type MapRow = z.infer<typeof ROW.map>;
export type AccuracyRow = z.infer<typeof ROW.accuracy>;
export type StatsResponse = z.infer<typeof RESPONSE.stats>;

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

export const api = {
  locations: () => get("/locations", {}, RESPONSE.locations),
  stats: (p: { locations: string; metric: string; period: string; from: string; to: string; compare?: string }) =>
    get("/stats", p, RESPONSE.stats),
  map: (p: { from: string; to: string }) => get("/map", p, RESPONSE.map),
  accuracy: (p: { from: string; to: string; location?: string }) => get("/accuracy", p, RESPONSE.accuracy),
};
