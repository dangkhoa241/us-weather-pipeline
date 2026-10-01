// One color scale for every chart and map, so the map matches the other charts whatever renders it.
export const PALETTES = {
  temp: ["#313695", "#4575b4", "#74add1", "#abd9e9", "#fee090", "#fdae61", "#f46d43", "#d73027", "#a50026"],
  rain: ["#f7fbff", "#c6dbef", "#9ecae1", "#6baed6", "#4292c6", "#2171b5", "#084594"],
} as const;
export const NO_DATA = "#e5e7eb";

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** Interpolated color for `value` within [min, max]; gray when there is no value. */
export function colorFor(value: number | null | undefined, [min, max]: [number, number], palette: readonly string[]) {
  if (value == null || Number.isNaN(value)) return NO_DATA;
  const t = max === min ? 0.5 : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const pos = t * (palette.length - 1);
  const i = Math.min(palette.length - 2, Math.floor(pos));
  const [a, b] = [hex(palette[i]), hex(palette[i + 1])];
  const f = pos - i;
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
}

export function extent(values: (number | null | undefined)[]): [number, number] | null {
  const nums = values.filter((v): v is number => v != null && !Number.isNaN(v));
  return nums.length ? [Math.min(...nums), Math.max(...nums)] : null;
}
