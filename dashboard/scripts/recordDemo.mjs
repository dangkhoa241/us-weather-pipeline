// Record the README demo GIF and screenshots from the static demo build (free tools only: Playwright + ffmpeg-static).
// Story: All US overview → click a city → drill into a month → Accuracy page → dark mode.
// Usage: npm run build:snapshot && node scripts/recordDemo.mjs   (writes docs/images/demo.gif and readme-*.png)

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpeg from "ffmpeg-static";
import { chromium } from "playwright";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const IMAGES = join(ROOT, "docs", "images");
const BASE = "http://127.0.0.1:4175";
const MAX_GIF_MB = 8;
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
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("[data-map] [data-location]:not([data-loading])").length >= 10, null, { timeout: 30_000 });
  await wait(1500);                                                   // All US KPIs

  await scroll(page, 420);                                            // the map + states table
  await wait(600);
  for (const st of ["CA", "TX", "FL"]) { await moveTo(page, page.locator(`[data-map] [data-state="${st}"]`)); await wait(350); }
  const city = page.locator('[data-map] [data-location="phoenix-az"]');
  await moveTo(page, city);
  await wait(500);
  await city.click();                                                 // opens the city history and scrolls to it
  await page.waitForSelector('[data-drill-panel] [data-key="07"][role="button"]', { timeout: 15_000 });
  await wait(1400);

  const july = page.locator("[data-drill-panel] [data-chart]").first().locator('[data-key="07"]');
  await moveTo(page, july);
  await wait(700);
  await july.click();                                                 // drill into July: both charts switch to days
  await wait(1300);
  await moveTo(page, page.locator("[data-drill-panel] [data-chart]").first().locator('[data-key="15"]'), 25);
  await wait(1200);                                                   // synced crosshair on both charts

  await page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Accuracy" }).click();
  await page.waitForSelector("[data-leaderboard]", { timeout: 15_000 });
  await wait(1800);                                                   // hero + leaderboard
  await scroll(page, 700, 16);
  await wait(1500);                                                   // error vs lead day, bias by month
  await scroll(page, 650, 16);
  await wait(1300);                                                   // best model per state
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await wait(900);

  const theme = page.locator("header button[aria-label*='theme']");
  await theme.click();                                                // System → Light
  await wait(250);
  await theme.click();                                                // Light → Dark
  await wait(1800);
  await scroll(page, 700, 16);
  await wait(1500);

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

  // ---- 2. README screenshots (light + dark) -----------------------------------------------------------------------
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
} finally {
  await browser.close();
  if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(preview.pid)], { stdio: "ignore" });
  preview.kill();
  rmSync(tmp, { recursive: true, force: true });
}
