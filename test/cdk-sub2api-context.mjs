import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createConsoleWorkspace } from "../src/console-server.mjs";

process.env.SUB2API_AUTO_REPAIR_COOLDOWN_MS = "0";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-sub2-context-"));
const jobId = "11111111-1111-4111-8111-111111111111";
const email = "context@example.com";
let savedMonitor;
let workspace;
let backendIdentity;
let details = 0;
let puts = 0;
let remoteEmail = email;
let holdAt = 0;
let releaseHeld;
let heldStarted;
const bindings = new Set();
const server = http.createServer(async (req, res) => {
  if (!["context-key-A", "context-key-B"].includes(req.headers["x-api-key"])) { res.writeHead(401).end(); return; }
  res.setHeader("content-type", "application/json");
  if (req.method === "GET" && req.url.startsWith("/api/v1/admin/accounts?")) { res.end(JSON.stringify({ data: { items: [], total: 0, pages: 1 } })); return; }
  if (req.method === "GET" && req.url === "/api/v1/admin/accounts/91") {
    details += 1;
    if (holdAt && details === holdAt) { heldStarted(); await new Promise((resolve) => { releaseHeld = resolve; }); }
    res.end(JSON.stringify({ data: { id: 91, platform: "openai", name: "fixture", credentials: { email: remoteEmail }, extra: { tosub2_cdk_id: "test-cdk" } } })); return;
  }
  if (req.method === "PUT" && req.url === "/api/v1/admin/accounts/91") { puts += 1; res.end(JSON.stringify({ data: { id: 91 } })); return; }
  if (req.method === "POST" && /^\/api\/v1\/admin\/accounts\/91\/(clear-error|schedulable)$/.test(req.url)) { res.end("{}"); return; }
  res.writeHead(404).end("{}");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const configA = { baseUrl, adminApiKey: "context-key-A", groupIds: [] };
savedMonitor = { version: 1, enabled: true, configurationId: "fixture-configuration-v1", config: configA };
async function start() {
  workspace = await createConsoleWorkspace({ root, cdkId: "test-cdk", namespace: "context-test", legacyEmails: new Set(), isEnabled: () => true, availableSlots: () => 20, requestSchedule: () => {},
    readMonitor: async () => savedMonitor, writeMonitor: async (value) => { savedMonitor = structuredClone(value); },
    fingerprint: (value) => crypto.createHmac("sha256", "synthetic-context-key").update(value).digest("hex").slice(0, 20),
    remoteBound: (backend, id) => bindings.has(`${backend}:${id}`), bindRemote: (backend, id) => bindings.add(`${backend}:${id}`),
  });
  workspace.resume();
}
async function call(route, body) { const response = await workspace.dispatch(body === undefined ? "GET" : "POST", route, body); return JSON.parse(response.body.toString()); }
async function fixture(backend) {
  const directory = path.join(root, jobId); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", version: 1, proxies: [], accounts: [{ name: "fixture", platform: "openai", type: "oauth", concurrency: 1, priority: 0, credentials: { email, access_token: "synthetic-fixture-token", chatgpt_account_id: "fixture-account-id" } }] }));
  await fs.writeFile(path.join(directory, "job-meta.json"), JSON.stringify({ version: 1, email, status: "completed", result_saved: true, created_at: new Date().toISOString(), auto_repair_pending_account_ids: [91], auto_repair_pending_backend: backend }));
}

try {
  await start(); backendIdentity = (await call("/api/sub2api/monitor")).bindingId; await workspace.shutdown();
  await fixture(backendIdentity); await start();
  await call("/api/sub2api/monitor/check", {});
  assert.equal(details, 0, "historical pending without explicit current binding cannot even fetch remote account");
  assert.equal(puts, 0);
  bindings.add(`${backendIdentity}:91`); remoteEmail = "different@example.com";
  await call("/api/sub2api/monitor/check", {});
  assert.equal(puts, 0, "pending remote email mismatch cannot PUT credentials");
  remoteEmail = email;
  holdAt = details + 2;
  const held = new Promise((resolve) => { heldStarted = resolve; });
  const inFlight = call("/api/sub2api/monitor/check", {}).catch((error) => error);
  await held;
  const changed = await call("/api/sub2api/monitor", { enabled: true, config: { ...configA, adminApiKey: "context-key-B" } });
  releaseHeld(); await inFlight; holdAt = 0;
  assert.notEqual(changed.bindingId, backendIdentity, "same URL with new API Key has a new config identity");
  assert.equal(puts, 0, "configuration change during final remote read blocks the pending PUT");
  const before = details; await call("/api/sub2api/monitor/check", {});
  assert.equal(details, before, "old pending IDs are not fetched using a new API Key");
  const restored = await call("/api/sub2api/monitor", { enabled: true, config: configA });
  assert.notEqual(restored.bindingId, backendIdentity, "switching back to the original key does not revive an old config epoch");
  await call("/api/sub2api/monitor/check", {});
  assert.equal(puts, 0, "old pending cannot resume after config A to B to A");
  await workspace.shutdown(); await fixture(restored.bindingId); bindings.add(`${restored.bindingId}:91`); await start();
  const completed = await call("/api/sub2api/monitor/check", {});
  assert.equal(completed.result.updated, 1, "correctly bound pending with matching current context can resume");
  assert.equal(puts, 1, "valid pending repair writes exactly once");
  console.log("Sub2API context guards passed (unbound pending, remote identity, key change during final read, config epochs, valid recovery)");
} finally {
  releaseHeld?.(); await workspace?.shutdown(); server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true });
}
