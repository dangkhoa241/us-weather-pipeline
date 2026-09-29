import { createClient } from "@clickhouse/client";
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB = process.env.MONGO_DB;
const MONGO_COLLECTION_ENRICHED = process.env.MONGO_COLLECTION_ENRICHED;

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL;

const ch = createClient({
  host: CLICKHOUSE_URL,
});

async function createTables() {
  console.log("Ensuring ClickHouse tables exist...");

  await ch.query({ query: `CREATE DATABASE IF NOT EXISTS weather_dw` });

  await ch.query({
    query: `
      CREATE TABLE IF NOT EXISTS weather_dw.daily_weather
      (
          -- Core weather data
          date Date,
          temperatureC Float32,
          temperatureF Float32,
          humidityPercent Float32,
          rainfallMm Float32,
          windSpeedMps Float32,
          windGustMps Float32,

          -- Location fields
          city String,
          state String,

          -- MongoDB metadata (source metadata)
          source_timestamp DateTime,
          source_database String,
          data_quality String,
          api_request_id String,
          etl_batch_id String,
          pipeline_name String,

          -- ClickHouse metadata (warehouse metadata)
          warehouse_load_time DateTime,
          rows_loaded UInt32,
          sync_interval_min UInt16,
          load_mode LowCardinality(String)
      )
      ENGINE = MergeTree()
      PARTITION BY toYYYYMM(date)
      ORDER BY (city, date)
    `,
  });

  console.log("ClickHouse tables are ready.");
}

async function incrementalSync() {
  console.log("\nStarting INCREMENTAL sync (MongoDB → ClickHouse)...");

  const mongo = new MongoClient(MONGO_URI);
  await mongo.connect();

  const db = mongo.db(MONGO_DB);
  const enriched = db.collection(MONGO_COLLECTION_ENRICHED);

  console.log(`Connected to DB: ${MONGO_DB}`);
  console.log(`Using collection: ${MONGO_COLLECTION_ENRICHED}`);

  const docs = await enriched.find({}).toArray();
  console.log(`Loaded ${docs.length} MongoDB documents`);

  if (docs.length === 0) {
    console.log("No documents found. Stopping.");
    return;
  }

  function toCHDateTime(ts) {
    if (!ts) return null;
    return ts.replace("T", " ").replace("Z", "").split(".")[0];
  }

  function gmtToClickHouseDateTime(gmtString) {
    if (!gmtString) return null;

    const d = new Date(gmtString);

    if (isNaN(d.getTime())) return null;

    return d.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
  }

  const nowCH = toCHDateTime(new Date().toISOString());

  const rows = docs.map((d) => ({
    date: d.timestamp.slice(0, 10),
    temperatureC: d.temperatureC,
    temperatureF: d.temperatureF,
    humidityPercent: d.humidityPercent,
    rainfallMm: d.rainfallMm,
    windSpeedMps: d.windSpeedMps,
    windGustMps: d.windGustMps,

    city: d.location.city,
    state: d.location.state,

    source_timestamp: gmtToClickHouseDateTime(d.metadata?.source_timestamp),
    source_database: d.metadata?.source_database,
    data_quality: d.metadata?.data_quality,
    api_request_id: d.metadata?.api_request_id ?? "",
    etl_batch_id: d.metadata?.etl_batch_id,
    pipeline_name: d.metadata?.pipeline_name ?? "",

    warehouse_load_time: nowCH,
    rows_loaded: 1,
    sync_interval_min: 60,
    load_mode: "incremental",
  }));

  await ch.insert({
    table: "weather_dw.daily_weather",
    values: rows,
    format: "JSONEachRow",
  });

  console.log("Incremental load completed into daily_weather.");
  await mongo.close();
}

async function updateMonthlyAgg() {
  console.log("Updating monthly_agg analytics table...");

  await ch.query({
    query: `
      CREATE TABLE IF NOT EXISTS weather_dw.monthly_agg
      (
          city String,
          month Date,
          avg_temp_c Float32,
          total_rain_mm Float32,

          warehouse_load_time DateTime,
          rows_loaded UInt32,
          load_mode LowCardinality(String),
          sync_interval_min UInt16
      )
      ENGINE = MergeTree()
      PARTITION BY toYYYYMM(month)
      ORDER BY (city, month)
    `,
  });

  await ch.query({
    query: `
      INSERT INTO weather_dw.monthly_agg
      SELECT
        city,
        toStartOfMonth(date) AS month,
        avg(temperatureC) AS avg_temp_c,
        sum(rainfallMm) AS total_rain_mm,
        now() AS warehouse_load_time,
        count(*) AS rows_loaded,
        'incremental' AS load_mode,
        0 AS sync_interval_min
      FROM weather_dw.daily_weather
      GROUP BY city, month
      ORDER BY month
    `,
  });

  console.log("monthly_agg updated successfully.");
}

async function main() {
  await createTables();
  await incrementalSync();
  await updateMonthlyAgg();
  console.log("\nETL PIPELINE COMPLETED SUCCESSFULLY\n");
}

main().catch(console.error);
