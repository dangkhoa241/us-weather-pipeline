# Setup: cloud collection of NWS data (GitHub Actions → MongoDB Atlas)

NWS forecasts and alerts can only be collected live. Two scheduled GitHub Actions workflows collect them into a free
MongoDB Atlas cluster, so no laptop has to stay on. When the laptop is on, the `fetcher` container copies the data into
local Mongo (`sync-atlas`). Everything here is free: Atlas M0 needs no credit card, and Actions minutes are free on
public repositories.

| Workflow | Schedule (UTC) | Writes |
|---|---|---|
| `NWS forecasts` (`.github/workflows/nws-forecasts.yml`) | every 3 h at minute 7 | `forecast_snapshots`, `pipeline_runs` |
| `NWS alerts` (`.github/workflows/nws-alerts.yml`) | every hour at minute 23 | `alerts`, `pipeline_runs` |

Atlas keeps 14 days of data (TTL indexes), so **sync at least once every 14 days**. The watcher warns after 7 days.

Takes about 15 minutes. Do the steps in order.

## 1. Create the free Atlas cluster

1. Sign up at <https://www.mongodb.com/cloud/atlas/register> (no credit card).
2. **Create** a cluster → choose **M0 (Free)**, provider **AWS**, region **us-east-1** (or any US region), name
   `weather`. Leave "Add sample data" unchecked.

## 2. Create a least-privilege database user

1. **Security → Database Access → Add New Database User**.
2. Authentication: **Password**. Username: `pipeline`. Click **Autogenerate Secure Password** and copy it somewhere safe
   (you need it in step 4; it is shown only once).
3. **Database User Privileges → Add Specific Privilege**: role **`readWrite`**, database **`weather`**.
   Don't pick "Atlas admin" or "Read and write to any database".
4. **Add User**.

## 3. Allow network access

GitHub's runners use changing IP addresses, so Atlas must accept connections from anywhere.

1. **Security → Network Access → Add IP Address → Allow Access from Anywhere** (`0.0.0.0/0`) → **Confirm**.

This is acceptable because the user from step 2 has a long random password, can only touch the `weather` database,
and Atlas always requires TLS. Never reuse this password anywhere else.

## 4. Build the connection string

1. **Database → Connect → Drivers** → copy the string. It looks like
   `mongodb+srv://pipeline:<db_password>@weather.abcde.mongodb.net/?retryWrites=true&w=majority&appName=weather`
2. Replace `<db_password>` with the password from step 2. If the password contains `@ : / ? # [ ] %`, URL-encode it
   (for example `@` → `%40`).
3. `mongodb+srv://` connections use TLS automatically; you don't need to add anything for it.

## 5. Make the repository public and push

Checked before publishing: no secrets in any commit (`.env` was never committed), and commits use your GitHub noreply
email.

1. Create an empty **public** repository on GitHub (no README, no .gitignore).
2. Push:
   ```bash
   git remote add origin https://github.com/<your-username>/us-weather-pipeline.git
   git push -u origin main
   ```

## 6. Add the secret and variable in GitHub

In the repository: **Settings → Secrets and variables → Actions**.

1. Tab **Secrets → New repository secret**: name `ATLAS_MONGO_URI`, value = the connection string from step 4.
2. Tab **Variables → New repository variable**: name `NWS_USER_AGENT`, value for example
   `us-weather-pipeline/1.0 (contact: https://github.com/<your-username>/us-weather-pipeline)`.
   NWS asks for a contact; the repository URL keeps your email out of public logs.

## 7. Test both workflows

1. **Actions** tab → if asked, click **I understand my workflows, go ahead and enable them**.
2. **NWS forecasts → Run workflow → Run workflow**. After ~1 minute the run should be green and its log should end
   with `[stage1:forecast] success`. The first run also seeds `locations`.
3. Do the same for **NWS alerts**.
4. In Atlas: **Database → Browse Collections → weather** should show `forecast_snapshots`, `alerts`, `locations` and
   `pipeline_runs`.

## 8. Connect your local setup

1. Add to your local `.env`:
   ```
   ATLAS_MONGO_URI=mongodb+srv://pipeline:<db_password>@<your-cluster-host>/?retryWrites=true&w=majority&appName=weather
   ```
2. Restart the watcher so it picks up the new setting: `docker compose up -d --build fetcher`.
3. Check: `docker compose logs fetcher | grep sync-atlas` should show documents copied. Or run it by hand any time:
   `npm run sync:atlas`.

## Keeping it running (and free)

- **60-day rule:** GitHub disables scheduled workflows in public repositories after 60 days without repository activity.
  Any push resets the clock; if it happens, re-enable them in the **Actions** tab.
- **Storage:** Atlas M0 has 512 MB. Expected use is about 250–330 MB at 14 days (20 cities). Check
  **Database → Metrics → Data Size** once in a while; if it passes ~400 MB, set `RAW_RETENTION_DAYS: "7"` in both
  workflow files.
- **Late runs:** GitHub can start scheduled runs 10–30+ minutes late, and occasionally skips one. That's accepted
  (see Known limitations in `docs/ROADMAP.md`).
- **Sync at least every 14 days.** After 7 days without a successful sync, the watcher logs a warning and records a
  `sync_stale` entry in `pipeline_runs`.
