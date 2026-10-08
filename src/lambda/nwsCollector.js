// AWS Lambda (Stage 6a part 3): NWS collection on EventBridge schedules instead of GitHub Actions.
// Event { "mode": "alerts" } hourly, { "mode": "forecast" } every 3 hours (infra/template.yaml).
// Same work as the GitHub workflows: NWS → MongoDB Atlas (same collections, 7-day TTL), plus the S3 raw archive.
// The Atlas URI comes from SSM (MONGO_URI_SSM_PARAM) at cold start; failures are emailed through SNS (NOTIFIER=sns).
// The handler never throws, so Lambda doesn't retry a failed run (and send the same email three times).

import { config } from "../config.js";
import { ensureCollections } from "../collections.js";
import { createRawStore } from "../adapters/rawStore/index.js";
import { createAlertPublisher, createNotifier } from "../adapters/notifier/index.js";
import { createCounterStore } from "../adapters/counterStore/index.js";
import { redact } from "../adapters/notifier/snsNotifier.js";
import { runMode } from "../stage1/runMode.js";
import { createPublicAlerts } from "../stage1/publicAlerts.js";
import { getSecureParameter } from "./ssmParameter.js";

const MODES = ["alerts", "forecast"];

/** Dependencies are injectable for tests. */
export function createHandler({
  getParameter = getSecureParameter,
  makeStore = (uri) => createRawStore(config.adapters.rawStore, { uri }, { archive: true }),
  makeNotifier = createNotifier,
  makeAlertPublisher = createAlertPublisher,   // null when PUBLIC_ALERTS=off
  makeCounters = createCounterStore,
} = {}) {
  let mongoUri = null;   // kept for warm invocations

  return async function handler(event) {
    const mode = event?.mode;
    const notifier = makeNotifier();
    if (!MODES.includes(mode)) {
      await notifier.notify({ level: "error", title: "Lambda NWS collector: bad event", message: `mode must be one of ${MODES.join(", ")}` });
      return { mode: String(mode), status: "failed" };
    }
    let store = null;
    try {
      mongoUri ??= await getParameter(config.aws.mongoUriParam);
      store = makeStore(mongoUri);
      await store.connect();
      await ensureCollections(store);
      // Subscriber emails (alerts mode only): their own publisher on the public topic; `notifier` (private) only for
      // the owner's "paused" notice.
      const publisher = mode === "alerts" ? makeAlertPublisher() : null;
      const publicAlerts = publisher && createPublicAlerts({
        publisher, counters: makeCounters(), notifier, monthlyCap: config.publicAlerts.monthlyEmailCap,
        cooldownHours: config.publicAlerts.cooldownHours, dashboardUrl: config.publicAlerts.dashboardUrl,
      });
      const { status, etl_batch_id, rows_fetched, error_count } = await runMode(mode, store, notifier, { publicAlerts });   // notifies on failure
      return { mode, status, etl_batch_id, rows_fetched, error_count };
    } catch (err) {
      mongoUri = null;   // re-read next time (the parameter may have been rotated)
      const message = redact(err?.message ?? err);
      console.error(`[lambda:${mode}] failed: ${message}`);
      await notifier.notify({ level: "error", title: `Lambda NWS ${mode} failed`, message });
      return { mode, status: "failed" };
    } finally {
      await store?.close().catch((err) => console.warn(`[lambda:${mode}] close: ${redact(err.message)}`));
    }
  };
}

export const handler = createHandler();
