// Screenshots and checks for the forecast replay on a static build, served like Vercel (headers incl. the CSP and
// rewrites from vercel.json). Opens Stockton › Sep 2026, clicks "Replay forecasts", picks Sep 20, 2026 (live from
// Open-Meteo, so this makes 2 real requests per run), and saves the panel in light and dark mode. Reports the
// Open-Meteo requests, CSP violations and the time from click to chart.
// Usage: npm run build:snapshot && node scripts/shotReplay.mjs <out-prefix> [dist-dir]
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { chromium } from "playwright";
import { insideDir } from "./insideDir.mjs";

const [prefix, distArg] = process.argv.slice(2);
if (!prefix) throw new Error("usage: node scripts/shotReplay.mjs <out-prefix> [dist-dir]");
const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const DIST = resolve(distArg ?? join(ROOT, "dist"));
const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const toRegex = (source) => new RegExp(`^${source.replace(/\(\.\*\)/g, "(.*)")}$`);

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  for (const rule of vercel.headers) if (toRegex(rule.source).test(path)) for (const h of rule.headers) res.setHeader(h.key, h.value);
  let file = normalize(join(DIST, path));
  if (!insideDir(DIST, file)) { res.writeHead(400); return res.end(); }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(4175, "127.0.0.1");

const browser = await chromium.launch();
const report = {};
try {
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, colorScheme: scheme });
    const openMeteo = [];
    page.on("request", (r) => { if (r.url().includes("open-meteo.com")) openMeteo.push(new URL(r.url()).host); });
    await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => (window.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`)));
    await page.goto("http://127.0.0.1:4175/?city=stockton-ca&year=2026&month=09", { waitUntil: "load" });
    const open = page.getByRole("button", { name: "Replay forecasts" });
    await open.waitFor({ timeout: 30_000 });
    await open.click();
    await page.getByRole("combobox", { name: "Day to replay" }).click();
    const t0 = Date.now();
    await page.getByRole("option", { name: "Sun, Sep 20, 2026" }).click();
    await page.waitForSelector("[data-replay-chart] svg", { timeout: 15_000 });
    const ms = Date.now() - t0;
    await page.waitForTimeout(400);
    const panel = page.locator("[data-replay-panel]");
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: `${prefix}-${scheme}.png` });
    // keyboard: Tab from the day picker reaches a focusable chart element
    const focusable = await page.locator("[data-replay-chart] [tabindex='0'], [data-replay-chart] button").count();
    report[scheme] = {
      insight: await page.locator("[data-replay-insight]").textContent(),
      source: await page.locator("[data-replay-source]").textContent(),
      openMeteoRequests: openMeteo.length, hosts: [...new Set(openMeteo)].join(" "),
      cspViolations: (await page.evaluate(() => window.__csp ?? [])).length,
      pickToChartMs: ms, focusableChartElements: focusable,
    };
    await page.close();
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
  server.close();
}
