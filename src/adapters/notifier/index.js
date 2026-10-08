// Factory: picks the Notifier implementation from config (NOTIFIER in .env).

import { config } from "../../config.js";
import { ConsoleNotifier } from "./consoleNotifier.js";
import { SnsNotifier } from "./snsNotifier.js";
import { SnsAlertPublisher, SnsSubscriptionManager } from "./snsPublicTopic.js";

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

/**
 * Public subscriber alerts (PUBLIC_ALERTS=sns): a separate publisher for the public topic. Never returned by
 * createNotifier(), so ops events can't reach subscribers. null when PUBLIC_ALERTS=off (the default; local runs).
 */
export function createAlertPublisher(kind = config.publicAlerts.mode) {
  switch (kind) {
    case "off":
      return null;
    case "sns":
      return new SnsAlertPublisher({ topicArn: config.publicAlerts.topicArn, privateTopicArn: config.aws.snsTopicArn, region: config.aws.region });
    default:
      throw new Error(`Unknown PUBLIC_ALERTS "${kind}". Supported: off, sns`);
  }
}

/** Sign-up Lambda: counts and creates subscriptions on the public topic. */
export const createSubscriptionManager = () =>
  new SnsSubscriptionManager({ topicArn: config.publicAlerts.topicArn, privateTopicArn: config.aws.snsTopicArn, region: config.aws.region });

export { Notifier } from "./Notifier.js";
