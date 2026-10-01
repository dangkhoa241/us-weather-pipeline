// Forecast models shown in the dashboard, with display names and colors from the shared palette (index.css).
// Anything else in the data (e.g. legacy gfs_seamless / icon_seamless snapshots) is left out.
export type ModelInfo = { id: string; name: string; color: string; baseline?: boolean };

export const MODELS: ModelInfo[] = [
  { id: "nws", name: "NWS", color: "var(--m-nws)" },
  { id: "ecmwf_ifs025", name: "ECMWF", color: "var(--m-ecmwf)" },
  { id: "gfs_global", name: "GFS", color: "var(--m-gfs)" },
  { id: "icon_global", name: "ICON", color: "var(--m-icon)" },
  { id: "gfs_hrrr", name: "HRRR", color: "var(--m-hrrr)" },
  { id: "best_match", name: "Best match", color: "var(--m-best)", baseline: true },
];

export const MODEL_BY_ID = new Map(MODELS.map((m) => [m.id, m]));
export const modelName = (id: string) => MODEL_BY_ID.get(id)?.name ?? id;
