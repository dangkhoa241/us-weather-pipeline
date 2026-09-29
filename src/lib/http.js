// src/lib/http.js
// All external HTTP goes through here: User-Agent header, per-API rate limit, retry with backoff.

import { config } from "../config.js";

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
const TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}${body ? ` - ${body.slice(0, 300)}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

/** Keeps at least `minIntervalMs` between request starts. Calls are queued in order. */
export class RateLimiter {
  constructor(minIntervalMs) {
    this.minIntervalMs = minIntervalMs;
    this.next = 0;
  }

  async wait() {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.minIntervalMs;
    if (at > now) await sleep(at - now);
  }
}

/** Seconds or HTTP-date from a Retry-After header, in ms. */
function retryAfterMs(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function backoffMs(attempt) {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return exp / 2 + Math.random() * (exp / 2);   // jitter
}

/**
 * GET a URL and parse JSON. Retries network errors and 408/429/5xx; other 4xx fail at once.
 * @param {string|URL} url
 * @param {{ limiter?: RateLimiter, headers?: object, maxRetries?: number }} [options]
 */
export async function getJson(url, { limiter, headers = {}, maxRetries = config.http.maxRetries } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    await limiter?.wait();
    let delay;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": config.http.nwsUserAgent, Accept: "application/json", ...headers },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return await res.json();

      const body = await res.text().catch(() => "");
      if (!RETRY_STATUS.has(res.status) || attempt >= maxRetries) throw new HttpError(res.status, url, body);
      delay = retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(attempt);
      console.warn(`[http] ${res.status} ${url} - retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms`);
    } catch (err) {
      if (err instanceof HttpError || attempt >= maxRetries) throw err;
      delay = backoffMs(attempt);
      console.warn(`[http] ${err.message} ${url} - retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms`);
    }
    await sleep(delay);
  }
}

// One limiter per API, shared by every caller in the process.
export const limiters = Object.freeze({
  nws: new RateLimiter(config.http.nwsMinIntervalMs),
  openMeteo: new RateLimiter(config.http.openMeteoMinIntervalMs),
});

export const nwsGet = (url, options = {}) =>
  getJson(url, { limiter: limiters.nws, headers: { Accept: "application/geo+json" }, ...options });

export const openMeteoGet = (url, options = {}) => getJson(url, { limiter: limiters.openMeteo, ...options });
