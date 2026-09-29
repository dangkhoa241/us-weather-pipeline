// Scheduler interface: runs jobs on a cron schedule (node-cron now, EventBridge later).

export class Scheduler {
  /**
   * Register a job. It must not run twice at the same time (overlapping runs are skipped).
   * @param {string} name        unique job name, e.g. "nws-forecast"
   * @param {string} cronExpr    5-field cron expression, e.g. "0 *\/3 * * *"
   * @param {() => Promise<void>} job
   */
  schedule(name, cronExpr, job) { throw new Error("Scheduler.schedule not implemented"); }

  /** Start all registered jobs. */
  async start() { throw new Error("Scheduler.start not implemented"); }

  /** Stop all jobs (used on shutdown). */
  async stop() { throw new Error("Scheduler.stop not implemented"); }
}
