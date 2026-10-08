// Proves that pipeline (ops) emails never go to the PUBLIC topic, and subscriber alerts never to the private one.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublishCommand } from "@aws-sdk/client-sns";

const nws = vi.hoisted(() => ({ result: null }));
vi.mock("../src/lib/http.js", () => ({
  nwsGet: vi.fn(async () => {
    if (nws.result instanceof Error) throw nws.result;
    return nws.result;
  }),
}));

const { fetchAlerts } = await import("../src/stage1/nwsAlerts.js");
const { createPublicAlerts } = await import("../src/stage1/publicAlerts.js");
const { SnsNotifier } = await import("../src/adapters/notifier/snsNotifier.js");
const { SnsAlertPublisher } = await import("../src/adapters/notifier/snsPublicTopic.js");
const { createAlertPublisher, createNotifier } = await import("../src/adapters/notifier/index.js");
const { MemoryCounterStore } = await import("../src/adapters/counterStore/memoryCounterStore.js");
const { createHandler } = await import("../src/lambda/nwsCollector.js");

const PRIVATE = "arn:aws:sns:us-east-2:123456789012:weather-pipeline-alerts";
const PUBLIC = "arn:aws:sns:us-east-2:123456789012:weather-pipeline-public-alerts";
const NOW = new Date("2026-10-08T17:23:00Z");
const LOCATIONS = [{ id: "stockton-ca", name: "Stockton", state: "CA", lat: 37.96, lon: -121.29, timezone: "America/Los_Angeles", nws_forecast_zone: "CAZ019" }];
const feature = (id, event, severity) => ({ id, properties: { id, event, severity, messageType: "Alert", sent: "2026-10-08T16:00:00Z", ends: "2026-10-10T05:00:00Z", affectedZones: ["https://api.weather.gov/zones/forecast/CAZ019"] } });

function wiring() {
  const privateSend = vi.fn(async () => ({}));
  const publicSend = vi.fn(async () => ({ Subscriptions: [] }));
  const notifier = new SnsNotifier({ topicArn: PRIVATE, region: "us-east-2", pipelineName: "p", client: { send: privateSend }, local: { notify: async () => {} } });
  const publisher = new SnsAlertPublisher({ topicArn: PUBLIC, privateTopicArn: PRIVATE, region: "us-east-2", client: { send: publicSend } });
  const counters = new MemoryCounterStore({ now: () => NOW });
  const publicAlerts = createPublicAlerts({ publisher, counters, notifier, monthlyCap: 900, cooldownHours: 24, dashboardUrl: "https://dash.test", now: () => NOW });
  const store = { find: vi.fn(async () => []), upsertMany: vi.fn(async (_c, docs) => ({ inserted: docs.length })), addRawResponse: vi.fn() };
  const run = { etlBatchId: "b", add: vi.fn(), error: vi.fn() };
  const published = (send) => send.mock.calls.map(([c]) => c).filter((c) => c instanceof PublishCommand).map((c) => c.input);
  return { privateSend, publicSend, notifier, publisher, counters, publicAlerts, store, run, published };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("ops emails never reach the public topic", () => {
  it("the public publisher refuses the private topic and has no free-text notify()", () => {
    expect(() => new SnsAlertPublisher({ topicArn: PRIVATE, privateTopicArn: PRIVATE, region: "us-east-2", client: {} })).toThrow(/must not be the private/);
    const p = new SnsAlertPublisher({ topicArn: PUBLIC, privateTopicArn: PRIVATE, region: "us-east-2", client: {} });
    expect(p.notify).toBeUndefined();
  });

  it("createNotifier() is always the private topic; the public publisher is off by default", () => {
    expect(createAlertPublisher("off")).toBeNull();
    expect(createAlertPublisher()).toBeNull();   // PUBLIC_ALERTS unset → off (local runs)
    expect(() => createAlertPublisher("discord")).toThrow(/PUBLIC_ALERTS/);
    expect(createNotifier("console").topicArn).toBeUndefined();
  });

  it("an alerts run: heat email → private only; subscriber alerts → public only, with attributes", async () => {
    const w = wiring();
    await w.counters.put(`sub#${PUBLIC}:s1`, { city: "stockton-ca", categories: ["heat", "wind_storm"], created_at: "2026-10-01T00:00:00Z" });
    nws.result = { updated: "2026-10-08T17:00:00Z", features: [feature("h1", "Heat Advisory", "Moderate"), feature("w1", "High Wind Watch", "Severe")] };
    await fetchAlerts(w.store, LOCATIONS, w.run, w.notifier, w.publicAlerts);
    expect(w.run.error).not.toHaveBeenCalled();
    const priv = w.published(w.privateSend);
    const pub = w.published(w.publicSend);
    expect(priv).toHaveLength(1);
    expect(priv[0]).toMatchObject({ TopicArn: PRIVATE, Subject: expect.stringContaining("Heat alert") });
    expect(priv[0].MessageAttributes).toBeUndefined();
    expect(pub.map((p) => [p.TopicArn, p.MessageAttributes.city.StringValue, p.MessageAttributes.category.StringValue]))
      .toEqual([[PUBLIC, "stockton-ca", "heat"], [PUBLIC, "stockton-ca", "wind_storm"]]);
  });

  it("a failed alerts run: the failure is recorded for the private notifier; nothing reaches the public topic", async () => {
    const w = wiring();
    nws.result = Object.assign(new Error("HTTP 503 for https://api.weather.gov/alerts/active"), { name: "HttpError" });
    await fetchAlerts(w.store, LOCATIONS, w.run, w.notifier, w.publicAlerts);
    expect(w.run.error).toHaveBeenCalled();
    expect(w.published(w.publicSend)).toEqual([]);
  });

  it("the 'paused' notice goes to the private topic, never the public one", async () => {
    const w = wiring();
    await w.counters.put(`sub#${PUBLIC}:s1`, { city: "stockton-ca", categories: ["heat"], created_at: "2026-10-01T00:00:00Z" });
    await w.counters.increment("emails#2026-10", 900, { limit: 900 });
    nws.result = { updated: "2026-10-08T17:00:00Z", features: [feature("h1", "Heat Advisory", "Moderate")] };
    await fetchAlerts(w.store, LOCATIONS, w.run, w.notifier, w.publicAlerts);
    expect(w.published(w.publicSend)).toEqual([]);
    expect(w.published(w.privateSend).map((p) => p.Subject)).toEqual([
      expect.stringContaining("Heat alert"),
      expect.stringContaining("Public alert emails paused for 2026-10"),
    ]);
  });

  it("collector Lambda: failures and partial runs go to the private notifier; forecast mode never builds the public publisher", async () => {
    const notifier = { notify: vi.fn(async () => {}) };
    const makeAlertPublisher = vi.fn(() => ({ publish: vi.fn(), confirmedSubscriptionArns: vi.fn() }));
    const handler = createHandler({
      getParameter: async () => "mongodb+srv://u:p@h", makeStore: () => ({ connect: async () => { throw new Error("Atlas down"); }, close: async () => {} }),
      makeNotifier: () => notifier, makeAlertPublisher, makeCounters: () => new MemoryCounterStore(),
    });
    await handler({ mode: "forecast" });
    expect(makeAlertPublisher).not.toHaveBeenCalled();
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", title: "Lambda NWS forecast failed" }));
    await handler({ mode: "alerts" });
    expect(makeAlertPublisher.mock.results.flatMap((r) => r.value.publish.mock.calls)).toEqual([]);
    expect(notifier.notify).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Lambda NWS alerts failed" }));
  });
});
