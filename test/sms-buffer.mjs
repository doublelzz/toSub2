import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkStore } from "../src/cdk-store.mjs";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createSmsPool } from "../src/sms-pool.mjs";

process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-legacy-inventory-administrator";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-legacy-inventory-"));
const vault = await createCdkVault(root); const store = await createCdkStore(root, vault);
let clock = Date.now(); let purchases = 0; const cancellations = []; let cancellationDenied = false;
const pool = createSmsPool({ store, now: () => clock, createProvider: () => ({
  getNumber: async () => { purchases++; throw new Error("maintenance must never buy"); },
  inspect: async () => ({ state: "waiting", hasSms: false }),
  cancelStrict: async (id) => { cancellations.push(id); if (cancellationDenied) throw Object.assign(new Error("fixture too early"), { code: "EARLY_CANCEL_DENIED" }); return { cancelled: true, receipt: "ACCESS_CANCEL" }; },
}) });
try {
  const admin = store.adminId;
  pool.saveRules({ enabled: false }, admin);
  const legacy = (state, ordinal, fields = {}) => {
    const id = crypto.randomUUID(); const config = { apiKey: "legacy-fixture-key", service: "dr", country: "1", maxPrice: "0.25" };
    store.createInventoryPurchase({ id, entryId: "former-entry", credentialId: "former-credential", providerId: "herosms", config, createdAt: clock }, { simplified: true, target: 20 });
    return store.finishInventoryPurchase(id, { state, order: { requestId: `legacy-${ordinal}`, number: `+1202555${String(ordinal).padStart(4, "0")}` },
      expiresAt: clock + 1500000, cancelAllowedAt: clock + 120000, cancelBeforeAt: clock + 1500000, nextActionAt: 0, ...fields });
  };
  const ready = legacy("ready", 1); const assigned = legacy("assigned", 2); const closed = legacy("closed", 3);
  const checking = legacy("checking", 4);
  await pool.tick();
  assert.equal(purchases, 0); assert.equal(cancellations.length, 0, "cleanup waits for provider cancellation age");
  assert.equal(store.inventoryItem(ready.id).state, "cancel_pending");
  assert.equal(store.inventoryItem(ready.id).retirementReason, "legacy_inventory_retired");
  assert.equal(store.inventoryItem(assigned.id).state, "assigned", "already assigned legacy orders continue their original task");
  assert.equal(store.inventoryItem(closed.id).state, "closed", "closed history is never reopened");
  assert.equal(store.inventoryItem(checking.id).state, "cancel_pending", "interrupted inventory checks are retained for cleanup");
  clock += 120001; cancellationDenied = true; await pool.tick();
  assert.equal(cancellations.length, 2); assert.equal(store.inventoryItem(ready.id).cancelState, "unknown");
  assert.ok(store.inventoryItem(ready.id).nextActionAt >= clock + 30000);
  const firstAttempts = cancellations.length; await pool.tick(); assert.equal(cancellations.length, firstAttempts);
  cancellationDenied = false; clock += 30001; await pool.tick();
  assert.equal(store.inventoryItem(ready.id).state, "closed"); assert.equal(store.inventoryItem(ready.id).refundStatus, "unconfirmed");
  assert.equal(store.inventoryItem(ready.id).retirementReason, "legacy_inventory_retired", "successful cancellation keeps its origin reason");
  assert.equal(store.inventoryItem(assigned.id).state, "assigned");
  const history = pool.inventoryPage({ scope: "history", pageSize: 100 }); assert.ok(history.items.some((value) => value.id === ready.id));
  assert.equal(JSON.stringify(pool.adminSnapshot()).includes("legacy-fixture-key"), false);
  await assert.rejects(pool.warmup(admin), (error) => error.code === "SMS_POOL_PREFETCH_REMOVED");
  assert.equal(purchases, 0);
  console.log("[ok] Former SMS inventory: no purchases, deferred cancellation/retry, assigned-order continuity, preserved history and cancellation reasons");
} finally { await pool.close(); store.close(); await fs.rm(root, { recursive: true, force: true }); }
