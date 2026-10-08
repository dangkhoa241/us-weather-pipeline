// Public email sign-ups (docs/analysis/email-signups.md): config, client-side checks, the request, and the lazy
// Cloudflare Turnstile loader. The server (src/lambda/signup.js) validates everything again; this only gives quick
// feedback. Both config values are public (vite.config.ts); without them the "Get alerts" button is hidden.
import { PUBLIC_CATEGORIES } from "@alerts";
import type { GlossaryKey } from "@/lib/glossary";

export const SIGNUP_URL: string = import.meta.env.VITE_SIGNUP_URL ?? "";
export const TURNSTILE_SITE_KEY: string = import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "";
export const signupEnabled = (url = SIGNUP_URL, key = TURNSTILE_SITE_KEY) => /^https:\/\/[a-z0-9.-]+\/?$/.test(url) && key.length > 0;

export type Category = (typeof PUBLIC_CATEGORIES)[number];
export const CATEGORIES: { id: Category; term: GlossaryKey }[] = [
  { id: "heat", term: "Heat alerts" },
  { id: "flood", term: "Flood alerts" },
  { id: "wind_storm", term: "Wind & storm alerts" },
  { id: "winter", term: "Winter alerts" },
  { id: "fire_air", term: "Fire & air quality alerts" },
  { id: "tropical", term: "Tropical alerts" },
];

export const PRIVACY_NOTE = "Your email address is stored only by Amazon SNS to send these alerts. It isn't shared or used for anything else. "
  + "Your IP address is used in hashed form for one hour to block abuse. Unsubscribe with the link in any email.";

/** Same shape as the server's check, kept simple: the server decides. */
export const looksLikeEmail = (email: string) => email.length <= 254 && /^[^\s@"'<>]+@[^\s@"'<>.]+(\.[^\s@"'<>.]+)+$/.test(email.trim());

export type SignupResult = { ok: boolean; message: string };
const FALLBACK = "Could not reach the sign-up service. Try again later.";

/** POST the sign-up. Only the server's `message` is shown (plain text), never raw error details. */
export async function submitSignup(
  body: { email: string; city: string; categories: Category[]; turnstileToken: string },
  { url = SIGNUP_URL, fetchImpl = fetch, timeoutMs = 10_000 }: { url?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<SignupResult> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, email: body.email.trim() }),
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data: unknown = await res.json().catch(() => null);
    const message = typeof (data as { message?: unknown })?.message === "string" ? (data as { message: string }).message.slice(0, 200) : FALLBACK;
    return { ok: res.ok, message };
  } catch {
    return { ok: false, message: FALLBACK };
  }
}

// ---- Turnstile (loaded only when the form opens; CSP: script-src + frame-src https://challenges.cloudflare.com) ----
type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};
declare global { interface Window { turnstile?: TurnstileApi } }

export const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | null = null;

export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = TURNSTILE_SRC;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile unavailable")));
    script.onerror = () => { loading = null; reject(new Error("Turnstile unavailable")); };
    document.head.appendChild(script);
  });
  return loading;
}
