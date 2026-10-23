import assert from "node:assert/strict";
import "./console-auth.mjs";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-insights-console-"));
const id = crypto.randomUUID();
const email = "insights-fixture@example.com";
const outputDir = path.join(root, id);
await fs.mkdir(outputDir);
const exportPath = path.join(outputDir, "sub2api-import-oauth.json");
const tokenExp = Math.floor(Date.now() / 1000) + 86400;
const accessToken = `e30.${Buffer.from(JSON.stringify({ exp: tokenExp, ["https://api.openai.com/auth"]: { chatgpt_account_id: "fixture-personal-account" } })).toString("base64url")}.fixture-access-secret`;
let raw = JSON.stringify({ type: "sub2api-data", version: 1, proxies: [], accounts: [{ name: email, platform: "openai", type: "oauth", concurrency: 10, priority: 1, credentials: {
  email, access_token: accessToken, refresh_token: "fixture-refresh-secret", chatgpt_account_id: "fixture-personal-account",
} }] });
await fs.writeFile(exportPath, raw);
const invalidId = crypto.randomUUID();
const expiredId = crypto.randomUUID();
const invalidPath = path.join(root, invalidId, "sub2api-import-oauth.json");
const expiredPath = path.join(root, expiredId, "sub2api-import-oauth.json");
const invalid = JSON.parse(raw);
invalid.accounts[0].credentials.email = "invalid-fixture@example.com";
invalid.accounts[0].credentials.chatgpt_account_id = "wrong-session-id";
const expired = JSON.parse(raw);
expired.accounts[0].credentials.email = "expired-fixture@example.com";
expired.accounts[0].credentials.access_token = `e30.${Buffer.from(JSON.stringify({ exp: 1, "https://api.openai.com/auth": { chatgpt_account_id: "fixture-personal-account" } })).toString("base64url")}.expired-fixture`;
for (const [target, data] of [[invalidPath, invalid], [expiredPath, expired]]) {
  await fs.mkdir(path.dirname(target));
  await fs.writeFile(target, JSON.stringify(data));
}
let fail = false;
let hold = false;
let partialUpload = false;
const requests = [];
let uploadedAccounts = [];
const backend = http.createServer(async (req, res) => {
  requests.push({ method: req.method, path: new URL(req.url, "http://localhost").pathname });
  if (req.method === "POST" && req.url === "/api/v1/admin/accounts/batch") {
    assert.equal(req.headers["x-api-key"], "fixture-admin-key");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    uploadedAccounts = JSON.parse(Buffer.concat(chunks).toString("utf8")).accounts;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(partialUpload ? { code: 0, data: { success: 1, failed: 1, results: uploadedAccounts.map((account, index) => ({
      name: account.name, success: index === 0, ...(index ? { error: "fixture-refresh-secret group rejected" } : {}),
    })) } } : { success: uploadedAccounts.length, failed: 0 }));
    return;
  }
  if (req.method === "POST" && req.url === "/oauth/token") {
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(new URLSearchParams(body).get("grant_type"), "refresh_token");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      access_token: accessToken, refresh_token: "fixture-refresh-secret",
      id_token: `e30.${Buffer.from(JSON.stringify({ email, sid: "fixture-personal-account", "https://api.openai.com/auth": { chatgpt_account_id: "fixture-personal-account", chatgpt_plan_type: "plus" } })).toString("base64url")}.signature`,
    }));
    return;
  }
  assert.equal(req.headers.authorization, `Bearer ${accessToken}`);
  assert.equal(req.headers["chatgpt-account-id"], "fixture-personal-account");
  assert.equal(req.headers.cookie, undefined);
  await delay(hold ? 10_000 : 500);
  if (res.destroyed) return;
  res.writeHead(fail ? 401 : 200, { "content-type": "application/json" });
  const route = new URL(req.url, "http://localhost").pathname;
  res.end(JSON.stringify(fail ? { error: "fixture-access-secret cannot leak" } : route.endsWith("usage") ? {
    email, account_id: "fixture-personal-account", plan_type: "plus",
    rate_limit: { allowed: true, primary_window: { used_percent: 100, limit_window_seconds: 3600 }, secondary_window: { used_percent: 20, limit_window_seconds: 604800 } },
  } : route.endsWith("rate-limit-reset-credits") ? { available_count: 0, credits: [] }
    : route.endsWith("subscriptions") ? { plan_type: "plus", active_until: "2099-01-01T00:00:00Z" } : {}));
});
await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
const backendUrl = `http://127.0.0.1:${backend.address().port}`;
const port = await availablePort();
const base = `http://127.0.0.1:${port}`;
let child;
let childExit;
let logs = "";
let headers;

function startConsole() {
  child = spawn(process.execPath, [path.join(project, "src/console-server.mjs"), "--port", String(port)], {
    cwd: project, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ONBOARDING_OUTPUT_ROOT: root, CHATGPT_BASE: backendUrl, AUTH_BASE: backendUrl },
  });
  child.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20000); });
  child.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-20000); });
  childExit = new Promise((resolve) => child.once("exit", resolve));
}
async function initialize() {
  const bootstrap = await waitFor(async () => {
    try { const res = await fetch(`${base}/api/bootstrap`); return res.ok ? res.json() : null; } catch { return null; }
  });
  headers = { "content-type": "application/json", "x-console-token": bootstrap.token };
}
async function page() { return (await fetch(`${base}/api/jobs`, { headers })).json(); }
async function jobWhen(predicate) {
  return waitFor(async () => { const job = (await page()).jobs.find((item) => item.id === id); return job && predicate(job) ? job : null; });
}
const post = (action) => fetch(`${base}/api/jobs/${id}/${action}`, { method: "POST", headers, body: "{}" });

try {
  startConsole();
  await initialize();
  const initial = await jobWhen((job) => job.status === "completed");
  assert.equal(initial.accountInsights, null);
  assert.equal(requests.length, 0, "restoring existing outputs must not query or log in");
  const previewResponse = await fetch(`${base}/api/jobs/export-preview`, { method: "POST", headers, body: JSON.stringify({ ids: [id, invalidId, expiredId] }) });
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.exportable, 2);
  assert.equal(preview.failed, 1);
  assert.deepEqual(preview.tokens, { valid: 1, expiredWithRefresh: 1, expiredWithoutRefresh: 0, unknown: 0 });
  assert.match(preview.rows.find((row) => row.id === invalidId).message, /账号 ID/);
  assert.doesNotMatch(JSON.stringify(preview), /fixture-access-secret|fixture-refresh-secret|expired-fixture`/);
  assert.equal(requests.length, 0, "preflight must not refresh tokens or call upstream services");
  assert.equal((await fetch(`${base}/api/jobs/${invalidId}/download`, { headers })).status, 409);
  const partialDownload = await fetch(`${base}/api/jobs/download-batch`, { method: "POST", headers, body: JSON.stringify({ ids: [id, invalidId] }) });
  assert.equal(partialDownload.status, 200);
  assert.equal(JSON.parse(partialDownload.headers.get("x-export-summary")).failed, 1);
  assert.equal((await partialDownload.json()).accounts.length, 1);
  assert.equal(await fs.readFile(invalidPath, "utf8"), JSON.stringify(invalid), "validation cannot repair saved identities");
  const concurrent = await Promise.all([post("account-insights"), post("account-insights")]);
  assert.equal(concurrent.filter((res) => res.status === 200).length, 1);
  assert.equal(concurrent.filter((res) => res.status === 409).length, 1);
  const running = await jobWhen((job) => job.accountInsightsChecking);
  assert.equal(running.canDownload, true);
  assert.equal((await post("relogin")).status, 409);
  assert.equal((await post("regenerate")).status, 409);
  let completed = await jobWhen((job) => job.status === "completed" && job.accountInsights);
  assert.equal(completed.accountInsights.status, "ok");
  assert.equal(completed.accountInsights.quota.windows[0].remainingPercent, 0);
  assert.equal(completed.accountInsights.quota.windows[1].remainingPercent, 80);
  assert.equal(completed.accountInsights.resetCredits.availableCount, 0);
  assert.equal(completed.accountInsights.subscription.expiresAt, "2099-01-01T00:00:00.000Z");
  assert.equal(await fs.readFile(exportPath, "utf8"), raw);
  for (const response of [
    await fetch(`${base}/api/jobs/${id}/download`, { headers }),
    await fetch(`${base}/api/jobs/download-batch`, { method: "POST", headers, body: JSON.stringify({ ids: [id] }) }),
  ]) {
    assert.equal(response.status, 200);
    const exported = await response.json();
    assert.equal(exported.accounts[0].credentials.expires_at, new Date(tokenExp * 1000).toISOString());
    assert.equal(exported.accounts[0].credentials.subscription_expires_at, "2099-01-01T00:00:00.000Z");
    assert.equal(exported.accounts[0].credentials.plan_type, "plus");
    assert.equal(exported.accounts[0].expires_at, undefined);
  }
  const upload = await fetch(`${base}/api/sub2api/upload`, {
    method: "POST", headers,
    body: JSON.stringify({ ids: [id], config: { baseUrl: backendUrl, adminApiKey: "fixture-admin-key" } }),
  });
  assert.equal(upload.status, 200, await upload.text());
  assert.equal(uploadedAccounts[0].credentials.expires_at, new Date(tokenExp * 1000).toISOString());
  assert.equal(uploadedAccounts[0].credentials.subscription_expires_at, "2099-01-01T00:00:00.000Z");
  assert.equal(await fs.readFile(exportPath, "utf8"), raw, "downloads and uploads cannot rewrite historical authorization files");
  const mixedUpload = await fetch(`${base}/api/sub2api/upload`, { method: "POST", headers, body: JSON.stringify({ ids: [id, invalidId], config: { baseUrl: backendUrl, adminApiKey: "fixture-admin-key" } }) });
  const mixedResult = await mixedUpload.json();
  assert.equal(mixedResult.uploaded, 1);
  assert.equal(mixedResult.failed, 1);
  assert.equal(uploadedAccounts.length, 1, "invalid identity must not be sent to Sub2API");
  assert.equal(uploadedAccounts[0].extra.codex_fingerprint_mode, "off");
  partialUpload = true;
  const partialUploadResponse = await fetch(`${base}/api/sub2api/upload`, { method: "POST", headers, body: JSON.stringify({ ids: [id, expiredId], config: { baseUrl: backendUrl, adminApiKey: "fixture-admin-key" } }) });
  const partialResult = await partialUploadResponse.json();
  assert.equal(partialResult.uploaded, 1, "wrapped upstream results must determine actual successful count");
  assert.equal(partialResult.failed, 1);
  assert.equal(partialResult.result.results[1].jobId, expiredId);
  assert.match(partialResult.result.results[1].message, /group rejected/);
  assert.doesNotMatch(JSON.stringify(partialResult), /fixture-refresh-secret/);
  partialUpload = false;
  assert.doesNotMatch(JSON.stringify(await page()), /fixture-access-secret|fixture-refresh-secret/);
  fail = true;
  assert.equal((await post("account-insights")).status, 200);
  completed = await jobWhen((job) => job.status === "completed" && job.accountInsights?.status === "error");
  assert.equal(completed.canDownload, true);
  assert.equal(completed.lastError, null);
  assert.equal(completed.accountInsights.quota.error, "unauthorized");
  assert.equal(await fs.readFile(exportPath, "utf8"), raw);
  const detail = await (await fetch(`${base}/api/jobs/${id}/logs`, { headers })).json();
  assert.match(detail.logs, /account-insights/);
  assert.doesNotMatch(detail.logs, /fixture-access-secret|fixture-refresh-secret/);
  assert.equal((await post("regenerate")).status, 200);
  completed = await jobWhen((job) => job.status === "completed" && job.attempt === 2);
  assert.equal(completed.accountInsights.status, "error", "automatic query errors must not fail a successful refresh");
  assert.equal(completed.canDownload, true);
  assert.equal(completed.lastError, null);
  raw = await fs.readFile(exportPath, "utf8");
  fail = false;
  hold = true;
  assert.equal((await post("account-insights")).status, 200);
  await jobWhen((job) => job.status === "checking_account");
  assert.equal((await post("cancel")).status, 200);
  completed = await jobWhen((job) => job.status === "completed");
  assert.match(completed.accountInsightsError, /取消/);
  assert.equal(completed.canDownload, true);
  assert.equal((await post("account-insights")).status, 200);
  await jobWhen((job) => job.status === "checking_account");
  child.kill("SIGKILL");
  await childExit;
  startConsole();
  await initialize();
  completed = await jobWhen((job) => job.status === "completed");
  assert.equal(completed.canDownload, true, "restart during detection must preserve authorization state");
  assert.equal(completed.accountInsights.status, "error", "previous snapshot survives restart");
  assert.equal(await fs.readFile(exportPath, "utf8"), raw);
  assert.equal(requests.filter((item) => item.path === "/oauth/token").length, 1, "only the explicit regenerate operation may refresh OAuth");
  assert.ok(requests.every((item) => ["/oauth/token", "/api/v1/admin/accounts/batch"].includes(item.path) || (item.method === "GET" && !/consume|authorize|oauth|signin|login/.test(item.path))), "manual checks must never log in or consume a reset");
  console.log("account insights console smoke passed (concurrency, failure isolation, cancellation, restart, no login)");
} catch (error) {
  error.message += `\nConsole output:\n${logs}`;
  throw error;
} finally {
  if (child?.exitCode === null) child.kill("SIGKILL");
  await Promise.race([childExit, delay(2000)]);
  backend.closeAllConnections();
  await new Promise((resolve) => backend.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(fn) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await delay(80); }
  throw new Error("expected condition did not become ready");
}
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}
