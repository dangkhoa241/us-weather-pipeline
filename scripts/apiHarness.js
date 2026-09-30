// scripts/apiHarness.js
// Start the API (`node backend/server.js`) in a child process for the load test and the security probe, so every
// implementation is measured the same way.

import { spawn } from "node:child_process";

export async function startServer({ port, env = {} }) {
  const child = spawn(process.execPath, ["backend/server.js"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", API_BENCH_MEMORY_LOG: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let peakRss = 0;
  let output = "";
  const onData = (chunk) => {
    const text = chunk.toString();
    for (const m of text.matchAll(/\[mem\] (\{.*?\})/g)) peakRss = Math.max(peakRss, JSON.parse(m[1]).rss);
    output += text.replace(/\[mem\] \{.*?\}\n?/g, "");
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode != null) throw new Error(`server exited:\n${output}`);
    try {
      if ((await fetch(`${base}/api/v1/health`)).status < 500) break;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    base,
    peakRssMb: () => Math.round(peakRss / 1024 / 1024),
    output: () => output,
    stop: () => new Promise((resolve) => { child.once("exit", resolve); child.kill(); }),
  };
}

// The same dashboard requests for every implementation (mirrors the Stage 3 benchmark queries).
export const LOAD_PATHS = [
  "/api/v1/stats?locations=stockton-ca&metric=temp_c&period=day&from=2026-08-25&to=2026-09-23",
  "/api/v1/stats?locations=miami-fl&metric=precip_mm&period=week&from=2026-06-26&to=2026-09-23",
  "/api/v1/stats?locations=new-york-ny,chicago-il,los-angeles-ca&period=month&from=2025-10-01&to=2026-09-23",
  "/api/v1/stats?locations=phoenix-az,denver-co,seattle-wa,houston-tx,boston-ma&period=quarter&from=2024-10-01&to=2026-09-23",
  "/api/v1/map?from=2026-09-17&to=2026-09-23",
  "/api/v1/map?from=2026-08-25&to=2026-09-23",
  "/api/v1/accuracy?from=2026-07-26&to=2026-09-23",
  "/api/v1/accuracy?from=2026-08-25&to=2026-09-23&location=stockton-ca",
  "/api/v1/forecast/stockton-ca",
  "/api/v1/drill?location=miami-fl&level=quarter&key=2025-Q3",
  "/api/v1/records?location=anchorage-ak",
  "/api/v1/locations",
];
