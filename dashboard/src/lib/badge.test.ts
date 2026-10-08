import { describe, expect, it } from "vitest";
import { badgeParts, shortDay, shortTime } from "@/lib/badge";

const dates = { history: "2026-10-02", forecast: { issued: "2026-10-07 19:50:00", tz: "America/Los_Angeles" }, scored: "2026-10-02" };

describe("header badge wording", () => {
  it("formats days and times from the data, not the clock", () => {
    expect(shortDay("2026-10-02")).toBe("Oct 2");
    expect(shortTime("2026-10-07 19:50:00", "America/Los_Angeles")).toBe("Oct 7, 12:50 PM");
    expect(shortTime("2026-10-07T19:50:00Z", "UTC")).toBe("Oct 7, 7:50 PM");
  });

  it("is page-aware: history on Overview, NWS issue time on Forecast, last scored day on Accuracy", () => {
    expect(badgeParts("overview", dates)).toEqual({ label: "history through", date: "Oct 2" });
    expect(badgeParts("forecast", dates)).toEqual({ label: "forecast updated", date: "Oct 7, 12:50 PM" });
    expect(badgeParts("accuracy", { ...dates, scored: "2026-09-30" })).toEqual({ label: "scored through", date: "Sep 30" });
  });

  it("has no date while the page's data is loading", () => {
    expect(badgeParts("forecast", { ...dates, forecast: null }).date).toBeNull();
  });
});
