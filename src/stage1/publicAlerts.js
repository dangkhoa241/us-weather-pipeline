// src/stage1/publicAlerts.js
// Public subscriber emails for NWS alerts (docs/analysis/email-signups.md, sections 3, 4 and 7).
// Input: the per-category changes of an alerts run (categoryChanges in nwsAlerts.js). For each (city, category, alert):
// 1. cooldown: at most one email per city + category per PUBLIC_ALERT_COOLDOWN_HOURS, except "Upgraded";
// 2. no matching subscription → nothing is sent;
// 3. cost guard: reserve the matching subscriptions on the monthly email counter (≤ PUBLIC_EMAIL_MONTHLY_CAP); when
//    full, publish nothing more this month and tell the owner once, through the PRIVATE notifier;
// 4. publish one message with `city` + `category` attributes; SNS filter policies pick the subscribers.
// A failed publish is logged, not retried (no duplicate emails); its reservation stays (safe over-count).

import { CATEGORY_LABELS, DISCLAIMER } from "./alertCategories.js";

const MONTH_TTL_SEC = 40 * 86_400;
const REGISTRY_GRACE_MS = 31 * 86_400_000;   // SNS deletes unconfirmed email subscriptions after 30 days
const MAX_HEADLINE = 300;
const MAX_INSTRUCTION = 1_000;

export const monthKey = (now) => now.toISOString().slice(0, 7);

/** Plain text from NWS: no control characters except newlines, collapsed blank lines, length-capped. */
const clean = (text, max) => {
  const s = String(text ?? "").replace(/\r\n?/g, "\n").replace(/[^\S\n]+/g, " ").replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "")
    .replace(/\n{3,}/g, "\n\n").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const ascii = (text) => text.replace(/[→–—]/g, "-").replace(/[^\x20-\x7E]/g, "").replace(/ {2,}/g, " ").trim();

function localTime(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date);
}
const utcTime = (date) => `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Subject + body of one subscriber email. `location`: { id, name, state, lat, lon, timezone }. */
export function publicAlertMessage({ reason, until, alert, category }, location, dashboardUrl) {
  const place = `${location.name}, ${location.state}`;
  const untilLocal = until ? localTime(until, location.timezone) : null;
  const why = reason === "Extended" ? `extended to ${untilLocal ?? "a later time"}` : reason.toLowerCase();
  const subjectText = ascii(`${place}: ${alert.event} (${why})`);
  const subject = subjectText.length > 100 ? `${subjectText.slice(0, 97)}...` : subjectText;
  const lines = [
    DISCLAIMER,
    "",
    `${alert.event} for ${place} (${why})`,
    `Severity: ${alert.severity ?? "Unknown"}`,
    until ? `Until: ${untilLocal} (${utcTime(until)})` : "Until: not given by NWS",
  ];
  const headline = clean(alert.headline, MAX_HEADLINE);
  const instruction = clean(alert.instruction, MAX_INSTRUCTION);
  if (headline) lines.push("", headline);
  if (instruction) lines.push("", `What to do: ${instruction}`);
  lines.push(
    "",
    `Forecast and all alerts for this area: https://forecast.weather.gov/MapClick.php?lat=${location.lat.toFixed(4)}&lon=${location.lon.toFixed(4)}`,
    `Dashboard: ${dashboardUrl}/forecast?city=${location.id}`,
    "",
    `You get this email because you signed up for ${CATEGORY_LABELS[category] ?? category} alerts for ${place} at ${dashboardUrl}.`,
    DISCLAIMER,
  );
  return { subject, message: lines.join("\n") };
}

/**
 * Drop registry items of subscriptions that are gone (unsubscribed, or unconfirmed past SNS's 30 days). Pending
 * subscriptions are listed without an ARN, so an item is only removed once it is older than the 30-day window.
 */
async function pruneRegistry(registry, publisher, counters, now) {
  let confirmed;
  try {
    confirmed = await publisher.confirmedSubscriptionArns();
  } catch (err) {
    console.warn(`[alerts:public] could not list subscriptions (${err?.name ?? "Error"}); registry not pruned`);
    return registry;
  }
  const kept = [];
  for (const item of registry) {
    const arn = item.key.slice("sub#".length);
    const old = now.getTime() - Date.parse(item.created_at ?? 0) > REGISTRY_GRACE_MS;
    if (!confirmed.has(arn) && old) await counters.delete(item.key);
    else kept.push(item);
  }
  return kept;
}

/**
 * @param {{ publisher: { publish: Function, confirmedSubscriptionArns: Function }, counters: import("../adapters/counterStore/CounterStore.js").CounterStore,
 *           notifier: { notify: Function }, monthlyCap: number, cooldownHours: number, dashboardUrl: string, now?: () => Date }} deps
 *   notifier: the PRIVATE notifier (owner only), used for the "paused" notice.
 * @returns {(changes: object[], locations: object[]) => Promise<object>} called by fetchAlerts
 */
export function createPublicAlerts({ publisher, counters, notifier, monthlyCap, cooldownHours, dashboardUrl, now = () => new Date() }) {
  return async function publishPublicAlerts(changes, locations) {
    const summary = { published: 0, cooldown: 0, noSubscribers: 0, failed: 0, paused: false };
    if (!changes.length) return summary;
    const at = now();
    const byId = new Map(locations.map((l) => [l.id, l]));
    const registry = await pruneRegistry(await counters.list("sub#"), publisher, counters, at);

    outer: for (const change of changes) {
      for (const city of change.cities) {
        const location = byId.get(city);
        if (!location) continue;
        const { category } = change;
        const coolKey = `cool#${city}#${category}`;
        if (change.reason !== "Upgraded" && await counters.exists(coolKey)) { summary.cooldown += 1; continue; }
        const matching = registry.filter((s) => s.city === city && s.categories?.includes(category)).length;
        if (!matching) { summary.noSubscribers += 1; continue; }

        const month = monthKey(at);
        const reserved = await counters.increment(`emails#${month}`, matching, { limit: monthlyCap, ttlSec: MONTH_TTL_SEC });
        if (reserved == null) {
          summary.paused = true;
          if (await counters.putIfAbsent(`paused#${month}`, { ttlSec: MONTH_TTL_SEC })) {
            await notifier.notify({
              level: "warn",
              title: `Public alert emails paused for ${month}`,
              message: `The ${monthlyCap}-email monthly budget for subscriber alerts is reached (SNS free tier: 1,000 emails / month). `
                + "Subscriber emails resume next month; your own pipeline emails are not affected.",
            });
          }
          break outer;
        }

        try {
          await publisher.publish({ city, category, ...publicAlertMessage({ ...change, category }, location, dashboardUrl) });
          await counters.put(coolKey, {}, { ttlSec: cooldownHours * 3600 });
          summary.published += 1;
        } catch (err) {
          summary.failed += 1;
          console.error(`[alerts:public] publish failed for ${city}/${category} (${err?.name ?? "Error"})`);
        }
      }
    }
    console.log(`[alerts:public] ${changes.length} change(s), subscriptions ${registry.length}`, summary);
    return summary;
  };
}
