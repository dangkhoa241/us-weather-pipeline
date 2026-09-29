// fetchStocktonWeather.js
// Fetch the past year of hourly weather history for Stockton, CA using Open-Meteo archive
// Usage: `npm run fetch` or `node fetchStocktonWeather.js`

import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const city = "Stockton";
const state = "CA";
const latitude = 37.9575;
const longitude = -121.2925;

// FIX THIS IF YOU REALLY WANT 1 YEAR, RIGHT NOW IT'S 1 DAY:
const hoursBack = 24 * 1; // 1 day; use 24 * 365 for ~1 year

const baseUrl = "https://archive-api.open-meteo.com/v1/archive";
const endDate = new Date();
const startDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

const mongoUri = process.env.MONGO_URI;
const dbName = process.env.MONGO_DB;
const rawCollectionName = process.env.MONGO_COLLECTION_RAW;
const enrichedCollectionName = process.env.MONGO_COLLECTION_ENRICHED;

const formatDate = (d) => d.toISOString().slice(0, 10); // YYYY-MM-DD

function buildUrl() {
  const params = new URLSearchParams({
    latitude: latitude.toString(),
    longitude: longitude.toString(),
    start_date: formatDate(startDate),
    end_date: formatDate(endDate),
    timezone: "America/Los_Angeles",
    hourly: [
      "temperature_2m",
      "relative_humidity_2m",
      "precipitation",
      "wind_speed_10m",
      "wind_gusts_10m"
    ].join(","),
    temperature_unit: "celsius",
    windspeed_unit: "ms",
    precipitation_unit: "mm"
  });

  return `${baseUrl}?${params.toString()}`;
}

async function fetchHourlyHistory() {
  const url = buildUrl();
  const response = await fetch(url, {
    headers: {
      "User-Agent": "us-weather-pipeline/1.0"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
        `Request failed: ${response.status} ${response.statusText} – ${body.slice(
            0,
            500
        )}`
    );
  }

  const data = await response.json();
  return { data, apiRequestId: null };
}

function toNumber(value, fallback = null) {
  return typeof value === "number" ? value : fallback;
}

function combineHourly(data) {
  const hourly = data.hourly || {};
  const times = hourly.time || [];
  const temps = hourly.temperature_2m || [];
  const humidity = hourly.relative_humidity_2m || [];
  const precipitation = hourly.precipitation || [];
  const windSpeed = hourly.wind_speed_10m || [];
  const windGust = hourly.wind_gusts_10m || [];

  const observations = [];
  for (let i = 0; i < times.length; i++) {
    const temperatureC = toNumber(temps[i]);
    const humidityPercent = toNumber(humidity[i]);
    const rainfallMm = toNumber(precipitation[i], 0);
    const windSpeedMps = toNumber(windSpeed[i]);
    const windGustMps = toNumber(windGust[i], 0);

    observations.push({
      timestamp: times[i],
      temperatureC,
      temperatureF: temperatureC == null ? null : temperatureC * (9 / 5) + 32,
      humidityPercent,
      rainfallMm,
      windSpeedMps,
      windGustMps
    });
  }
  return observations;
}

async function saveRawAndEnriched(rawDoc, enrichedDocs) {
  if (!mongoUri || !dbName || !rawCollectionName || !enrichedCollectionName) {
    console.warn(
        "Missing Mongo env vars (MONGO_URI, MONGO_DB, MONGO_COLLECTION_RAW, MONGO_COLLECTION_ENRICHED); skipping DB inserts."
    );
    return;
  }

  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const db = client.db(dbName);

    const rawResult = await db.collection(rawCollectionName).insertOne(rawDoc);
    const enrichedResult = await db
        .collection(enrichedCollectionName)
        .insertMany(enrichedDocs);

    const rawInserted = rawResult.insertedId ? 1 : 0;
    const enrichedInserted =
        enrichedResult.insertedCount ||
        (enrichedResult.insertedIds
            ? Object.keys(enrichedResult.insertedIds).length
            : 0);

    console.log(
        `Inserted ${rawInserted} raw doc into ${dbName}.${rawCollectionName}`
    );
    console.log(
        `Inserted ${enrichedInserted} enriched docs into ${dbName}.${enrichedCollectionName}`
    );
  } finally {
    await client.close();
  }
}

async function main() {
  try {
    const { data, apiRequestId } = await fetchHourlyHistory();
    const observations = combineHourly(data);

    const metadata = {
      source_timestamp: new Date().toISOString(),
      source_database: "open-meteo.com/archive",
      data_quality: "as-provided",
      api_request_id: apiRequestId,
      etl_batch_id: `etl-${Date.now()}`,
      pipeline_name: process.env.PIPELINE_NAME || "us-weather-pipeline"
    };

    console.log(`Observation count: ${observations.length}`);

    console.log(
        JSON.stringify(
            {
              latitude,
              longitude,
              city,
              state,
              start: startDate.toISOString(),
              end: endDate.toISOString(),
              metadata,
              count: observations.length,
              sample: observations.slice(0, 3)
            },
            null,
            2
        )
    );

    const rawDoc = {
      latitude,
      longitude,
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      fetched_at: new Date().toISOString(),
      city,
      state,
      metadata,
      payload: data
    };

    const enrichedDocs = observations.map((obs) => ({
      ...obs,
      location: { city, state },
      metadata
    }));

    await saveRawAndEnriched(rawDoc, enrichedDocs);
  } catch (err) {
    console.error("Error", err);
    process.exitCode = 1;
  }
}

main();