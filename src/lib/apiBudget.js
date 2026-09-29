// src/lib/apiBudget.js
// Usage ledger for rate-limited free APIs (Open-Meteo counts "weighted calls" per minute/hour/day).
// Callers reserve the cost before a request; when the hourly or daily budget would be exceeded,
// reserve() throws BudgetExceeded and the job stops cleanly, to resume on its next run.

import { COLLECTIONS } from "../collections.js";

const USAGE = COLLECTIONS.apiUsage.name;

export class BudgetExceeded extends Error {
  constructor(message) {
    super(message);
    this.name = "BudgetExceeded";
  }
}

const periodKeys = (now) => {
  const iso = now.toISOString();
  return { hour: `hour:${iso.slice(0, 13)}`, day: `day:${iso.slice(0, 10)}` };   // UTC hour and day
};

export class ApiBudget {
  /**
   * @param {import("../adapters/rawStore/RawStore.js").RawStore} store
   * @param {string} api  e.g. "open-meteo"
   * @param {{ perHour: number, perDay: number }} limits  weighted calls
   */
  constructor(store, api, { perHour, perDay }) {
    this.store = store;
    this.api = api;
    this.limits = { hour: perHour, day: perDay };
  }

  /** Weighted calls used in the current UTC hour and day. */
  async usage(now = new Date()) {
    const keys = periodKeys(now);
    const [hour, day] = await Promise.all([
      this.store.findOne(USAGE, { api: this.api, period: keys.hour }),
      this.store.findOne(USAGE, { api: this.api, period: keys.day }),
    ]);
    return { hour: hour?.calls ?? 0, day: day?.calls ?? 0 };
  }

  /** Record `cost` weighted calls, or throw BudgetExceeded if that would pass the hourly/daily budget. */
  async reserve(cost, now = new Date()) {
    const used = await this.usage(now);
    for (const period of ["hour", "day"]) {
      if (used[period] + cost > this.limits[period]) {
        throw new BudgetExceeded(`${this.api} ${period}ly budget reached (${Math.round(used[period])} of ${this.limits[period]} weighted calls)`);
      }
    }
    const keys = periodKeys(now);
    for (const period of ["hour", "day"]) {
      await this.store.increment(USAGE, { api: this.api, period: keys[period] }, { calls: cost }, { updated_at: now });
    }
  }
}
