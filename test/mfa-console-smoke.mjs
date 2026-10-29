import assert from "node:assert/strict";
import "./console-auth.mjs";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { storedFiles } from "./stored-files.mjs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCredentialStore } from "../src/credential-store.mjs";

// These HTTP tests use synthetic accounts, isolated output, and a local protocol fixture.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-mfa-http-"));
const id = crypto.randomUUID();
const email = `mfa-http-${id}@example.com`;
const queuedEmail = `mfa-queued-${id}@example.com`;
const password = "Fixture-password-4826!";
const oldSecret = "JBSWY3DPEHPK3PXP";
const newSecret = "NB2W45DFOIZAQWER";
const jobDir = path.join(root, id);
const protocolScript = path.join(root, "mock-mfa.mjs");
await fs.mkdir(jobDir);
await fs.writeFile(path.join(jobDir, "sub2api-import-oauth.json"), JSON.stringify({
  type: "sub2api-data", version: 1, accounts: [{ credentials: { email } }],
}));
await fs.writeFile(path.join(jobDir, "job-meta.json"), JSON.stringify({
  version: 1, email, status: "completed", result_saved: true, login_mode: "email_otp",
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
}));
await fs.writeFile(protocolScript, `
import fs from ${JSON.stringify(new URL("../src/workspace-storage.mjs", import.meta.url).href)};
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
if (process.argv.includes('--logout-all')) {
  console.log('[mfa-stage] logout_requested');
  console.error('< POST /backend-api/accounts/logout_all 200');
  if (!process.argv.includes('--mfa-session') || process.env.CHATGPT_TOTP_SECRET || process.env.CHATGPT_LOGIN_PASSWORD) process.exit(98);
  const session = JSON.parse(await fs.readFile(arg('--mfa-session'), 'utf8'));
  if (session.email !== arg('--email') || !session.accessToken) process.exit(97);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await fs.writeFile(arg('--logout-result'), JSON.stringify({
    version:1, mode:'logout_all', email:arg('--email'), attempt_id:arg('--logout-attempt'),
    logout_succeeded:true, logout_at:new Date().toISOString(), stage:'logout_confirmed',
  }));
  process.exit(0);
}
if (!process.argv.includes('--rotate-totp')) process.exit(99);
if (process.argv.includes('--mfa-session')) {
  if (process.env.CHATGPT_LOGIN_PASSWORD || process.env.CHATGPT_TOTP_SECRET) process.exit(96);
  const session = JSON.parse(await fs.readFile(arg('--mfa-session'), 'utf8'));
  if (session.email !== arg('--email') || !session.accessToken) process.exit(95);
  console.log('[reuse-only] Existing authorization; no login credentials supplied');
}
await fs.writeFile(arg('--mfa-session-output'), JSON.stringify({type:'chatgpt-session',version:1,email:arg('--email'),accessToken:'synthetic-saved-session',accountId:'fixture-account',expiresAt:'2099-01-01T00:00:00Z'}));
console.log('[mfa-stage] authenticated');
console.error('< GET /api/auth/session 200');
process.stdout.write('credential fragment: ' + process.env.CHATGPT_LOGIN_PASSWORD.slice(0, 7));
await new Promise((resolve) => setTimeout(resolve, 30));
console.log(process.env.CHATGPT_LOGIN_PASSWORD.slice(7));
console.log('secret="' + process.env.CHATGPT_TOTP_SECRET + '"');
console.log('access_token="synthetic-private-token"');
console.log('Cookie: synthetic-private-cookie');
console.log('[mfa-stage] activating');
await new Promise((resolve) => setTimeout(resolve, 1600));
await fs.writeFile(arg('--totp-result'), JSON.stringify({
  version: 1, email: arg('--email'), secret: '${newSecret}',
  activation_succeeded: true, activated_at: new Date().toISOString(), stage: 'confirmed',
}));
`);
const port = await availablePort();
const base = `http://127.0.0.1:${port}`;
let child;
let logs = "";
let token = "";
try {
  await startServer();
  const unauthenticated = await fetch(`${base}/api/mfa/accounts`);
  assert.equal(unauthenticated.status, 401);
  const invalid = await request("preview", { text: "bad-input" });
  assert.equal(invalid.status, 400);
  const input = `${email}----${password}----${oldSecret}\n${queuedEmail}----${password}----${oldSecret}`;
  const preview = await request("preview", { text: input });
  assert.equal(preview.status, 200);
  const previewText = await preview.text();
  assert.equal(JSON.parse(previewText).count, 2);
  assert.doesNotMatch(previewText, new RegExp(`${password}|${oldSecret}`));
  const imported = await request("import", { text: input });
  assert.equal(imported.status, 200, await imported.clone().text());
  assert.equal((await imported.json()).imported, 2);
  const state = await (await request("accounts")).json();
  const ids = state.accounts.map((account) => account.id);
  const primaryId = state.accounts.find((account) => account.email === email).id;
  const queuedId = state.accounts.find((account) => account.email === queuedEmail).id;
  assert.equal((await fetch(`${base}/api/mfa/accounts/${primaryId}/logs`)).status, 401);
  assert.equal((await request('accounts/missing/logs')).status, 404);
  assert.equal((await (await request(`accounts/${primaryId}/logs`)).json()).logs, '');
  assert.equal((await request("logout-all", { ids: [primaryId] })).status, 400);
  assert.equal((await request("start", { ids, concurrency: 31 })).status, 400);
  assert.equal((await request("start", { ids, concurrency: 1, proxyUrl: "invalid-proxy" })).status, 400);
  const visibleProxy = 'http://fixture-user:fixture-proxy-secret@127.0.0.1:7890';
  const started = await request("start", { ids: [primaryId, queuedId], concurrency: 1, proxyUrl: visibleProxy });
  assert.equal(started.status, 200, await started.clone().text());
  assert.equal((await started.json()).started, 2);
  await until(async () => {
    const details = await (await request(`accounts/${primaryId}/logs`)).json();
    return details.running && details.logs.includes('/api/auth/session 200') && details.logs.includes('(activating)');
  });
  const conflict = await fetch(`${base}/api/jobs/${id}/relogin`, {
    method: "POST", headers: headers(), body: JSON.stringify({}),
  });
  assert.equal(conflict.status, 409, await conflict.text());
  const canceled = await request("cancel", { ids: [queuedId] });
  assert.equal(canceled.status, 200);
  await until(async () => {
    const { accounts } = await (await request("accounts")).json();
    return accounts.find((account) => account.id === primaryId)?.status === "success";
  });
  await until(async () => (await (await request(`accounts/${primaryId}/logs`)).json()).logs.includes('[success]'));
  const publicResponse = await request("accounts");
  assert.equal(publicResponse.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await publicResponse.text(), new RegExp(`${password}|${oldSecret}|${newSecret}|cookies`));
  const detailsResponse = await request(`accounts/${primaryId}/logs`);
  assert.equal(detailsResponse.headers.get('cache-control'), 'no-store');
  const rotationLogs = (await detailsResponse.json()).logs;
  assert.ok(rotationLogs.includes(visibleProxy), 'proxy must remain visible in detail logs');
  assert.match(rotationLogs, /\[success\]/);
  assert.match(rotationLogs, /退出码：0/);
  assert.match(rotationLogs, /<redacted>/);
  for (const secret of [password, oldSecret, newSecret, 'synthetic-private-token', 'synthetic-private-cookie']) assert.equal(rotationLogs.includes(secret), false);
  assert.match((await (await request(`accounts/${queuedId}/logs`)).json()).logs, /\[cancel\]/);
  const txt = await request("export", { format: "txt" });
  assert.equal(txt.status, 200, await txt.clone().text());
  assert.equal(txt.headers.get("cache-control"), "no-store");
  assert.match(txt.headers.get("content-disposition"), /attachment; filename=/);
  assert.equal((await txt.text()).replace(/^\uFEFF/, "").trim(), `${email}----${password}----${newSecret}`);
  const json = await request("export", { ids, format: "json" });
  assert.equal(json.status, 200);
  assert.deepEqual(await json.json(), [{ email, password, totpSecret: newSecret }]);
  assert.equal((await request("export", { ids: [], format: "txt" })).status, 400);
  const source = await fetch(`${base}/api/jobs/export-source`, {
    method: "POST", headers: headers(), body: JSON.stringify({ ids: [id] }),
  });
  assert.equal(source.status, 200);
  assert.equal((await source.text()).replace(/^\uFEFF/, "").trim(), `${email}----${password}----${newSecret}`);
  assert.equal((await request("logout-all", { ids: [primaryId], concurrency: 31 })).status, 400);
  const logout = await request("logout-all", { ids: [primaryId], concurrency: 1, proxyUrl: "http://127.0.0.1:7890" });
  assert.equal(logout.status, 200, await logout.clone().text());
  assert.equal((await logout.json()).started, 1);
  const logoutConflict = await fetch(`${base}/api/jobs/${id}/relogin`, { method:"POST", headers:headers(), body:"{}" });
  assert.equal(logoutConflict.status, 409);
  await until(async () => (await (await request("accounts")).json()).accounts.find((account) => account.id === primaryId)?.logoutStatus === "success");
  await until(async () => (await (await request(`accounts/${primaryId}/logs`)).json()).logs.includes('[success] 所有设备登出'));
  const afterLogout = (await (await request("accounts")).json()).accounts.find((account) => account.id === primaryId);
  assert.equal(afterLogout.status, "success");
  assert.ok(afterLogout.logoutAt);
  const allLogs = (await (await request(`accounts/${primaryId}/logs`)).json()).logs;
  assert.ok(allLogs.startsWith(rotationLogs), 'logout must preserve the preceding rotation log');
  assert.match(allLogs, /POST \/backend-api\/accounts\/logout_all 200/);
  assert.equal((await request("export", { ids: [primaryId], format:"txt" })).status, 200);
  const history = await (await request("history")).json();
  assert.ok(history.items.some((item) => item.email === email && item.status === "success"));
  assert.ok(history.items.some((item) => item.email === email && item.operation === "logout_all" && item.status === "success"));
  await stopServer();
  await startServer();
  const restored = await (await request("accounts")).json();
  assert.equal(restored.accounts.find((account) => account.id === primaryId).status, "success");
  assert.equal(restored.accounts.find((account) => account.id === primaryId).logoutStatus, "success");
  assert.equal((await (await request(`accounts/${primaryId}/logs`)).json()).logs, allLogs);
  const restoredExport = await request("export", { ids: [primaryId], format: "txt" });
  assert.equal((await restoredExport.text()).replace(/^\uFEFF/, "").trim(), `${email}----${password}----${newSecret}`);
  const sessionPath = path.join(jobDir, "account-session.json");
  const sourceSession = { type: "chatgpt-session", version: 1, email, accountId: "fixture-account", accessToken: "fixture-auth-page-session", expiresAt: "2000-01-01T00:00:00Z" };
  await storedFiles(root).writeFile(sessionPath, JSON.stringify(sourceSession));
  const callMfa = () => fetch(`${base}/api/jobs/${id}/change-mfa`, { method: "POST", headers: headers(), body: "{}" });
  assert.equal((await fetch(`${base}/api/jobs/${id}/change-mfa`, { method: "POST", body: "{}" })).status, 401);
  const expiredStart = await callMfa();
  assert.equal(expiredStart.status, 409);
  assert.match((await expiredStart.json()).error, /授权已过期/);
  await storedFiles(root).writeFile(sessionPath, JSON.stringify({ ...sourceSession, expiresAt: "2099-01-01T00:00:00Z" }));
  const exportBeforeMfa = await fs.readFile(path.join(jobDir, "sub2api-import-oauth.json"), "utf8");
  const directStart = await callMfa();
  assert.equal(directStart.status, 200, await directStart.clone().text());
  assert.equal((await directStart.json()).accountId, primaryId);
  assert.equal((await callMfa()).status, 409, "double-clicks must not queue duplicate MFA changes");
  assert.equal((await fetch(`${base}/api/jobs/${id}/relogin`, { method: "POST", headers: headers(), body: "{}" })).status, 409);
  await until(async () => (await (await request(`accounts/${primaryId}/logs`)).json()).logs.includes('[reuse-only]'));
  await until(async () => (await (await request("accounts")).json()).accounts.find((account) => account.id === primaryId)?.status === "success");
  const jobsAfterMfa = await (await fetch(`${base}/api/jobs`, { headers: headers() })).json();
  assert.equal(jobsAfterMfa.jobs.find((job) => job.id === id).hasTotpKey, true);
  assert.equal(jobsAfterMfa.jobs.find((job) => job.id === id).lastOperationType, "change_mfa");
  assert.equal(await fs.readFile(path.join(jobDir, "sub2api-import-oauth.json"), "utf8"), exportBeforeMfa, "MFA changes must not regenerate Codex OAuth");
  const afterDirectExport = await fetch(`${base}/api/jobs/export-source`, { method: "POST", headers: headers(), body: JSON.stringify({ ids: [id] }) });
  assert.equal((await afterDirectExport.text()).replace(/^\uFEFF/, "").trim(), `${email}----${password}----${newSecret}`);
  assert.equal((await request("logout-all", { ids: [primaryId] })).status, 200);
  await until(async () => (await (await request(`accounts/${primaryId}/logs`)).json()).logs.split('[success] 所有设备登出').length === 3);
  const invalidated = JSON.parse(await storedFiles(root).readFile(sessionPath, "utf8"));
  assert.equal(invalidated.accessToken, "");
  assert.ok(invalidated.invalidatedAt);
  assert.equal((await callMfa()).status, 409, "logged-out authorization must prompt instead of signing in");
  console.log("MFA console API, synchronization, export, and restart smoke passed");
} catch (error) {
  error.message += `\nConsole output:\n${logs}`;
  throw error;
} finally {
  await stopServer();
  await createCredentialStore({ windowsRoot: path.join(root, "test-local-appdata", "toSub2", "credentials") }).delete(email);
  const isolatedStore = createCredentialStore({ windowsRoot: path.join(root, "mfa", "credentials"), macRoot: path.join(root, "mfa", "credentials") });
  const prefix = `mfa:${crypto.createHash("sha256").update(root).digest("hex")}:`;
  await Promise.all([email, queuedEmail].map((value) => isolatedStore.delete(`${prefix}${value}`)));
  // All paths removed below belong to the mkdtemp fixture directory.
  await fs.rm(root, { recursive: true, force: true });
}

function headers() { return { "content-type": "application/json", "x-console-token": token }; }
function request(action, body) {
  return fetch(`${base}/api/mfa/${action}`, {
    method: body === undefined ? "GET" : "POST", headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function startServer() {
  child = spawn(process.execPath, [path.join(projectRoot, "src", "console-server.mjs"), "--port", String(port)], {
    cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LOCALAPPDATA: path.join(root, "test-local-appdata"), ONBOARDING_OUTPUT_ROOT: root, ONBOARDING_PROTOCOL_SCRIPT: protocolScript },
  });
  child.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-8000); });
  child.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-8000); });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/bootstrap`);
      if (!response.ok) return false;
      const data = await response.json();
      token = data.token;
      assert.equal(data.features.mfaChange, true);
      return true;
    } catch { return false; }
  });
}
async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 9000);
  try { await closed; } finally { clearTimeout(timer); }
}
async function until(check) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("MFA HTTP test timed out");
}
function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
