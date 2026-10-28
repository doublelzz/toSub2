import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkStore } from "../src/cdk-store.mjs";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createSmsPool } from "../src/sms-pool.mjs";

process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-demand-administrator-fixture";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-demand-"));
const vault = await createCdkVault(root); const store = await createCdkStore(root, vault);
let calls = 0; let active = 0; let maximum = 0; let mode = "normal"; let retryCalls = 0;
const pool = createSmsPool({ store, retryDelayMs: 2, createProvider: () => ({
  async getNumber() {
    const ordinal = ++calls; active++; maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (mode === "unknown") throw new Error("fixture lost purchase response");
      if (mode === "unavailable") throw Object.assign(new Error("fixture always unavailable"), { code: "NO_NUMBERS" });
      if (mode === "retry" && ++retryCalls < 3) throw Object.assign(new Error("fixture no stock"), { code: "NO_NUMBERS" });
      return { requestId: `demand-${ordinal}`, number: `+1202555${String(ordinal).padStart(4, "0")}` };
    } finally { active--; }
  }, inspect: async () => ({ state: "waiting", hasSms: false }), cancelStrict: async () => ({ cancelled: true, receipt: "ACCESS_CANCEL" }),
}) });
try {
  const admin = store.adminId; const [owner] = store.generate({ count: 1, quota: 100, note: "demand fixture" }, admin);
  store.inventory(owner.id, ["demand@example.invalid"]); const user = pool.forOwner(owner.id);
  pool.saveRules({ enabled: true, requestConcurrency: 3, maxAttempts: 4 }, admin);
  for (let index = 0; index < 8; index++) {
    pool.saveCredential({ name: `credential ${index}`, providerId: "herosms", apiKey: `synthetic-demand-key-${index}` }, admin);
    const credentialId = pool.adminSnapshot().credentials.at(-1).id;
    pool.saveEntry({ credentialId, country: String(index + 1), maxPrice: "0.25", priority: 1 }, admin);
  }
  // Obsolete persisted switches must never wake a purchase worker.
  store.mutateSmsPoolConfig((value) => { value.rules.buffer = { enabled: true, forceRefill: true, target: 20 }; value.rules.maxConcurrent = 1; return value; });
  await pool.tick(); await pool.tick(); assert.equal(calls, 0);
  await assert.rejects(pool.warmup(admin), (error) => error.code === "SMS_POOL_PREFETCH_REMOVED");
  assert.equal(calls, 0); assert.equal(pool.adminSnapshot().rules.buffer, undefined); assert.equal(pool.adminSnapshot().rules.maxConcurrent, undefined);
  assert.equal(pool.publicSummary().status, "available_on_demand"); assert.equal(pool.publicSummary().hasNumbers, undefined);
  const begin = () => { const input = { operationId: crypto.randomUUID(), jobId: crypto.randomUUID(), runId: crypto.randomUUID(), email: "demand@example.invalid" }; user.begin(input); return input; };
  const inputs = Array.from({ length: 8 }, begin);
  const allocations = await Promise.all(inputs.map((input) => user.getNumber(input)));
  assert.equal(calls, 8); assert.equal(maximum, 3, "only actual provider requests occupy the configured three slots");
  assert.equal(store.pendingSmsOperations().filter((row) => row.state === "allocated").length, 8, "eight SMS waits do not hit the old unsettled-five gate");
  assert.equal(new Set(allocations.map((value) => value.order.requestId)).size, 8);
  assert.ok(allocations.every((value) => !value.inventoryId), "new tasks never claim former prefetched inventory");
  await pool.tick(); assert.equal(calls, 8, "pending SMS never triggers replenishment");
  mode = "unknown"; const uncertain = begin();
  await assert.rejects(user.getNumber(uncertain), (error) => error.code === "SMS_POOL_UNKNOWN");
  const beforeRetry = calls;
  await assert.rejects(user.getNumber(uncertain), (error) => error.code === "SMS_POOL_UNKNOWN"); assert.equal(calls, beforeRetry);
  mode = "normal"; const afterUnknown = begin(); await user.getNumber(afterUnknown); assert.equal(calls, beforeRetry + 1, "an unknown operation never blocks another task");
  const stopped = begin(); await assert.rejects(user.getNumber({ ...stopped, canContinue: () => false })); assert.equal(calls, beforeRetry + 1);
  for (const input of inputs) user.release(input); user.release(afterUnknown);
  for (const entry of pool.adminSnapshot().entries.slice(1)) pool.patchEntry(entry.id, { enabled: false }, admin);
  mode = "retry";
  const retry = begin(); const acquired = await user.getNumber(retry);
  assert.ok(acquired.order.requestId); assert.equal(retryCalls, 3, "an active task retries unavailable quotations within its attempt bound");
  user.release(retry);
  mode = "unavailable"; pool.saveRules({ maxAttempts: 2, noStockThreshold: 100 }, admin);
  const exhausted = begin(); const beforeExhausted = calls;
  await assert.rejects(user.getNumber(exhausted), (error) => error.code === "SMS_POOL_LIMIT");
  assert.equal(calls - beforeExhausted, 2, "a single unavailable quotation is retried only up to the operation limit");
  mode = "normal"; pool.saveRules({ requestConcurrency: 1 }, admin);
  const holding = begin(); const heldPurchase = user.getNumber(holding);
  const waiting = begin(); let continueWaiting = true; const beforeWaiting = calls;
  const stoppedWait = user.getNumber({ ...waiting, canContinue: () => continueWaiting }).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 10)); continueWaiting = false;
  await heldPurchase; const stoppedOutcome = await stoppedWait;
  assert.ok(stoppedOutcome.code); assert.equal(calls, beforeWaiting, "stopping while queued never sends another getNumber request");
  user.release(holding);
  const disabled = begin(); const beforeDisabled = calls; const disabledPurchase = user.getNumber(disabled).catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 10)); store.update(owner.id, { status: "disabled" }, admin);
  const disabledOutcome = await disabledPurchase;
  assert.equal(disabledOutcome.code, "SMS_POOL_CLOSED"); assert.equal(calls, beforeDisabled + 1);
  assert.equal(user.recover(disabled.operationId).state, "released");
  assert.ok(store.inventoryItems().some((value) => value.order?.requestId === `demand-${calls}` && value.state === "cancel_pending"), "a purchase finishing after CDK disable is persisted for cancellation");
  console.log("[ok] Demand SMS pool: zero background purchases, obsolete switches ignored, eight allocated tasks, request-only concurrency, unknown isolation, stop checks and bounded retries");
} finally { await pool.close(); store.close(); await fs.rm(root, { recursive: true, force: true }); }
