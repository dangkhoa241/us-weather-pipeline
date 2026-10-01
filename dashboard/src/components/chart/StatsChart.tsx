// Statistics chart, v1: ECharts (tree-shaken core, SVG renderer; same engine as the sparklines).
// Temperature: avg line + min/max band (stacked areas); precipitation: bars. Null buckets are gaps (never 0).
// With onSelect, clicking a bucket with data selects it (drill-down).
import { useEffect, useRef } from "react";
import ReactEChartsCore from "echarts-for-react/esm/core";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { AriaComponent, GridComponent, TooltipComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { fmt } from "@/lib/units";
import { valueOf, type StatsChartProps } from "./types";

echarts.use([BarChart, LineChart, GridComponent, TooltipComponent, AriaComponent, SVGRenderer]);

const toUnit = (v: number | null, rain: boolean, unit: string) => (v == null || rain ? v : unit === "F" ? (v * 9) / 5 + 32 : v);

export function StatsChart({ points, metric, unit, title, onSelect, readyMark }: StatsChartProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReactEChartsCore>(null);
  const rain = metric === "precip_mm";
  const unitLabel = rain ? "mm" : `°${unit}`;
  const values = points.map((p) => valueOf(p, metric, unit));
  const mins = points.map((p) => toUnit(p.min, rain, unit));
  const maxs = points.map((p) => toUnit(p.max, rain, unit));

  // ECharts draws without one DOM element per bucket, so the measurement script asks for pixel positions.
  useEffect(() => {
    if (!readyMark) return;
    (window as unknown as Record<string, unknown>).__chartPointPixel = (key: string) => {
      const i = points.findIndex((p) => p.key === key);
      const chart = chartRef.current?.getEchartsInstance();
      const px = i < 0 || !chart ? null : (chart.convertToPixel({ gridIndex: 0 }, [i, values[i] ?? 0]) as number[]);
      const dom = chart?.getDom().getBoundingClientRect();
      const root = rootRef.current?.getBoundingClientRect();
      return px && dom && root ? [px[0] + dom.left - root.left, px[1] + dom.top - root.top] : null;
    };
  }, [points, values, readyMark]);

  const option = {
    animation: false,
    aria: { enabled: true, label: { description: `${title}, in ${unitLabel}.` } },
    grid: { left: 44, right: 12, top: 12, bottom: 28 },
    tooltip: { trigger: "axis", valueFormatter: (v: unknown) => (v == null || Number.isNaN(Number(v)) ? "no data" : `${fmt(Number(v))} ${unitLabel}`) },
    xAxis: { type: "category", data: points.map((p) => p.label), axisTick: { alignWithLabel: true } },
    yAxis: { type: "value", scale: !rain, min: rain ? 0 : undefined },
    series: rain
      ? [{ name: "Precipitation", type: "bar", data: values, itemStyle: { color: "#2171b5" } }]
      : [
          // Band = invisible min series + (max − min) stacked on top of it.
          { name: "Min", type: "line", stack: "band", data: mins, symbol: "none", lineStyle: { opacity: 0 }, connectNulls: false, tooltip: { show: false } },
          { name: "Range", type: "line", stack: "band", data: maxs.map((m, i) => (m == null || mins[i] == null ? null : m - (mins[i] as number))),
            symbol: "none", lineStyle: { opacity: 0 }, areaStyle: { color: "#fdae61", opacity: 0.35 }, connectNulls: false, tooltip: { show: false } },
          { name: "Average", type: "line", data: values, symbolSize: 6, itemStyle: { color: "#d73027" }, lineStyle: { width: 2, color: "#d73027" }, connectNulls: false },
        ],
  };

  // Click anywhere in a bucket's column (not only on the small symbol). Refs keep the handler, bound once
  // per chart instance, pointing at the latest points.
  const latest = useRef({ points, values, onSelect });
  latest.current = { points, values, onSelect };
  const onReady = (chart: echarts.ECharts) => {
    chart.getZr().on("click", (e: { offsetX: number; offsetY: number }) => {
      const { points: pts, values: vals, onSelect: select } = latest.current;
      if (!select || !chart.containPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY])) return;
      const i = Math.round((chart.convertFromPixel({ gridIndex: 0 }, [e.offsetX, e.offsetY]) as number[])[0]);
      if (pts[i] && vals[i] != null) select(pts[i].key);
    });
    if (readyMark && points.length) requestAnimationFrame(() => performance.mark(readyMark));
  };

  return (
    <div ref={rootRef} data-chart data-points={points.length} role="group" aria-label={title}>
      <ReactEChartsCore ref={chartRef} echarts={echarts} opts={{ renderer: "svg" }} notMerge option={option}
        style={{ height: 280, width: "100%", cursor: onSelect ? "pointer" : "default" }}
        onChartReady={onReady} />
    </div>
  );
}
