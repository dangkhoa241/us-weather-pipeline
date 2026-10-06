// Bundled fallback for the forecast replay: runs the dashboard's own client (src/lib/replay.ts, loaded through Vite
// so the aliases resolve) against the live Open-Meteo APIs for 3 fixed cities and days, and writes
// public/data/replay-sample.json. 2 requests per city (~4–5 weighted Open-Meteo calls). Non-commercial use.
// Usage: node scripts/buildReplaySample.mjs
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createServer } from "vite";

const SAMPLES = [["stockton-ca", "2026-09-20"], ["chicago-il", "2026-08-15"], ["miami-fl", "2026-07-04"]];
const OUT = new URL("../public/data/replay-sample.json", import.meta.url);

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const { fetchReplay } = await vite.ssrLoadModule("/src/lib/replay.ts");
  const results = [];
  for (const [city, day] of SAMPLES) {
    const r = await fetchReplay(city, day, { now: Date.now(), timeoutMs: 15_000 });
    results.push(r);
    console.log(`${city} ${day}: observed ${r.observed} °C, models ${r.models.map((m) => `${m.id}(${m.leads.length})`).join(" ")}${r.missing.length ? `, missing ${r.missing}` : ""}`);
    await new Promise((ok) => setTimeout(ok, 1000));   // stay gentle with the free API
  }
  const json = JSON.stringify({ format: 1, generated_at: new Date().toISOString(), results });
  writeFileSync(OUT, json + "\n");
  console.log(`wrote ${OUT.pathname}: ${json.length + 1} bytes, ${gzipSync(json).length} gzipped`);
} finally {
  await vite.close();
}
