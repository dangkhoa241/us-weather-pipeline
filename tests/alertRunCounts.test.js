// The alerts run saves its public-email counts (for the Ops page's status.json): sent, skipped by cooldown, not new.
import { describe, it, expect, vi, beforeEach } from "vitest";

const nws = vi.hoisted(() => ({ result: null }));
vi.mock("../src/lib/http.js", () => ({ nwsGet: vi.fn(async () => nws.result) }));

const { fetchAlerts } = await import("../src/stage1/nwsAlerts.js");
const { createPublicAlerts } = await import("../src/stage1/publicAlerts.js");
const { MemoryCounterStore } = await import("../src/adapters/counterStore/memoryCounterStore.js");

const NOW = new Date("2026-10-08T17:23:00Z");
const LOCATIONS = [{ id: "stockton-ca", name: "Stockton", state: "CA", lat: 37.96, lon: -121.29, timezone: "America/Los_Angeles", nws_forecast_zone: "CAZ019" }];
const feature = (id, event, severity) => ({ id, properties: { id, event, severity, messageType: "Update", sent: "2026-10-08T16:00:00Z",
  ends: "2026-10-10T05:00:00Z", affectedZones: ["https://api.weather.gov/zones/forecast/CAZ019"] } });
// Already stored before this run: the same heat advisory (older id, same end time).
const PRIOR = [{ id: "h0", event: "Heat Advisory", severity: "Moderate", message_type: "Alert", location_ids: ["stockton-ca"],
  sent: new Date("2026-10-07T16:00:00Z"), ends: new Date("2026-10-10T05:00:00Z") }];

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("alerts run: public email counts in the run record", () => {
  it("counts sent, cooldown skips and NWS re-issues (not new), with no subscriber data", async () => {
    const counters = new MemoryCounterStore({ now: () => NOW });
    await counters.put("sub#arn:x:s1", { city: "stockton-ca", categories: ["heat", "wind_storm", "flood"], created_at: "2026-10-01T00:00:00Z" });
    await counters.put("cool#stockton-ca#flood", {}, { ttlSec: 3600 });   // a flood email went out an hour ago
    const publisher = { publish: vi.fn(async () => {}), confirmedSubscriptionArns: vi.fn(async () => new Set(["arn:x:s1"])) };
    const publicAlerts = createPublicAlerts({ publisher, counters, notifier: { notify: vi.fn() }, monthlyCap: 900, cooldownHours: 24,
      dashboardUrl: "https://dash.test", now: () => NOW });
    const store = { find: vi.fn(async () => PRIOR), upsertMany: vi.fn(async (_c, docs) => ({ inserted: docs.length })), addRawResponse: vi.fn() };
    const run = { etlBatchId: "b", add: vi.fn(), error: vi.fn(), set: vi.fn() };
    nws.result = { updated: "2026-10-08T17:00:00Z", features: [
      feature("h1", "Heat Advisory", "Moderate"),   // re-issue: same level, same end → not new
      feature("w1", "High Wind Watch", "Severe"),   // new → sent
      feature("f1", "Flood Watch", "Moderate"),     // new, but in cooldown
    ] };
    await fetchAlerts(store, LOCATIONS, run, null, publicAlerts);
    expect(run.error).not.toHaveBeenCalled();
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(run.set).toHaveBeenCalledWith({ public_alerts: { sent: 1, cooldown: 1, not_new: 1, failed: 0 } });
  });
});
