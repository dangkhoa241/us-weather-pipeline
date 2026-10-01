// Display units. Storage and the API are metric (°C, mm); °F is the dashboard default.
export type TempUnit = "F" | "C";

export const toUnit = (c: number | null | undefined, unit: TempUnit) =>
  c == null ? null : unit === "F" ? (c * 9) / 5 + 32 : c;

/** A temperature difference (no +32 offset). */
export const deltaToUnit = (dc: number | null | undefined, unit: TempUnit) =>
  dc == null ? null : unit === "F" ? (dc * 9) / 5 : dc;

export const fmt = (v: number | null | undefined, digits = 1) =>
  v == null || Number.isNaN(v) ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
