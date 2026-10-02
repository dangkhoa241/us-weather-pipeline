import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

// The API (npm start in the repo root) listens on 127.0.0.1:3000; dev and preview servers proxy /api to it,
// so the browser talks to one origin and no CORS is needed.
const API = "http://127.0.0.1:3000";
// Live data for the static demo (Stage 6a part 4): CloudFront in front of the dashboard publisher's files (stack output
// DashboardDataUrl). Not a secret. Must match connect-src in vercel.json. Empty = bundled snapshot only.
const LIVE_DATA_URL = "";

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // `vite build --mode snapshot` (npm run build:snapshot) makes the static demo read public/data/ instead of /api.
  // Set here rather than in a .env.snapshot file, so the repository has no .env files at all.
  define: mode === "snapshot"
    ? { "import.meta.env.VITE_DATA_MODE": JSON.stringify("snapshot"), "import.meta.env.VITE_LIVE_DATA_URL": JSON.stringify(LIVE_DATA_URL) }
    : {},
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // API schemas shared with the backend (src/api/schemas.js): one definition for validation and types.
      "@shared": path.resolve(import.meta.dirname, "../src/api"),
    },
    dedupe: ["zod"],
  },
  server: {
    proxy: { "/api": API },
    // The dev server may read this app plus only the shared API schema files outside it.
    fs: { allow: [import.meta.dirname, path.resolve(import.meta.dirname, "../src/api"), path.resolve(import.meta.dirname, "../src/adapters/warehouse")] },
  },
  preview: { proxy: { "/api": API } },
  // globals: lets React Testing Library clean up the DOM after each test automatically
  test: { globals: true, environment: "jsdom", setupFiles: ["./src/test/setup.ts"], include: ["src/**/*.test.{ts,tsx}"] },
}));
