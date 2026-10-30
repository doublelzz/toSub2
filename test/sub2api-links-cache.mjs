import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createConsoleWorkspace } from "../src/console-server.mjs";

// All accounts, keys, tokens and responses in this test are synthetic.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-links-cache-"));
const owner = "synthetic-cache-owner";
const rows = Object.fromEntries(["existing", "new"].map((name) => [name, {
  id: crypto.randomUUID(), email: `${name}@cache.example.invalid`, accountId: `synthetic-cache-${name}`,
}]));
const keys = ["synthetic-cache-admin-key", "synthetic-cache-admin-key-B"];
const bindings = new Map();
const snapshots = new Map();
const remote = new Map();
const requests = [];
let nextId = 100;
let failDetails = false;
let workspace;

function credentials(row) {
  const claims = { exp: Math.floor(Date.now() / 1000) + 86400,
    "https://api.openai.com/auth": { chatgpt_account_id: row.accountId } };
  return { email: row.email, chatgpt_account_id: row.accountId,
    access_token: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic-access-secret`,
    refresh_token: "synthetic-refresh-secret" };
}
remote.set(91, { id: 91, name: rows.existing.email, platform: "openai", type: "oauth",
  credentials: credentials(rows.existing), extra: {}, status: "active", schedulable: true,
  concurrency: 12, priority: 2, load_factor: 80, proxy_id: 3,
  group_ids: [7], groups: [{ id: 7, name: "Cached plus" }] });
function send(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: status === 200 ? 0 : status, data,
    ...(status === 200 ? {} : { message: "synthetic upstream unavailable" }) }));
}
async function read(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture.invalid");
    const route = url.pathname;
    requests.push({ method: req.method, route });
    if (!keys.includes(req.headers["x-api-key"])) return send(res, null, 401);
    if (req.method === "GET" && route === "/api/v1/admin/accounts") {
      const items = [...remote.values()];
      return send(res, { items, total: items.length, page: 1, page_size: 100, pages: 1 });
    }
    const detail = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(route);
    if (detail && req.method === "GET") {
      if (failDetails) return send(res, null, 503);
      return remote.has(Number(detail[1])) ? send(res, remote.get(Number(detail[1]))) : send(res, null, 404);
    }
    if (detail && req.method === "PUT") {
      const id = Number(detail[1]);
      if (!remote.has(id)) return send(res, null, 404);
      remote.set(id, { ...remote.get(id), ...await read(req) });
      return send(res, remote.get(id));
    }
    if (req.method === "POST" && route === "/api/v1/admin/accounts/batch") {
      const body = await read(req);
      const results = body.accounts.map((account) => {
        const id = nextId++;
        remote.set(id, { id, ...account, groups: (account.group_ids || []).map((groupId) => ({ id: groupId, name: "Cached plus" })) });
        return { name: account.name, id, success: true };
      });
      return send(res, { success: results.length, failed: 0, results });
    }
    send(res, null, 404);
  } catch (error) { send(res, { message: String(error.message) }, 500); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, adminApiKey: keys[0], groupIds: [], codexFingerprintMode: "off" };
const fingerprint = (value) => crypto.createHmac("sha256", "synthetic-cache-fingerprint").update(String(value)).digest("hex").slice(0, 20);

async function start(ownerId = owner) {
  const folder = path.join(root, ownerId);
  for (const row of Object.values(rows)) {
    const directory = path.join(folder, row.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", version: 1, proxies: [], accounts: [{
      name: row.email, platform: "openai", type: "oauth", credentials: credentials(row), concurrency: 1, priority: 0,
    }] }));
    await fs.writeFile(path.join(directory, "job-meta.json"), JSON.stringify({ version: 1, email: row.email, status: "completed", result_saved: true, created_at: new Date().toISOString() }));
  }
  return createConsoleWorkspace({ root: folder, cdkId: ownerId, namespace: "synthetic-cache-test", legacyEmails: new Set(),
    isEnabled: () => true, availableSlots: () => 20, requestSchedule() {}, readMonitor: async () => null, writeMonitor: async () => {}, fingerprint,
    getRemoteBindings: (backend, email) => [...bindings.values()].filter((row) => row.ownerId === ownerId && row.backend === backend && row.email === email.toLowerCase())
      .map(({ remoteId, email }) => ({ remoteId, email })),
    bindRemote: (backend, remoteId, email) => bindings.set(`${ownerId}:${backend}:${remoteId}`, { ownerId, backend, remoteId: Number(remoteId), email: email.toLowerCase() }),
    remoteBound: (backend, remoteId) => bindings.has(`${ownerId}:${backend}:${remoteId}`),
    getSub2ApiLinkSnapshots: (backend, emails) => [...snapshots.values()].filter((row) => row.ownerId === ownerId && row.backend === backend && emails.includes(row.email)).map((row) => structuredClone(row.snapshot)),
    saveSub2ApiLinkSnapshot: (backend, email, snapshot) => snapshots.set(`${ownerId}:${backend}:${email.toLowerCase()}`, { ownerId, backend, email: email.toLowerCase(), snapshot: structuredClone(snapshot) }),
  });
}
async function call(route, name = "existing", override = {}, extra = {}) {
  const response = await workspace.dispatch("POST", route, { ids: [rows[name].id], config: { ...config, ...override }, ...extra });
  return JSON.parse(response.body.toString());
}
const cache = (name, override) => call("/api/sub2api/links-cache", name, override);
const refresh = (name, override) => call("/api/sub2api/links", name, override);
async function push(name) {
  const plan = await call("/api/sub2api/upload-preview", name);
  assert.equal(plan.canPush, true);
  return call("/api/sub2api/upload", name, {}, { previewToken: plan.previewToken });
}
function assertSafe(value) {
  const text = JSON.stringify(value);
  for (const secret of [...keys, "synthetic-access-secret", "synthetic-refresh-secret"]) assert.equal(text.includes(secret), false, "only safe metadata may be returned");
  assert.equal(/access_token|refresh_token|credentials|chatgpt_account_id/.test(text), false);
}

try {
  workspace = await start();
  const initialRequests = requests.length;
  const initial = await cache();
  assert.notEqual(initial.items[0]?.status, "linked");
  assert.equal(requests.length, initialRequests, "uncached local lookup must not contact the remote service");

  const updated = await push("existing");
  assert.equal(updated.updated, 1);
  const afterPushRequests = requests.length;
  const saved = await cache();
  assert.equal(saved.items[0].status, "linked");
  assert.equal(saved.items[0].accounts[0].id, 91);
  assert.ok(saved.items[0].checkedAt && Number.isFinite(Date.parse(saved.items[0].checkedAt)));
  assert.equal(saved.items[0].cached, true);
  assert.equal(saved.items[0].accounts[0].groups[0].name, "Cached plus");
  assert.equal(requests.length, afterPushRequests, "push saves its verified association result without requiring a follow-up remote request");
  assertSafe(saved);

  remote.get(91).group_ids = [9]; remote.get(91).groups = [{ id: 9, name: "Refreshed group" }];
  const beforeRefresh = requests.length;
  const refreshed = await refresh();
  assert.equal(requests.length, beforeRefresh + 1, "manual refresh only fetches the confirmed remote account detail");
  assert.equal(refreshed.items[0].accounts[0].groups[0].name, "Refreshed group");
  const beforeRead = requests.length;
  assert.equal((await cache()).items[0].accounts[0].groups[0].name, "Refreshed group");
  assert.equal(requests.length, beforeRead, "subsequent reads reuse the refreshed saved snapshot");

  failDetails = true;
  const failed = await refresh();
  assert.equal(failed.items[0].status, "linked", "transient refresh failure preserves the last confirmed association");
  assert.equal(failed.items[0].accounts[0].groups[0].name, "Refreshed group");
  assert.ok(failed.items[0].refreshError);
  assert.equal(failed.items[0].checkedAt, refreshed.items[0].checkedAt, "refresh errors must not claim that old metadata was freshly checked");
  const afterFailedRead = requests.length;
  const savedFailure = await cache();
  assert.equal(savedFailure.items[0].status, "linked"); assert.ok(savedFailure.items[0].refreshError);
  assert.equal(requests.length, afterFailedRead);
  assertSafe(failed); assertSafe(savedFailure);
  failDetails = false;

  await workspace.shutdown(); workspace = await start();
  const beforeRestartCache = requests.length;
  assert.equal((await cache()).items[0].status, "linked", "saved association details survive workspace restart");
  assert.equal(requests.length, beforeRestartCache, "restoring a cached result after restart performs no remote request");
  const changedKey = await cache("existing", { adminApiKey: keys[1] });
  assert.notEqual(changedKey.items[0]?.status, "linked", "another backend credential cannot display the old connection snapshot");
  assert.equal(requests.length, beforeRestartCache);

  const added = await push("new");
  assert.equal(added.created, 1);
  const afterCreate = requests.length;
  const newCache = await cache("new");
  assert.equal(newCache.items[0].status, "linked");
  assert.equal(newCache.items[0].accounts[0].id, added.result.results[0].remoteId);
  assert.equal(requests.length, afterCreate, "new remote accounts immediately have a saved association result");
  await assert.rejects(() => call("/api/sub2api/upload", "new"), (error) => error.status === 409, "a cache snapshot never substitutes for push confirmation");
  const newSnapshots = [...snapshots.entries()].filter(([, row]) => row.ownerId === owner && row.email === rows.new.email);
  for (const [key] of newSnapshots) snapshots.delete(key);
  const legacy = await cache("new");
  assert.equal(legacy.items[0].status, "linked", "historical explicit bindings can be displayed without querying remote details");
  assert.equal(legacy.items[0].metadataComplete, false);
  assert.equal(legacy.items[0].checkedAt, null);
  assert.deepEqual(legacy.items[0].accounts[0].groups, [], "historical bindings do not invent unsaved group metadata");
  assert.equal(requests.length, afterCreate);
  for (const [key, row] of newSnapshots) snapshots.set(key, row);

  await workspace.shutdown(); workspace = await start("different-cache-cdk");
  const beforeOtherOwner = requests.length;
  assert.notEqual((await cache("new")).items[0]?.status, "linked", "same email in another CDK cannot inherit saved association metadata");
  assert.equal(requests.length, beforeOtherOwner);
  await workspace.shutdown(); workspace = await start();

  remote.delete(91);
  const missing = await refresh();
  assert.equal(missing.items[0].status, "missing", "a confirmed 404 invalidates the old linked snapshot");
  const afterMissing = requests.length;
  assert.equal((await cache()).items[0].status, "missing");
  assert.equal(requests.length, afterMissing);

  for (const row of bindings.values()) if (row.ownerId === owner && row.email === rows.new.email) row.remoteId = 999;
  const staleBinding = await cache("new");
  assert.ok((staleBinding.items[0]?.accounts || []).every((account) => account.id !== newCache.items[0].accounts[0].id), "cached remote IDs are checked against the current explicit binding before display");
  assert.equal(requests.length, afterMissing, "binding validation for saved metadata remains entirely local");
  assertSafe(staleBinding);
  console.log("Sub2API links cache passed (zero-remote saved reads, push and refresh snapshots, error retention, 404 invalidation, restart and CDK/connection/binding isolation; synthetic fixtures only)");
} finally {
  await workspace?.shutdown(); server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
