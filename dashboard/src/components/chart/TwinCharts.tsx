// Temperature and rain charts side by side (stacked on phones). They share one crosshair/tooltip, and drilling on
// either chart calls the same onSelect, so both always show the same level.
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { TempUnit } from "@/lib/units";
import { StatsChart } from "./StatsChart";
import type { ChartPoint } from "./types";

export type TwinData = { points: ChartPoint[]; pending: boolean; error: Error | null };

type Props = {
  temp: TwinData;
  rain: TwinData;
  unit: TempUnit;
  scope: string;                       // e.g. "per month, 2025" or "by week, 2026-06-29 – 2026-09-26"
  subject: string;                     // e.g. "Stockton, CA"
  maWindow: number;
  onSelect?: (key: string) => void;
  emptyHint?: string;
  readyMark?: string;
};

function Body({ data, children, empty }: { data: TwinData; children: React.ReactNode; empty: string }) {
  if (data.error) return <Alert variant="destructive"><AlertTitle>Could not load the chart</AlertTitle><AlertDescription>{data.error.message}</AlertDescription></Alert>;
  if (data.pending) return <Skeleton className="h-72" />;
  if (!data.points.some((p) => p.avg != null || p.sum != null)) return <Alert><AlertTitle>No data</AlertTitle><AlertDescription>{empty}</AlertDescription></Alert>;
  return <>{children}</>;
}

export function TwinCharts({ temp, rain, unit, scope, subject, maWindow, onSelect, emptyHint = "Nothing to show for this selection.", readyMark }: Props) {
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const shared = { unit, maWindow, hoverKey, onHoverKey: setHoverKey, onSelect };
  return (
    <div {...(readyMark === "drill-chart-ready" ? { "data-drill-panel": true } : { "data-trend-panel": true })} className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Temperature</CardTitle></CardHeader>
        <CardContent>
          <Body data={temp} empty={emptyHint}>
            <StatsChart {...shared} points={temp.points} metric="temp_c" title={`Temperature in ${subject} ${scope}`} readyMark={readyMark} fileName={`temperature-${scope}`.replace(/\W+/g, "-")} />
          </Body>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Rain</CardTitle></CardHeader>
        <CardContent>
          <Body data={rain} empty={emptyHint}>
            <StatsChart {...shared} points={rain.points} metric="precip_mm" title={`Precipitation in ${subject} ${scope}`} fileName={`rain-${scope}`.replace(/\W+/g, "-")} />
          </Body>
        </CardContent>
      </Card>
    </div>
  );
}
