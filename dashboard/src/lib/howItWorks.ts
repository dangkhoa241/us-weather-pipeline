// "How it works" page data: the nodes, edges and layouts of the two diagram views (Data flow, AWS). Public-safe: service
// names only (no account IDs, ARNs, bucket or parameter names, URLs or hosts of our own; a test scans this file).
// Every number names the repo file it comes from. Text may contain {Term} tokens: glossary terms shown with a tooltip.
import { z } from "zod";
import type { OpsData } from "@/lib/ops";

export const REPO_URL = "https://github.com/dangkhoa241/us-weather-pipeline/blob/main/";
/** Link to a file in the public repository (constant base: no user input ever reaches it). */
export const repoLink = (path: string) => `${REPO_URL}${path}`;

export const WHERE = {
  external: { label: "External service", short: "External", dash: "2 4" },
  aws: { label: "AWS (production)", short: "AWS", dash: "" },
  local: { label: "Local laptop (Docker)", short: "Local", dash: "7 4" },
} as const;
export type Where = keyof typeof WHERE;

export type Badge = "collector" | "publisher";
export type FlowNode = {
  id: string; label: string; sub: string; where: Where;
  what: string; why: string; note?: string;
  number?: { value: string; source: string };
  doc?: string;            // repo path of the matching doc
  badge?: Badge;           // live "last run" from status.json
};

const nodes = {
  nws: {
    id: "nws", label: "NWS API", sub: "forecasts + alerts", where: "external",
    what: "The US National Weather Service: official 7-day forecasts and active alerts for the tracked cities.",
    why: "Free and official, no API key (only a User-Agent with a contact).",
    number: { value: "53 cities", source: "README.md" },
  },
  openmeteo: {
    id: "openmeteo", label: "Open-Meteo", sub: "history + 4 models", where: "external",
    what: "Hourly history from its archive, and forecasts from four weather models (ECMWF, GFS, ICON, HRRR).",
    why: "Free for non-commercial use, and it keeps past model runs, which scoring forecasts needs.",
    number: { value: "2,000 / hour and 6,000 / day: our call budget, kept under Open-Meteo's free limits", source: "docs/ROADMAP.md" },
  },
  collector: {
    id: "collector", label: "NWS collector", sub: "serverless function", where: "aws", badge: "collector",
    what: "Runs on a schedule (alerts every hour, forecasts every 3 hours), saves NWS data to the Atlas buffer and a raw copy to S3, and emails alerts.",
    why: "A {Serverless function} inside the free tier, so collection keeps going when the laptop is off.",
    number: { value: "about 1.5 min per forecast run", source: "README.md" },
    doc: "docs/SETUP_AWS.md",
  },
  atlas: {
    id: "atlas", label: "MongoDB Atlas", sub: "7-day buffer", where: "external",
    what: "A free cloud database that holds the NWS data until the laptop copies it home.",
    why: "Free tier, and the same database driver as the local MongoDB.",
    note: "The sync runs when the laptop is on. Atlas keeps 7 days, so the laptop can be off for up to a week without losing NWS data.",
    number: { value: "7 days kept", source: "docs/ROADMAP.md" },
    doc: "docs/SETUP_CLOUD_COLLECTION.md",
  },
  raw: {
    id: "raw", label: "MongoDB (raw)", sub: "Stage 1 fetcher", where: "local",
    what: "The fetcher saves Open-Meteo responses and the synced NWS data as raw documents, each with a unique key.",
    why: "Flexible raw copies, and re-running a fetch updates rows instead of adding duplicates.",
    number: { value: "3.42 M forecast snapshots", source: "README.md" },
  },
  clickhouse: {
    id: "clickhouse", label: "ClickHouse", sub: "Stage 2 warehouse", where: "local",
    what: "{ETL} loads only the new raw rows into warehouse tables, with daily and monthly rollups in each city's local time.",
    why: "A columnar database: aggregates over years of hourly data stay fast.",
    number: { value: "1.75 M hourly rows", source: "README.md" },
  },
  redis: {
    id: "redis", label: "Redis", sub: "Stage 3 cache", where: "local",
    what: "Keeps the answers to the dashboard's queries, versioned so a new data load never serves stale answers.",
    why: "Repeated dashboard queries come from memory instead of the warehouse.",
    number: { value: "warm {p95} 35.4 → 2.9 ms", source: "docs/analysis/caching.md" },
    doc: "docs/analysis/caching.md",
  },
  api: {
    id: "api", label: "Hono API", sub: "Stage 4", where: "local",
    what: "A REST API with OpenAPI docs; it reads the cache and falls back to ClickHouse on a miss.",
    why: "Of the 3 frameworks compared, the lowest memory use and the smallest dependency tree.",
    number: { value: "{p95} 12.7 ms under load", source: "docs/analysis/api-layer.md" },
    doc: "docs/analysis/api-layer.md",
  },
  publisher: {
    id: "publisher", label: "Publisher", sub: "S3 + CloudFront", where: "aws", badge: "publisher",
    what: "A {Serverless function} writes recent history, forecasts, alerts and pipeline status as JSON files to S3; CloudFront, a {CDN}, serves them.",
    why: "Small attack surface: static files only, no code runs per page view.",
    number: { value: "8 runs a day", source: "infra/template.yaml" },
    doc: "docs/analysis/live-dashboard.md",
  },
  dashboard: {
    id: "dashboard", label: "Dashboard", sub: "React on Vercel", where: "external",
    what: "This site: a data snapshot bundled with each deploy, with the live files from CloudFront laid over it.",
    why: "Free static hosting; still works if live data is down (bundled snapshot fallback).",
    number: { value: "665 KB gzipped snapshot", source: "README.md" },
    doc: "docs/DEPLOY_VERCEL.md",
  },
  // AWS view only
  eventbridge: {
    id: "eventbridge", label: "EventBridge", sub: "4 schedules", where: "aws",
    what: "Starts the functions on time: alerts every hour, forecasts every 3 hours, the publisher every 3 hours (history once a day).",
    why: "Scheduled rules cost nothing, and running at most hourly keeps usage far below the free limits.",
    number: { value: "4 schedule rules", source: "infra/template.yaml" },
  },
  awsPublisher: {
    id: "awsPublisher", label: "Publisher", sub: "serverless function", where: "aws", badge: "publisher",
    what: "Builds the live JSON files from Atlas and Open-Meteo, checks that nothing internal is in them, and writes them to S3.",
    why: "Static files instead of an API: no code runs per page view.",
    number: { value: "8 runs a day", source: "infra/template.yaml" },
    doc: "docs/analysis/live-dashboard.md",
  },
  s3: {
    id: "s3", label: "S3", sub: "archive + live files", where: "aws",
    what: "Holds a 30-day raw archive of the API responses and the dashboard's live JSON files; the bucket stays private.",
    why: "Durable storage at no cost at this size; a lifecycle rule deletes old archive files.",
    number: { value: "30-day expiry", source: "infra/template.yaml" },
    doc: "docs/SETUP_AWS.md",
  },
  cloudfront: {
    id: "cloudfront", label: "CloudFront", sub: "CDN", where: "aws",
    what: "A {CDN} that serves only the live files folder of the private bucket.",
    why: "Small attack surface: static files only, no code runs per page view.",
    number: { value: "about 3% of the free requests expected", source: "docs/analysis/live-dashboard.md" },
    doc: "docs/analysis/live-dashboard.md",
  },
  snsOwner: {
    id: "snsOwner", label: "SNS (owner)", sub: "pipeline emails", where: "aws",
    what: "Emails the owner about failed runs and new heat alerts.",
    why: "Free email delivery from the same account, with no mail server to run.",
    number: { value: "under 150 emails a month", source: "README.md" },
  },
  snsPublic: {
    id: "snsPublic", label: "SNS (subscribers)", sub: "alert emails", where: "aws",
    what: "Sends subscriber alert emails, one message per city and alert category; filters pick the recipients.",
    why: "A separate topic, so pipeline emails and subscriber emails never mix.",
    number: { value: "hard cap of 900 emails a month", source: "docs/analysis/email-signups.md" },
    doc: "docs/analysis/email-signups.md",
  },
  signup: {
    id: "signup", label: "Sign-up", sub: "function + URL", where: "aws",
    what: "Checks the form, the bot check and the limits, then adds an email subscription that the visitor confirms by email.",
    why: "A function URL instead of an API gateway: one small public endpoint.",
    number: { value: "128 MB, 8 s timeout", source: "infra/template.yaml" },
    doc: "docs/analysis/email-signups.md",
  },
  dynamodb: {
    id: "dynamodb", label: "DynamoDB", sub: "limits + budget", where: "aws",
    what: "Counters for rate limits, the monthly email budget and cooldowns; old entries expire on their own.",
    why: "Always-free fixed capacity: at worst it slows down, it is never billed.",
    number: { value: "1 read and 1 write capacity unit", source: "infra/template.yaml" },
  },
  turnstile: {
    id: "turnstile", label: "Turnstile", sub: "bot check", where: "external",
    what: "Cloudflare's bot check on the sign-up form; the sign-up function verifies each answer on the server.",
    why: "Free, and it stops scripted sign-ups before any email is sent.",
    doc: "docs/analysis/email-signups.md",
  },
} satisfies Record<string, FlowNode>;
export type NodeId = keyof typeof nodes;
export const NODES: Record<NodeId, FlowNode> = nodes;

export type Side = "t" | "r" | "b" | "l";
export type Point = { x: number; y: number };
/** Anchor sides, curve reach, and offsets along each side (to keep edges leaving one side apart). */
export type Route = { from?: Side; to?: Side; reach?: number; fromOffset?: number; toOffset?: number };
export type Edge = {
  from: NodeId; to: NodeId; label?: string; dashed?: boolean;
  /** Anchor sides and curve reach per layout; omitted = chosen from the node positions. */
  desktop?: Route & { hideLabel?: boolean; labelAt?: Point & { anchor?: "start" | "middle" | "end" } };
  mobile?: Route & { hidden?: boolean };
};
export type Layout = { width: number; height: number; node: { w: number; h: number }; at: Partial<Record<NodeId, Point>> };
export type View = {
  id: "flow" | "aws"; title: string; intro: string;
  nodes: NodeId[];
  edges: Edge[];
  /** Desktop only: lanes (rows, where things run) and column headers (stages). */
  lanes: { where: Where; y: number; h: number }[];
  columns: { label: string; x: number; w: number }[];
  desktop: Layout; mobile: Layout;
};

const flow: View = {
  id: "flow", title: "Data flow",
  intro: "Where the data comes from, how it is processed, stored and cached, and how it reaches this page.",
  nodes: ["nws", "openmeteo", "collector", "atlas", "raw", "clickhouse", "redis", "api", "publisher", "dashboard"],
  edges: [
    { from: "nws", to: "collector", label: "hourly + every 3 h", desktop: { from: "r", to: "t" } },
    { from: "collector", to: "atlas", desktop: { from: "r", to: "l" } },
    { from: "atlas", to: "raw", label: "sync, when the laptop is on", desktop: { from: "b", to: "t" } },
    { from: "openmeteo", to: "raw", label: "Stage 1 fetcher", desktop: { from: "b", to: "l", reach: 180 }, mobile: { from: "b", to: "r", reach: 90 } },
    { from: "raw", to: "clickhouse", label: "ETL", desktop: { from: "r", to: "l" } },
    { from: "clickhouse", to: "redis", desktop: { from: "r", to: "l" } },
    { from: "redis", to: "api", desktop: { from: "r", to: "l" } },
    { from: "clickhouse", to: "api", label: "cache miss", dashed: true, desktop: { from: "b", to: "b", reach: 46 }, mobile: { hidden: true } },
    { from: "api", to: "dashboard", label: "snapshot, exported when I redeploy",
      desktop: { from: "r", to: "r", reach: 45, labelAt: { x: 1238, y: 432, anchor: "end" } }, mobile: { from: "r", to: "r", reach: 70 } },
    { from: "atlas", to: "publisher", label: "NWS forecasts + alerts", desktop: { from: "r", to: "t", hideLabel: true }, mobile: { hidden: true } },
    { from: "openmeteo", to: "publisher", label: "history + 4 models", desktop: { from: "r", to: "l", hideLabel: true }, mobile: { hidden: true } },
    { from: "publisher", to: "dashboard", label: "live JSON", desktop: { from: "r", to: "b", labelAt: { x: 1262, y: 236, anchor: "start" } } },
  ],
  lanes: [{ where: "external", y: 40, h: 180 }, { where: "aws", y: 220, h: 180 }, { where: "local", y: 400, h: 180 }],
  columns: [{ label: "Sources", x: 0, w: 220 }, { label: "Collect", x: 220, w: 220 }, { label: "Store & process", x: 440, w: 600 }, { label: "Serve", x: 1040, w: 300 }],
  desktop: {
    width: 1340, height: 600, node: { w: 140, h: 58 },
    at: {
      nws: { x: 110, y: 95 }, openmeteo: { x: 110, y: 172 }, atlas: { x: 560, y: 130 }, dashboard: { x: 1230, y: 130 },
      collector: { x: 330, y: 310 }, publisher: { x: 1110, y: 310 },
      raw: { x: 560, y: 490 }, clickhouse: { x: 745, y: 490 }, redis: { x: 930, y: 490 }, api: { x: 1110, y: 490 },
    },
  },
  mobile: {
    width: 360, height: 900, node: { w: 150, h: 52 },
    at: {
      nws: { x: 92, y: 40 }, openmeteo: { x: 268, y: 40 }, collector: { x: 180, y: 140 }, atlas: { x: 180, y: 240 },
      raw: { x: 180, y: 340 }, clickhouse: { x: 180, y: 440 }, redis: { x: 180, y: 540 }, api: { x: 180, y: 640 },
      publisher: { x: 180, y: 740 }, dashboard: { x: 180, y: 850 },
    },
  },
};

const aws: View = {
  id: "aws", title: "AWS",
  intro: "How AWS runs the cloud part: schedules, serverless functions, storage, the CDN, emails and the sign-up form.",
  nodes: ["eventbridge", "collector", "awsPublisher", "atlas", "s3", "cloudfront", "dashboard", "snsOwner", "snsPublic", "signup", "turnstile", "dynamodb"],
  edges: [
    { from: "eventbridge", to: "collector", label: "hourly + every 3 h", desktop: { from: "r", to: "l" } },
    { from: "eventbridge", to: "awsPublisher", label: "every 3 h", desktop: { from: "r", to: "l" } },
    { from: "collector", to: "atlas", label: "NWS data", desktop: { from: "t", to: "b", labelAt: { x: 342, y: 210, anchor: "end" } } },
    { from: "atlas", to: "awsPublisher", desktop: { from: "r", to: "t", reach: 130, toOffset: 30 }, mobile: { hidden: true } },
    { from: "collector", to: "s3", label: "raw copy", desktop: { from: "r", to: "t", fromOffset: 16, toOffset: -30 }, mobile: { hidden: true } },
    { from: "awsPublisher", to: "s3", label: "live files", desktop: { from: "r", to: "l" } },
    { from: "s3", to: "cloudfront", label: "private origin", desktop: { from: "r", to: "l" } },
    { from: "cloudfront", to: "dashboard", label: "live JSON", desktop: { from: "t", to: "b", labelAt: { x: 1240, y: 300, anchor: "start" } } },
    { from: "collector", to: "snsOwner", label: "failures, heat", desktop: { from: "r", to: "l", fromOffset: -16 }, mobile: { from: "l", to: "l", reach: 40 } },
    { from: "collector", to: "snsPublic", label: "new alerts", desktop: { from: "r", to: "b", reach: 90, hideLabel: true }, mobile: { hidden: true } },
    { from: "dashboard", to: "signup", label: "sign-up form", desktop: { from: "l", to: "t" } },
    { from: "signup", to: "turnstile", label: "verify", desktop: { from: "t", to: "b" } },
    { from: "signup", to: "dynamodb", label: "limits", desktop: { from: "b", to: "t" } },
    { from: "signup", to: "snsPublic", label: "subscribe", desktop: { from: "l", to: "r" } },
  ],
  lanes: [{ where: "external", y: 40, h: 160 }, { where: "aws", y: 200, h: 380 }],
  columns: [{ label: "Schedule", x: 0, w: 220 }, { label: "Run", x: 220, w: 260 }, { label: "Store & notify", x: 480, w: 470 }, { label: "Serve", x: 950, w: 390 }],
  desktop: {
    width: 1340, height: 600, node: { w: 140, h: 58 },
    at: {
      atlas: { x: 350, y: 120 }, turnstile: { x: 960, y: 120 }, dashboard: { x: 1230, y: 120 },
      eventbridge: { x: 110, y: 390 }, collector: { x: 350, y: 290 }, awsPublisher: { x: 350, y: 500 },
      snsOwner: { x: 600, y: 260 }, snsPublic: { x: 830, y: 260 }, s3: { x: 640, y: 500 },
      signup: { x: 1060, y: 290 }, dynamodb: { x: 1060, y: 420 }, cloudfront: { x: 1230, y: 500 },
    },
  },
  mobile: {
    width: 360, height: 720, node: { w: 150, h: 52 },
    at: {
      eventbridge: { x: 180, y: 40 }, collector: { x: 92, y: 140 }, awsPublisher: { x: 268, y: 140 },
      atlas: { x: 92, y: 240 }, s3: { x: 268, y: 240 }, snsOwner: { x: 92, y: 340 }, cloudfront: { x: 268, y: 340 },
      snsPublic: { x: 92, y: 440 }, dashboard: { x: 268, y: 440 }, signup: { x: 180, y: 560 },
      turnstile: { x: 92, y: 670 }, dynamodb: { x: 268, y: 670 },
    },
  },
};

export const VIEWS = { flow, aws } as const;
export type ViewId = keyof typeof VIEWS;

// ---- Geometry ------------------------------------------------------------------------------------------------------
const NORMAL: Record<Side, Point> = { t: { x: 0, y: -1 }, r: { x: 1, y: 0 }, b: { x: 0, y: 1 }, l: { x: -1, y: 0 } };

export function anchor(p: Point, node: Layout["node"], side: Side, offset = 0): Point {
  const n = NORMAL[side];
  return { x: p.x + n.x * node.w / 2 + (n.x === 0 ? offset : 0), y: p.y + n.y * node.h / 2 + (n.y === 0 ? offset : 0) };
}

/** Sides facing each other: horizontal neighbours connect left/right, vertical ones top/bottom. */
function autoSides(a: Point, b: Point): [Side, Side] {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? ["r", "l"] : ["l", "r"];
  return dy > 0 ? ["b", "t"] : ["t", "b"];
}

/** A cubic Bézier between two node sides; also its midpoint (for the label). */
export function edgePath(a: Point, b: Point, node: Layout["node"], o: Route = {}) {
  const [fs, ts] = autoSides(a, b);
  const p0 = anchor(a, node, o.from ?? fs, o.fromOffset), p3 = anchor(b, node, o.to ?? ts, o.toOffset);
  const reach = o.reach ?? Math.max(30, Math.min(160, Math.hypot(p3.x - p0.x, p3.y - p0.y) / 2));
  const n0 = NORMAL[o.from ?? fs], n3 = NORMAL[o.to ?? ts];
  const p1 = { x: p0.x + n0.x * reach, y: p0.y + n0.y * reach }, p2 = { x: p3.x + n3.x * reach, y: p3.y + n3.y * reach };
  const r = (v: number) => Math.round(v * 10) / 10;
  const mid = { x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8, y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8 };
  return { d: `M${r(p0.x)},${r(p0.y)} C${r(p1.x)},${r(p1.y)} ${r(p2.x)},${r(p2.y)} ${r(p3.x)},${r(p3.y)}`, mid };
}

// ---- Text tokens: "{ETL}" → a glossary term --------------------------------------------------------------------------
export type Part = { text: string; term?: string };
export function parseTerms(text: string): Part[] {
  return text.split(/(\{[^}]+\})/).filter(Boolean).map((s) => (/^\{.+\}$/.test(s) ? { text: s.slice(1, -1), term: s.slice(1, -1) } : { text: s }));
}
export const plain = (text: string) => parseTerms(text).map((p) => p.text).join("");

/** Last run per badge node from status.json (the collector: newest of its alerts and forecast jobs); null if none. */
export function lastRuns(data: OpsData | undefined): Record<Badge, string | null> {
  const job = (id: string) => data?.status.jobs.find((j) => j.id === id)?.lastRunAt ?? null;
  const newest = (...t: (string | null)[]) => t.filter((x): x is string => !!x).sort().at(-1) ?? null;
  return { collector: newest(job("alerts"), job("forecast")), publisher: job("publisher") };
}

// ---- Schema (tested) -----------------------------------------------------------------------------------------------
export const nodeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/), label: z.string().min(2).max(18), sub: z.string().min(2).max(22),
  where: z.enum(["external", "aws", "local"]),
  what: z.string().min(20).max(200), why: z.string().min(20).max(140), note: z.string().max(200).optional(),
  number: z.object({ value: z.string().min(1).max(100), source: z.string().regex(/^[A-Za-z0-9_./-]+\.(md|yaml)$/) }).optional(),
  doc: z.string().regex(/^docs\/[A-Za-z0-9_./-]+\.md$/).optional(),
  badge: z.enum(["collector", "publisher"]).optional(),
}).strict();
