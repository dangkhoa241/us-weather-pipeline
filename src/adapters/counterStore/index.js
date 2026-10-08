// Factory: picks the CounterStore implementation from config (COUNTER_STORE in .env).

import { config } from "../../config.js";
import { MemoryCounterStore } from "./memoryCounterStore.js";
import { DynamoCounterStore } from "./dynamoCounterStore.js";

export function createCounterStore(kind = config.adapters.counterStore) {
  switch (kind) {
    case "memory":
      return new MemoryCounterStore();
    case "dynamodb":
      return new DynamoCounterStore({ table: config.signups.table, region: config.aws.region });
    default:
      throw new Error(`Unknown COUNTER_STORE "${kind}". Supported: memory, dynamodb`);
  }
}

export { CounterStore } from "./CounterStore.js";
