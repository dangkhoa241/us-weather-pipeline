// Factory: picks the Scheduler implementation from config (SCHEDULER in .env).

import { config } from "../../config.js";
import { CronScheduler } from "./cronScheduler.js";

export function createScheduler({ notifier } = {}, kind = config.adapters.scheduler) {
  switch (kind) {
    case "node-cron":
      return new CronScheduler({ notifier });
    // case "eventbridge": return new EventBridgeScheduler(config.eventbridge);   // optional AWS phase
    default:
      throw new Error(`Unknown SCHEDULER "${kind}". Supported: node-cron`);
  }
}

export { Scheduler } from "./Scheduler.js";
