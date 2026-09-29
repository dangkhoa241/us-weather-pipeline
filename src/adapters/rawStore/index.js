// Factory: picks the RawStore implementation from config (RAW_STORE in .env).

import { config } from "../../config.js";
import { MongoRawStore } from "./mongoRawStore.js";

export function createRawStore(kind = config.adapters.rawStore) {
  switch (kind) {
    case "mongo":
      return new MongoRawStore(config.mongo);
    // case "s3": return new S3RawStore(config.s3);   // optional AWS phase
    default:
      throw new Error(`Unknown RAW_STORE "${kind}". Supported: mongo`);
  }
}

export { RawStore } from "./RawStore.js";
