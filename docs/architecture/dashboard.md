# Dashboard: React on Vercel, bundled snapshot plus live overlay

Rebuild steps: [DEPLOY_VERCEL.md](../DEPLOY_VERCEL.md).

## Purpose

The public site. It ships a data snapshot exported from the local API at each redeploy, and lays the live files from
CloudFront over it, so it shows current forecasts and alerts while the local stack is off, and still works if live
data is down.

## Requirements

- Static hosting on a free plan; no backend, database or secret in the deployment.
- Work without the live files (bundled fallback), and say which data is live and which is a snapshot.
- A strict Content-Security-Policy with no `eval`.
- Keyboard-accessible map and charts, and a small bundle.

## Design

- **Stack.** React + TypeScript + Vite, TanStack Query, Zustand (filters synced to the URL), Tailwind CSS + shadcn/ui.
  The map uses d3-geo and the drill-down charts d3-scale/d3-shape; ECharts only draws the small sparklines.
- **Snapshot build.** `npm run build:snapshot` (`vite build --mode snapshot`) makes the app read
  `dashboard/public/data/` instead of `/api`. `npm run export:snapshot` writes that folder from the local API: a
  versioned `snapshot-<…>/` folder plus `manifest.json`, replacing the previous snapshot, and fails above 5 MB.
  `npm run refresh:snapshot` chains the whole refresh (pipeline, API, export, status, build, demo checks) and never
  commits.
- **Live overlay.** The app loads the bundled snapshot first, then fetches each live file from CloudFront with a 4 s
  timeout and validates it with Zod. The last 60 days of `recent.json` replace the bundled daily files; forecasts,
  alerts and status come from their live files. Each page says whether it shows live data or the snapshot.
- **Data per page.** Overview and City: bundled history with the live 60-day overlay. Accuracy: snapshot only (scoring
  needs the local ClickHouse history). Forecast: live. Ops: live `status.json`. Replay: the browser calls Open-Meteo
  directly, with a bundled 3-city sample as fallback. How it works: the diagram ships with the site; its "last run"
  badges come from live `status.json`.
- **Hosting.** Vercel Hobby; `dashboard/vercel.json` sets the build command, the output directory, SPA rewrites,
  security headers and caching (snapshot folders and assets `immutable`, `manifest.json` revalidated).

## Alternatives considered

- Static files instead of a live API: [decision 6](../DESIGN_DECISIONS.md#6-the-public-site-reads-static-json-from-s3--cloudfront-not-a-live-api).
- Hand-rolled d3 instead of ECharts, react-simple-maps or Recharts:
  [decision 7](../DESIGN_DECISIONS.md#7-hand-rolled-d3-for-the-map-and-charts).
- Ranking forecast models only after 30 days of scores:
  [decision 10](../DESIGN_DECISIONS.md#10-rank-a-forecast-model-only-after-30-days-of-scores).

## Failure handling

- A live file that fails, times out or does not validate is ignored, and the bundled copy is shown with a
  "Snapshot" label. Each live file falls back on its own.
- The Ops page shows a stale warning when the live `status.json` is more than 6 hours old.
- The forecast replay shows "Live data unavailable" and the bundled sample when Open-Meteo answers 429 or fails.
- `npm run check:demo` serves the build the way Vercel does (headers and rewrites from `vercel.json`), blocks the live
  host, and checks the fallback in headless Chromium.

## Security

- **CSP** (`dashboard/vercel.json`): `default-src 'self'`; scripts only from `'self'` and Cloudflare Turnstile;
  `connect-src` lists exact hosts only (two Open-Meteo hosts, the CloudFront host, the sign-up Function URL);
  `object-src 'none'`, `frame-ancestors 'none'`, `form-action 'none'`. Zod runs "jitless", so no `eval` is needed.
  `style-src 'unsafe-inline'` is kept for inline `style` attributes on SVG charts (README, Security).
- **Other headers:** `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy`, HSTS.
- **No HTML from data:** React escapes everything; nothing uses `dangerouslySetInnerHTML`.
- **Public-safe data:** the snapshot export refuses files that contain hostnames, connection strings or run ids, and
  a test scans the How it works data file for account IDs, ARNs, resource names and hosts.

## Numbers

| Number | Source |
|---|---|
| Snapshot 3,768 KB (665 KB gzipped) for 53 cities × 3.77 years, data through 2026-10-09 | [README.md](../../README.md), "By the numbers" |
| ~0.5 MB gzipped per visit; Vercel Hobby allows 100 GB a month (≈ 200,000 visits) | [DEPLOY_VERCEL.md](../DEPLOY_VERCEL.md), [ROADMAP.md](../ROADMAP.md) free-tier table |
| 27 checks on the demo build (one: no page scrolls sideways at 360 px), 0 CSP violations | [ROADMAP.md](../ROADMAP.md), "Resume numbers" |
| Map +47 KB gzipped; drill-down chart +10 KB | [DESIGN_DECISIONS.md](../DESIGN_DECISIONS.md), decision 7 |
| Live fetch timeout 4 s | `dashboard/src/lib/snapshot.ts` (`LIVE_TIMEOUT_MS`) |

## Where in the code

| What | File |
|---|---|
| Snapshot and live data loading | `dashboard/src/lib/snapshot.ts` |
| Pages | `dashboard/src/pages/` |
| Build modes, live and sign-up URLs | `dashboard/vite.config.ts` |
| Hosting, headers, CSP | `dashboard/vercel.json` |
| Snapshot export and refresh | `scripts/exportSnapshot.js`, `scripts/exportStatus.js`, `scripts/refreshSnapshot.js` |
| Demo build checks | `dashboard/scripts/checkDemoBuild.mjs` |
