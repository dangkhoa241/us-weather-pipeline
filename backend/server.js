// backend/server.js — start the Stage 4 API (v2: Fastify). Usage: npm start
import { config } from "../src/config.js";
import { createApiDeps } from "../src/api/deps.js";
import { buildApp } from "./app.js";

const deps = await createApiDeps();
const app = await buildApp(deps);
await app.listen({ port: config.port, host: config.host });
console.log(`[api] listening on http://${config.host}:${config.port} (docs: /docs)`);

const shutdown = async () => { await app.close(); await deps.close(); process.exit(0); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
