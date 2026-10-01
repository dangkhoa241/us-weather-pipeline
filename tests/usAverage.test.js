import { describe, it, expect } from "vitest";
import { usAverage } from "../src/api/service.js";

const row = (location_id, period_start, avg, extra = {}) => ({
  location_id, period_start, min: avg == null ? null : avg - 5, max: avg == null ? null : avg + 5, avg, sum: null, n_values: avg == null ? 0 : 24, n_hours: 24, ...extra,
});

describe("usAverage (locations=all)", () => {
  it("averages each period over the cities that have data, ignoring nulls (never 0)", () => {
    const out = usAverage([
      row("a", "2026-09-02", 20), row("b", "2026-09-02", 30), row("c", "2026-09-02", null),
      row("a", "2026-09-01", 10),
    ]);
    expect(out).toEqual([
      { location_id: "all", period_start: "2026-09-01", min: 5, max: 15, avg: 10, sum: null, n_values: 24, n_hours: 24, cities: 1 },
      { location_id: "all", period_start: "2026-09-02", min: 20, max: 30, avg: 25, sum: null, n_values: 48, n_hours: 72, cities: 2 },
    ]);
  });

  it("averages rain totals across cities (a US-wide 'typical city')", () => {
    const out = usAverage([
      { ...row("a", "2026-09-01", null), sum: 4, n_values: 24 },
      { ...row("b", "2026-09-01", null), sum: 0, n_values: 24 },
    ]);
    expect(out[0]).toMatchObject({ sum: 2, cities: 2 });
  });
});
