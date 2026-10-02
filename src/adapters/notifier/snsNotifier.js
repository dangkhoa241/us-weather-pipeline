// Amazon SNS implementation of Notifier (NOTIFIER=sns): every event is logged locally, and events at or above
// SNS_MIN_LEVEL (default "warn": pipeline failures, heat alerts) are published to the SNS topic, which emails them.
// Credentials come from the AWS SDK's default chain (AWS_PROFILE → ~/.aws), never from this repo.
// A failed publish is logged and swallowed: notifications must never break the pipeline.

import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { Notifier } from "./Notifier.js";
import { ConsoleNotifier } from "./consoleNotifier.js";

const RANK = { info: 0, warn: 1, error: 2 };
const TOPIC_ARN = /^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/;
const MAX_MESSAGE_BYTES = 200_000;   // SNS allows 256 KB; email stays readable well below that

/** Remove credentials that may appear in error messages (e.g. connection strings). */
export const redact = (text) => String(text).replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, "$1***:***@");

/** SNS email subjects: printable ASCII, no line breaks, at most 100 characters. */
export function subjectOf(pipelineName, { level = "info", title }) {
  const text = `[${pipelineName}] ${level.toUpperCase()}: ${redact(title)}`
    .replace(/\s+/g, " ").replace(/°/g, " deg").replace(/[→–—]/g, "-").replace(/[^\x20-\x7E]/g, "").replace(/ {2,}/g, " ").trim();
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

export function messageOf(pipelineName, { level = "info", title, message = "", data }, now = new Date()) {
  const parts = [title, message, data ? JSON.stringify(data, null, 2) : "", `-- ${pipelineName}, ${level}, ${now.toISOString()}`];
  const body = redact(parts.filter(Boolean).join("\n\n"));
  return Buffer.byteLength(body) > MAX_MESSAGE_BYTES ? `${body.slice(0, MAX_MESSAGE_BYTES / 2)}\n\n[truncated]` : body;
}

export class SnsNotifier extends Notifier {
  /**
   * @param {{ topicArn: string, region: string, minLevel?: "info"|"warn"|"error", pipelineName: string,
   *           client?: { send: Function }, local?: Notifier }} options  client/local: injectable for tests
   */
  constructor({ topicArn, region, minLevel = "warn", pipelineName, client, local = new ConsoleNotifier() }) {
    super();
    if (!TOPIC_ARN.test(topicArn ?? "")) throw new Error("NOTIFIER=sns needs SNS_TOPIC_ARN (arn:aws:sns:<region>:<account>:<topic>)");
    if (!(minLevel in RANK)) throw new Error(`SNS_MIN_LEVEL must be one of ${Object.keys(RANK).join(", ")}`);
    this.topicArn = topicArn;
    this.minLevel = minLevel;
    this.pipelineName = pipelineName;
    this.local = local;
    this.client = client ?? new SNSClient({ region, maxAttempts: 3 });
  }

  async notify(event) {
    await this.local.notify(event);
    if ((RANK[event.level] ?? 0) < RANK[this.minLevel]) return;
    try {
      await this.client.send(new PublishCommand({
        TopicArn: this.topicArn,
        Subject: subjectOf(this.pipelineName, event),
        Message: messageOf(this.pipelineName, event),
      }));
    } catch (err) {
      console.error(`[notify:sns] publish failed (${err.name ?? "Error"}): ${redact(err.message)}`);
    }
  }
}
