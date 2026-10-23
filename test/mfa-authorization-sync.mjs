import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConsoleWorkspace } from "../src/console-server.mjs";
import { startCdkServer } from "../src/cdk-server.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-mfa-sync-"));
const requests = [];
const backend = http.createServer((req, res) => {
  requests.push({ method: req.method, path: new URL(req.url, "http://localhost").pathname });
  const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); } catch {}
  assert.equal(req.method, "GET", "sync must never mutate the upstream account");
  assert.equal(req.headers["chatgpt-account-id"], "sync-account");
  const route = new URL(req.url, "http://localhost").pathname;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(route.endsWith("usage") ? {
    email: claims.email, account_id: "sync-account", plan_type: "plus",
    rate_limit: { allowed: true, primary_window: { used_percent: 25, limit_window_seconds: 18000 } },
  } : route.endsWith("rate-limit-reset-credits") ? { available_count: 2 }
    : route.endsWith("subscriptions") ? { plan_type: "plus", active_until: "2099-01-01T00:00:00Z" } : {}));
});
await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
const script = path.join(root, "insights-only.mjs");
const callsPath = path.join(root, "process-calls.jsonl");
await fs.writeFile(script, `import fs from 'node:fs/promises';
await fs.appendFile(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2))+'\\n');
if (!process.argv.includes('--check-account-insights')) process.exit(90);
process.argv.push('--native-http');
await import(${JSON.stringify(pathToFileURL(path.join(project, "src/protocol-login.mjs")).href)});
`);
process.env.TOSUB2_ADMIN_CDK = "isolated-mfa-sync-admin-fixture";
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.ONBOARDING_PROTOCOL_SCRIPT = script;
process.env.LOCALAPPDATA = path.join(root, "isolated-os-credentials");
process.env.CHATGPT_BASE = `http://127.0.0.1:${backend.address().port}`;
process.env.AUTH_BASE = process.env.CHATGPT_BASE;
let app;
const parsed = (response) => JSON.parse(response.body.toString("utf8"));
const call = async (workspace, route, method = "GET", body = {}) => parsed(await workspace.dispatch(method, route, body));
async function waitFor(operation) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await operation(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 40)); }
  throw new Error("synthetic sync condition timed out");
}
try {
  app = await startCdkServer({ root, createWorkspace: createConsoleWorkspace, listen: false });
  const [owner, other] = app.store.generate({ count: 2, quota: 10, note: "synthetic MFA sync" }, app.store.adminId);
  const workspace = await app.workspaceFor(owner.id);
  const otherWorkspace = await app.workspaceFor(other.id);
  const email = "sync-valid@example.com";
  const expiredEmail = "sync-expired@example.com";
  const missingEmail = "sync-missing@example.com";
  const imported = await app.importFor(owner.id, "mfa", { text: [email, expiredEmail, missingEmail].map((value) => `${value}----fixture-password----JBSWY3DPEHPK3PXP`).join("\n") }, crypto.randomUUID(), owner.id);
  assert.equal(imported.status, 200);
  const accounts = (await call(workspace, "/api/mfa/accounts")).accounts;
  const byEmail = new Map(accounts.map((account) => [account.email, account]));
  const workspaceRoot = path.join(root, "cdk", owner.id);
  const sessionFor = (address, exp) => ({ type: "chatgpt-session", version: 1, email: address,
    accessToken: `e30.${Buffer.from(JSON.stringify({ email: address, exp, "https://api.openai.com/auth": { chatgpt_account_id: "sync-account" } })).toString("base64url")}.private-fixture`,
    accountId: "sync-account", chatgptBase: process.env.CHATGPT_BASE });
  for (const [address, exp] of [[email, Math.floor(Date.now() / 1000) + 3600], [expiredEmail, 1]]) {
    await fs.writeFile(path.join(workspaceRoot, "mfa", `${byEmail.get(address).id}.session.json`), JSON.stringify(sessionFor(address, exp)));
  }
  const balance = app.store.get(owner.id).balance;
  await assert.rejects(call(otherWorkspace, "/api/mfa/sync-authorization", "POST", { ids: [byEmail.get(email).id] }), { status: 400 });
  const sync = await call(workspace, "/api/mfa/sync-authorization", "POST", { ids: accounts.map((account) => account.id) });
  assert.equal(sync.synced, 1);
  assert.equal(sync.failed, 2);
  assert.match(sync.results.find((row) => row.email === expiredEmail).message, /过期/);
  assert.match(sync.results.find((row) => row.email === missingEmail).message, /授权/);
  assert.doesNotMatch(JSON.stringify(sync), /fixture-password|JBSWY3DPEHPK3PXP|private-fixture/);
  assert.equal(app.store.get(owner.id).balance, balance, "moving existing accounts within a workspace cannot charge import quota again");
  let job = await waitFor(async () => {
    const item = workspace.publicJobs().find((value) => value.email === email);
    return item?.status === "phone_skipped" && item.accountInsights?.status === "ok" ? item : null;
  });
  assert.equal(job.phoneBindingEnabled, false);
  assert.equal(job.phoneBindingMode, "manual");
  assert.equal(job.accountInsights.quota.windows[0].remainingPercent, 75);
  assert.equal(job.canDownload, false, "syncing a web session must not fabricate Codex credentials");
  assert.equal(workspace.publicJobs().length, 1);
  assert.equal(otherWorkspace.publicJobs().length, 0);
  assert.equal((await call(workspace, "/api/jobs?phoneBinding=disabled")).jobs[0].id, job.id);
  const outputPath = path.join(workspaceRoot, job.id, "sub2api-import-oauth.json");
  await assert.rejects(fs.access(outputPath), { code: "ENOENT" });
  const repeat = await call(workspace, "/api/mfa/sync-authorization", "POST", { ids: [byEmail.get(email).id] });
  assert.equal(repeat.results[0].jobId, job.id);
  assert.equal(repeat.results[0].created, false);
  await waitFor(async () => workspace.publicJobs()[0]?.status === "phone_skipped");
  assert.equal(workspace.publicJobs().length, 1);
  assert.ok(requests.length >= 6);
  const recordedCalls = (await fs.readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(recordedCalls.every((args) => args.includes("--check-account-insights") && !args.some((arg) => /--rotate|--logout|--refresh|--resume/.test(arg))));
  assert.ok(requests.every((request) => request.method === "GET" && !/oauth|login|phone/.test(request.path)));
  const source = await workspace.dispatch("POST", "/api/jobs/export-source", { ids: [job.id] });
  assert.match(source.body.toString(), /sync-valid@example.com----fixture-password----JBSWY3DPEHPK3PXP/);
  // Simulate a pre-existing Codex export so reuse cannot accidentally select its token for detection.
  const oauthRaw = JSON.stringify({ type: "sub2api-data", version: 1, proxies: [], accounts: [{ name: email, platform: "openai", type: "oauth", credentials: { email, access_token: "old-codex-fixture" } }] });
  await fs.writeFile(outputPath, oauthRaw);
  const metadataPath = path.join(path.dirname(outputPath), "job-meta.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  await fs.writeFile(metadataPath, JSON.stringify({ ...metadata, status: "completed", result_saved: true, account_insights_return_status: null }));
  await app.close();
  const countBeforeRestart = requests.length;
  app = await startCdkServer({ root, createWorkspace: createConsoleWorkspace, listen: false });
  const restored = await app.workspaceFor(owner.id);
  job = restored.publicJobs()[0];
  assert.equal(job.status, "completed");
  assert.equal(job.phoneBindingEnabled, false);
  assert.equal(job.accountInsights.quota.windows[0].remainingPercent, 75);
  assert.equal(requests.length, countBeforeRestart, "restoration must not start a login or re-run successful detection");
  const existingSync = await call(restored, "/api/mfa/sync-authorization", "POST", { ids: [byEmail.get(email).id] });
  assert.equal(existingSync.results[0].created, false);
  await waitFor(async () => restored.publicJobs()[0].status === "completed" && requests.length > countBeforeRestart);
  assert.equal(restored.publicJobs()[0].accountInsights.status, "ok", "existing Codex exports must still detect through the newly synced web session");
  assert.equal(await fs.readFile(outputPath, "utf8"), oauthRaw, "sync cannot replace an existing OAuth export");
  console.log("MFA authorization sync passed (reuse, auto insights, no login/phone, expiry, deduplication, restart, CDK isolation and quota)");
} finally {
  await app?.close();
  backend.closeAllConnections();
  await new Promise((resolve) => backend.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
