# US Weather Pipeline

End-to-end data pipeline for US weather forecasts and historical statistics:

```
Weather APIs (NWS, Open-Meteo) → MongoDB (raw) → ClickHouse (warehouse) → Redis (cache) → Express API → Dashboard
```

> Work in progress. See [docs/ROADMAP.md](docs/ROADMAP.md) for the plan and progress.

## Quick start

Requirements: Node.js 18+, Docker Desktop.

```bash
npm install
cp .env.example .env          # then adjust values if needed
docker compose up -d          # MongoDB, ClickHouse, Redis

npm run fetch                 # 1. APIs → MongoDB
npm run etl:clickhouse        # 2. MongoDB → ClickHouse
npm run etl:redis             # 3. ClickHouse → Redis
npm start                     # 4. API + dashboard on http://localhost:3000
```
