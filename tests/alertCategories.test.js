import { describe, it, expect } from "vitest";
import {
  CATEGORY_EVENTS, CATEGORY_LABELS, DISCLAIMER, OTHER_EVENTS, PUBLIC_CATEGORIES, TEST_CATEGORY, categoryOf, isUnmappedEvent,
} from "../src/stage1/alertCategories.js";

describe("alert category mapping", () => {
  it("maps the NWS events seen for tracked cities to the six public categories", () => {
    expect(PUBLIC_CATEGORIES).toEqual(["heat", "flood", "wind_storm", "winter", "fire_air", "tropical"]);
    expect(categoryOf("Extreme Heat Warning")).toBe("heat");
    expect(categoryOf("Heat Advisory")).toBe("heat");
    expect(categoryOf("Coastal Flood Advisory")).toBe("flood");
    expect(categoryOf("Flash Flood Warning")).toBe("flood");
    expect(categoryOf("High Wind Watch")).toBe("wind_storm");
    expect(categoryOf("Tornado Warning")).toBe("wind_storm");
    expect(categoryOf("Frost Advisory")).toBe("winter");
    expect(categoryOf("Air Quality Alert")).toBe("fire_air");
    expect(categoryOf("Red Flag Warning")).toBe("fire_air");
    expect(categoryOf("Tropical Cyclone Local Statement")).toBe("tropical");
    expect(categoryOf("Storm Surge Warning")).toBe("tropical");
  });

  it("leaves beach, marine, fog, catch-all and civil alerts in \"other\" (never emailed)", () => {
    for (const event of ["Rip Current Statement", "High Surf Advisory", "Dense Fog Advisory", "Special Weather Statement",
      "Small Craft Advisory", "Storm Warning", "Hurricane Force Wind Warning", "Test Message", "Tsunami Warning", "Child Abduction Emergency"]) {
      expect(categoryOf(event)).toBeNull();
      expect(isUnmappedEvent(event)).toBe(false);
    }
  });

  it("flags unknown event names (exact match only) and never maps them", () => {
    expect(categoryOf("Brand New Hazard Warning")).toBeNull();
    expect(isUnmappedEvent("Brand New Hazard Warning")).toBe(true);
    expect(categoryOf("heat advisory")).toBeNull();   // case matters: exact NWS names
  });

  it("has no event in two categories or in both a category and \"other\"", () => {
    const all = Object.values(CATEGORY_EVENTS).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.filter((e) => OTHER_EVENTS.includes(e))).toEqual([]);
  });

  it("keeps the owner-only test category out of the public allowlist; labels and disclaimer are set", () => {
    expect(PUBLIC_CATEGORIES).not.toContain(TEST_CATEGORY);
    for (const c of [...PUBLIC_CATEGORIES, TEST_CATEGORY]) expect(CATEGORY_LABELS[c]).toBeTruthy();
    expect(DISCLAIMER).toBe("Not an official warning service. For emergencies, use weather.gov and your phone's emergency alerts.");
  });
});
