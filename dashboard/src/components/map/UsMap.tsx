// Placeholder: the US map is chosen by the Compare & review process (feature/map-v1..v3, docs/analysis/).
// Implements the same measurement markers as the real maps (data-map, "map-ready"), so this build is the
// "no map" baseline for bundle size.
import { useEffect } from "react";
import type { MapProps } from "./types";

export function UsMap({ states }: MapProps) {
  useEffect(() => {
    requestAnimationFrame(() => performance.mark("map-ready"));
  }, []);
  return (
    <div data-map data-map-level="us" className="flex h-80 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
      US map ({states.length} states with data) — implementation pending
    </div>
  );
}
