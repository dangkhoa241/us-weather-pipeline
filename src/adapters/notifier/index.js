// Factory: picks the Notifier implementation from config (NOTIFIER in .env).

import { config } from "../../config.js";
import { ConsoleNotifier } from "./consoleNotifier.js";
import { SnsNotifier } from "./snsNotifier.js";

export function createNotifier(kind = config.adapters.notifier) {
  switch (kind) {
    case "console":
      return new ConsoleNotifier();
    case "sns":
      return new SnsNotifier({
        topicArn: config.aws.snsTopicArn, region: config.aws.region, minLevel: config.aws.snsMinLevel, pipelineName: config.pipelineName,
      });
    // case "discord": return new DiscordNotifier(config.discord);
    default:
      throw new Error(`Unknown NOTIFIER "${kind}". Supported: console, sns`);
  }
}

export { Notifier } from "./Notifier.js";
