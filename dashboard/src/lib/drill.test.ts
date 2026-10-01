import { describe, it, expect, afterEach } from "vitest";
import { dayPoints, drillLevel, monthPoints, periodLabel, rangeFor, yearPoints, yearsWithData } from "@/lib/drill";
import { setDataEnd } from "@/lib/dates";
import { parseFilters, toSearch, DEFAULTS } from "@/store/filters";
import type { StatsRow } from "@/lib/api";

const row = (period_start: string, v: Partial<StatsRow> = {}): StatsRow =>
  ({ location_id: "x", period_start, min: 1, max: 9, avg: 5, sum: null, n_values: 24, n_hours: 24, ...v });

afterEach(() => setDataEnd(null));

describe("drill levels and URL state", () => {
  it("maps year/month to a level", () => {
    expect(drillLevel("", "")).toBe("months");
    expect(drillLevel("2025", "")).toBe("months");
    expect(drillLevel("all", "")).toBe("years");
    expect(drillLevel("2025", "07")).toBe("days");
  });

  it("reads and writes year/month in the URL, rejecting invalid values", () => {
    expect(parseFilters("?year=2025&month=07")).toMatchObject({ year: "2025", month: "07" });
    expect(toSearch({ ...DEFAULTS, year: "2025", month: "07" })).toBe("?year=2025&month=07");
    expect(parseFilters("?year=all")).toMatchObject({ year: "all", month: "" });
    expect(parseFilters("?year=all&month=07").month).toBe("");            // a month needs a real year
    expect(parseFilters("?year=20x5&month=13")).toMatchObject({ year: "", month: "" });
    expect(parseFilters("?year=1800").year).toBe("");
  });
});

describe("drill points", () => {
  it("always gives 12 months; months without data (e.g. the future) are null, not 0", () => {
    const pts = monthPoints([row("2026-01-01"), row("2026-02-01", { avg: 0, min: -3, max: 2 })]);
    expect(pts).toHaveLength(12);
    expect(pts[0]).toMatchObject({ key: "01", label: "Jan", avg: 5 });
    expect(pts[1]).toMatchObject({ key: "02", avg: 0 });                  // a real 0 stays 0
    expect(pts[11]).toEqual({ key: "12", label: "Dec", min: null, max: null, avg: null, sum: null });
  });

  it("gives one point per calendar day, including leap days", () => {
    expect(dayPoints("2024", "02", [row("2024-02-29", { sum: 3 })])).toHaveLength(29);
    expect(dayPoints("2024", "02", [row("2024-02-29", { sum: 3 })]).at(-1)).toMatchObject({ key: "29", sum: 3 });
    expect(dayPoints("2025", "02", [])).toHaveLength(28);
  });

  it("lists years with data newest first and builds year points oldest first", () => {
    const rows = [row("2024-01-01"), row("2026-01-01"), row("2025-01-01", { n_values: 0 })];
    expect(yearsWithData(rows)).toEqual(["2026", "2024"]);
    expect(yearPoints(rows).map((p) => p.key)).toEqual(["2024", "2025", "2026"]);
  });

  it("cuts year and month ranges at the latest data day", () => {
    setDataEnd("2026-09-26");
    expect(rangeFor("2026")).toEqual({ from: "2026-01-01", to: "2026-09-26" });
    expect(rangeFor("2025")).toEqual({ from: "2025-01-01", to: "2025-12-31" });
    expect(rangeFor("2026", "09")).toEqual({ from: "2026-09-01", to: "2026-09-26" });
    expect(rangeFor("2024", "02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
  });

  it("labels periods for the trend chart", () => {
    expect(periodLabel("2026-07-06", "week")).toBe("Jul 6");
    expect(periodLabel("2026-07-01", "month")).toBe("Jul 2026");
    expect(periodLabel("2026-07-01", "quarter")).toBe("Q3 2026");
    expect(periodLabel("2026-07-01", "half")).toBe("H2 2026");
    expect(periodLabel("2026-01-01", "year")).toBe("2026");
  });
});
