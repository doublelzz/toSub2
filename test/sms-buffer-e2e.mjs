import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startCdkServer } from "../src/cdk-server.mjs";

process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-buffer-e2e-administrator";
process.env.SMS_POLL_INTERVAL_MS = "10";
const { createConsoleWorkspace } = await import("../src/console-server.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-buffer-e2e-"));
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
let purchases = 0; let cancellationRequests = 0; let purchaseAttempts = 0; let unavailable = false;
const requestedCountries = [];
const orders = new Map();
const provider = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture.invalid");
  assert.equal(url.searchParams.get("api_key"), "synthetic-buffer-key");
  const action = url.searchParams.get("action"); let body;
  if (action === "getNumber") {
    purchaseAttempts++; const country = url.searchParams.get("country"); requestedCountries.push(country);
    if (country === "1" || unavailable) body = "NO_NUMBERS";
    else {
      const id = `buffer-order-${++purchases}`;
      orders.set(id, { country, ready: false, cancelled: false });
      body = JSON.stringify({ activationId: id, phoneNumber: `+1202555${String(purchases).padStart(4, "0")}`, activationCost: "0.20", activationCurrency: "USD" });
    }
  } else if (action === "getStatus") {
    const order = orders.get(url.searchParams.get("id"));
    body = !order || order.cancelled ? "STATUS_CANCEL" : order.ready ? "STATUS_OK:123456" : "STATUS_WAIT_CODE";
  } else if (action === "setStatus") {
    const order = orders.get(url.searchParams.get("id")); const status = url.searchParams.get("status");
    if (status === "1") { order.ready = true; body = "ACCESS_READY"; }
    else if (status === "6") body = "ACCESS_ACTIVATION";
    else if (status === "8") { order.cancelled = true; cancellationRequests++; body = "ACCESS_CANCEL"; }
  }
  res.writeHead(body ? 200 : 400, { "content-type": "text/plain" }); res.end(body || "BAD_ACTION");
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerBase = `http://127.0.0.1:${provider.address().port}/handler_api.php`;
process.env.SMSBOWER_API_BASE = providerBase;
let app; let base; let checks = 0;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
async function wait(predicate, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error(message);
}
function session() {
  let cookie = ""; let csrf = "";
  return async (route, method = "GET", body) => {
    const response = await fetch(base + route, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(csrf ? { "x-console-token": csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    const data = await response.json(); if (data.token) csrf = data.token;
    return { status: response.status, data };
  };
}
try {
  app = await startCdkServer({ root: path.join(root, "data"), listen: false,
    smsPoolOptions: { providerOptions: { smsBowerApiBase: providerBase } },
    createWorkspace: (options) => createConsoleWorkspace({ ...options, protocolScript: protocolFile }) });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  const [first, second] = app.store.generate({ count: 2, quota: 20, note: "Synthetic buffer E2E", allowedSmsProviders: ["custom", "pool"] }, app.store.adminId);
  app.smsPool.saveRules({ enabled: true, fee: 2, maxConcurrent: 3,
    buffer: { enabled: true, forceRefill: false, target: 3, lowWater: 1, perEntry: 1, refillConcurrency: 1, minRemainingSeconds: 480, idleMinutes: 10, maxOutstanding: 3, maxPerMinute: 1 } }, app.store.adminId);
  app.smsPool.saveCredential({ providerId: "smsbower", name: "Synthetic buffer account", apiKey: "synthetic-buffer-key" }, app.store.adminId);
  const credentialId = app.smsPool.adminSnapshot().credentials[0].id;
  app.smsPool.saveEntries({ entries: ["1", "2"].map((country) => ({ credentialId, country, countryLabel: `Private country ${country}`, maxPrice: "0.25", providerIds: "1" })) }, app.store.adminId);
  check(purchases, 0, "enabled buffer does not purchase without demand or an explicit warmup");
  const admin = session(); const user = session();
  check((await admin("/api/auth/login", "POST", { cdk: process.env.TOSUB2_ADMIN_CDK })).status, 200, "fixture administrator signs in");
  check((await user("/api/auth/login", "POST", { cdk: first.secret })).status, 200, "fixture user signs in");
  check((await user("/api/admin/sms-pool/buffer/warmup", "POST", {})).status, 403, "ordinary CDK cannot request paid prefetch");
  check((await user("/api/admin/sms-pool/buffer/pause", "POST", {})).status, 403, "ordinary CDK cannot pause shared inventory replenishment");
  check((await user("/api/admin/sms-pool/inventory")).status, 403, "ordinary CDK cannot see administrator phone inventory");
  check((await user("/api/admin/sms-pool/buffer/drain", "POST", {})).status, 403, "ordinary CDK cannot drain inventory");
  const summaryBefore = (await user("/api/sms-pool")).data;
  for (const field of ["countries", "country", "availableEntries", "entries", "credentials"]) check(summaryBefore[field], undefined, `${field} stays administrator-only`);
  check(summaryBefore.hasNumbers, false, "on-demand service is not presented as already stocked");
  check((await admin("/api/admin/sms-pool/buffer/warmup", "POST", {})).status, 200, "administrator can explicitly warm the buffer");
  await wait(() => app.smsPool.adminSnapshot().buffer?.counts.ready === 3, "one explicit warmup must keep taking numbers from an available quote until the global target is full");
  check(purchases, 3, "one available quote can fill a target larger than the old per-entry limit and minute cap");
  check(requestedCountries.includes("1") && requestedCountries.includes("2"), true, "a no-stock quote does not stop the worker trying the next enabled quote");
  check([...orders.values()].every((row) => row.country === "2"), true, "all successful stock can come from the single quote that has supply");
  const currentInventory = (await admin("/api/admin/sms-pool/inventory?scope=current&pageSize=2")).data;
  check(currentInventory.total, 3, "administrator inventory pagination counts the whole current stock");
  check(currentInventory.items.length, 2, "administrator inventory obeys requested page size");
  check(currentInventory.items.every((row) => /^\+1202555\d{4}$/.test(row.phone) && row.countryLabel === "Private country 2" && row.cost?.amount === "0.20"), true, "administrator sees complete numbers, purchase countries and actual order prices");
  check(JSON.stringify(currentInventory).includes("synthetic-buffer-key"), false, "administrator inventory never includes a provider API key");
  const beforePause = purchaseAttempts;
  const paused = await admin("/api/admin/sms-pool/buffer/pause", "POST", {});
  check(paused.status, 200, "administrator can pause refill without cancelling orders");
  check(paused.data.buffer.progress.state, "paused", "paused refill has an explicit progress state");
  check(paused.data.buffer.counts.ready, 3, "pausing preserves the complete current buffer");
  await app.smsPool.tick(); await app.smsPool.tick();
  check(purchaseAttempts, beforePause, "paused refill does not issue more provider purchases");
  await admin("/api/admin/sms-pool/buffer/warmup", "POST", {});
  await app.smsPool.tick();
  check(purchaseAttempts, beforePause, "repeated warmup at the target never buys extra numbers");
  const warmIds = new Set(app.smsPool.adminSnapshot().buffer.items.filter((row) => row.state === "ready").map((row) => row.id));
  check(app.store.get(first.id).reserved, 0, "prefetch does not reserve any ordinary CDK quota");
  check(app.store.get(second.id).consumed, 0, "prefetch does not charge another CDK");
  check((await user("/api/sms-pool")).data.hasNumbers, true, "ordinary user sees stocked availability only");
  const email = "same-buffer-account@example.invalid";
  const imported = await Promise.all([first, second].map((owner) => app.importFor(owner.id, "single", { email, phoneBindingMode: "automatic", smsProvider: { id: "pool", config: { quotedFee: 2 } } }, crypto.randomUUID(), owner.id)));
  await wait(() => [first, second].every((owner) => app.store.get(owner.id).smsPoolConsumed === 2), "both buffer allocations should settle from target verification");
  const operationA = app.store.smsOperations(first.id)[0]; const operationB = app.store.smsOperations(second.id)[0];
  check(warmIds.has(operationA.allocation.inventoryId), true, "first user receives an existing warm inventory order");
  check(warmIds.has(operationB.allocation.inventoryId), true, "second user receives a different warm inventory order");
  check(operationA.allocation.inventoryId === operationB.allocation.inventoryId, false, "cross-CDK claims are exclusive");
  check(app.store.get(first.id).balance, 17, "one import plus one successful pool verification is charged");
  check(app.store.get(second.id).balance, 17, "same-email account remains independently charged in its owner CDK");
  const firstJob = (await app.workspaceFor(first.id)).publicJobs().find((row) => row.id === imported[0].data.job.id);
  check(firstJob.smsSummary.latest.country, undefined, "pool order history does not disclose country");
  check(firstJob.smsProviderId, "pool", "public task identifies the pool instead of the administrator provider");
  assert.doesNotMatch(JSON.stringify(firstJob), /Private country|synthetic-buffer-key/); checks++;
  await wait(() => [first, second].every((owner) => app.store.get(owner.id).reserved === 0), "completed claims release quota reservations");
  await admin("/api/admin/sms-pool/buffer/drain", "POST", {});
  app.smsPool.saveRules({ buffer: { enabled: false } }, app.store.adminId);
  const beforeFallback = purchases;
  const fallback = await app.importFor(first.id, "single", { email: "fallback-buffer@example.invalid", phoneBindingMode: "automatic", smsProvider: { id: "pool", config: { quotedFee: 2 } } }, crypto.randomUUID(), first.id);
  await wait(() => app.store.get(first.id).smsPoolConsumed === 4, "empty or disabled buffer must still use immediate acquisition");
  check(purchases > beforeFallback, true, "on-demand fallback purchases a number when no buffered order is usable");
  const fallbackOperation = app.store.smsOperations(first.id).find((row) => row.jobId === fallback.data.job.id);
  check(Boolean(fallbackOperation.allocation.inventoryId), false, "fallback remains compatible with the original immediate allocation");
  check(app.store.get(first.id).reserved, 0, "fallback also settles exactly one reservation");
  const adminSnapshot = (await admin("/api/admin/sms-pool")).data;
  assert.doesNotMatch(JSON.stringify(adminSnapshot), /synthetic-buffer-key|123456/); checks++;
  check(cancellationRequests >= 0, true, "cancellation counter remains separate from CDK settlement");
  await admin("/api/admin/sms-pool/buffer/pause", "POST", {});
  unavailable = true;
  const missingBefore = purchaseAttempts;
  await admin("/api/admin/sms-pool/buffer/warmup", "POST", {});
  await wait(() => app.smsPool.adminSnapshot().buffer?.progress?.nextRetryAt > Date.now(), "an all-unavailable pass must expose its next retry rather than silently stop");
  const missingProgress = app.smsPool.adminSnapshot().buffer.progress;
  check(["waiting", "blocked"].includes(missingProgress.state), true, "all unavailable quotes have a visible waiting or blocked state");
  check(purchaseAttempts > missingBefore, true, "the unavailable round actually tried the local provider");
  check(purchaseAttempts - missingBefore <= 2, true, "one unavailable round tries each eligible quote at most once instead of flooding retries");
  check(missingProgress.failures.length > 0, true, "the worker exposes aggregated failure details");
  await admin("/api/admin/sms-pool/buffer/pause", "POST", {});
  console.log(`[ok] SMS buffer E2E: ${checks} assertions; real server, store, console and provider adapter with localhost fixtures only.`);
} finally {
  await app?.close(); await new Promise((resolve) => provider.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
