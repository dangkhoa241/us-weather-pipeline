import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

// The API (npm start in the repo root) listens on 127.0.0.1:3000; dev and preview servers proxy /api to it,
// so the browser talks to one origin and no CORS is needed.
const API = "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // API schemas shared with the backend (src/api/schemas.js): one definition for validation and types.
      "@shared": path.resolve(__dirname, "../src/api"),
    },
    dedupe: ["zod"],
  },
  server: { proxy: { "/api": API }, fs: { allow: [".."] } },
  preview: { proxy: { "/api": API } },
  test: { environment: "jsdom", setupFiles: ["./src/test/setup.ts"], include: ["src/**/*.test.{ts,tsx}"] },
});
