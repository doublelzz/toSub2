import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkStore } from "../src/cdk-store.mjs";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createSmsPool } from "../src/sms-pool.mjs";

process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64"); process.env.TOSUB2_ADMIN_CDK = "synthetic-buffer-admin-fixture";
const roots = []; let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
async function fixture({ getNumber, inspect, cancelStrict } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-buffer-")); roots.push(root);
  const vault = await createCdkVault(root); const store = await createCdkStore(root, vault); let time = Date.now(); let count = 0; const cancelled = [];
  const provider = (id, config) => ({ activationPolicy: { lifetimeSeconds: 1500, minCancelAgeSeconds: 120, source: "https://provider.example.invalid/policy" },
    getNumber: getNumber || (async () => { count++; return { requestId: `buffer-order-${count}`, number: `+1202555${String(count).padStart(4, "0")}`, expiresAt: time + 1500000, expiresAtSource: "provider_policy", cancelAllowedAt: time + 120000 }; }),
    inspect: inspect || (async () => ({ state: "waiting", hasSms: false })),
    cancelStrict: cancelStrict || (async (orderId) => { cancelled.push(orderId); return { cancelled: true, receipt: "ACCESS_CANCEL", refundStatus: "unconfirmed" }; }) });
  const pool = createSmsPool({ store, createProvider: provider, now: () => time }); const adminId = store.adminId;
  const [first, second] = store.generate({ count: 2, quota: 20, note: "buffer-fixture" }, adminId);
  for (const owner of [first, second]) store.inventory(owner.id, ["shared@example.invalid"]);
  pool.saveRules({ enabled: true, fee: 2, maxConcurrent: 5, buffer: { enabled: true, target: 3, lowWater: 1, perEntry: 1, refillConcurrency: 1 } }, adminId);
  pool.saveCredential({ providerId: "herosms", name: "Synthetic buffer", apiKey: "synthetic-buffer-key" }, adminId);
  const credentialId = pool.adminSnapshot().credentials[0].id;
  for (let country = 1; country <= 3; country++) pool.saveEntry({ credentialId, country: String(country), maxPrice: "0.25", priority: 1 }, adminId);
  const input = (owner = first) => ({ owner, operationId: crypto.randomUUID(), jobId: crypto.randomUUID(), runId: crypto.randomUUID(), email: "shared@example.invalid", expectedFee: 2 });
  return { root, vault, store, pool, adminId, first, second, input, cancelled, count: () => count, advance: (ms) => { time += ms; }, now: () => time, provider };
}
try {
  const base = await fixture();
  try {
    await base.pool.tick(); check(base.count() === 0, "enabling a buffer without real demand never purchases inventory");
    for (let index = 0; index < 3; index++) await base.pool.warmup(base.adminId);
    check(base.store.inventoryItems({ activeOnly: true }).filter((row) => row.state === "ready").length === 3 && base.count() === 3, "explicit administrator warmup fills global target respecting per-entry cap");
    check(base.store.get(base.first.id).balance === 20 && base.store.get(base.first.id).reserved === 0, "prefetch never consumes or reserves tenant quota");
    const summary = base.pool.publicSummary();
    check(summary.hasNumbers && summary.status === "ready" && !JSON.stringify(summary).includes("country") && summary.availableEntries === undefined, "public pool exposes availability without locations or inventory counts");
    const one = base.input(); const two = base.input(base.second); const userA = base.pool.forOwner(base.first.id); const userB = base.pool.forOwner(base.second.id);
    userA.begin(one); userB.begin(two); const [a, b] = await Promise.all([userA.getNumber(one), userB.getNumber(two)]);
    check(a.inventoryId && b.inventoryId && a.inventoryId !== b.inventoryId && base.count() === 3, "two tenants atomically claim distinct preloaded orders without new purchases");
    check(base.store.inventoryItem(a.inventoryId).claimOwner === base.first.id && base.store.smsOperation(base.first.id, one.operationId).allocation.inventoryId === a.inventoryId, "inventory owner and operation allocation are committed together");
    const proof = { version: 1, type: "phone_verification", state: "verified", operationId: one.operationId, allocationId: a.allocationId, jobId: one.jobId, runId: one.runId,
      providerId: a.providerId, orderId: a.order.requestId, eventId: crypto.randomUUID(), verifiedAt: new Date().toISOString() };
    userA.noteSubmitted({ ...one, allocationId: a.allocationId }); userA.verified({ ...one, ...a, evidence: proof });
    check(base.store.inventoryItem(a.inventoryId).state === "consumed" && base.store.get(base.first.id).smsPoolConsumed === 2, "successful buffered phone verification atomically consumes inventory and charges fee once");
    userB.abandon({ ...two, allocationId: b.allocationId }); userB.release(two);
    check(base.store.inventoryItem(b.inventoryId).state === "cancel_pending" && base.store.get(base.second.id).balance === 20, "failed buffered allocation never returns to ready and releases CDK fee");
    base.pool.pause(); base.advance(121000); await base.pool.tick();
    check(base.store.inventoryItem(b.inventoryId).state === "closed" && base.store.inventoryItem(b.inventoryId).refundStatus === "unconfirmed", "strict cancel receipt closes inventory without inventing a refund");
    await base.pool.drain(base.adminId); await base.pool.tick();
    check(!base.pool.publicSummary().hasNumbers && base.store.inventoryItems().filter((row) => row.state === "ready").length === 0, "drain removes only unassigned inventory without replenishing");
  } finally { await base.pool.close(); base.store.close(); }

  const expired = await fixture();
  try {
    await expired.pool.warmup(expired.adminId); expired.pool.pause(); expired.advance(1020001); await expired.pool.tick(); await expired.pool.tick();
    check(expired.store.inventoryItems().every((row) => row.state !== "ready"), "inventory with less than minimum remaining lifetime is retired before assignment");
    check(expired.cancelled.length === 1 && expired.count() === 1, "idle paused cleanup cancels without another purchase");
  } finally { await expired.pool.close(); expired.store.close(); }

  const earlySms = await fixture({ inspect: async () => ({ state: "received", hasSms: true }) });
  try {
    await earlySms.pool.warmup(earlySms.adminId); earlySms.pool.pause(); const input = earlySms.input(); const user = earlySms.pool.forOwner(earlySms.first.id); user.begin(input);
    const allocation = await user.getNumber(input);
    check(!allocation.inventoryId && earlySms.store.inventoryItems().some((row) => row.lastError === "sms_received_before_assignment"), "received or reused SMS inventory is quarantined and empty-buffer fallback buys a new order");
    user.release(input);
  } finally { await earlySms.pool.close(); earlySms.store.close(); }

  let unknownCalls = 0;
  const unknown = await fixture({ getNumber: async () => { unknownCalls++; throw new Error("fixture lost purchase response"); } });
  try {
    unknown.pool.saveRules({ buffer: { target: 1, lowWater: 0, perEntry: 1, maxOutstanding: 1 } }, unknown.adminId);
    await unknown.pool.warmup(unknown.adminId); await unknown.pool.tick();
    check(unknownCalls === 1 && unknown.store.inventoryItems()[0].state === "purchase_unknown", "uncertain purchase consumes outstanding cap and is never automatically repeated");
    await unknown.pool.close(); unknown.store.close(); unknown.store = await createCdkStore(unknown.root, unknown.vault);
    unknown.pool = createSmsPool({ store: unknown.store, createProvider: unknown.provider, now: unknown.now });
    await unknown.pool.tick(); check(unknownCalls === 1, "actual store restart preserves unknown purchase without rebuying");
  } finally { await unknown.pool.close(); unknown.store.close(); }

  let cancelCalls = 0;
  const denied = await fixture({ cancelStrict: async () => { cancelCalls++; throw Object.assign(new Error("fixture cancellation denied"), { code: "OTP_RECEIVED" }); } });
  try {
    await denied.pool.warmup(denied.adminId); denied.pool.pause(); denied.advance(121000); await denied.pool.drain(denied.adminId); await denied.pool.tick();
    const row = denied.store.inventoryItems()[0];
    check(cancelCalls === 1 && row.state === "quarantined" && row.refundStatus === "unconfirmed", "cancel denial stays quarantined without false refund or cancellation retries");
  } finally { await denied.pool.close(); denied.store.close(); }

  let duplicateCalls = 0;
  const duplicates = await fixture({ getNumber: async () => ({ requestId: `duplicate-${++duplicateCalls}`, number: "+12025550123" }) });
  try {
    await duplicates.pool.warmup(duplicates.adminId); await duplicates.pool.warmup(duplicates.adminId);
    check(duplicates.store.inventoryItems().filter((row) => row.state === "ready").length === 1 && duplicates.store.inventoryItems().some((row) => row.state === "quarantined" && row.lastError === "duplicate_phone"), "same normalized phone cannot produce two ready allocations across provider orders");
    const entry = duplicates.pool.adminSnapshot().entries.find((row) => row.id === duplicates.store.inventoryItems().find((row) => row.state === "ready").entryId);
    duplicates.pool.patchEntry(entry.id, { enabled: false }, duplicates.adminId);
    check(!duplicates.pool.publicSummary().hasNumbers, "disabled routing never advertises its old inventory as assignable");
  } finally { await duplicates.pool.close(); duplicates.store.close(); }

  const rate = await fixture();
  try {
    rate.pool.saveRules({ buffer: { maxPerMinute: 1 } }, rate.adminId);
    for (let index = 0; index < 4; index++) await rate.pool.warmup(rate.adminId);
    check(rate.count() === 1, "prefetch minute rate budget applies even when warmup is repeatedly requested");
    rate.advance(61000); await rate.pool.tick(); check(rate.count() === 2, "next minute permits a bounded refill");
    rate.advance(11 * 60000); await rate.pool.tick(); check(rate.count() === 2, "idle window stops all replenishment until another real demand or explicit warmup");
  } finally { await rate.pool.close(); rate.store.close(); }

  let repeatedOrderCancels = 0;
  const repeatedOrder = await fixture({ getNumber: async () => ({ requestId: "one-activation-only", number: "+12025550123" }), cancelStrict: async () => { repeatedOrderCancels++; return { cancelled: true, receipt: "ACCESS_CANCEL" }; } });
  try {
    await repeatedOrder.pool.warmup(repeatedOrder.adminId); await repeatedOrder.pool.warmup(repeatedOrder.adminId); repeatedOrder.pool.pause();
    const stock = repeatedOrder.store.inventoryItems();
    check(stock.filter((row) => row.state === "ready").length === 1 && stock.some((row) => row.state === "purchase_unknown" && row.lastError === "duplicate_order" && !row.order), "duplicate provider activation is never represented as a second cancellable order");
    repeatedOrder.advance(121000); await repeatedOrder.pool.tick();
    check(repeatedOrderCancels === 0, "duplicate activation handling never cancels the original live inventory order");
    const duplicate = stock.find((row) => row.state === "purchase_unknown");
    repeatedOrder.pool.reconcileInventory(duplicate.id, { action: "close", note: "Provider confirmed duplicate response refers to original existing activation" }, repeatedOrder.adminId);
    check(repeatedOrder.store.inventoryItem(duplicate.id).state === "closed" && repeatedOrder.store.inventoryItem(duplicate.id).refundStatus === "unconfirmed", "audited duplicate response can close without touching original activation or claiming refund");
  } finally { await repeatedOrder.pool.close(); repeatedOrder.store.close(); }

  let directCalls = 0;
  const directDuplicate = await fixture({ getNumber: async () => ({ requestId: `direct-unique-order-${++directCalls}`, number: "+12025550123" }) });
  try {
    directDuplicate.pool.saveRules({ buffer: { enabled: false }, maxAttempts: 1 }, directDuplicate.adminId);
    const first = directDuplicate.input(); const second = directDuplicate.input(directDuplicate.second); const userA = directDuplicate.pool.forOwner(directDuplicate.first.id); const userB = directDuplicate.pool.forOwner(directDuplicate.second.id);
    userA.begin(first); const assigned = await userA.getNumber(first); userB.begin(second);
    await assert.rejects(userB.getNumber(second));
    check(directCalls >= 2 && !directDuplicate.store.smsOperation(directDuplicate.second.id, second.operationId).allocation
      && directDuplicate.store.inventoryItems().some((row) => row.state === "quarantined" && row.source === "direct_duplicate"), "on-demand path atomically rejects a phone already allocated to another CDK");
    check(directDuplicate.store.smsOperation(directDuplicate.first.id, first.operationId).allocation.order.requestId === assigned.order.requestId, "duplicate direct purchase cannot change first tenant allocation");
    userA.release(first);
  } finally { await directDuplicate.pool.close(); directDuplicate.store.close(); }

  const sameDirectOrder = await fixture({ getNumber: async () => ({ requestId: "persistent-provider-order", number: "+12025550123" }) });
  try {
    sameDirectOrder.pool.saveRules({ buffer: { enabled: false }, maxAttempts: 1 }, sameDirectOrder.adminId);
    const first = sameDirectOrder.input(); const userA = sameDirectOrder.pool.forOwner(sameDirectOrder.first.id);
    userA.begin(first); await userA.getNumber(first); userA.release(first);
    const second = sameDirectOrder.input(sameDirectOrder.second); const userB = sameDirectOrder.pool.forOwner(sameDirectOrder.second.id); userB.begin(second);
    await assert.rejects(userB.getNumber(second));
    const duplicate = sameDirectOrder.store.inventoryItems().find((row) => row.lastError === "duplicate_order");
    check(duplicate?.state === "purchase_unknown" && !duplicate.order, "a previously ended provider order is never reallocated or automatically cancelled under another CDK");
  } finally { await sameDirectOrder.pool.close(); sameDirectOrder.store.close(); }

  let finishBufferBuy; const interrupted = await fixture({ getNumber: () => new Promise((resolve) => { finishBufferBuy = resolve; }) });
  try {
    const pending = interrupted.pool.warmup(interrupted.adminId);
    let closed = false; const closing = interrupted.pool.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 30)); check(!closed, "buffer shutdown waits for pending purchase response before allowing database close");
    finishBufferBuy({ requestId: "shutdown-prefetch-order", number: "+12025550123" }); await pending; await closing;
    check(interrupted.store.inventoryItems()[0].order.requestId === "shutdown-prefetch-order", "in-flight purchase result is durably saved during shutdown");
  } finally { await interrupted.pool.close(); interrupted.store.close(); }

  let finishDrainPurchase;
  const draining = await fixture({ getNumber: () => new Promise((resolve) => { finishDrainPurchase = resolve; }) });
  try {
    const warmup = draining.pool.warmup(draining.adminId); const drain = draining.pool.drain(draining.adminId);
    finishDrainPurchase({ requestId: "drained-arrival", number: "+12025550123" }); await Promise.all([warmup, drain]);
    check(draining.store.inventoryItems()[0].state === "cancel_pending" && !draining.pool.publicSummary().hasNumbers, "in-flight warmup response after drain retires on arrival instead of recreating ready stock");
  } finally { await draining.pool.close(); draining.store.close(); }
  console.log(`[ok] SMS buffer: ${checks} scenario assertions; independent encrypted inventory, atomic tenant claims, success fees, cancellation, expiry, unknown recovery and public privacy; local provider stubs only.`);
} finally { for (const root of roots) await fs.rm(root, { recursive: true, force: true }); }
