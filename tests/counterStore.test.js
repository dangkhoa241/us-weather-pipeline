import { describe, it, expect, vi } from "vitest";
import { GetItemCommand, PutItemCommand, ScanCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { MemoryCounterStore } from "../src/adapters/counterStore/memoryCounterStore.js";
import { DynamoCounterStore } from "../src/adapters/counterStore/dynamoCounterStore.js";

const T0 = new Date("2026-10-08T12:00:00Z");
const T0_SEC = T0.getTime() / 1000;

describe("MemoryCounterStore (fixed clock)", () => {
  it("increments up to the limit and refuses past it without changing the value", async () => {
    const store = new MemoryCounterStore({ now: () => T0 });
    for (let i = 1; i <= 5; i += 1) expect(await store.increment("ip#a#2026100812", 1, { limit: 5, ttlSec: 7200 })).toBe(i);
    expect(await store.increment("ip#a#2026100812", 1, { limit: 5, ttlSec: 7200 })).toBeNull();
    expect(await store.increment("emails#2026-10", 3, { limit: 2 })).toBeNull();
    expect(await store.increment("emails#2026-10", 2, { limit: 2 })).toBe(2);
  });

  it("treats expired items as absent", async () => {
    let now = T0;
    const store = new MemoryCounterStore({ now: () => now });
    expect(await store.putIfAbsent("email#h", { ttlSec: 86_400 })).toBe(true);
    expect(await store.putIfAbsent("email#h", { ttlSec: 86_400 })).toBe(false);
    now = new Date(T0.getTime() + 86_401_000);
    expect(await store.exists("email#h")).toBe(false);
    expect(await store.putIfAbsent("email#h", { ttlSec: 86_400 })).toBe(true);
  });

  it("lists live items by prefix with their fields", async () => {
    const store = new MemoryCounterStore({ now: () => T0 });
    await store.put("sub#arn:1", { city: "stockton-ca", categories: ["heat"] });
    await store.put("cool#x#heat", {}, { ttlSec: 60 });
    expect(await store.list("sub#")).toEqual([{ key: "sub#arn:1", city: "stockton-ca", categories: ["heat"], expires_at: undefined }]);
  });
});

describe("DynamoCounterStore (mocked client)", () => {
  const make = (send) => new DynamoCounterStore({ table: "weather-pipeline-signups", region: "us-east-2", client: { send }, now: () => T0 });

  it("refuses a table outside weather-pipeline-*", () => {
    expect(() => new DynamoCounterStore({ table: "other", region: "us-east-2", client: {} })).toThrow(/SIGNUP_TABLE/);
  });

  it("increments atomically with a limit condition and TTL set once", async () => {
    const send = vi.fn(async () => ({ Attributes: { n: { N: "3" } } }));
    expect(await make(send).increment("day#20261008", 1, { limit: 20, ttlSec: 172_800 })).toBe(3);
    const [cmd] = send.mock.calls[0];
    expect(cmd).toBeInstanceOf(UpdateItemCommand);
    expect(cmd.input).toMatchObject({
      TableName: "weather-pipeline-signups",
      Key: { pk: { S: "day#20261008" } },
      UpdateExpression: "ADD n :by SET expires_at = if_not_exists(expires_at, :exp)",
      ConditionExpression: "attribute_not_exists(n) OR n <= :max",
      ExpressionAttributeValues: { ":by": { N: "1" }, ":max": { N: "19" }, ":exp": { N: String(T0_SEC + 172_800) } },
    });
  });

  it("returns null when the condition fails, and rethrows other errors", async () => {
    const failed = Object.assign(new Error("x"), { name: "ConditionalCheckFailedException" });
    expect(await make(vi.fn(async () => { throw failed; })).increment("emails#2026-10", 5, { limit: 900 })).toBeNull();
    const throttled = Object.assign(new Error("x"), { name: "ProvisionedThroughputExceededException" });
    await expect(make(vi.fn(async () => { throw throttled; })).increment("k", 1, { limit: 5 })).rejects.toThrow();
    const send = vi.fn();
    expect(await make(send).increment("k", 6, { limit: 5 })).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("putIfAbsent treats an expired-but-undeleted item as absent", async () => {
    const send = vi.fn(async () => ({}));
    expect(await make(send).putIfAbsent("email#h", { ttlSec: 86_400 })).toBe(true);
    const [cmd] = send.mock.calls[0];
    expect(cmd).toBeInstanceOf(PutItemCommand);
    expect(cmd.input.ConditionExpression).toBe("attribute_not_exists(pk) OR expires_at < :now");
    expect(cmd.input.ExpressionAttributeValues).toEqual({ ":now": { N: String(T0_SEC) } });
    expect(cmd.input.Item).toEqual({ pk: { S: "email#h" }, expires_at: { N: String(T0_SEC + 86_400) } });
  });

  it("exists/list ignore expired items; list unmarshals fields", async () => {
    const send = vi.fn(async (cmd) => (cmd instanceof GetItemCommand
      ? { Item: { pk: { S: "cool#a#heat" }, expires_at: { N: String(T0_SEC - 1) } } }
      : { Items: [
        { pk: { S: "sub#arn:1" }, city: { S: "stockton-ca" }, categories: { L: [{ S: "heat" }, { S: "flood" }] } },
        { pk: { S: "sub#arn:2" }, expires_at: { N: String(T0_SEC - 5) } },
      ] }));
    const store = make(send);
    expect(await store.exists("cool#a#heat")).toBe(false);
    expect(await store.list("sub#")).toEqual([{ key: "sub#arn:1", city: "stockton-ca", categories: ["heat", "flood"] }]);
    expect(send.mock.calls[1][0]).toBeInstanceOf(ScanCommand);
  });
});
