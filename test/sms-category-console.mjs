import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.SMS_POLL_INTERVAL_MS = "20";
const { createConsoleWorkspace } = await import("../src/console-server.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-category-console-"));
const protocolScript = path.join(root, "phone-fixture.mjs");
await fs.writeFile(protocolScript, `import readline from 'node:readline/promises';
const rl=readline.createInterface({input:process.stdin,output:process.stdout});
try { await rl.question('Phone number, E.164 format (p=quit): '); await new Promise(resolve=>setTimeout(resolve,50)); await rl.question('Phone number, E.164 format (p=quit): '); await rl.question('Phone OTP (r=resend, p=change phone, q=quit): '); } finally {rl.close();}
`);
const categories = [{ id: "us", name: "美区", enabled: true, fee: 5, feeVersion: 2 }, { id: "other", name: "其他", enabled: true, fee: 2, feeVersion: 1 }];
const rows = new Map(); let purchases = 0; let workspace;
const billing = (row) => ({ operationId: row.operationId, state: row.state, fee: row.expectedFee, reserved: row.state === "released" ? 0 : row.expectedFee,
  categoryId: row.categoryId, categoryName: categories.find((value) => value.id === row.categoryId).name, categoryFeeVersion: row.feeVersion, maxAttempts: 3 });
const smsPool = {
  summary(id) { return id ? categories.find((value) => value.id === id) : { enabled: true, categories }; },
  begin(input) { const row = { ...input, state: "reserved" }; rows.set(input.operationId, row); return billing(row); },
  getNumber({ operationId }) { const row = rows.get(operationId); purchases++; row.state = "allocated"; row.allocation = { allocationId: crypto.randomUUID(), providerId: "smsbower", order: { requestId: `console-category-${purchases}`, number: "+12025550123" }, config: {},
    client: { name: "Fixture provider", getSms: async () => ({ status: "waiting" }), release: async () => true } }; return row.allocation; },
  abandon({ operationId }) { const row = rows.get(operationId); row.state = "reserved"; row.allocation = null; return billing(row); },
  release({ operationId }) { const row = rows.get(operationId); row.state = "released"; return billing(row); },
  recover(operationId) { const row = rows.get(operationId); return { ...billing(row), runId: row.runId, jobId: row.jobId, allocation: row.allocation }; },
};
const vault = { seal: (value) => JSON.stringify(value), open: (value) => JSON.parse(value) };
const options = { root: path.join(root, "workspace"), namespace: "category-console-fixture", cdkId: "fixture-owner", smsPool, protocolScript,
  rebindVault: vault, offerVault: vault, offerCanUse: () => true, isEnabled: () => true, availableSlots: () => 20, requestSchedule() { queueMicrotask(() => workspace?.tick()); }, readMonitor: async () => null };
const call = (route, body) => workspace.dispatch(body ? "POST" : "GET", route, body);
const wait = async (fn) => { const until = Date.now() + 5000; while (Date.now() < until) { const value = fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error(`fixture condition timed out: ${JSON.stringify(workspace.publicJobs())}`); };
const timer = setInterval(() => workspace?.tick(), 20);
try {
  workspace = await createConsoleWorkspace(options);
  await assert.rejects(call("/api/jobs", { email: "missing-category@example.invalid", phoneBindingMode: "automatic", smsProvider: { id: "pool", config: { quotedFee: 2 } } }), /分类/);
  const created = JSON.parse((await call("/api/jobs", { email: "category-console@example.invalid", phoneBindingMode: "automatic", smsProvider: { id: "pool", config: { categoryId: "us", quotedFee: 5, feeVersion: 2 } } })).body.toString()).job;
  workspace.resume();
  const active = await wait(() => workspace.publicJobs().find((row) => row.id === created.id && row.status === "phone" && row.smsNumberAttempt === 1));
  assert.equal(active.smsPoolBilling.categoryId, "us"); assert.equal(active.smsPoolBilling.categoryName, "美区"); assert.equal(active.smsPoolBilling.fee, 5);
  const before = purchases;
  await assert.rejects(call(`/api/jobs/${created.id}/sms-number`, { providerId: "pool", config: { categoryId: "other", quotedFee: 2, feeVersion: 1 } }), (error) => error.status === 409 && /分类/.test(error.message));
  assert.equal(purchases, before); assert.equal(rows.get(active.smsPoolBilling.operationId).state, "allocated", "rejected category changes do not abandon an existing allocation");
  const metadata = JSON.parse(await fs.readFile(path.join(options.root, created.id, "job-meta.json"), "utf8"));
  assert.equal(metadata.sms_pool_category_id, "us"); assert.equal(metadata.sms_pool_fee_version, 2); assert.equal(metadata.sms_pool_billing.categoryName, "美区");
  await call(`/api/jobs/${created.id}/cancel`, {}); await workspace.shutdown(); workspace = null;
  // This persisted pre-upgrade setup has no category. Its only migration path
  // is a saved task read, never a new HTTP import.
  const saved = JSON.parse(await fs.readFile(path.join(options.root, created.id, "sms-provider.json"), "utf8"));
  delete saved.config.categoryId; delete saved.config.feeVersion;
  await fs.writeFile(path.join(options.root, created.id, "sms-provider.json"), JSON.stringify(saved));
  workspace = await createConsoleWorkspace(options); workspace.resume();
  await call(`/api/jobs/${created.id}/retry`, {});
  await wait(() => { try { return workspace.publicJobs().find((row) => row.id === created.id && ["phone", "phone_otp"].includes(row.status)); } catch { return false; } });
  const upgraded = JSON.parse(await fs.readFile(path.join(options.root, created.id, "sms-provider.json"), "utf8")); assert.equal(upgraded.config.categoryId, "other");
  console.log("[ok] SMS category console: explicit HTTP selection, category/fee persistence, rejected active-operation switches and saved-task compatibility");
} finally { clearInterval(timer); await workspace?.shutdown(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
