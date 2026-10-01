import { describe, it, expect } from "vitest";
import { conditionOf, dailyCards, local, modelDailyHighs, next48, type HourlyRow } from "@/lib/forecast";

const TZ = "America/Los_Angeles";   // UTC−7 in October

describe("forecast helpers", () => {
  it("converts API UTC times to the city's local date and hour", () => {
    expect(local("2026-10-02 06:00:00", TZ)).toMatchObject({ date: "2026-10-01", hour: 23 });
    expect(local("2026-10-02 07:00:00", TZ)).toMatchObject({ date: "2026-10-02", hour: 0, weekday: "Fri" });
  });

  it("turns NWS day/night periods into daily cards (high from day, low from the night that starts that date)", () => {
    const cards = dailyCards([
      { target_time: "2026-10-01 20:00:00", temp_c: 34, precip_prob_pct: 0, short_forecast: "Sunny" },          // Thu 1 PM
      { target_time: "2026-10-02 01:00:00", temp_c: 17, precip_prob_pct: 10, short_forecast: "Mostly Clear" },  // Thu 6 PM
      { target_time: "2026-10-02 13:00:00", temp_c: 30, precip_prob_pct: 40, short_forecast: "Chance Showers" },// Fri 6 AM
    ], TZ);
    expect(cards).toEqual([
      { date: "2026-10-01", weekday: "Thu", high: 34, low: 17, rainChance: 10, text: "Sunny", night: false },
      { date: "2026-10-02", weekday: "Fri", high: 30, low: null, rainChance: 40, text: "Chance Showers", night: false },
    ]);
  });

  it("classifies the forecaster's text for the icon", () => {
    expect(conditionOf("Chance Showers And Thunderstorms")).toBe("storm");
    expect(conditionOf("Light Rain Likely")).toBe("rain");
    expect(conditionOf("Mostly Sunny")).toBe("partly");
    expect(conditionOf("Cloudy")).toBe("cloud");
    expect(conditionOf("Clear")).toBe("clear");
  });

  const hours = (model: string, startUtc: string, n: number, temp: (i: number) => number | null): HourlyRow[] =>
    Array.from({ length: n }, (_, i) => ({
      model, temp_c: temp(i), precip_mm: null, precip_prob_pct: i % 10,
      target_time: new Date(Date.parse(`${startUtc.replace(" ", "T")}Z`) + i * 3_600_000).toISOString().slice(0, 19).replace("T", " "),
    }));

  it("takes the first 48 NWS hours, with rain chance as the bar value", () => {
    const { temp, rain } = next48([...hours("nws", "2026-10-01 20:00:00", 60, () => 20), ...hours("gfs_global", "2026-10-01 20:00:00", 60, () => 25)], TZ);
    expect(temp).toHaveLength(48);
    expect(temp[0]).toMatchObject({ avg: 20, label: "1p" });
    expect(rain[3].sum).toBe(3);
  });

  it("computes each model's daily high from tomorrow on, leaving days with too few hours empty", () => {
    // Starts Thu 1 PM local. GFS covers 3 full days; HRRR only 18 hours (no full local day).
    const rows = [...hours("gfs_global", "2026-10-01 20:00:00", 80, (i) => (i % 24 === 5 ? 30 : 20)), ...hours("gfs_hrrr", "2026-10-01 20:00:00", 18, () => 22)];
    const { dates, series } = modelDailyHighs(rows, TZ, ["gfs_global", "gfs_hrrr"], 3);
    expect(dates).toEqual(["2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(series.gfs_global).toEqual([30, 30, 30]);
    expect(series.gfs_hrrr).toEqual([null, null, null]);
  });
});
