import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkStore } from "../src/cdk-store.mjs";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { classifyPoolError, createSmsPool } from "../src/sms-pool.mjs";
import { createSmsBuffer } from "../src/sms-buffer.mjs";
import { createSmsProvider } from "../src/sms-providers.mjs";

process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-daxigua-pool-administrator";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-daxigua-pool-"));
const vault = await createCdkVault(root);
const store = await createCdkStore(root, vault);
const providerConfigs = [];
const pool = createSmsPool({ store, createProvider: (providerId, config) => {
  assert.equal(providerId, "daxigua");
  providerConfigs.push({ ...config });
  return {
    listNumberOptions: async () => [{ serviceId: "2", country: "kh", project: "chatgpt", uses: 1, title: "Chat GPT", price: 1, count: 1, currency: "次" }],
    getNumber: async () => ({ requestId: "987", number: "+85512345678" }),
    inspect: async () => ({ state: "waiting", hasSms: false }),
    cancelStrict: async () => ({ requestId: "987", cancelled: true, receipt: "cancelled", refundStatus: "confirmed" }),
  };
} });

try {
  const admin = store.adminId;
  const [owner] = store.generate({ count: 1, quota: 20, note: "DaXiGua pool fixture" }, admin);
  store.inventory(owner.id, ["daxigua-pool@example.invalid"]);
  pool.saveRules({ enabled: true, fee: 2, requestConcurrency: 1 }, admin);
  pool.saveCredential({ providerId: "daxigua", name: "DaXiGua fixture", apiKey: "fixture:key/with-symbols" }, admin);
  const credential = pool.adminSnapshot().credentials[0];
  const options = await pool.credentialOptions(credential.id, {}, admin);
  assert.equal(options.options[0].serviceId, "2");
  pool.saveEntry({ credentialId: credential.id, country: "kh", countryLabel: "Chat GPT / kh", project: "chatgpt", serviceId: "2", uses: "1", priority: 1 }, admin);
  const entry = pool.adminSnapshot().entries[0];
  assert.deepEqual({ country: entry.country, service: entry.service, project: entry.project, serviceId: entry.serviceId, uses: entry.uses, maxPrice: entry.maxPrice, providerIds: entry.providerIds },
    { country: "kh", service: "chatgpt", project: "chatgpt", serviceId: "2", uses: "1", maxPrice: "1", providerIds: "2" });
  assert.equal(entry.quotedPrice, null, "provider usage count must not be recorded as money");
  assert.equal(entry.currency, null);
  const user = pool.forOwner(owner.id);
  const input = { operationId: crypto.randomUUID(), jobId: crypto.randomUUID(), runId: crypto.randomUUID(), email: "daxigua-pool@example.invalid" };
  user.begin(input);
  const allocation = await user.getNumber(input);
  assert.equal(allocation.providerId, "daxigua");
  assert.equal(allocation.order.requestId, "987");
  const acquisitionConfig = providerConfigs.at(-1);
  assert.deepEqual({ country: acquisitionConfig.country, project: acquisitionConfig.project, serviceId: acquisitionConfig.serviceId, uses: acquisitionConfig.uses },
    { country: "kh", project: "chatgpt", serviceId: "2", uses: "1" });
  assert.equal(classifyPoolError({ code: "INSUFFICIENT_USES" }), "balance_insufficient");
  assert.equal(classifyPoolError({ code: "API_DISABLED" }), "auth_invalid", "disabled API permissions pause the credential rather than pretending a purchase is pending");
  assert.equal(classifyPoolError({ code: "SERVICE_UNAVAILABLE" }), "no_stock");
  user.release({ operationId: input.operationId, orderId: "987", providerId: "daxigua", reason: "fixture complete" });
  assert.equal(store.get(owner.id).reserved, 0);
  const clock = Date.now();
  const pending = new Map();
  for (const id of ["1001", "1002", "1003", "1004", "1005"]) {
    const item = store.queueSmsOrderCancellation({ ...allocation, allocationId: crypto.randomUUID(),
      order: { requestId: id, number: `+1202555${id}` } }, { now: clock, reason: "synthetic_daxigua_recovery" });
    pending.set(id, item.id);
  }
  const providerCalls = [];
  const maintenance = createSmsBuffer({ store, now: () => clock, createProvider: createSmsProvider, providerOptions: { fetchImpl: async (url, options) => {
    const request = new URL(url);
    const id = /\/orders\/(\d+)/.exec(request.pathname)?.[1];
    assert.ok(id, "maintenance never creates a replacement order");
    providerCalls.push(`${options.method}:${id}`);
    if (options.method === "POST" && ["1003", "1004"].includes(id)) return Response.json({ success: false, error: { code: id === "1004" ? "order_not_cancellable" : "cancel_not_confirmed" } }, { status: 409 });
    const status = id === "1004" ? "review" : options.method === "POST" || ["1002", "987"].includes(id) ? "cancelled" : "assigned";
    return Response.json({ success: true, data: { id: options.method === "POST" && id === "1005" ? 999 : id, status,
      terminal: status !== "assigned", phone_number: "+12025550123", failure_reason: status === "review" ? "Fixture review" : "" } });
  } } });
  try {
    await maintenance.tick();
    for (const id of ["1001", "1002"]) {
      const item = store.inventoryItem(pending.get(id));
      assert.equal(item.state, "closed"); assert.equal(item.cancelState, "confirmed");
      assert.equal(item.refundStatus, "confirmed"); assert.equal(item.refundEvidence, `daxigua:${id}:cancelled`);
    }
    assert.ok(!providerCalls.includes("POST:1002"), "an already cancelled order is confirmed without another cancel request");
    assert.ok(!providerCalls.includes("POST:1004"), "review inspection prevents any automatic cancel attempt");
    const uncertain = store.inventoryItem(pending.get("1003"));
    assert.equal(uncertain.state, "cancel_pending"); assert.notEqual(uncertain.refundStatus, "confirmed");
    assert.ok(uncertain.nextActionAt > clock);
    for (const id of ["1004", "1005"]) {
      const item = store.inventoryItem(pending.get(id));
      assert.equal(item.state, "quarantined"); assert.equal(item.nextActionAt, 0);
      assert.notEqual(item.refundStatus, "confirmed", "review and mismatched-order receipts never count as returned uses");
    }
    assert.equal(store.get(owner.id).reserved, 0); assert.equal(store.get(owner.id).balance, 20);
  } finally { await maintenance.close(); }
  console.log("DaXiGua SMS pool tests passed (usage routing, verified JSON cancellation/inspection, unconfirmed refunds, review quarantine and quota isolation; synthetic fixtures only)");
} finally {
  await pool.close();
  store.close();
  await fs.rm(root, { recursive: true, force: true });
}
