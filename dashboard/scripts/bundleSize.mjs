// Gzipped size of the built JS/CSS (dist/assets), for comparing implementations. Run after `npm run build`.
// Usage: node scripts/bundleSize.mjs <label>  → prints sizes, writes ../docs/analysis/data/map-<label>-bundle.json
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";

const label = process.argv[2] ?? "unnamed";
const dir = new URL("../dist/assets/", import.meta.url);
const files = readdirSync(dir).filter((f) => /\.(js|css)$/.test(f)).map((f) => {
  const raw = readFileSync(new URL(f, dir));
  return { file: f, raw_kb: +(raw.length / 1024).toFixed(1), gzip_kb: +(gzipSync(raw, { level: 9 }).length / 1024).toFixed(1) };
});
const sum = (ext) => +files.filter((f) => f.file.endsWith(ext)).reduce((a, f) => a + f.gzip_kb, 0).toFixed(1);
const result = { label, js_gzip_kb: sum(".js"), css_gzip_kb: sum(".css"), files };
console.log(JSON.stringify({ label, js_gzip_kb: result.js_gzip_kb, css_gzip_kb: result.css_gzip_kb }));
const out = new URL("../../docs/analysis/data/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL(`map-${label}-bundle.json`, out), JSON.stringify(result, null, 2));
