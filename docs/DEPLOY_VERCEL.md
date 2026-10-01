# Deploy the dashboard demo to Vercel (static snapshot, free Hobby plan)

The public demo is the React dashboard built in **snapshot mode**: it reads JSON files exported from your local API
(`dashboard/public/data/`) instead of calling `/api`, and shows a "Demo data as of <date>" badge. No backend,
database or secret runs in the cloud. Local development keeps using the live API.

| | |
|---|---|
| Plan | Vercel Hobby: free, no credit card, **non-commercial personal use only** |
| Limits that matter | 100 GB Fast Data Transfer per month; 100 deployments per day; 45 min per build. Over the allowance, a Hobby project is paused, not billed |
| Our use | ~0.5 MB gzipped per visit (JS + snapshot): 100 GB ≈ 200,000 visits/month |
| Config | `dashboard/vercel.json`: build command, output directory, SPA rewrites, security headers (strict CSP), caching |

## 1. Refresh the snapshot (whenever you want newer demo data)

```bash
npm start                       # terminal 1: the local API (Docker running)
npm run export:snapshot         # terminal 2: writes dashboard/public/data/ (~750 KB, ~2 minutes)
cd dashboard && npm run build:snapshot && npm run check:demo   # optional: test the demo build locally
cd .. && npm run check:secrets && git add dashboard/public/data && git commit -m "Refresh demo snapshot" && git push
```

The export refuses to write files that contain hostnames, connection strings or pipeline run ids, and replaces the
previous snapshot, so the repository only ever holds one. Each push to `main` redeploys the demo.

## 2. Create the Vercel project (once, about 5 minutes)

1. Sign up at <https://vercel.com/signup> with **Continue with GitHub** (Hobby plan; no card needed).
2. **Add New… → Project → Import Git Repository** → pick `dangkhoa241/us-weather-pipeline`
   (allow Vercel's GitHub app access to this repository only).
3. In **Configure Project**:
   - **Root Directory:** click *Edit* and choose `dashboard`.
   - **Framework Preset:** Vite (detected). Leave **Build Command**, **Output Directory** and **Install Command**
     empty: `dashboard/vercel.json` sets them (`npm ci`, `npm run build:snapshot`, `dist`).
   - **Environment Variables:** none. (`npm run build:snapshot` builds in snapshot mode; see `dashboard/vite.config.ts`.)
4. Click **Deploy**. After ~1 minute you get `https://<project>.vercel.app`.

## 3. Check the settings (once)

In the project's **Settings**:

- **Build and Deployment → Root Directory:** `dashboard`, and keep **"Include files outside the root directory in
  the Build Step"** enabled. The dashboard imports the API schemas from `src/api/` in the repository root, so the build
  fails without it.
- **Build and Deployment → Node.js Version:** 22.x or newer.
- **Deployment Protection:** off for Production if the demo should be public (Vercel Authentication may protect
  preview deployments; that is fine).
- **Git → Ignored Build Step** (optional, saves builds): `git diff --quiet HEAD^ HEAD -- dashboard src/api` to skip
  deploys when only pipeline code changed.

## 4. Verify the live demo

1. Open the URL: the header shows **Demo data as of <date>**, the KPI cards and map have values.
2. Browser dev tools → **Network**: no request goes to `/api`; data comes from `/data/snapshot-…/…json`.
3. Dev tools → **Console**: no Content-Security-Policy errors.
4. Optional: check the headers at <https://securityheaders.com> (expected: CSP, X-Frame-Options, HSTS,
   X-Content-Type-Options, Referrer-Policy, Permissions-Policy).

## What the demo can't do

- Data is frozen at the snapshot date; date presets count back from that date.
- Forecast accuracy exists only for the preset ranges and their comparisons (a custom range shows "—").
- No API docs (`/docs`) and no live pipeline status: there is no backend in the deployment.
