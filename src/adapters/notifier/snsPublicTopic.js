// The PUBLIC SNS topic for subscriber alert emails (docs/analysis/email-signups.md). Kept apart from the private
// ops topic on purpose:
// - SnsAlertPublisher (collector) publishes one alert per message, with `city` + `category` message attributes that
//   the subscribers' filter policies match. It takes structured alerts only (no free-text notify()), and refuses
//   the private topic, so pipeline failures can never be sent to subscribers.
// - SnsSubscriptionManager (sign-up Lambda) counts subscriptions and creates email subscriptions with a filter
//   policy. It cannot publish (IAM) and never changes an existing subscription.

import { ListSubscriptionsByTopicCommand, PublishCommand, SNSClient, SubscribeCommand } from "@aws-sdk/client-sns";
import { PUBLIC_CATEGORIES, TEST_CATEGORY } from "../../stage1/alertCategories.js";

const TOPIC_ARN = /^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/;
const CITY_ID = /^[a-z0-9-]{3,40}$/;
const SUBJECT = /^[\x20-\x7E]{1,100}$/;        // SNS email subjects: printable ASCII, ≤ 100 characters
const MAX_MESSAGE_BYTES = 8_000;               // one alert; SNS allows 256 KB
const MAX_LIST_PAGES = 5;                       // 100 subscriptions per page; the cap is far below 500
const ALLOWED = new Set([...PUBLIC_CATEGORIES, TEST_CATEGORY]);

/** SNS subscription filter policy for one city and its categories (both attributes must match). */
export function filterPolicyFor(city, categories) {
  if (!CITY_ID.test(city ?? "")) throw new Error("invalid city id");
  const cats = [...new Set(categories ?? [])];
  if (!cats.length || cats.some((c) => !ALLOWED.has(c))) throw new Error("invalid categories");
  return { city: [city], category: cats };
}

function checkTopics(topicArn, privateTopicArn) {
  if (!TOPIC_ARN.test(topicArn ?? "")) throw new Error("PUBLIC_ALERTS=sns needs PUBLIC_SNS_TOPIC_ARN (arn:aws:sns:<region>:<account>:<topic>)");
  if (privateTopicArn && topicArn === privateTopicArn) throw new Error("PUBLIC_SNS_TOPIC_ARN must not be the private SNS_TOPIC_ARN");
}

async function listSubscriptions(client, topicArn) {
  const subs = [];
  let token;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const out = await client.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken: token }));
    subs.push(...(out.Subscriptions ?? []));
    token = out.NextToken;
    if (!token) break;
  }
  return subs;
}

export class SnsAlertPublisher {
  /** @param {{ topicArn: string, privateTopicArn?: string, region: string, client?: { send: Function } }} options */
  constructor({ topicArn, privateTopicArn, region, client }) {
    checkTopics(topicArn, privateTopicArn);
    this.topicArn = topicArn;
    this.client = client ?? new SNSClient({ region, maxAttempts: 3 });
  }

  /** One alert email to the subscribers whose filter policy matches `city` and `category`. */
  async publish({ city, category, subject, message }) {
    if (!CITY_ID.test(city ?? "")) throw new Error("invalid city id");
    if (!ALLOWED.has(category)) throw new Error("invalid category");
    if (!SUBJECT.test(subject ?? "")) throw new Error("subject must be 1-100 printable ASCII characters");
    if (!message || Buffer.byteLength(message) > MAX_MESSAGE_BYTES) throw new Error("message empty or too long");
    await this.client.send(new PublishCommand({
      TopicArn: this.topicArn,
      Subject: subject,
      Message: message,
      MessageAttributes: {
        city: { DataType: "String", StringValue: city },
        category: { DataType: "String", StringValue: category },
      },
    }));
  }

  /** ARNs of confirmed subscriptions (pending ones are listed as "PendingConfirmation", without an ARN). */
  async confirmedSubscriptionArns() {
    return new Set((await listSubscriptions(this.client, this.topicArn)).map((s) => s.SubscriptionArn).filter((a) => a?.startsWith("arn:")));
  }
}

export class SnsSubscriptionManager {
  /** @param {{ topicArn: string, privateTopicArn?: string, region: string, client?: { send: Function } }} options */
  constructor({ topicArn, privateTopicArn, region, client }) {
    checkTopics(topicArn, privateTopicArn);
    this.topicArn = topicArn;
    this.client = client ?? new SNSClient({ region, maxAttempts: 2 });
  }

  /** All subscriptions, confirmed and pending (the filter-policy cap counts both). */
  async count() {
    return (await listSubscriptions(this.client, this.topicArn)).length;
  }

  /**
   * Email subscription with a filter policy; SNS emails the confirmation link (double opt-in).
   * @returns {Promise<string>} the subscription ARN (also for a pending subscription)
   */
  async subscribe(email, filterPolicy) {
    const out = await this.client.send(new SubscribeCommand({
      TopicArn: this.topicArn,
      Protocol: "email",
      Endpoint: email,
      ReturnSubscriptionArn: true,
      Attributes: { FilterPolicy: JSON.stringify(filterPolicy), FilterPolicyScope: "MessageAttributes" },
    }));
    return out.SubscriptionArn;
  }
}
