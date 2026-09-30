// Redis implementation of CacheStore.

import { createClient } from "redis";
import { CacheStore } from "./CacheStore.js";

export class RedisCacheStore extends CacheStore {
  constructor({ url, ttlSec }) {
    super();
    this.defaultTtlSec = ttlSec;
    this.client = createClient({ url });
    this.client.on("error", (err) => console.error("[redis]", err.message));
  }

  async connect() {
    if (!this.client.isOpen) await this.client.connect();
    return this;
  }

  async close() {
    if (this.client.isOpen) await this.client.quit();
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
