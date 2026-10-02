import { describe, it, expect, vi, beforeEach } from "vitest";
import { gunzipSync } from "node:zlib";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { S3RawArchive, objectKey } from "../src/adapters/rawStore/s3RawArchive.js";
import { RawStore } from "../src/adapters/rawStore/RawStore.js";

const BUCKET = "weather-pipeline-raw-123456789012";
const NOW = new Date("2026-10-01T20:42:39.123Z");

/** In-memory api_usage ledger: the only RawStore methods ApiBudget uses. */
class FakeStore extends RawStore {
  usage = new Map();
  async findOne(_c, { api, period }) { const calls = this.usage.get(`${api}|${period}`); return calls ? { calls } : null; }
  async increment(_c, { api, period }, { calls }) { this.usage.set(`${api}|${period}`, (this.usage.get(`${api}|${period}`) ?? 0) + calls); }
}

const make = (send, opts = {}) => new S3RawArchive({ bucket: BUCKET, region: "us-east-2", client: { send, destroy: vi.fn() }, ...opts });
const lines = (cmd) => gunzipSync(cmd.input.Body).toString("utf8").trim().split("\n").map((l) => JSON.parse(l));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("S3RawArchive (mocked AWS SDK client)", () => {
  it("uploads one gzipped NDJSON object per source and run, SSE-S3, under <source>/<yyyy>/<mm>/<dd>/", async () => {
    const send = vi.fn(async () => ({}));
    const archive = make(send);
    archive.add("nws-forecast", "https://api.weather.gov/a", { properties: { periods: [1] } }, NOW);
    archive.add("nws-forecast", "https://api.weather.gov/b", { properties: { periods: [2] } }, NOW);
    archive.add("open-meteo-forecast", "https://api.open-meteo.com/v1/forecast", { hourly: {} }, NOW);
    await archive.flush(new FakeStore(), "stage1-forecast-20261001T204239123Z-abcd1234", NOW);

    expect(send).toHaveBeenCalledTimes(2);
    const [forecast, om] = send.mock.calls.map(([cmd]) => cmd);
    expect(forecast).toBeInstanceOf(PutObjectCommand);
    expect(forecast.input).toMatchObject({
      Bucket: BUCKET,
      Key: "nws-forecast/2026/10/01/204239Z-stage1-forecast-20261001T204239123Z-abcd1234.json.gz",
      ContentType: "application/gzip",
      ServerSideEncryption: "AES256",
    });
    expect(lines(forecast)).toEqual([
      { url: "https://api.weather.gov/a", fetched_at: NOW.toISOString(), body: { properties: { periods: [1] } } },
      { url: "https://api.weather.gov/b", fetched_at: NOW.toISOString(), body: { properties: { periods: [2] } } },
    ]);
    expect(om.input.Key).toMatch(/^open-meteo-forecast\/2026\/10\/01\//);
  });

  it("clears the buffers after a flush (nothing uploaded twice, nothing uploaded for an empty run)", async () => {
    const send = vi.fn(async () => ({}));
    const archive = make(send);
    archive.add("nws-forecast", "u", {}, NOW);
    const store = new FakeStore();
    await archive.flush(store, "b-1", NOW);
    await archive.flush(store, "b-2", new Date(NOW.getTime() + 3_600_000));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uploads at most one object per source per UTC hour", async () => {
    const send = vi.fn(async () => ({}));
    const archive = make(send);
    const store = new FakeStore();
    for (const minutes of [0, 15, 30, 45, 60]) {
      archive.add("nws-forecast", "u", {}, NOW);
      await archive.flush(store, "b", new Date(Date.parse("2026-10-01T20:00:00Z") + minutes * 60_000));
    }
    expect(send.mock.calls.map(([cmd]) => cmd.input.Key.slice(0, 31))).toEqual(["nws-forecast/2026/10/01/200000Z", "nws-forecast/2026/10/01/210000Z"]);
  });

  it("archives NWS alerts only in UTC hours divisible by 3 (hourly runs → 8 objects / day)", async () => {
    const send = vi.fn(async () => ({}));
    const archive = make(send);
    const store = new FakeStore();
    for (let hour = 0; hour < 24; hour += 1) {
      archive.add("nws-alerts", "u", {}, NOW);
      await archive.flush(store, "b", new Date(Date.parse("2026-10-01T00:23:00Z") + hour * 3_600_000));
    }
    expect(send.mock.calls.map(([cmd]) => cmd.input.Key.slice(22, 24))).toEqual(["00", "03", "06", "09", "12", "15", "18", "21"]);
  });

  it("stops at RAW_ARCHIVE_MAX_PUTS_PER_DAY across sources", async () => {
    const send = vi.fn(async () => ({}));
    const archive = make(send, { maxPutsPerDay: 2 });
    for (const source of ["a", "b", "c"]) archive.add(source, "u", {}, NOW);
    await archive.flush(new FakeStore(), "b", NOW);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("never throws when S3 fails, and keeps credentials out of the log", async () => {
    const send = vi.fn(async () => { throw Object.assign(new Error("denied for mongodb://user:<password>@host"), { name: "AccessDenied" }); });
    const archive = make(send);
    archive.add("nws-forecast", "u", {}, NOW);
    await expect(archive.flush(new FakeStore(), "b", NOW)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("upload failed (AccessDenied)"));
    expect(console.warn.mock.calls.flat().join(" ")).not.toContain("<password>");
  });

  it("caps one run's buffer per source instead of growing without limit", () => {
    const archive = make(vi.fn());
    const big = "x".repeat(20 * 1024 * 1024);
    archive.add("open-meteo-history", "u1", big, NOW);
    archive.add("open-meteo-history", "u2", big, NOW);
    archive.add("open-meteo-history", "u3", "small", NOW);
    expect(archive.buffers.get("open-meteo-history").lines).toHaveLength(1);
  });

  it("needs a valid bucket name and source", () => {
    expect(() => new S3RawArchive({ bucket: "", region: "us-east-2", client: {} })).toThrow(/RAW_ARCHIVE_BUCKET/);
    expect(() => make(vi.fn()).add("../etc", "u", {})).toThrow(/invalid archive source/);
  });

  it("RawStore without an archive ignores raw responses (RAW_ARCHIVE=none)", async () => {
    const store = new FakeStore();
    store.addRawResponse("nws-forecast", "u", {});
    await expect(store.flushRawResponses("b")).resolves.toBeUndefined();
  });

  it("builds safe keys from the batch id", () => {
    expect(objectKey("nws-alerts", "../x y", NOW)).toBe("nws-alerts/2026/10/01/204239Z-xy.json.gz");
  });
});
