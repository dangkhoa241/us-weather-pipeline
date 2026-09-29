// Factory: picks the Notifier implementation from config (NOTIFIER in .env).

import { config } from "../../config.js";
import { ConsoleNotifier } from "./consoleNotifier.js";

export function createNotifier(kind = config.adapters.notifier) {
  switch (kind) {
    case "console":
      return new ConsoleNotifier();
    // case "discord": return new DiscordNotifier(config.discord);
    // case "sns":     return new SnsNotifier(config.sns);   // optional AWS phase
    default:
      throw new Error(`Unknown NOTIFIER "${kind}". Supported: console`);
  }
}

export { Notifier } from "./Notifier.js";
