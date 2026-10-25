import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "../src/workspace-storage.mjs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.SMS_POLL_INTERVAL_MS = "10";
const { createConsoleWorkspace } = await import("../src/console-server.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-pool-console-"));
const fixture = path.join(root, "protocol-fixture.mjs");
const evidenceModule = pathToFileURL(path.resolve("src/phone-verification-evidence.mjs")).href;
await fs.writeFile(fixture, `import fs from ${JSON.stringify(new URL("../src/workspace-storage.mjs", import.meta.url).href)};
import readline from 'node:readline/promises';
import {phoneEvidenceContext,persistPhoneOutcome} from ${JSON.stringify(evidenceModule)};
const rl=readline.createInterface({input:process.stdin,output:process.stdout});
const email=process.argv[process.argv.indexOf('--email')+1];
try {
 let phone=await rl.question('Phone number, E.164 format (p=quit): ');
 if(email.startsWith('rotate')) {
   console.log('[warn] Could not send SMS to '+phone+': phone unavailable');
   phone=await rl.question('Phone number, E.164 format (p=quit): ');
 }
 const code=await rl.question('Phone OTP (r=resend, p=change phone, q=quit): ');
 const context=await phoneEvidenceContext(phone);
 const pending=await persistPhoneOutcome(context,'pending');
 if(email.startsWith('unknown')) process.exitCode=7;
 else if(email.startsWith('stale')) {
   await fs.writeFile(process.env.TOSUB2_PHONE_RESULT_PATH,JSON.stringify({...pending,runId:'wrong-run',state:'verified',verifiedAt:new Date().toISOString()}));
   console.log('[ok] Phone OTP validated');
 } else {
   await persistPhoneOutcome(context,'verified',pending);
   console.log('[phone-verification-evidence] verified');
   console.log('[ok] Phone OTP validated');
   console.log('[ok] Phone OTP validated');
   process.exitCode=7;
 }
} finally {rl.close();}
`);

const operations = new Map();
let charges = 0;
let begun = 0;
let numbers = 0;
let maxConcurrent = Infinity;
let holdSms = false;
let configuredFee = 2;
let workspaceEnabled = true;
const secret = "fixture-admin-provider-key-must-not-leak";
const billing = row => ({ operationId: row.operationId, state: row.state, fee: 2, reserved: ["verified", "released"].includes(row.state) ? 0 : 2, maxAttempts: 5 });
const smsPool = {
  summary: () => ({ enabled: true, available: true, fee: configuredFee }),
  begin(input) {
    if (input.expectedFee !== undefined && input.expectedFee !== configuredFee) throw Object.assign(new Error("fee changed"), { code: "SMS_POOL_FEE_CHANGED" });
    if ([...operations.values()].filter(row => !["verified", "released"].includes(row.state)).length >= maxConcurrent) throw Object.assign(new Error("pool busy"), { code: "SMS_POOL_BUSY" });
    begun++; const row = { ...input, state: "reserved" }; operations.set(input.operationId, row); return billing(row);
  },
  getNumber({ operationId }) {
    const row = operations.get(operationId); numbers++;
    const order = { requestId: `pool-order-${numbers}`, number: `+60123456${String(numbers).padStart(3, "0")}` };
    const allocation = { operationId, allocationId: crypto.randomUUID(), entryId: "fixture-entry", providerId: "smsbower", config: { apiKey: secret, country: "1", maxPrice: "1", providerIds: "1" }, order,
      client: { id: "smsbower", name: "Fixture Provider", getSms: async () => holdSms || row.email.startsWith("cancel") ? { status: "waiting" } : { status: "received", code: "654321" }, release: async () => true, complete: async () => true } };
    row.allocation = allocation; row.state = "allocated"; return allocation;
  },
  noteSubmitted({ operationId }) { operations.get(operationId).state = "submitted"; },
  abandon({ operationId, confirmedFailure }) {
    const row = operations.get(operationId);
    assert.ok(row.state !== "submitted" || confirmedFailure, "submitted verification cannot be abandoned without evidence");
    row.state = "reserved"; row.allocation = null; return billing(row);
  },
  verified({ operationId, allocationId, orderId, evidence }) {
    const row = operations.get(operationId);
    assert.equal(evidence.operationId, operationId); assert.equal(evidence.jobId, row.jobId); assert.equal(evidence.runId, row.runId);
    assert.equal(evidence.allocationId, allocationId); assert.equal(evidence.orderId, orderId); assert.equal(evidence.state, "verified");
    assert.equal(evidence.providerId, row.allocation.providerId);
    if (row.state !== "verified") charges++;
    row.state = "verified"; return billing(row);
  },
  release({ operationId, uncertain }) {
    const row = operations.get(operationId);
    if (!["verified", "released"].includes(row.state)) row.state = uncertain || row.state === "submitted" ? "unknown" : "released";
    return billing(row);
  },
  recover(operationId) { const row = operations.get(operationId); return { ...billing(row), jobId: row.jobId, runId: row.runId, allocation: row.allocation }; },
};
const vault = { seal: value => JSON.stringify(value), open: value => JSON.parse(value) };
let workspace;
const ticker = setInterval(() => workspace?.tick(), 20);
const options = { root: path.join(root, "workspace"), namespace: "sms-pool-test", cdkId: "fixture-cdk", protocolScript: fixture,
  smsPool, rebindVault: vault, offerVault: vault, offerCanUse: () => true, isEnabled: () => workspaceEnabled,
  readMonitor: async () => null,
  availableSlots: () => 20, requestSchedule: () => { queueMicrotask(() => workspace?.tick()); } };
const call = async (route, body, actorId = "fixture-cdk") => {
  try {
    const result = await workspace.dispatch(body ? "POST" : "GET", route, body, actorId);
    return { status: result.status, data: JSON.parse(result.body.toString()) };
  } catch (error) { return { status: error.status || 500, data: { error: error.message } }; }
};
const wait = async (predicate, label) => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await predicate(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`${label}: ${JSON.stringify(workspace.publicJobs())}`);
};
async function start(email, automatic = true, actorId = "fixture-cdk") {
  const response = await call("/api/jobs", { email, actorId: "untrusted-body-actor", phoneBindingEnabled: true, ...(automatic ? { phoneBindingMode: "automatic", smsProvider: { id: "pool", config: {} } } : {}) }, actorId);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data.job.id;
}
try {
  workspace = await createConsoleWorkspace(options); workspace.resume();
  const bootstrap = await call("/api/bootstrap"); assert.ok(bootstrap.data.features.smsProviders.some(row => row.id === "pool"));
  assert.equal((await call("/api/jobs", { email: "bad@example.com", smsProvider: { id: "pool", config: { fee: 0 } }, phoneBindingMode: "automatic" })).status, 400);
  const success = await start("success@example.com", true, "fixture-admin");
  await wait(() => workspace.publicJobs().find(row => row.id === success && row.smsPoolBilling?.state === "verified"), "verification must settle despite OAuth failure");
  assert.equal(charges, 1); assert.equal(begun, 1);
  assert.equal([...operations.values()][0].actorId, "fixture-admin", "trusted request actor must reach the deferred begin; JSON body actor must be ignored");
  const saved = await fs.readFile(path.join(options.root, success, "job-meta.json"), "utf8");
  assert.equal(JSON.parse(saved).sms_pool_actor_id, "fixture-admin", "actual initiator survives job persistence");
  assert.ok(!saved.includes(secret), "provider secrets must not enter job metadata");
  assert.ok(!JSON.stringify(workspace.publicJobs()).includes(secret));
  const publicOrder = workspace.publicJobs().find(row => row.id === success).smsSummary.latest;
  for (const field of ["amount", "currency", "quote", "maxPrice", "quoteCurrency", "country", "poolEntryId", "inventoryId"]) assert.equal(Object.hasOwn(publicOrder, field), false, `pool internal field ${field} must remain private`);
  assert.equal(publicOrder.providerId, "pool");
  assert.equal(publicOrder.providerName, "接码池");
  assert.equal(workspace.publicJobs().find(row => row.id === success).smsProviderId, "pool");
  assert.deepEqual(workspace.publicJobs().find(row => row.id === success).smsSummary.totals, []);
  const logs = await call(`/api/jobs/${success}/logs`); assert.ok(!logs.data.logs.includes(secret));
  await wait(() => workspace.activeCount() === 0, "first process should exit");
  const rotate = await start("rotate@example.com");
  await wait(() => workspace.publicJobs().find(row => row.id === rotate && row.smsPoolBilling?.state === "verified"), "rotation should finish");
  assert.equal(begun, 2, "rotation must reuse one reservation"); assert.equal(charges, 2); assert.equal(numbers, 3);
  await wait(() => workspace.activeCount() === 0, "rotated process should exit");
  const unknown = await start("unknown@example.com");
  await wait(() => workspace.publicJobs().find(row => row.id === unknown && row.smsPoolBilling?.state === "unknown"), "unknown verification retains its reservation");
  assert.equal(charges, 2);
  await wait(() => workspace.activeCount() === 0, "unknown process should exit");
  const stale = await start("stale@example.com");
  await wait(() => workspace.publicJobs().find(row => row.id === stale && row.smsPoolBilling?.state === "unknown"), "stale evidence must not charge");
  assert.equal(charges, 2);
  await wait(() => workspace.activeCount() === 0, "stale process should exit");
  const staleOperation = operations.get(workspace.publicJobs().find(row => row.id === stale).smsPoolBilling.operationId);
  staleOperation.state = "released";
  await call("/api/jobs");
  assert.equal(workspace.publicJobs().find(row => row.id === stale).smsPoolBilling.state, "released", "admin-released central operation refreshes an already loaded job without restart");
  const confirmedUnknown = await start("unknown-admin-confirmed@example.com");
  await wait(() => workspace.publicJobs().find(row => row.id === confirmedUnknown && row.smsPoolBilling?.state === "unknown"), "admin confirmation fixture should become unknown");
  const unknownOperation = operations.get(workspace.publicJobs().find(row => row.id === confirmedUnknown).smsPoolBilling.operationId);
  unknownOperation.state = "verified";
  await call("/api/jobs");
  assert.equal(workspace.publicJobs().find(row => row.id === confirmedUnknown).smsPoolBilling.state, "verified", "admin-confirmed central success refreshes local unknown state");
  await wait(() => workspace.activeCount() === 0, "admin confirmation fixture should exit");
  const canceled = await start("cancel@example.com", false);
  await wait(() => workspace.publicJobs().find(row => row.id === canceled && row.status === "phone"), "manual request should wait for number");
  assert.equal((await call(`/api/jobs/${canceled}/sms-number`, { providerId: "pool", config: { quotedFee: 2 }, actorId: "untrusted-body-actor" }, "fixture-request-admin")).status, 200);
  await wait(() => workspace.publicJobs().find(row => row.id === canceled && row.smsPoolBilling), "manual request should reserve");
  await wait(() => operations.get(workspace.publicJobs().find(row => row.id === canceled).smsPoolBilling.operationId), "manual request should reach central begin");
  assert.equal(operations.get(workspace.publicJobs().find(row => row.id === canceled).smsPoolBilling.operationId).actorId, "fixture-request-admin", "manual pool request captures authenticated actor");
  await call(`/api/jobs/${canceled}/cancel`, {});
  await wait(() => workspace.publicJobs().find(row => row.id === canceled && row.smsPoolBilling?.state === "released"), "cancel before OTP submission must release reservation");
  assert.equal(charges, 2);
  await workspace.shutdown(); workspace = null;
  const metadata = JSON.parse(await fs.readFile(path.join(options.root, unknown, "job-meta.json"), "utf8"));
  const context = metadata.sms_pool_context;
  const evidence = { version: 1, type: "phone_verification", ...context, eventId: crypto.randomUUID(), state: "verified", at: new Date().toISOString(), verifiedAt: new Date().toISOString() };
  await fs.writeFile(path.join(options.root, unknown, `phone-pool-result-${context.runId}.json`), JSON.stringify(evidence));
  workspace = await createConsoleWorkspace(options);
  assert.equal(workspace.publicJobs().find(row => row.id === unknown).smsPoolBilling.state, "verified", "restart must reconcile durable verification evidence");
  assert.equal(charges, 3);
  workspace.resume();
  const actorBatch = await workspace.applyImport("authorization", { text: "actor-batch-one@example.com\nactor-batch-two@example.com", actorId: "untrusted-import-actor",
    phoneBindingMode: "automatic", smsProvider: { id: "pool", config: { quotedFee: 2 } } }, "fixture-import-admin");
  workspace.resume();
  const actorBatchIds = actorBatch.data.jobs.map(row => row.id);
  await wait(() => actorBatchIds.every(id => workspace.publicJobs().find(row => row.id === id)?.smsPoolBilling?.state === "verified"), "batch imports should propagate actual initiator into deferred pool operations");
  for (const id of actorBatchIds) {
    const operationId = workspace.publicJobs().find(row => row.id === id).smsPoolBilling.operationId;
    assert.equal(operations.get(operationId).actorId, "fixture-import-admin");
  }
  await workspace.shutdown(); workspace = null;
  // A batch larger than the pool limit must keep waiting without buying or reserving.
  operations.clear(); begun = 0; numbers = 0; charges = 0;
  options.root = path.join(root, "queued-workspace");
  maxConcurrent = 5; holdSms = true;
  workspace = await createConsoleWorkspace(options); workspace.resume();
  const batch = [];
  for (let index = 0; index < 6; index++) batch.push(await start(`queue-${index}@example.com`));
  await wait(() => numbers === 5 && workspace.publicJobs().find(row => row.id === batch[5] && row.smsPoolBilling?.state === "queued"), "sixth pool request should queue behind five active sessions");
  const waiting = workspace.publicJobs().find(row => row.id === batch[5]);
  assert.equal(waiting.smsPoolBilling.reserved, 0); assert.equal(waiting.smsNumberAttempt, 0); assert.equal(begun, 5); assert.equal(charges, 0);
  const queuedCancel = await start("queued-cancel@example.com");
  await wait(() => workspace.publicJobs().find(row => row.id === queuedCancel && row.smsPoolBilling?.state === "queued"), "cancel target should be queued");
  await call(`/api/jobs/${queuedCancel}/cancel`, {});
  await wait(() => workspace.publicJobs().find(row => row.id === queuedCancel && row.smsPoolBilling?.state === "released"), "queued cancellation must release without buying");
  holdSms = false;
  await wait(() => batch.every(id => workspace.publicJobs().find(row => row.id === id)?.smsPoolBilling?.state === "verified"), "sixth request should continue automatically after pool slot is freed");
  assert.equal(begun, 6); assert.equal(numbers, 6); assert.equal(charges, 6);
  await wait(() => workspace.activeCount() === 0, "queued batch processes should exit");
  // The quote captured when joining the queue must not silently follow fee changes.
  maxConcurrent = 1; holdSms = true;
  const blocker = await start("fee-blocker@example.com");
  await wait(() => workspace.publicJobs().find(row => row.id === blocker && row.smsStatus === "waiting_sms"), "fee blocker should occupy pool");
  const feeWaiter = await start("fee-waiter@example.com");
  await wait(() => workspace.publicJobs().find(row => row.id === feeWaiter && row.smsPoolBilling?.state === "queued"), "fee waiter should queue");
  const numbersBeforeFee = numbers; configuredFee = 3;
  await call(`/api/jobs/${blocker}/cancel`, {});
  await wait(() => workspace.publicJobs().find(row => row.id === feeWaiter && row.smsStatus === "error" && row.smsPoolBilling?.state === "released"), "fee change must pause for reconfirmation");
  assert.match(workspace.publicJobs().find(row => row.id === feeWaiter).smsError, /重新确认/);
  assert.equal(numbers, numbersBeforeFee); await call(`/api/jobs/${feeWaiter}/cancel`, {});
  // Disabling a CDK stops a queued request without creating another reservation.
  configuredFee = 2;
  const disableBlocker = await start("disable-blocker@example.com");
  await wait(() => workspace.publicJobs().find(row => row.id === disableBlocker && row.smsStatus === "waiting_sms"), "disable blocker should occupy pool");
  const disabledWaiter = await start("disabled-waiter@example.com");
  await wait(() => workspace.publicJobs().find(row => row.id === disabledWaiter && row.smsPoolBilling?.state === "queued"), "disabled waiter should queue");
  const beforeDisable = numbers; workspaceEnabled = false;
  await wait(() => workspace.publicJobs().find(row => row.id === disabledWaiter && row.smsPoolBilling?.state === "released"), "disabled CDK must stop waiting");
  assert.equal(numbers, beforeDisable);
  await call(`/api/jobs/${disableBlocker}/cancel`, {});
  await call(`/api/jobs/${disabledWaiter}/cancel`, {});
  workspaceEnabled = true;
  const shutdownBlocker = await start("shutdown-blocker@example.com");
  await wait(() => workspace.publicJobs().find(row => row.id === shutdownBlocker && row.smsStatus === "waiting_sms"), "shutdown blocker should occupy pool");
  const shutdownWaiter = await start("shutdown-waiter@example.com");
  await wait(() => workspace.publicJobs().find(row => row.id === shutdownWaiter && row.smsPoolBilling?.state === "queued"), "shutdown waiter should queue");
  const beforeShutdown = numbers;
  await workspace.shutdown(); workspace = null;
  assert.equal(numbers, beforeShutdown, "shutdown must not buy a queued number after cancellation frees capacity");
  assert.ok([...operations.values()].every(row => ["verified", "released"].includes(row.state)), "shutdown must release all unsubmitted operations");
  console.log("[ok] sms pool console: settlement, evidence, redaction, restart, automatic queue overflow, queued cancellation, fee reconfirmation and disabled-CDK stop");
} finally {
  clearInterval(ticker);
  await workspace?.shutdown();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
}
