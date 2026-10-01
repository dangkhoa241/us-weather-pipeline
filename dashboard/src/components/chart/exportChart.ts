// Chart downloads: CSV of the plotted buckets and a PNG of the SVG (theme colors resolved to real values).
import type { ChartPoint } from "./types";

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const cell = (v: string | number | null) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

/** Missing values are empty cells (never 0). Temperatures are in the displayed unit. */
export function csvOf(points: ChartPoint[], metric: "temp_c" | "precip_mm", unit: "F" | "C", rainUnit = "mm"): string {
  const conv = (c: number | null) => (c == null || metric === "precip_mm" || unit === "C" ? c : (c * 9) / 5 + 32);
  const round = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);
  if (metric === "precip_mm") return [`bucket,label,${rainUnit === "mm" ? "precip_mm" : "rain_chance_pct"}`, ...points.map((p) => [p.key, p.label, round(p.sum)].map(cell).join(","))].join("\n");
  return [`bucket,label,min_${unit},avg_${unit},max_${unit}`,
    ...points.map((p) => [p.key, p.label, round(conv(p.min)), round(conv(p.avg)), round(conv(p.max))].map(cell).join(","))].join("\n");
}

export const downloadCsv = (csv: string, name: string) => save(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${name}.csv`);

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function downloadPng(svg: SVGSVGElement, name: string) {
  const w = svg.clientWidth || Number(svg.getAttribute("width")) || 640;
  const h = svg.clientHeight || Number(svg.getAttribute("height")) || 300;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll("[data-no-export]").forEach((e) => e.remove());
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  clone.setAttribute("font-family", "sans-serif");
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("width", String(w));
  bg.setAttribute("height", String(h));
  bg.setAttribute("fill", cssVar("--card") || "#ffffff");
  clone.insertBefore(bg, clone.firstChild);
  // The image has no access to the page's CSS variables, so write their values into the markup.
  const xml = new XMLSerializer().serializeToString(clone).replace(/var\((--[\w-]+)\)/g, (_, n) => cssVar(n) || "#888888");
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = w * 2;
    canvas.height = h * 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0, w, h);
    canvas.toBlob((b) => b && save(b, `${name}.png`), "image/png");
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
}
