// Check the static demo build (npm run build:snapshot) the way Vercel serves it: a local server applies the
// headers and rewrites from vercel.json; headless Chromium loads the page and checks the badge, KPIs, map,
// that nothing calls /api, and that the Content-Security-Policy blocks nothing. Saves a screenshot.
// Usage: npm run build:snapshot && node scripts/checkDemoBuild.mjs

import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const DIST = new URL("../dist/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const toRegex = (source) => new RegExp(`^${source.replace(/\(\.\*\)/g, "(.*)")}$`);

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  for (const rule of vercel.headers) if (toRegex(rule.source).test(path)) for (const h of rule.headers) res.setHeader(h.key, h.value);
  let file = normalize(join(DIST, path));
  if (!file.startsWith(normalize(DIST))) { res.writeHead(400); return res.end(); }
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
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
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
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  const base = "http://127.0.0.1:4174/";
  const res = await page.goto(base, { waitUntil: "load" });
  check("CSP header served", Boolean(res.headers()["content-security-policy"]), res.headers()["content-security-policy"]);
  await page.waitForFunction(() => performance.getEntriesByName("map-ready").length > 0, null, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const badge = await page.getByText(/^Demo data as of \d{4}-\d{2}-\d{2}$/).textContent().catch(() => null);
  check("'Demo data as of' badge", Boolean(badge), badge);
  const avgTemp = await page.locator("section[aria-label='Key figures'] p.text-2xl").first().textContent();
  check("KPI cards have values", /\d/.test(avgTemp ?? ""), avgTemp);
  check("map rendered with states", (await page.locator("[data-map] [data-state]").count()) >= 50, await page.locator("[data-map] [data-state]").count());

  const dotsWithData = await page.waitForFunction(() => document.querySelectorAll("[data-map] [data-location]:not([data-loading])").length >= 10, null, { timeout: 15_000 })
    .then(() => true).catch(() => false);
  const dots = await page.locator("[data-map] [data-location]").count();
  check("53 city dots, most with values", dots === 53 && dotsWithData, `${dots} dots`);

  await page.screenshot({ path: new URL("../../docs/images/dashboard-demo.png", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1"), fullPage: true });

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
  await page.goto(`${base}?loc=stockton-ca&year=2023`, { waitUntil: "load" });
  await page.waitForFunction(() => performance.getEntriesByName("drill-chart-ready").length > 0, null, { timeout: 30_000 });
  const dec = page.locator('[data-drill-panel] [data-key="12"][role="button"]');
  if (await dec.count()) { await dec.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(600); }
  const dayCount = await page.locator("[data-drill-panel] [data-chart]").getAttribute("data-points");
  check("city chart: 2023 → December days", new URL(page.url()).searchParams.get("month") === "12" && dayCount === "31", `${dayCount} points`);

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
