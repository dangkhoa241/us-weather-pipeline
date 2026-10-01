# Stage 5 US map with drill-down: comparison of three implementations

Three implementations of `dashboard/src/components/map/UsMap.tsx` were built on parallel branches from the same
dashboard base (`feature/map-v1`, `-v2`, `-v3`, one git worktree each). They implement the same contract
(`MapProps` in `components/map/types.ts`): the same `/api/v1/map` and `/api/v1/locations` data, Albers USA with
Alaska/Hawaii insets, states colored by the selected metric and period with the shared palette (`lib/colors.ts`),
and the drill-down US → state (zoom) → city markers → click a city = select that location (URL filter).

| Version | Approach |
|---|---|
| v1 | ECharts geo map: us-atlas states registered with `echarts.registerMap`, Albers USA via ECharts' custom `projection` hook (d3-geo), city markers as a scatter series; drilling re-registers a one-state map |
| v2 | `react-simple-maps` 5: `ComposableMap` with the same d3 `geoAlbersUsa` projection, `Geographies`/`Geography`, `ZoomableGroup` (center + zoom) and `Marker` |
| v3 | Hand-rolled SVG with `d3-geo`: `geoAlbersUsa().fitSize`, one `<path>` per state, zoom = a `translate/scale` transform to the state's projected bounds |

## Measurements

Production builds (`npm run build`), measured the same way for each branch:
`scripts/bundleSize.mjs` (gzip level 9 of `dist/assets`) and `scripts/measureMap.mjs` (Playwright, headless
Chromium 1400×1000, real API, 5 page loads). Raw data: `docs/analysis/data/map-*-{bundle,browser}.json`;
screenshots: `docs/images/map-v*-drilled.png`, `dashboard-v*.png`.

| | Base (no map) | v1 ECharts | v2 react-simple-maps | v3 d3-geo |
|---|---|---|---|---|
| JS, gzipped | 325.4 KB | 408.3 KB (**+82.9**) | 396.0 KB (+70.6) | **372.4 KB (+47.0)** |
| First map render (median of 5) | — | 157 ms | 170 ms | **149 ms** |
| Mouse drill-down + select city | — | yes | yes | yes |
| Keyboard drill-down (Tab, Enter) | — | **no** | yes | yes |
| Focusable / labelled map elements | — | 0 / 1 | 51 / 51 | 51 / 51 |
| `UsMap.tsx` | — | 130 lines (118 code) | 113 lines (103 code) | **109 lines (100 code)** |

All three include the same us-atlas TopoJSON (~115 KB raw) and topojson-client, so the differences are the
rendering libraries: ECharts' map/geo/visualMap modules (v1), react-simple-maps with d3-zoom/d3-selection (v2), and only
d3-geo (v3). Render times are within ~20 ms of each other; the first load of each run (300–400 ms) includes the cold
API cache and is the outlier in every version.

## Comparison

| Criterion | v1 ECharts geo | v2 react-simple-maps | v3 hand-rolled d3-geo |
|---|---|---|---|
| Files changed | 1 (+ test hooks for pixel positions) | 1 + new dependency | 1 |
| Drill-down / zoom code | Re-registers a one-state map; ECharts refits it (no zoom animation, neighbors disappear) | `ZoomableGroup` center + zoom from the state's centroid/bounds; also wheel/drag pan-zoom for free; must sync its internal pan state back (`onMoveEnd`) | One transform from `path.bounds()`; CSS transition; neighbors stay visible as context |
| Accessibility | Canvas/SVG drawn by ECharts: no per-state focus or labels; only a generated `aria` description. Not usable by keyboard | Each `Geography`/`Marker` accepts `tabIndex`, `role`, `aria-label`, key handlers | Same as v2, plain SVG elements |
| Theming with the other charts | Native: `visualMap` + the same ECharts engine as the sparklines/charts; tooltips built in | Manual: shared `colorFor` palette + Tailwind; legend hand-made | Same as v2 |
| Error handling | ECharts swallows bad data quietly (NaN → "no data" color) | Same data path as v3 | Missing values → gray `NO_DATA`; projection returns null outside the insets → marker skipped |
| Security | Tooltip `formatter` returns an **HTML string** built from state and city names (XSS if the API ever returned markup); exposes test hooks on `window` | React escapes all text; one more third-party package (+ d3-zoom/selection) to keep updated | React escapes all text; no new dependencies |
| Extensibility | Easy to add ECharts features (labels, effects, heatmaps); hard to add custom interaction | Pan/zoom and annotations built in; tied to the library's release cadence (v5 dropped the old `style` states API) | Full control; pan/zoom or county drill-down would be ~20 more lines with d3-zoom |

## Decision: adopt v3 (hand-rolled d3-geo)

- **Smallest:** +47 KB gzipped instead of +71 KB (v2) or +83 KB (v1); fastest first render (149 ms).
- **Accessible:** every state and city is a labelled, keyboard-operable button, as in v2; v1 can't offer this.
- **Simplest drill-down:** one transform computed from the state's projected bounds, with a smooth transition and
  neighboring states kept as context. Least code (100 lines) and no extra dependency to maintain.
- **Theming:** uses the same palette module as the ECharts charts, so colors match; losing ECharts' built-in tooltip
  is covered by SVG `<title>` tooltips and the states table.

Security notes from the comparison: v1's HTML tooltip formatter is the only injection risk found, and it is not
adopted (React escapes everything in v3). v3 adds no runtime dependency and loads no data from third parties: the
TopoJSON is bundled, so the dashboard keeps working under a strict Content-Security-Policy.

Possible later improvements (not needed now): lazy-load the TopoJSON to shave ~35 KB off the first load; add
d3-zoom for free pan/zoom.
