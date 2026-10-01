// Root tests (pipeline, cache, API). The dashboard has its own Vitest config in dashboard/.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["tests/**/*.test.js"] } });
