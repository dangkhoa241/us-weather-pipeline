// Factory: picks the RawStore implementation from config (RAW_STORE in .env).

import { config } from "../../config.js";
import { MongoRawStore } from "./mongoRawStore.js";
import { S3RawArchive } from "./s3RawArchive.js";

/**
 * @param {object} [overrides] connection settings, e.g. { uri, db } for a second store (Atlas sync)
 * @param {{ archive?: boolean }} [options] archive: attach RAW_ARCHIVE (default: only without overrides)
 */
export function createRawStore(kind = config.adapters.rawStore, overrides = {}, { archive = !Object.keys(overrides).length } = {}) {
  let store;
  switch (kind) {
    case "mongo":
      store = new MongoRawStore({ ...config.mongo, ...overrides });
      break;
    // case "s3": store = new S3RawStore(config.s3); break;   // optional AWS phase
    default:
      throw new Error(`Unknown RAW_STORE "${kind}". Supported: mongo`);
  }
  // The raw archive belongs to the main store only (not to a second store such as the Atlas sync source);
  // the Lambda passes archive: true because its main store is Atlas.
  if (archive) store.archive = createRawArchive();
  return store;
}

/** RAW_ARCHIVE: none | s3 */
export function createRawArchive(kind = config.adapters.rawArchive) {
  switch (kind) {
    case "none":
      return null;
    case "s3":
      return new S3RawArchive({
        bucket: config.aws.rawArchiveBucket, region: config.aws.region, maxPutsPerDay: config.aws.rawArchiveMaxPutsPerDay,
      });
    default:
      throw new Error(`Unknown RAW_ARCHIVE "${kind}". Supported: none, s3`);
  }
}

export { RawStore } from "./RawStore.js";
