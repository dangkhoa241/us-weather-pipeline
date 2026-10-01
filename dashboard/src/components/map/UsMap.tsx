// US map, v2: react-simple-maps (SVG via d3-geo) with the same Albers USA projection (Alaska/Hawaii insets).
// Drill-down: click (or Enter) a state to zoom to it and show its city markers; click a city to select it.
// ZoomableGroup also gives wheel/drag pan and zoom.
import { useEffect, useMemo, useState } from "react";
import { ComposableMap, Geographies, Geography, Marker, ZoomableGroup } from "react-simple-maps";
import { geoAlbersUsa, geoCentroid, geoPath } from "d3-geo";
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
const statesGeo: FeatureCollection<Geometry> = {
  type: "FeatureCollection",
  features: (feature(topology, topology.objects.states) as FeatureCollection<Geometry>).features
    .filter((f) => STATE_BY_FIPS[String(f.id)] && STATE_BY_FIPS[String(f.id)] !== "PR"),
};
const projection = geoAlbersUsa().fitSize([W, H], statesGeo);
const path = geoPath(projection);
const US_CENTER = projection.invert!([W / 2, H / 2]) as [number, number];

function zoomFor(f: Feature | undefined): { center: [number, number]; zoom: number } {
  if (!f) return { center: US_CENTER, zoom: 1 };
  const [[x0, y0], [x1, y1]] = path.bounds(f);
  return { center: geoCentroid(f) as [number, number], zoom: Math.min(8, 0.85 / Math.max((x1 - x0) / W, (y1 - y0) / H)) };
}

const activate = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
};

export function UsMap({ states: rows, locations, metric, unit, selectedLocation, onSelectLocation }: MapProps) {
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const [view, setView] = useState(zoomFor(undefined));
  const byState = useMemo(() => new Map(rows.map((r) => [r.state, r])), [rows]);
  const values = useMemo(() => new Map(rows.map((r) => [r.state, stateValue(r, metric, unit)])), [rows, metric, unit]);
  const range = extent([...values.values()]) ?? [0, 1];
  const palette = metric === "precip_mm" ? PALETTES.rain : PALETTES.temp;
  const cities = locations.filter((l) => l.state === selectedState);
  const label = metricLabel(metric, unit);
  const valueUnit = metric === "precip_mm" ? "mm" : `°${unit}`;
  const selectedName = statesGeo.features.find((f) => STATE_BY_FIPS[String(f.id)] === selectedState)?.properties?.name;

  const select = (code: string | null) => {
    setSelectedState(code);
    setView(zoomFor(statesGeo.features.find((f) => STATE_BY_FIPS[String(f.id)] === code)));
  };

  useEffect(() => {
    requestAnimationFrame(() => performance.mark("map-ready"));
  }, []);

  return (
    <div data-map data-map-level={selectedState ? "state" : "us"} role="group" aria-label={`US map: ${label}`} className="flex flex-col gap-2">
      <div className="flex h-8 items-center gap-2 text-sm">
        {selectedState ? (
          <button type="button" className="rounded-md border px-2 py-1 hover:bg-muted" onClick={() => select(null)}>← United States</button>
        ) : <span className="text-muted-foreground">Select a state to see its cities</span>}
        {selectedState && (
          <span className="font-medium">
            {String(selectedName ?? selectedState)} · {cities.length ? `${cities.length} tracked ${cities.length === 1 ? "city" : "cities"}` : "no tracked cities"}
          </span>
        )}
      </div>
      <ComposableMap projection={projection} width={W} height={H} className="h-auto w-full">
        <ZoomableGroup center={view.center} zoom={view.zoom} minZoom={1} maxZoom={8}
          onMoveEnd={({ coordinates, zoom }) => setView((v) => ({ center: coordinates ?? v.center, zoom: zoom ?? v.zoom }))}>
          <Geographies geography={statesGeo}>
            {({ geographies }) => geographies.map((geo) => {
              const code = STATE_BY_FIPS[String(geo.id)];
              const value = values.get(code) ?? null;
              const row = byState.get(code);
              const name = String(geo.properties?.name ?? code);
              const text = `${name}: ${value == null ? "no data" : `${fmt(value)} ${valueUnit}`}${row ? `, ${row.cities} tracked ${row.cities === 1 ? "city" : "cities"}` : ""}`;
              return (
                <Geography key={geo.rsmKey} geography={geo} data-state={code} tabIndex={selectedState ? -1 : 0} role="button"
                  aria-label={text} onClick={() => select(code)} onKeyDown={activate(() => select(code))}
                  fill={colorFor(value, range, palette)} stroke="white" strokeWidth={0.75 / view.zoom}
                  className="cursor-pointer outline-none hover:opacity-80 focus-visible:stroke-black">
                  <title>{text}</title>
                </Geography>
              );
            })}
          </Geographies>
          {cities.map((c) => {
            const selected = c.id === selectedLocation;
            return (
              <Marker key={c.id} coordinates={[c.lon, c.lat]} data-location={c.id} tabIndex={0} role="button"
                aria-label={`Select ${c.name}, ${c.state}`} aria-pressed={selected} className="cursor-pointer outline-none"
                onClick={() => onSelectLocation(c.id)} onKeyDown={activate(() => onSelectLocation(c.id))}>
                <circle r={6 / view.zoom} fill={selected ? "#111827" : "#ffffff"} stroke="#111827" strokeWidth={1.5 / view.zoom} />
                <text x={9 / view.zoom} y={4 / view.zoom} fontSize={13 / view.zoom} fontWeight={selected ? 600 : 400}
                  paintOrder="stroke" stroke="white" strokeWidth={3 / view.zoom}>{c.name}</text>
              </Marker>
            );
          })}
        </ZoomableGroup>
      </ComposableMap>
      <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-hidden>
        <span>{fmt(range[0])}</span>
        <div className="h-2 w-48 rounded" style={{ background: `linear-gradient(to right, ${palette.join(",")})` }} />
        <span>{fmt(range[1])}</span>
        <span>{label}</span>
      </div>
    </div>
  );
}
