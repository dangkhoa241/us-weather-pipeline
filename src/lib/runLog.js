// src/lib/runLog.js
// One `pipeline_runs` document per stage run: batch id, counts, duration, status, errors.

import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { COLLECTIONS } from "../collections.js";

const RUNS = COLLECTIONS.pipelineRuns.name;
const MAX_ERRORS = 50;

export class RunLog {
  /**
   * @param {import("../adapters/rawStore/RawStore.js").RawStore} store
   * @param {{ stage: string, mode: string }} info
   */
  constructor(store, { stage, mode }) {
    this.store = store;
    this.stage = stage;
    this.mode = mode;
    this.etlBatchId = `${stage}-${mode}-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
    this.counts = { rows_fetched: 0, inserted: 0, updated: 0, unchanged: 0 };
    this.errors = [];
    this.skipped = [];   // expected gaps (e.g. a model that doesn't cover a location); not errors
  }

  async start() {
    this.startedAt = new Date();
    await this.store.insertOne(RUNS, {
      etl_batch_id: this.etlBatchId,
      pipeline: config.pipelineName,
      stage: this.stage,
      mode: this.mode,
      status: "running",
      started_at: this.startedAt,
    });
    return this;
  }

  /** Add the result of one fetch + upsert. */
  add(rowsFetched, { inserted = 0, updated = 0, unchanged = 0 } = {}) {
    this.counts.rows_fetched += rowsFetched;
    this.counts.inserted += inserted;
    this.counts.updated += updated;
    this.counts.unchanged += unchanged;
  }

  error(locationId, err) {
    console.error(`[${this.stage}:${this.mode}] ${locationId ?? "-"}: ${err.message}`);
    if (this.errors.length < MAX_ERRORS) this.errors.push({ location_id: locationId ?? null, message: err.message });
  }

  skip(locationId, reason) {
    if (this.skipped.length < MAX_ERRORS) this.skipped.push({ location_id: locationId ?? null, reason });
  }

  /** @param {Error} [fatal] an error that stopped the whole run */
  async finish(fatal) {
    if (fatal) this.error(null, fatal);
    const finishedAt = new Date();
    const status = fatal ? "failed" : this.errors.length ? "partial" : "success";
    const summary = {
      status,
      finished_at: finishedAt,
      duration_ms: finishedAt - this.startedAt,
      ...this.counts,
      error_count: this.errors.length,
      errors: this.errors,
      skipped_count: this.skipped.length,
      skipped: this.skipped,
    };
    await this.store.updateOne(RUNS, { etl_batch_id: this.etlBatchId }, summary);
    return { etl_batch_id: this.etlBatchId, stage: this.stage, mode: this.mode, ...summary, errors: undefined, skipped: undefined };
  }
}
