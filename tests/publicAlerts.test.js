import { describe, it, expect, vi, beforeEach } from "vitest";
import { categoryChanges, heatChanges } from "../src/stage1/nwsAlerts.js";
import { createPublicAlerts, publicAlertMessage } from "../src/stage1/publicAlerts.js";
import { MemoryCounterStore } from "../src/adapters/counterStore/memoryCounterStore.js";
import { filterPolicyFor } from "../src/adapters/notifier/snsPublicTopic.js";
import { DISCLAIMER } from "../src/stage1/alertCategories.js";

const d = (s) => new Date(s);
const NOW = d("2026-10-08T17:23:00Z");
const alert = (id, event, severity, cities, sent, ends, message_type = "Update") =>
  ({ id, event, severity, message_type, location_ids: cities, sent: d(sent), ends: d(ends), expires: null, headline: `${event} issued`, instruction: "Stay safe." });
const LOCATIONS = [
  { id: "stockton-ca", name: "Stockton", state: "CA", lat: 37.9577, lon: -121.2908, timezone: "America/Los_Angeles" },
  { id: "jacksonville-fl", name: "Jacksonville", state: "FL", lat: 30.3322, lon: -81.6557, timezone: "America/New_York" },
];

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("per-category notify rule (fixed dates)", () => {
  const flood = alert("f1", "Coastal Flood Advisory", "Minor", ["jacksonville-fl"], "2026-10-08T05:00:00Z", "2026-10-10T18:00:00Z", "Alert");

  it("new alert with nothing of its category in effect → one change \"New\"", () => {
    expect(categoryChanges([flood], []).map((c) => [c.reason, c.category, c.cities])).toEqual([["New", "flood", ["jacksonville-fl"]]]);
  });

  it("re-issue with the same end time → no change", () => {
    const reissue = alert("f2", "Coastal Flood Advisory", "Minor", ["jacksonville-fl"], "2026-10-08T18:05:00Z", "2026-10-10T18:00:00Z");
    expect(categoryChanges([reissue], [flood])).toEqual([]);
  });

  it("later end time → one change \"Extended\"", () => {
    const later = alert("f2", "Coastal Flood Advisory", "Minor", ["jacksonville-fl"], "2026-10-08T18:05:00Z", "2026-10-11T06:00:00Z");
    expect(categoryChanges([later], [flood]).map((c) => c.reason)).toEqual(["Extended"]);
  });

  it("higher product in the same category (Watch → Warning) → one change \"Upgraded\"", () => {
    const watch = alert("w1", "Flood Watch", "Severe", ["jacksonville-fl"], "2026-10-08T05:00:00Z", "2026-10-11T12:00:00Z", "Alert");
    const warning = alert("w2", "Flash Flood Warning", "Severe", ["jacksonville-fl"], "2026-10-08T15:00:00Z", "2026-10-08T21:00:00Z", "Alert");
    expect(categoryChanges([warning], [watch]).map((c) => c.reason)).toEqual(["Upgraded"]);
  });

  it("categories are independent: an active flood alert doesn't hide a new wind alert", () => {
    const wind = alert("x1", "High Wind Watch", "Severe", ["jacksonville-fl"], "2026-10-08T17:04:00Z", "2026-10-11T12:00:00Z", "Alert");
    expect(categoryChanges([wind], [flood]).map((c) => [c.reason, c.category])).toEqual([["New", "wind_storm"]]);
  });

  it("\"other\" events and cancellations never produce changes", () => {
    const rip = alert("r1", "Rip Current Statement", "Moderate", ["jacksonville-fl"], "2026-10-08T05:54:00Z", "2026-10-11T10:00:00Z");
    expect(categoryChanges([rip], [])).toEqual([]);
    const cancel = { ...flood, id: "c1", message_type: "Cancel" };
    expect(categoryChanges([flood], [cancel]).map((c) => c.reason)).toEqual(["New"]);
  });

  it("the private heat rule is unchanged (heat only, any heat event name)", () => {
    const heat = alert("h1", "Heat Advisory", "Moderate", ["stockton-ca"], "2026-10-07T15:51:00Z", "2026-10-09T05:00:00Z", "Alert");
    expect(heatChanges([heat, flood], []).map((c) => [c.reason, c.alert.id])).toEqual([["New", "h1"]]);
  });
});

describe("filter policy", () => {
  it("one city, de-duplicated categories; both attributes must match", () => {
    expect(filterPolicyFor("stockton-ca", ["heat", "flood", "heat"])).toEqual({ city: ["stockton-ca"], category: ["heat", "flood"] });
    expect(filterPolicyFor("stockton-ca", ["test"])).toEqual({ city: ["stockton-ca"], category: ["test"] });
  });
  it("refuses bad cities and unknown or empty categories", () => {
    expect(() => filterPolicyFor("Stockton CA", ["heat"])).toThrow(/city/);
    expect(() => filterPolicyFor("stockton-ca", [])).toThrow(/categories/);
    expect(() => filterPolicyFor("stockton-ca", ["sms"])).toThrow(/categories/);
  });
});

describe("subscriber email text", () => {
  it("has an ASCII subject, local + UTC end time, links, why, and the disclaimer at top and bottom", () => {
    const change = { reason: "Extended", until: d("2026-10-10T05:00:00Z"), alert: alert("h", "Heat Advisory", "Moderate", ["stockton-ca"], "2026-10-08T10:00:00Z", "2026-10-10T05:00:00Z"), category: "heat" };
    const { subject, message } = publicAlertMessage(change, LOCATIONS[0], "https://us-weather-pipeline.vercel.app");
    expect(subject).toBe("Stockton, CA: Heat Advisory (extended to Oct 9, 10:00 PM PDT)");
    const lines = message.split("\n");
    expect(lines[0]).toBe(DISCLAIMER);
    expect(lines.at(-1)).toBe(DISCLAIMER);
    expect(message).toContain("Until: Oct 9, 10:00 PM PDT (2026-10-10 05:00 UTC)");
    expect(message).toContain("https://forecast.weather.gov/MapClick.php?lat=37.9577&lon=-121.2908");
    expect(message).toContain("https://us-weather-pipeline.vercel.app/forecast?city=stockton-ca");
    expect(message).toContain("you signed up for Heat alerts for Stockton, CA");
  });

  it("strips control characters and caps the NWS instruction", () => {
    const a = { ...alert("h", "Heat Advisory", "Moderate", ["stockton-ca"], "2026-10-08T10:00:00Z", "2026-10-10T05:00:00Z"), instruction: `a\x07b${"x".repeat(2000)}` };
    const { message } = publicAlertMessage({ reason: "New", until: a.ends, alert: a, category: "heat" }, LOCATIONS[0], "https://x.test");
    expect(message).not.toContain("\x07");
    expect(message).toMatch(/What to do: abx{990,}…/);
    expect(message.length).toBeLessThan(2_000);
  });
});

describe("createPublicAlerts: cooldown, cost guard, publishing", () => {
  const change = (reason, city = "stockton-ca", category = "heat") =>
    ({ reason, until: d("2026-10-10T05:00:00Z"), alert: alert(`${reason}-${city}`, "Heat Advisory", "Moderate", [city], "2026-10-08T10:00:00Z", "2026-10-10T05:00:00Z"), cities: [city], category });

  async function setup({ subs = 2, cap = 900, now = NOW, confirmed = null } = {}) {
    const counters = new MemoryCounterStore({ now: () => now });
    for (let i = 0; i < subs; i += 1) await counters.put(`sub#arn:aws:sns:us-east-2:123456789012:p:${i}`, { city: "stockton-ca", categories: ["heat"], created_at: "2026-10-01T00:00:00Z" });
    const publisher = {
      publish: vi.fn(async () => {}),
      confirmedSubscriptionArns: vi.fn(async () => confirmed ?? new Set((await counters.list("sub#")).map((s) => s.key.slice(4)))),
    };
    const notifier = { notify: vi.fn(async () => {}) };
    const run = createPublicAlerts({ publisher, counters, notifier, monthlyCap: cap, cooldownHours: 24, dashboardUrl: "https://dash.test", now: () => now });
    return { counters, publisher, notifier, run };
  }

  it("publishes one message per (city, category, alert) with the attributes, and reserves the matching subscriptions", async () => {
    const { run, publisher, counters } = await setup();
    const summary = await run([change("New")], LOCATIONS);
    expect(summary).toMatchObject({ published: 1, cooldown: 0, noSubscribers: 0, paused: false });
    expect(publisher.publish).toHaveBeenCalledWith(expect.objectContaining({ city: "stockton-ca", category: "heat", subject: expect.stringMatching(/^Stockton, CA: Heat Advisory \(new\)$/) }));
    expect(await counters.increment("emails#2026-10", 0, {})).toBe(2);   // 2 matching subscriptions reserved
  });

  it("re-issue → no message (no change in); no subscribers → nothing sent and no cooldown set", async () => {
    const { run, publisher, counters } = await setup({ subs: 0 });
    expect(await run([], LOCATIONS)).toMatchObject({ published: 0 });
    expect(await run([change("New", "jacksonville-fl", "flood")], LOCATIONS)).toMatchObject({ published: 0, noSubscribers: 1 });
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(await counters.exists("cool#jacksonville-fl#flood")).toBe(false);
  });

  it("24 h cooldown per city + category: a second New/Extended is skipped, Upgraded is always sent", async () => {
    const { run, publisher } = await setup();
    await run([change("New")], LOCATIONS);
    expect(await run([change("Extended")], LOCATIONS)).toMatchObject({ published: 0, cooldown: 1 });
    expect(await run([change("Upgraded")], LOCATIONS)).toMatchObject({ published: 1 });
    expect(publisher.publish).toHaveBeenCalledTimes(2);
  });

  it("cooldown ends after 24 h", async () => {
    const first = await setup();
    await first.run([change("New")], LOCATIONS);
    const later = new MemoryCounterStore({ now: () => d("2026-10-09T17:24:00Z") });
    later.items = first.counters.items;
    expect(await later.exists("cool#stockton-ca#heat")).toBe(false);
  });

  it("cost guard: stops at the monthly cap, publishes nothing more, and tells the owner once (private notifier)", async () => {
    const { run, publisher, notifier, counters } = await setup({ subs: 2, cap: 900 });
    await counters.increment("emails#2026-10", 897, { limit: 900 });   // 3 left; each message needs 2
    const summary = await run([change("New"), change("Upgraded")], LOCATIONS);
    // first message fits (899); the upgrade (not held by the cooldown) would reach 901 → paused
    expect(summary).toMatchObject({ published: 1, paused: true });
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledTimes(1);
    expect(notifier.notify.mock.calls[0][0]).toMatchObject({ level: "warn", title: "Public alert emails paused for 2026-10" });
    // later runs this month: still paused, no second notice
    await run([change("Upgraded")], LOCATIONS);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(notifier.notify).toHaveBeenCalledTimes(1);
  });

  it("the budget resets with the month", async () => {
    const { counters } = await setup({ cap: 900 });
    await counters.increment("emails#2026-10", 900, { limit: 900 });
    const nov = await setup({ cap: 900, now: d("2026-11-01T00:23:00Z") });
    nov.counters.items = new Map([...counters.items]);
    expect(await nov.run([change("New")], LOCATIONS)).toMatchObject({ published: 1, paused: false });
  });

  it("a failed publish is logged, not retried, and keeps its reservation", async () => {
    const { run, publisher, counters } = await setup();
    publisher.publish.mockRejectedValueOnce(Object.assign(new Error("boom"), { name: "InternalError" }));
    expect(await run([change("New")], LOCATIONS)).toMatchObject({ published: 0, failed: 1 });
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(await counters.increment("emails#2026-10", 0, {})).toBe(2);
  });

  it("prunes registry items of subscriptions that are gone after the 30-day pending window", async () => {
    const { run, counters } = await setup({ subs: 0, confirmed: new Set(["arn:keep"]) });
    await counters.put("sub#arn:keep", { city: "stockton-ca", categories: ["heat"], created_at: "2026-08-01T00:00:00Z" });
    await counters.put("sub#arn:gone", { city: "stockton-ca", categories: ["heat"], created_at: "2026-08-01T00:00:00Z" });
    await counters.put("sub#arn:pending", { city: "stockton-ca", categories: ["heat"], created_at: "2026-10-07T00:00:00Z" });
    await run([change("New")], LOCATIONS);
    expect((await counters.list("sub#")).map((s) => s.key).sort()).toEqual(["sub#arn:keep", "sub#arn:pending"]);
  });
});
