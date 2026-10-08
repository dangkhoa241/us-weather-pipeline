// DynamoDB CounterStore (COUNTER_STORE=dynamodb): one small table `weather-pipeline-signups`, partition key `pk`,
// provisioned capacity (always free: 25 RCU + 25 WCU), TTL on `expires_at` (infra/template.yaml).
// Conditional writes make every limit atomic across concurrent Lambda instances.

import {
  DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand, ScanCommand, UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { CounterStore, expiresAt, isLive } from "./CounterStore.js";

const TABLE = /^weather-pipeline-[A-Za-z0-9_.-]{1,200}$/;
const MAX_SCAN_PAGES = 5;   // the table holds ≤ ~100 subscriptions + short-lived counters

// Only the types this store writes: strings, numbers, string lists.
function toAttr(value) {
  if (typeof value === "number") return { N: String(value) };
  if (Array.isArray(value)) return { L: value.map((v) => ({ S: String(v) })) };
  return { S: String(value) };
}
function fromAttr(attr) {
  if ("N" in attr) return Number(attr.N);
  if ("L" in attr) return attr.L.map((v) => v.S);
  return attr.S;
}
const marshal = (fields) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toAttr(v)]));
const unmarshal = (item) => Object.fromEntries(Object.entries(item ?? {}).map(([k, v]) => [k, fromAttr(v)]));
const nowSec = (now) => Math.floor(now.getTime() / 1000);
const conditionFailed = (err) => err?.name === "ConditionalCheckFailedException";

export class DynamoCounterStore extends CounterStore {
  /**
   * @param {{ table: string, region: string, client?: { send: Function }, now?: () => Date }} options
   *   client/now: injectable for tests
   */
  constructor({ table, region, client, now = () => new Date() }) {
    super();
    if (!TABLE.test(table ?? "")) throw new Error("COUNTER_STORE=dynamodb needs SIGNUP_TABLE (weather-pipeline-…)");
    this.table = table;
    this.now = now;
    this.client = client ?? new DynamoDBClient({ region, maxAttempts: 3 });
  }

  async increment(key, by, { limit, ttlSec } = {}) {
    if (limit != null && by > limit) return null;
    const values = { ":by": { N: String(by) } };
    const sets = [];
    if (ttlSec) { sets.push("expires_at = if_not_exists(expires_at, :exp)"); values[":exp"] = { N: String(expiresAt(this.now(), ttlSec)) }; }
    let condition;
    if (limit != null) { condition = "attribute_not_exists(n) OR n <= :max"; values[":max"] = { N: String(limit - by) }; }
    try {
      const out = await this.client.send(new UpdateItemCommand({
        TableName: this.table,
        Key: { pk: { S: key } },
        UpdateExpression: `ADD n :by${sets.length ? ` SET ${sets.join(", ")}` : ""}`,
        ConditionExpression: condition,
        ExpressionAttributeValues: values,
        ReturnValues: "UPDATED_NEW",
      }));
      return Number(out.Attributes?.n?.N);
    } catch (err) {
      if (conditionFailed(err)) return null;
      throw err;
    }
  }

  async putIfAbsent(key, { ttlSec, fields = {} } = {}) {
    try {
      await this.client.send(new PutItemCommand({
        TableName: this.table,
        Item: { pk: { S: key }, ...marshal({ ...fields, expires_at: expiresAt(this.now(), ttlSec) }) },
        // TTL deletion lags: an expired item still in the table counts as absent.
        ConditionExpression: "attribute_not_exists(pk) OR expires_at < :now",
        ExpressionAttributeValues: { ":now": { N: String(nowSec(this.now())) } },
      }));
      return true;
    } catch (err) {
      if (conditionFailed(err)) return false;
      throw err;
    }
  }

  async put(key, fields = {}, { ttlSec } = {}) {
    await this.client.send(new PutItemCommand({
      TableName: this.table,
      Item: { pk: { S: key }, ...marshal({ ...fields, expires_at: expiresAt(this.now(), ttlSec) }) },
    }));
  }

  async exists(key) {
    const out = await this.client.send(new GetItemCommand({ TableName: this.table, Key: { pk: { S: key } }, ConsistentRead: true }));
    return isLive(out.Item ? unmarshal(out.Item) : null, this.now());
  }

  async list(prefix) {
    const items = [];
    let start;
    for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
      const out = await this.client.send(new ScanCommand({
        TableName: this.table,
        FilterExpression: "begins_with(pk, :p)",
        ExpressionAttributeValues: { ":p": { S: prefix } },
        ExclusiveStartKey: start,
      }));
      for (const raw of out.Items ?? []) {
        const { pk, ...fields } = unmarshal(raw);
        if (isLive(fields, this.now())) items.push({ key: pk, ...fields });
      }
      start = out.LastEvaluatedKey;
      if (!start) break;
    }
    return items;
  }

  async delete(key) {
    await this.client.send(new DeleteItemCommand({ TableName: this.table, Key: { pk: { S: key } } }));
  }
}
