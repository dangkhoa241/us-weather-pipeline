// US map, v3: hand-rolled SVG with d3-geo (Albers USA with Alaska/Hawaii insets).
// All tracked cities are dots on the national map; click a state to zoom (county borders load lazily and city
// names appear); click a city to select it. State hover and zoom can be controlled by the table next to the map.
import { useEffect, useMemo, useState } from "react";
import { geoAlbersUsa, geoPath } from "d3-geo";
import { feature, mesh } from "topojson-client";
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
const statePaths = states.map((f) => ({ f, code: STATE_BY_FIPS[String(f.id)], d: path(f) ?? "" }));
const borders = path(mesh(topology, topology.objects.states, (a, b) => a !== b)) ?? "";   // shared state lines
const outline = path(mesh(topology, topology.objects.states, (a, b) => a === b)) ?? "";   // the US outline

/** Transform that fits a state's projected bounds into the view (with padding). */
function zoomTo(f: Feature | undefined) {
  if (!f) return { k: 1, x: 0, y: 0 };
  const [[x0, y0], [x1, y1]] = path.bounds(f);
  const k = Math.min(8, 0.85 / Math.max((x1 - x0) / W, (y1 - y0) / H));
  return { k, x: W / 2 - (k * (x0 + x1)) / 2, y: H / 2 - (k * (y0 + y1)) / 2 };
}

// County borders are ~840 KB: loaded only when a state is zoomed, as a separate chunk.
type Counties = Feature<Geometry>[];
let countiesPromise: Promise<Counties> | null = null;
const loadCounties = () => (countiesPromise ??= import("us-atlas/counties-10m.json").then((m) => {
  const t = (m.default ?? m) as unknown as Topology<{ counties: GeometryCollection }>;
  return (feature(t, t.objects.counties) as FeatureCollection<Geometry>).features;
}));

const activate = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
};

export function UsMap({ states: rows, locations, metric, unit, selectedLocation, onSelectLocation, cityValues,
  zoomState, onZoomState, hoveredState, onHoverState }: MapProps) {
  const [ownZoom, setOwnZoom] = useState<string | null>(null);
  const [ownHover, setOwnHover] = useState<string | null>(null);
  const selectedState = zoomState !== undefined ? zoomState : ownZoom;
  const hovered = hoveredState !== undefined ? hoveredState : ownHover;
  const setZoom = (code: string | null) => { setOwnZoom(code); onZoomState?.(code); };
  const setHover = (code: string | null) => { setOwnHover(code); onHoverState?.(code); };

  const byState = useMemo(() => new Map(rows.map((r) => [r.state, r])), [rows]);
  const values = useMemo(() => new Map(rows.map((r) => [r.state, stateValue(r, metric, unit)])), [rows, metric, unit]);
  const range = extent([...values.values()]) ?? [0, 1];
  const palette = metric === "precip_mm" ? PALETTES.rain : PALETTES.temp;
  const selectedFeature = states.find((f) => STATE_BY_FIPS[String(f.id)] === selectedState);
  const t = zoomTo(selectedFeature);
  const label = metricLabel(metric, unit);
  const valueUnit = metric === "precip_mm" ? "mm" : `°${unit}`;
  const cityCount = locations.filter((l) => l.state === selectedState).length;

  const [counties, setCounties] = useState<Counties>([]);
  useEffect(() => {
    if (!selectedState) return;
    let live = true;
    loadCounties().then((all) => { if (live) setCounties(all); }).catch(() => { /* borders are optional */ });
    return () => { live = false; };
  }, [selectedState]);
  const fips = selectedFeature ? String(selectedFeature.id) : null;
  const countyPaths = useMemo(
    () => (fips ? counties.filter((c) => String(c.id).startsWith(fips)).map((c) => ({ id: String(c.id), d: path(c) ?? "" })) : []),
    [counties, fips],
  );

  useEffect(() => {
    requestAnimationFrame(() => performance.mark("map-ready"));
  }, []);

  const dots = locations.map((c) => ({ c, p: projection([c.lon, c.lat]) })).filter((d) => d.p != null);
  const r = 1 / t.k;   // one screen pixel in map units

  return (
    <div data-map data-map-level={selectedState ? "state" : "us"} role="group" aria-label={`US map: ${label}`} className="flex flex-col gap-2">
      <div className="flex h-8 items-center gap-2 text-sm">
        {selectedState ? (
          <button type="button" className="rounded-md border px-2 py-1 hover:bg-muted" onClick={() => setZoom(null)}>← United States</button>
        ) : <span className="text-muted-foreground">Select a state to zoom in, or a city dot to open its history</span>}
        {selectedState && (
          <span className="font-medium">
            {String(selectedFeature?.properties?.name ?? selectedState)} · {cityCount ? `${cityCount} tracked ${cityCount === 1 ? "city" : "cities"}` : "no tracked cities"}
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
        <defs>
          <pattern id="map-nodata-hatch" patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">
            <rect width="7" height="7" style={{ fill: "var(--map-nodata)" }} />
            <line x1="0" y1="0" x2="0" y2="7" strokeWidth="1.6" style={{ stroke: "var(--map-hatch)" }} />
          </pattern>
        </defs>
        <g transform={`translate(${t.x},${t.y}) scale(${t.k})`} style={{ transition: "transform 450ms ease" }}>
          {statePaths.map(({ f, code, d }) => {
            const value = values.get(code) ?? null;
            const row = byState.get(code);
            const name = String(f.properties?.name ?? code);
            const text = `${name}: ${value == null ? "no data" : `${fmt(value)} ${valueUnit}`}${row ? `, ${row.cities} tracked ${row.cities === 1 ? "city" : "cities"}` : ""}`;
            return (
              <path key={code} d={d} data-state={code} data-hover={hovered === code || undefined}
                fill={value == null ? "url(#map-nodata-hatch)" : colorFor(value, range, palette)}
                className="cursor-pointer outline-none focus-visible:opacity-80"
                tabIndex={selectedState ? -1 : 0} role="button" aria-label={text}
                onClick={() => setZoom(code)} onKeyDown={activate(() => setZoom(code))}
                onMouseEnter={() => setHover(code)} onMouseLeave={() => setHover(null)}>
                <title>{text}</title>
              </path>
            );
          })}
          <g pointerEvents="none" fill="none">
            {countyPaths.map((c) => <path key={c.id} d={c.d} data-county strokeWidth={0.6} vectorEffect="non-scaling-stroke" style={{ stroke: "var(--map-county)" }} />)}
            <path d={borders} strokeWidth={1.2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={{ stroke: "var(--map-line)" }} />
            <path d={outline} strokeWidth={1.8} strokeLinejoin="round" vectorEffect="non-scaling-stroke" style={{ stroke: "var(--map-outline)" }} />
            {hovered && (
              <path d={statePaths.find((s) => s.code === hovered)?.d} data-hover-outline strokeWidth={2.5} strokeLinejoin="round"
                vectorEffect="non-scaling-stroke" style={{ stroke: "var(--foreground)" }} />
            )}
          </g>
          {dots.map(({ c, p }) => {
            const inView = !selectedState || c.state === selectedState;
            const value = cityValues?.get(c.id) ?? null;
            const loading = value == null;
            const selected = c.id === selectedLocation;
            const color = colorFor(value, range, palette);
            const tip = `${c.name}, ${c.state}: ${loading ? "Data loading" : `${fmt(value)} ${valueUnit}`}`;
            return (
              <g key={c.id} data-location={c.id} data-loading={loading || undefined} transform={`translate(${p![0]},${p![1]})`}
                tabIndex={inView ? 0 : -1} role="button" aria-hidden={inView ? undefined : true}
                aria-label={`Select ${c.name}, ${c.state}${loading ? ": data loading" : `: ${fmt(value)} ${valueUnit}`}`} aria-pressed={selected}
                className="cursor-pointer outline-none" onClick={() => onSelectLocation(c.id)} onKeyDown={activate(() => onSelectLocation(c.id))}>
                <title>{tip}</title>
                {loading ? (
                  <circle r={3 * r} fill="none" strokeWidth={1.4 * r} style={{ stroke: "var(--muted-foreground)" }} opacity={0.8} />
                ) : (
                  <>
                    <circle r={9 * r} fill={color} opacity={0.28} />
                    <circle r={5.2 * r} fill={color} stroke="#ffffff" strokeWidth={1.4 * r} />
                  </>
                )}
                {selected && <circle r={10 * r} fill="none" strokeWidth={2 * r} style={{ stroke: "var(--foreground)" }} />}
                {selectedState && c.state === selectedState && (
                  <text x={12 * r} y={4 * r} fontSize={13 * r} fontWeight={selected ? 700 : 500} paintOrder="stroke" strokeWidth={3.5 * r}
                    style={{ stroke: "var(--card)", fill: "var(--foreground)" }}>{c.name}</text>
                )}
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
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" aria-hidden>
      <span>{fmt(range[0])}</span>
      <div className="h-2 w-48 rounded" style={{ background: `linear-gradient(to right, ${palette.join(",")})` }} />
      <span>{fmt(range[1])}</span>
      <span>{label}</span>
      <span className="ml-auto flex items-center gap-3">
        <span className="flex items-center gap-1"><svg width="12" height="12"><circle cx="6" cy="6" r="4" fill="none" strokeWidth="1.4" style={{ stroke: "var(--muted-foreground)" }} /></svg>data loading</span>
        <span className="flex items-center gap-1"><svg width="12" height="12"><rect width="12" height="12" rx="2" style={{ fill: "var(--map-hatch)" }} /></svg>no data</span>
      </span>
    </div>
  );
}
