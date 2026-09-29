// Console implementation of Notifier: prints events to stdout/stderr.

import { Notifier } from "./Notifier.js";

const LOG = { info: console.log, warn: console.warn, error: console.error };

export class ConsoleNotifier extends Notifier {
  async notify({ level = "info", title, message = "", data }) {
    const log = LOG[level] ?? console.log;
    log(`[notify:${level}] ${title}${message ? ` - ${message}` : ""}`);
    if (data) log(JSON.stringify(data, null, 2));
  }
}
