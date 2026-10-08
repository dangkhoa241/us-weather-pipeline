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
    rawArchive: env.RAW_ARCHIVE || "none",     // none | s3: extra copy of raw API responses (Stage 6a part 2)
    counterStore: env.COUNTER_STORE || "memory", // memory | dynamodb: email sign-up counters (Lambda: dynamodb)
  },

  // Public email sign-ups (docs/analysis/email-signups.md). Lambda only; local runs never email subscribers.
  publicAlerts: {
    mode: env.PUBLIC_ALERTS || "off",                          // off | sns
    topicArn: env.PUBLIC_SNS_TOPIC_ARN || null,                // the PUBLIC topic (never the private SNS_TOPIC_ARN)
    monthlyEmailCap: int(env.PUBLIC_EMAIL_MONTHLY_CAP, 900),   // SNS free tier 1,000 emails / month; 100 kept for ops
    cooldownHours: int(env.PUBLIC_ALERT_COOLDOWN_HOURS, 24),   // per city + category; Upgraded is always sent
    dashboardUrl: env.PUBLIC_DASHBOARD_URL || "https://us-weather-pipeline.vercel.app",
  },
  signups: {
    table: env.SIGNUP_TABLE || null,                           // COUNTER_STORE=dynamodb: the DynamoDB table
    subscriberCap: int(env.PUBLIC_SUBSCRIBER_CAP, 100),        // confirmed + pending; SNS allows 200 filter policies / topic
    ipLimitPerHour: int(env.SIGNUP_IP_LIMIT_PER_HOUR, 5),
    dailyLimit: int(env.SIGNUP_DAILY_LIMIT, 20),               // new subscriptions per UTC day (pending ones live 30 days)
    emailCooldownHours: int(env.SIGNUP_EMAIL_COOLDOWN_HOURS, 24),
    allowedHostnames: (env.SIGNUP_ALLOWED_HOSTNAMES || "us-weather-pipeline.vercel.app,localhost").split(",").map((s) => s.trim()).filter(Boolean),
    turnstileSecretParam: env.TURNSTILE_SECRET_SSM_PARAM || null,   // SSM SecureString names (values never in .env)
    hmacKeyParam: env.SIGNUP_HMAC_SSM_PARAM || null,
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
  // Interface the API listens on. 127.0.0.1 = this machine only; use 0.0.0.0 only behind a firewall/proxy.
  host: env.HOST || "127.0.0.1",
  api: {
    rateLimitPerMin: int(env.API_RATE_LIMIT_PER_MIN, 120),   // per client IP
    // Browser origins allowed to call the API (comma-separated). Default: the Vite dev server of the dashboard.
    benchMemoryLog: env.API_BENCH_MEMORY_LOG === "1",   // load test only: print RSS every 250 ms
    corsOrigins: (env.CORS_ORIGINS || "http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean),
  },

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
    openMeteoForecastCron: env.OPEN_METEO_FORECAST_CRON || "40 2,8,14,20 * * *",
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

  // Watcher: run pipeline.js (Stage 1 catch-up → Stage 2 → Stage 3) on this schedule.
  pipelineCron: env.PIPELINE_CRON || "50 */3 * * *",

  // Raw-store retention in days (0 = keep forever). The GitHub Actions workflows set 7 for the free Atlas cluster.
  retentionDays: int(env.RAW_RETENTION_DAYS, 0),

  // Second raw store that GitHub Actions writes NWS data to; sync-atlas copies it into the local store.
  atlas: {
    uri: env.ATLAS_MONGO_URI || null,
    db: env.ATLAS_MONGO_DB || "weather",
    syncCron: env.SYNC_ATLAS_CRON || "40 5 * * *",
    syncWarnDays: int(env.SYNC_WARN_DAYS, 4),   // Atlas keeps 7 days: warn with 3 days to spare
  },

  discord: {
    webhookUrl: env.DISCORD_WEBHOOK_URL || null,
  },

  // AWS (Stage 6, docs/SETUP_AWS.md). Credentials are never configured here: the AWS SDK reads them for AWS_PROFILE
  // from the files in AWS_SHARED_CREDENTIALS_FILE / AWS_CONFIG_FILE (default ~/.aws); it reads those variables itself.
  aws: {
    profile: env.AWS_PROFILE || null,                 // runtime (publish/write only): weather-runtime
    deployProfile: env.AWS_DEPLOY_PROFILE || "weather-dev", // SAM deploys only (scripts/aws.js)
    region: env.AWS_REGION || "us-east-2",
    snsTopicArn: env.SNS_TOPIC_ARN || null,       // output of the weather-pipeline stack (NOTIFIER=sns)
    snsMinLevel: env.SNS_MIN_LEVEL || "warn",      // info | warn | error: lowest level that is emailed
    alertEmail: env.ALERT_EMAIL || null,           // SNS email subscription, passed at deploy time only
    stackName: env.AWS_STACK_NAME || "weather-pipeline",
    rawArchiveBucket: env.RAW_ARCHIVE_BUCKET || null,                       // RAW_ARCHIVE=s3: stack output RawArchiveBucketName
    rawArchiveMaxPutsPerDay: int(env.RAW_ARCHIVE_MAX_PUTS_PER_DAY, 50),     // hard cap (S3 free tier: 2,000 PUTs / month)
    // Lambda only (Stage 6a part 3): SSM SecureString holding the Atlas connection string, read at cold start.
    mongoUriParam: env.MONGO_URI_SSM_PARAM || null,
    // Lambda only (Stage 6a part 4): live dashboard files, written to <bucket>/<prefix> and served by CloudFront.
    dashboardBucket: env.DASHBOARD_BUCKET || null,
    dashboardPrefix: env.DASHBOARD_PREFIX || "dashboard/",
    dashboardMaxPutsPerDay: int(env.DASHBOARD_MAX_PUTS_PER_DAY, 17),   // 8 runs × 2 files + 1 history file
    dashboardRecentDays: int(env.DASHBOARD_RECENT_DAYS, 60),           // days of history in recent.json
  },
});
