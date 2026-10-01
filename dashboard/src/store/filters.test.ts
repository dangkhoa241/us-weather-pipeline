import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { DEFAULTS, createFilterStore, parseFilters, selectedRange, startUrlSync, toSearch } from "@/store/filters";

describe("parseFilters / toSearch", () => {
  it("uses the defaults for an empty query string", () => {
    expect(parseFilters("")).toEqual(DEFAULTS);
    expect(toSearch(DEFAULTS)).toBe("");
  });

  it("reads valid values and round-trips them", () => {
    const f = parseFilters("?loc=miami-fl&period=quarter&range=365d&metric=precip_mm&unit=C&compare=last_year");
    expect(f).toMatchObject({ location: "miami-fl", period: "quarter", preset: "365d", metric: "precip_mm", unit: "C", compare: "last_year" });
    expect(parseFilters(toSearch(f))).toEqual(f);
  });

  it("only writes non-default values", () => {
    expect(toSearch({ ...DEFAULTS, unit: "C" })).toBe("?unit=C");
  });

  it("falls back to defaults for invalid or hostile values", () => {
    const f = parseFilters("?loc=../../etc&period=decade&metric=DROP&unit=K&compare=x&range=forever&__proto__=1");
    expect(f).toEqual(DEFAULTS);
  });

  it("accepts a custom range only with valid, ordered dates", () => {
    expect(parseFilters("?range=custom&from=2026-01-01&to=2026-01-31")).toMatchObject({ preset: "custom", from: "2026-01-01", to: "2026-01-31" });
    expect(parseFilters("?range=custom&from=2026-02-01&to=2026-01-01").preset).toBe(DEFAULTS.preset);
    expect(parseFilters("?range=custom&from=yesterday&to=2026-01-01").preset).toBe(DEFAULTS.preset);
  });

  it("ignores from/to unless the range is custom", () => {
    expect(toSearch({ ...DEFAULTS, from: "2026-01-01", to: "2026-01-31" })).toBe("");
    expect(selectedRange({ ...DEFAULTS, preset: "custom", from: "2026-01-01", to: "2026-01-31" })).toEqual({ from: "2026-01-01", to: "2026-01-31" });
  });
});

describe("startUrlSync", () => {
  let stop: () => void;
  beforeEach(() => window.history.replaceState(null, "", "/?unit=C&loc=denver-co"));
  afterEach(() => stop?.());

  it("starts from the URL, pushes filter changes, and restores them on back/forward", () => {
    const store = createFilterStore(parseFilters(window.location.search));
    stop = startUrlSync(store, window);
    const { result } = renderHook(() => store());
    expect(result.current).toMatchObject({ unit: "C", location: "denver-co" });

    const before = window.history.length;
    act(() => result.current.setFilters({ period: "year" }));
    expect(window.location.search).toBe(toSearch({ ...DEFAULTS, period: "year", unit: "C", location: "denver-co" }));
    expect(window.history.length).toBe(before + 1);

    // Back/forward: the browser changes the URL and fires popstate; the store follows without pushing again.
    act(() => {
      window.history.replaceState(null, "", "/?unit=F&metric=precip_mm");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current).toMatchObject({ unit: "F", metric: "precip_mm", location: DEFAULTS.location, period: DEFAULTS.period });
    expect(window.history.length).toBe(before + 1);
  });

  it("normalizes an invalid URL on start", () => {
    window.history.replaceState(null, "", "/?metric=DROP&unit=C");
    const store = createFilterStore(parseFilters(window.location.search));
    stop = startUrlSync(store, window);
    expect(window.location.search).toBe("?unit=C");
  });
});
