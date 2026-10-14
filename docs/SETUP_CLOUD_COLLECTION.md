# Cloud collection of NWS data: MongoDB Atlas (GitHub Actions as a manual fallback)

Rebuild guide: how to deploy this part of the project from scratch. For how it works and why, see [docs/architecture/nws-collector.md](architecture/nws-collector.md).

## Objective

Set up the free MongoDB Atlas cluster that buffers NWS forecasts and alerts for 7 days, the two GitHub Actions
workflows that can write to it, and the local connection that copies the data home.

Since Stage 6a part 3 (2026-10-02), the AWS collector Lambda (EventBridge, hourly + every 3 h) collects NWS data into
Atlas ([SETUP_AWS.md](SETUP_AWS.md), step 10). The two workflows no longer run on a schedule: they are
`workflow_dispatch` only, a manual fallback. The Atlas set-up in this guide is still what the Lambda uses.

| Workflow | Schedule (UTC) before the Lambda took over | Writes |
|---|---|---|
| `NWS forecasts` (`.github/workflows/nws-forecasts.yml`) | every 3 h at minute 7 | `forecast_snapshots`, `pipeline_runs` |
| `NWS alerts` (`.github/workflows/nws-alerts.yml`) | every hour at minute 23 | `alerts`, `pipeline_runs` |

When the laptop is on, the `fetcher` container copies the data into the local MongoDB (`sync-atlas`). Atlas keeps
7 days of data (TTL indexes), so a sync is needed at least once every 7 days; the watcher warns after 4 days.

## Prerequisites

- A MongoDB Atlas account: M0 is free and needs no credit card.
- A **public** GitHub repository (Actions minutes are free on public repositories).
- The local Docker stack from the README ("Run it locally").
- About 15 minutes. Do the steps in order.

## Procedure

### Step 1. Create the free Atlas cluster

1. Sign up at <https://www.mongodb.com/cloud/atlas/register> (no credit card).
2. **Create** a cluster → choose **M0 (Free)**, provider **AWS**, region **us-east-1** (or any US region), name
   `weather`. Leave "Add sample data" unchecked.

### Step 2. Create a least-privilege database user

1. **Security → Database Access → Add New Database User**.
2. Authentication: **Password**. Username: `pipeline`. Choose **Autogenerate Secure Password** and store the password
   in a password manager (step 4 needs it; it is shown only once).
3. **Database User Privileges → Add Specific Privilege**: role **`readWrite`**, database **`weather`**.
   Don't pick "Atlas admin" or "Read and write to any database".
4. **Add User**.

### Step 3. Allow network access

GitHub's runners and AWS Lambda use changing IP addresses, so Atlas must accept connections from anywhere.

1. **Security → Network Access → Add IP Address → Allow Access from Anywhere** (`0.0.0.0/0`) → **Confirm**.

This is acceptable because the user from step 2 has a long random password, can only touch the `weather` database,
and Atlas always requires TLS. Never reuse this password anywhere else.

### Step 4. Build the connection string

1. **Database → Connect → Drivers** → copy the string. It looks like
   `mongodb+srv://pipeline:<db_password>@weather.abcde.mongodb.net/?retryWrites=true&w=majority&appName=weather`
2. Replace `<db_password>` with the password from step 2. If the password contains `@ : / ? # [ ] %`, URL-encode it
   (for example `@` → `%40`).
3. `mongodb+srv://` connections use TLS automatically; nothing needs to be added for it.

### Step 5. Make the repository public and push

Checked before the repository was published: no secrets in any commit (`.env` was never committed), and commits use
the GitHub noreply email. `npm run check:secrets` checks both.

1. Create an empty **public** repository on GitHub (no README, no .gitignore).
2. Push:
   ```bash
   git remote add origin https://github.com/<your-username>/us-weather-pipeline.git
   git push -u origin main
   ```

### Step 6. Add the secret and variable in GitHub

In the repository: **Settings → Secrets and variables → Actions**.

1. Tab **Secrets → New repository secret**: name `ATLAS_MONGO_URI`, value = the connection string from step 4.
2. Tab **Variables → New repository variable**: name `NWS_USER_AGENT`, value for example
   `us-weather-pipeline/1.0 (contact: https://github.com/<your-username>/us-weather-pipeline)`.
   NWS asks for a contact; the repository URL keeps an email address out of public logs.

The Lambda reads the same connection string from SSM instead (`/weather-pipeline/atlas-mongo-uri`,
[SETUP_AWS.md](SETUP_AWS.md) step 10).

### Step 7. Enable and run both workflows

1. **Actions** tab → if asked, choose **I understand my workflows, go ahead and enable them**.
2. **NWS forecasts → Run workflow → Run workflow**. The first run also seeds `locations`.
3. Do the same for **NWS alerts**.

### Step 8. Connect the local stack

1. Add to the local `.env`:
   ```
   ATLAS_MONGO_URI=mongodb+srv://pipeline:<db_password>@<your-cluster-host>/?retryWrites=true&w=majority&appName=weather
   ```
2. Restart the watcher so it picks up the new setting: `docker compose up -d --build fetcher`.

## Verification

- **Workflows (step 7):** after ~1 minute each run is green, and the forecasts log ends with `[stage1:forecast] success`.
- **Atlas:** **Database → Browse Collections → weather** shows `forecast_snapshots`, `alerts`, `locations` and
  `pipeline_runs`.
- **Local sync (step 8):** `docker compose logs fetcher | grep sync-atlas` shows documents copied. `npm run sync:atlas`
  runs the same copy on demand.
- **Storage:** **Database → Metrics → Data Size** in Atlas stays below ~430 MB (see Troubleshooting).

## Rollback

There is no rollback beyond removing what was created:
- delete the `ATLAS_MONGO_URI` line from `.env` (the `sync-atlas` mode then skips with "ATLAS_MONGO_URI not set");
- delete the `ATLAS_MONGO_URI` secret and the `NWS_USER_AGENT` variable in GitHub;
- delete the Atlas cluster (its data is gone; anything already synced stays in the local MongoDB).

The AWS collector Lambda depends on this cluster: removing it breaks NWS collection until the Lambda is pointed at a new
cluster (SSM parameter, [SETUP_AWS.md](SETUP_AWS.md) step 10) or the stack is torn down.

## Troubleshooting

- **Laptop off for more than 7 days.** Atlas deletes documents after 7 days, so unsynced NWS data is lost. After
  4 days without a successful sync, the watcher logs a warning, emails it through the notifier and records a
  `sync_stale` entry in `pipeline_runs`.
- **Atlas storage.** M0 has 512 MB. With 53 cities, NWS adds ~48 MB a day (9,010 snapshots of ~660 bytes per run,
  8 runs), so 7 days are ~335 MB of data, ~370 MB with indexes and alerts. If **Data Size** passes ~430 MB, lower the
  retention to 5 days: `RAW_RETENTION_DAYS: "5"` in `infra/template.yaml` (collector Lambda) and in both workflow
  files, and `SYNC_WARN_DAYS=3` locally.
- **Workflows disabled after 60 days.** GitHub disables scheduled workflows in public repositories after 60 days
  without repository activity. This only matters if a `schedule:` block is restored; any push resets the clock, and
  disabled workflows can be re-enabled in the **Actions** tab.
- **Late or skipped scheduled runs.** GitHub can start scheduled runs 10–30+ minutes late, and occasionally skips one.
  This is why the Lambda replaced the schedules (see Known limitations in [ROADMAP.md](ROADMAP.md)).
- **Connection string rejected.** Check that special characters in the password are URL-encoded (step 4).
