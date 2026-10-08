// Cloudflare Turnstile server-side check for the sign-up Lambda (free plan, no card).
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
// A token is single-use and valid for 300 s; the widget's hostname and action must be ours.

import { postFormJson } from "./http.js";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_ACTION = "signup";

/**
 * @param {{ secret: string, token: string, remoteIp?: string, allowedHostnames: string[], post?: Function }} input
 *   post: injectable for tests
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>} reason is safe to log (no token, no secret)
 */
export async function verifyTurnstile({ secret, token, remoteIp, allowedHostnames, post = postFormJson }) {
  let out;
  try {
    out = await post(SITEVERIFY_URL, { secret, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) });
  } catch (err) {
    return { ok: false, reason: `siteverify_error:${err?.name ?? "Error"}` };
  }
  if (out?.success !== true) {
    const codes = (Array.isArray(out?.["error-codes"]) ? out["error-codes"] : []).map(String).filter((c) => /^[a-z-]{1,40}$/.test(c));
    return { ok: false, reason: `not_success:${codes.join(",") || "none"}` };
  }
  if (!allowedHostnames.includes(out.hostname)) return { ok: false, reason: "hostname" };
  if (out.action !== TURNSTILE_ACTION) return { ok: false, reason: "action" };
  return { ok: true };
}
