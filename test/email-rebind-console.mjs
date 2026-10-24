import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConsoleWorkspace } from "../src/console-server.mjs";
import { startCdkServer } from "../src/cdk-server.mjs";

if (!["win32", "darwin"].includes(process.platform)) { console.log("rebind encrypted credential integration skipped on unsupported OS"); process.exit(0); }
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-rebind-http-"));
const requests = []; const begun = new Set(); const rebound = new Map();
const backend = http.createServer((req, res) => handle(req, res).catch(() => { res.writeHead(500); res.end('{}'); }));
await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
const upstream = `http://127.0.0.1:${backend.address().port}`;
const wrapper = path.join(root, "protocol-fixture.mjs");
const callsFile = path.join(root, "process-calls.jsonl");
await fs.writeFile(wrapper, `import fs from 'node:fs/promises';
await fs.appendFile(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2))+'\\n');
if (!process.argv.includes('--rebind-operation')) process.exit(97);
process.argv.push('--native-http');
await import(${JSON.stringify(pathToFileURL(path.join(project, "src/protocol-login.mjs")).href)});
`);
process.env.TOSUB2_ADMIN_CDK = "rebind-integration-admin-only";
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.ONBOARDING_PROTOCOL_SCRIPT = wrapper;
process.env.CHATGPT_BASE = upstream; process.env.AUTH_BASE = upstream;
process.env.LOCALAPPDATA = path.join(root, "isolated-os-credentials");
let app; let base; let cookie = ""; let token = "";
async function call(route, method = "GET", body, headers = {}) {
  const response = await fetch(`${base}${route}`, { method, headers: { "content-type": "application/json", "x-console-token": token, cookie, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
async function start() {
  app = await startCdkServer({ createWorkspace: createConsoleWorkspace, root, listen: false });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
}
async function login(secret) {
  const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cdk: secret }) });
  assert.equal(response.status, 200);
  cookie = response.headers.get("set-cookie").split(";")[0]; token = (await response.json()).token;
}
const parsed = (response) => JSON.parse(response.body.toString("utf8"));
async function waitFor(operation) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await operation(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 30)); }
  throw new Error("isolated rebind state timed out");
}
try {
  await start();
  const [owner, other] = app.store.generate({ count: 2, quota: 10, note: "synthetic rebind integration" }, app.store.adminId);
  let workspace = await app.workspaceFor(owner.id);
  await app.importFor(owner.id, "mfa", { text: "source-a@example.com----fixture-password----JBSWY3DPEHPK3PXP\nsource-b@example.com----fixture-password----JBSWY3DPEHPK3PXP" }, crypto.randomUUID(), owner.id);
  const mfa = parsed(await workspace.dispatch("GET", "/api/mfa/accounts"));
  const ownRoot = path.join(root, "cdk", owner.id);
  for (const row of mfa.accounts) {
    const accessToken = `e30.${Buffer.from(JSON.stringify({ email: row.email, exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "stable-account" } })).toString("base64url")}.synthetic-private-access`;
    await fs.writeFile(path.join(ownRoot, "mfa", `${row.id}.session.json`), JSON.stringify({ type: "chatgpt-session", version: 1, email: row.email, accessToken, accountId: "stable-account", chatgptBase: upstream }));
  }
  const originalSessions = await Promise.all(mfa.accounts.map((row) => fs.readFile(path.join(ownRoot, "mfa", `${row.id}.session.json`), "utf8")));
  const originalAuthId = crypto.randomUUID(); const originalAuthDirectory = path.join(ownRoot, originalAuthId);
  await fs.mkdir(originalAuthDirectory);
  const originalAuthMetadata = JSON.stringify({ version: 1, email: "source-a@example.com", status: "phone_skipped", phone_binding_enabled: false,
    phone_binding_mode: "manual", account_session_available: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  await fs.writeFile(path.join(originalAuthDirectory, "job-meta.json"), originalAuthMetadata);
  await fs.writeFile(path.join(originalAuthDirectory, "account-session.json"), originalSessions[mfa.accounts.findIndex((row) => row.email === "source-a@example.com")]);
  await app.close(); await start(); workspace = await app.workspaceFor(owner.id);
  const originalMfa = await fs.readFile(path.join(ownRoot, "mfa/accounts.json"), "utf8");
  await login(owner.secret);
  assert.equal((await call("/api/rebind/state", "GET", null, { "x-console-token": "wrong" })).status, 403);
  const initial = await call("/api/rebind/state");
  const ids = initial.data.sources.map((row) => row.id);
  const invalid = await call("/api/rebind/preview", "POST", { ids, text: "only-one@example.com" });
  assert.equal(invalid.status, 400);
  assert.equal(requests.length, 0, "invalid target count cannot perform upstream operations");
  const body = { ids, text: `target-a@example.com----${upstream}/mail/target-a\ntarget-b@example.com`, concurrency: 1 };
  const preview = await call("/api/rebind/preview", "POST", body);
  assert.equal(preview.status, 200);
  assert.doesNotMatch(JSON.stringify(preview.data), /127\.0\.0\.1|fixture-password|synthetic-private-access/);
  const started = await call("/api/rebind/start", "POST", { ...body, digest: preview.data.digest });
  assert.equal(started.status, 200);
  assert.equal((await call("/api/rebind/start", "POST", { ...body, digest: preview.data.digest })).status, 409);
  const state = () => workspace.dispatch("GET", "/api/rebind/state").then(parsed);
  const auto = await waitFor(async () => (await state()).items.find((row) => row.newEmail === "target-a@example.com" && row.status === "success"));
  let manual = await waitFor(async () => (await state()).items.find((row) => row.newEmail === "target-b@example.com" && row.status === "waiting_manual"));
  assert.equal((await call(`/api/rebind/${manual.id}/code`, "POST", { code: "999999", version: manual.challengeVersion })).data.item.status, "waiting_manual");
  manual = (await state()).items.find((row) => row.id === manual.id);
  assert.equal((await call(`/api/rebind/${manual.id}/code`, "POST", { code: "001234", version: manual.challengeVersion })).data.item.status, "success");
  assert.equal(rebound.get("source-a@example.com"), "target-a@example.com");
  assert.equal(rebound.get("source-b@example.com"), "target-b@example.com");
  assert.equal(await fs.readFile(path.join(ownRoot, "mfa/accounts.json"), "utf8"), originalMfa, "email changes cannot modify MFA records");
  assert.deepEqual(await Promise.all(mfa.accounts.map((row) => fs.readFile(path.join(ownRoot, "mfa", `${row.id}.session.json`), "utf8"))), originalSessions);
  assert.equal(workspace.publicJobs().length, 1, "confirmed rebind must not implicitly create authorization accounts");
  assert.equal(workspace.publicJobs()[0].email, "source-a@example.com");
  assert.equal(await fs.readFile(path.join(originalAuthDirectory, "job-meta.json"), "utf8"), originalAuthMetadata, "original authorization metadata cannot change");
  assert.equal(app.store.preview(owner.id, ["target-a@example.com"]).charge, 1, "target emails cannot enter inventory before explicit charged import");
  const currentCookie = cookie; const currentToken = token;
  await login(other.secret);
  assert.equal((await call("/api/rebind/state")).data.items.length, 0);
  assert.equal((await call(`/api/rebind/${manual.id}/retry`, "POST", {})).status, 404);
  assert.equal((await call("/api/imports/preview", "POST", { mode: "rebind", payload: { ids: [auto.id] } })).status, 404);
  cookie = currentCookie; token = currentToken;
  const payload = { ids: [auto.id, manual.id] };
  const quote = await call("/api/imports/preview", "POST", { mode: "rebind", payload });
  assert.equal(quote.status, 200);
  assert.equal(quote.data.added, 2); assert.equal(quote.data.charge, 2);
  const before = app.store.get(owner.id).balance;
  const requestKey = crypto.randomUUID();
  const synced = await call("/api/rebind/sync", "POST", payload, { "idempotency-key": requestKey });
  assert.equal(synced.status, 200, JSON.stringify(synced.data));
  assert.equal(synced.data.created, 2);
  assert.equal(app.store.get(owner.id).balance, before - 2);
  assert.equal(workspace.publicJobs().length, 3);
  assert.ok(workspace.publicJobs().filter((job) => job.id !== originalAuthId).every((job) => job.status === "reauth_required" && job.phoneBindingEnabled === false));
  assert.equal((await call("/api/rebind/sync", "POST", payload, { "idempotency-key": requestKey })).status, 200);
  assert.equal(app.store.get(owner.id).balance, before - 2, "idempotent import cannot charge twice");
  assert.equal(workspace.publicJobs().length, 3);
  const repeated = await call("/api/rebind/sync", "POST", payload, { "idempotency-key": crypto.randomUUID() });
  assert.equal(repeated.status, 200); assert.equal(repeated.data.created, 0);
  assert.equal(app.store.get(owner.id).balance, before - 2);
  assert.doesNotMatch(JSON.stringify((await state()).items), /fixture-password|synthetic-private-access|JBSWY3DPEHPK3PXP|001234|127\.0\.0\.1/);
  const calls = (await fs.readFile(callsFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(calls.every((args) => args.includes("--rebind-operation") && !args.includes("--rotate-totp") && !args.includes("--logout-all")));
  assert.ok(requests.every((request) => !/oauth|login|phone|mfa/.test(request.path)));
  const originalRequestCount = requests.length;
  await app.close(); await start(); await login(owner.secret);
  assert.equal((await call("/api/rebind/state")).data.items.filter((row) => row.status === "success").length, 2);
  assert.equal(requests.length, originalRequestCount, "restart cannot replay upstream email changes");
  assert.equal(app.store.get(owner.id).balance, before - 2);
  const [limited] = app.store.generate({ count: 1, quota: 1, note: "zero balance rebind fixture" }, app.store.adminId);
  const limitedWorkspace = await app.workspaceFor(limited.id);
  await app.importFor(limited.id, "mfa", { text: "limited-source@example.com----fixture-password" }, crypto.randomUUID(), limited.id);
  const limitedMfa = parsed(await limitedWorkspace.dispatch("GET", "/api/mfa/accounts")).accounts[0];
  const limitedRoot = path.join(root, "cdk", limited.id);
  const limitedToken = `e30.${Buffer.from(JSON.stringify({ email: limitedMfa.email, exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "stable-account" } })).toString("base64url")}.synthetic-private-access`;
  await fs.writeFile(path.join(limitedRoot, "mfa", `${limitedMfa.id}.session.json`), JSON.stringify({ type: "chatgpt-session", version: 1, email: limitedMfa.email, accessToken: limitedToken, accountId: "stable-account", chatgptBase: upstream }));
  await login(limited.secret);
  const limitedState = () => limitedWorkspace.dispatch("GET", "/api/rebind/state").then(parsed);
  const limitedBody = { ids: (await limitedState()).sources.map((row) => row.id), text: "limited-target@example.com" };
  const limitedPreview = await call("/api/rebind/preview", "POST", limitedBody);
  assert.equal((await call("/api/rebind/start", "POST", { ...limitedBody, digest: limitedPreview.data.digest })).status, 200, "zero balance allows operations on existing source accounts");
  const limitedItem = await waitFor(async () => (await limitedState()).items.find((row) => row.status === "waiting_manual"));
  assert.equal((await call(`/api/rebind/${limitedItem.id}/code`, "POST", { code: "001234", version: limitedItem.challengeVersion })).status, 200);
  const limitedQuote = await call("/api/imports/preview", "POST", { mode: "rebind", payload: { ids: [limitedItem.id] } });
  assert.equal(limitedQuote.data.canImport, false); assert.equal(limitedQuote.data.charge, 1);
  const deniedImport = await call("/api/rebind/sync", "POST", { ids: [limitedItem.id] }, { "idempotency-key": crypto.randomUUID() });
  assert.equal(deniedImport.status, 409);
  assert.equal(limitedWorkspace.publicJobs().length, 0, "insufficient quota cannot create an uncharged account");
  assert.equal((await limitedState()).items[0].status, "success", "failed account import cannot undo confirmed email rebind");
  assert.equal(app.store.get(limited.id).balance, 0);
  console.log("email rebind console passed (real protocol fixture, mixed OTP, cookie context, original-data preservation, CDK charging/isolation, idempotency and restart)");
} finally {
  await app?.close(); backend.closeAllConnections(); await new Promise((resolve) => backend.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}

async function handle(req, res) {
  const url = new URL(req.url, upstream);
  requests.push({ method: req.method, path: url.pathname });
  const send = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (url.pathname.startsWith("/mail/")) return send(200, begun.has("target-a@example.com")
    ? { code: "001234", received_at: new Date().toISOString(), message_id: "new-message" }
    : { code: "999999", received_at: "2000-01-01T00:00:00Z", message_id: "old-message" });
  let claims;
  try { claims = JSON.parse(Buffer.from(String(req.headers.authorization).split(".")[1], "base64url").toString("utf8")); } catch {}
  assert.ok(claims?.email);
  assert.equal(req.headers["chatgpt-account-id"], "stable-account");
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
  if (url.pathname.endsWith("/eligibility")) { res.setHeader("set-cookie", "rebind-context=synthetic-cookie; Path=/"); return send(200, { eligible: true }); }
  assert.match(req.headers.cookie || "", /rebind-context=synthetic-cookie/, "cookies returned by eligibility must carry across protocol processes");
  if (url.pathname.endsWith("/begin")) { begun.add(body.email); return send(200, { success: true }); }
  if (url.pathname.endsWith("/verify")) {
    if (body.code !== "001234") return send(400, { error: { code: "invalid_code", message: "private response text cannot leak" } });
    rebound.set(claims.email, body.email); return send(200, { success: true });
  }
  return send(404, {});
}
