import { describe, it, expect } from "vitest";
import { MAX_GAP_DAYS, historyProblems } from "../src/publish/snapshotFormat.js";

const daily = (n) => ({ from: "2026-01-01", days: n.length, temp: { n } });
const full = (days) => new Array(days).fill(24);
const withGap = (days, start, len) => full(days).map((v, i) => (i >= start && i < start + len ? null : v));

describe("historyProblems (snapshot data-quality check)", () => {
  it("passes when every city has data and gaps are at most MAX_GAP_DAYS", () => {
    const locations = [{ id: "a" }, { id: "b" }];
    expect(historyProblems(locations, { a: daily(full(30)), b: daily(withGap(30, 10, MAX_GAP_DAYS)) })).toEqual([]);
  });

  it("lists cities with no history: missing file, all nulls", () => {
    const locations = [{ id: "a" }, { id: "missing" }, { id: "empty" }];
    expect(historyProblems(locations, { a: daily(full(30)), empty: daily(new Array(30).fill(null)) }))
      .toEqual(["missing: no history", "empty: no history"]);
  });

  it("reports the longest gap anywhere in the window: start, middle or end", () => {
    const locations = [{ id: "start" }, { id: "middle" }, { id: "end" }];
    expect(historyProblems(locations, {
      start: daily(withGap(30, 0, 8)),
      middle: daily(withGap(30, 10, 9)),
      end: daily(withGap(30, 20, 10)),
    })).toEqual([
      "start: 8 days without data (2026-01-01..2026-01-08)",
      "middle: 9 days without data (2026-01-11..2026-01-19)",
      "end: 10 days without data (2026-01-21..2026-01-30)",
    ]);
  });
});
