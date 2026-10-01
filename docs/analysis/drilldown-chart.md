# Stage 5 city drill-down chart: comparison of three implementations

Three implementations of `dashboard/src/components/chart/StatsChart.tsx` were built on parallel branches from the
same base commit (`feature/drilldown-v1`, `-v2`, `-v3`, one git worktree each). They implement the same contract
(`StatsChartProps` in `components/chart/types.ts`), so `DrillDownPanel` (City › Year › Month, state in the URL) and
`TrendPanel` (Period filter) use any of them unchanged:

- Temperature: average line + min/max band. Precipitation: bars of the sum.
- Null buckets (future months, missing days) are gaps, never drawn as 0.
- With `onSelect`, a bucket with data can be selected (years → months → days).

| Version | Approach |
|---|---|
| v1 | ECharts (tree-shaken `echarts/core`, SVG renderer, same engine as the KPI sparklines). The band is two stacked line series (an invisible min plus max − min with an area). A click anywhere in a column is mapped to its bucket with `convertFromPixel`. |
| v2 | Recharts 3 `ComposedChart` in a `ResponsiveContainer`, with a range `Area` for the band, a `Line` with custom dots and a `Bar` with a custom shape. The custom dots and bars carry the ARIA attributes and key handlers. |
| v3 | Hand-rolled SVG with `d3-scale` (band + linear scales) and `d3-shape` (`area`, `line`, with `.defined()` for gaps). One transparent full-height hit rect per bucket acts as the button. |

## Measurements

Each branch got a production build (`npm run build`) and was measured the same way:

- `scripts/bundleSize.mjs`: gzip level 9 of `dist/assets`.
- `scripts/measureDrill.mjs`: Playwright, headless Chromium at 1400×1000, real API.
  - It times 5 page loads of `?loc=stockton-ca&year=2025` until the chart's `drill-chart-ready` mark.
  - Then it checks the mouse drill to July, the keyboard drill (focus July and press Enter), the breadcrumb back to 2025, and that browser Back restores `month=07`.

The base is the same app with a placeholder chart.

- Raw data: `docs/analysis/data/drill-*-{bundle,browser}.json`.
- Screenshots: `docs/images/drill-v*-{months,days}.png`.

| | Base (placeholder) | v1 ECharts | v2 Recharts | v3 d3 |
|---|---|---|---|---|
| JS, gzipped | 374.8 KB | 391.6 KB (+16.8) | 482.8 KB (**+108.0**) | **385.2 KB (+10.4)** |
| First chart render (median of 5) | 167 ms | 237 ms | 245 ms | **185 ms** |
| Mouse drill months → days (31 points) | — | yes | yes | yes |
| Keyboard drill (focus a month, Enter) | — | **no** | yes | yes |
| Breadcrumb back / browser Back restores the month | — | yes / yes | yes / yes | yes / yes |
| Focusable / labelled chart elements | — | 0 / 1 | 13 / 12 | 12 / 13 |
| `StatsChart.tsx` | — | 78 lines (64 code) | 72 lines (63 code) | 79 lines (70 code) |

Notes on the numbers:

- v1 is cheap because ECharts core is already in the bundle for the sparklines. It only adds the line/bar charts, grid, tooltip and aria modules.
- v2 adds Recharts and its dependencies (Redux Toolkit, Immer, lodash parts, victory-vendor/d3), all for one chart.
- The worst load in every run (300–500 ms) includes a cold API cache and was the outlier for all versions, including the base.
- v2's extra focusable element is Recharts' own focusable chart surface (its `accessibilityLayer`).

## Comparison

| Criterion | v1 ECharts | v2 Recharts | v3 d3-scale/d3-shape |
|---|---|---|---|
| Files changed | 1 | 1 + new dependency | 1 + two small d3 modules |
| Drill-down code | No DOM element per bucket. The click comes in pixels and must be mapped with `convertFromPixel`/`containPixel`. A ref keeps the handler (bound once per chart instance) pointing at fresh props. The measurement script needs a `window.__chartPointPixel` hook. | Per-dot/per-bar handlers inside custom shapes, plus a chart-level `onClick` keyed by `activeLabel`. Shape props arrive typed as `number \| string` and need coercion. | One `<rect>` per bucket with `onClick`/`onKeyDown`. The drill target is a plain element with a `data-key`. |
| Accessibility | Only a generated `aria` description. No focusable buckets, so it can't be used by keyboard. | Labelled buttons on dots/bars. The hit target is the small dot itself, so it is harder to click. | Labelled buttons over each full column (large target), with `<title>` tooltips and a visible focus style. |
| Gaps (nulls) | `connectNulls: false` on each series. The stacked band needs `null` handled on both series. | `connectNulls={false}`. The band is `[min,max] \| null`. | `.defined()` on the area and the line. Bars and dots are skipped. |
| Error handling | ECharts ignores bad values quietly (NaN → gap). | Same data path as v3. | Same data path. An empty series falls back to the domain [0, 1]. |
| Security | The default tooltip escapes HTML. A custom `formatter` returning HTML strings would be an XSS risk (avoided here). Exposes a test hook on `window`. | React escapes all text. Biggest new dependency tree to keep patched. | React escapes all text. Only d3-scale/d3-shape (no DOM manipulation, no network). |
| Responsiveness | ECharts resizes itself on container resize. | `ResponsiveContainer` measures its parent, so it paints one frame later. | `viewBox` scaling. Text scales with the width, which is acceptable at dashboard widths. |
| Extensibility | Built-in zoom, legends, data zoom and themes, if ever wanted. | Rich component API. Tied to Recharts' release cadence (v3 broke v2 APIs). | Full control. Each extra (legend, crosshair) is hand-written. |

## Decision: adopt v3 (d3-scale + d3-shape SVG)

- **Smallest:** +10 KB gzipped, against +17 KB (v1) and +108 KB (v2). It is also the fastest first render (185 ms, close to the 167 ms placeholder).
- **Accessible:** every month and day with data is a labelled, keyboard-operable button covering its whole column. v1 can't offer this without a parallel hidden DOM.
- **Simplest drill-down:** a click or Enter on an element with `data-key` calls `onSelect`. No pixel mapping and no test hooks on `window`.
- **Consistent with the map**, which is also hand-rolled d3 SVG (see `map-drilldown.md`). ECharts stays for the sparklines, where it is already paid for.

Nothing was combined from v1/v2. The one v2 idea worth keeping (labelled per-bucket buttons) is already in v3.

Security notes from the comparison:

- No injection risk in the adopted version: all text goes through React.
- v1's `window.__chartPointPixel` hook is not merged.
- The measurement script fix (scroll into view before a pixel click; kill the `vite preview` process tree before its shell exits so port 4173 is freed) is kept on main.
