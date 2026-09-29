// Factory: picks the Warehouse implementation from config (WAREHOUSE in .env).

import { config } from "../../config.js";
import { ClickHouseWarehouse } from "./clickhouseWarehouse.js";

export function createWarehouse(kind = config.adapters.warehouse) {
  switch (kind) {
    case "clickhouse":
      return new ClickHouseWarehouse(config.clickhouse);
    // case "bigquery": return new BigQueryWarehouse(config.bigquery);   // optional deploy target (free tier)
    default:
      throw new Error(`Unknown WAREHOUSE "${kind}". Supported: clickhouse`);
  }
}

export { Warehouse, TABLES, PERIODS, METRICS } from "./Warehouse.js";
