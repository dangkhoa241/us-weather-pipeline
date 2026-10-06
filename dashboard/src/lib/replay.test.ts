import { describe, expect, it, vi } from "vitest";
import {
  ReplayError, archiveUrl, buildReplay, checkReplayInput, fetchReplay, loadReplaySample, localDayHours, localHigh,
  pickSample, previousRunsUrl, replayCity, replayDaysInMonth, replayInsight, replayRange, replaySeries,
} from "@/lib/replay";
import file from "../../public/data/replay-sample.json?raw";
import { HIGHS, NOW, OBSERVED, archiveBody, json, openMeteoFetch, previousRunsBody } from "@/test/replayFixtures";

const DAY = "2026-09-20";
const stockton = replayCity("stockton-ca")!;

describe("input validation", () => {
  it("accepts one of the 53 cities and a day inside the range", () => {
    expect(replayRange(NOW)).toEqual({ from: "2024-03-01", to: "2026-09-28" });
    expect(checkReplayInput("stockton-ca", "2026-09-28", NOW).timezone).toBe("America/Los_Angeles");
  });
  it.each([
    ["unknown city", "springfield-xx", DAY],
    ["prototype key", "__proto__", DAY],
    ["the All-US pseudo location", "all", DAY],
    ["too recent (archive not settled)", "stockton-ca", "2026-09-29"],
    ["before the models' history", "stockton-ca", "2024-02-29"],
    ["not a calendar day", "stockton-ca", "2026-02-30"],
    ["not a day key", "stockton-ca", "2026-09-20T00:00"],
    ["injection attempt", "stockton-ca", "2026-09-20&models=x"],
  ])("rejects %s", (_, city, day) => {
    expect(() => checkReplayInput(city, day, NOW)).toThrow(ReplayError);
  });
  it("lists the replayable days of a month with the injected clock", () => {
    expect(replayDaysInMonth("2026", "09", NOW).at(-1)).toBe("2026-09-28");
    expect(replayDaysInMonth("2026", "10", NOW)).toEqual([]);
    expect(replayDaysInMonth("2024", "02", NOW)).toEqual([]);
    expect(replayDaysInMonth("2024", "02", Date.parse("2030-01-01"))).toEqual([]);
    expect(replayDaysInMonth("2025", "02", NOW)).toHaveLength(28);
  });
});

describe("URLs", () => {
  it("asks Previous Runs for 7 lead days × 5 models over the UTC days around the local day", () => {
    const url = new URL(previousRunsUrl(stockton, DAY));
    expect(url.origin + url.pathname).toBe("https://previous-runs-api.open-meteo.com/v1/forecast");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: "37.9577", longitude: "-121.2908",
      hourly: [1, 2, 3, 4, 5, 6, 7].map((n) => `temperature_2m_previous_day${n}`).join(","),
      models: "ecmwf_ifs025,gfs_global,icon_global,gfs_hrrr,best_match",
      timezone: "GMT", start_date: "2026-09-19", end_date: "2026-09-21",
    });
  });
  it("asks the archive for hourly temperature only", () => {
    const url = new URL(archiveUrl(stockton, "2026-01-01"));
    expect(url.origin + url.pathname).toBe("https://archive-api.open-meteo.com/v1/archive");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: "37.9577", longitude: "-121.2908", hourly: "temperature_2m", timezone: "GMT", start_date: "2025-12-31", end_date: "2026-01-02",
    });
  });
});

describe("local day", () => {
  const utcHours = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from) + i * 3_600_000).toISOString().slice(0, 16));
  it("has 24, 23 or 25 hours across DST changes", () => {
    expect(localDayHours(utcHours("2026-09-19T00:00Z", 72), "America/Los_Angeles", "2026-09-20")).toEqual([...Array(24).keys()].map((i) => i + 31));
    expect(localDayHours(utcHours("2025-03-08T00:00Z", 72), "America/Los_Angeles", "2025-03-09")).toHaveLength(23);
    expect(localDayHours(utcHours("2025-11-01T00:00Z", 72), "America/Los_Angeles", "2025-11-02")).toHaveLength(25);
    expect(localDayHours(utcHours("2025-11-01T00:00Z", 72), "Pacific/Honolulu", "2025-11-02")).toHaveLength(24);
  });
  it("is null unless every hour has a value (nulls stay null)", () => {
    expect(localHigh([1, 5, 3], [0, 1, 2])).toBeNull();   // fewer than 23 hours
    const v = Array.from({ length: 24 }, (_, i) => i);
    expect(localHigh(v, [...v.keys()])).toBe(23);
    v[3] = null as unknown as number;
    expect(localHigh(v, [...v.keys()])).toBeNull();
    expect(localHigh(undefined, [...v.keys()])).toBeNull();
  });
});

describe("buildReplay", () => {
  const r = buildReplay(stockton, DAY, previousRunsBody(DAY).hourly as never, archiveBody(DAY).hourly as never);
  it("takes the high inside the local day only", () => {
    expect(r.observed).toBe(OBSERVED);   // the 40 °C decoys sit outside the local day
  });
  it("keeps each model's lead days with data, earliest first", () => {
    const leads = Object.fromEntries(r.models.map((m) => [m.id, m.leads.map((l) => l.lead)]));
    expect(leads).toEqual({
      ecmwf_ifs025: [7, 6, 5, 4, 3, 2, 1], gfs_global: [7, 6, 5, 4, 3, 2, 1], icon_global: [6, 5, 4, 3, 2, 1],
      gfs_hrrr: [1], best_match: [7, 6, 5, 4, 2, 1],
    });
    expect(r.models[0].leads[0]).toEqual({ lead: 7, high: HIGHS.ecmwf_ifs025[7] });
    expect(r.missing).toEqual([]);
  });
  it("lists a model with no data as missing instead of drawing it", () => {
    const prev = previousRunsBody(DAY).hourly as Record<string, unknown>;
    for (const k of Object.keys(prev)) if (k.endsWith("_gfs_hrrr")) prev[k] = Array(72).fill(null);
    const out = buildReplay(stockton, DAY, prev as never, archiveBody(DAY).hourly as never);
    expect(out.missing).toEqual(["gfs_hrrr"]);
    expect(out.models.map((m) => m.id)).not.toContain("gfs_hrrr");
  });
  it("fails as unavailable without observations", () => {
    const arch = { ...archiveBody(DAY).hourly, temperature_2m: Array(72).fill(null) };
    expect(() => buildReplay(stockton, DAY, previousRunsBody(DAY).hourly as never, arch as never)).toThrow("No complete observations");
  });
});

describe("fetchReplay", () => {
  it("makes exactly two requests (Previous Runs + archive) and returns the typed result", async () => {
    const f = openMeteoFetch();
    const r = await fetchReplay("stockton-ca", DAY, { now: NOW, fetch: f });
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls.map(([u]) => new URL(String(u)).host).sort()).toEqual(["archive-api.open-meteo.com", "previous-runs-api.open-meteo.com"]);
    expect(f.mock.calls[0][1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    expect(r).toMatchObject({ city: "stockton-ca", day: DAY, observed: OBSERVED });
    expect(r.models).toHaveLength(5);
  });
  it("sends nothing for invalid input", async () => {
    const f = openMeteoFetch();
    await expect(fetchReplay("nowhere", DAY, { now: NOW, fetch: f })).rejects.toMatchObject({ kind: "invalid" });
    await expect(fetchReplay("stockton-ca", "2026-10-01", { now: NOW, fetch: f })).rejects.toMatchObject({ kind: "invalid" });
    expect(f).not.toHaveBeenCalled();
  });
  it.each([
    ["an HTTP error", () => new Response("rate limited", { status: 429 }), "Open-Meteo answered 429."],
    ["an unexpected body", () => json({ hourly: { time: ["x"], temperature_2m: ["<img src=x onerror=alert(1)>"] } }), "Unexpected answer from Open-Meteo."],
    ["a network error", () => { throw new TypeError("Failed to fetch"); }, "Open-Meteo can't be reached."],
  ])("is unavailable on %s", async (_, answer, message) => {
    const f = vi.fn(async () => answer());
    await expect(fetchReplay("stockton-ca", DAY, { now: NOW, fetch: f })).rejects.toMatchObject({ kind: "unavailable", message });
  });
  it("gives up after the timeout", async () => {
    const f = vi.fn((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    await expect(fetchReplay("stockton-ca", DAY, { now: NOW, fetch: f, timeoutMs: 20 }))
      .rejects.toMatchObject({ kind: "unavailable", message: "Open-Meteo took too long to answer." });
  });
});

describe("insight line", () => {
  const r = buildReplay(stockton, DAY, previousRunsBody(DAY).hourly as never, archiveBody(DAY).hourly as never);
  it("says how far off ECMWF was at its longest and shortest lead, and the closest one-day forecast", () => {
    expect(replayInsight(r, "F")).toBe("ECMWF was off by 6.1°F seven days ahead and by 0.7°F one day ahead. Closest one day ahead: HRRR (0.2°F off).");
    expect(replayInsight(r, "C")).toBe("ECMWF was off by 3.4°C seven days ahead and by 0.4°C one day ahead. Closest one day ahead: HRRR (0.1°C off).");
  });
  it("falls back to the longest-range model and handles a single forecast", () => {
    const one = { ...r, models: [{ id: "gfs_hrrr", name: "HRRR", leads: [{ lead: 1, high: 29.1 }] }] };
    expect(replayInsight(one, "C")).toBe("HRRR was off by 1.0°C one day ahead.");
    expect(replayInsight({ ...r, models: [] }, "C")).toBeNull();
  });
  it("converts series to display units", () => {
    expect(replaySeries(r, "F")[0]).toMatchObject({ id: "ecmwf_ifs025", name: "ECMWF", points: expect.arrayContaining([{ lead: 1, v: 83.3 }]) });
  });
});

describe("bundled sample", () => {
  it("is the committed file: 3 cities, small, valid", async () => {
    expect(file.length).toBeLessThan(5_000);
    const samples = await loadReplaySample(vi.fn(async () => new Response(file)));
    expect(samples.map((s) => s.city)).toEqual(["stockton-ca", "chicago-il", "miami-fl"]);
    expect(pickSample(samples, "chicago-il")?.city).toBe("chicago-il");
    expect(pickSample(samples, "boise-id")?.city).toBe("stockton-ca");
  });
  it("is empty when missing or invalid", async () => {
    expect(await loadReplaySample(vi.fn(async () => new Response("", { status: 404 })))).toEqual([]);
    expect(await loadReplaySample(vi.fn(async () => json({ format: 2 })))).toEqual([]);
    expect(await loadReplaySample(vi.fn(async () => { throw new TypeError("offline"); }))).toEqual([]);
  });
});
