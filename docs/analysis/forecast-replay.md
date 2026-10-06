# Stage 5 forecast replay: comparison of three chart designs

Goal: for a city and a past day, show what each model predicted 1 to 7 days before, converging on the observed daily
high. It opens only on request ("Replay forecasts" in the city's day drill-down) and runs live from the browser:
no dependency on the local Docker stack, ClickHouse or AWS.

## Step 0: what Open-Meteo actually returns (real requests, 2026-10-05)

Stockton, CA (37.9577, −121.2908) for 2026-09-20, then other dates and cities to find the limits.

**CORS.** Both `previous-runs-api.open-meteo.com/v1/forecast` and `archive-api.open-meteo.com/v1/archive` answer with
`access-control-allow-origin: *` (`allow-methods: GET, POST, OPTIONS`, `max-age: 600`). A plain GET with no custom
headers is a simple request, so the browser sends no preflight.

**Models and lead days.** `hourly=temperature_2m_previous_day1..7` with
`models=ecmwf_ifs025,gfs_global,icon_global,gfs_hrrr,best_match`; non-null hours of the local day:

| Model | day1 | day2 | day3 | day4 | day5 | day6 | day7 | Max lead |
|---|---|---|---|---|---|---|---|---|
| ECMWF (`ecmwf_ifs025`) | 24 | 24 | 24 | 24 | 24 | 24 | 24 | 7 |
| GFS (`gfs_global`) | 24 | 24 | 24 | 24 | 24 | 24 | 24 | 7 |
| ICON (`icon_global`) | 24 | 24 | 24 | 24 | 24 | 24 | **0** | 6 |
| HRRR (`gfs_hrrr`) | 24 | **0** | **0** | **0** | **0** | **0** | **0** | 1 |
| Best match | 24 | 24 | 24 | 24 | 24 | 24 | 24 | 7 |

- HRRR covers the lower 48 states only: for Anchorage and Honolulu it returns nothing, and the panel lists it as
  "No forecasts from HRRR".
- In the US, best match equals HRRR at 1 day ahead and GFS at 2–7 days ahead (identical values).
- No model returned nothing everywhere, so none was left out.

**How far back.**
- GFS and best match have data on 2021-06-01, 2022-06-01 and 2023-06-01, but none on 2024-01-15.
- ECMWF starts between 2024-02-01 and 2024-02-15. ICON and HRRR are there on 2024-02-01.
- Every model has data from 2024-02-15 on, so the replay starts at **2024-03-01**.

**The most recent day.**
- The archive returned 24 non-null hours right up to today, but its last ~5 days are model-filled, not observed (as
  already noted in the roadmap).
- So the replay ends at **today − 7 days**.

**Time zones.**
- With `timezone=America/Los_Angeles`, Open-Meteo applies **one fixed UTC offset**: today's, GMT−7, even for
  2025-01-15 (PST, GMT−8).
- On DST days it still returns exactly 24 slots (2025-03-09 and 2025-11-02).
- So a winter local day would start at 01:00. The client asks for `timezone=GMT` over the UTC days D−1 … D+1 and
  picks the hours whose local date in the city's IANA zone is D (`Intl.DateTimeFormat`). That gives 24 hours, or
  23/25 on DST days.
- A lead day counts only if every local hour has a value (a partial day would understate the high). Nulls stay null.

## Client (`dashboard/src/lib/replay.ts`, `useReplay.ts`)

- **Validation:** the city must be one of the 53 (a `Map` over `src/locations/cities.js`, so `__proto__` finds
  nothing). The day must be a real calendar day inside 2024-03-01 … today − 7. Invalid input throws before any
  request is sent.
- **Requests:** URLs are built with `URLSearchParams` on fixed hosts, with a 4 s timeout (one `AbortController` for
  both requests) and `credentials: "omit"`. Answers are validated with zod, including size caps.
- **Calls per panel open: 2 HTTP requests** (Previous Runs + archive) for the day shown. Picking another day costs
  2 more. Re-opening, or returning to a day already seen, costs 0.
  - TanStack Query keeps one entry per city + day with `staleTime: Infinity`, `retry: false`, `retryOnMount: false`
    and no refetch on focus.
  - The query's abort signal is deliberately not passed on, so closing the panel mid-request can't trigger a second
    request.
- **Open-Meteo usage:** one day viewed is ~5 weighted calls (35 variables × models ≈ 4, plus the archive's 1). The
  limit is per client IP, so each visitor uses their own allowance of 10,000/day.
- **Fallback:**
  - If the live call fails, the panel says "Live data unavailable" with the reason, switches its label to
    "Sample · bundled, not live", and shows a bundled sample.
  - The sample covers 3 cities (Stockton 2026-09-20, Chicago 2026-08-15, Miami 2026-07-04).
  - `scripts/buildReplaySample.mjs` made it by running the same `fetchReplay` through Vite.
  - Size: **2,896 bytes (572 gzipped)**.

## The three designs

All three implement the same `ReplayChartProps` contract (`components/replay/types.ts`) on parallel branches from
the same base commit (`feature/forecast-replay-v1`, `-v2`, `-v3`, one git worktree each). Same data for all three:
Stockton, Sun Sep 20, 2026, live.

| Version | Approach |
|---|---|
| A (v1) | One line per model over lead days 7 → 1. Each model has its own marker shape, a direct label at its last forecast and a legend button (hover or focus highlights it). Seven focusable lead-day columns with a tooltip listing every model. |
| B (v2) | Small multiples: one panel per model on a shared y-scale, each with the dashed observed high. The panel title shows the model name and its 1-day miss. Each panel is focusable and describes its values in words. |
| C (v3) | A min–max band across models per lead day, thin model lines inside it, a "±" spread label per lead and the dashed observed high. Legend buttons and lead-day columns as in A. |

Screenshots (light/dark): `docs/images/replay-v{1,2,3}-{light,dark}.png`. Raw browser data:
`docs/analysis/data/replay-v*-browser.json`.

## Measurements

- **Bundle:** `vite build --mode snapshot`, all JS gzip level 9, without the lazy county chunk.
- **Browser:** `dashboard/scripts/shotReplay.mjs`, headless Chromium at 1400×1000. The build is served with
  `vercel.json`'s headers (strict CSP), and the script picks Sep 20 in the day select.

| | Base (placeholder) | A: lines | B: small multiples | C: band + lines |
|---|---|---|---|---|
| JS, gzipped | 411.2 KB | 412.6 KB (+1.4) | **411.8 KB (+0.6)** | 412.2 KB (+1.0) |
| Pick a day → chart drawn (live, light / dark) | — | 3,526* / 952 ms | 949 / 940 ms | 980 / 963 ms |
| Open-Meteo requests (default day + picked day) | — | 4 | 4 | 4 |
| CSP violations | — | 0 | 0 | 0 |
| Focusable chart elements | — | 12 (5 models + 7 lead days) | 5 (one per model) | 12 |
| `ReplayChart.tsx` | — | 106 lines (96 code) | **70 lines (62 code)** | 99 lines (91 code) |

\* First request of the run (cold DNS/TLS to Open-Meteo); the times are dominated by the network, not the chart.

## Comparison (screenshots and readability)

| Criterion | A: lines | B: small multiples | C: band + lines |
|---|---|---|---|
| Can every model be read? | No: best match lies exactly on GFS (2–7 days ahead), and HRRR's single point sits under best match at 1 day | **Yes**, each model alone | No: same overlap as A, and the band hides the lines |
| Converging on the observed high | Visible, but crowded | Visible per model (the dashed line in every panel) | The band narrowing is the story, but here it doesn't narrow (GFS/best match stay high) |
| Comparing models at one lead | Best (same axes; lead-day tooltip) | Harder: compare across panels (same y-scale helps) | Good (tooltip with spread) |
| Labels | The right-edge labels collide with "obs 82.6°" | No collisions | "±" labels add noise; ±0.4 at 7 days is only 2 models |
| Identity without color | Shape + direct label + legend | Name in each panel title | Legend only (lines all look alike) |
| Accessibility | 12 tab stops, tooltip by keyboard | 5 tab stops, one sentence per model; native tooltips on points | Like A |
| Dark mode | OK | OK | The band's gray is weak on dark |
| Error handling | Same data path for all three: the panel handles loading, unavailable, sample and out-of-range; the chart only draws | Same | Same |
| Security | React text only; no HTML strings, no `window` hooks | Same | Same |

**Palette note.** The dashboard's model colors fail the dataviz validator:
- ECMWF purple vs GFS blue: ΔE 0.4 for deuteranopes, 12.4 normal-vision, below the floor of 15.
- Best match is gray.
- The colors are shared with the Forecast and Accuracy pages, so they weren't changed here. B names every model in
  its panel, so identity never depends on color.

## Decision: adopt B (small multiples)

- **Readable with real data:** best match duplicates GFS for 2–7 days in the US, so A and C always hide one line.
  Small multiples never overlap.
- **Smallest:** +0.6 KB, 62 lines of code, and no tooltip state.
- **What it gives up:** comparing models at one lead is harder. The insight line above the chart covers that
  ("ECMWF was off by 8.6°F seven days ahead and by 0.4°F one day ahead. Closest one day ahead: ICON (0.2°F off).").
- Combined after the merge: the 1-day miss in each panel title now has its unit (°F/°C).

## Security review (new pieces)

`/security-review` found no high-confidence issues. Checked: URL building, input validation, response validation,
XSS, links, CSP, dev scripts. Both low items were fixed:

- **Path guard in the local static servers:** `checkDemoBuild.mjs` and `shotReplay.mjs` accepted a sibling folder
  with the same prefix (`dist-old`). Both now use `scripts/insideDir.mjs` (folder + trailing separator), with tests.
- **Sample model ids:** the bundled sample's model ids, including the `missing` list, must be one of the five
  requested models, or the sample is rejected (tested).

CSP: `connect-src 'self' https://previous-runs-api.open-meteo.com https://archive-api.open-meteo.com` (exact hosts,
no wildcards) in `vercel.json`. `vite preview` serves the same policy, read from `vercel.json`. The dev server
applies only its `connect-src`, because the full policy would block Vite's inline HMR scripts.
