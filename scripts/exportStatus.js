// scripts/exportStatus.js
// Bundled fallback for the dashboard's Ops page: dashboard/public/data/status.json, built like the publisher's live
// status.json (src/publish/opsStatus.js) from the last 7 days of pipeline_runs. Reads Atlas when ATLAS_MONGO_URI is set
// (the Lambdas' runs), else the local store. Freshness is the bundled snapshot's, since that is what the dashboard
// shows when CloudFront is unreachable.
// Usage: npm run export:status (after npm run export:snapshot)

import { readFileSync, writeFileSync } from "node:fs";
import { config } from "../src/config.js";
import { COLLECTIONS } from "../src/collections.js";
import { createRawStore } from "../src/adapters/rawStore/index.js";
import { buildOpsStatus } from "../src/lambda/dashboardPublisher.js";
import { publicStatusJson } from "../src/publish/opsStatus.js";

const OUT = new URL("../dashboard/public/data/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", OUT), "utf8"));
const forecasts = JSON.parse(readFileSync(new URL(`${manifest.snapshot}/forecasts.json`, OUT), "utf8"));
const nwsIssued = Object.values(forecasts).map((m) => m.nws?.issued_at).filter(Boolean).sort().at(-1);

const store = config.atlas.uri ? createRawStore(undefined, { uri: config.atlas.uri, db: config.atlas.db }) : createRawStore();
try {
  await store.connect();
  const locations = await store.find(COLLECTIONS.locations.name, {}, { sort: { id: 1 } });
  const status = await buildOpsStatus(store, locations, {
    now: new Date(),
    freshness: { historyThrough: manifest.data_as_of, forecastUpdatedAt: nwsIssued ? `${nwsIssued.replace(" ", "T")}Z` : null },
  });
  const text = publicStatusJson(status);   // whitelist + leak check: throws instead of writing anything internal
  writeFileSync(new URL("status.json", OUT), text);
  console.log(`[status] dashboard/public/data/status.json: ${status.jobs.map((j) => `${j.id} ${j.lastStatus ?? "no run"}`).join(", ")}; `
    + `${status.incidents.length} incident(s), ${(text.length / 1024).toFixed(1)} KB (${config.atlas.uri ? "Atlas" : "local store"})`);
} finally {
  await store.close();
}
