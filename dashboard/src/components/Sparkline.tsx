// Tiny line chart. Missing values are gaps (null), never drawn as 0.
import ReactEChartsCore from "echarts-for-react/esm/core";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent } from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

echarts.use([LineChart, GridComponent, SVGRenderer]);

export function Sparkline({ values, color = "#4575b4", label }: { values: (number | null)[]; color?: string; label: string }) {
  if (!values.some((v) => v != null)) return null;
  return (
    <div role="img" aria-label={label} className="h-10 w-full">
      <ReactEChartsCore
        echarts={echarts}
        opts={{ renderer: "svg" }}
        style={{ height: 40, width: "100%" }}
        option={{
          animation: false,
          grid: { left: 0, right: 0, top: 4, bottom: 4 },
          xAxis: { type: "category", show: false, data: values.map((_, i) => i) },
          yAxis: { type: "value", show: false, scale: true },
          series: [{ type: "line", data: values, symbol: "none", connectNulls: false, lineStyle: { width: 1.5, color } }],
        }}
      />
    </div>
  );
}
