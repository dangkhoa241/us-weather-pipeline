# Pipeline image (Stage 1 fetcher now; later stages can reuse it with a different command).
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY fetchWeather.js pipeline.js etlToClickHouse.js clickhouseToRedis.js ./

# Run as the image's non-root user.
USER node

CMD ["node", "fetchWeather.js", "--watch"]
