import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "../src/workspace-storage.mjs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createConsoleWorkspace } from "../src/console-server.mjs";
import { startCdkServer } from "../src/cdk-server.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-device-logout-"));
const requests = [];
const backend = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  requests.push({ method: req.method, path: req.url, bodyLength: Buffer.concat(chunks).length, accountId: req.headers["chatgpt-account-id"] });
  await new Promise(resolve => setTimeout(resolve, 150));
  res.writeHead(req.method === "POST" && req.url === "/backend-api/accounts/logout_all" ? 200 : 500, { "content-type": "application/json" });
  res.end(JSON.stringify({ success: true }));
});
await new Promise(resolve => backend.listen(0, "127.0.0.1", resolve));
const upstream = `http://127.0.0.1:${backend.address().port}`;
const wrapper = path.join(root, "protocol.mjs");
const processCalls = path.join(root, "process-calls.jsonl");
await fs.writeFile(wrapper, `
import fs from ${JSON.stringify(new URL("../src/workspace-storage.mjs", import.meta.url).href)};
if (!process.argv.includes('--logout-all') || process.argv.includes('--rotate-totp') || process.env.CHATGPT_LOGIN_PASSWORD || process.env.CHATGPT_TOTP_SECRET) process.exit(97);
await fs.appendFile(${JSON.stringify(processCalls)}, JSON.stringify(process.argv.slice(2))+'\\n');
process.argv.push('--native-http');
await import(${JSON.stringify(new URL("../src/protocol-login.mjs", import.meta.url).href)});
`);
process.env.TOSUB2_ADMIN_CDK = "isolated-device-logout-admin";
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.LOCALAPPDATA = path.join(root, "os-credentials");
process.env.ONBOARDING_PROTOCOL_SCRIPT = wrapper;
process.env.CHATGPT_BASE = upstream; process.env.AUTH_BASE = upstream;
let app; let base; let cookie = ""; let token = "";
const oldSecret = "JBSWY3DPEHPK3PXP";
const parsed = response => JSON.parse(response.body.toString("utf8"));
const ids = new Map();
const email = name => `${name}@fixture.invalid`;
async function start() {
  app = await startCdkServer({ createWorkspace: createConsoleWorkspace, root, listen: false });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
async function login(secret) {
  const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cdk: secret }) });
  assert.equal(response.status, 200);
  cookie = response.headers.get("set-cookie").split(";")[0]; token = (await response.json()).token;
}
async function call(route, method = "GET", body) {
  const response = await fetch(`${base}${route}`, { method, headers: { cookie, "x-console-token": token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
async function until(read) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw Error("Independent logout fixture timed out");
}
async function seed(ownerId, name, { expired = false, mismatch = false, metadataSession = true } = {}) {
  const id = crypto.randomUUID(); ids.set(`${ownerId}:${name}`, id);
  const folder = path.join(root, "cdk", ownerId, id); await fs.mkdir(folder, { recursive: true });
  const timestamp = new Date().toISOString();
  await fs.writeFile(path.join(folder, "job-meta.json"), JSON.stringify({ version: 1, task_metadata_version: 2, email: email(name), status: "login_ready",
    prompt: "登录成功，可以管理账号", result_saved: false, account_session_available: metadataSession, login_checkpoint_available: true,
    created_at: timestamp, updated_at: timestamp, phone_binding_enabled: false, phone_binding_mode: "manual" }));
  const identityEmail = mismatch ? "different@fixture.invalid" : email(name);
  const accountId = `fixture-${ownerId}`;
  const accessToken = `e30.${Buffer.from(JSON.stringify({ email: identityEmail, exp: expired ? 1 : Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.fixture`;
  await fs.writeFile(path.join(folder, "account-session.json"), JSON.stringify({ type: "chatgpt-session", version: 1, email: identityEmail, accountId, accessToken, chatgptBase: upstream }));
  await fs.writeFile(path.join(folder, "login-checkpoint.json"), JSON.stringify({ version: 1, email: email(name), stage: "email_verified", cookies: [] }));
}
try {
  await start();
  const [owner, other] = app.store.generate({ count: 2, quota: 5, note: "independent device logout" }, app.store.adminId);
  await app.importFor(owner.id, "mfa", { text: ["single", "batch-a", "batch-b", "expired", "mismatch"].map(name => `${email(name)}----fixture-password----${oldSecret}`).join("\n") }, crypto.randomUUID(), owner.id);
  await app.importFor(other.id, "mfa", { text: `${email("single")}----other-password----${oldSecret}` }, crypto.randomUUID(), other.id);
  assert.equal(app.store.get(owner.id).balance, 0);
  for (const name of ["single", "batch-a", "batch-b", "auth-only"]) await seed(owner.id, name);
  await seed(owner.id, "expired", { expired: true }); await seed(owner.id, "mismatch", { mismatch: true });
  await seed(other.id, "single");
  const before = app.store.get(owner.id); const beforeLedger = app.store.ledger(owner.id);
  await app.close(); await start(); await login(owner.secret);
  const jobId = name => ids.get(`${owner.id}:${name}`);
  const own = await app.workspaceFor(owner.id);
  const ownRoot = path.join(root, "cdk", owner.id);
  const sourceState = await call("/api/jobs");
  assert.equal(sourceState.data.jobs.find(row => row.id === jobId("single")).canLogoutDevices, true);
  assert.ok((await call("/api/mfa/accounts")).data.accounts.every(row => row.status === "ready"));
  const beforeOther = await fs.readFile(path.join(root, "cdk", other.id, ids.get(`${other.id}:single`), "account-session.json"), "utf8");
  await login(other.secret);
  assert.equal((await call(`/api/jobs/${jobId("single")}/logout-devices`, "POST", {})).status, 404);
  await login(owner.secret);
  const single = await call(`/api/jobs/${jobId("single")}/logout-devices`, "POST", {});
  assert.equal(single.status, 200);
  assert.equal((await call(`/api/jobs/${jobId("single")}/logout-devices`, "POST", {})).status, 409);
  await until(async () => (await call("/api/mfa/accounts")).data.accounts.find(row => row.id === single.data.accountId && row.logoutStatus === "success"));
  let changed = (await call("/api/jobs")).data.jobs.find(row => row.id === jobId("single"));
  assert.equal(changed.canLogoutDevices, false); assert.equal(changed.status, "reauth_required"); assert.equal(changed.lastOperationType, "logout_all");
  assert.equal(JSON.parse(await fs.readFile(path.join(ownRoot, jobId("single"), "account-session.json"), "utf8")).accessToken, "");
  await assert.rejects(fs.access(path.join(ownRoot, jobId("single"), "login-checkpoint.json")), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(root, "cdk", other.id, ids.get(`${other.id}:single`), "account-session.json"), "utf8"), beforeOther);
  const requestCount = requests.length;
  for (const name of ["expired", "mismatch"]) assert.equal((await call(`/api/jobs/${jobId(name)}/logout-devices`, "POST", {})).status, 409);
  const mixed = await call("/api/jobs/logout-devices-batch", "POST", { ids: [jobId("batch-a"), jobId("expired")] });
  assert.equal(mixed.status, 409);
  assert.equal(requests.length, requestCount, "failed preflight cannot start logout for part of a batch");
  assert.equal((await call("/api/mfa/accounts")).data.accounts.find(row => row.email === email("batch-a")).logoutStatus, "idle");
  const batch = await call("/api/jobs/logout-devices-batch", "POST", { ids: [jobId("batch-a"), jobId("batch-b")], concurrency: 2 });
  assert.equal(batch.status, 200); assert.equal(batch.data.started, 2);
  await until(async () => {
    const state = (await call("/api/mfa/accounts")).data;
    return !state.running && batch.data.accountIds.every(id => state.accounts.find(row => row.id === id)?.logoutStatus === "success");
  });
  const authOnly = await call(`/api/jobs/${jobId("auth-only")}/logout-devices`, "POST", {});
  assert.equal(authOnly.status, 200);
  await until(async () => (await call("/api/mfa/accounts")).data.accounts.find(row => row.id === authOnly.data.accountId && row.logoutStatus === "success"));
  const mfa = (await call("/api/mfa/accounts")).data.accounts;
  assert.ok(mfa.every(row => row.status === "ready" && !row.changedAt), "logout never fabricates a successful MFA change");
  const exported = await own.dispatch("POST", "/api/mfa/export", { ids: [single.data.accountId], format: "txt" }).catch(error => ({ status: error.status }));
  assert.equal(exported.status, 400, "an account only logged out has no successful MFA export");
  assert.equal(requests.length, 4);
  assert.ok(requests.every(row => row.method === "POST" && row.path === "/backend-api/accounts/logout_all" && row.bodyLength === 0 && row.accountId === `fixture-${owner.id}`));
  const protocols = (await fs.readFile(processCalls, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(protocols.every(args => args.includes("--logout-all") && !args.includes("--rotate-totp")));
  assert.equal(app.store.get(owner.id).balance, before.balance); assert.equal(app.store.get(owner.id).consumed, before.consumed);
  assert.deepEqual(app.store.ledger(owner.id), beforeLedger);
  await app.close(); await start(); await login(owner.secret);
  const restored = (await call("/api/mfa/accounts")).data.accounts.find(row => row.id === single.data.accountId);
  assert.equal(restored.status, "ready"); assert.equal(restored.logoutStatus, "success");
  assert.equal(requests.length, 4, "restart cannot replay device logout");
  assert.doesNotMatch(JSON.stringify(restored), /accessToken|refresh_token|fixture-password|JBSWY3/);
  console.log("Independent device logout passed (real protocol/local upstream, no MFA prerequisite or mutation, single/batch, auth-only sessions, expiry/identity guards, zero quota, CDK isolation and restart).");
} finally {
  await app?.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
