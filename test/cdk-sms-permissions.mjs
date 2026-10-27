import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startCdkServer } from "../src/cdk-server.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-cdk-sms-permissions-"));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-cdk-sms-permissions-administrator";
const ids = ["custom", "luban", "smsbower", "herosms", "pool"];
const canonicalIds = ["luban", "smsbower", "herosms", "custom", "pool"];
const smsKey = "chatgpt-onboarding.sms-provider-settings-v1";
const legacyKey = "chatgpt-onboarding.luban-api-key";
const mailKey = "chatgpt-onboarding.mail-request-settings-v1";
let app; let base; let forwarded = 0; let purchases = 0; let holdPurchase = false; let finishPurchase; let holdInspection = false; let finishInspection;
const scopes = new Map();
function client() {
  let cookie = ""; let csrf = "";
  return async (route, method = "GET", body) => {
    const response = await fetch(base + route, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(csrf ? { "x-console-token": csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    const data = await response.json(); if (data.token) csrf = data.token;
    return { status: response.status, data };
  };
}
const wait = async (predicate) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "fixture operation did not reach expected stage"); await new Promise((resolve) => setTimeout(resolve, 10)); }
};
async function start() {
  app = await startCdkServer({ root, listen: false, smsPoolOptions: { createProvider: () => ({
    activationPolicy: { lifetimeSeconds: 1500, minCancelAgeSeconds: 120, source: "fixture" },
    getNumber: async () => { const index = ++purchases; const order = { requestId: `permission-order-${index}`, number: `+1202555${String(index).padStart(4, "0")}` }; if (holdPurchase) return new Promise((resolve) => { finishPurchase = () => resolve(order); }); return order; },
    inspect: async () => holdInspection ? new Promise((resolve) => { finishInspection = () => resolve({ state: "waiting", hasSms: false }); }) : { state: "waiting", hasSms: false },
    cancelStrict: async () => ({ cancelled: true, receipt: "ACCESS_CANCEL" }),
  }) }, createWorkspace: async (options) => {
    scopes.set(options.cdkId, options);
    const emails = [];
    const providerAllowed = (id) => options.smsProviderAllowed(id);
    return { activeCount: () => 0, tick: () => 0, inventory: () => emails, publicJobs: () => [], pause() {}, resume() {}, stop: async () => {}, shutdown: async () => {},
      dispatch: async (method, route) => ({ status: 200, body: Buffer.from(JSON.stringify({ features: { smsProviders: canonicalIds.map((id) => ({ id, name: id, fields: [] })), smsPool: { enabled: true, fee: 2 } } })) }),
      planImport: (mode, body) => [body.email || "fixture@example.invalid"],
      applyImport: async (mode, body) => { emails.push(body.email); return { status: 201, data: { created: true, job: { id: crypto.randomUUID(), email: body.email } } }; },
      handle: async (req, res) => { forwarded++; res.writeHead(200, { "content-type": "application/json" }); const pathname = new URL(req.url, "http://fixture.invalid").pathname; res.end(JSON.stringify(pathname === "/api/jobs" ? { features: { smsProviders: canonicalIds.filter(providerAllowed).map((id) => ({ id, name: id, fields: [] })) } } : { ok: true })); },
    };
  } });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
}

try {
  await start(); const admin = client(); const user = client(); const other = client();
  const login = await admin("/api/auth/login", "POST", { cdk: process.env.TOSUB2_ADMIN_CDK });
  assert.equal(login.status, 200); assert.deepEqual(login.data.workspace.allowedSmsProviders, ids);
  const adminId = login.data.account.id;
  assert.equal((await admin(`/api/admin/cdks/${adminId}`, "PATCH", { allowedSmsProviders: ["custom"] })).status, 409);
  const generated = await admin("/api/admin/cdks", "POST", { count: 2, quota: 20 });
  const [owner, second] = generated.data.items;
  assert.deepEqual(owner.allowedSmsProviders, ["custom"]);
  assert.equal((await admin("/api/admin/cdks", "POST", { count: 1, quota: 1, allowedSmsProviders: ["invalid"] })).status, 422);
  assert.equal((await admin(`/api/admin/cdks/${owner.id}`, "PATCH", { allowedSmsProviders: "pool" })).status, 422);
  assert.equal((await user("/api/auth/login", "POST", { cdk: owner.secret })).status, 200);
  await other("/api/auth/login", "POST", { cdk: second.secret });
  let current = (await user("/api/bootstrap")).data;
  assert.deepEqual(current.features.smsProviders.map((provider) => provider.id), ["custom"]);
  assert.deepEqual(current.features.allowedSmsProviders, ["custom"]);
  assert.deepEqual((await user("/api/jobs")).data.features.smsProviders.map((provider) => provider.id), current.features.smsProviders.map((provider) => provider.id), "bootstrap and job polling expose the same provider order");
  assert.equal(current.features.smsPool, undefined, "ungranted pool metadata is also hidden from bootstrap");
  assert.equal(scopes.get(owner.id).smsProviderAllowed("herosms"), false);
  assert.equal(scopes.get(owner.id).smsProviderAllowed("custom"), true);
  const balance = app.store.get(owner.id).balance;
  const callsBefore = forwarded;
  for (const [route, body] of [
    ["/api/sms-providers/herosms/options", { config: { apiKey: "fixture" } }],
    ["/api/jobs/11111111-1111-4111-8111-111111111111/sms-number", { providerId: "herosms", config: {} }],
    ["/api/jobs/11111111-1111-4111-8111-111111111111/luban-number", { apiKey: "fixture", serviceId: "1" }],
    ["/api/jobs/start-phone-batch", { ids: [], smsProvider: { id: "pool", config: {} } }],
    ["/api/jobs", { email: "denied@example.invalid", phoneBindingMode: "automatic", smsProvider: { id: "herosms", config: {} } }],
    ["/api/imports/preview", { mode: "single", payload: { email: "denied@example.invalid", smsProvider: { id: "pool" } } }],
  ]) { const denied = await user(route, "POST", body); assert.equal(denied.status, 403, route); assert.equal(denied.data.code, "SMS_PROVIDER_FORBIDDEN"); }
  assert.equal(forwarded, callsBefore); assert.equal(app.store.get(owner.id).balance, balance); assert.equal(app.store.get(owner.id).reserved, 0);
  assert.equal((await user("/api/sms-pool")).status, 403);
  assert.equal((await user(`/api/admin/cdks/${owner.id}`, "PATCH", { allowedSmsProviders: ["herosms"] })).status, 403);

  app.store.saveSetting(owner.id, "workspace", { [smsKey]: JSON.stringify({ selectedProviderId: "herosms", configs: { herosms: { apiKey: "hidden-provider-secret" }, custom: { entries: "old-custom" } } }), [legacyKey]: "hidden-legacy-secret", [mailKey]: "mail-before" });
  current = (await user("/api/bootstrap")).data;
  assert.deepEqual(JSON.parse(current.settings[smsKey]), { selectedProviderId: "custom", configs: { custom: { entries: "old-custom" } } });
  assert.equal(current.settings[legacyKey], undefined); assert.doesNotMatch(JSON.stringify(current), /hidden-provider-secret|hidden-legacy-secret/);
  let saved = await user("/api/settings/workspace", "PUT", { workspaceId: owner.id, settings: { [smsKey]: JSON.stringify({ selectedProviderId: "custom", configs: { custom: { entries: "new-custom" } } }), [mailKey]: "mail-after", allowedSmsProviders: ["herosms"] } });
  assert.equal(saved.status, 200); assert.deepEqual(app.store.get(owner.id).allowedSmsProviders, ["custom"]);
  assert.equal(JSON.parse(app.store.setting(owner.id, "workspace")[smsKey]).configs.herosms.apiKey, "hidden-provider-secret", "hidden encrypted credentials survive an unrelated settings save");
  assert.equal(app.store.setting(owner.id, "workspace")[legacyKey], "hidden-legacy-secret");
  assert.equal((await user("/api/settings/workspace", "PUT", { workspaceId: owner.id, settings: { [smsKey]: JSON.stringify({ selectedProviderId: "herosms", configs: {} }) } })).status, 403);
  assert.equal((await user("/api/settings/workspace", "PUT", { workspaceId: owner.id, settings: { [smsKey]: JSON.stringify({ selectedProviderId: "custom", configs: { herosms: {} } }) } })).status, 403);
  assert.equal((await user("/api/settings/workspace", "PUT", { workspaceId: owner.id, settings: { [legacyKey]: "forged-key" } })).status, 403);
  assert.equal((await user("/api/settings/workspace", "PUT", { workspaceId: second.id, settings: {} })).status, 409);

  saved = await admin(`/api/admin/cdks/${owner.id}`, "PATCH", { allowedSmsProviders: ["herosms", "pool", "herosms"] });
  assert.equal(saved.status, 200); assert.deepEqual(saved.data.allowedSmsProviders, ["custom", "herosms", "pool"]);
  current = (await user("/api/auth/me")).data;
  assert.deepEqual(current.features.smsProviders.map((provider) => provider.id), ["herosms", "custom", "pool"], "permission changes retain the existing session and update its capabilities in canonical order");
  assert.deepEqual((await user("/api/jobs")).data.features.smsProviders.map((provider) => provider.id), current.features.smsProviders.map((provider) => provider.id), "permission updates keep bootstrap and job polling provider order aligned");
  assert.equal(JSON.parse(current.settings[smsKey]).configs.herosms.apiKey, "hidden-provider-secret");
  assert.equal(scopes.get(owner.id).smsProviderAllowed("herosms"), true);
  assert.equal((await user("/api/sms-providers/herosms/options", "POST", {})).status, 200);
  assert.equal((await user("/api/sms-pool")).status, 200);
  assert.deepEqual((await other("/api/bootstrap")).data.features.allowedSmsProviders, ["custom"]);
  current = (await admin("/api/auth/workspace", "POST", { cdkId: second.id })).data;
  assert.equal(current.account.role, "admin"); assert.deepEqual(current.features.allowedSmsProviders, ["custom"], "administrator acting in an ordinary workspace follows that workspace's SMS permissions");
  assert.equal((await admin("/api/sms-pool")).status, 403);
  await admin("/api/auth/workspace", "POST", { cdkId: adminId });

  app.smsPool.saveRules({ enabled: true, fee: 2, maxConcurrent: 5 }, adminId);
  app.smsPool.saveCredential({ providerId: "herosms", name: "Synthetic pool source", apiKey: "synthetic-permission-provider" }, adminId);
  const credentialId = app.smsPool.adminSnapshot().credentials[0].id;
  app.smsPool.saveEntry({ credentialId, country: "1", maxPrice: "0.25" }, adminId);
  app.store.inventory(owner.id, ["pool@example.invalid"]);
  const poolUser = app.smsPool.forOwner(owner.id);
  const context = () => ({ operationId: crypto.randomUUID(), jobId: crypto.randomUUID(), runId: crypto.randomUUID(), email: "pool@example.invalid" });
  const first = context(); const waiting = context(); poolUser.begin(first); poolUser.begin(waiting);
  holdPurchase = true; const firstPurchase = poolUser.getNumber(first); await wait(() => typeof finishPurchase === "function");
  const waitingPurchase = poolUser.getNumber(waiting); const waitingRejected = assert.rejects(waitingPurchase, (error) => error.code === "SMS_PROVIDER_FORBIDDEN");
  await admin(`/api/admin/cdks/${owner.id}`, "PATCH", { allowedSmsProviders: [] });
  finishPurchase(); const allocation = await firstPurchase; holdPurchase = false; await waitingRejected;
  assert.equal(purchases, 1, "permission revoked while waiting for a provider lease prevents a second purchase");
  assert.equal(app.store.smsOperation(owner.id, waiting.operationId).state, "released");
  assert.equal(app.store.get(owner.id).reserved, 2, "only the already purchased operation retains its reservation");
  assert.equal((await poolUser.getNumber(first)).order.requestId, allocation.order.requestId, "already allocated numbers remain available to finish after revocation");
  poolUser.release(first); assert.equal(app.store.get(owner.id).reserved, 0);
  assert.throws(() => poolUser.begin(context()), (error) => error.code === "SMS_PROVIDER_FORBIDDEN");

  await admin(`/api/admin/cdks/${owner.id}`, "PATCH", { allowedSmsProviders: ["pool"] });
  app.smsPool.saveRules({ buffer: { enabled: true, forceRefill: false, target: 1 } }, adminId);
  const inventoryId = crypto.randomUUID(); const at = Date.now();
  app.store.createInventoryPurchase({ id: inventoryId, entryId: app.smsPool.adminSnapshot().entries[0].id, credentialId, providerId: "herosms", config: { apiKey: "synthetic-permission-provider", service: "dr", country: "1", maxPrice: "0.25" }, createdAt: at }, { simplified: true, target: 1 });
  app.store.finishInventoryPurchase(inventoryId, { order: { requestId: "buffer-permission-order", number: "+12025550999" }, state: "ready", expiresAt: at + 1500000, expiresSource: "provider", cancelAllowedAt: at + 120000 });
  const inspecting = context(); poolUser.begin(inspecting); holdInspection = true;
  const inspectingPurchase = poolUser.getNumber(inspecting); const inspectingRejected = assert.rejects(inspectingPurchase, (error) => error.code === "SMS_PROVIDER_FORBIDDEN");
  await wait(() => typeof finishInspection === "function");
  await admin(`/api/admin/cdks/${owner.id}`, "PATCH", { allowedSmsProviders: ["custom"] });
  finishInspection(); await inspectingRejected; holdInspection = false;
  assert.equal(app.store.inventoryItem(inventoryId).state, "ready", "a revoked user cannot claim checked shared inventory");
  assert.equal(app.store.inventoryItem(inventoryId).claimOwner, null);
  assert.equal(app.store.smsOperation(owner.id, inspecting.operationId).state, "released");
  assert.equal(purchases, 1); assert.equal(app.store.get(owner.id).reserved, 0);

  await admin(`/api/admin/cdks/${owner.id}`, "PATCH", { allowedSmsProviders: ["smsbower"] });
  const generatedWithAccess = await admin("/api/admin/cdks", "POST", { count: 1, quota: 1, allowedSmsProviders: ["luban"] });
  assert.deepEqual(generatedWithAccess.data.items[0].allowedSmsProviders, ["custom", "luban"]);
  await app.close(); app = null; await start();
  current = (await user("/api/auth/me")).data;
  assert.deepEqual(current.workspace.allowedSmsProviders, ["custom", "smsbower"], "permissions survive a store/server restart");
  assert.deepEqual(current.features.smsProviders.map((provider) => provider.id), ["smsbower", "custom"]);
  assert.equal(app.store.get(owner.id).balance, balance);
  console.log("[ok] CDK SMS permissions: default custom, scoped grants/revocation, hidden encrypted settings, administrator workspace scope, purchase-time guards, reservation release, buffered claim races and persistence; synthetic fixtures only.");
} finally { await app?.close(); await fs.rm(root, { recursive: true, force: true }); }
