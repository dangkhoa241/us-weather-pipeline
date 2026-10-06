// Record the README demo GIF (and, with --screenshots, the readme-*.png screenshots) from the static demo build, served
// by `vite preview` under the vercel.json CSP. Free tools only: Playwright + ffmpeg-static.
// Story: US map → click a state → open a city → September → "Replay forecasts" → wait for the Live chart → 2 s pause.
// The replay is live from Open-Meteo (2 requests). Fails on any CSP violation or if the last frame has no real data.
// Usage: npm run build:snapshot && node scripts/recordDemo.mjs [--screenshots]   (writes docs/images/demo.gif)

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { chromium } from "playwright";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const IMAGES = join(ROOT, "docs", "images");
const BASE = "http://127.0.0.1:4175";
const MAX_GIF_MB = 4;
const SCREENSHOTS = process.argv.includes("--screenshots");
const SIZE = { width: 1280, height: 800 };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function scroll(page, px, steps = 12) {
  for (let i = 0; i < steps; i += 1) { await page.mouse.wheel(0, px / steps); await wait(45); }
}
async function moveTo(page, locator, steps = 18) {
  const box = await locator.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps });
}

const preview = spawn("npx", ["vite", "preview", "--port", "4175", "--strictPort", "--host", "127.0.0.1"], { cwd: join(ROOT, "dashboard"), stdio: "ignore", shell: true });
const tmp = mkdtempSync(join(tmpdir(), "uwp-demo-"));
const browser = await chromium.launch();
try {
  for (let i = 0; i < 60; i += 1) { try { if ((await fetch(BASE)).ok) break; } catch { /* not up yet */ } await wait(300); }

  // ---- 1. The GIF ------------------------------------------------------------------------------------------------
  const context = await browser.newContext({ viewport: SIZE, colorScheme: "light", recordVideo: { dir: tmp, size: SIZE } });
  const page = await context.newPage();
  const openMeteo = [];
  page.on("request", (r) => { if (r.url().includes("open-meteo.com")) openMeteo.push(new URL(r.url()).host); });
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => (window.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`)));
  const started = Date.now();
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("[data-map] [data-location]:not([data-loading])").length >= 10, null, { timeout: 30_000 });
  await wait(1500);                                                   // All US KPIs

  await scroll(page, 420);                                            // the map + states table
  await wait(600);
  const state = page.locator('[data-map] [data-state="CA"]');
  await moveTo(page, state);
  await wait(400);
  await state.focus();                                                // Enter = click (the bounding-box center may be
  await page.keyboard.press("Enter");                                 // outside the shape), zooms into California
  await page.waitForFunction(() => document.querySelector("[data-map]")?.getAttribute("data-map-level") === "state", null, { timeout: 10_000 });
  await wait(1500);                                                   // state zoom + city markers

  const city = page.locator('[data-map] [data-location="stockton-ca"]');
  await moveTo(page, city);
  await wait(500);
  await city.click();                                                 // opens the city history and scrolls to it
  await page.waitForSelector('[data-drill-panel] [data-key="09"][role="button"]', { timeout: 15_000 });
  await wait(1300);

  const sept = page.locator("[data-drill-panel] [data-chart]").first().locator('[data-key="09"]');
  await moveTo(page, sept);
  await wait(500);
  await sept.click();                                                 // September: days level, where the replay lives
  const replay = page.getByRole("button", { name: "Replay forecasts" });
  await replay.waitFor({ timeout: 10_000 });
  await wait(1000);
  await moveTo(page, replay);
  await wait(400);
  await replay.click();                                               // live from Open-Meteo
  await page.waitForFunction(() => /^Live/.test(document.querySelector("[data-replay-source]")?.textContent ?? "")
    && document.querySelector("[data-replay-chart] svg") && document.querySelector("[data-replay-insight]"), null, { timeout: 15_000 });
  await page.locator("[data-replay-panel]").evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await wait(800);
  const final = {
    source: await page.locator("[data-replay-source]").textContent(),
    insight: await page.locator("[data-replay-insight]").textContent(),
    day: await page.getByRole("combobox", { name: "Day to replay" }).textContent(),
    models: await page.locator("[data-replay-chart]").getAttribute("data-series"),
  };
  await wait(2000);                                                   // the 2 s pause on the Live chart
  const csp = await page.evaluate(() => window.__csp ?? []);
  console.log(`[demo] ${((Date.now() - started) / 1000).toFixed(1)} s recorded; CSP violations: ${csp.length}; Open-Meteo requests: ${openMeteo.length} (${[...new Set(openMeteo)].join(" ")})`);
  console.log(`[demo] final frame: ${JSON.stringify(final)}`);
  if (csp.length) throw new Error(`CSP violations: ${csp.join("; ")}`);
  if (!/^Live/.test(final.source ?? "") || !/was off by \d/.test(final.insight ?? "") || !(Number(final.models) > 0)) throw new Error("final frame has no live data");

  const video = page.video();
  await context.close();
  const webm = await video.path();
  const gif = join(IMAGES, "demo.gif");
  for (const [fps, width] of [[8, 760], [7, 760], [6, 760]]) {
    const filter = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
    const res = spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-i", webm, "-vf", filter, "-loop", "0", gif], { stdio: "inherit" });
    if (res.status !== 0) throw new Error("ffmpeg failed");
    const mb = statSync(gif).size / 1024 / 1024;
    console.log(`[demo] ${fps} fps, ${width}px → ${mb.toFixed(1)} MB`);
    if (mb < MAX_GIF_MB) break;
  }

  // ---- 2. README screenshots (light + dark), only with --screenshots -------------------------------------------------
  if (!SCREENSHOTS) { console.log("[demo] wrote docs/images/demo.gif (readme-*.png unchanged; pass --screenshots to redo them)"); }
  else {
  const shot = async (scheme, url, file, prepare) => {
    const p = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
    await p.goto(`${BASE}${url}`, { waitUntil: "load" });
    await prepare(p);
    await p.screenshot({ path: join(IMAGES, file) });
    await p.close();
  };
  await shot("light", "/", "readme-overview.png", async (p) => {
    await p.waitForFunction(() => document.querySelectorAll("[data-map] [data-location]:not([data-loading])").length >= 10, null, { timeout: 30_000 });
    await p.evaluate(() => window.scrollTo(0, 0));
    await wait(800);
  });
  await shot("dark", "/?city=phoenix-az&year=2026&month=07", "readme-city-dark.png", async (p) => {
    await p.waitForSelector("[data-drill-panel] [data-chart]", { timeout: 15_000 });
    await p.evaluate(() => { document.querySelector("[data-drill-section]")?.scrollIntoView({ block: "start" }); window.scrollBy(0, -12); });
    await wait(800);
    await p.locator("[data-drill-panel] [data-chart]").first().locator('[data-key="15"]').hover();
    await wait(400);
  });
  await shot("light", "/accuracy", "readme-accuracy.png", async (p) => {
    await p.waitForSelector("[data-leaderboard]", { timeout: 15_000 });
    await wait(1000);
  });
  await shot("dark", "/forecast?city=phoenix-az", "readme-forecast-dark.png", async (p) => {
    await p.waitForSelector("[data-day]", { timeout: 15_000 });
    await wait(1000);
  });
  console.log("[demo] wrote docs/images/demo.gif and readme-*.png");
  }
} finally {
  await browser.close();
  if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(preview.pid)], { stdio: "ignore" });
  preview.kill();
  rmSync(tmp, { recursive: true, force: true });
}
