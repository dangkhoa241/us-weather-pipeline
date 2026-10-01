import { describe, it, expect } from "vitest";
import { maWindowFor, movingAverage } from "@/lib/movingAverage";

describe("movingAverage", () => {
  it("averages a centered window that shrinks at the edges", () => {
    expect(movingAverage([1, 2, 3, 4, 5], 3)).toEqual([1.5, 2, 3, 4, 4.5]);
  });

  it("keeps gaps as gaps and ignores nulls inside a window", () => {
    expect(movingAverage([2, null, 4, 6], 3)).toEqual([2, null, 5, 5]);
    expect(movingAverage([null, null], 7)).toEqual([null, null]);
  });

  it("uses 7 points for daily data and 3 periods otherwise", () => {
    expect(maWindowFor(true)).toBe(7);
    expect(maWindowFor(false)).toBe(3);
    expect(movingAverage([0, 0, 0, 7, 0, 0, 0], 7)[3]).toBe(1);
  });
});
