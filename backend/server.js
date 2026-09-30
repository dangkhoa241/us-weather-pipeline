// backend/server.js — start the Stage 4 API (v1: Express). Usage: npm start
import { config } from "../src/config.js";
import { createApiDeps } from "../src/api/deps.js";
import { createApp } from "./app.js";

const deps = await createApiDeps();
const server = createApp(deps).listen(config.port, config.host, () => {
  console.log(`[api] listening on http://${config.host}:${config.port} (docs: /docs)`);
});

const shutdown = () => server.close(async () => { await deps.close(); process.exit(0); });
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
