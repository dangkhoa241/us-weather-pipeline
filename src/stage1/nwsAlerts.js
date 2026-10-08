// src/stage1/nwsAlerts.js
// Active NWS alerts for every state we track → `alerts` (upsert by NWS alert id).
// Each alert is linked to our locations through its affected forecast zones / counties.

import { COLLECTIONS } from "../collections.js";
import { nwsGet } from "../lib/http.js";
import { categoryOf, isUnmappedEvent } from "./alertCategories.js";

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
const isHeat = (d) => /heat/i.test(d.event ?? "");
const endOf = (d) => d.ends ?? d.expires ?? null;
const utcText = (date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

const isNewFor = (d, knownIds) => d.location_ids.length && !knownIds.has(d.id) && d.message_type !== "Cancel";

/** Heat alerts that affect a tracked city and weren't stored before (cancellations excluded). */
export const newHeatAlerts = (docs, knownIds) => docs.filter((d) => isHeat(d) && isNewFor(d, knownIds));

/** Alerts of an emailable category (src/stage1/alertCategories.js) that affect a tracked city and are new. */
export const newCategoryAlerts = (docs, knownIds) => docs.filter((d) => categoryOf(d.event) && isNewFor(d, knownIds));

// Severity first, then the product: a Watch → Warning with the same NWS severity is still an upgrade.
const SEVERITY_RANK = { Minor: 1, Moderate: 2, Severe: 3, Extreme: 4 };
const kindRank = (event) => (/warning/i.test(event) ? 3 : /advisory/i.test(event) ? 2 : /watch/i.test(event) ? 1 : 0);
const rank = (d) => (SEVERITY_RANK[d.severity] ?? 0) * 10 + kindRank(d.event ?? "");

/**
 * Which new alerts are worth an email, per city and group. NWS re-issues an alert about once a day with a new id (an
 * Update that references the earlier ones), mostly with nothing changed. Compared with the city's alerts of the same
 * group still in effect when the new one was sent: none → "New"; a higher severity or product → "Upgraded"; a later
 * end time → "Extended". Anything else (same or earlier end, same or lower level) is a re-issue: stored, not emailed.
 * `groupOf(alert)`: the group name, or null for alerts that are never emailed.
 * `prior`: stored alerts (cancellations are ignored). Returns [{ reason, until, alert, cities, category }] in send order.
 */
function groupChanges(fresh, prior, groupOf) {
  const seen = prior.filter((d) => groupOf(d) && d.message_type !== "Cancel");
  const changes = [];
  for (const d of [...fresh].sort((a, b) => (a.sent ?? 0) - (b.sent ?? 0))) {
    const group = groupOf(d);
    if (!group) continue;
    const byReason = new Map();
    for (const city of d.location_ids) {
      const active = seen.filter((p) => groupOf(p) === group && p.location_ids.includes(city) && (endOf(p) == null || !d.sent || endOf(p) > d.sent));
      const lastEnd = active.reduce((a, p) => (endOf(p) && (!a || endOf(p) > a) ? endOf(p) : a), null);
      const reason = !active.length ? "New"
        : rank(d) > Math.max(...active.map(rank)) ? "Upgraded"
        : endOf(d) && lastEnd && endOf(d) > lastEnd ? "Extended"
        : null;
      if (reason) byReason.set(reason, [...(byReason.get(reason) ?? []), city]);
    }
    for (const [reason, cities] of byReason) changes.push({ reason, until: endOf(d), alert: d, cities, category: group });
    seen.push(d);   // two alerts for one city in the same run: the second compares with the first
  }
  return changes;
}

/** Your private heat emails (unchanged rule): every event with "heat" in its name is one group. */
export const heatChanges = (fresh, prior) => groupChanges(fresh, prior, (d) => (isHeat(d) ? "heat" : null));

/** Public emails: one group per alert category (heat, flood, …); "other" events never count. */
export const categoryChanges = (fresh, prior) => groupChanges(fresh, prior, (d) => categoryOf(d.event));

/** One notification for all heat changes of a run (keeps email volume low); each line says why it was sent. */
export function heatAlertEvent(changes) {
  const label = (c) => (c.reason === "Extended" ? `Extended to ${c.until ? utcText(c.until) : "a later time"}` : c.reason);
  const until = (c) => (c.reason !== "Extended" && c.until ? ` until ${utcText(c.until)}` : "");
  const lines = changes.slice(0, MAX_LISTED).map((c) => `- ${label(c)}: ${c.alert.event} (${c.alert.severity ?? "unknown severity"}): ${c.cities.join(", ")}${until(c)}`);
  if (changes.length > MAX_LISTED) lines.push(`- … and ${changes.length - MAX_LISTED} more`);
  const reasons = [...new Set(changes.map((c) => c.reason.toLowerCase()))].join(", ");
  return {
    level: "warn",
    title: `Heat alert: ${changes.length} ${changes.length === 1 ? "change" : "changes"} for tracked cities (${reasons})`,
    message: lines.join("\n"),
  };
}

/**
 * @param publicAlerts optional `(changes, locations) => Promise` (src/stage1/publicAlerts.js): public subscriber emails.
 *   Only the Lambda passes it; local runs never email subscribers.
 */
export async function fetchAlerts(store, locations, run, notifier, publicAlerts = null) {
  const states = [...new Set(locations.map((l) => l.state))].sort();
  const locationsByZone = new Map();
  for (const l of locations) {
    for (const zone of [l.nws_forecast_zone, l.nws_county].filter(Boolean)) {
      locationsByZone.set(zone, [...(locationsByZone.get(zone) ?? []), l.id]);
    }
  }

  try {
    const fetchedAt = new Date();
    const url = `${ACTIVE_URL}?${new URLSearchParams({ area: states.join(",") })}`;
    const data = await nwsGet(url);
    store.addRawResponse("nws-alerts", url, data);
    const sourceTimestamp = toDate(data.updated) ?? fetchedAt;
    const meta = { etl_batch_id: run.etlBatchId, source_timestamp: sourceTimestamp, fetched_at: fetchedAt };
    const docs = (data.features ?? []).map((f) => toAlert(f, locationsByZone, meta));
    // Emailable alerts for tracked cities (heat; with public alerts also every category), compared with what was stored
    // before this run (read before the upsert): the cities' alerts that could still be in effect when the earliest
    // new one was sent.
    const emailable = (d) => isHeat(d) || (publicAlerts && categoryOf(d.event));
    const candidates = docs.filter((d) => emailable(d) && isNewFor(d, new Set()));
    let prior = [];
    if (candidates.length) {
      const since = new Date(Math.min(...candidates.map((d) => (d.sent ?? fetchedAt).getTime())));
      const open = { $or: [{ ends: { $gt: since } }, { ends: null, expires: { $gt: since } }, { ends: null, expires: null }] };
      prior = (await store.find(ALERTS.name, { location_ids: { $in: [...new Set(candidates.flatMap((d) => d.location_ids))] }, ...open },
        { projection: { _id: 0, id: 1, event: 1, severity: 1, message_type: 1, location_ids: 1, sent: 1, ends: 1, expires: 1 } })).filter(emailable);
    }
    const result = docs.length ? await store.upsertMany(ALERTS.name, docs, ALERTS.uniqueKey) : {};
    const knownIds = new Set(prior.map((d) => d.id));
    const changes = heatChanges(newHeatAlerts(docs, knownIds), prior);
    if (changes.length && notifier) await notifier.notify(heatAlertEvent(changes));
    if (publicAlerts) {
      // Public subscriber emails never break the run (and never reach the private notifier's text path).
      try {
        await publicAlerts(categoryChanges(newCategoryAlerts(docs, knownIds), prior), locations);
      } catch (err) {
        console.error(`[alerts:public] failed (${err?.name ?? "Error"}): ${err?.message ?? err}`);
      }
    }
    run.add(docs.length, result);
    const forOurCities = docs.filter((d) => d.location_ids.length);
    console.log(`[alerts] ${docs.length} active alerts in ${states.length} states, ${forOurCities.length} affect tracked cities`, result);
    for (const d of forOurCities) console.log(`  - ${d.event} (${d.severity}) → ${d.location_ids.join(", ")}`);
    for (const event of new Set(forOurCities.map((d) => d.event).filter(isUnmappedEvent))) console.log(`[alerts] unmapped event: ${event}`);
  } catch (err) {
    run.error(null, err);
  }
}
