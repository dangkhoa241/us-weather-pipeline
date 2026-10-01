// Measure the built dashboard's US map in headless Chromium (same procedure for every map implementation):
// time to first map render, drill-down (state → city → location filter), keyboard/label accessibility, screenshot.
// Each UsMap marks its root with data-map (data-map-level="us"|"state") and calls performance.mark("map-ready")
// after its first paint. Usage: npm run build && node scripts/measureMap.mjs <label>

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const label = process.argv[2] ?? "unnamed";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const APP = "http://127.0.0.1:4173/";
const RUNS = 5;

async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up`);
}

const procs = [
  spawn(process.execPath, ["backend/server.js"], { cwd: ROOT, env: { ...process.env, PORT: "3000", API_RATE_LIMIT_PER_MIN: "100000" }, stdio: "ignore" }),
  spawn("npx", ["vite", "preview", "--port", "4173", "--strictPort", "--host", "127.0.0.1"], { cwd: `${ROOT}/dashboard`, stdio: "ignore", shell: true }),
];
const browser = await chromium.launch();
try {
  await waitFor("http://127.0.0.1:3000/api/v1/health");
  await waitFor(APP);
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

  // 1. First render: navigation start → map-ready mark, median of several loads (API cache warm after the first).
  const times = [];
  for (let i = 0; i < RUNS; i += 1) {
    await page.goto(APP, { waitUntil: "load" });
    await page.waitForFunction(() => performance.getEntriesByName("map-ready").length > 0, null, { timeout: 30_000 });
    times.push(await page.evaluate(() => performance.getEntriesByName("map-ready")[0].startTime));
  }
  times.sort((a, b) => a - b);

  // 2. Accessibility: focusable and labelled map elements.
  const a11y = await page.evaluate(() => {
    const map = document.querySelector("[data-map]");
    const focusable = map ? map.querySelectorAll('[tabindex="0"], a[href], button').length : 0;
    const labelled = map ? map.querySelectorAll("[aria-label]").length : 0;
    return { focusable, labelled, role: map?.getAttribute("role") ?? null, mapLabel: map?.getAttribute("aria-label") ?? null };
  });

  // 3. Keyboard drill-down: Tab into the map, Enter on the first focused region.
  let keyboardDrill = false;
  if (a11y.focusable > 0) {
    await page.locator('[data-map] [tabindex="0"]').first().focus();
    await page.keyboard.press("Enter");
    keyboardDrill = (await page.getAttribute("[data-map]", "data-map-level")) === "state";
    await page.goto(APP, { waitUntil: "load" });
    await page.waitForFunction(() => performance.getEntriesByName("map-ready").length > 0);
  }

  // 4. Mouse drill-down: click California, then the Stockton marker; the location filter must change.
  const box = await page.locator("[data-map]").boundingBox();
  const ca = page.locator('[data-map] [data-state="CA"]');
  if (await ca.count()) await ca.first().click();
  else {
    // Maps drawn without a DOM element per state expose the state's pixel position instead.
    const pos = await page.evaluate(() => window.__mapStatePixel?.("CA") ?? null);
    if (pos) await page.mouse.click(box.x + pos[0], box.y + pos[1]);
  }
  await page.waitForTimeout(800);
  const mouseDrill = (await page.getAttribute("[data-map]", "data-map-level")) === "state";
  const marker = page.locator('[data-map] [data-location="los-angeles-ca"]');
  let citySelect = false;
  if (await marker.count()) {
    await marker.first().click();
  } else {
    const pos = await page.evaluate(() => window.__mapCityPixel?.("los-angeles-ca") ?? null);   // canvas maps expose marker pixels
    if (pos) await page.mouse.click(box.x + pos[0], box.y + pos[1]);
  }
  await page.waitForTimeout(500);
  citySelect = new URL(page.url()).searchParams.get("loc") === "los-angeles-ca";
  mkdirSync(`${ROOT}/docs/images`, { recursive: true });
  await page.locator("[data-map]").screenshot({ path: `${ROOT}/docs/images/map-${label}-drilled.png` });

  // 5. Full-page screenshot at the default view.
  await page.goto(APP, { waitUntil: "load" });
  await page.waitForFunction(() => performance.getEntriesByName("map-ready").length > 0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${ROOT}/docs/images/dashboard-${label}.png`, fullPage: true });

  const result = {
    label,
    first_render_ms_median: Math.round(times[Math.floor(times.length / 2)]),
    first_render_ms_all: times.map(Math.round),
    mouse_drill_to_state: mouseDrill,
    select_city_from_marker: citySelect,
    keyboard_drill: keyboardDrill,
    ...a11y,
  };
  console.log(JSON.stringify(result, null, 2));
  mkdirSync(`${ROOT}/docs/analysis/data`, { recursive: true });
  writeFileSync(`${ROOT}/docs/analysis/data/map-${label}-browser.json`, JSON.stringify({ ...result, measured_at: new Date() }, null, 2));
} finally {
  await browser.close();
  for (const p of procs) p.kill();
  if (process.platform === "win32") spawn("taskkill", ["/F", "/T", "/PID", String(procs[1].pid)], { stdio: "ignore" });
}
