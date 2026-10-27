import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createCdkVault } from "../src/cdk-vault.mjs";

process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.SMS_POLL_INTERVAL_MS = "10";
process.env.SMS_POLL_TIMEOUT_MS = "2000";
const { createConsoleWorkspace } = await import("../src/console-server.mjs");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-cdk-sms-routes-"));
const protocolScript = path.join(root, "phone-protocol.mjs");
await fs.writeFile(protocolScript, `import readline from "node:readline/promises";
const rl=readline.createInterface({input:process.stdin,output:process.stdout});
try {await rl.question("Phone number, E.164 format (p=quit): "); await rl.question("Phone OTP (r=resend, p=change phone, q=quit): "); console.log("[ok] Phone OTP validated"); process.exitCode=7;} finally {rl.close();}
`);
const allowed = new Set(["custom"]);
let enabled = false; let numberCalls = 0; let optionCalls = 0; let smsPolls = 0;
let failNextNumber = false; let deliverCode = false; let poolBegins = 0; let poolGets = 0; let poolReleases = 0;
const provider = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture.invalid");
  const action = url.searchParams.get("action"); let value = "BAD_ACTION";
  if (action === "getNumber") {
    numberCalls++;
    if (failNextNumber) { failNextNumber = false; value = "NO_NUMBERS"; }
    else value = `ACCESS_NUMBER:route-order-${numberCalls}:+1202555${String(numberCalls).padStart(4, "0")}`;
  } else if (action === "getStatus") { smsPolls++; value = deliverCode ? "STATUS_OK:123456" : "STATUS_WAIT_CODE"; }
  else if (action === "setStatus") value = ({ "1": "ACCESS_READY", "6": "ACCESS_ACTIVATION", "8": "ACCESS_CANCEL" })[url.searchParams.get("status")] || "BAD_STATUS";
  else if (["getCountries", "getPricesV3", "getTopCountriesByService"].includes(action)) { optionCalls++; value = "{}"; }
  res.writeHead(200, { "content-type": "text/plain" }); res.end(value);
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
process.env.SMSBOWER_API_BASE = `http://127.0.0.1:${provider.address().port}/handler_api.php`;
const vault = await createCdkVault(root);
const pool = { summary: async () => ({ enabled: true, available: true, fee: 2, hasNumbers: false }),
  begin: async () => { poolBegins++; throw Object.assign(new Error("fixture pool busy"), { code: "SMS_POOL_BUSY" }); },
  getNumber: async () => { poolGets++; throw Error("unexpected purchase"); },
  release: async () => { poolReleases++; return { state: "released", reserved: 0, fee: 2 }; },
};
const setup = { id: "smsbower", config: { apiKey: "synthetic-route-key", service: "dr", country: "1", maxPrice: "0.25", providerIds: "1", maxRotationAttempts: "3", rotationIntervalSeconds: "0.1" } };
let workspace;
let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions++; };
const parse = (response) => JSON.parse(response.body.toString());
const dispatch = (method, route, body) => workspace.dispatch(method, route, body);
const blocked = async (action, label) => { await assert.rejects(action, (error) => error.status === 403 && error.code === "SMS_PROVIDER_FORBIDDEN", label); assertions++; };
const until = async (predicate, label) => { const end = Date.now() + 5000; while (Date.now() < end) { const result = await predicate(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 10)); } throw Error(label); };
const job = (id) => workspace.publicJobs().find((row) => row.id === id);
const add = async (email, providerSetup = null) => parse(await dispatch("POST", "/api/jobs", { email, phoneBindingMode: providerSetup ? "automatic" : "manual", ...(providerSetup ? { smsProvider: providerSetup } : {}) })).job;
const cancel = (id) => dispatch("POST", `/api/jobs/${id}/cancel`, {});
try {
  workspace = await createConsoleWorkspace({ root: path.join(root, "workspace"), namespace: "synthetic-route-workspace", cdkId: "synthetic-route-owner",
    credentialVault: vault, rebindVault: vault, offerVault: vault, protocolScript, smsPool: pool,
    smsProviderAllowed: (id) => allowed.has(id), isEnabled: () => enabled, availableSlots: () => 20, requestSchedule() { setImmediate(() => workspace?.tick()); },
    readMonitor: async () => null, writeMonitor: async () => {}, remoteBound: () => false, bindRemote() {}, offerCanUse: () => true });
  const initial = parse(await dispatch("GET", "/api/bootstrap"));
  check(initial.features.smsProviders.map((row) => row.id).join() === "custom", "default workspace only advertises custom SMS");
  check(initial.features.smsPool === undefined, "ungranted pool availability is not returned");
  await blocked(() => dispatch("POST", "/api/sms-providers/smsbower/options", { config: setup.config }), "prices reject an ungranted provider before a request");
  await blocked(() => dispatch("POST", "/api/jobs", { email: "blocked-import@example.invalid", phoneBindingMode: "automatic", smsProvider: setup }), "automatic single import rejects unauthorized SMS");
  await blocked(() => dispatch("POST", "/api/jobs/batch", { text: "blocked-batch@example.invalid", phoneBindingMode: "automatic", smsProvider: setup }), "automatic batch import rejects unauthorized SMS");
  await blocked(async () => workspace.planImport("single", { email: "blocked-plan@example.invalid", phoneBindingMode: "automatic", smsProvider: setup }), "import preview checks provider permission before charging");
  check(numberCalls === 0 && optionCalls === 0 && workspace.publicJobs().length === 0, "forbidden routes do not buy, query or create tasks");

  allowed.add("smsbower");
  const pending = await add("revoked-queued@example.invalid", setup);
  allowed.delete("smsbower"); enabled = true; workspace.resume();
  await until(() => job(pending.id)?.status === "failed", "queued setup should reject after permission revocation");
  check(numberCalls === 0, "queued automatic task checks live permission before launching or buying");
  await blocked(() => dispatch("POST", `/api/jobs/${pending.id}/retry`, {}), "retry cannot reuse a revoked saved provider");
  await blocked(() => dispatch("POST", `/api/jobs/${pending.id}/relogin`, {}), "relogin cannot reuse a revoked saved provider");
  await blocked(() => dispatch("POST", `/api/jobs/${pending.id}/start-phone`, { smsProvider: setup }), "single phone start rejects revoked provider");
  await blocked(() => dispatch("POST", "/api/jobs/start-phone-batch", { ids: [pending.id], smsProvider: setup }), "batch phone start rejects revoked provider");
  await blocked(() => dispatch("POST", `/api/jobs/${pending.id}/sms-number`, { providerId: "smsbower", config: setup.config }), "manual provider-number endpoint rejects revoked provider");
  await blocked(() => dispatch("POST", `/api/jobs/${pending.id}/luban-number`, { apiKey: "synthetic-luban-key", serviceId: "1" }), "legacy provider-number endpoint rejects ungranted provider");

  allowed.add("smsbower"); failNextNumber = true;
  const retried = await add("retry-revoked@example.invalid", setup);
  await until(() => numberCalls === 1, "first local provider request should run");
  allowed.delete("smsbower");
  await until(() => job(retried.id)?.smsStatus === "error", "automatic retry should stop after provider revocation");
  await new Promise((resolve) => setTimeout(resolve, 150));
  check(numberCalls === 1, "revocation prevents an automatic second number purchase");
  check(/未开通/.test(job(retried.id)?.smsError || ""), "stopped acquisition explains the missing permission");
  await cancel(retried.id);

  allowed.add("smsbower"); deliverCode = false;
  const held = await add("held-order@example.invalid", setup);
  await until(() => job(held.id)?.status === "phone_otp", "existing acquired order should reach SMS stage");
  const heldPurchases = numberCalls; allowed.delete("smsbower"); deliverCode = true;
  await until(() => job(held.id)?.phoneVerificationStatus === "verified", "already acquired order should still receive and verify SMS after revocation");
  check(numberCalls === heldPurchases && smsPolls > 0, "held order polling is allowed without buying another number");
  await until(() => !["phone_otp", "working"].includes(job(held.id)?.status), "completed fixture process should exit");

  const manual = parse(await dispatch("POST", "/api/jobs", { email: "manual-phone@example.invalid", phoneBindingEnabled: true })).job;
  await until(() => job(manual.id)?.status === "phone", "manual phone entry should remain available");
  await dispatch("POST", `/api/jobs/${manual.id}/input`, { action: "phone", value: "+12025550999" });
  await until(() => job(manual.id)?.status === "phone_otp", "manual number should reach verification");
  await dispatch("POST", `/api/jobs/${manual.id}/input`, { action: "phone_otp", value: "123456" });
  await until(() => job(manual.id)?.phoneVerificationStatus === "verified", "manual phone verification is independent of provider grants");
  check(numberCalls === heldPurchases, "manual phone input requires no SMS-platform permission and makes no purchase");

  allowed.add("pool");
  const queuedPool = await add("queued-pool@example.invalid", { id: "pool", config: { quotedFee: 2 } });
  await until(() => poolBegins > 0, "pool should wait for a slot"); allowed.delete("pool");
  await until(() => job(queuedPool.id)?.smsStatus === "error", "revoked pool queue should stop");
  check(poolGets === 0 && job(queuedPool.id)?.smsPoolBilling?.reserved === 0, "revoked queued pool does not reserve or buy");
  await cancel(queuedPool.id);
  const updated = parse(await dispatch("GET", "/api/jobs"));
  check(updated.features.allowedSmsProviders.join() === "custom" && updated.features.smsProviders[0].id === "custom", "routine job polling returns current permissions for live UI updates");
  console.log(`[ok] CDK SMS routes: ${assertions} assertions; live permission guards, queued starts, retries, provider/pool acquisition and existing-order continuity; local fixtures only.`);
} finally {
  await workspace?.shutdown(); await new Promise((resolve) => provider.close(resolve));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
