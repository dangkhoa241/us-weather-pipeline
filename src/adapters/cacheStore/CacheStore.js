// CacheStore interface: key/value cache for API responses (Redis now, DynamoDB later).
// Values are plain JSON-serializable objects; implementations handle serialization.

export class CacheStore {
  /** @param {{ optional?: boolean }} [options] optional: keep going without the cache if it is unreachable */
  async connect(options) { throw new Error("CacheStore.connect not implemented"); }

  async close() { throw new Error("CacheStore.close not implemented"); }

  /** @returns {Promise<any|null>} the stored value, or null when missing/expired */
  async get(key) { throw new Error("CacheStore.get not implemented"); }

  /** @param {{ ttlSec?: number }} [options] */
  async set(key, value, options = {}) { throw new Error("CacheStore.set not implemented"); }

  async del(key) { throw new Error("CacheStore.del not implemented"); }

  /** Atomically add `by` to a counter (created at 0). @returns {Promise<number>} the new value */
  async incr(key, by = 1) { throw new Error("CacheStore.incr not implemented"); }

  /** Delete every key that starts with `prefix`. @returns {Promise<number>} keys deleted */
  async clear(prefix) { throw new Error("CacheStore.clear not implemented"); }

  /** Memory used by the cache in bytes and the number of keys (for monitoring and benchmarks). */
  async stats() { throw new Error("CacheStore.stats not implemented"); }

  /** Can the cache be reached? Used by /health. */
  async ping() { throw new Error("CacheStore.ping not implemented"); }
}
