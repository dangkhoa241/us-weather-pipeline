import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// docs/architecture/ holds one engineering doc per component (the "Read more" links on /how-it-works). Each has the
// same sections, and every relative link (and #anchor) in docs/ must resolve, so a renamed file or heading fails here.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARCH = join(ROOT, "docs", "architecture");
const SECTIONS = ["Purpose", "Requirements", "Design", "Alternatives considered", "Failure handling", "Security", "Numbers", "Where in the code"];

const read = (file) => readFileSync(file, "utf8");
const mdFiles = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? mdFiles(path) : name.endsWith(".md") ? [path] : [];
});
/** Markdown without fenced code blocks and inline code (links in code are examples, not links). */
const prose = (text) => text.replace(/^```[\s\S]*?^```/gm, "").replace(/`[^`\n]*`/g, "");
/** GitHub heading anchors, with -1, -2 … for repeated headings. */
function anchors(text) {
  const seen = new Map();
  return text.replace(/^```[\s\S]*?^```/gm, "").split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => {
    const slug = l.replace(/^#+ /, "").trim().toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    return n ? `${slug}-${n}` : slug;
  });
}

const componentDocs = readdirSync(ARCH).filter((f) => f.endsWith(".md") && f !== "README.md");

describe("docs/architecture component docs", () => {
  it("there are 6 to 9 component docs, all listed in the index", () => {
    expect(componentDocs.length).toBeGreaterThanOrEqual(6);
    expect(componentDocs.length).toBeLessThanOrEqual(9);
    const index = read(join(ARCH, "README.md"));
    for (const f of componentDocs) expect(index, f).toContain(`](${f})`);
  });

  it.each(componentDocs)("%s has exactly the engineering sections, in order, and links its decision", (file) => {
    const text = read(join(ARCH, file));
    expect(text.split("\n")[0], file).toMatch(/^# \S/);
    expect([...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())).toEqual(SECTIONS);
    const alternatives = text.split("## Alternatives considered")[1].split("\n## ")[0];
    expect(alternatives).toMatch(/\]\(\.\.\/DESIGN_DECISIONS\.md#\d+-[a-z0-9-]+\)/);
  });

  it.each(componentDocs)("%s: every repo path named in code spans exists", (file) => {
    const paths = [...read(join(ARCH, file)).matchAll(/`([^`\s]+\/[^`\s]*\.(?:js|mjs|ts|tsx|json|yaml|yml|toml|md))`/g)].map((m) => m[1]);
    const missing = paths.filter((p) => !existsSync(join(ROOT, p)));
    expect(missing).toEqual([]);
  });
});

describe("relative links in docs/", () => {
  const files = mdFiles(join(ROOT, "docs"));

  it.each(files.map((f) => relative(ROOT, f).replace(/\\/g, "/")))("%s: every relative link and anchor resolves", (rel) => {
    const file = join(ROOT, rel);
    const text = read(file);
    const broken = [];
    for (const [, target] of prose(text).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [path, anchor] = target.split("#");
      const dest = path ? join(dirname(file), decodeURIComponent(path)) : file;
      if (!existsSync(dest)) { broken.push(`${target} (no file)`); continue; }
      if (anchor && dest.endsWith(".md") && !anchors(read(dest)).includes(anchor)) broken.push(`${target} (no heading)`);
    }
    expect(broken).toEqual([]);
  });
});
