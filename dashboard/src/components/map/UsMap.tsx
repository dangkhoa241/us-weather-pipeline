// US map, v3: hand-rolled SVG with d3-geo (Albers USA with Alaska/Hawaii insets).
// Drill-down: click (or Enter) a state to zoom to it and show its city markers; click a city to select it.
import { useEffect, useMemo, useState } from "react";
import { geoAlbersUsa, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import us from "us-atlas/states-10m.json";
import { colorFor, extent, PALETTES } from "@/lib/colors";
import { STATE_BY_FIPS } from "@/lib/states";
import { fmt } from "@/lib/units";
import { metricLabel, stateValue, type MapProps } from "./types";

const W = 975;
const H = 610;
const topology = us as unknown as Topology<{ states: GeometryCollection }>;
const states = (feature(topology, topology.objects.states) as FeatureCollection<Geometry>).features
  .filter((f) => STATE_BY_FIPS[String(f.id)] && STATE_BY_FIPS[String(f.id)] !== "PR");
const projection = geoAlbersUsa().fitSize([W, H], { type: "FeatureCollection", features: states });
const path = geoPath(projection);

/** Transform that fits a state's projected bounds into the view (with padding). */
function zoomTo(f: Feature | undefined) {
  if (!f) return { k: 1, x: 0, y: 0 };
  const [[x0, y0], [x1, y1]] = path.bounds(f);
  const k = Math.min(8, 0.85 / Math.max((x1 - x0) / W, (y1 - y0) / H));
  return { k, x: W / 2 - (k * (x0 + x1)) / 2, y: H / 2 - (k * (y0 + y1)) / 2 };
}

const activate = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
};

export function UsMap({ states: rows, locations, metric, unit, selectedLocation, onSelectLocation }: MapProps) {
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const byState = useMemo(() => new Map(rows.map((r) => [r.state, r])), [rows]);
  const values = useMemo(() => new Map(rows.map((r) => [r.state, stateValue(r, metric, unit)])), [rows, metric, unit]);
  const range = extent([...values.values()]) ?? [0, 1];
  const palette = metric === "precip_mm" ? PALETTES.rain : PALETTES.temp;
  const selectedFeature = states.find((f) => STATE_BY_FIPS[String(f.id)] === selectedState);
  const t = zoomTo(selectedFeature);
  const cities = locations.filter((l) => l.state === selectedState);
  const label = metricLabel(metric, unit);
  const valueUnit = metric === "precip_mm" ? "mm" : `°${unit}`;

  useEffect(() => {
    requestAnimationFrame(() => performance.mark("map-ready"));
  }, []);

  return (
    <div data-map data-map-level={selectedState ? "state" : "us"} role="group" aria-label={`US map: ${label}`} className="flex flex-col gap-2">
      <div className="flex h-8 items-center gap-2 text-sm">
        {selectedState ? (
          <button type="button" className="rounded-md border px-2 py-1 hover:bg-muted" onClick={() => setSelectedState(null)}>← United States</button>
        ) : <span className="text-muted-foreground">Select a state to see its cities</span>}
        {selectedState && (
          <span className="font-medium">
            {String(selectedFeature?.properties?.name ?? selectedState)} · {cities.length ? `${cities.length} tracked ${cities.length === 1 ? "city" : "cities"}` : "no tracked cities"}
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
        <g transform={`translate(${t.x},${t.y}) scale(${t.k})`} style={{ transition: "transform 450ms ease" }}>
          {states.map((f) => {
            const code = STATE_BY_FIPS[String(f.id)];
            const value = values.get(code) ?? null;
            const row = byState.get(code);
            const name = String(f.properties?.name ?? code);
            const text = `${name}: ${value == null ? "no data" : `${fmt(value)} ${valueUnit}`}${row ? `, ${row.cities} tracked ${row.cities === 1 ? "city" : "cities"}` : ""}`;
            return (
              <path key={code} d={path(f) ?? ""} data-state={code} fill={colorFor(value, range, palette)}
                stroke="white" strokeWidth={0.75 / t.k} className="cursor-pointer outline-none hover:opacity-80 focus-visible:stroke-black"
                tabIndex={selectedState ? -1 : 0} role="button" aria-label={text}
                onClick={() => setSelectedState(code)} onKeyDown={activate(() => setSelectedState(code))}>
                <title>{text}</title>
              </path>
            );
          })}
          {cities.map((c) => {
            const p = projection([c.lon, c.lat]);
            if (!p) return null;
            const selected = c.id === selectedLocation;
            return (
              <g key={c.id} data-location={c.id} transform={`translate(${p[0]},${p[1]})`} tabIndex={0} role="button"
                aria-label={`Select ${c.name}, ${c.state}`} aria-pressed={selected} className="cursor-pointer outline-none"
                onClick={() => onSelectLocation(c.id)} onKeyDown={activate(() => onSelectLocation(c.id))}>
                <circle r={6 / t.k} fill={selected ? "#111827" : "#ffffff"} stroke="#111827" strokeWidth={1.5 / t.k} />
                <text x={9 / t.k} y={4 / t.k} fontSize={13 / t.k} fontWeight={selected ? 600 : 400} paintOrder="stroke"
                  stroke="white" strokeWidth={3 / t.k}>{c.name}</text>
              </g>
            );
          })}
        </g>
      </svg>
      <Legend range={range} palette={palette} label={label} />
    </div>
  );
}

function Legend({ range, palette, label }: { range: [number, number]; palette: readonly string[]; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-hidden>
      <span>{fmt(range[0])}</span>
      <div className="h-2 w-48 rounded" style={{ background: `linear-gradient(to right, ${palette.join(",")})` }} />
      <span>{fmt(range[1])}</span>
      <span>{label}</span>
    </div>
  );
}
