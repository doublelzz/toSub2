import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCdkStore } from "../src/cdk-store.mjs";
import { createCdkVault } from "../src/cdk-vault.mjs";

process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-category-store-admin";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-category-store-"));
const vault = await createCdkVault(root); let store = await createCdkStore(root, vault);
try {
  const [owner] = store.generate({ count: 1, quota: 100, note: "Category fixture" }, store.adminId);
  store.inventory(owner.id, ["category@example.invalid"]);
  const operation = (categoryId, categoryName, fee) => ({ operationId: crypto.randomUUID(), jobId: crypto.randomUUID(), runId: crypto.randomUUID(),
    email: "category@example.invalid", categoryId, categoryName, categoryFeeVersion: 1, categoryFee: fee, fee, maxAttempts: 10 });
  const us = operation("us", "美区", 7); const other = operation("other", "其他", 3);
  store.prepareSmsOperation(owner.id, us); store.prepareSmsOperation(owner.id, other);
  assert.equal(store.get(owner.id).reserved, 10);
  assert.equal(store.prepareSmsOperation(owner.id, { ...us, fee: 99, categoryName: "改名", categoryFeeVersion: 2 }).fee, 7);
  assert.throws(() => store.prepareSmsOperation(owner.id, { ...us, categoryId: "other" }), (error) => error.code === "SMS_POOL_CATEGORY_CHANGED");
  assert.throws(() => store.updateSmsOperation(owner.id, us.operationId, (value) => ({ ...value, categoryId: "other" })), (error) => error.code === "SMS_POOL_CATEGORY_CHANGED");
  store.updateSmsOperation(owner.id, us.operationId, (value) => ({ ...value, categoryName: "改名", categoryFeeVersion: 99, categoryFee: 99 }));
  assert.equal(store.smsOperation(owner.id, us.operationId).categoryName, "美区");
  assert.equal(store.smsOperation(owner.id, us.operationId).categoryFeeVersion, 1);
  assert.equal(store.smsOperation(owner.id, us.operationId).categoryFee, 7);
  const acquire = (input, suffix) => {
    const id = crypto.randomUUID();
    store.updateSmsOperation(owner.id, input.operationId, (value) => { value.state = "requesting"; value.attempts.push({ id, state: "requesting" }); return value; });
    const allocation = { allocationId: id, entryId: "fixture-entry", credentialId: "fixture-key", providerId: "herosms", categoryId: "untrusted", categoryName: "wrong",
      config: { apiKey: "synthetic-category-api-key", country: "1", service: "dr", maxPrice: "1", quotedPrice: "0.2", currency: "USD" },
      order: { requestId: `category-order-${suffix}`, number: `+1202555012${suffix}`, cost: { amount: "0.1", currency: "USD", source: "order" } }, abandoned: false };
    return store.allocateSmsOrder(owner.id, input.operationId, allocation).allocation;
  };
  const boughtUs = acquire(us, 1); const boughtOther = acquire(other, 2);
  assert.equal(boughtUs.categoryId, "us"); assert.equal(boughtUs.config.categoryName, "美区", "operation snapshot is authoritative for purchased orders");
  store.settleSmsOperation(owner.id, us.operationId, { success: true, evidence: { verifiedAt: new Date().toISOString() } });
  store.settleSmsOperation(owner.id, other.operationId, { success: true, evidence: { verifiedAt: new Date().toISOString() } });
  assert.equal(store.get(owner.id).balance, 90); assert.equal(store.get(owner.id).reserved, 0);
  store.recordSmsCostOrder({ ...boughtUs, categoryId: "other", categoryName: "改名", config: { ...boughtUs.config, categoryId: "other" } });
  const costs = store.smsCostOrders();
  assert.equal(costs.find((row) => row.orderId === boughtUs.order.requestId).categoryId, "us", "duplicate writes never move history into another category");
  assert.equal(costs.find((row) => row.orderId === boughtUs.order.requestId).categoryName, "美区");
  assert.equal(costs.length, 2);
  assert.equal(store.smsOperationPage({ categoryId: "us" }).total, 1);
  assert.equal(store.smsOperationPage({ categoryId: "other" }).total, 1);
  const waiting = operation("us", "美区", 9); store.prepareSmsOperation(owner.id, waiting);
  assert.equal(store.smsOperationPage({ categoryId: "us", state: "reserved" }).total, 1, "category filtering includes tasks with no number yet");
  assert.equal(store.smsOperationPage({ categoryId: "other", state: "reserved" }).total, 0);
  store.settleSmsOperation(owner.id, waiting.operationId);
  store.close();
  const db = new DatabaseSync(path.join(root, ".cdk", "cdk.sqlite"));
  const row = db.prepare("SELECT identity,payload FROM sms_pool_cost_orders LIMIT 1").get();
  const value = vault.open(row.payload, `sms-cost:${row.identity}`);
  for (const field of ["categoryId", "categoryName", "categoryFeeVersion"]) delete value[field];
  db.prepare("UPDATE sms_pool_cost_orders SET payload=? WHERE identity=?").run(vault.seal(value, `sms-cost:${row.identity}`), row.identity); db.close();
  store = await createCdkStore(root, vault);
  const legacy = store.smsCostOrders().find((item) => item.orderId === value.orderId);
  assert.equal(legacy.categoryId, "legacy"); assert.equal(legacy.categoryName, "原接码池");
  assert.equal(store.get(owner.id).balance, 90, "legacy category normalization never changes charged quota");
  console.log("SMS category store passed (frozen fees/names, operation isolation, immutable order category, pre-pagination filters, waiting operations and legacy history)");
} finally { store.close(); await fs.rm(root, { recursive: true, force: true }); }
