// RawStore interface: where raw and staged documents live (MongoDB now, S3 later).
// Pipeline code only calls these methods; it never imports a database driver.

export class RawStore {
  /** Open connections. */
  async connect() { throw new Error("RawStore.connect not implemented"); }

  /** Close connections. Safe to call more than once. */
  async close() { throw new Error("RawStore.close not implemented"); }

  /**
   * Make sure a collection exists with a unique natural key and optional extra indexes.
   * @param {string} collection
   * @param {{ uniqueKey: string[], indexes?: string[][], retention?: { field: string, days: number } }} spec
   *        retention: delete documents `days` after the date in `field` (data retention on free tiers)
   */
  async ensureCollection(collection, spec) { throw new Error("RawStore.ensureCollection not implemented"); }

  /**
   * Insert or update documents by their natural key (idempotent: re-running never duplicates).
   * @returns {Promise<{ inserted: number, updated: number, unchanged: number }>}
   */
  async upsertMany(collection, docs, keyFields) { throw new Error("RawStore.upsertMany not implemented"); }

  /** Insert one document (e.g. a run log entry). */
  async insertOne(collection, doc) { throw new Error("RawStore.insertOne not implemented"); }

  /**
   * Atomically add to numeric fields of the document matched by `filter` (created if missing).
   * @param {object} inc     e.g. { calls: 1.5 }
   * @param {object} [set]   fields to set at the same time
   */
  async increment(collection, filter, inc, set = {}) { throw new Error("RawStore.increment not implemented"); }

  /** Update one document matched by `filter` with the given fields. */
  async updateOne(collection, filter, fields) { throw new Error("RawStore.updateOne not implemented"); }

  /**
   * Find documents.
   * @param {object} filter  equality filter, e.g. { location_id: "stockton-ca" }
   * @param {{ sort?: object, limit?: number, projection?: object }} [options]
   */
  async find(collection, filter = {}, options = {}) { throw new Error("RawStore.find not implemented"); }

  async findOne(collection, filter = {}, options = {}) { throw new Error("RawStore.findOne not implemented"); }

  async count(collection, filter = {}) { throw new Error("RawStore.count not implemented"); }
}
