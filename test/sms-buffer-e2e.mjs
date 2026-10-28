import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startCdkServer } from "../src/cdk-server.mjs";

process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-legacy-demand-e2e-administrator";
process.env.SMS_POLL_INTERVAL_MS = "10";
const { createConsoleWorkspace } = await import("../src/console-server.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-legacy-demand-e2e-"));
const protocolFile = path.join(root, "protocol.mjs");
await fs.writeFile(protocolFile, `import readline from 'node:readline/promises';
import {phoneEvidenceContext,persistPhoneOutcome} from ${JSON.stringify(pathToFileURL(path.resolve("src/phone-verification-evidence.mjs")).href)};
const rl=readline.createInterface({input:process.stdin,output:process.stdout});
try {const phone=await rl.question('Phone number, E.164 format (p=quit): ');
await rl.question('Phone OTP (r=resend, p=change phone, q=quit): ');
const context=await phoneEvidenceContext(phone);const pending=await persistPhoneOutcome(context,'pending');
await persistPhoneOutcome(context,'verified',pending);console.log('[phone-verification-evidence] verified');console.log('[ok] Phone OTP validated');process.exitCode=7;
}finally{rl.close();}
`);
let purchases = 0; let cancellations = 0; const orders = new Map();
const provider = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture.invalid"); assert.equal(url.searchParams.get("api_key"), "synthetic-legacy-e2e-key");
  const action = url.searchParams.get("action"); let body;
  if (action === "getNumber") {
    const id = `demand-${++purchases}`; orders.set(id, { ready: false, cancelled: false });
    body = JSON.stringify({ activationId: id, phoneNumber: `+1202555${String(purchases).padStart(4, "0")}`, activationCost: "0.20", activationCurrency: "USD" });
  } else if (action === "getStatus") {
    const order = orders.get(url.searchParams.get("id")); body = !order || order.cancelled ? "STATUS_CANCEL" : order.ready ? "STATUS_OK:123456" : "STATUS_WAIT_CODE";
  } else if (action === "setStatus") {
    const order = orders.get(url.searchParams.get("id")); const status = url.searchParams.get("status");
    if (status === "1") { order.ready = true; body = "ACCESS_READY"; }
    if (status === "6") body = "ACCESS_ACTIVATION";
    if (status === "8") { order.cancelled = true; cancellations++; body = "ACCESS_CANCEL"; }
  }
  res.writeHead(body ? 200 : 400, { "content-type": "text/plain" }); res.end(body || "BAD_ACTION");
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerBase = `http://127.0.0.1:${provider.address().port}/handler_api.php`; process.env.SMSBOWER_API_BASE = providerBase;
let app;
async function wait(predicate, message) { const until = Date.now() + 15000; while (Date.now() < until) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error(message); }
try {
  app = await startCdkServer({ root: path.join(root, "data"), listen: false, smsPoolOptions: { providerOptions: { smsBowerApiBase: providerBase } },
    createWorkspace: (options) => createConsoleWorkspace({ ...options, protocolScript: protocolFile }) });
  const admin = app.store.adminId; const [owner] = app.store.generate({ count: 1, quota: 20, note: "legacy demand fixture", allowedSmsProviders: ["custom", "pool"] }, admin);
  app.smsPool.saveRules({ enabled: true, requestConcurrency: 2 }, admin);
  app.smsPool.saveCredential({ providerId: "smsbower", name: "Fixture account", apiKey: "synthetic-legacy-e2e-key" }, admin);
  const credentialId = app.smsPool.adminSnapshot().credentials[0].id;
  app.smsPool.saveEntry({ credentialId, country: "1", countryLabel: "Private legacy country", maxPrice: "0.25", providerIds: "1" }, admin);
  const entryId = app.smsPool.adminSnapshot().entries[0].id;
  const legacyId = crypto.randomUUID(); const createdAt = Date.now() - 180000; orders.set("legacy-order", { ready: false, cancelled: false });
  app.store.createInventoryPurchase({ id: legacyId, entryId, credentialId, providerId: "smsbower", config: { apiKey: "synthetic-legacy-e2e-key", service: "dr", country: "1", maxPrice: "0.25", providerIds: "1" }, createdAt }, { simplified: true, target: 20 });
  app.store.finishInventoryPurchase(legacyId, { state: "ready", order: { requestId: "legacy-order", number: "+12025559999" }, expiresAt: Date.now() + 1200000,
    cancelAllowedAt: createdAt + 120000, cancelBeforeAt: Date.now() + 1200000, nextActionAt: 0 });
  app.store.mutateSmsPoolConfig((value) => { value.rules.buffer = { enabled: true, forceRefill: true, target: 20 }; return value; });
  await app.smsPool.tick(); assert.equal(purchases, 0); assert.equal(cancellations, 1); assert.equal(app.store.inventoryItem(legacyId).state, "closed");
  const imported = await app.importFor(owner.id, "single", { email: "demand-e2e@example.invalid", phoneBindingMode: "automatic", smsProvider: { id: "pool", config: { categoryId: "other", quotedFee: 2 } } }, crypto.randomUUID(), owner.id);
  assert.equal(imported.status, 201);
  await wait(() => app.store.get(owner.id).smsPoolConsumed === 2, "new task must acquire directly and settle verified evidence");
  assert.equal(purchases, 1, "one active task causes exactly one new purchase");
  const operation = app.store.smsOperations(owner.id)[0]; assert.equal(operation.allocation.inventoryId, undefined);
  assert.equal(operation.allocation.order.requestId, "demand-1"); assert.equal(app.store.get(owner.id).reserved, 0);
  await app.smsPool.tick(); await app.smsPool.tick(); assert.equal(purchases, 1, "successful completion never refills an old inventory target");
  const publicJob = (await app.workspaceFor(owner.id)).publicJobs().find((value) => value.id === imported.data.job.id);
  assert.equal(publicJob.smsProviderId, "pool"); assert.doesNotMatch(JSON.stringify(publicJob), /synthetic-legacy-e2e-key|Private legacy country/);
  assert.equal(app.smsPool.inventoryPage({ scope: "history" }).items.some((value) => value.id === legacyId), true);
  console.log("[ok] Legacy-to-demand E2E: old ready order recovered, zero prefetch, fresh task direct acquisition, exact fee settlement and historical preservation (localhost only)");
} finally { await app?.close(); await new Promise((resolve) => provider.close(resolve)); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
