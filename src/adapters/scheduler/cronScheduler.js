// node-cron implementation of Scheduler (runs inside this Node process).

import cron from "node-cron";
import { Scheduler } from "./Scheduler.js";

export class CronScheduler extends Scheduler {
  constructor({ notifier } = {}) {
    super();
    this.notifier = notifier;
    this.jobs = new Map();   // name -> { cronExpr, job, task, running }
  }

  schedule(name, cronExpr, job) {
    if (!cron.validate(cronExpr)) throw new Error(`Invalid cron expression for ${name}: "${cronExpr}"`);
    if (this.jobs.has(name)) throw new Error(`Job "${name}" is already scheduled`);
    this.jobs.set(name, { cronExpr, job, task: null, running: false });
  }

  async start() {
    for (const [name, entry] of this.jobs) {
      entry.task = cron.schedule(entry.cronExpr, () => this.#runOnce(name, entry), { name });
      console.log(`[scheduler] ${name} scheduled: "${entry.cronExpr}"`);
    }
  }

  async stop() {
    for (const entry of this.jobs.values()) entry.task?.stop();
  }

  async #runOnce(name, entry) {
    if (entry.running) {
      console.warn(`[scheduler] ${name} still running, skipping this tick`);
      return;
    }
    entry.running = true;
    try {
      await entry.job();
    } catch (err) {
      await this.notifier?.notify({ level: "error", title: `Job ${name} failed`, message: err.message });
    } finally {
      entry.running = false;
    }
  }
}
