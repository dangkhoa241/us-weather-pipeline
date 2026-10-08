import { describe, it, expect, vi, beforeEach } from "vitest";
import { ListSubscriptionsByTopicCommand, SubscribeCommand } from "@aws-sdk/client-sns";
import { GENERIC, MAX_BODY_BYTES, createSignupHandler, maskEmail, validateSignup } from "../src/lambda/signup.js";
import { MemoryCounterStore } from "../src/adapters/counterStore/memoryCounterStore.js";
import { SnsSubscriptionManager } from "../src/adapters/notifier/snsPublicTopic.js";
import { verifyTurnstile } from "../src/lib/turnstile.js";

const NOW = new Date("2026-10-08T17:30:00Z");
const PUBLIC = "arn:aws:sns:us-east-2:123456789012:weather-pipeline-public-alerts";
const PRIVATE = "arn:aws:sns:us-east-2:123456789012:weather-pipeline-alerts";
const IP = "203.0.113.7";
const EMAIL = "Visitor.Name@Example.com";
const LIMITS = { ipPerHour: 5, perDay: 20, subscriberCap: 100, emailCooldownHours: 24, monthlyEmailCap: 900, allowedHostnames: ["us-weather-pipeline.vercel.app", "localhost"] };
const PARAMS = { turnstileSecret: "/weather-pipeline/turnstile-secret", hmacKey: "/weather-pipeline/signup-hmac-key" };

const request = (body, { ip = IP, method = "POST", contentType = "application/json", base64 = false } = {}) => {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return {
    requestContext: { http: { method, sourceIp: ip } },
    headers: { "content-type": contentType },
    body: base64 ? Buffer.from(raw).toString("base64") : raw,
    isBase64Encoded: base64,
  };
};
const valid = (extra = {}) => ({ email: EMAIL, city: "stockton-ca", categories: ["heat"], turnstileToken: "tok-123", ...extra });
const message = (res) => JSON.parse(res.body).message;

function setup({ existing = 0, captcha = { ok: true }, subscribe } = {}) {
  const counters = new MemoryCounterStore({ now: () => NOW });
  const snsSend = vi.fn(async (cmd) => {
    if (cmd instanceof ListSubscriptionsByTopicCommand) return { Subscriptions: Array.from({ length: existing }, (_, i) => ({ SubscriptionArn: `${PUBLIC}:${i}` })) };
    if (cmd instanceof SubscribeCommand) return subscribe ? subscribe(cmd) : { SubscriptionArn: `${PUBLIC}:new-1` };
    throw new Error("unexpected");
  });
  const subscriptions = new SnsSubscriptionManager({ topicArn: PUBLIC, privateTopicArn: PRIVATE, region: "us-east-2", client: { send: snsSend } });
  const getParameter = vi.fn(async (name) => (name.endsWith("hmac-key") ? "k".repeat(64) : "turnstile-secret-value"));
  const verifyCaptcha = vi.fn(async () => captcha);
  const makeCounters = vi.fn(() => counters);
  const handler = createSignupHandler({ getParameter, makeCounters, makeSubscriptions: () => subscriptions, verifyCaptcha, now: () => NOW, limits: LIMITS, params: PARAMS });
  const subscribeCalls = () => snsSend.mock.calls.map(([c]) => c).filter((c) => c instanceof SubscribeCommand);
  return { handler, counters, snsSend, getParameter, verifyCaptcha, makeCounters, subscribeCalls };
}

let logs;
beforeEach(() => {
  vi.restoreAllMocks();
  logs = [];
  for (const level of ["log", "warn", "error"]) vi.spyOn(console, level).mockImplementation((...a) => logs.push(a.join(" ")));
});

describe("validateSignup (pure, no network)", () => {
  const cityIds = new Set(["stockton-ca", "miami-fl"]);
  it("normalizes the email and orders/de-duplicates categories", () => {
    expect(validateSignup(valid({ categories: ["flood", "heat", "flood"] }), { cityIds })).toEqual({
      ok: true, value: { email: "visitor.name@example.com", city: "stockton-ca", categories: ["heat", "flood"], token: "tok-123" },
    });
  });
  it.each([
    [{ email: "no-at-sign" }, /email/], [{ email: "a b@example.com" }, /email/], [{ email: "a@localhost" }, /email/],
    [{ email: `${"a".repeat(65)}@example.com` }, /email/], [{ email: 42 }, /email/],
    [{ city: "paris-fr" }, /cities/], [{ city: ["stockton-ca"] }, /cities/],
    [{ categories: [] }, /alert type/], [{ categories: ["test"] }, /alert type/], [{ categories: "heat" }, /alert type/],
    [{ categories: ["heat", "sms"] }, /alert type/],
    [{ turnstileToken: "" }, /Verification/], [{ turnstileToken: "x".repeat(2049) }, /Verification/],
    [{ extra: 1 }, /Invalid request/],
  ])("rejects %j", (patch, pattern) => {
    const res = validateSignup(valid(patch), { cityIds });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(pattern);
  });
  it("rejects non-objects", () => {
    for (const input of [null, [], "x", 1]) expect(validateSignup(input, { cityIds }).ok).toBe(false);
  });
});

describe("sign-up handler: cheap rejections happen before any network call", () => {
  it.each([
    ["GET", request(valid(), { method: "GET" }), 405],
    ["oversized body", request(`{"email":"${"a".repeat(MAX_BODY_BYTES)}"}`), 413],
    ["oversized base64 body", request(`{"email":"${"a".repeat(MAX_BODY_BYTES)}"}`, { base64: true }), 413],
    ["wrong content type", request(valid(), { contentType: "text/plain" }), 415],
    ["bad JSON", request("{nope"), 400],
    ["invalid email", request(valid({ email: "nope" })), 400],
    ["unknown city", request(valid({ city: "atlantis-xx" })), 400],
    ["owner-only test category", request(valid({ categories: ["test"] })), 400],
    ["missing source IP", request(valid(), { ip: "" }), 400],
  ])("%s → %i, no SSM / DynamoDB / Turnstile / SNS", async (_name, event, status) => {
    const s = setup();
    const res = await s.handler(event);
    expect(res.statusCode).toBe(status);
    expect(s.getParameter).not.toHaveBeenCalled();
    expect(s.makeCounters).not.toHaveBeenCalled();
    expect(s.verifyCaptcha).not.toHaveBeenCalled();
    expect(s.snsSend).not.toHaveBeenCalled();
  });
});

describe("sign-up handler: limits, CAPTCHA, generic answer", () => {
  it("valid sign-up → SNS email subscription with the filter policy, registry item without the address, generic answer", async () => {
    const s = setup();
    const res = await s.handler(request(valid({ categories: ["flood", "heat"] })));
    expect(res.statusCode).toBe(200);
    expect(message(res)).toBe(GENERIC);
    expect(res.headers).toMatchObject({ "content-type": "application/json", "cache-control": "no-store" });
    const [sub] = s.subscribeCalls();
    expect(sub.input).toEqual({
      TopicArn: PUBLIC, Protocol: "email", Endpoint: "visitor.name@example.com", ReturnSubscriptionArn: true,
      Attributes: { FilterPolicy: JSON.stringify({ city: ["stockton-ca"], category: ["heat", "flood"] }), FilterPolicyScope: "MessageAttributes" },
    });
    expect(s.verifyCaptcha).toHaveBeenCalledWith(expect.objectContaining({ secret: "turnstile-secret-value", token: "tok-123", remoteIp: IP }));
    const items = [...s.counters.items.entries()];
    expect(items.find(([k]) => k === `sub#${PUBLIC}:new-1`)[1]).toMatchObject({ city: "stockton-ca", categories: ["heat", "flood"], created_at: NOW.toISOString() });
    expect(JSON.stringify(items)).not.toMatch(/example\.com|visitor|203\.0\.113/i);   // only hashes and ARNs stored
    expect(await s.counters.increment("emails#2026-10", 0, {})).toBe(1);             // confirmation email reserved
  });

  it("CAPTCHA failure → 400, nothing subscribed", async () => {
    const s = setup({ captcha: { ok: false, reason: "not_success:invalid-input-response" } });
    const res = await s.handler(request(valid()));
    expect(res.statusCode).toBe(400);
    expect(message(res)).toBe("Verification failed. Please try again.");
    expect(s.subscribeCalls()).toEqual([]);
    expect(logs.join("\n")).toContain("captcha_failed (not_success:invalid-input-response)");
  });

  it("per-IP rate limit: 5 attempts per hour, the 6th → 429 before the CAPTCHA call", async () => {
    const s = setup();
    for (let i = 0; i < 5; i += 1) expect((await s.handler(request(valid({ email: `user${i}@example.com` })))).statusCode).toBe(200);
    const res = await s.handler(request(valid({ email: "user9@example.com" })));
    expect(res.statusCode).toBe(429);
    expect(s.verifyCaptcha).toHaveBeenCalledTimes(5);
    expect((await s.handler(request(valid({ email: "other@example.com" }), { ip: "198.51.100.1" }))).statusCode).toBe(200);
  });

  it("subscriber cap: 100 subscriptions (confirmed + pending) → 503 full, nothing subscribed", async () => {
    const s = setup({ existing: 100 });
    const res = await s.handler(request(valid()));
    expect(res.statusCode).toBe(503);
    expect(message(res)).toBe("Sign-ups are full right now.");
    expect(s.subscribeCalls()).toEqual([]);
    expect((await setup({ existing: 99 }).handler(request(valid()))).statusCode).toBe(200);
  });

  it("daily limit of new subscriptions and the monthly email budget → 503 paused", async () => {
    const s = setup();
    await s.counters.increment("day#20261008", 20, { limit: 20 });
    expect(message(await s.handler(request(valid())))).toBe("Sign-ups are paused for today. Try again tomorrow.");
    const b = setup();
    await b.counters.increment("emails#2026-10", 900, { limit: 900 });
    expect(message(await b.handler(request(valid())))).toBe("Sign-ups are paused for now. Try again later.");
    expect([...s.subscribeCalls(), ...b.subscribeCalls()]).toEqual([]);
  });

  it("generic answer whether or not the email exists: repeat within 24 h, SNS 'already exists', other SNS errors", async () => {
    const repeat = setup();
    const first = await repeat.handler(request(valid()));
    const again = await repeat.handler(request(valid({ email: "  VISITOR.name@example.COM " })));
    expect(repeat.subscribeCalls()).toHaveLength(1);   // 24 h per-email cooldown: no second confirmation email
    const exists = setup({ subscribe: () => { throw Object.assign(new Error("Invalid parameter: Attributes Reason: Subscription already exists with different attributes"), { name: "InvalidParameterException" }); } });
    const existsRes = await exists.handler(request(valid({ categories: ["flood"] })));
    const broken = setup({ subscribe: () => { throw Object.assign(new Error("Endpoint visitor.name@example.com rejected"), { name: "InternalErrorException" }); } });
    const brokenRes = await broken.handler(request(valid()));
    for (const res of [first, again, existsRes, brokenRes]) {
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(JSON.stringify({ message: GENERIC }));
    }
  });

  it("an existing subscription is never changed (no SetSubscriptionAttributes, no Unsubscribe)", async () => {
    const s = setup();
    await s.handler(request(valid()));
    const names = s.snsSend.mock.calls.map(([c]) => c.constructor.name);
    expect(new Set(names)).toEqual(new Set(["ListSubscriptionsByTopicCommand", "SubscribeCommand"]));
  });

  it("logs outcome codes with a masked email only: never the address, IP, token, secret or HMAC key", async () => {
    const s = setup({ subscribe: () => { throw Object.assign(new Error("Endpoint visitor.name@example.com rejected"), { name: "InternalErrorException" }); } });
    await s.handler(request(valid()));
    await setup().handler(request(valid()));
    const text = logs.join("\n");
    expect(text).toContain("[signup] subscribe_failed v***@e***.com");
    expect(text).toContain("[signup] ok v***@e***.com city=stockton-ca categories=heat");
    for (const secret of ["visitor.name", "example.com", IP, "tok-123", "turnstile-secret-value", "kkkkkkkk"]) expect(text).not.toContain(secret);
  });

  it("an unexpected AWS error → 503 without details, and the secrets are re-read next time", async () => {
    const s = setup();
    s.counters.increment = vi.fn(async () => { throw Object.assign(new Error("Rate exceeded"), { name: "ProvisionedThroughputExceededException" }); });
    const res = await s.handler(request(valid()));
    expect(res.statusCode).toBe(503);
    expect(message(res)).toBe("Something went wrong. Try again later.");
    await s.handler(request(valid()));
    expect(s.getParameter).toHaveBeenCalledTimes(4);
  });
});

describe("maskEmail", () => {
  it("keeps the first character of each part and the top-level domain", () => {
    expect(maskEmail("visitor.name@example.com")).toBe("v***@e***.com");
    expect(maskEmail("x@y")).toBe("x***@y***");
  });
});

describe("verifyTurnstile (mocked siteverify)", () => {
  const base = { secret: "s", token: "t", remoteIp: IP, allowedHostnames: ["us-weather-pipeline.vercel.app", "localhost"] };
  it("accepts success from our hostname with the signup action", async () => {
    const post = vi.fn(async () => ({ success: true, hostname: "us-weather-pipeline.vercel.app", action: "signup" }));
    expect(await verifyTurnstile({ ...base, post })).toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith("https://challenges.cloudflare.com/turnstile/v0/siteverify", { secret: "s", response: "t", remoteip: IP });
  });
  it.each([
    [{ success: false, "error-codes": ["timeout-or-duplicate"] }, "not_success:timeout-or-duplicate"],
    [{ success: false, "error-codes": ["<script>"] }, "not_success:none"],
    [{ success: true, hostname: "evil.example", action: "signup" }, "hostname"],
    [{ success: true, hostname: "localhost", action: "login" }, "action"],
  ])("rejects %j", async (answer, reason) => {
    expect(await verifyTurnstile({ ...base, post: async () => answer })).toEqual({ ok: false, reason });
  });
  it("fails closed on a network error or timeout", async () => {
    const post = async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); };
    expect(await verifyTurnstile({ ...base, post })).toEqual({ ok: false, reason: "siteverify_error:TimeoutError" });
  });
});
