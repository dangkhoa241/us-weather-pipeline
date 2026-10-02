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

const MAX_LISTED = 10;

/** Heat alerts that affect a tracked city and weren't stored before (cancellations excluded). */
export const newHeatAlerts = (docs, knownIds) =>
  docs.filter((d) => /heat/i.test(d.event ?? "") && d.location_ids.length && !knownIds.has(d.id) && d.message_type !== "Cancel");

/** One notification for all new heat alerts of a run (keeps email volume low). */
export function heatAlertEvent(alerts) {
  const until = (d) => (d.ends ?? d.expires) ? ` until ${(d.ends ?? d.expires).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
  const lines = alerts.slice(0, MAX_LISTED).map((d) => `- ${d.event} (${d.severity ?? "unknown severity"}): ${d.location_ids.join(", ")}${until(d)}`);
  if (alerts.length > MAX_LISTED) lines.push(`- … and ${alerts.length - MAX_LISTED} more`);
  return {
    level: "warn",
    title: `Heat alert: ${alerts.length} new NWS ${alerts.length === 1 ? "alert" : "alerts"} for tracked cities`,
    message: lines.join("\n"),
  };
}

export async function fetchAlerts(store, locations, run, notifier) {
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
    // Which heat alerts are new? Checked before the upsert (only the few heat candidates, by id).
    const candidates = newHeatAlerts(docs, new Set());
    const known = new Set();
    for (const d of candidates) if (await store.findOne(ALERTS.name, { id: d.id }, { projection: { id: 1 } })) known.add(d.id);
    const result = docs.length ? await store.upsertMany(ALERTS.name, docs, ALERTS.uniqueKey) : {};
    const heat = newHeatAlerts(docs, known);
    if (heat.length && notifier) await notifier.notify(heatAlertEvent(heat));
    run.add(docs.length, result);
    const forOurCities = docs.filter((d) => d.location_ids.length);
    console.log(`[alerts] ${docs.length} active alerts in ${states.length} states, ${forOurCities.length} affect tracked cities`, result);
    for (const d of forOurCities) console.log(`  - ${d.event} (${d.severity}) → ${d.location_ids.join(", ")}`);
  } catch (err) {
    run.error(null, err);
  }
}
