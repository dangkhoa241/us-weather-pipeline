// CounterStore interface: small shared counters and flags with expiry, for the public email sign-ups
// (rate limits, the monthly email budget, cooldowns, the subscription registry). COUNTER_STORE picks the
// implementation: memory (tests, local) or dynamodb (Lambda). Keys are strings like "ip#<hmac>#2026100817".
// Expiry: every item may carry `expires_at` (Unix seconds). An expired item counts as absent even before the store
// deletes it (DynamoDB TTL deletes within ~48 h).

export class CounterStore {
  /**
   * Atomically add `by` to the counter `key` unless the result would exceed `limit`.
   * @returns {Promise<number|null>} the new value, or null when the limit would be exceeded (nothing changed)
   */
  async increment(key, by, { limit, ttlSec }) { throw new Error("not implemented"); }

  /** Create `key` unless a live (unexpired) item exists. @returns {Promise<boolean>} true if created */
  async putIfAbsent(key, { ttlSec, fields } = {}) { throw new Error("not implemented"); }

  /** Create or replace `key`. */
  async put(key, fields = {}, { ttlSec } = {}) { throw new Error("not implemented"); }

  /** True if a live item exists. */
  async exists(key) { throw new Error("not implemented"); }

  /** Live items whose key starts with `prefix`: [{ key, ...fields }]. Small sets only (≤ a few hundred items). */
  async list(prefix) { throw new Error("not implemented"); }

  async delete(key) { throw new Error("not implemented"); }
}

export const expiresAt = (now, ttlSec) => (ttlSec ? Math.floor(now.getTime() / 1000) + ttlSec : undefined);
export const isLive = (item, now) => Boolean(item) && (item.expires_at == null || item.expires_at > Math.floor(now.getTime() / 1000));
