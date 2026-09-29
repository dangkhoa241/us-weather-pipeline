// CacheStore interface: key/value cache for API responses (Redis now, DynamoDB later).
// Values are plain JSON-serializable objects; implementations handle serialization.

export class CacheStore {
  async connect() { throw new Error("CacheStore.connect not implemented"); }

  async close() { throw new Error("CacheStore.close not implemented"); }

  /** @returns {Promise<any|null>} the stored value, or null when missing/expired */
  async get(key) { throw new Error("CacheStore.get not implemented"); }

  /** @param {{ ttlSec?: number }} [options] */
  async set(key, value, options = {}) { throw new Error("CacheStore.set not implemented"); }

  async del(key) { throw new Error("CacheStore.del not implemented"); }

  /** Can the cache be reached? Used by /health. */
  async ping() { throw new Error("CacheStore.ping not implemented"); }
}
