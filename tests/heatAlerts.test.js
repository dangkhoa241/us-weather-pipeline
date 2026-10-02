import { describe, it, expect, vi } from "vitest";
import { fetchAlerts, heatAlertEvent, newHeatAlerts } from "../src/stage1/nwsAlerts.js";

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
  return { id, properties: { id, event, severity, messageType: "Alert", affectedZones: [`https://api.weather.gov/zones/forecast/${zone}`], ends: "2026-10-03T03:00:00Z" } };
}

const locations = [{ id: "phoenix-az", state: "AZ", nws_forecast_zone: "AZZ530" }, { id: "los-angeles-ca", state: "CA", nws_forecast_zone: "CAZ041" }];

describe("heat alerts → Notifier", () => {
  it("notifies once per run, only for new heat alerts that affect tracked cities", async () => {
    const store = {
      findOne: vi.fn(async (_c, { id }) => (id === "a2" ? { id } : null)),
      upsertMany: vi.fn(async (_c, docs) => ({ inserted: docs.length, updated: 0, unchanged: 0 })),
      addRawResponse: vi.fn(),
    };
    const run = { etlBatchId: "b-1", add: vi.fn(), error: vi.fn() };
    const notifier = { notify: vi.fn(async () => {}) };
    vi.spyOn(console, "log").mockImplementation(() => {});
    await fetchAlerts(store, locations, run, notifier);
    expect(run.error).not.toHaveBeenCalled();
    expect(store.addRawResponse).toHaveBeenCalledWith("nws-alerts", expect.stringContaining("area=AZ%2CCA"), expect.any(Object));
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledWith({
      level: "warn",
      title: "Heat alert: 1 new NWS alert for tracked cities",
      message: "- Extreme Heat Warning (Extreme): phoenix-az until 2026-10-03 03:00 UTC",
    });
  });

  it("skips cancellations and caps the list", () => {
    const doc = (id, extra = {}) => ({ id, event: "Heat Advisory", severity: "Moderate", location_ids: ["x"], ends: null, expires: null, ...extra });
    expect(newHeatAlerts([doc("c", { message_type: "Cancel" })], new Set())).toEqual([]);
    const event = heatAlertEvent(Array.from({ length: 12 }, (_, i) => doc(`h${i}`)));
    expect(event.title).toBe("Heat alert: 12 new NWS alerts for tracked cities");
    expect(event.message.split("\n")).toHaveLength(11);
    expect(event.message).toMatch(/and 2 more$/);
  });
});
