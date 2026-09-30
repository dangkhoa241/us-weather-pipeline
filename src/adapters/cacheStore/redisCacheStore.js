// Redis implementation of CacheStore.

import { createClient } from "redis";
import { CacheStore } from "./CacheStore.js";

const CONNECT_TIMEOUT_MS = 2000;

export class RedisCacheStore extends CacheStore {
  constructor({ url, ttlSec }) {
    super();
    this.defaultTtlSec = ttlSec;
    this.client = createClient({
      url,
      // Fail fast while disconnected instead of queueing commands until Redis returns (callers then fall back
      // to the warehouse); keep reconnecting in the background.
      disableOfflineQueue: true,
      socket: { connectTimeout: CONNECT_TIMEOUT_MS, reconnectStrategy: (retries) => Math.min(250 * 2 ** retries, 10_000) },
    });
    this.lastError = null;
    this.client.on("error", (err) => {
      const text = err.message || err.code || err.errors?.[0]?.code || String(err);   // ECONNREFUSED has no message
      if (text !== this.lastError) console.error("[redis]", text);   // log each new problem once
      this.lastError = text;
    });
    this.client.on("ready", () => { this.lastError = null; });
  }

  /**
   * @param {{ optional?: boolean }} [options] optional: don't throw if Redis is unreachable; keep reconnecting in
   *        the background and let commands fail fast until it is back (for readers that can skip the cache).
   */
  async connect({ optional = false } = {}) {
    if (this.client.isOpen) return this;
    const connecting = this.client.connect();
    connecting.catch(() => {});   // failures are reported through the "error" event
    let timer;
    try {
      await Promise.race([connecting, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Redis not reachable within ${CONNECT_TIMEOUT_MS} ms`)), CONNECT_TIMEOUT_MS);
      })]);
    } catch (err) {
      if (!optional) {
        await this.close();
        throw err;
      }
      console.warn(`[redis] ${err.message}; continuing without cache, reconnecting in the background`);
    } finally {
      clearTimeout(timer);
    }
    return this;
  }

  async close() {
    if (this.client.isReady) await this.client.quit();
    else if (this.client.isOpen) await this.client.disconnect();
  }

  async get(key) {
    const raw = await this.client.get(key);
    return raw == null ? null : JSON.parse(raw);
  }

  async set(key, value, { ttlSec = this.defaultTtlSec } = {}) {
    const options = ttlSec > 0 ? { EX: ttlSec } : undefined;
    await this.client.set(key, JSON.stringify(value), options);
  }

  async del(key) {
    await this.client.del(key);
  }

  async incr(key, by = 1) {
    return this.client.incrBy(key, by);
  }

  async clear(prefix) {
    let deleted = 0;
    for await (const keys of this.client.scanIterator({ MATCH: `${prefix}*`, COUNT: 500 })) {
      const batch = Array.isArray(keys) ? keys : [keys];   // redis v4 yields keys one by one, v5 in arrays
      if (batch.length) deleted += await this.client.del(batch);
    }
    return deleted;
  }

  async stats() {
    const info = await this.client.info("memory");
    const usedBytes = Number(/used_memory:(\d+)/.exec(info)?.[1] ?? NaN);
    return { usedBytes, keys: await this.client.dbSize() };
  }

  async ping() {
    return (await this.client.ping()) === "PONG";
  }
}
