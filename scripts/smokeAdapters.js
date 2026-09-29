// scripts/smokeAdapters.js
// Quick check that each local adapter works against the real services (docker compose up -d first).

import { createRawStore } from "../src/adapters/rawStore/index.js";
import { createCacheStore } from "../src/adapters/cacheStore/index.js";
import { createNotifier } from "../src/adapters/notifier/index.js";
import { createScheduler } from "../src/adapters/scheduler/index.js";

const COLLECTION = "_smoke_test";
const KEY = "smoke:test";

async function testRawStore() {
  const store = createRawStore();
  try {
    await store.connect();
    await store.ensureCollection(COLLECTION, { uniqueKey: ["id"] });
    const docs = [{ id: 1, v: "a" }, { id: 2, v: "b" }];
    const first = await store.upsertMany(COLLECTION, docs, ["id"]);
    const second = await store.upsertMany(COLLECTION, docs, ["id"]);
    const third = await store.upsertMany(COLLECTION, [{ id: 1, v: "changed" }], ["id"]);
    const count = await store.count(COLLECTION);
    const one = await store.findOne(COLLECTION, { id: 1 });
    let duplicateRejected = false;
    try { await store.insertOne(COLLECTION, { id: 1 }); } catch { duplicateRejected = true; }
    console.log("RawStore  ", { first, second, third, count, id1: one.v, duplicateRejected });
    if (count !== 2 || one.v !== "changed" || !duplicateRejected) throw new Error("RawStore check failed");
  } finally {
    await store.db?.collection(COLLECTION).drop().catch(() => {});
    await store.close();
  }
}

async function testCacheStore() {
  const cache = createCacheStore();
  try {
    await cache.connect();
    const ping = await cache.ping();
    await cache.set(KEY, { temp_f: 71.5, missing: null }, { ttlSec: 30 });
    const value = await cache.get(KEY);
    await cache.del(KEY);
    const afterDel = await cache.get(KEY);
    console.log("CacheStore", { ping, value, afterDel });
    if (!ping || value.missing !== null || afterDel !== null) throw new Error("CacheStore check failed");
  } finally {
    await cache.close();
  }
}

async function testScheduler(notifier) {
  const scheduler = createScheduler({ notifier });
  let runs = 0;
  scheduler.schedule("smoke", "* * * * * *", async () => { runs += 1; });   // every second
  scheduler.schedule("smoke-fail", "* * * * * *", async () => { throw new Error("expected test failure"); });
  await scheduler.start();
  await new Promise((r) => setTimeout(r, 2500));
  await scheduler.stop();
  console.log("Scheduler ", { runs });
  if (runs < 1) throw new Error("Scheduler check failed");
}

const notifier = createNotifier();
try {
  await testRawStore();
  await testCacheStore();
  await testScheduler(notifier);
  await notifier.notify({ level: "info", title: "Adapter smoke test passed" });
} catch (err) {
  await notifier.notify({ level: "error", title: "Adapter smoke test failed", message: err.message });
  process.exitCode = 1;
}
