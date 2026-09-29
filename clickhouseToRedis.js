// clickhouseToRedis.js
// ClickHouse -> Redis ETL (ESM)
// Reads monthly_agg from ClickHouse and caches Stockton monthly aggregates in Redis with TTL.

import dotenv from "dotenv";
import { createClient as createCHClient } from "@clickhouse/client";
import { createClient as createRedisClient } from "redis";

dotenv.config();

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const REDIS_TTL_SEC = parseInt(process.env.REDIS_TTL_SEC || "3600", 10);

const ch = createCHClient({
    host: CLICKHOUSE_URL
});

const redis = createRedisClient({
    url: REDIS_URL
});

async function fetchMonthlyAggFromClickHouse() {
    console.log("Fetching monthly aggregates from ClickHouse...");

    const resultSet = await ch.query({
        query: `
      SELECT
        city,
        month,
        avg_temp_c,
        total_rain_mm,
        warehouse_load_time,
        rows_loaded,
        load_mode,
        sync_interval_min
      FROM weather_dw.monthly_agg
      ORDER BY city, month
    `,
        format: "JSONEachRow"
    });

    const rows = await resultSet.json();
    console.log(`Loaded ${rows.length} rows from weather_dw.monthly_agg`);
    return rows;
}

async function cacheToRedis(rows) {
    await redis.connect();

    const nowIso = new Date().toISOString();

    // Filter for Stockton only – adjust if needed
    const stocktonRows = rows.filter((r) => r.city === "Stockton");

    const payload = {
        city: "Stockton",
        metric: "monthly_agg",
        data: stocktonRows,
        metadata: {
            cache_timestamp: nowIso,
            data_version: `v${Date.now()}`,
            refresh_interval_sec: REDIS_TTL_SEC
        }
    };

    const redisKey = `weather:stockton:monthly`;

    await redis.set(redisKey, JSON.stringify(payload), {
        EX: REDIS_TTL_SEC
    });

    console.log(
        `Cached ${stocktonRows.length} rows into Redis key "${redisKey}" with TTL=${REDIS_TTL_SEC}s`
    );

    await redis.quit();
}

async function main() {
    try {
        const rows = await fetchMonthlyAggFromClickHouse();
        if (!rows.length) {
            console.warn("No rows in monthly_agg – nothing to cache.");
            return;
        }
        await cacheToRedis(rows);
    } finally {
        await ch.close();
    }
}

main().catch((err) => {
    console.error("ClickHouse -> Redis ETL failed:", err);
    process.exit(1);
});