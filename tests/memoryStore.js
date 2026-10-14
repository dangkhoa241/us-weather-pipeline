// In-memory RawStore for tests: the methods the restore and gap-fill code use, with the small subset of MongoDB
// filters they pass (equality, $in, $ne, $gt, $gte, $lte).

import { RawStore } from "../src/adapters/rawStore/RawStore.js";

const value = (v) => (v instanceof Date ? v.getTime() : v);
const get = (doc, path) => path.split(".").reduce((o, k) => o?.[k], doc);

function matches(doc, filter) {
  return Object.entries(filter).every(([field, cond]) => {
    const v = value(get(doc, field));
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      return Object.entries(cond).every(([op, arg]) => {
        if (op === "$in") return arg.map(value).includes(v);
        if (op === "$ne") return v !== value(arg) && !(arg === null && v === undefined);
        if (op === "$gt") return v != null && v > value(arg);
        if (op === "$gte") return v != null && v >= value(arg);
        if (op === "$lte") return v != null && v <= value(arg);
        throw new Error(`memoryStore: ${op} not supported`);
      });
    }
    return v === value(cond);
  });
}

export class MemoryStore extends RawStore {
  collections = new Map();

  docs(collection) {
    if (!this.collections.has(collection)) this.collections.set(collection, []);
    return this.collections.get(collection);
  }

  keyOf(doc, keyFields) { return keyFields.map((k) => value(doc[k])).join("|"); }

  async insertMissing(collection, docs, keyFields) {
    const all = this.docs(collection);
    const keys = new Set(all.map((d) => this.keyOf(d, keyFields)));
    const totals = { inserted: 0, unchanged: 0 };
    for (const doc of docs) {
      const key = this.keyOf(doc, keyFields);
      if (keys.has(key)) { totals.unchanged += 1; continue; }
      keys.add(key);
      all.push(structuredClone({ ...doc, stored_at: new Date(), first_seen_at: doc.first_seen_at ?? new Date() }));
      totals.inserted += 1;
    }
    return totals;
  }

  async upsertMany(collection, docs, keyFields) {
    const all = this.docs(collection);
    const totals = { inserted: 0, updated: 0, unchanged: 0 };
    for (const doc of docs) {
      const i = all.findIndex((d) => this.keyOf(d, keyFields) === this.keyOf(doc, keyFields));
      if (i < 0) { all.push(structuredClone(doc)); totals.inserted += 1; } else { all[i] = { ...all[i], ...structuredClone(doc) }; totals.updated += 1; }
    }
    return totals;
  }

  async updateMany(collection, filter, fields) {
    let n = 0;
    for (const doc of this.docs(collection).filter((d) => matches(d, filter))) { Object.assign(doc, fields); n += 1; }
    return n;
  }

  async updateOne(collection, filter, fields) {
    const doc = this.docs(collection).find((d) => matches(d, filter));
    if (doc) Object.assign(doc, fields);
  }

  async insertOne(collection, doc) { this.docs(collection).push(structuredClone(doc)); }

  async increment(collection, filter, inc, set = {}) {
    let doc = this.docs(collection).find((d) => matches(d, filter));
    if (!doc) { doc = { ...filter }; this.docs(collection).push(doc); }
    for (const [k, n] of Object.entries(inc)) doc[k] = (doc[k] ?? 0) + n;
    Object.assign(doc, set);
  }

  async find(collection, filter = {}) { return this.docs(collection).filter((d) => matches(d, filter)).map((d) => structuredClone(d)); }

  async findOne(collection, filter = {}) { return (await this.find(collection, filter))[0] ?? null; }

  async *findBatches(collection, filter = {}, { batchSize = 10_000 } = {}) {
    const all = await this.find(collection, filter);
    for (let i = 0; i < all.length; i += batchSize) yield all.slice(i, i + batchSize);
  }

  async count(collection, filter = {}) { return (await this.find(collection, filter)).length; }
}
