// Measure the city drill-down chart in headless Chromium (same procedure for every chart implementation):
// time to first render, mouse and keyboard drill-down (months → days), breadcrumb back, accessibility counts,
// screenshots. The chart marks performance "drill-chart-ready"; the drill panel is [data-drill-panel].
// Charts without one DOM element per point expose window.__chartPointPixel(key) instead.
// Usage: npm run build && node scripts/measureDrill.mjs <label>

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const label = process.argv[2] ?? "unnamed";
const ROOT = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const APP = "http://127.0.0.1:4173/";
const START = `${APP}?loc=stockton-ca&year=2025`;
const RUNS = 5;

async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i += 1) {
    try { if ((await fetch(url)).status < 500) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} did not come up`);
}
const ready = (page) => page.waitForFunction(() => performance.getEntriesByName("drill-chart-ready").length > 0, null, { timeout: 30_000 });
const search = (page, key) => new URL(page.url()).searchParams.get(key);

async function clickPoint(page, key) {
  const panel = page.locator("[data-drill-panel] [data-chart]");
  const el = page.locator(`[data-drill-panel] [data-chart] [data-key="${key}"]`);
  if (await el.count()) return el.first().click();
  const pos = await page.evaluate((k) => window.__chartPointPixel?.(k) ?? null, key);
  const box = await panel.boundingBox();
  if (pos && box) await page.mouse.click(box.x + pos[0], box.y + pos[1]);
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

  // 1. First render of the drill chart (12 months of 2025), median of several loads.
  const times = [];
  for (let i = 0; i < RUNS; i += 1) {
    await page.goto(START, { waitUntil: "load" });
    await ready(page);
    times.push(await page.evaluate(() => performance.getEntriesByName("drill-chart-ready")[0].startTime));
  }
  times.sort((a, b) => a - b);

  // 2. Accessibility of the chart: focusable and labelled elements.
  const a11y = await page.evaluate(() => {
    const chart = document.querySelector("[data-drill-panel] [data-chart]");
    return {
      focusable: chart ? chart.querySelectorAll('[tabindex="0"], button, a[href]').length : 0,
      labelled: chart ? chart.querySelectorAll("[aria-label]").length : 0,
      chart_label: chart?.getAttribute("aria-label") ?? null,
      chart_role: chart?.getAttribute("role") ?? null,
    };
  });

  // 3. Keyboard drill-down: focus the July point and press Enter.
  let keyboardDrill = false;
  const julyFocusable = page.locator('[data-drill-panel] [data-chart] [data-key="07"][tabindex="0"]');
  if (await julyFocusable.count()) {
    await julyFocusable.first().focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    keyboardDrill = search(page, "month") === "07";
    await page.goto(START, { waitUntil: "load" });
    await ready(page);
  }

  // 4. Mouse drill-down: click July → days of July; screenshot; breadcrumb back to the year.
  await page.waitForTimeout(400);
  await clickPoint(page, "07");
  await page.waitForTimeout(800);
  const mouseDrill = search(page, "month") === "07";
  const dayPoints = await page.locator("[data-drill-panel] [data-chart]").getAttribute("data-points");
  mkdirSync(`${ROOT}/docs/images`, { recursive: true });
  await page.locator("[data-drill-panel]").screenshot({ path: `${ROOT}/docs/images/drill-${label}-days.png` });
  const crumb = page.locator('nav[aria-label="Breadcrumb"] button', { hasText: "2025" });
  if (await crumb.count()) await crumb.click();
  await page.waitForTimeout(500);
  const breadcrumbBack = search(page, "month") === null && search(page, "year") === "2025";

  // 5. Back button restores the drilled state from the URL.
  await page.goBack();
  await page.waitForTimeout(600);
  const backButton = search(page, "month") === "07";

  await page.goto(START, { waitUntil: "load" });
  await ready(page);
  await page.waitForTimeout(500);
  await page.locator("[data-drill-panel]").screenshot({ path: `${ROOT}/docs/images/drill-${label}-months.png` });

  const result = {
    label,
    first_render_ms_median: Math.round(times[Math.floor(times.length / 2)]),
    first_render_ms_all: times.map(Math.round),
    mouse_drill_to_days: mouseDrill,
    day_points: dayPoints == null ? null : Number(dayPoints),
    keyboard_drill: keyboardDrill,
    breadcrumb_back_to_year: breadcrumbBack,
    browser_back_restores_month: backButton,
    ...a11y,
  };
  console.log(JSON.stringify(result, null, 2));
  mkdirSync(`${ROOT}/docs/analysis/data`, { recursive: true });
  writeFileSync(`${ROOT}/docs/analysis/data/drill-${label}-browser.json`, JSON.stringify({ ...result, measured_at: new Date() }, null, 2));
} finally {
  await browser.close();
  for (const p of procs) p.kill();
  if (process.platform === "win32") spawn("taskkill", ["/F", "/T", "/PID", String(procs[1].pid)], { stdio: "ignore" });
}
