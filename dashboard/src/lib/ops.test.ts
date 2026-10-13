import { beforeEach, describe, expect, it, vi } from "vitest";
import { OPS_NOW, opsStatus } from "@/test/opsFixtures";

const live = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/snapshot", () => ({ fetchLive: vi.fn(async () => live.value) }));
const { STALE_MS, ago, alertsCountingSince, formatDuration, isStale, loadOpsStatus, overall, utcTime } = await import("@/lib/ops");

describe("stale banner logic", () => {
  const generated = "2026-10-08T12:40:00.000Z";
  it("is fresh up to 6 hours, stale after", () => {
    expect(isStale(generated, Date.parse(generated))).toBe(false);
    expect(isStale(generated, Date.parse(generated) + STALE_MS)).toBe(false);
    expect(isStale(generated, Date.parse(generated) + STALE_MS + 1)).toBe(true);
    expect(isStale(generated, Date.parse("2026-10-13T00:00:00Z"))).toBe(true);
  });
});

describe("alerts window", () => {
  const at = (since: string | null) => opsStatus({ alerts7d: { ...opsStatus().alerts7d, since } });
  it("says 'counting since' until the first counted run is at the start of the 7-day window", () => {
    expect(alertsCountingSince(at("2026-10-01T13:23:00.000Z"))).toBeNull();   // full window (generated Oct 8 12:40)
    expect(alertsCountingSince(at("2026-10-01T14:39:00.000Z"))).toBeNull();   // within the 2 h slack
    expect(alertsCountingSince(at("2026-10-01T14:41:00.000Z"))).toBe("counting since Oct 1");
    expect(alertsCountingSince(at("2026-10-06T17:23:00.000Z"))).toBe("counting since Oct 6");
    expect(alertsCountingSince(at(null))).toBeNull();   // nothing recorded: the numbers say "Not recorded yet"
  });
});

describe("formatting", () => {
  it("durations, ages and UTC times", () => {
    expect(formatDuration(2491)).toBe("2.5 s");
    expect(formatDuration(95_712)).toBe("1 min 36 s");
    expect(formatDuration(null)).toBe("–");
    expect(ago("2026-10-08T12:40:00Z", OPS_NOW)).toBe("20 min ago");
    expect(ago("2026-10-08T07:00:00Z", OPS_NOW)).toBe("6 h ago");
    expect(ago("2026-10-05T13:00:00Z", OPS_NOW)).toBe("3 days ago");
    expect(ago("2026-10-08T13:00:30Z", OPS_NOW)).toBe("just now");
    expect(utcTime("2026-10-08T12:07:00.000Z")).toBe("Oct 8, 12:07 PM UTC");
  });
});

describe("overall", () => {
  const jobs = opsStatus().jobs;
  it("worst last run wins", () => {
    expect(overall(jobs)).toEqual({ level: "ok", text: "All jobs ok on their last run" });
    expect(overall([{ ...jobs[0], lastStatus: "partial" }, jobs[1]]).level).toBe("partial");
    expect(overall([{ ...jobs[0], lastStatus: "partial" }, { ...jobs[1], lastStatus: "failed" }])).toEqual({ level: "failed", text: "1 job failed on the last run" });
    expect(overall([jobs[0], { ...jobs[2], lastStatus: null }]).text).toBe("All recorded jobs ok (1 job with no run recorded yet)");
    expect(overall(jobs.map((j) => ({ ...j, lastStatus: null }))).level).toBe("unknown");
  });
});

describe("loadOpsStatus (live first, bundled fallback)", () => {
  beforeEach(() => { live.value = null; vi.unstubAllGlobals(); });

  it("uses the live file when it loads and validates", async () => {
    live.value = opsStatus();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await loadOpsStatus()).toMatchObject({ kind: "live", status: { generatedAt: "2026-10-08T12:40:00.000Z" } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to /data/status.json and labels it snapshot", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(opsStatus()), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    expect((await loadOpsStatus()).kind).toBe("snapshot");
    expect(fetchSpy).toHaveBeenCalledWith("/data/status.json", expect.anything());
  });

  it("throws on a missing or invalid bundled file", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(loadOpsStatus()).rejects.toThrow(/not available \(404\)/);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ format: 2 }), { status: 200 })));
    await expect(loadOpsStatus()).rejects.toThrow(/invalid/);
  });
});
