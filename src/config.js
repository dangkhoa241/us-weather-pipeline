// src/config.js
// The ONLY place that reads environment variables. Everything else imports `config`.
// Every variable here must also be listed in .env.example.

import dotenv from "dotenv";

dotenv.config({ quiet: true });

const env = process.env;
const int = (value, fallback) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = Object.freeze({
  pipelineName: env.PIPELINE_NAME || "us-weather-pipeline",
  logLevel: env.LOG_LEVEL || "info",
  // TZ is read by Node itself (process time zone); it is listed in .env.example only.

  adapters: {
    rawStore: env.RAW_STORE || "mongo",
    cacheStore: env.CACHE_STORE || "redis",
    scheduler: env.SCHEDULER || "node-cron",
    notifier: env.NOTIFIER || "console",
    warehouse: env.WAREHOUSE || "clickhouse",
  },

  mongo: {
    uri: env.MONGO_URI || "mongodb://localhost:27017",
    db: env.MONGO_DB || "weather",
  },

  clickhouse: {
    url: env.CLICKHOUSE_URL || "http://localhost:8123",
    user: env.CLICKHOUSE_USER || "weather",
    password: env.CLICKHOUSE_PASSWORD || "weather",
    db: env.CLICKHOUSE_DB || "weather_dw",
  },

  redis: {
    url: env.REDIS_URL || "redis://localhost:6379",
    ttlSec: int(env.REDIS_TTL_SEC, 3600),
  },

  port: int(env.PORT, 3000),

  http: {
    nwsUserAgent: env.NWS_USER_AGENT || "us-weather-pipeline/1.0",
    maxRetries: int(env.HTTP_MAX_RETRIES, 4),
    nwsMinIntervalMs: int(env.NWS_MIN_INTERVAL_MS, 250),
    openMeteoMinIntervalMs: int(env.OPEN_METEO_MIN_INTERVAL_MS, 250),
  },

  stage1: {
    historyYears: int(env.HISTORY_YEARS, 3),
    archiveLagDays: int(env.ARCHIVE_LAG_DAYS, 5),
    forecastCron: env.FORECAST_CRON || "0 */3 * * *",
    alertsCron: env.ALERTS_CRON || "*/15 * * * *",
    historyCron: env.HISTORY_CRON || "30 6 * * *",
    openMeteoForecastModels: (env.OPEN_METEO_FORECAST_MODELS || "best_match,gfs_hrrr,gfs_global,ecmwf_ifs025,icon_global").split(",").map((s) => s.trim()).filter(Boolean),
    openMeteoForecastCron: env.OPEN_METEO_FORECAST_CRON || "0 */3 * * *",
    forecastGapWarnHours: int(env.FORECAST_GAP_WARN_HOURS, 6),
    omBackfillDays: int(env.OM_BACKFILL_DAYS, 90),
    omBackfillModels: (env.OM_BACKFILL_MODELS || "gfs_hrrr,gfs_global,ecmwf_ifs025,icon_global").split(",").map((s) => s.trim()).filter(Boolean),
    omBackfillCron: env.OM_BACKFILL_CRON || "15 * * * *",
    omBaselineCron: env.OM_BASELINE_CRON || "45 6 * * *",
  },

  // Open-Meteo free tier: 600/min, 5,000/hour, 10,000/day weighted calls. Stay well below.
  openMeteoBudget: {
    perHour: int(env.OPEN_METEO_BUDGET_PER_HOUR, 2000),
    perDay: int(env.OPEN_METEO_BUDGET_PER_DAY, 6000),
  },

  discord: {
    webhookUrl: env.DISCORD_WEBHOOK_URL || null,
  },
});
