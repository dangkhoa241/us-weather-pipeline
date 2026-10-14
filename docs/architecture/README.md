# Architecture

One engineering doc per component or group: purpose, requirements, design, alternatives, failure handling,
security, numbers (each with its source) and where it lives in the code. The "Read more" links on the
[/how-it-works](https://us-weather-pipeline.vercel.app/how-it-works) page point here. Why each big choice was made:
[DESIGN_DECISIONS.md](../DESIGN_DECISIONS.md). How to deploy a part from scratch: the `SETUP_*` and `DEPLOY_*` guides
in [docs/](../).

| Doc | Covers | Diagram parts |
|---|---|---|
| [ingestion.md](ingestion.md) | Stage 1 fetcher, Open-Meteo jobs, API budget, MongoDB raw store, S3 archive copy | Open-Meteo, MongoDB (raw) |
| [nws-collector.md](nws-collector.md) | NWS collection on Lambda, EventBridge schedules, Atlas buffer, sync home | NWS API, NWS collector, MongoDB Atlas, EventBridge |
| [warehouse-etl.md](warehouse-etl.md) | Stage 2: incremental ETL into ClickHouse, rollups, quarantine | ClickHouse |
| [cache.md](cache.md) | Stage 3: versioned Redis cache, pre-warm, single-flight | Redis |
| [api.md](api.md) | Stage 4: Hono API, validation, OpenAPI, headers, rate limit | Hono API |
| [live-publishing.md](live-publishing.md) | Publisher Lambda, S3 bucket, CloudFront | Publisher, S3, CloudFront |
| [dashboard.md](dashboard.md) | React site on Vercel, bundled snapshot, live overlay, CSP | Dashboard |
| [alerts-and-signups.md](alerts-and-signups.md) | Owner and subscriber emails, sign-up function, DynamoDB, Turnstile | SNS (owner), SNS (subscribers), Sign-up, DynamoDB, Turnstile |
| [security.md](security.md) | Secret scanning, IAM users and boundary, secrets, public-data checks | — |
