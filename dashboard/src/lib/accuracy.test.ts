import { describe, it, expect } from "vitest";
import { bestModelByState, biasWord, errorToUnit, headToHeadNote, heroLine, leaderboard, MIN_DAYS } from "@/lib/accuracy";
import { deltaToUnit, toUnit } from "@/lib/units";

/** Scored days between two fixed dates, inclusive (what the API's `days` counts for a model scored every day). */
const daysBetween = (first: string, last: string) => (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000 + 1;
const NINETY = daysBetween("2026-07-05", "2026-10-02");   // 90: the dashboard's default range
const row = (model: string, lead_days: number, mae_c: number, bias_c = 0, n = 500, days = NINETY) => ({ model, lead_days, n, days, mae_c, bias_c });

describe("°C → °F for errors and biases", () => {
  it("multiplies by 1.8 only (no +32 offset)", () => {
    expect(errorToUnit(1, "F")).toBeCloseTo(1.8);
    expect(errorToUnit(-2.5, "F")).toBeCloseTo(-4.5);
    expect(errorToUnit(0, "F")).toBe(0);                  // a perfect forecast stays 0, not 32
    expect(errorToUnit(1.2, "C")).toBe(1.2);
    expect(errorToUnit(null, "F")).toBeNull();
    expect(toUnit(1, "F")).toBeCloseTo(33.8);              // absolute temperatures do get +32 …
    expect(deltaToUnit(1, "F")).toBeCloseTo(errorToUnit(1, "F") as number);   // … differences don't
  });

  it("names the bias direction", () => {
    expect(biasWord(0.6)).toBe("too warm");
    expect(biasWord(-0.3)).toBe("too cold");
    expect(biasWord(0.01)).toBe("no bias");
  });
});

describe("leaderboard", () => {
  const rows = [
    row("gfs_global", 1, 1.69, 0.4), row("gfs_global", 2, 1.81),
    row("ecmwf_ifs025", 1, 1.14, -0.2), row("ecmwf_ifs025", 2, 1.28),
    row("icon_global", 1, 1.28), row("icon_global", 2, 1.38),
    row("best_match", 1, 1.0),                          // baseline: listed, never ranked
    row("gfs_hrrr", 1, 0.9, 0, 40),                     // too few samples: not ranked
    row("icon_seamless", 1, 0.5),                       // legacy model: left out
  ];

  it("ranks known models by error at the selected lead day, in the display unit", () => {
    const board = leaderboard(rows, 1, "F");
    expect(board.map((r) => [r.name, r.rank])).toEqual([
      ["ECMWF", 1], ["ICON", 2], ["GFS", 3], ["Best match", null], ["HRRR", null],
    ]);
    expect(board[0].mae[0]).toBeCloseTo(2.052);         // 1.14 °C × 1.8
    expect(board[0].bias).toBeCloseTo(-0.36);
    expect(board[0].mae[6]).toBeNull();                 // no lead-7 data: gap, not 0
  });

  it("re-ranks for another lead day and writes the hero line", () => {
    const board = leaderboard(rows, 2, "C");
    expect(board.filter((r) => r.rank).map((r) => r.name)).toEqual(["ECMWF", "ICON", "GFS"]);
    expect(heroLine(board, 2, "C")).toBe("ECMWF is the most accurate model: 1.3°C average error 2 days ahead.");
    expect(heroLine(leaderboard([], 1, "F"), 1, "F")).toBeNull();
  });

  it("picks the best non-baseline model per state", () => {
    const best = bestModelByState([
      { state: "CA", model: "gfs_global", n: 500, days: NINETY, mae_c: 1.5 }, { state: "CA", model: "icon_global", n: 500, days: NINETY, mae_c: 1.2 },
      { state: "CA", model: "best_match", n: 500, days: NINETY, mae_c: 0.8 }, { state: "TX", model: "ecmwf_ifs025", n: 10, days: NINETY, mae_c: 0.5 },
    ]);
    expect(best.get("CA")).toEqual({ model: "icon_global", mae_c: 1.2 });
    expect(best.has("TX")).toBe(false);
  });
});

describe(`minimum history: ranked only after ${MIN_DAYS} days of scores`, () => {
  // NWS scored 2026-09-29 .. 2026-10-01 (3 days) with a slightly lower error than ECMWF over the full 90 days.
  const nwsDays = daysBetween("2026-09-29", "2026-10-01");
  const rows = [
    row("ecmwf_ifs025", 1, 1.12, 0.03, 81_432), row("icon_global", 1, 1.28, 0.11, 81_144),
    row("gfs_global", 1, 1.67, 0.31, 82_056), row("gfs_hrrr", 1, 1.56, -0.19, 75_480),
    row("best_match", 1, 1.37, 0.05, 112_544),
    row("nws", 1, 1.1, 0.33, 2_175, nwsDays),
  ];

  it("shows a short-history model as not ranked, with its day count, and keeps the leader as the headline", () => {
    expect(nwsDays).toBe(3);
    const board = leaderboard(rows, 1, "F");
    const nws = board.find((r) => r.model === "nws")!;
    expect(nws).toMatchObject({ rank: null, shortHistory: true, days: 3, n: 2_175 });
    expect(board.filter((r) => r.rank).map((r) => r.name)).toEqual(["ECMWF", "ICON", "HRRR", "GFS"]);
    expect(heroLine(board, 1, "F")).toBe("ECMWF is the most accurate model: 2.0°F average error 1 day ahead.");
    expect(board.find((r) => r.baseline)?.shortHistory).toBe(false);   // the baseline is never "short history"
  });

  it("starts ranking on day 30, not day 29", () => {
    const at = (first: string) => leaderboard([...rows.filter((r) => r.model !== "nws"),
      row("nws", 1, 1.1, 0.33, 9_000, daysBetween(first, "2026-09-30"))], 1, "F").find((r) => r.model === "nws")!;
    expect(at("2026-09-02")).toMatchObject({ days: 29, rank: null, shortHistory: true });
    expect(at("2026-09-01")).toMatchObject({ days: 30, rank: 1, shortHistory: false });
  });

  it("leaves short-history models out of the best-model-per-state map", () => {
    const best = bestModelByState([
      { state: "OR", model: "ecmwf_ifs025", n: 2_000, days: NINETY, mae_c: 1.2 },
      { state: "OR", model: "nws", n: 150, days: nwsDays, mae_c: 0.9 },
    ]);
    expect(best.get("OR")).toEqual({ model: "ecmwf_ifs025", mae_c: 1.2 });
  });

  it("writes the head-to-head note on the shared city-hours, labeled as a small sample", () => {
    const board = leaderboard(rows, 1, "F");
    const nws = board.find((r) => r.model === "nws")!;
    const leader = board.find((r) => r.rank === 1);
    const matched = [{ model: "ecmwf_ifs025", n: 412, mae_c: 0.86, target_mae_c: 1.1 }, { model: "gfs_global", n: 412, mae_c: 1.4, target_mae_c: 1.1 }];
    expect(headToHeadNote(nws, leader, matched, "F")).toBe(
      "Small sample: NWS has 3 days of scores so far. On the 412 city-hours both were scored on, ECMWF missed by 1.55°F on average and NWS by 1.98°F.");
    expect(headToHeadNote(nws, leader, [], "F")).toBeNull();          // no shared hours: no note
    expect(headToHeadNote(nws, undefined, matched, "F")).toBeNull();  // nothing ranked: no note
  });
});
