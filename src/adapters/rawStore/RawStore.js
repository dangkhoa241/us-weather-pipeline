// RawStore interface: where raw and staged documents live (MongoDB now, S3 later).
// Pipeline code only calls these methods; it never imports a database driver.

export class RawStore {
  /** Optional extra copy of raw API responses (RAW_ARCHIVE=s3: S3RawArchive); set by the factory. */
  archive = null;

  /** Keep a raw API response for the archive (no-op without RAW_ARCHIVE). Uploaded by flushRawResponses(). */
  addRawResponse(source, url, body) { this.archive?.add(source, url, body); }

  /** Upload the run's raw responses to the archive. Never throws: the archive must not break the pipeline. */
  async flushRawResponses(batchId) { await this.archive?.flush(this, batchId); }

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
   * Every written document gets `stored_at` (when it last arrived in this store), used by Stage 2's incremental load.
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

  /**
   * Stream matching documents in arrays of up to `batchSize` (for collections too big to load at once).
   * @returns {AsyncGenerator<object[]>}
   */
  async *findBatches(collection, filter = {}, { batchSize = 10_000, projection } = {}) {
    throw new Error("RawStore.findBatches not implemented");
  }

  /** Can the store be reached? Used by /health. */
  async ping() { throw new Error("RawStore.ping not implemented"); }

  async count(collection, filter = {}) { throw new Error("RawStore.count not implemented"); }
}
