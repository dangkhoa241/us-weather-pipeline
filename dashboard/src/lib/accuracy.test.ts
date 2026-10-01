import { describe, it, expect } from "vitest";
import { bestModelByState, biasWord, errorToUnit, heroLine, leaderboard } from "@/lib/accuracy";
import { deltaToUnit, toUnit } from "@/lib/units";

const row = (model: string, lead_days: number, mae_c: number, bias_c = 0, n = 500) => ({ model, lead_days, n, mae_c, bias_c });

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
      { state: "CA", model: "gfs_global", n: 500, mae_c: 1.5 }, { state: "CA", model: "icon_global", n: 500, mae_c: 1.2 },
      { state: "CA", model: "best_match", n: 500, mae_c: 0.8 }, { state: "TX", model: "ecmwf_ifs025", n: 10, mae_c: 0.5 },
    ]);
    expect(best.get("CA")).toEqual({ model: "icon_global", mae_c: 1.2 });
    expect(best.has("TX")).toBe(false);
  });
});
