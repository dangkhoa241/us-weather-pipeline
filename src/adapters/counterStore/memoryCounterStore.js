// In-memory CounterStore (COUNTER_STORE=memory): tests and local runs. Same semantics as the DynamoDB version.

import { CounterStore, expiresAt, isLive } from "./CounterStore.js";

export class MemoryCounterStore extends CounterStore {
  /** @param {{ now?: () => Date }} [options] */
  constructor({ now = () => new Date() } = {}) {
    super();
    this.now = now;
    this.items = new Map();
  }

  #live(key) {
    const item = this.items.get(key);
    return isLive(item, this.now()) ? item : null;
  }

  async increment(key, by, { limit, ttlSec } = {}) {
    const item = this.#live(key);
    const next = (item?.n ?? 0) + by;
    if (limit != null && next > limit) return null;
    this.items.set(key, { ...item, n: next, expires_at: item?.expires_at ?? expiresAt(this.now(), ttlSec) });
    return next;
  }

  async putIfAbsent(key, { ttlSec, fields = {} } = {}) {
    if (this.#live(key)) return false;
    this.items.set(key, { ...fields, expires_at: expiresAt(this.now(), ttlSec) });
    return true;
  }

  async put(key, fields = {}, { ttlSec } = {}) {
    this.items.set(key, { ...fields, expires_at: expiresAt(this.now(), ttlSec) });
  }

  async exists(key) {
    return Boolean(this.#live(key));
  }

  async list(prefix) {
    return [...this.items.keys()].filter((k) => k.startsWith(prefix) && this.#live(k)).map((key) => ({ key, ...this.items.get(key) }));
  }

  async delete(key) {
    this.items.delete(key);
  }
}
