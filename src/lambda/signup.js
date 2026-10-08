// AWS Lambda behind a Function URL (AuthType NONE): public email sign-ups for NWS alerts
// (docs/analysis/email-signups.md, section 5). POST {"email","city","categories","turnstileToken"}.
// Cheap checks first, network last: method → size → JSON → validation (no network) → per-IP limit (DynamoDB) →
// Turnstile → subscriber cap → daily limit → monthly email budget → per-email cooldown → SNS Subscribe.
// After the CAPTCHA every outcome that depends on the email address returns the same generic answer, so the endpoint
// never reveals who is subscribed. SNS sends its own confirmation email (double opt-in); nothing else is sent.
// Logs: outcome codes, city and categories only; emails masked; never IPs, tokens, hashes or the raw body.

import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { createCounterStore } from "../adapters/counterStore/index.js";
import { createSubscriptionManager } from "../adapters/notifier/index.js";
import { filterPolicyFor } from "../adapters/notifier/snsPublicTopic.js";
import { CITIES } from "../locations/cities.js";
import { PUBLIC_CATEGORIES } from "../stage1/alertCategories.js";
import { monthKey } from "../stage1/publicAlerts.js";
import { verifyTurnstile } from "../lib/turnstile.js";
import { getSecureParameter } from "./ssmParameter.js";

export const MAX_BODY_BYTES = 2_048;
export const GENERIC = "Check your inbox to confirm.";
const MAX_TOKEN = 2_048;
const KEYS = new Set(["email", "city", "categories", "turnstileToken"]);
const CITY_IDS = new Set(CITIES.map((c) => c.id));
// A practical subset of RFC 5322: one @, no spaces/quotes/control characters, a dotted domain of LDH labels.
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const EMAIL_IN_TEXT = /[^\s@"'<>]+@[^\s@"'<>]+/g;

/** d***@g***.com: first character of the local part and of the domain, plus the last domain label. */
export function maskEmail(email) {
  const [local = "", domain = ""] = String(email).split("@");
  const labels = domain.split(".");
  const tld = labels.length > 1 ? `.${labels.at(-1)}` : "";
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***${tld}`;
}
const scrub = (text) => String(text ?? "").replace(EMAIL_IN_TEXT, (m) => maskEmail(m)).slice(0, 200);

/**
 * Pure validation (no network). Returns { ok: true, value } or { ok: false, message } with a field-level message.
 * `cityIds` / `categories`: injectable for tests.
 */
export function validateSignup(input, { cityIds = CITY_IDS, categories = PUBLIC_CATEGORIES } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((k) => !KEYS.has(k))) {
    return { ok: false, message: "Invalid request." };
  }
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL.test(email)) return { ok: false, message: "Enter a valid email address." };
  if (typeof input.city !== "string" || !cityIds.has(input.city)) return { ok: false, message: "Choose one of the listed cities." };
  const raw = input.categories;
  if (!Array.isArray(raw) || !raw.length || raw.length > categories.length || raw.some((c) => typeof c !== "string" || !categories.includes(c))) {
    return { ok: false, message: "Choose at least one alert type." };
  }
  const cats = categories.filter((c) => raw.includes(c));   // de-duplicated, fixed order
  if (typeof input.turnstileToken !== "string" || !input.turnstileToken || input.turnstileToken.length > MAX_TOKEN) {
    return { ok: false, message: "Verification is missing. Please try again." };
  }
  return { ok: true, value: { email, city: input.city, categories: cats, token: input.turnstileToken } };
}

const json = (statusCode, message) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  body: JSON.stringify({ message }),
});

/** Dependencies and limits are injectable for tests. */
export function createSignupHandler({
  getParameter = getSecureParameter,
  makeCounters = createCounterStore,
  makeSubscriptions = createSubscriptionManager,
  verifyCaptcha = verifyTurnstile,
  now = () => new Date(),
  limits = {
    ipPerHour: config.signups.ipLimitPerHour, perDay: config.signups.dailyLimit, subscriberCap: config.signups.subscriberCap,
    emailCooldownHours: config.signups.emailCooldownHours, monthlyEmailCap: config.publicAlerts.monthlyEmailCap,
    allowedHostnames: config.signups.allowedHostnames,
  },
  params = { turnstileSecret: config.signups.turnstileSecretParam, hmacKey: config.signups.hmacKeyParam },
} = {}) {
  let secrets = null;     // cached across warm invocations
  let counters = null;
  let subscriptions = null;
  const log = (outcome, extra = "") => console.log(`[signup] ${outcome}${extra ? ` ${extra}` : ""}`);

  async function loadSecrets() {
    if (!secrets) {
      const [turnstileSecret, hmacKey] = await Promise.all([getParameter(params.turnstileSecret), getParameter(params.hmacKey)]);
      secrets = { turnstileSecret, hmacKey };
    }
    return secrets;
  }

  return async function handler(event) {
    // 1. Cheap checks, no network: method, size (before decoding/parsing), content type, JSON, fields.
    const http = event?.requestContext?.http ?? {};
    if (http.method !== "POST") return json(405, "Method not allowed.");
    const raw = typeof event?.body === "string" ? event.body : "";
    if (raw.length > (event.isBase64Encoded ? Math.ceil(MAX_BODY_BYTES / 3) * 4 : MAX_BODY_BYTES)) {
      log("too_large");
      return json(413, "Request too large.");
    }
    const body = event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) { log("too_large"); return json(413, "Request too large."); }
    const contentType = String(event.headers?.["content-type"] ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) return json(415, "Send JSON.");
    let input;
    try { input = JSON.parse(body); } catch { return json(400, "Invalid request."); }
    const valid = validateSignup(input);
    if (!valid.ok) { log("invalid"); return json(400, valid.message); }
    const { email, city, categories, token } = valid.value;
    const ip = typeof http.sourceIp === "string" ? http.sourceIp : "";
    if (!ip) return json(400, "Invalid request.");

    try {
      const { turnstileSecret, hmacKey } = await loadSecrets();
      const hash = (value) => createHmac("sha256", hmacKey).update(value).digest("hex").slice(0, 32);
      counters ??= makeCounters();
      subscriptions ??= makeSubscriptions();
      const at = now();
      const iso = at.toISOString();

      // 2. Per-IP limit (counts every valid-looking attempt, before the CAPTCHA call).
      const hour = iso.slice(0, 13).replace(/\D/g, "");
      if (await counters.increment(`ip#${hash(ip)}#${hour}`, 1, { limit: limits.ipPerHour, ttlSec: 7_200 }) == null) {
        log("rate_limited");
        return json(429, "Too many attempts. Try again later.");
      }

      // 3. CAPTCHA, verified server-side.
      const captcha = await verifyCaptcha({ secret: turnstileSecret, token, remoteIp: ip, allowedHostnames: limits.allowedHostnames });
      if (!captcha.ok) {
        log("captcha_failed", `(${captcha.reason})`);
        // Our stored secret is wrong (not the visitor's fault): re-read SSM next time, so a corrected parameter takes
        // effect without waiting for a cold start.
        if (/invalid-input-secret/.test(captcha.reason)) secrets = null;
        return json(400, "Verification failed. Please try again.");
      }

      // 4. Limits that don't depend on the email address (so their answers reveal nothing about subscribers).
      if (await subscriptions.count() >= limits.subscriberCap) { log("full"); return json(503, "Sign-ups are full right now."); }
      if (await counters.increment(`day#${iso.slice(0, 10).replace(/\D/g, "")}`, 1, { limit: limits.perDay, ttlSec: 2 * 86_400 }) == null) {
        log("daily_limit");
        return json(503, "Sign-ups are paused for today. Try again tomorrow.");
      }
      // The SNS confirmation email counts against the same monthly budget as the alert emails.
      if (await counters.increment(`emails#${monthKey(at)}`, 1, { limit: limits.monthlyEmailCap, ttlSec: 40 * 86_400 }) == null) {
        log("email_budget");
        return json(503, "Sign-ups are paused for now. Try again later.");
      }

      // 5. From here on: the same generic answer whatever happens.
      if (!(await counters.putIfAbsent(`email#${hash(email)}`, { ttlSec: limits.emailCooldownHours * 3_600 }))) {
        log("email_cooldown", maskEmail(email));
        return json(200, GENERIC);
      }
      try {
        const arn = await subscriptions.subscribe(email, filterPolicyFor(city, categories));
        // Registry for the email budget (no address stored); pruned by the collector once gone.
        if (typeof arn === "string" && arn.startsWith("arn:")) await counters.put(`sub#${arn}`, { city, categories, created_at: iso });
        log("ok", `${maskEmail(email)} city=${city} categories=${categories.join(",")}`);
      } catch (err) {
        // e.g. InvalidParameter "Subscription already exists with different attributes": existing ones are never changed.
        log("subscribe_failed", `${maskEmail(email)} (${err?.name ?? "Error"}: ${scrub(err?.message)})`);
      }
      return json(200, GENERIC);
    } catch (err) {
      secrets = null;   // re-read next time (a parameter may have been rotated)
      console.error(`[signup] error (${err?.name ?? "Error"}: ${scrub(err?.message)})`);
      return json(503, "Something went wrong. Try again later.");
    }
  };
}

export const handler = createSignupHandler();
