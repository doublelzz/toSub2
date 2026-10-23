import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createConsoleWorkspace } from "../src/console-server.mjs";
import { startCdkServer } from "../src/cdk-server.mjs";
import { createCredentialStore } from "../src/credential-store.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-cdk-console-"));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "test-administrator-cdk-integration-only";
process.env.TOSUB2_TRUSTED_PROXIES = "127.0.0.1";
process.env.LOCALAPPDATA = path.join(root, "os-credentials");
process.env.ONBOARDING_PROTOCOL_SCRIPT = path.join(project, "test", "mock-queue-protocol.mjs");
const legacyId = "22222222-2222-4222-8222-222222222222";
if (["win32", "darwin"].includes(process.platform)) {
  const previousCredentials = createCredentialStore();
  await previousCredentials.save("legacy-only@example.com", { password: "synthetic-legacy-only" });
  await fs.mkdir(path.join(root, legacyId));
  await fs.writeFile(path.join(root, legacyId, "job-meta.json"), JSON.stringify({ version: 1, email: "legacy-only@example.com", status: "canceled", login_mode: "password", has_stored_credentials: true, has_password: true, has_totp_key: false }));
}
let app;
let base;
let assertions = 0;
let failRecovery = false;

function client(ip) {
  let cookie = ""; let csrf = "";
  return {
    async call(url, method = "GET", body, extra = {}) {
      const response = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(cookie ? { cookie } : {}), ...(csrf ? { "x-console-token": csrf } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
      const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
      if (response.ok && data.token) csrf = data.token;
      return { status: response.status, data };
    },
    token: () => csrf,
  };
}

function equal(actual, expected, name) { assert.deepEqual(actual, expected, name); assertions += 1; }
async function start() {
  app = await startCdkServer({ createWorkspace: async (options) => {
    const workspace = await createConsoleWorkspace(options); const apply = workspace.applyImport;
    workspace.applyImport = async (mode, body) => { if (failRecovery && body.email === "recoverable@example.com") throw new Error("Synthetic interrupted recovery"); return apply(mode, body); };
    return workspace;
  }, root, listen: false });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
}

try {
  await start();
  await assert.rejects(startCdkServer({ createWorkspace: createConsoleWorkspace, root, listen: false }), /已有控制台/); assertions += 1;
  const anonymous = client("198.51.100.1"); const admin = client("198.51.100.2");
  equal((await anonymous.call("/api/bootstrap")).data.authenticated, false, "bootstrap does not issue public credentials");
  equal((await anonymous.call("/api/jobs")).status, 401, "anonymous task request rejected");
  equal((await anonymous.call("/api/cdk/reveal", "POST", {})).status, 401, "anonymous CDK reveal rejected");
  equal((await anonymous.call("/src/console-server.mjs")).status, 404, "runtime source is never served");
  const login = await admin.call("/api/auth/login", "POST", { cdk: process.env.TOSUB2_ADMIN_CDK });
  equal(login.status, 200, "admin login");
  const adminId = login.data.account.id;
  if (["win32", "darwin"].includes(process.platform)) {
    const initialLegacy = await admin.call("/api/jobs/export-source", "POST", { ids: [legacyId] });
    equal(initialLegacy.status, 200, `historical credential export: ${typeof initialLegacy.data === "object" ? JSON.stringify(initialLegacy.data) : "text"}`);
    assert.ok(initialLegacy.data.includes("synthetic-legacy-only")); assertions += 1;
    equal(app.store.legacyUsed(adminId, "legacy-only@example.com"), true, "legacy credential migration is recorded durably");
    await admin.call("/api/jobs/delete-batch", "POST", { ids: [legacyId] });
    const restoredLegacy = await admin.call("/api/jobs", "POST", { email: "legacy-only@example.com" }, { "idempotency-key": "restore-legacy-without-password" });
    equal(restoredLegacy.status, 201, "deleted historical account can be recreated without secrets");
    const restoredSource = await admin.call("/api/jobs/export-source", "POST", { ids: [restoredLegacy.data.job.id] });
    equal(restoredSource.data.includes("synthetic-legacy-only"), false, "deleted historical secrets are never restored from old global fallback");
  }
  const generated = await admin.call("/api/admin/cdks", "POST", { count: 3, quota: 2, note: "integration fixtures" });
  equal(generated.status, 201, "admin generates ordinary keys");
  const [keyA, keyB, keySource] = generated.data.items;
  const ownerA = client("198.51.100.10"); const ownerB = client("198.51.100.11"); const source = client("198.51.100.12");
  equal((await ownerA.call("/api/auth/login", "POST", { cdk: keyA.secret })).status, 200, "first tenant login");
  await ownerB.call("/api/auth/login", "POST", { cdk: keyB.secret });
  await source.call("/api/auth/login", "POST", { cdk: keySource.secret });
  equal((await ownerA.call("/api/cdk/reveal", "POST", {})).data.secret, keyA.secret, "ordinary user can reveal own current CDK");
  equal((await ownerA.call("/api/cdk/reveal", "POST", { cdkId: keyB.id })).data.secret, keyA.secret, "CDK reveal ignores forged owner IDs");
  equal((await ownerA.call("/api/cdk/reveal", "POST", {}, { "x-console-token": "invalid-token" })).status, 403, "reveal requires scope and CSRF token");
  equal(JSON.stringify((await ownerA.call("/api/auth/me")).data).includes(keyA.secret), false, "bootstrap never includes recoverable CDK");
  app.store.saveSetting(keyA.id, "login-secret", null);
  equal((await ownerA.call("/api/cdk/reveal", "POST", {})).data.code, "CDK_SECRET_UNAVAILABLE", "old hash-only key cannot be fabricated");
  equal((await ownerA.call("/api/cdk/reveal", "POST", { cdk: keyB.secret })).status, 400, "another valid key cannot fill current secret");
  equal((await ownerA.call("/api/cdk/reveal", "POST", { cdk: keyA.secret })).data.secret, keyA.secret, "current old key can be verified without logout");
  app.store.saveSetting(keyB.id, "login-secret", null);
  await ownerB.call("/api/auth/login", "POST", { cdk: keyB.secret });
  equal((await ownerB.call("/api/cdk/reveal", "POST", {})).data.secret, keyB.secret, "relogin backfills a hash-only key");
  equal((await ownerA.call("/api/admin/cdks")).status, 403, "ordinary user cannot administer");
  equal((await ownerA.call("/api/auth/workspace", "POST", { cdkId: keyB.id })).status, 403, "ordinary user cannot switch tenants");
  const payloadA = { email: "joint@example.com", password: "synthetic-password-A", phoneBindingMode: "manual" };
  const createdA = await ownerA.call("/api/jobs", "POST", payloadA, { "idempotency-key": "first-a" });
  equal(createdA.status, 201, "first owner imports");
  const jobA = createdA.data.job;
  equal((await ownerA.call("/api/auth/me")).data.workspace.balance, 1, "new account debits once");
  equal((await ownerB.call("/api/auth/me")).data.workspace.balance, 2, "other balance unchanged");
  const createdB = await ownerB.call("/api/jobs", "POST", { ...payloadA, password: "synthetic-password-B" }, { "idempotency-key": "first-b" });
  equal(createdB.status, 201, "same email is independent in another tenant");
  const jobB = createdB.data.job;
  equal((await ownerA.call(`/api/jobs/${jobB.id}`)).status, 404, "cross-tenant detail rejected");
  equal((await ownerB.call(`/api/jobs/${jobA.id}/logs`)).status, 404, "cross-tenant logs rejected");
  equal((await ownerB.call("/api/jobs/delete-batch", "POST", { ids: [jobA.id, jobB.id] })).status, 404, "mixed-tenant batch rejected without partial deletion");
  equal((await ownerB.call("/api/jobs")).data.pagination.totalAll, 1, "selection and counts scoped");
  const exportedA = await ownerA.call("/api/jobs/export-source", "POST", { ids: [jobA.id] });
  equal(exportedA.status, 200, "own source export available");
  assert.ok(exportedA.data.includes("synthetic-password-A") && !exportedA.data.includes("synthetic-password-B")); assertions += 1;
  equal((await ownerA.call("/api/jobs", "POST", payloadA, { "idempotency-key": "first-a" })).status, 201, "idempotent retry succeeds even while original task is active");
  equal((await ownerA.call("/api/auth/me")).data.workspace.consumed, 1, "retry does not consume again");
  await ownerA.call(`/api/jobs/${jobA.id}/cancel`, "POST", {});
  const mfa = await ownerA.call("/api/mfa/import", "POST", { text: "joint@example.com----synthetic-password-A" }, { "idempotency-key": "mfa-existing" });
  equal(mfa.status, 200, "existing authorization account enters MFA workspace");
  equal((await ownerA.call("/api/auth/me")).data.workspace.balance, 1, "cross-workspace import is free");
  equal((await ownerB.call("/api/mfa/accounts")).data.accounts.length, 0, "MFA records isolated");
  const settingsKey = "chatgpt-onboarding.sms-provider-settings-v1";
  const saved = await ownerA.call("/api/settings/workspace", "PUT", { workspaceId: keyA.id, settings: { [settingsKey]: JSON.stringify({ apiKey: "synthetic-settings-secret" }) } });
  equal(saved.status, 200, "own settings saved");
  equal((await ownerB.call("/api/settings/workspace")).data.settings[settingsKey], undefined, "settings not shared");
  equal((await ownerA.call("/api/settings/workspace", "PUT", { workspaceId: keyB.id, settings: {} })).status, 409, "stale or forged settings scope rejected");
  equal((await ownerA.call("/api/settings/workspace", "PUT", { workspaceId: keyA.id, settings: {} }, { "x-console-token": "é".repeat(ownerA.token().length) })).status, 403, "malformed CSRF token rejected without server exception");
  const limitedKey = (await admin.call("/api/admin/cdks", "POST", { count: 1, quota: 1, note: "single-credit fixture" })).data.items[0];
  const limited = client("198.51.100.15"); await limited.call("/api/auth/login", "POST", { cdk: limitedKey.secret });
  const competing = await Promise.all(["one@example.com", "two@example.com"].map((email, index) => limited.call("/api/jobs", "POST", { email }, { "idempotency-key": `limited-${index}` })));
  equal(competing.map((response) => response.status).sort(), [201, 409], "concurrent last-credit imports cannot overspend");
  equal((await limited.call("/api/auth/me")).data.workspace.balance, 0, "last credit consumed exactly once");
  const existingEmail = competing.find((response) => response.status === 201).data.job.email;
  equal((await limited.call("/api/jobs", "POST", { email: existingEmail }, { "idempotency-key": "limited-update" })).status, 200, "zero-credit active existing account update remains available");
  const oldCsrf = admin.token();
  const switched = await admin.call("/api/auth/workspace", "POST", { cdkId: keyA.id });
  equal(switched.data.workspace.id, keyA.id, "administrator can enter ordinary workspace");
  equal((await admin.call("/api/cdk/reveal", "POST", {})).data.secret, keyA.secret, "administrator sees explicitly selected workspace key");
  equal((await admin.call("/api/jobs")).data.jobs[0].id, jobA.id, "administrator ordinary view uses correct scope");
  equal((await admin.call("/api/settings/workspace", "PUT", { workspaceId: keyA.id, settings: {} }, { "x-console-token": oldCsrf })).status, 403, "workspace switch invalidates old write token");
  await admin.call("/api/auth/workspace", "POST", { cdkId: adminId });
  equal((await ownerA.call("/api/jobs/delete-batch", "POST", { ids: [jobA.id, "missing-job"] })).status, 404, "failed deletion does not change inventory");
  equal((await ownerA.call("/api/auth/me")).data.workspace.accounts, 1, "failed deletion preserves account count");
  equal((await ownerA.call("/api/jobs/delete-batch", "POST", { ids: [jobA.id] })).status, 200, "authorization record can be removed");
  equal((await ownerA.call("/api/auth/me")).data.workspace.accounts, 1, "MFA record keeps shared account inventory alive");
  const quote = await ownerA.call("/api/cdk/merge-preview", "POST", { sourceCdk: keySource.secret });
  equal(quote.status, 200, "logged-in unused source can merge");
  const mergeBody = { sourceCdk: keySource.secret, fingerprint: quote.data.fingerprint, amount: quote.data.amount, requestKey: "merge-source" };
  equal((await ownerA.call("/api/cdk/merge", "POST", mergeBody)).data.cdk.balance, 3, "merge transfers all credits");
  equal((await ownerA.call("/api/cdk/merge", "POST", mergeBody)).data.cdk.balance, 3, "merge retry does not transfer twice");
  equal((await source.call("/api/jobs")).status, 401, "merged source session revoked");
  equal((await ownerB.call("/api/cdk/merge-preview", "POST", { sourceCdk: keyA.secret })).status, 409, "used source cannot merge");
  const topupBody = { amount: 4, note: "synthetic topup", requestKey: "topup-a" };
  await admin.call(`/api/admin/cdks/${keyA.id}/topups`, "POST", topupBody);
  await admin.call(`/api/admin/cdks/${keyA.id}/topups`, "POST", topupBody);
  equal((await ownerA.call("/api/auth/me")).data.workspace.balance, 7, "top-up idempotent");
  equal((await ownerA.call("/api/jobs/cancel-all", "POST", {})).status, 200, "stop-own operates");
  equal((await ownerB.call("/api/jobs")).data.pagination.totalAll, 1, "stop-own preserves other tenant");
  equal((await ownerA.call("/api/jobs", "POST", { email: "origin@example.com" }, { "origin": "https://untrusted.invalid", "idempotency-key": "bad-origin" })).status, 403, "cross-origin write rejected");
  const invalid = client("203.0.113.25");
  for (let index = 0; index < 10; index += 1) {
    const response = await invalid.call("/api/auth/login", "POST", { cdk: "incorrect-synthetic-secret-only" });
    equal(response.status, index === 9 ? 403 : 401, "failed verification counted and tenth blocked");
  }
  equal((await invalid.call("/api/bootstrap")).data.code, "IP_BLOCKED", "ban enforced for anonymous bootstrap");
  const blocks = (await admin.call("/api/admin/security/ip-bans")).data.items;
  const block = blocks.find((item) => item.ip === "203.0.113.25"); assert.ok(block?.active); assertions += 1;
  equal((await admin.call("/api/admin/security/events")).data.items.some((item) => item.ip === "203.0.113.25" && item.unread), true, "administrator alerted");
  await admin.call(`/api/admin/security/ip-bans/${block.id}/revoke`, "POST", {});
  equal((await invalid.call("/api/bootstrap")).status, 200, "administrator can remove ban");
  await admin.call("/api/auth/workspace", "POST", { cdkId: keyA.id });
  const disabledScopeToken = admin.token();
  await admin.call(`/api/admin/cdks/${keyA.id}`, "PATCH", { status: "disabled" });
  equal((await admin.call("/api/jobs", "GET", undefined, { "x-console-token": disabledScopeToken })).status, 403, "stale scoped GET cannot return fallback workspace data");
  const reloadedAdmin = await admin.call("/api/bootstrap");
  equal(reloadedAdmin.data.workspace.id, adminId, "bootstrap explicitly reloads administrator fallback scope");
  equal((await ownerA.call("/api/auth/me")).status, 401, "disabled user session revoked");
  const recoverable = app.store.generate({ count: 1, quota: 2, note: "recovery fixture" }, adminId)[0];
  const recoveryBody = { email: "recoverable@example.com", password: "synthetic-recovery-only" };
  const pendingImport = app.store.prepareImport(recoverable.id, "single", [recoveryBody.email], recoveryBody, "pending-recovery");
  const recoveringWorkspace = await app.workspaceFor(recoverable.id); recoveringWorkspace.pause(); await recoveringWorkspace.applyImport("single", recoveryBody);
  equal(app.store.get(recoverable.id).reserved, 1, "prepared import retains reservation before finalization");
  equal(pendingImport.payload.includes("synthetic-recovery-only"), false, "durable recovery payload is encrypted");
  await app.close(); failRecovery = true; await start();
  const restartedAdmin = client("198.51.100.2"); await restartedAdmin.call("/api/auth/login", "POST", { cdk: process.env.TOSUB2_ADMIN_CDK });
  const afterRestart = (await restartedAdmin.call("/api/admin/cdks")).data.items;
  equal(afterRestart.find((item) => item.id === keyA.id).balance, 7, "balance persists after restart");
  equal(afterRestart.find((item) => item.id === keySource.id).status, "merged", "source terminal state persists");
  const recoveryUser = client("198.51.100.20"); await recoveryUser.call("/api/auth/login", "POST", { cdk: recoverable.secret });
  equal((await recoveryUser.call("/api/jobs", "POST", { email: "new-during-recovery@example.com" }, { "idempotency-key": "new-bypassing-recovery" })).status, 409, "pending recovery rejects a different import request key");
  equal((await recoveryUser.call("/api/jobs", "POST", { ...recoveryBody, password: "changed" }, { "idempotency-key": "pending-recovery" })).status, 409, "pending replay rejects changed content");
  equal(app.store.get(recoverable.id).consumed, 0, "failed recovery and new request do not add a debit");
  equal(app.store.get(recoverable.id).reserved, 1, "blocked new import preserves original reservation");
  failRecovery = false;
  equal((await restartedAdmin.call(`/api/admin/imports/${pendingImport.id}/retry`, "POST", {})).status, 200, "administrator retries exactly the pending import");
  equal(app.store.get(recoverable.id).balance, 1, "prepared import reconciles after explicit recovery");
  equal(app.store.get(recoverable.id).consumed, 1, "recovery charges exactly once");
  equal(app.store.pendingImports().length, 0, "reconciled recovery clears pending outbox");
  equal((await recoveryUser.call("/api/jobs", "POST", { email: "new-after-recovery@example.com" }, { "idempotency-key": "new-after-recovery" })).status, 201, "new imports resume only after recovery completes");
  console.log(`cdk console passed (${assertions} assertions; authentication, scope, joint accounts, charging, MFA flow, merge, config, CSRF, bans, restart)`);
} finally {
  await app?.close(); await fs.rm(root, { recursive: true, force: true });
}
