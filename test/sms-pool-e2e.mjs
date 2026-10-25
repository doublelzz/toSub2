import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "../src/workspace-storage.mjs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startCdkServer } from "../src/cdk-server.mjs";

process.env.SMS_POLL_INTERVAL_MS = "10";
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-pool-e2e-admin-only";
const { createConsoleWorkspace } = await import("../src/console-server.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-pool-e2e-"));
const fixture = path.join(root, "protocol-fixture.mjs");
const evidenceModule = pathToFileURL(path.resolve("src/phone-verification-evidence.mjs")).href;
await fs.writeFile(fixture, `import readline from 'node:readline/promises';
import {phoneEvidenceContext,persistPhoneOutcome} from ${JSON.stringify(evidenceModule)};
const email=process.argv[process.argv.indexOf('--email')+1];
const rl=readline.createInterface({input:process.stdin,output:process.stdout});
try {
 const phone=await rl.question('Phone number, E.164 format (p=quit): ');
 await rl.question('Phone OTP (r=resend, p=change phone, q=quit): ');
 const context=await phoneEvidenceContext(phone);
 const pending=await persistPhoneOutcome(context,'pending');
 await new Promise(resolve=>setTimeout(resolve,180));
 if(email.startsWith('unknown')) process.exitCode=7;
 else { await persistPhoneOutcome(context,'verified',pending); console.log('[phone-verification-evidence] verified'); console.log('[ok] Phone OTP validated'); process.exitCode=7; }
} finally {rl.close();}
`);

const orders = new Map(); let purchaseCalls = 0; let holdNew = false;
const provider = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture.invalid"); assert.equal(url.searchParams.get("api_key"), "synthetic-e2e-key");
  const action = url.searchParams.get("action"); let result;
  if (action === "getNumber") {
    purchaseCalls++; const id = `order-${purchaseCalls}`; const phone = `+1202555${String(purchaseCalls).padStart(4, "0")}`;
    orders.set(id, { phone, hold: holdNew }); result = `ACCESS_NUMBER:${id}:${phone}`;
  } else if (action === "getStatus") result = orders.get(url.searchParams.get("id"))?.hold ? "STATUS_WAIT_CODE" : "STATUS_OK:654321";
  else if (action === "setStatus") result = ({ 1: "ACCESS_READY", 6: "ACCESS_ACTIVATION", 8: "ACCESS_CANCEL" })[url.searchParams.get("status")];
  else { res.writeHead(400); res.end("BAD_ACTION"); return; }
  res.writeHead(200, { "content-type": "text/plain" }); res.end(result);
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerBase = `http://127.0.0.1:${provider.address().port}/handler_api.php`;
process.env.SMSBOWER_API_BASE = providerBase;
let app; let first; let second; let assertions = 0;
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
async function start() {
  app = await startCdkServer({ root: path.join(root, "data"), listen: false,
    smsPoolOptions: { providerOptions: { smsBowerApiBase: providerBase } },
    createWorkspace: (options) => createConsoleWorkspace({ ...options, protocolScript: fixture }) });
}
async function wait(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 15)); }
  throw new Error(message);
}
async function importJob(ownerId, email, automatic = true) {
  const body = { email, phoneBindingEnabled: true, ...(automatic ? { phoneBindingMode: "automatic", smsProvider: { id: "pool", config: { quotedFee: 2 } } } : {}) };
  const imported = await app.importFor(ownerId, "single", body, crypto.randomUUID(), ownerId);
  check(imported.status, 201, "CDK import completed"); return imported.data.job.id;
}
async function job(ownerId, id) { return (await app.workspaceFor(ownerId)).publicJobs().find((value) => value.id === id); }
async function dispatch(ownerId, route, body = {}) {
  try { const response = await (await app.workspaceFor(ownerId)).dispatch("POST", route, body); return { status: response.status, data: JSON.parse(response.body.toString()) }; }
  catch (error) { return { status: error.status || 500, data: { error: error.message, code: error.code } }; }
}
try {
  await start();
  [first, second] = app.store.generate({ count: 2, quota: 20, note: "Synthetic central+console" }, app.store.adminId);
  app.smsPool.saveRules({ enabled: true, fee: 2, maxConcurrent: 2 }, app.store.adminId);
  app.smsPool.saveCredential({ providerId: "smsbower", name: "Shared synthetic key", apiKey: "synthetic-e2e-key" }, app.store.adminId);
  const credentialId = app.smsPool.adminSnapshot().credentials[0].id;
  app.smsPool.saveEntry({ credentialId, country: "1", countryLabel: "Synthetic country", maxPrice: "0.25", providerIds: "1" }, app.store.adminId);
  const [one, two] = await Promise.all([importJob(first.id, "shared@example.invalid"), importJob(second.id, "shared@example.invalid")]);
  await wait(() => app.store.pendingSmsOperations().length === 2, "two CDK-owned sessions should run concurrently");
  check(app.store.get(first.id).reserved, 2, "first tenant reservation separate"); check(app.store.get(second.id).reserved, 2, "second tenant reservation separate");
  await wait(async () => (await job(first.id, one)).smsPoolBilling?.state === "verified" && (await job(second.id, two)).smsPoolBilling?.state === "verified", "both tenants must settle");
  check(app.store.get(first.id).balance, 17, "one import plus two success fees"); check(app.store.get(second.id).balance, 17, "same email charged only in own CDK");
  check(app.store.get(first.id).smsPoolConsumed, 2, "fee is independent of OAuth fixture failure"); check(app.store.get(first.id).importConsumed, 1, "import ledger remains separate");
  check(purchaseCalls, 2, "same-key concurrent sessions purchased distinct orders");
  const rawMetadata = await fs.readFile(path.join(root, "data", "cdk", first.id, one, "job-meta.json"), "utf8");
  check(rawMetadata.includes("synthetic-e2e-key"), false, "no shared API key in tenant metadata");
  const jobs = (await app.workspaceFor(first.id)).publicJobs(); check(JSON.stringify(jobs).includes("synthetic-e2e-key"), false, "no shared API key in tenant responses");

  app.smsPool.saveRules({ maxConcurrent: 1 }, app.store.adminId); holdNew = true;
  const held = await importJob(first.id, "cancel-held@example.invalid");
  await wait(async () => (await job(first.id, held)).smsStatus === "waiting_sms", "held order should be allocated while waiting for SMS");
  check(app.store.get(first.id).reserved, 2, "concurrency lease covers allocated SMS wait");
  const contender = await importJob(second.id, "contender@example.invalid", false);
  await wait(async () => (await job(second.id, contender)).status === "phone", "manual contender should reach phone step");
  const beforeBusy = purchaseCalls;
  const busy = await dispatch(second.id, `/api/jobs/${contender}/sms-number`, { providerId: "pool", config: { quotedFee: 2 } });
  check(busy.status, 200, "busy session is accepted into pool wait queue");
  await wait(async () => (await job(second.id, contender)).smsPoolBilling?.state === "queued", "concurrency overflow should wait without reserving");
  check(app.store.get(second.id).reserved, 0, "queued pool session holds no CDK reservation");
  check(purchaseCalls, beforeBusy, "queued session does not purchase another number");
  await dispatch(first.id, `/api/jobs/${held}/cancel`);
  await wait(() => app.store.get(first.id).reserved === 0, "cancel before OTP submission should release fee");
  check(app.store.get(first.id).smsPoolConsumed, 2, "cancellation adds no fee");
  await wait(async () => (await job(second.id, contender)).smsStatus === "waiting_sms", "queued session should continue automatically when lease is released");
  check(purchaseCalls, beforeBusy + 1, "released pool slot starts the next purchase without another click");
  await dispatch(second.id, `/api/jobs/${contender}/cancel`);

  holdNew = false;
  const unknownId = await importJob(first.id, "unknown-result@example.invalid");
  await wait(async () => (await job(first.id, unknownId)).smsPoolBilling?.state === "unknown", "submitted uncertain verification must freeze fee");
  check(app.store.get(first.id).reserved, 2, "unknown result keeps reservation");
  const metadataPath = path.join(root, "data", "cdk", first.id, unknownId, "job-meta.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8")); const context = metadata.sms_pool_context;
  const callsBeforeRestart = purchaseCalls;
  await app.close(); app = null; await start();
  check(app.store.get(first.id).reserved, 2, "unknown reservation persists across actual store/workspace restart");
  check(purchaseCalls, callsBeforeRestart, "restart never repeats unknown purchase");
  const resultFile = path.join(path.dirname(metadataPath), `phone-pool-result-${context.runId}.json`);
  await fs.writeFile(resultFile, JSON.stringify({ version: 1, type: "phone_verification", ...context, eventId: crypto.randomUUID(), state: "verified", at: new Date().toISOString(), verifiedAt: new Date().toISOString() }));
  await app.close(); app = null; await start();
  check(app.store.get(first.id).reserved, 0, "durable matching evidence settles after restart");
  check(app.store.get(first.id).smsPoolConsumed, 4, "recovered success charges once");
  check(purchaseCalls, callsBeforeRestart, "reconciliation never allocates another number");

  holdNew = true; const shutdownJob = await importJob(second.id, "cancel-shutdown@example.invalid");
  await wait(async () => (await job(second.id, shutdownJob)).smsStatus === "waiting_sms", "shutdown fixture should wait for SMS");
  await app.close(); app = null; await start();
  check(app.store.get(second.id).reserved, 0, "graceful shutdown releases unsubmitted allocation");
  check(app.store.get(second.id).smsPoolConsumed, 2, "shutdown does not invent success fees");
  console.log(`[ok] SMS pool E2E: ${assertions} assertions; real CDK store/server/workspace/provider adapters with localhost SMS and protocol fixtures only.`);
} finally {
  await app?.close(); await new Promise((resolve) => provider.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
}
