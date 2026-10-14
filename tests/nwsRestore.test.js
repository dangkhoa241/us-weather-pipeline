import { describe, it, expect, vi, beforeEach } from "vitest";
import { gzipSync } from "node:zlib";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { MemoryStore } from "./memoryStore.js";
import { S3RawArchive } from "../src/adapters/rawStore/s3RawArchive.js";
import { RESTORED_FROM, mergeByKey, restoreNws } from "../src/stage1/nwsRestore.js";
import { COLLECTIONS } from "../src/collections.js";

const SNAPSHOTS = COLLECTIONS.forecastSnapshots.name;
const ALERTS = COLLECTIONS.alerts.name;
const GRID = "https://api.weather.gov/gridpoints/STO/45,62";
const LOCATIONS = [{
  id: "stockton-ca", name: "Stockton", state: "CA", nws_forecast_zone: "CAZ019", nws_county: "CAC077",
  nws_forecast_url: `${GRID}/forecast`, nws_forecast_hourly_url: `${GRID}/forecast/hourly`,
}];

const period = (start, temp) => ({
  startTime: start, endTime: new Date(Date.parse(start) + 3_600_000).toISOString(), temperature: temp, temperatureUnit: "C",
  windSpeed: "10 km/h", windDirection: "NW", isDaytime: true, name: "", shortForecast: "Sunny",
});
const forecastLine = (fetchedAt, updateTime, temps) => ({
  url: `${GRID}/forecast/hourly?units=si`, fetched_at: new Date(fetchedAt),
  body: { properties: { updateTime, generatedAt: updateTime, periods: temps.map((t, i) => period(new Date(Date.parse("2026-10-06T06:00:00Z") + i * 3_600_000).toISOString(), t)) } },
});
const alertLine = (fetchedAt, ids) => ({
  url: "https://api.weather.gov/alerts/active?area=CA", fetched_at: new Date(fetchedAt),
  body: { updated: fetchedAt, features: ids.map((id) => ({ properties: {
    id, event: "Heat Advisory", severity: "Moderate", messageType: "Alert", affectedZones: ["https://api.weather.gov/zones/forecast/CAZ019"],
    geocode: { UGC: ["CAZ019"] }, sent: "2026-10-06T02:00:00Z", expires: "2026-10-07T02:00:00Z",
  } })) },
});

/** Archive with fixed objects (the S3RawArchive read methods). */
const fakeArchive = (objects) => ({
  listKeys: vi.fn(async (source) => Object.keys(objects).filter((k) => k.startsWith(`${source}/`)).sort()),
  readObject: vi.fn(async (key) => objects[key]),
});

const OBJECTS = {
  "nws-forecast/2026/10/06/030829Z-a.json.gz": [forecastLine("2026-10-06T03:08:00Z", "2026-10-06T02:50:00Z", [20, 21, 22])],
  "nws-forecast/2026/10/06/060847Z-b.json.gz": [forecastLine("2026-10-06T06:08:00Z", "2026-10-06T05:40:00Z", [19, 20])],
  "nws-forecast/2026/10/07/120842Z-c.json.gz": [forecastLine("2026-10-07T12:08:00Z", "2026-10-07T11:40:00Z", [18])],   // after the window
  "nws-alerts/2026/10/06/032312Z-a.json.gz": [alertLine("2026-10-06T03:23:10Z", ["A1", "A2"])],
  "nws-alerts/2026/10/06/062313Z-b.json.gz": [alertLine("2026-10-06T06:23:10Z", ["A2", "A3"])],
};
const WINDOW = { from: new Date("2026-10-06T03:07:00Z"), to: new Date("2026-10-07T09:23:00Z") };
const snapshot = (store) => structuredClone([...store.collections.entries()]);

beforeEach(() => vi.restoreAllMocks());

describe("restoreNws (S3 archive → raw store)", () => {
  it("dry run (default) reports the missing documents and writes nothing", async () => {
    const store = new MemoryStore();
    const report = await restoreNws(store, fakeArchive(OBJECTS), LOCATIONS, { ...WINDOW, batchId: "dry" });
    expect(report.forecast).toMatchObject({ objects: 2, responses: 2, documents: 5, missing: 5, inserted: 0 });
    expect(report.alerts).toMatchObject({ objects: 2, responses: 2, documents: 3, missing: 3, inserted: 0 });
    expect([...store.collections.values()].flat()).toEqual([]);
  });

  it("--apply inserts the missing documents with the collector's own fields; a second run changes nothing", async () => {
    const store = new MemoryStore();
    const archive = fakeArchive(OBJECTS);
    const first = await restoreNws(store, archive, LOCATIONS, { ...WINDOW, apply: true, batchId: "r1" });
    expect(first.forecast.inserted).toBe(5);
    expect(first.alerts.inserted).toBe(3);
    const [doc] = await store.find(SNAPSHOTS, { issued_at: new Date("2026-10-06T02:50:00Z"), target_time: new Date("2026-10-06T06:00:00Z") });
    expect(doc).toMatchObject({
      location_id: "stockton-ca", source: "nws", model: "nws", kind: "hourly", issued_at_basis: "nws_update_time",
      lead_hours: 3, lead_days: 0, restored_from: RESTORED_FROM, etl_batch_id: "r1",
    });
    expect(doc.values.temp_c).toBe(20);

    const before = snapshot(store);
    const second = await restoreNws(store, archive, LOCATIONS, { ...WINDOW, apply: true, batchId: "r2" });
    expect(second.forecast).toMatchObject({ documents: 5, already_stored: 5, missing: 0, inserted: 0 });
    expect(second.alerts).toMatchObject({ documents: 3, already_stored: 3, missing: 0, inserted: 0 });
    expect(snapshot(store)).toEqual(before);
  });

  it("never changes a document that is already stored (insert-only)", async () => {
    const store = new MemoryStore();
    await store.insertMissing(ALERTS, [{ id: "A2", event: "kept as collected", fetched_at: new Date("2026-10-06T00:23:00Z") }], ["id"]);
    const report = await restoreNws(store, fakeArchive(OBJECTS), LOCATIONS, { ...WINDOW, apply: true, batchId: "r1" });
    expect(report.alerts).toMatchObject({ documents: 3, already_stored: 1, inserted: 2 });
    expect((await store.find(ALERTS, { id: "A2" }))[0].event).toBe("kept as collected");
  });

  it("an alert seen in several slots becomes one document: latest fetch, first_seen_at from the earliest", async () => {
    const store = new MemoryStore();
    await restoreNws(store, fakeArchive(OBJECTS), LOCATIONS, { ...WINDOW, apply: true, batchId: "r1" });
    const [a2] = await store.find(ALERTS, { id: "A2" });
    expect(a2.first_seen_at).toEqual(new Date("2026-10-06T03:23:10Z"));
    expect(a2.fetched_at).toEqual(new Date("2026-10-06T06:23:10Z"));
    expect(a2.last_seen_at).toEqual(new Date("2026-10-06T06:23:10Z"));
    expect(a2.location_ids).toEqual(["stockton-ca"]);
  });

  it("mergeByKey keeps one document per natural key", () => {
    const docs = [
      { id: "x", v: 1, fetched_at: new Date("2026-10-06T03:00:00Z") },
      { id: "x", v: 2, fetched_at: new Date("2026-10-06T06:00:00Z") },
      { id: "y", v: 3, fetched_at: new Date("2026-10-06T03:00:00Z") },
    ];
    expect(mergeByKey(docs, ["id"]).map((d) => [d.id, d.v])).toEqual([["x", 2], ["y", 3]]);
  });
});

describe("S3RawArchive read methods (mocked AWS SDK client)", () => {
  const BUCKET = "weather-pipeline-raw-123456789012";

  it("listKeys lists one prefix per UTC day and follows continuation tokens", async () => {
    const send = vi.fn(async (cmd) => {
      expect(cmd).toBeInstanceOf(ListObjectsV2Command);
      const { Prefix, ContinuationToken } = cmd.input;
      if (Prefix === "nws-alerts/2026/10/06/" && !ContinuationToken) return { Contents: [{ Key: `${Prefix}b` }], IsTruncated: true, NextContinuationToken: "t" };
      if (Prefix === "nws-alerts/2026/10/06/") return { Contents: [{ Key: `${Prefix}a` }] };
      return { Contents: [{ Key: `${Prefix}c` }] };
    });
    const archive = new S3RawArchive({ bucket: BUCKET, region: "us-east-2", client: { send, destroy: vi.fn() } });
    expect(await archive.listKeys("nws-alerts", "2026-10-06", "2026-10-07"))
      .toEqual(["nws-alerts/2026/10/06/a", "nws-alerts/2026/10/06/b", "nws-alerts/2026/10/07/c"]);
    expect(send).toHaveBeenCalledTimes(3);
    await expect(archive.listKeys("../etc", "2026-10-06", "2026-10-06")).rejects.toThrow(/invalid archive source/);
  });

  it("readObject gunzips the NDJSON lines and parses fetched_at", async () => {
    const body = gzipSync(`${JSON.stringify({ url: "u", fetched_at: "2026-10-06T03:08:00.000Z", body: { a: 1 } })}\n`);
    const send = vi.fn(async (cmd) => {
      expect(cmd).toBeInstanceOf(GetObjectCommand);
      return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
    });
    const archive = new S3RawArchive({ bucket: BUCKET, region: "us-east-2", client: { send, destroy: vi.fn() } });
    expect(await archive.readObject("nws-forecast/2026/10/06/x.json.gz"))
      .toEqual([{ url: "u", fetched_at: new Date("2026-10-06T03:08:00.000Z"), body: { a: 1 } }]);
  });
});
