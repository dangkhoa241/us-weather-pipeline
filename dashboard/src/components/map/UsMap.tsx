// US map, v1: ECharts geo map (us-atlas states registered with ECharts, Albers USA via a custom d3-geo projection).
// Drill-down: click a state to show only that state with its city markers; click a city to select it.
import { useEffect, useMemo, useRef, useState } from "react";
import ReactEChartsCore from "echarts-for-react/esm/core";
import * as echarts from "echarts/core";
import { MapChart, ScatterChart } from "echarts/charts";
import { GeoComponent, TooltipComponent, VisualMapComponent, AriaComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { geoAlbersUsa, geoCentroid } from "d3-geo";
import { feature } from "topojson-client";
import type { FeatureCollection, Geometry } from "geojson";
import type { GeometryCollection, Topology } from "topojson-specification";
import us from "us-atlas/states-10m.json";
import { NO_DATA, PALETTES, extent } from "@/lib/colors";
import { STATE_BY_FIPS } from "@/lib/states";
import { fmt } from "@/lib/units";
import { metricLabel, stateValue, type MapProps } from "./types";

echarts.use([MapChart, ScatterChart, GeoComponent, TooltipComponent, VisualMapComponent, AriaComponent, SVGRenderer]);

const topology = us as unknown as Topology<{ states: GeometryCollection }>;
const features = (feature(topology, topology.objects.states) as FeatureCollection<Geometry>).features
  .filter((f) => STATE_BY_FIPS[String(f.id)] && STATE_BY_FIPS[String(f.id)] !== "PR");
const nameOf = (code: string) => String(features.find((f) => STATE_BY_FIPS[String(f.id)] === code)?.properties?.name ?? code);
const albers = geoAlbersUsa();
// ECharts fits the projected shapes into the view itself; this only maps lon/lat to the Albers plane.
const projection = {
  project: (p: number[]) => albers(p as [number, number]) ?? [NaN, NaN],
  unproject: (p: number[]) => albers.invert!(p as [number, number]) ?? [NaN, NaN],
};
echarts.registerMap("USA", { type: "FeatureCollection", features } as never);

export function UsMap({ states: rows, locations, metric, unit, selectedLocation, onSelectLocation }: MapProps) {
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReactEChartsCore>(null);
  const marked = useRef(false);
  const values = useMemo(() => rows.map((r) => ({ name: nameOf(r.state), code: r.state, value: stateValue(r, metric, unit), cities: r.cities })),
    [rows, metric, unit]);
  const range = extent(values.map((v) => v.value)) ?? [0, 1];
  const palette = metric === "precip_mm" ? PALETTES.rain : PALETTES.temp;
  const cities = locations.filter((l) => l.state === selectedState);
  const label = metricLabel(metric, unit);
  const valueUnit = metric === "precip_mm" ? "mm" : `°${unit}`;
  const mapName = selectedState ? `USA-${selectedState}` : "USA";

  if (selectedState && !echarts.getMap(mapName)) {
    echarts.registerMap(mapName, { type: "FeatureCollection", features: features.filter((f) => STATE_BY_FIPS[String(f.id)] === selectedState) } as never);
  }

  // Canvas/SVG drawn by ECharts has no DOM per state, so the measurement script asks for pixel positions.
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    const toRoot = (lonLat: number[]) => {
      const chart = chartRef.current?.getEchartsInstance();
      const px = chart?.convertToPixel({ geoIndex: 0 }, lonLat) as number[] | undefined;
      const dom = chart?.getDom().getBoundingClientRect();
      const root = rootRef.current?.getBoundingClientRect();
      return px && dom && root ? [px[0] + dom.left - root.left, px[1] + dom.top - root.top] : null;
    };
    w.__mapStatePixel = (code: string) => {
      const f = features.find((x) => STATE_BY_FIPS[String(x.id)] === code);
      return f ? toRoot(geoCentroid(f)) : null;
    };
    w.__mapCityPixel = (id: string) => {
      const c = locations.find((l) => l.id === id);
      return c ? toRoot([c.lon, c.lat]) : null;
    };
  }, [locations, selectedState]);

  const option = {
    animation: false,
    aria: { enabled: true, label: { description: `US map of ${label.toLowerCase()} by state.` } },
    tooltip: {
      trigger: "item",
      formatter: (p: { seriesType: string; name: string; value: number | number[] }) =>
        p.seriesType === "scatter" ? `${p.name} — click to select` : `${p.name}: ${typeof p.value === "number" && !Number.isNaN(p.value) ? `${fmt(p.value)} ${valueUnit}` : "no data"}`,
    },
    visualMap: {
      min: range[0], max: range[1], calculable: false, orient: "horizontal", left: 0, bottom: 0,
      text: [fmt(range[1]), fmt(range[0])], inRange: { color: [...palette] }, outOfRange: { color: NO_DATA }, seriesIndex: 0,
      itemHeight: 160, itemWidth: 10,
    },
    geo: {
      map: mapName, projection, roam: false, top: 8, bottom: 40, left: 8, right: 8,   // fit into this box, keep aspect
      itemStyle: { areaColor: NO_DATA, borderColor: "#fff", borderWidth: 0.75 },
      emphasis: { itemStyle: { areaColor: undefined, opacity: 0.8 }, label: { show: false } },
      select: { disabled: true },
    },
    series: [
      { type: "map", geoIndex: 0, data: values.map((v) => ({ name: v.name, value: v.value ?? NaN })) },
      {
        type: "scatter", coordinateSystem: "geo", symbolSize: 12, z: 3,
        data: cities.map((c) => ({ name: `${c.name}, ${c.state}`, value: [c.lon, c.lat], id: c.id,
          itemStyle: { color: c.id === selectedLocation ? "#111827" : "#fff", borderColor: "#111827", borderWidth: 1.5 } })),
        label: { show: true, position: "right", formatter: "{b}", fontSize: 13, textBorderColor: "#fff", textBorderWidth: 3 },
      },
    ],
  };

  const onEvents = {
    click: (p: { seriesType: string; name: string; data?: { id?: string } }) => {
      if (p.seriesType === "scatter" && p.data?.id) onSelectLocation(p.data.id);
      else if (p.seriesType === "map" && !selectedState) {
        const code = features.find((f) => f.properties?.name === p.name);
        if (code) setSelectedState(STATE_BY_FIPS[String(code.id)]);
      }
    },
  };

  return (
    <div ref={rootRef} data-map data-map-level={selectedState ? "state" : "us"} role="group" aria-label={`US map: ${label}`} className="flex flex-col gap-2">
      <div className="flex h-8 items-center gap-2 text-sm">
        {selectedState ? (
          <button type="button" className="rounded-md border px-2 py-1 hover:bg-muted" onClick={() => setSelectedState(null)}>← United States</button>
        ) : <span className="text-muted-foreground">Select a state to see its cities</span>}
        {selectedState && (
          <span className="font-medium">
            {nameOf(selectedState)} · {cities.length ? `${cities.length} tracked ${cities.length === 1 ? "city" : "cities"}` : "no tracked cities"}
          </span>
        )}
      </div>
      <ReactEChartsCore ref={chartRef} echarts={echarts} opts={{ renderer: "svg" }} notMerge option={option} onEvents={onEvents}
        onChartReady={() => {
          if (!marked.current) { marked.current = true; requestAnimationFrame(() => performance.mark("map-ready")); }
        }}
        style={{ height: 560, width: "100%" }} />
    </div>
  );
}
