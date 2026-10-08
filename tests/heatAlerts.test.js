import { describe, it, expect, vi } from "vitest";
import { fetchAlerts, heatAlertEvent, heatChanges, newHeatAlerts } from "../src/stage1/nwsAlerts.js";

vi.mock("../src/lib/http.js", () => ({
  nwsGet: vi.fn(async () => ({
    updated: "2026-10-01T20:00:00Z",
    features: [
      feature("a1", "Extreme Heat Warning", "Extreme", "AZZ530"),       // new, affects Phoenix
      feature("a2", "Heat Advisory", "Moderate", "AZZ530"),             // already stored → not new
      feature("a3", "Excessive Heat Watch", "Severe", "CAZ999"),        // no tracked city
      feature("a4", "Flood Warning", "Severe", "AZZ530"),               // not heat
    ],
  })),
}));

function feature(id, event, severity, zone) {
  return { id, properties: { id, event, severity, messageType: "Alert", sent: "2026-10-01T19:00:00Z", affectedZones: [`https://api.weather.gov/zones/forecast/${zone}`], ends: "2026-10-03T03:00:00Z" } };
}

const locations = [{ id: "phoenix-az", state: "AZ", nws_forecast_zone: "AZZ530" }, { id: "los-angeles-ca", state: "CA", nws_forecast_zone: "CAZ041" }];
const d = (s) => new Date(s);
const alert = (id, event, severity, cities, sent, ends, message_type = "Update") =>
  ({ id, event, severity, message_type, location_ids: cities, sent: d(sent), ends: d(ends), expires: null });

describe("heat alerts → Notifier", () => {
  it("notifies once per run, only for heat alerts that affect tracked cities, with the reason", async () => {
    const stored = { id: "a2", event: "Heat Advisory", severity: "Moderate", message_type: "Alert", location_ids: ["phoenix-az"], sent: d("2026-10-01T10:00:00Z"), ends: d("2026-10-03T03:00:00Z"), expires: null };
    const store = {
      find: vi.fn(async () => [stored]),
      upsertMany: vi.fn(async (_c, docs) => ({ inserted: docs.length, updated: 0, unchanged: 0 })),
      addRawResponse: vi.fn(),
    };
    const run = { etlBatchId: "b-1", add: vi.fn(), error: vi.fn() };
    const notifier = { notify: vi.fn(async () => {}) };
    vi.spyOn(console, "log").mockImplementation(() => {});
    await fetchAlerts(store, locations, run, notifier);
    expect(run.error).not.toHaveBeenCalled();
    expect(store.addRawResponse).toHaveBeenCalledWith("nws-alerts", expect.stringContaining("area=AZ%2CCA"), expect.any(Object));
    expect(store.find.mock.calls[0][1]).toMatchObject({ location_ids: { $in: ["phoenix-az"] } });   // read before the upsert
    expect(store.find.mock.invocationCallOrder[0]).toBeLessThan(store.upsertMany.mock.invocationCallOrder[0]);
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith({
      level: "warn",
      title: "Heat alert: 1 change for tracked cities (upgraded)",
      message: "- Upgraded: Extreme Heat Warning (Extreme): phoenix-az until 2026-10-03 03:00 UTC",
    });
  });

  it("skips cancellations and caps the list", () => {
    const doc = (id, extra = {}) => ({ id, event: "Heat Advisory", severity: "Moderate", location_ids: ["x"], ends: null, expires: null, ...extra });
    expect(newHeatAlerts([doc("c", { message_type: "Cancel" })], new Set())).toEqual([]);
    const event = heatAlertEvent(Array.from({ length: 12 }, (_, i) => ({ reason: "New", until: null, alert: doc(`h${i}`), cities: ["x"] })));
    expect(event.title).toBe("Heat alert: 12 changes for tracked cities (new)");
    expect(event.message.split("\n")).toHaveLength(11);
    expect(event.message).toMatch(/and 2 more$/);
  });
});

describe("heat alert changes (fixed dates)", () => {
  const warning = alert("w1", "Extreme Heat Warning", "Severe", ["los-angeles-ca"], "2026-10-02T12:00:00Z", "2026-10-09T03:00:00Z", "Alert");

  it("re-issue with the same end time → no email", () => {
    const reissue = alert("w2", "Extreme Heat Warning", "Severe", ["los-angeles-ca"], "2026-10-03T12:00:00Z", "2026-10-09T03:00:00Z");
    expect(heatChanges([reissue], [warning])).toEqual([]);
  });

  it("end time extended → one email, \"Extended to …\"", () => {
    const later = alert("w2", "Extreme Heat Warning", "Severe", ["los-angeles-ca"], "2026-10-03T12:00:00Z", "2026-10-10T03:00:00Z");
    const changes = heatChanges([later], [warning]);
    expect(changes.map((c) => c.reason)).toEqual(["Extended"]);
    expect(heatAlertEvent(changes).message).toBe("- Extended to 2026-10-10 03:00 UTC: Extreme Heat Warning (Severe): los-angeles-ca");
  });

  it("severity goes up (Advisory → Warning) → one email, \"Upgraded\"", () => {
    const advisory = alert("h1", "Heat Advisory", "Moderate", ["stockton-ca"], "2026-10-02T12:00:00Z", "2026-10-08T05:00:00Z", "Alert");
    const upgrade = alert("h2", "Excessive Heat Warning", "Severe", ["stockton-ca"], "2026-10-03T12:00:00Z", "2026-10-08T05:00:00Z");
    const changes = heatChanges([upgrade], [advisory]);
    expect(changes.map((c) => c.reason)).toEqual(["Upgraded"]);
    expect(heatAlertEvent(changes).message).toBe("- Upgraded: Excessive Heat Warning (Severe): stockton-ca until 2026-10-08 05:00 UTC");
  });

  it("a new city → one email, \"New\", for that city only", () => {
    const spread = alert("w2", "Extreme Heat Warning", "Severe", ["los-angeles-ca", "stockton-ca"], "2026-10-03T12:00:00Z", "2026-10-09T03:00:00Z");
    const changes = heatChanges([spread], [warning]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ reason: "New", cities: ["stockton-ca"] });
  });

  it("a city whose last heat alert has ended starts a new event; shortening the end time sends nothing", () => {
    const nextWeek = alert("w9", "Extreme Heat Warning", "Severe", ["los-angeles-ca"], "2026-10-12T12:00:00Z", "2026-10-14T03:00:00Z");
    expect(heatChanges([nextWeek], [warning]).map((c) => c.reason)).toEqual(["New"]);
    const shorter = alert("w2", "Extreme Heat Warning", "Severe", ["los-angeles-ca"], "2026-10-03T12:00:00Z", "2026-10-08T03:00:00Z");
    expect(heatChanges([shorter], [warning])).toEqual([]);
  });

  // The 17 heat alerts for tracked cities stored in Atlas (2026-09-30 → 2026-10-07), one collector run each.
  // The old rule (any new id) emailed every one; the inbox had the LA warning 7× and the Stockton advisory ~7×.
  it("replays the real sequence: 17 NWS alerts → 5 emails", () => {
    const LA = ["los-angeles-ca"], ST = ["stockton-ca"];
    const W = "Extreme Heat Warning", A = "Heat Advisory";
    const seq = [
      alert("la-watch", "Extreme Heat Watch", "Severe", LA, "2026-09-30T16:46:00Z", "2026-10-09T03:00:00Z", "Alert"),
      alert("st-1", A, "Moderate", ST, "2026-10-01T16:34:00Z", "2026-10-06T05:00:00Z", "Alert"),
      alert("la-1", W, "Severe", LA, "2026-10-01T19:17:00Z", "2026-10-09T03:00:00Z", "Alert"),
      alert("la-2", W, "Severe", LA, "2026-10-02T12:38:00Z", "2026-10-09T03:00:00Z"),
      alert("st-2", A, "Moderate", ST, "2026-10-02T17:00:00Z", "2026-10-08T05:00:00Z"),
      alert("la-3", W, "Severe", LA, "2026-10-02T17:38:00Z", "2026-10-09T03:00:00Z"),
      alert("st-3", A, "Moderate", ST, "2026-10-03T17:18:00Z", "2026-10-08T05:00:00Z"),
      alert("la-4", W, "Severe", LA, "2026-10-03T19:15:00Z", "2026-10-09T03:00:00Z"),
      alert("st-4", A, "Moderate", ST, "2026-10-03T21:14:00Z", "2026-10-08T05:00:00Z"),
      alert("la-5", W, "Severe", LA, "2026-10-04T18:04:00Z", "2026-10-09T03:00:00Z"),
      alert("st-5", A, "Moderate", ST, "2026-10-04T20:16:00Z", "2026-10-08T05:00:00Z"),
      alert("st-6", A, "Moderate", ST, "2026-10-05T16:42:00Z", "2026-10-10T05:00:00Z"),
      alert("la-6", W, "Severe", LA, "2026-10-05T21:47:00Z", "2026-10-09T03:00:00Z"),
      alert("la-7", W, "Severe", LA, "2026-10-06T09:56:00Z", "2026-10-09T03:00:00Z"),
      alert("st-7", A, "Moderate", ST, "2026-10-06T18:32:00Z", "2026-10-10T05:00:00Z"),
      alert("st-8", A, "Moderate", ST, "2026-10-07T15:51:00Z", "2026-10-09T05:00:00Z"),
      alert("la-8", W, "Severe", LA, "2026-10-07T16:41:00Z", "2026-10-09T03:00:00Z"),
    ];
    const stored = [];
    const emails = [];
    for (const a of seq) {
      const changes = heatChanges([a], stored);
      if (changes.length) emails.push(heatAlertEvent(changes).message);
      stored.push(a);
    }
    expect(emails).toEqual([
      "- New: Extreme Heat Watch (Severe): los-angeles-ca until 2026-10-09 03:00 UTC",
      "- New: Heat Advisory (Moderate): stockton-ca until 2026-10-06 05:00 UTC",
      "- Upgraded: Extreme Heat Warning (Severe): los-angeles-ca until 2026-10-09 03:00 UTC",
      "- Extended to 2026-10-08 05:00 UTC: Heat Advisory (Moderate): stockton-ca",
      "- Extended to 2026-10-10 05:00 UTC: Heat Advisory (Moderate): stockton-ca",
    ]);
    // In the inbox window (alerts sent from 2026-10-02 on): 2 emails instead of 14 (both Stockton extensions).
  });
});
