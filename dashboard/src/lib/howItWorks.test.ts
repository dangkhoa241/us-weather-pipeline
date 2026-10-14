import { describe, expect, it } from "vitest";
import SOURCE from "./howItWorks.ts?raw";
import { isGlossaryKey } from "@/lib/glossary";
import { NODES, REPO_URL, VIEWS, edgePath, nodeSchema, parseTerms, plain, repoLink, type NodeId } from "@/lib/howItWorks";

// The repo files a node may cite or link (paths relative to the repo root); listed at build time, never loaded.
const REPO_FILES = new Set(Object.keys(import.meta.glob(["../../../docs/**/*.md", "../../../README.md", "../../../infra/template.yaml"]))
  .map((k) => k.replace(/^(\.\.\/){3}/, "")));
const inRepo = (path: string) => REPO_FILES.has(path);
const texts = Object.values(NODES).flatMap((n) => [n.label, n.sub, n.what, n.why, n.note ?? "", n.number?.value ?? ""]);

describe("How it works data", () => {
  it("every node matches the schema and its key", () => {
    for (const [key, n] of Object.entries(NODES)) {
      expect(nodeSchema.safeParse(n).success, key).toBe(true);
      expect(n.id).toBe(key);
    }
  });

  it("the views have the agreed sizes, unique nodes and edges between their own nodes", () => {
    expect(VIEWS.flow.nodes).toHaveLength(10);
    expect(VIEWS.aws.nodes).toHaveLength(12);
    for (const v of Object.values(VIEWS)) {
      expect(new Set(v.nodes).size, v.id).toBe(v.nodes.length);
      const pairs = v.edges.map((e) => `${e.from}>${e.to}`);
      expect(new Set(pairs).size, v.id).toBe(pairs.length);
      for (const e of v.edges) {
        expect(v.nodes, `${v.id}: ${e.from}`).toContain(e.from);
        expect(v.nodes, `${v.id}: ${e.to}`).toContain(e.to);
      }
      // Every node has a position inside the canvas in both layouts, and never overlaps another node.
      for (const layout of [v.desktop, v.mobile]) {
        const { w, h } = layout.node;
        for (const id of v.nodes) {
          const p = layout.at[id as NodeId];
          expect(p, `${v.id}/${id}`).toBeDefined();
          expect(p!.x - w / 2 >= 0 && p!.x + w / 2 <= layout.width && p!.y - h / 2 >= 0 && p!.y + h / 2 <= layout.height, `${v.id}/${id} in canvas`).toBe(true);
        }
        for (const a of v.nodes) for (const b of v.nodes) {
          if (a >= b) continue;
          const [p, q] = [layout.at[a as NodeId]!, layout.at[b as NodeId]!];
          expect(Math.abs(p.x - q.x) >= w || Math.abs(p.y - q.y) >= h, `${v.id}: ${a} overlaps ${b}`).toBe(true);
        }
      }
    }
  });

  it("every {term} is a glossary entry, and plain() drops the braces", () => {
    const terms = texts.flatMap((t) => parseTerms(t).filter((p) => p.term).map((p) => p.term!));
    expect(terms.length).toBeGreaterThan(3);
    for (const t of terms) expect(isGlossaryKey(t), t).toBe(true);
    expect(plain("warm {p95} 35.4 ms")).toBe("warm p95 35.4 ms");
  });

  it("every number names a source file and every doc link points to a file that exists in the repo", () => {
    for (const n of Object.values(NODES)) {
      if (n.number) expect(inRepo(n.number.source), `${n.id}: ${n.number.source}`).toBe(true);
      if (n.doc) {
        expect(inRepo(n.doc), `${n.id}: ${n.doc}`).toBe(true);
        expect(repoLink(n.doc)).toBe(`${REPO_URL}${n.doc}`);
      }
    }
    expect(REPO_URL).toBe("https://github.com/dangkhoa241/us-weather-pipeline/blob/main/");
  });

  it("edge paths start and end on the node borders", () => {
    const { d } = edgePath({ x: 100, y: 100 }, { x: 400, y: 100 }, { w: 140, h: 58 });
    expect(d.startsWith("M170,100 ")).toBe(true);
    expect(d.endsWith(" 330,100")).toBe(true);
  });
});

// Public-safe: service names only. The page's data file must never carry our account, resource names, URLs or hosts.
const LEAKS: [string, RegExp][] = [
  ["AWS account ID", /(?<!\d)\d{12}(?!\d)/],
  ["ARN", /\barn:aws/i],
  ["resource name", /weather-pipeline-[a-z]/i],
  ["bucket", /\bs3:\/\/|\.s3[.-][a-z0-9-]*amazonaws/i],
  ["SSM parameter name", /parameter\/|["'`]\/weather-pipeline\//i],
  ["Function URL", /lambda-url|\.on\.aws\b/i],
  ["CloudFront host", /\.cloudfront\.net/i],
  ["AWS endpoint", /amazonaws\.com/i],
  ["internal host", /localhost|127\.0\.0\.1|\b10\.\d+\.\d+\.\d+|\.internal\b/i],
  ["database URL", /mongodb(\+srv)?:\/\/|mongodb\.net/i],
  ["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
  ["other URL", /https?:\/\/(?!github\.com\/dangkhoa241\/us-weather-pipeline\/)/],
];
const leaksIn = (text: string) => LEAKS.filter(([, re]) => re.test(text)).map(([what]) => what);

describe("How it works data is public-safe", () => {
  it("the data file and the built data contain none of the leak patterns", () => {
    expect(leaksIn(SOURCE)).toEqual([]);
    expect(leaksIn(JSON.stringify({ NODES, VIEWS }))).toEqual([]);
  });

  it.each([
    ["AWS account ID", "account 123456789012"],
    ["ARN", "arn:aws:sns:us-east-2:1:topic"],
    ["resource name", "weather-pipeline-dashboard-publisher"],
    ["bucket", "s3://my-bucket/dashboard/"],
    ["SSM parameter name", '"/weather-pipeline/atlas-uri"'],
    ["Function URL", "https://abc.lambda-url.us-east-2.on.aws/"],
    ["CloudFront host", "d1abc.cloudfront.net"],
    ["AWS endpoint", "sns.us-east-2.amazonaws.com"],
    ["internal host", "http://localhost:3000"],
    ["database URL", "mongodb+srv://u:p@cluster0.example.mongodb.net"],
    ["email address", "owner@example.com"],
    ["other URL", "https://example.com/x"],
  ])("the scan catches a %s", (what, sample) => {
    expect(leaksIn(sample)).toContain(what);
  });
});
