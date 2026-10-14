# Deploy the dashboard to Vercel (static snapshot, free Hobby plan)

Rebuild guide: how to deploy this part of the project from scratch. For how it works and why, see [docs/architecture/dashboard.md](architecture/dashboard.md).

## Objective

Host the React dashboard on Vercel, built in **snapshot mode**: it reads JSON files exported from the local API
(`dashboard/public/data/`) instead of calling `/api`. No backend, database or secret runs on Vercel; local development
keeps using the live API. Once the AWS live files are deployed ([SETUP_AWS.md](SETUP_AWS.md), step 11), the site lays
them over the bundled snapshot, and its header shows **Live · …** or **Snapshot · …**.

| | |
|---|---|
| Plan | Vercel Hobby: free, no credit card, **non-commercial personal use only** |
| Limits that matter | 100 GB Fast Data Transfer per month; 100 deployments per day; 45 min per build. Over the allowance, a Hobby project is paused, not billed |
| Our use | ~0.5 MB gzipped per visit (JS + snapshot): 100 GB ≈ 200,000 visits/month |
| Config | `dashboard/vercel.json`: build command, output directory, SPA rewrites, security headers (strict CSP), caching |

Limits of the deployment:
- Forecast accuracy is frozen at the snapshot date, and exists only for the preset ranges and their comparisons
  (a custom range shows "—"). Date presets count back from the snapshot date.
- History beyond the live 60 days, and every page when the live files are unreachable, come from the snapshot.
- No API docs (`/docs`): there is no backend in the deployment.

## Prerequisites

- A GitHub account with the public repository `dangkhoa241/us-weather-pipeline`.
- The local stack running (Docker, `npm start`) to export a snapshot.
- Node.js 22.x or newer (the Vercel build uses the same).

## Procedure

### Step 1. Refresh the snapshot (whenever newer data should ship)

One command runs the whole refresh: the pipeline catch-up, the API, `export:snapshot`, `export:status`,
`build:snapshot` and `check:demo`. It never commits or pushes:

```bash
npm run refresh:snapshot
```

The same steps by hand:

```bash
npm start                       # terminal 1: the local API (Docker running)
npm run export:snapshot         # terminal 2: writes dashboard/public/data/ (~2 minutes)
cd dashboard && npm run build:snapshot && npm run check:demo   # test the demo build locally
```

Then review the diff and publish it:

```bash
npm run check:secrets && git add dashboard/public/data && git commit -m "Refresh demo snapshot" && git push
```

The snapshot is 3,768 KB (665 KB gzipped) as of 2026-10-09 (README, "By the numbers"). The export refuses to write files that contain hostnames, connection strings or pipeline run ids, and replaces the
previous snapshot, so the repository only ever holds one. Each push to `main` redeploys the site.

### Step 2. Create the Vercel project (once, about 5 minutes)

1. Sign up at <https://vercel.com/signup> with **Continue with GitHub** (Hobby plan; no card needed).
2. **Add New… → Project → Import Git Repository** → pick `dangkhoa241/us-weather-pipeline`
   (allow Vercel's GitHub app access to this repository only).
3. In **Configure Project**:
   - **Root Directory:** choose *Edit* and select `dashboard`.
   - **Framework Preset:** Vite (detected). Leave **Build Command**, **Output Directory** and **Install Command**
     empty: `dashboard/vercel.json` sets them (`npm ci`, `npm run build:snapshot`, `dist`).
   - **Environment Variables:** none. (`npm run build:snapshot` builds in snapshot mode; see `dashboard/vite.config.ts`.)
4. Choose **Deploy**. After ~1 minute the site is at `https://<project>.vercel.app`.

### Step 3. Check the project settings (once)

In the project's **Settings**:

- **Build and Deployment → Root Directory:** `dashboard`, and keep **"Include files outside the root directory in
  the Build Step"** enabled. The dashboard imports the API schemas from `src/api/` in the repository root, so the build
  fails without it.
- **Build and Deployment → Node.js Version:** 22.x or newer.
- **Deployment Protection:** off for Production so the site is public (Vercel Authentication may protect preview
  deployments; that is fine).
- **Git → Ignored Build Step** (optional, saves builds): `git diff --quiet HEAD^ HEAD -- dashboard src/api` skips
  deploys when only pipeline code changed.

## Verification

1. Open the URL: the header shows **Live · history through …** (or **Snapshot · history through …** when the live
   files are unreachable), and the KPI cards and map have values.
2. Browser dev tools → **Network**: no request goes to `/api`; bundled data comes from `/data/snapshot-…/…json`, live
   files from the CloudFront host.
3. Dev tools → **Console**: no Content-Security-Policy errors.
4. Optional: check the headers at <https://securityheaders.com> (expected: CSP, X-Frame-Options, HSTS,
   X-Content-Type-Options, Referrer-Policy, Permissions-Policy).

`npm run check:demo` (step 1) runs the same kind of checks locally against the build, with the live host blocked.

## Rollback

- **A bad deploy or snapshot:** revert the commit and push; each push to `main` redeploys the site.
- **Remove the site:** delete the Vercel project in its settings. Nothing else depends on it; the AWS live files and
  the local stack keep working (CloudFront CORS still names the old origin until `DashboardOrigin` is changed).

## Troubleshooting

- **Build fails with missing files from `src/api/`:** "Include files outside the root directory in the Build Step"
  is off (step 3).
- **CSP errors in the console after a new live host:** the host must be in `connect-src` in `dashboard/vercel.json`
  (the CloudFront host and the sign-up Function URL are listed there; see [SETUP_AWS.md](SETUP_AWS.md), steps 11 and 12).
- **The header always says Snapshot:** the live files are unreachable or failed validation; check them with the
  Part 4 verification in [SETUP_AWS.md](SETUP_AWS.md#part-4-live-dashboard-data).
- **The export fails on size:** `export:snapshot` stops above 5 MB in total (`MAX_TOTAL_KB` in
  `scripts/exportSnapshot.js`).
