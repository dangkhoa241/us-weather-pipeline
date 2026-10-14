import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "./memoryStore.js";
import { RunLog } from "../src/lib/runLog.js";
import { COLLECTIONS } from "../src/collections.js";
import { openMeteoGet } from "../src/lib/http.js";
import {
  FILL_BASIS, FILL_METHOD, MAX_DAY1_DIFF_F, addDay1Comparison, fillForecastGaps, leadDaysFor, planRanges, requestWeight,
  summarizeComparison, supersedeFilledSlots, validationGate,
} from "../src/stage1/openMeteoGapFill.js";

vi.mock("../src/lib/http.js", () => ({ openMeteoGet: vi.fn(), HttpError: class HttpError extends Error {} }));

const SNAPSHOTS = COLLECTIONS.forecastSnapshots;
const USAGE = COLLECTIONS.apiUsage.name;
const NOW = new Date("2026-10-14T18:00:00Z");
const DAY = "2026-08-20";
const T0 = Date.parse(`${DAY}T00:00:00Z`);
const H = 3_600_000;
const LOCATION = { id: "stockton-ca", state: "CA", lat: 37.96, lon: -121.29 };
const MODEL = "ecmwf_ifs025";

/** A Previous Runs answer for DAY: previous_dayN = 20 + N °C at every hour. */
function previousRunsAnswer() {
  const time = Array.from({ length: 24 }, (_, h) => new Date(T0 + h * H).toISOString().slice(0, 16));
  const hourly = { time };
  for (let n = 1; n <= 7; n += 1) hourly[`temperature_2m_previous_day${n}`] = time.map(() => 20 + n);
  return { hourly };
}

const collectedRow = (hour, lead, temp, extra = {}) => ({
  location_id: LOCATION.id, source: "open-meteo", model: MODEL, kind: "hourly", fetch_method: "single_runs",
  issued_at_basis: "model_run", issued_at: new Date(T0 + hour * H - (lead * 24 + 6) * H), target_time: new Date(T0 + hour * H),
  lead_hours: lead * 24 + 6, lead_days: lead, values: { temp_c: temp }, fetched_at: NOW, ...extra,
});

/** A finished --validate run in pipeline_runs (the fill's gate). */
const validationRun = (validation) => ({
  etl_batch_id: "v1", stage: "stage1", mode: "om-gap-fill", status: "success", started_at: new Date("2026-10-14T17:00:00Z"),
  gap_fill: { mode: "validate", calls_used: 10, validation },
});

async function setup({ validation = { [MODEL]: { diff_f: -0.05, ok: true } } } = {}) {
  const store = new MemoryStore();
  if (validation) await store.insertOne(COLLECTIONS.pipelineRuns.name, validationRun(validation));
  await store.insertMissing(SNAPSHOTS.name, [collectedRow(0, 1, 22)], SNAPSHOTS.uniqueKey);   // slot (00:00, lead 1) is collected
  await store.insertMissing(COLLECTIONS.observationsHourly.name,
    Array.from({ length: 24 }, (_, h) => ({ location_id: LOCATION.id, time: new Date(T0 + h * H), temp_c: 21 })), ["location_id", "time"]);
  return store;
}
const runOf = (store) => new RunLog(store, { stage: "stage1", mode: "om-gap-fill" }).start();
const fill = async (store, opts = {}) => fillForecastGaps(store, [LOCATION], await runOf(store),
  { range: { from: DAY, to: DAY }, models: [MODEL], now: NOW, ...opts });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "table").mockImplementation(() => {});
  openMeteoGet.mockReset();
  openMeteoGet.mockResolvedValue(previousRunsAnswer());
});
afterEach(() => vi.useRealTimers());

describe("fillForecastGaps (Previous Runs → empty accuracy slots)", () => {
  it("fills only empty (model, city, hour, lead day) slots and never the collected one", async () => {
    const store = await setup();
    const result = await fill(store);
    expect(openMeteoGet).toHaveBeenCalledTimes(1);
    expect(result.inserted_by_model[MODEL]).toBe(24 * 7 - 1);
    const slot = await store.find(SNAPSHOTS.name, { model: MODEL, target_time: new Date(T0), lead_days: 1 });
    expect(slot).toHaveLength(1);                         // one row for the collected slot: no double count
    expect(slot[0]).toMatchObject({ fetch_method: "single_runs", values: { temp_c: 22 } });   // not overwritten
  });

  it("marks the filled rows with their source: fetch_method previous_runs, approximate issued_at, no lead_hours", async () => {
    const store = await setup();
    await fill(store);
    const [row] = await store.find(SNAPSHOTS.name, { model: MODEL, target_time: new Date(T0 + 5 * H), lead_days: 3 });
    expect(row).toMatchObject({
      source: "open-meteo", fetch_method: FILL_METHOD, issued_at_basis: FILL_BASIS, kind: "hourly",
      lead_hours: null, lead_days: 3, issued_at: new Date(T0 + 5 * H - 3 * 86_400_000), values: { temp_c: 23 },
    });
    expect(row.exclude_from_accuracy).toBeUndefined();
  });

  it("a second run plans no request and changes nothing", async () => {
    const store = await setup();
    await fill(store);
    const rows = structuredClone(await store.find(SNAPSHOTS.name));
    openMeteoGet.mockClear();
    const again = await fill(store);
    expect(openMeteoGet).not.toHaveBeenCalled();
    expect(again.requests).toBe(0);
    expect(await store.find(SNAPSHOTS.name)).toEqual(rows);
  });

  it("dry run: plans requests and weighted calls, no API call, nothing written", async () => {
    const store = await setup();
    const result = await fill(store, { dryRun: true });
    expect(result).toMatchObject({ plan_only: true, requests: 1, calls_planned: 1, calls_used: 0 });
    expect(openMeteoGet).not.toHaveBeenCalled();
    expect(await store.count(SNAPSHOTS.name)).toBe(1);
  });

  it("validate: compares lead-day-1 MAE on the same city-hours and writes nothing", async () => {
    const store = await setup();
    const result = await fill(store, { validate: true });
    // collected 22 vs observed 21 → 1 °C; Previous Runs day 1 = 21 → 0 °C, on the one shared city-hour
    expect(result.validation[MODEL]).toMatchObject({ city_hours: 1, collected_rows: 1, collected_mae_f: 1.8, previous_runs_mae_f: 0, diff_f: -1.8, ok: false });
    expect(await store.count(SNAPSHOTS.name)).toBe(1);
  });
});

describe("validation gate (a fill writes only after a passing --validate run)", () => {
  it("fills nothing and calls nothing when the last validation is over the threshold for a model", async () => {
    const store = await setup({ validation: { [MODEL]: { diff_f: -0.21, ok: false } } });
    const result = await fill(store);
    expect(result.gate).toMatch(/ecmwf_ifs025 -0.21 °F/);
    expect(openMeteoGet).not.toHaveBeenCalled();
    expect(await store.count(SNAPSHOTS.name)).toBe(1);
  });

  it("needs a validation run that compared every model", async () => {
    expect((await validationGate(await setup({ validation: null }), [MODEL])).reason).toMatch(/no validation run yet/);
    expect((await validationGate(await setup(), [MODEL, "gfs_hrrr"])).reason).toMatch(/gfs_hrrr not compared/);
    expect((await validationGate(await setup(), [MODEL])).ok).toBe(true);
  });
});

describe("supersedeFilledSlots (no double counting after the Single Runs backfill catches up)", () => {
  it("excludes a filled row once a collected row lands in its slot, and only that row", async () => {
    const store = await setup();
    await fill(store);
    expect(await supersedeFilledSlots(store, [MODEL], new Date(NOW.getTime() + 60_000))).toBe(0);

    vi.setSystemTime(new Date(NOW.getTime() + 2 * H));
    await store.insertMissing(SNAPSHOTS.name, [collectedRow(5, 3, 24)], SNAPSHOTS.uniqueKey);   // backfill reaches (05:00, lead 3)
    const at = new Date(NOW.getTime() + 3 * H);
    expect(await supersedeFilledSlots(store, [MODEL], at)).toBe(1);
    const slot = await store.find(SNAPSHOTS.name, { model: MODEL, target_time: new Date(T0 + 5 * H), lead_days: 3 });
    const filled = slot.find((d) => d.fetch_method === FILL_METHOD);
    expect(filled).toMatchObject({ exclude_from_accuracy: true, stored_at: at });   // stored_at: Stage 2 reloads it
    expect(await store.count(SNAPSHOTS.name, { fetch_method: FILL_METHOD, exclude_from_accuracy: true })).toBe(1);
    expect(await supersedeFilledSlots(store, [MODEL], new Date(at.getTime() + H))).toBe(0);   // incremental: nothing new
  });
});

describe("budget accounting (shared Open-Meteo ledger, 75% share)", () => {
  it("records each request's weighted calls in the hour and day ledger", async () => {
    const store = await setup();
    const result = await fill(store);
    expect(result.calls_used).toBe(1);
    expect((await store.findOne(USAGE, { api: "open-meteo", period: "day:2026-10-14" })).calls).toBe(1);
    expect((await store.findOne(USAGE, { api: "open-meteo", period: "hour:2026-10-14T18" })).calls).toBe(1);
  });

  it("stops cleanly before the daily share (4,500 of 6,000) and makes no request past it", async () => {
    const store = await setup();
    await store.increment(USAGE, { api: "open-meteo", period: "day:2026-10-14" }, { calls: 4499.5 });
    const run = await runOf(store);
    const result = await fillForecastGaps(store, [LOCATION], run, { range: { from: DAY, to: DAY }, models: [MODEL], now: NOW });
    expect(openMeteoGet).not.toHaveBeenCalled();
    expect(result).toMatchObject({ requests: 0, calls_used: 0 });
    expect(run.skipped[0].reason).toMatch(/daily budget reached/);
    expect(await store.count(SNAPSHOTS.name)).toBe(1);
  });

  it("request weight: 7 lead-day variables per 14 days count as 1 call; longer ranges scale", () => {
    expect(requestWeight(1)).toBe(1);
    expect(requestWeight(14)).toBe(1);
    expect(requestWeight(90)).toBeCloseTo(90 / 14);
  });
});

describe("planning helpers", () => {
  const day = (d) => Date.parse(`2026-08-${String(d).padStart(2, "0")}T00:00:00Z`);

  it("joins wanted days into one request when the days between cost less than a new request", () => {
    const wanted = new Set([day(1), day(2), day(10), day(30)]);
    const ranges = planRanges(day(1), day(31), (d) => wanted.has(d));
    expect(ranges.map((r) => [new Date(r.from).getUTCDate(), new Date(r.to).getUTCDate(), r.days])).toEqual([[1, 10, 10], [30, 30, 1]]);
  });

  it("HRRR's 48-hour runs reach lead day 1 only; the global models all 7", () => {
    expect(leadDaysFor("gfs_hrrr")).toEqual([1]);
    expect(leadDaysFor("ecmwf_ifs025")).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("validation summary flags a model only above the threshold", () => {
    const stats = {};
    const hourly = { time: ["2026-08-20T00:00"], temperature_2m_previous_day1: [20.05] };
    addDay1Comparison(stats, MODEL, "c", hourly, { fromMs: T0, day1Temps: new Map([[0, [20, 20.1]]]), observed: new Map([[`c|${T0}`, 20]]) });
    const s = summarizeComparison(stats)[MODEL];
    expect(s.collected_rows).toBe(2);
    expect(Math.abs(s.diff_f)).toBeLessThanOrEqual(MAX_DAY1_DIFF_F);
    expect(s.ok).toBe(true);
  });
});
