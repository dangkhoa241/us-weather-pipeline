// Check the static demo build (npm run build:snapshot) the way Vercel serves it: a local server applies the
// headers and rewrites from vercel.json; headless Chromium loads the page and checks the badge, KPIs, map,
// that nothing calls /api, and that the Content-Security-Policy blocks nothing. Requests to the live data host
// (CloudFront, from connect-src) are blocked, so the check always tests the bundled snapshot fallback.
// Usage: npm run build:snapshot && node scripts/checkDemoBuild.mjs [--screenshots]
// --screenshots: also rewrite docs/images/dashboard-demo*.png (off by default, so a check run changes no files).

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";
import { insideDir } from "./insideDir.mjs";
import { MAX_GAP_DAYS, historyProblems } from "../../src/publish/snapshotFormat.js";

const DIST = new URL("../dist/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const toRegex = (source) => new RegExp(`^${source.replace(/\(\.\*\)/g, "(.*)")}$`);
const CSP = vercel.headers.flatMap((r) => r.headers).find((h) => h.key === "Content-Security-Policy").value;
const LIVE_HOSTS = CSP.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src ")).split(/\s+/)
  .filter((s) => /^https:\/\/[^/]+\.cloudfront\.net$/.test(s)).map((s) => new URL(s).host);
const isLive = (url) => LIVE_HOSTS.includes(new URL(url).host);
const SCREENSHOTS = process.argv.includes("--screenshots");
const shot = (target, name, options = {}) => SCREENSHOTS
  ? target.screenshot({ path: new URL(`../../docs/images/${name}`, import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"), ...options })
  : Promise.resolve();

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  for (const rule of vercel.headers) if (toRegex(rule.source).test(path)) for (const h of rule.headers) res.setHeader(h.key, h.value);
  let file = normalize(join(DIST, path));
  if (!insideDir(DIST, file)) { res.writeHead(400); return res.end(); }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    const rewrite = vercel.rewrites.find((r) => toRegex(r.source).test(path));
    if (!rewrite && path !== "/") { res.writeHead(404); return res.end("not found"); }
    file = join(DIST, "index.html");
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(4174, "127.0.0.1");

const checks = [];
const check = (name, ok, detail = "") => checks.push({ check: name, result: ok ? "PASS" : "FAIL", detail: String(detail).slice(0, 90) });

// Data quality of the bundled snapshot (same rule as export:snapshot): every city has history, no long gaps.
{
  const readData = (name) => JSON.parse(readFileSync(join(DIST, "data", name), "utf8"));
  const { snapshot } = readData("manifest.json");
  const locations = readData(`${snapshot}/locations.json`);
  const dailies = Object.fromEntries(locations.map((l) => [l.id, existsSync(join(DIST, "data", snapshot, `daily-${l.id}.json`)) ? readData(`${snapshot}/daily-${l.id}.json`) : null]));
  const problems = historyProblems(locations, dailies);
  if (problems.length) console.error(`[check] history problems:\n  ${problems.join("\n  ")}`);
  check(`history: all ${locations.length} cities, no gap > ${MAX_GAP_DAYS} days`, problems.length === 0,
    problems.length ? `${problems.length} cities: ${problems.map((p) => p.split(":")[0]).join(", ")}` : `${locations.length} cities`);
}
const browser = await chromium.launch();
const blockedLive = [];
// Abort live-data requests (its CORS allows only the Vercel origin anyway): the fallback is then deterministic.
const blockLive = (p) => p.route((url) => isLive(url.href), (route) => { blockedLive.push(route.request().url()); return route.abort(); });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await blockLive(page);
  const violations = [];
  const apiCalls = [];
  const errors = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI} at ${e.sourceFile?.split("/").pop()}:${e.lineNumber}:${e.columnNumber}`);
    });
  });
  page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api")) apiCalls.push(r.url()); });
  page.on("pageerror", (e) => errors.push(e.message));
  // The aborted live requests log "Failed to load resource"; that is expected, not a page error.
  page.on("console", (m) => { if (m.type() === "error" && !(m.location().url && isLive(m.location().url))) errors.push(m.text()); });

  const base = "http://127.0.0.1:4174/";
  const res = await page.goto(base, { waitUntil: "load" });
  check("CSP header served", Boolean(res.headers()["content-security-policy"]), res.headers()["content-security-policy"]);
  await page.waitForFunction(() => performance.getEntriesByName("map-ready").length > 0, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const badge = await page.getByText(/^(Live|Snapshot) · history through [A-Z][a-z]{2} \d{1,2}$/).textContent().catch(() => null);
  check("data source badge", Boolean(badge), badge);
  check("live data requested and blocked", LIVE_HOSTS.length === 0 || blockedLive.length > 0, `${blockedLive.length} blocked (${LIVE_HOSTS.join(", ") || "no live host"})`);
  check("live blocked → badge shows Snapshot", /^Snapshot · /.test(badge ?? ""), badge);
  const avgTemp = await page.locator("section[aria-label='Key figures'] p.text-2xl").first().textContent();
  check("KPI cards have values", /\d/.test(avgTemp ?? ""), avgTemp);
  const subject = await page.locator("[data-kpi-subject]").textContent();
  check("default is All US (US-wide KPIs)", /^All US · \d+ cities$/.test(subject ?? ""), subject);
  check("map rendered with states", (await page.locator("[data-map] [data-state]").count()) >= 50, await page.locator("[data-map] [data-state]").count());

  const dotsWithData = await page.waitForFunction(() => document.querySelectorAll("[data-map] [data-location]:not([data-loading])").length >= 10, null, { timeout: 15_000 })
    .then(() => true).catch(() => false);
  const dots = await page.locator("[data-map] [data-location]").count();
  check("53 city dots, most with values", dots === 53 && dotsWithData, `${dots} dots`);

  await shot(page, "dashboard-demo.png", { fullPage: true });

  // Another preset + comparison (computed from the daily snapshot) and a deep link.
  await page.goto(`${base}?range=365d&compare=last_year&unit=C&loc=miami-fl`, { waitUntil: "load" });
  await page.waitForFunction(() => performance.getEntriesByName("map-ready").length > 0);
  await page.waitForTimeout(1500);
  const delta = await page.locator("section[aria-label='Key figures']").getByText(/vs same period last year/).count();
  check("365 days vs last year (deep link)", delta > 0, `${delta} deltas`);
  await page.locator('[data-map] [data-state="FL"]').focus();   // bounding-box center of Florida is in the Gulf
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  check("drill-down works offline", (await page.getAttribute("[data-map]", "data-map-level")) === "state");

  // City chart: the oldest year in the snapshot, then drill into December (days derived from the daily columns).
  await page.goto(`${base}?city=stockton-ca&year=2023`, { waitUntil: "load" });
  await page.waitForFunction(() => performance.getEntriesByName("drill-chart-ready").length > 0, null, { timeout: 30_000 });
  // Drill on the rain chart: both charts (temperature + rain) must switch to the days of December.
  const dec = page.locator('[data-drill-panel] [data-chart]').nth(1).locator('[data-key="12"][role="button"]');
  if (await dec.count()) { await dec.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(800); }
  const dayCounts = await page.locator("[data-drill-panel] [data-chart]").evaluateAll((els) => els.map((e) => e.getAttribute("data-points")));
  check("city charts: 2023 → December days (both)", new URL(page.url()).searchParams.get("month") === "12" && dayCounts.join() === "31,31", dayCounts.join(" + "));

  // City history open on a recent year, hovering a month (synced crosshair): screenshot for the README.
  await page.goto(`${base}?city=stockton-ca&year=2025`, { waitUntil: "load" });
  await page.waitForFunction(() => performance.getEntriesByName("drill-chart-ready").length > 0, null, { timeout: 30_000 });
  await page.waitForTimeout(800);
  await page.locator('[data-drill-panel] [data-chart]').first().locator('[data-key="07"]').hover();
  const crosshairs = await page.locator("[data-drill-panel] [data-crosshair]").count();
  check("synced crosshair on both charts", crosshairs === 2, `${crosshairs} crosshairs`);
  await shot(page.locator("[data-drill-section]"), "dashboard-demo-city.png");

  // Page tabs: real URLs, Back/Forward.
  await page.goto(`${base}?city=stockton-ca`, { waitUntil: "load" });
  await page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Forecast" }).click();
  await page.waitForTimeout(300);
  const forecastUrl = new URL(page.url());
  await page.goBack();
  await page.waitForTimeout(300);
  check("tabs: /forecast keeps the city, Back returns", forecastUrl.pathname === "/forecast" && forecastUrl.searchParams.get("city") === "stockton-ca"
    && new URL(page.url()).pathname === "/", `${forecastUrl.pathname}${forecastUrl.search} → ${new URL(page.url()).pathname}`);

  // Forecast page (frozen at the snapshot): label, daily cards, models chart.
  await page.goto(`${base}forecast?city=stockton-ca`, { waitUntil: "load" });
  await page.waitForSelector("[data-day]", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const issued = await page.locator("[data-forecast-issued]").textContent();
  const days = await page.locator("[data-day]").count();
  const modelSeries = await page.locator("[data-multiline]").first().getAttribute("data-series").catch(() => null);
  check("forecast page: 'Forecast as of', cards, models", /^Forecast as of \d{4}-\d{2}-\d{2}$/.test(issued ?? "") && days >= 5 && Number(modelSeries) >= 3,
    `${issued}; ${days} days; ${modelSeries} models`);
  const forecastBadge = (await page.locator("[data-source]").textContent())?.trim();
  check("forecast badge: Snapshot · forecast updated …", /^Snapshot · forecast updated [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/.test(forecastBadge ?? ""), forecastBadge);
  await shot(page, "dashboard-demo-forecast.png", { fullPage: true });

  // Accuracy page: hero from data, leaderboard, map by state.
  await page.goto(`${base}accuracy`, { waitUntil: "load" });
  await page.waitForSelector("[data-leaderboard]", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const hero = await page.locator("[data-hero]").textContent();
  const models = await page.locator("[data-leaderboard] tbody tr").count();
  const colored = await page.locator("[data-accuracy-map] [data-state]").evaluateAll((els) => els.filter((e) => !e.style.fill.includes("hatch")).length);
  check("accuracy page: hero, leaderboard, map", /is the most accurate model: \d+\.\d°F average error 1 day ahead/.test(hero ?? "") && models >= 4 && colored >= 10,
    `${hero?.slice(0, 40)}…; ${models} models; ${colored} states`);
  const accuracyBadge = (await page.locator("[data-source]").textContent())?.trim();
  check("accuracy badge: Snapshot · scored through …", /^Snapshot · scored through [A-Z][a-z]{2} \d{1,2}$/.test(accuracyBadge ?? ""), accuracyBadge);
  await shot(page, "dashboard-demo-accuracy.png", { fullPage: true });

  // Dark mode follows the system by default: same page with a dark color scheme.
  const dark = await browser.newPage({ viewport: { width: 1400, height: 1000 }, colorScheme: "dark" });
  await blockLive(dark);
  await dark.goto(`${base}?city=stockton-ca&year=2025`, { waitUntil: "load" });
  await dark.waitForFunction(() => performance.getEntriesByName("drill-chart-ready").length > 0, null, { timeout: 30_000 });
  await dark.waitForTimeout(1500);
  check("dark mode follows the system", await dark.evaluate(() => document.documentElement.classList.contains("dark")));
  await shot(dark, "dashboard-demo-dark.png", { fullPage: true });
  await dark.close();

  const csp = await page.evaluate(() => window.__csp ?? []);
  check("no CSP violations", csp.length === 0, csp.join("; "));
  check("no /api requests (static demo)", apiCalls.length === 0, apiCalls.slice(0, 2).join(" "));
  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  const notFound = await fetch(`${base}data/../../vercel.json`).then((r) => r.status);
  check("no path traversal out of dist", notFound !== 200 || !(await fetch(`${base}data/../../vercel.json`).then((r) => r.text())).includes("buildCommand"), notFound);
} finally {
  await browser.close();
  server.close();
}
console.table(checks);
const failed = checks.filter((c) => c.result === "FAIL").length;
console.log(failed ? `${failed} check(s) failed` : `all ${checks.length} checks passed`);
process.exitCode = failed ? 1 : 0;
