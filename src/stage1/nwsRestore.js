// src/stage1/nwsRestore.js
// Restore NWS forecasts and alerts from the S3 raw archive (30-day lifecycle) into the raw store, for windows that
// never reached local MongoDB (e.g. the laptop was off longer than Atlas's 7-day TTL).
// Documents are rebuilt with the collector's own transforms (toSnapshot, toAlert) and written insert-only by their
// natural keys: what is already stored is never changed, so running a restore twice changes nothing.

import { COLLECTIONS } from "../collections.js";
import { KINDS, toSnapshot } from "./nwsForecast.js";
import { locationsByZone, toAlert } from "./nwsAlerts.js";

const SNAPSHOTS = COLLECTIONS.forecastSnapshots;
const ALERTS = COLLECTIONS.alerts;
export const RESTORED_FROM = "s3-archive";
export const SOURCES = { forecast: "nws-forecast", alerts: "nws-alerts" };

const day = (date) => date.toISOString().slice(0, 10);
const withoutQuery = (url) => String(url).split("?")[0];

/** NWS forecast URL (without query) → { location, kind }, from the locations' resolved grid URLs. */
export function forecastUrlIndex(locations) {
  const index = new Map();
  for (const location of locations) {
    for (const [kind, field] of Object.entries(KINDS)) {
      if (location[field]) index.set(withoutQuery(location[field]), { location, kind });
    }
  }
  return index;
}

/**
 * Several fetches of one record (same natural key) → one document, as the live upserts would have left it: the
 * latest fetch's fields, `first_seen_at` from the earliest fetch.
 */
export function mergeByKey(docs, keyFields) {
  const byKey = new Map();
  for (const doc of docs) {
    const key = keyFields.map((k) => (doc[k] instanceof Date ? doc[k].getTime() : doc[k])).join("|");
    const prev = byKey.get(key);
    const firstSeen = prev && prev.first_seen_at < doc.fetched_at ? prev.first_seen_at : doc.fetched_at;
    byKey.set(key, !prev || doc.fetched_at >= prev.fetched_at ? { ...doc, first_seen_at: firstSeen } : { ...prev, first_seen_at: firstSeen });
  }
  return [...byKey.values()];
}

/** forecast_snapshots documents from archived nws-forecast responses ([{ url, fetched_at, body }]). */
export function forecastDocs(lines, urlIndex, batchId) {
  const docs = [];
  const unknownUrls = new Set();
  for (const { url, fetched_at: fetchedAt, body } of lines) {
    const hit = urlIndex.get(withoutQuery(url));
    const p = body?.properties;
    if (!hit || !p) {
      unknownUrls.add(withoutQuery(url));
      continue;
    }
    // Same fields as fetchForecasts() in nwsForecast.js, plus where the document came from.
    const issuedAt = new Date(p.updateTime ?? p.generatedAt);
    const generatedAt = p.generatedAt ? new Date(p.generatedAt) : null;
    const meta = { etl_batch_id: batchId, source_timestamp: generatedAt ?? issuedAt, fetched_at: fetchedAt, restored_from: RESTORED_FROM };
    for (const period of p.periods ?? []) docs.push(toSnapshot(hit.location, hit.kind, issuedAt, generatedAt, period, meta));
  }
  return { docs, unknownUrls: [...unknownUrls] };
}

/** alerts documents from archived nws-alerts responses (one /alerts/active answer per line). */
export function alertDocs(lines, byZone, batchId) {
  const docs = [];
  for (const { fetched_at: fetchedAt, body } of lines) {
    const sourceTimestamp = body?.updated ? new Date(body.updated) : fetchedAt;
    const meta = { etl_batch_id: batchId, source_timestamp: sourceTimestamp, fetched_at: fetchedAt, restored_from: RESTORED_FROM };
    for (const feature of body?.features ?? []) docs.push(toAlert(feature, byZone, meta));
  }
  return docs;
}

/** The documents of `docs` whose natural key is not in the store yet (read-only). */
export async function missingDocs(store, collection, docs) {
  if (collection === SNAPSHOTS.name) {
    // All periods of one response share (location, kind, issued_at): one indexed query per response.
    const groups = new Map();
    for (const d of docs) {
      const key = `${d.location_id}|${d.kind}|${d.issued_at.getTime()}`;
      groups.set(key, [...(groups.get(key) ?? []), d]);
    }
    const missing = [];
    for (const group of groups.values()) {
      const { location_id, model, kind, issued_at } = group[0];
      const stored = await store.find(collection, { location_id, model, kind, issued_at }, { projection: { _id: 0, target_time: 1 } });
      const have = new Set(stored.map((s) => new Date(s.target_time).getTime()));
      missing.push(...group.filter((d) => !have.has(d.target_time.getTime())));
    }
    return missing;
  }
  const ids = [...new Set(docs.map((d) => d.id))];
  const have = new Set((await store.find(collection, { id: { $in: ids } }, { projection: { _id: 0, id: 1 } })).map((d) => d.id));
  return docs.filter((d) => !have.has(d.id));
}

/**
 * Restore one window. Dry run unless `apply`: then the missing documents are inserted (insert-only).
 * @param {import("../adapters/rawStore/RawStore.js").RawStore} store
 * @param {{ listKeys: Function, readObject: Function }} archive  S3RawArchive opened for reading
 * @param {object[]} locations
 * @param {{ from: Date, to: Date, apply?: boolean, batchId: string }} options  fetch times from..to (inclusive)
 * @returns {Promise<object>} per source: objects and responses read, documents rebuilt, already stored, inserted
 */
export async function restoreNws(store, archive, locations, { from, to, apply = false, batchId }) {
  const urlIndex = forecastUrlIndex(locations);
  const byZone = locationsByZone(locations);
  const report = {};
  for (const [name, source] of Object.entries(SOURCES)) {
    const keys = await archive.listKeys(source, day(from), day(to));
    let lines = [];
    const objects = [];
    for (const key of keys) {
      const inWindow = (await archive.readObject(key)).filter((l) => l.fetched_at >= from && l.fetched_at <= to);
      if (inWindow.length) objects.push(key);
      lines = lines.concat(inWindow);
    }
    const spec = name === "forecast" ? SNAPSHOTS : ALERTS;
    const built = name === "forecast" ? forecastDocs(lines, urlIndex, batchId) : { docs: alertDocs(lines, byZone, batchId), unknownUrls: [] };
    const docs = mergeByKey(built.docs, spec.uniqueKey);
    const missing = await missingDocs(store, spec.name, docs);
    const written = apply && missing.length ? await store.insertMissing(spec.name, missing, spec.uniqueKey) : { inserted: 0 };
    report[name] = {
      collection: spec.name,
      objects: objects.length,
      responses: lines.length,
      documents: docs.length,
      already_stored: docs.length - missing.length,
      missing: missing.length,
      inserted: written.inserted,
      missing_by_day: countBy(missing, (d) => day(d.fetched_at)),
      unknown_urls: built.unknownUrls,
    };
  }
  return report;
}

function countBy(items, keyOf) {
  const counts = {};
  for (const item of items) counts[keyOf(item)] = (counts[keyOf(item)] ?? 0) + 1;
  return counts;
}
