import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startCdkServer } from "../src/cdk-server.mjs";
import { createConsoleWorkspace } from "../src/console-server.mjs";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createCdkStore } from "../src/cdk-store.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-account-at-console-"));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-at-export-administrator";
const vault = await createCdkVault(root);
const seed = await createCdkStore(root, vault);
const ordinary = seed.generate({ count: 1, quota: 2, note: "AT export fixture" }, seed.adminId)[0];
seed.close();
const auth = "https://api.openai.com/auth";
const exp = Math.floor(Date.now() / 1000) + 3600;
const jwt = (email, extra = {}) => `e30.${Buffer.from(JSON.stringify({ email, [auth]: { chatgpt_account_id: "fixture-account" }, ...extra })).toString("base64url")}.fixture-signature`;
const session = (email, token) => ({ type: "chatgpt-session", version: 1, email, accountId: "fixture-account", accessToken: token });
const oauth = (email, token) => ({ type: "sub2api-data", version: 1, proxies: [], accounts: [{ name: email, platform: "openai", type: "oauth", concurrency: 1, priority: 0,
  credentials: { email, chatgpt_account_id: "fixture-account", access_token: token, refresh_token: "synthetic-refresh-secret" } }] });
const tokens = [];
const storedFiles = [];
async function job(name, { owner = root, email = `${name}@example.invalid`, session: savedSession, oauth: savedOauth } = {}) {
  const id = crypto.randomUUID(); const directory = path.join(owner, id); await fs.mkdir(directory, { recursive: true });
  const documents = { "job-meta.json": { version: 1, task_metadata_version: 2, email, status: "canceled", login_mode: "password", phone_binding_mode: "manual",
    has_password: true, has_totp_key: true, has_stored_credentials: true, proxy_configured: true, created_at: "2026-11-05T00:00:00Z", updated_at: "2026-11-05T00:00:00Z" } };
  if (savedSession !== undefined) documents["account-session.json"] = savedSession;
  if (savedOauth !== undefined) documents["sub2api-import-oauth.json"] = savedOauth;
  for (const [name, value] of Object.entries(documents)) {
    const target = path.join(directory, name); await fs.writeFile(target, typeof value === "string" ? value : JSON.stringify(value)); storedFiles.push(target);
  }
  return { id, email };
}

let app; let credentialDecrypts = 0; let externalRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const target = new URL(typeof input === "string" ? input : input.url);
  if (target.hostname !== "127.0.0.1") { externalRequests++; throw Error("AT export cannot make upstream requests"); }
  return originalFetch(input, options);
};
try {
  const sharedEmail = "shared@example.invalid";
  const sessionToken = jwt(sharedEmail, { exp }); tokens.push(sessionToken);
  const secondaryToken = "synthetic-unused-oauth"; tokens.push(secondaryToken);
  const first = await job("session", { email: sharedEmail, session: session(sharedEmail, sessionToken), oauth: oauth(sharedEmail, secondaryToken) });
  const expiredEmail = "expired@example.invalid"; const expiredToken = jwt(expiredEmail, { exp: 0 }); tokens.push(expiredToken);
  const expired = await job("expired", { session: session(expiredEmail, expiredToken) });
  const unknownToken = "synthetic-unknown-at"; tokens.push(unknownToken);
  const unknown = await job("unknown", { session: { ...session("unknown@example.invalid", unknownToken), expiresAt: "2099-01-01T00:00:00Z" } });
  const oauthToken = jwt("oauth@example.invalid", { exp }); tokens.push(oauthToken);
  const oauthJob = await job("oauth", { oauth: oauth("oauth@example.invalid", oauthToken) });
  const placeholderToken = "synthetic-placeholder-fallback-at"; tokens.push(placeholderToken);
  const placeholder = await job("placeholder", { session: { type: "chatgpt-session", version: 1, email: "placeholder@example.invalid", accessToken: "" }, oauth: oauth("placeholder@example.invalid", placeholderToken) });
  const missing = await job("missing");
  const corrupt = await job("corrupt", { session: "{bad-json PRIVATE_BODY" });
  const mismatch = await job("mismatch", { session: session("mismatch@example.invalid", jwt("another@example.invalid", { exp })) });
  const control = await job("control", { session: session("control@example.invalid", "synthetic-first-line\nsynthetic-second-line") });
  const invalidated = await job("invalidated", { session: { ...session("invalidated@example.invalid", "synthetic-invalidated-at"), invalidatedAt: "2026-11-05T00:00:00Z" }, oauth: oauth("invalidated@example.invalid", "synthetic-stale-oauth-at") });
  const wrongOAuth = oauth("wrong-oauth@example.invalid", jwt("wrong-oauth@example.invalid", { exp })); wrongOAuth.accounts[0].credentials.chatgpt_account_id = "conflicting-account";
  const invalidOAuth = await job("wrong-oauth", { oauth: wrongOAuth });
  const ownToken = "synthetic-other-cdk-at"; tokens.push(ownToken);
  const foreign = await job("foreign", { owner: path.join(root, "cdk", ordinary.id), email: sharedEmail, session: session(sharedEmail, ownToken) });
  const forbiddenProtocol = path.join(root, "must-not-run.mjs");
  const protocolMarker = path.join(root, "unexpected-protocol-run");
  await fs.writeFile(forbiddenProtocol, `import fs from 'node:fs/promises'; await fs.writeFile(${JSON.stringify(protocolMarker)}, 'unexpected'); process.exit(1);`);
  app = await startCdkServer({ root, listen: false, createWorkspace: (options) => createConsoleWorkspace({ ...options, protocolScript: forbiddenProtocol,
    credentialVault: { ...options.credentialVault, open: (...args) => { credentialDecrypts++; return options.credentialVault.open(...args); } } }) });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  function client() {
    let cookie = ""; let csrf = "";
    return { async call(route, method = "GET", body, extra = {}) {
      const response = await fetch(`${base}${route}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(csrf ? { "x-console-token": csrf } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
      const raw = await response.text(); let data; try { data = JSON.parse(raw); } catch { data = raw; }
      if (response.ok && data.token) csrf = data.token;
      return { status: response.status, data, raw, headers: response.headers };
    } };
  }
  const anonymous = client(); const admin = client(); const user = client();
  assert.equal((await anonymous.call("/api/jobs/export-at", "POST", { ids: [first.id] })).status, 401);
  const adminLogin = await admin.call("/api/auth/login", "POST", { cdk: process.env.TOSUB2_ADMIN_CDK });
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.data.features.atExport, true);
  assert.equal((await user.call("/api/auth/login", "POST", { cdk: ordinary.secret })).status, 200);
  const before = new Map(await Promise.all(storedFiles.map(async (target) => [target, await fs.readFile(target, "utf8")])));
  const selected = [oauthJob, first, expired, unknown, placeholder, missing, corrupt, mismatch, control, invalidated, invalidOAuth];
  const result = await admin.call("/api/jobs/export-at", "POST", { ids: [...selected.map((item) => item.id), first.id] });
  assert.equal(result.status, 200, result.raw);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.data.requested, selected.length, "duplicate IDs are deduplicated without changing order");
  assert.equal(result.data.exported, 5);
  assert.deepEqual(result.data.entries.map((entry) => entry.email), [oauthJob, first, expired, unknown, placeholder].map((entry) => entry.email));
  assert.deepEqual(result.data.entries.map((entry) => entry.source), ["oauth", "session", "session", "session", "oauth"]);
  assert.equal(result.data.entries.find((entry) => entry.email === first.email).accessToken, sessionToken);
  assert.equal(result.data.entries.find((entry) => entry.email === expired.email).expired, true);
  assert.equal(result.data.entries.find((entry) => entry.email === unknown.email).expired, null);
  assert.deepEqual(result.data.skipped.map((entry) => entry.email), [missing, corrupt, mismatch, control, invalidated, invalidOAuth].map((entry) => entry.email));
  assert.match(result.data.skipped.find((entry) => entry.email === invalidated.email).reason, /登出或失效/);
  assert.doesNotMatch(JSON.stringify(result.data.skipped), /PRIVATE_BODY|synthetic-|fixture-signature|conflicting-account/);
  const none = await admin.call("/api/jobs/export-at", "POST", { ids: [missing.id] });
  assert.equal(none.status, 200); assert.equal(none.data.exported, 0); assert.equal(none.data.skipped.length, 1);
  assert.equal((await admin.call("/api/jobs/export-at", "POST", { ids: [] })).status, 400);
  assert.equal((await admin.call("/api/jobs/export-at", "POST", { ids: [first.id] }, { "x-console-token": "" })).status, 403);
  const mixed = await admin.call("/api/jobs/export-at", "POST", { ids: [first.id, foreign.id] });
  assert.equal(mixed.status, 404); assert.ok(!mixed.raw.includes(sessionToken), "all selected IDs are checked before returning any token");
  assert.equal((await user.call("/api/jobs/export-at", "POST", { ids: [first.id] })).status, 404);
  const own = await user.call("/api/jobs/export-at", "POST", { ids: [foreign.id] });
  assert.equal(own.status, 200); assert.equal(own.data.entries[0].accessToken, ownToken);
  const listing = await admin.call("/api/jobs");
  const logs = await admin.call(`/api/jobs/${first.id}/logs`);
  for (const value of tokens) { assert.ok(!listing.raw.includes(value)); assert.ok(!logs.raw.includes(value)); }
  for (const [target, contents] of before) assert.equal(await fs.readFile(target, "utf8"), contents, "AT export does not change task/session/OAuth files");
  assert.equal(credentialDecrypts, 0, "AT export never loads password, MFA or proxy credentials");
  assert.equal(externalRequests, 0, "AT export never logs in, refreshes, or checks quota upstream");
  await assert.rejects(fs.access(protocolMarker), { code: "ENOENT" });
  console.log("account AT console passed (authenticated preview, partial/empty exports, source precedence, expiry, CDK isolation, no task writes/credential loads/network)");
} finally {
  await app?.close(); globalThis.fetch = originalFetch;
  await fs.rm(root, { recursive: true, force: true });
}
