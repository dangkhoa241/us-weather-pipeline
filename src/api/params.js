// src/api/params.js
// Parameter rules shared by every API implementation. Each framework expresses them in its own schema language
// (Zod, JSON Schema, ...); the service re-checks the semantic rules (ranges, existence) so all behave the same.

export { METRICS, PERIODS } from "../adapters/warehouse/Warehouse.js";

export const PATTERNS = Object.freeze({
  locationId: "^[a-z0-9-]{1,40}$",
  date: "^\\d{4}-\\d{2}-\\d{2}$",
  state: "^[A-Z]{2}$",
  // year 2025 | half 2025-H1 | quarter 2025-Q3 | month 2025-07 | week/day 2025-07-07
  drillKey: "^\\d{4}(-(H[12]|Q[1-4]|\\d{2}(-\\d{2})?))?$",
});

export const DRILL_LEVELS = Object.freeze(["year", "half", "quarter", "month", "week", "day"]);
export const COMPARE = Object.freeze(["previous", "last_year"]);
export const STAGES = Object.freeze(["stage1", "stage2", "stage3", "pipeline"]);

export const LIMITS = Object.freeze({
  maxLocations: 25,      // per stats request
  maxRangeDays: 4000,    // ~11 years
  maxForecastDays: 16,
  maxRuns: 200,
});
