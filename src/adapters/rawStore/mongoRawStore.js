// MongoDB implementation of RawStore.

import { MongoClient } from "mongodb";
import { RawStore } from "./RawStore.js";

const BATCH_SIZE = 2000;

export class MongoRawStore extends RawStore {
  constructor({ uri, db }) {
    super();
    this.client = new MongoClient(uri);
    this.dbName = db;
    this.db = null;
  }

  async connect() {
    if (!this.db) {
      await this.client.connect();
      this.db = this.client.db(this.dbName);
    }
    return this;
  }

  async close() {
    await this.client.close();
    this.db = null;
  }

  async ensureCollection(collection, { uniqueKey, indexes = [] }) {
    const col = this.db.collection(collection);
    const toSpec = (fields) => Object.fromEntries(fields.map((f) => [f, 1]));
    const uniqueName = `uniq_${uniqueKey.join("_")}`;
    // Drop a unique index left over from an older natural key, or it would reject valid new rows.
    const current = await col.indexes().catch(() => []);   // collection may not exist yet
    for (const idx of current) {
      if (idx.unique && idx.name !== uniqueName) {
        console.warn(`[mongo] ${collection}: dropping outdated unique index ${idx.name}`);
        await col.dropIndex(idx.name);
      }
    }
    await col.createIndex(toSpec(uniqueKey), { unique: true, name: uniqueName });
    for (const fields of indexes) await col.createIndex(toSpec(fields));
  }

  async upsertMany(collection, docs, keyFields) {
    const col = this.db.collection(collection);
    const totals = { inserted: 0, updated: 0, unchanged: 0 };

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const ops = docs.slice(i, i + BATCH_SIZE).map((doc) => {
        const { _id, first_seen_at, ...fields } = doc;
        const filter = Object.fromEntries(keyFields.map((k) => [k, doc[k]]));
        return {
          updateOne: {
            filter,
            // $setOnInsert keeps the time we first saw this record; $set refreshes the rest.
            update: { $set: fields, $setOnInsert: { first_seen_at: first_seen_at ?? new Date() } },
            upsert: true,
          },
        };
      });
      const res = await col.bulkWrite(ops, { ordered: false });
      totals.inserted += res.upsertedCount;
      totals.updated += res.modifiedCount;
      totals.unchanged += res.matchedCount - res.modifiedCount;
    }
    return totals;
  }

  async insertOne(collection, doc) {
    const res = await this.db.collection(collection).insertOne(doc);
    return res.insertedId;
  }

  async increment(collection, filter, inc, set = {}) {
    await this.db.collection(collection).updateOne(filter, { $inc: inc, $set: set }, { upsert: true });
  }

  async updateOne(collection, filter, fields) {
    await this.db.collection(collection).updateOne(filter, { $set: fields });
  }

  async find(collection, filter = {}, { sort, limit, projection } = {}) {
    let cursor = this.db.collection(collection).find(filter, { projection });
    if (sort) cursor = cursor.sort(sort);
    if (limit) cursor = cursor.limit(limit);
    return cursor.toArray();
  }

  async findOne(collection, filter = {}, { sort, projection } = {}) {
    return this.db.collection(collection).findOne(filter, { sort, projection });
  }

  async count(collection, filter = {}) {
    return this.db.collection(collection).countDocuments(filter);
  }
}
