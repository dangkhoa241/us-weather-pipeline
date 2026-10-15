import { describe, it, expect } from "vitest";
import { DOT_HIT_RADIUS, crowdedDots, labelBox, labelSides, type MapPoint } from "@/lib/mapLabels";

// Fixed coordinates in viewBox units, like the California zoom (k = 2.18): Stockton 42 units east of San Francisco on
// the same row, San Jose 13 east and 25 south of it.
const SF: MapPoint = { id: "san-francisco-ca", name: "San Francisco", x: 100, y: 100 };
const STOCKTON: MapPoint = { id: "stockton-ca", name: "Stockton", x: 142, y: 97 };
const SAN_JOSE: MapPoint = { id: "san-jose-ca", name: "San Jose", x: 113, y: 125 };

describe("labelSides (state zoom)", () => {
  it("puts a label left when its right side would run through another dot", () => {
    const sides = labelSides([SF, STOCKTON, SAN_JOSE]);
    expect(sides.get("san-francisco-ca")).toBe("left");
    expect(sides.get("stockton-ca")).toBe("right");
    expect(sides.get("san-jose-ca")).toBe("right");
  });

  it("keeps labels on the right when nothing is in the way", () => {
    const far = [{ ...SF, x: 0 }, { ...STOCKTON, x: 400 }];
    expect([...labelSides(far).values()]).toEqual(["right", "right"]);
  });

  it("avoids dots it doesn't label (another state's dot in view)", () => {
    const newYork: MapPoint = { id: "new-york-ny", name: "New York", x: 100, y: 100 };
    const newark: MapPoint = { id: "newark-nj", name: "Newark", x: 125, y: 102 };
    expect(labelSides([newYork], [newYork, newark]).get("new-york-ny")).toBe("left");
    expect(labelSides([newYork]).get("new-york-ny")).toBe("right");
  });

  it("keeps the right side when both sides are blocked (no better choice)", () => {
    const left: MapPoint = { id: "w", name: "West", x: 70, y: 100 };
    expect(labelSides([SF], [SF, STOCKTON, left]).get("san-francisco-ca")).toBe("right");
  });

  it("estimates the label box beside the dot", () => {
    expect(labelBox(SF, "right").x0).toBe(112);
    expect(labelBox(SF, "left").x1).toBe(88);
    expect(labelBox(SF, "left").x1 - labelBox(SF, "left").x0).toBeCloseTo("San Francisco".length * 13 * 0.6);
  });
});

describe("crowdedDots (US zoom)", () => {
  it("marks dots whose click areas overlap, and only those", () => {
    const la: MapPoint = { id: "los-angeles-ca", name: "Los Angeles", x: 300, y: 300 };
    const crowded = crowdedDots([SF, { ...SAN_JOSE, x: 104, y: 109 }, la]);
    expect([...crowded].sort()).toEqual(["san-francisco-ca", "san-jose-ca"]);
  });

  it("uses twice the click radius as the distance limit", () => {
    const a: MapPoint = { id: "a", name: "A", x: 0, y: 0 };
    expect(crowdedDots([a, { id: "b", name: "B", x: 2 * DOT_HIT_RADIUS - 0.1, y: 0 }]).size).toBe(2);
    expect(crowdedDots([a, { id: "b", name: "B", x: 2 * DOT_HIT_RADIUS, y: 0 }]).size).toBe(0);
  });
});
