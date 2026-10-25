import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startCdkServer } from "../src/cdk-server.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-sms-pool-api-"));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-sms-pool-api-admin-only";
let app; let base; const scopes = new Map(); let optionsCalls = 0;
function client() {
  let cookie = ""; let token = "";
  return async (url, method = "GET", body, headers = {}) => {
    const response = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { "x-console-token": token } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    const data = await response.json(); if (data.token) token = data.token; return { status: response.status, data };
  };
}
try {
  app = await startCdkServer({ root, listen: false, smsPoolOptions: { createProvider: (id, config) => ({ listNumberOptions: async () => {
    optionsCalls++; assert.equal(config.apiKey, "synthetic-pool-key"); return [{ country: "1", title: "Synthetic country", price: 0.25, count: 5 }];
  }, getNumber: async () => ({ requestId: crypto.randomUUID(), number: "+12025550123", cost: { amount: "0.25", currency: "USD", source: "order" } }) }) }, createWorkspace: async (options) => {
    scopes.set(options.cdkId, options.smsPool);
    return { activeCount: () => 0, tick: () => 0, inventory: () => [], pause() {}, resume() {}, stop: async () => {}, shutdown: async () => {},
      dispatch: async () => ({ body: Buffer.from(JSON.stringify({ features: {} })) }), handle: async (req, res) => { res.writeHead(404); res.end("{}"); } };
  } });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  const anonymous = client(); const admin = client(); const user = client();
  assert.equal((await anonymous("/api/sms-pool")).status, 401);
  assert.equal((await admin("/api/auth/login", "POST", { cdk: process.env.TOSUB2_ADMIN_CDK })).status, 200);
  const generated = await admin("/api/admin/cdks", "POST", { count: 1, quota: 10, note: "Synthetic pool API" }); const owner = generated.data.items[0];
  assert.equal((await user("/api/auth/login", "POST", { cdk: owner.secret })).status, 200);
  assert.equal((await user("/api/admin/sms-pool")).status, 403);
  assert.equal((await user("/api/admin/sms-pool/rules", "PUT", { enabled: true })).status, 403);
  let response = await admin("/api/admin/sms-pool/rules", "PUT", { enabled: true, fee: 2, noStockThreshold: 3, cooldownMinutes: 15, maxAttempts: 5, maxConcurrent: 3 });
  assert.equal(response.status, 200); assert.equal(response.data.rules.fee, 2);
  assert.equal((await admin("/api/admin/sms-pool/rules", "PUT", { fee: -1 })).status, 422);
  response = await admin("/api/admin/sms-pool/credentials", "POST", { providerId: "herosms", name: "Synthetic account", apiKey: "synthetic-pool-key" });
  assert.equal(response.status, 200); const credentialId = response.data.credentials[0].id;
  assert.equal(JSON.stringify(response.data).includes("synthetic-pool-key"), false);
  response = await admin(`/api/admin/sms-pool/credentials/${credentialId}/options`, "POST", {});
  assert.equal(response.status, 200); assert.equal(response.data.options[0].country, "1"); assert.equal(optionsCalls, 1);
  assert.equal((await user(`/api/admin/sms-pool/credentials/${credentialId}/options`, "POST", {})).status, 403); assert.equal(optionsCalls, 1);
  response = await admin("/api/admin/sms-pool/entries", "POST", { credentialId, country: "1", countryLabel: "Synthetic country", maxPrice: "0.25", priority: 1 });
  assert.equal(response.status, 200); const entryId = response.data.entries[0].id;
  response = await user("/api/sms-pool"); assert.equal(response.status, 200); assert.equal(response.data.available, true); assert.equal(response.data.fee, 2);
  assert.equal(response.data.credentials, undefined); assert.equal(response.data.entries, undefined); assert.equal(response.data.operations, undefined);
  for (const field of ["countries", "country", "countryLabel", "availableEntries", "cost", "costOrders", "costSummary", "quote", "maxPrice"]) assert.equal(response.data[field], undefined, `ordinary CDKs cannot read internal ${field}`);
  assert.equal(typeof response.data.hasNumbers, "boolean");
  assert.equal((await user("/api/admin/sms-pool/buffer/warmup", "POST", {})).status, 403);
  assert.equal((await user("/api/admin/sms-pool/buffer/drain", "POST", {})).status, 403);
  assert.equal((await user(`/api/admin/sms-pool/inventory/${crypto.randomUUID()}/reconcile`, "POST", { action: "close", note: "forged" })).status, 403);
  response = await admin("/api/admin/sms-pool/buffer/warmup", "POST", {});
  assert.equal(response.status, 200);
  assert.equal(response.data.buffer.rules.enabled, false, "warmup does not bypass the disabled buffer rule");
  assert.equal((await admin("/api/admin/sms-pool/buffer/drain", "POST", {})).status, 200);
  assert.equal((await admin(`/api/admin/sms-pool/entries/${entryId}`, "PATCH", { enabled: false })).status, 200);
  assert.equal((await user("/api/sms-pool")).data.available, false);
  await admin(`/api/admin/sms-pool/entries/${entryId}`, "PATCH", { enabled: true });
  app.store.inventory(owner.id, ["fixture@example.invalid"]);
  const context = { operationId: crypto.randomUUID(), jobId: crypto.randomUUID(), runId: crypto.randomUUID(), email: "fixture@example.invalid" };
  scopes.get(owner.id).begin({ ...context, fee: 0, ownerId: app.store.adminId });
  assert.equal(app.store.get(owner.id).reserved, 2); assert.equal(app.store.get(app.store.adminId).reserved, 0);
  await scopes.get(owner.id).getNumber(context);
  scopes.get(owner.id).release({ operationId: context.operationId, uncertain: true });
  response = await user(`/api/admin/sms-pool/operations/${context.operationId}/reconcile`, "POST", { action: "release", note: "forged" }); assert.equal(response.status, 403);
  response = await admin(`/api/admin/sms-pool/operations/${context.operationId}/reconcile`, "POST", { cdkId: owner.id, action: "release", note: "Provider confirmed cancellation" });
  assert.equal(response.status, 200); assert.equal(app.store.get(owner.id).reserved, 0); assert.equal(app.store.get(owner.id).balance, 10);
  response = await admin("/api/admin/sms-pool"); assert.equal(JSON.stringify(response.data).includes("synthetic-pool-key"), false);
  assert.equal(response.data.costSummary.byCurrency.find((row) => row.currency === "USD").confirmedPurchaseAmount, "0.25", "administrator sees provider-confirmed purchase amount");
  assert.equal(response.data.operations[0].costOrders[0].cost.amount, "0.25", "administrator can inspect per-number costs");
  response = await user("/api/sms-pool");
  assert.equal(response.data.costSummary, undefined, "public availability stays free of administrator cost data");
  response = await admin("/api/admin/sms-pool");
  const previousCount = response.data.entries.length;
  response = await admin("/api/admin/sms-pool/entries", "POST", { entries: [{ credentialId, country: "2", maxPrice: "0.3" }, { credentialId, country: "invalid", maxPrice: "0.5" }] });
  assert.equal(response.status, 422); assert.equal((await admin("/api/admin/sms-pool")).data.entries.length, previousCount);
  response = await admin("/api/admin/sms-pool/entries", "POST", { entries: [{ credentialId, country: "2", maxPrice: "0.3" }, { credentialId, country: "3", maxPrice: "0.5" }] });
  assert.equal(response.status, 200); assert.equal(response.data.entries.length, previousCount + 2);
  assert.equal((await admin("/api/admin/sms-pool/rules", "PUT", { fee: 3 }, { "x-console-token": "wrong" })).status, 403);
  console.log("[ok] SMS pool API: administrator controls, tenant isolation, redacted options, server fee, owner-bound callbacks, and audited recovery passed; localhost stubs only.");
} finally { await app?.close(); await fs.rm(root, { recursive: true, force: true }); }
