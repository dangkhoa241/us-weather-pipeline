// src/stage1/nwsAlerts.js
// Active NWS alerts for every state we track → `alerts` (upsert by NWS alert id).
// Each alert is linked to our locations through its affected forecast zones / counties.

import { COLLECTIONS } from "../collections.js";
import { nwsGet } from "../lib/http.js";

const ALERTS = COLLECTIONS.alerts;
const ACTIVE_URL = "https://api.weather.gov/alerts/active";

const toDate = (value) => (value ? new Date(value) : null);
const zoneId = (url) => url.split("/").pop();

function toAlert(feature, locationsByZone, meta) {
  const p = feature.properties;
  const zones = (p.affectedZones ?? []).map(zoneId);
  const ugc = p.geocode?.UGC ?? zones;
  const locationIds = [...new Set(zones.flatMap((z) => locationsByZone.get(z) ?? []))];
  return {
    id: p.id ?? feature.id,
    event: p.event,
    headline: p.headline ?? null,
    severity: p.severity ?? null,
    urgency: p.urgency ?? null,
    certainty: p.certainty ?? null,
    status: p.status ?? null,
    message_type: p.messageType ?? null,
    sender_name: p.senderName ?? null,
    area_desc: p.areaDesc ?? null,
    states: [...new Set(ugc.map((code) => code.slice(0, 2)))].sort(),
    zones,
    location_ids: locationIds,
    sent: toDate(p.sent),
    effective: toDate(p.effective),
    onset: toDate(p.onset),
    expires: toDate(p.expires),
    ends: toDate(p.ends),
    description: p.description ?? null,
    instruction: p.instruction ?? null,
    last_seen_at: meta.fetched_at,
    ...meta,
  };
}

export async function fetchAlerts(store, locations, run) {
  const states = [...new Set(locations.map((l) => l.state))].sort();
  const locationsByZone = new Map();
  for (const l of locations) {
    for (const zone of [l.nws_forecast_zone, l.nws_county].filter(Boolean)) {
      locationsByZone.set(zone, [...(locationsByZone.get(zone) ?? []), l.id]);
    }
  }

  try {
    const fetchedAt = new Date();
    const data = await nwsGet(`${ACTIVE_URL}?${new URLSearchParams({ area: states.join(",") })}`);
    const sourceTimestamp = toDate(data.updated) ?? fetchedAt;
    const meta = { etl_batch_id: run.etlBatchId, source_timestamp: sourceTimestamp, fetched_at: fetchedAt };
    const docs = (data.features ?? []).map((f) => toAlert(f, locationsByZone, meta));
    const result = docs.length ? await store.upsertMany(ALERTS.name, docs, ALERTS.uniqueKey) : {};
    run.add(docs.length, result);
    const forOurCities = docs.filter((d) => d.location_ids.length);
    console.log(`[alerts] ${docs.length} active alerts in ${states.length} states, ${forOurCities.length} affect tracked cities`, result);
    for (const d of forOurCities) console.log(`  - ${d.event} (${d.severity}) → ${d.location_ids.join(", ")}`);
  } catch (err) {
    run.error(null, err);
  }
}
