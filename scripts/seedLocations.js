// scripts/seedLocations.js
// Upsert the cities from src/locations/cities.js into `locations` and resolve each one's NWS grid point.
// Usage: npm run seed:locations [-- --refresh]   (--refresh re-resolves grid points that are already stored)

import { createRawStore } from "../src/adapters/rawStore/index.js";
import { COLLECTIONS, ensureCollections } from "../src/collections.js";
import { CITIES } from "../src/locations/cities.js";
import { nwsGet } from "../src/lib/http.js";

const refresh = process.argv.includes("--refresh");
const { name: LOCATIONS, uniqueKey } = COLLECTIONS.locations;

/** NWS /points gives the forecast office, grid cell, forecast URLs and zones for a lat/lon. */
async function resolveNwsPoint({ lat, lon }) {
  const { properties: p } = await nwsGet(`https://api.weather.gov/points/${lat},${lon}`);
  const zoneId = (url) => (url ? url.split("/").pop() : null);
  return {
    nws_office: p.gridId,
    grid_x: p.gridX,
    grid_y: p.gridY,
    nws_timezone: p.timeZone,   // cross-check only; `timezone` comes from cities.js
    nws_forecast_url: p.forecast,
    nws_forecast_hourly_url: p.forecastHourly,
    nws_forecast_zone: zoneId(p.forecastZone),
    nws_county: zoneId(p.county),
  };
}

const store = createRawStore();
try {
  await store.connect();
  await ensureCollections(store);

  const existing = new Map((await store.find(LOCATIONS)).map((doc) => [doc.id, doc]));
  const docs = [];
  const failed = [];

  for (const city of CITIES) {
    const known = existing.get(city.id);
    let grid;
    if (known?.nws_office && !refresh) {
      grid = null;   // keep stored grid fields; $set below only touches city fields
    } else {
      try {
        grid = await resolveNwsPoint(city);
      } catch (err) {
        failed.push(city.id);
        console.error(`[seed] ${city.id}: NWS /points failed - ${err.message}`);
        grid = {};
      }
    }
    const nwsZone = grid?.nws_timezone ?? known?.nws_timezone;
    if (nwsZone && nwsZone !== city.timezone) {
      console.warn(`[seed] ${city.id}: timezone ${city.timezone} differs from NWS ${nwsZone}`);
    }
    docs.push({ ...city, ...grid, updated_at: new Date() });
  }

  const result = await store.upsertMany(LOCATIONS, docs, uniqueKey);
  const rows = await store.find(LOCATIONS, {}, { sort: { region: 1, state: 1, name: 1 } });
  console.table(rows.map(({ id, region, nws_office, grid_x, grid_y, timezone }) =>
    ({ id, region, nws_office, grid: nws_office ? `${grid_x},${grid_y}` : null, timezone })));
  const noZone = rows.filter((r) => !r.timezone).map((r) => r.id);
  if (noZone.length) throw new Error(`locations without timezone: ${noZone.join(", ")}`);
  console.log(`[seed] ${rows.length} locations`, result, failed.length ? { failed } : "");
  if (failed.length) process.exitCode = 1;
} finally {
  await store.close();
}
