import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkStore } from "../src/cdk-store.mjs";
import { createCdkVault } from "../src/cdk-vault.mjs";

process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-cancellation-admin-cdk";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-cancellation-"));
const vault = await createCdkVault(root);
let store = await createCdkStore(root, vault);
const now = Date.now();
try {
  const [owner] = store.generate({ count: 1, quota: 30, note: "Synthetic cancellation" }, store.adminId);
  store.inventory(owner.id, ["demand@example.invalid"]);
  const operations = Array.from({ length: 8 }, () => ({ operationId: crypto.randomUUID(), jobId: crypto.randomUUID(), runId: crypto.randomUUID(),
    email: "demand@example.invalid", fee: 1, maxConcurrent: 5, maxAttempts: 10 }));
  for (const operation of operations.slice(0, 7)) store.prepareSmsOperation(owner.id, operation);
  store.updateSmsOperation(owner.id, operations[0].operationId, (value) => ({ ...value, state: "unknown" }));
  store.prepareSmsOperation(owner.id, operations[7]);
  assert.equal(store.pendingSmsOperations().length, 8, "unsettled or unknown orders do not consume provider request slots");
  assert.equal(store.get(owner.id).reserved, 8, "every task still reserves its own quota");
  store.prepareSmsOperation(owner.id, operations[7]);
  assert.equal(store.get(owner.id).reserved, 8, "retrying an operation does not reserve twice");

  const allocation = { allocationId: crypto.randomUUID(), entryId: "fixture-entry", credentialId: "fixture-credential", providerId: "smsbower",
    config: { apiKey: "synthetic-cancellation-provider-key", country: "31", countryLabel: "Fixture", service: "dr", maxPrice: "1", quotedPrice: "0.2", currency: "USD" },
    order: { requestId: "fixture-cancel-order", number: "+12025550123", expiresAt: now + 1500000, cancelAllowedAt: new Date(now + 120000).toISOString(),
      cancelBeforeAt: now + 1500000, cost: { amount: "0.1", currency: "USD", source: "order" } }, createdAt: now, abandoned: true };
  const inUse = { ...allocation, allocationId: crypto.randomUUID(), order: { ...allocation.order, requestId: "other-task-active-order", number: "+12025550129" }, abandoned: false };
  store.updateSmsOperation(owner.id, operations[1].operationId, (value) => { value.state = "requesting"; value.attempts.push({ id: inUse.allocationId, state: "requesting" }); return value; });
  store.allocateSmsOrder(owner.id, operations[1].operationId, inUse, now);
  const duplicateLate = { ...inUse, allocationId: crypto.randomUUID(), config: { ...inUse.config, country: "different-route" } };
  store.settleSmsOperation(owner.id, operations[2].operationId);
  assert.equal(store.allocateSmsOrder(owner.id, operations[2].operationId, duplicateLate, now + 1000).conflict, "operation_stopped");
  assert.equal(store.queueSmsOrderCancellation(duplicateLate, { reason: "operation_stopped", now: now + 1000 }), null,
    "a stopped task receiving a duplicate order cannot cancel another live task's number");
  assert.equal(store.smsCostOrders().find((row) => row.orderId === inUse.order.requestId).country, "31", "a duplicate late response cannot rewrite the original purchase route");
  store.settleSmsOperation(owner.id, operations[1].operationId, { success: true, evidence: { verifiedAt: new Date(now).toISOString() } });
  assert.equal(store.queueSmsOrderCancellation(inUse, { now: now + 1000 }), null, "completed direct orders are protected even without an inventory row");
  const pending = store.queueSmsOrderCancellation(allocation, { reason: "phone_rejected", now: now + 1000 });
  assert.equal(pending.state, "cancel_pending");
  assert.equal(pending.nextActionAt, now + 120000, "a quick rotation waits until the provider permits cancellation");
  assert.equal(pending.cancelBeforeAt, now + 1500000, "numeric provider timestamps remain valid");
  assert.equal(pending.retirementReason, "phone_rejected");
  const repeated = store.queueSmsOrderCancellation({ ...allocation, credentialId: "same-key-alias" }, { reason: "task_stopped", now: now + 2000 });
  assert.equal(repeated.id, pending.id, "the same provider account/order has one durable cancellation even under an alias");
  assert.equal(store.inventoryItems().length, 1);
  assert.equal(store.smsCostOrders().filter((row) => row.orderId === allocation.order.requestId).length, 1, "the cleanup record does not double-count the purchase");
  assert.equal(store.smsCostOrders().find((row) => row.orderId === allocation.order.requestId).cost.amount, "0.1");
  assert.equal(repeated.retirementReason, "phone_rejected", "the original cancellation reason survives retries");
  store.close();
  store = await createCdkStore(root, vault);
  assert.equal(store.inventoryItem(pending.id).nextActionAt, now + 120000, "restart preserves deferred cancellation");
  store.updateInventory(pending.id, (value) => ({ ...value, state: "closed", cancelState: "confirmed", nextActionAt: 0 }));
  assert.equal(store.queueSmsOrderCancellation(allocation, { now: now + 180000 }).state, "closed", "a confirmed cancellation never reopens");

  const used = { ...allocation, order: { ...allocation.order, requestId: "fixture-used-order", number: "+12025550124" } };
  const usedRow = store.queueSmsOrderCancellation(used, { now });
  store.updateInventory(usedRow.id, (value) => ({ ...value, state: "consumed", nextActionAt: 0 }));
  assert.equal(store.queueSmsOrderCancellation(used, { now: now + 1000 }).state, "consumed", "a consumed order cannot be queued again");
  console.log("SMS cancellation persistence passed (deferred provider window, duplicate aliases, restart, original reason, quota isolation and no unsettled-order cap; local fixtures only)");
} finally {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
}
