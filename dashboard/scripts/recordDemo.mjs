// Record the README demo GIF from the live site (and, with --screenshots, the readme-*.png screenshots); with --how,
// record how-it-works.gif for posts instead. Free tools only: Playwright + ffmpeg-static.
// Smoothness: frames come from the Chrome screencast (real timestamps, ~30 fps) and ffmpeg resamples them to a constant
// 20 fps GIF with palettegen/paletteuse. Every page is visited once in the recording tab before capture (query cache and
// lazy chunks loaded), so no loading state is recorded. The cursor is drawn by the page (headless capture has none) and
// glides with easing. Every clip starts at the top of the page with the header and nav visible.
// Tour → docs/images/demo.gif (1280x840 viewport, scaled to 960 px wide or narrower, see below): header + KPIs → US map → California → San Francisco history →
//   Forecast → "Get alerts" dialog (one alert type ticked, never submitted) → Accuracy leaderboard → Ops.
// How it works → how-it-works.gif (1280x960 → 960x720): the whole diagram (all three lanes), two node panels, AWS view.
// Fails on any CSP violation, a POST outside the Turnstile widget (the sign-up form must never be sent), a header badge
// that isn't "Live · …", an overview that isn't "All US · <every tracked city> cities", or a tour outside 14–21 s.
// GIFs stay under 5 MB: narrower first (960 → 880 → 800 px), then fewer fps (18, 15).
// Usage: node scripts/recordDemo.mjs [--screenshots]          (writes docs/images/demo.gif)
//        node scripts/recordDemo.mjs --how [--out <dir>]     (writes <dir>/how-it-works.gif, default ~/Desktop/linkedin-media)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ffmpeg from "ffmpeg-static";
import { chromium } from "playwright";
import { CITIES } from "../../src/locations/cities.js";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const IMAGES = join(ROOT, "docs", "images");
const BASE = "https://us-weather-pipeline.vercel.app";
const HOW = process.argv.includes("--how");
const SCREENSHOTS = process.argv.includes("--screenshots");
const outArg = process.argv.indexOf("--out");
const HOW_OUT = outArg > 0 ? resolve(process.argv[outArg + 1]) : join(homedir(), "Desktop", "linkedin-media");
const MAX_GIF_BYTES = 5 * 1024 * 1024;
const SPEED = 0.7;                                                      // scales every cursor glide

if (!ffmpeg || !existsSync(ffmpeg)) throw new Error("ffmpeg-static has no binary (installed with --ignore-scripts?): run `node node_modules/ffmpeg-static/install.js` in dashboard/");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

// The visible cursor. It moves into an open <dialog> so the top layer doesn't hide it.
const CURSOR = () => {
  const make = () => {
    const c = document.createElement("div");
    c.id = "__cursor";
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.5-3.4-6.6L4 20z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none", transform: "translate(-200px,-200px)", filter: "drop-shadow(0 1px 1px rgba(0,0,0,.35))" });
    return c;
  };
  addEventListener("mousemove", (e) => {
    const c = document.getElementById("__cursor") ?? make();
    const host = document.querySelector("dialog[open]") ?? document.body;
    if (c.parentNode !== host) host.appendChild(c);
    c.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`;
  }, true);
  addEventListener("mousedown", () => { const c = document.getElementById("__cursor"); if (c) c.style.scale = "0.85"; }, true);
  addEventListener("mouseup", () => { const c = document.getElementById("__cursor"); if (c) c.style.scale = "1"; }, true);
};

/** Eased cursor glides, clicks and scrolls (no jumps). */
function director(page) {
  const cur = { x: 900, y: 140 };
  const d = {
    async glide(x, y, ms = 700) {
      const n = Math.max(10, Math.round((ms * SPEED) / 16)); const s = { ...cur };
      for (let i = 1; i <= n; i += 1) { const e = ease(i / n); await page.mouse.move(s.x + (x - s.x) * e, s.y + (y - s.y) * e); await wait(12); }
      cur.x = x; cur.y = y;
    },
    async to(locator, ms = 700, dx = 0, dy = 0) {
      await locator.waitFor({ state: "visible", timeout: 15_000 });
      const b = await locator.boundingBox();
      await d.glide(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, ms);
    },
    async click(locator, ms = 700) { await d.to(locator, ms); await wait(160); await page.mouse.down(); await wait(90); await page.mouse.up(); },
    async scroll(top, ms = 800) {
      await page.evaluate(({ top, ms }) => new Promise((res) => {
        const from = scrollY; const t0 = performance.now();
        const f = (t) => { const p = Math.min(1, (t - t0) / ms); const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
          scrollTo({ top: from + (top - from) * e, behavior: "instant" }); if (p < 1) requestAnimationFrame(f); else res(); };
        requestAnimationFrame(f);
      }), { top, ms });
    },
    park: () => page.mouse.move(cur.x, cur.y),
  };
  return d;
}

/** Screencast frames to JPEG files plus an ffmpeg concat list with each frame's real duration. */
async function startCapture(context, page, dir) {
  const cdp = await context.newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = join(dir, `f${String(frames.length).padStart(5, "0")}.jpg`).replaceAll("\\", "/");
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, t: metadata.timestamp });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  const { width, height } = page.viewportSize();
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  return async function stop() {
    const end = Date.now() / 1000;
    await cdp.send("Page.stopScreencast"); await wait(200); await cdp.detach();
    if (!frames.length) throw new Error("no frames captured");
    const lines = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.t ?? Math.max(f.t + 0.04, end)) - f.t).toFixed(4)}`);
    lines.push(`file '${frames.at(-1).file}'`);                           // the concat demuxer needs the last file twice
    const list = join(dir, "list.txt"); writeFileSync(list, lines.join("\n"));
    const seconds = Math.max(frames.at(-1).t, end) - frames[0].t;
    console.log(`[demo] ${frames.length} frames over ${seconds.toFixed(1)} s`);
    return { list, seconds };
  };
}

function toGif(list, out) {
  for (const [fps, width] of [[20, 960], [20, 880], [20, 800], [18, 800], [15, 800]]) {
    const vf = `fps=${fps},scale=${width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
    const res = spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", vf, "-loop", "0", out], { stdio: "inherit" });
    if (res.status !== 0) throw new Error("ffmpeg failed");
    const size = statSync(out).size;
    console.log(`[demo] ${out}: ${fps} fps, ${width}px → ${(size / 1024 / 1024).toFixed(2)} MB`);
    if (size < MAX_GIF_BYTES) return;
  }
  throw new Error(`${out} is still over 5 MB at 800 px and 15 fps`);
}

const browser = await chromium.launch();
const tmp = mkdtempSync(join(tmpdir(), "uwp-demo-"));
try {
  const context = await browser.newContext({ viewport: HOW ? { width: 1280, height: 960 } : { width: 1280, height: 840 }, colorScheme: "light", deviceScaleFactor: 1 });
  await context.addInitScript(CURSOR);
  await context.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => (window.__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`)));
  const page = await context.newPage();
  const posts = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).host !== "challenges.cloudflare.com") posts.push(r.url()); });
  const d = director(page);
  const nav = (name) => page.locator('nav[aria-label="Pages"] a', { hasText: new RegExp(`^${name}$`) });
  const mapReady = () => page.waitForFunction((n) => document.querySelectorAll("[data-map] [data-location]:not([data-loading])").length >= n, CITIES.length, { timeout: 30_000 });
  const go = (url) => page.evaluate((u) => { history.pushState(null, "", u); dispatchEvent(new PopStateEvent("popstate")); }, url);

  // Warm-up in the recording tab: in-app visits (pushState + popstate) keep the query cache and lazy chunks.
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await mapReady();
  for (const [url, sel] of [["/?loc=san-francisco-ca&city=san-francisco-ca", "[data-drill-panel] [data-chart]"], ["/forecast?loc=san-francisco-ca&city=san-francisco-ca", "[data-day]"],
    ["/accuracy", "[data-leaderboard]"], ["/ops", "[data-ops-overall]"], ["/how-it-works", '[data-flow-node="collector"]']]) {
    await go(url); await page.waitForSelector(sel, { timeout: 20_000 }); await page.waitForLoadState("networkidle"); await wait(300);
  }
  if (!HOW) { await go("/"); await mapReady(); await page.waitForLoadState("networkidle"); }
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await d.park(); await wait(600);

  const opening = {
    badge: (await page.getByText(/^Live · /).first().textContent().catch(() => ""))?.trim(),
    subject: HOW ? undefined : await page.locator("[data-kpi-subject]").textContent(),
  };
  if (!opening.badge) throw new Error("opening frame: no \"Live · …\" header badge");
  if (!HOW && opening.subject !== `All US · ${CITIES.length} cities`) throw new Error(`opening frame: overview shows "${opening.subject}", not all ${CITIES.length} cities`);
  const stop = await startCapture(context, page, tmp);

  if (HOW) {
    // ---- how-it-works.gif: the whole diagram, two node panels, then the AWS view -------------------------------------
    await wait(1100);
    await d.click(page.locator('[data-flow-node="collector"]'), 750);
    await page.waitForSelector('[data-flow-panel="collector"]', { timeout: 5_000 });
    await wait(1900);
    await d.click(page.locator('[data-flow-node="clickhouse"]'), 750);
    await page.waitForSelector('[data-flow-panel="clickhouse"]', { timeout: 5_000 });
    await wait(1900);
    await d.click(page.getByRole("button", { name: "AWS", exact: true }), 750);
    await page.waitForSelector('[data-flow-view="aws"]', { timeout: 5_000 });
    await d.glide(640, 640, 600);
    await wait(1900);
  } else {
    // ---- tour: header + KPIs → map → California → San Francisco → Forecast + alerts → Accuracy → Ops --------------------
    await wait(1000);                                                   // header, filters and All US KPI cards
    const mapCard = await page.locator("[data-map]").evaluate((e) => e.closest('[data-slot="card"]')?.getBoundingClientRect().top ?? e.getBoundingClientRect().top - 120);
    await d.scroll(Math.round(mapCard - 16), 800);                     // the whole map card, 55 city dots
    await wait(700);
    const ca = page.locator('[data-map] [data-state="CA"]');
    const b = await ca.boundingBox();
    const pt = { x: b.x + b.width * 0.42, y: b.y + b.height * 0.42 };   // Central Valley, inside the shape
    await d.glide(pt.x, pt.y, 700); await wait(200);
    if (await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-state="CA"]'), pt)) { await page.mouse.down(); await wait(90); await page.mouse.up(); }
    else { await ca.focus(); await page.keyboard.press("Enter"); }
    await page.waitForFunction(() => document.querySelector("[data-map]")?.getAttribute("data-map-level") === "state", null, { timeout: 10_000 });
    await wait(700);
    await d.click(page.locator('[data-map] [data-location="san-francisco-ca"]'), 650);  // opens its history and scrolls to it
    await page.waitForSelector("[data-drill-panel] [data-chart]", { timeout: 15_000 });
    await wait(900);
    const chart = await page.locator("[data-drill-panel] [data-chart]").first().boundingBox();
    await d.glide(chart.x + chart.width * 0.3, chart.y + chart.height * 0.55, 500);
    await d.glide(chart.x + chart.width * 0.75, chart.y + chart.height * 0.5, 800);   // the tooltip follows the months
    await wait(300);

    await d.glide(900, 180, 300);
    await d.scroll(0, 600);
    await d.click(nav("Forecast"), 600);                                // keeps San Francisco
    await page.waitForSelector("[data-day]", { timeout: 15_000 });
    await wait(600);
    await d.click(page.locator("[data-signup-open]").first(), 550);    // "Get alerts": tick one type, close, never submit
    const dialog = page.locator("dialog[data-signup-dialog][open]");
    await dialog.waitFor({ timeout: 5_000 });
    await d.park(); await wait(200);
    await d.click(dialog.locator('input[name="category"]:not(:checked)').first(), 500);
    await wait(800);
    await d.click(dialog.locator('button[aria-label="Close"]'), 450);
    await dialog.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
    await wait(250);
    const hours = await page.locator("main > *").nth(2).evaluate((e) => e.getBoundingClientRect().bottom + scrollY);
    await d.scroll(Math.max(0, Math.round(hours - page.viewportSize().height + 16)), 500);  // the 48-hour charts in full
    await wait(600);
    await d.scroll(0, 450);

    await d.click(nav("Accuracy"), 600);
    await page.waitForSelector("[data-leaderboard]", { timeout: 15_000 });
    await d.to(page.locator("[data-leaderboard] tr", { hasText: "ECMWF" }).first(), 600, -200);
    await wait(1100);
    await d.click(nav("Ops"), 600);
    await page.waitForSelector("[data-ops-overall]", { timeout: 15_000 });
    await d.glide(900, 460, 500);
    await wait(1300);                                                   // ends on the Ops status page
  }

  const { list, seconds } = await stop();
  const csp = await page.evaluate(() => window.__csp ?? []);
  console.log(`[demo] opening: ${JSON.stringify(opening)}; CSP violations: ${csp.length}; POSTs: ${posts.length}`);
  if (csp.length) throw new Error(`CSP violations: ${csp.join("; ")}`);
  if (posts.length) throw new Error(`unexpected POST requests (the sign-up form must never be sent): ${posts.join(", ")}`);
  if (!HOW && (seconds < 14 || seconds > 21)) throw new Error(`tour is ${seconds.toFixed(1)} s, outside 14–21 s`);
  await context.close();
  if (HOW) { mkdirSync(HOW_OUT, { recursive: true }); toGif(list, join(HOW_OUT, "how-it-works.gif")); }
  else toGif(list, join(IMAGES, "demo.gif"));

  // ---- README screenshots (light + dark), only with --screenshots ------------------------------------------------------
  if (SCREENSHOTS && !HOW) {
    const shot = async (scheme, url, file, prepare) => {
      const p = await browser.newPage({ viewport: { width: 1400, height: 900 }, colorScheme: scheme });
      await p.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
      await prepare(p);
      await p.screenshot({ path: join(IMAGES, file) });
      await p.close();
    };
    await shot("light", "/", "readme-overview.png", async (p) => {
      await p.waitForFunction(() => document.querySelectorAll("[data-map] [data-location]:not([data-loading])").length >= 10, null, { timeout: 30_000 });
      await wait(800);
    });
    await shot("dark", "/?city=phoenix-az&year=2026&month=07", "readme-city-dark.png", async (p) => {
      await p.waitForSelector("[data-drill-panel] [data-chart]", { timeout: 15_000 });
      await p.evaluate(() => { document.querySelector("[data-drill-section]")?.scrollIntoView({ block: "start" }); window.scrollBy(0, -12); });
      await wait(800);
      await p.locator("[data-drill-panel] [data-chart]").first().locator('[data-key="15"]').hover();
      await wait(400);
    });
    await shot("light", "/accuracy", "readme-accuracy.png", async (p) => { await p.waitForSelector("[data-leaderboard]", { timeout: 15_000 }); await wait(1000); });
    await shot("dark", "/forecast?city=phoenix-az", "readme-forecast-dark.png", async (p) => { await p.waitForSelector("[data-day]", { timeout: 15_000 }); await wait(1000); });
    console.log("[demo] wrote readme-*.png");
  }
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
