import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createConsoleWorkspace } from "../src/console-server.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-push-confirmation-"));
const remote = new Map();
const writes = [];
const bindings = new Map();
const workspaces = [];
let heldDetail = null;
let heldPut = null;
let sequence = 100;

function gate(id) {
  let enter;
  let release;
  return { id, entered: new Promise((resolve) => { enter = resolve; }), waiting: new Promise((resolve) => { release = resolve; }), enter: () => enter(), release: () => release() };
}
function reply(res, value, status = 200) {
  if (res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: status === 200 ? 0 : status, data: value }));
}
async function requestJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture.invalid");
    if (req.headers["x-api-key"] !== "synthetic-confirmation-admin-key") return reply(res, null, 401);
    if (req.method === "GET" && url.pathname === "/api/v1/admin/accounts") {
      const items = [...remote.values()];
      return reply(res, { items, total: items.length, page: 1, page_size: 100, pages: 1 });
    }
    const match = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(url.pathname);
    if (!match || !remote.has(Number(match[1]))) return reply(res, null, 404);
    const id = Number(match[1]);
    if (req.method === "GET") {
      const pending = heldDetail?.id === id ? heldDetail : null;
      if (pending) { heldDetail = null; pending.enter(); await pending.waiting; }
      return reply(res, remote.get(id));
    }
    if (req.method === "PUT") {
      const patch = await requestJson(req);
      writes.push(id);
      const pending = heldPut?.id === id ? heldPut : null;
      if (pending) { heldPut = null; pending.enter(); await pending.waiting; }
      remote.set(id, { ...remote.get(id), ...patch });
      return reply(res, remote.get(id));
    }
    reply(res, null, 404);
  } catch (error) { reply(res, { message: error.message }, 500); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const config = { baseUrl: `http://127.0.0.1:${server.address().port}`, adminApiKey: "synthetic-confirmation-admin-key", groupIds: [] };
const fingerprint = (value) => crypto.createHmac("sha256", "synthetic-confirmation-fingerprint").update(String(value)).digest("hex").slice(0, 20);
const gates = [];

async function fixture(name, count) {
  const folder = path.join(root, name);
  const records = [];
  for (let index = 0; index < count; index++) {
    const id = crypto.randomUUID();
    const email = `${name}-${index}@confirmation.example.invalid`;
    const remoteId = sequence++;
    const directory = path.join(folder, id);
    const accountId = `synthetic-account-${name}-${index}`;
    const credentials = { email, access_token: `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString("base64url")}.synthetic-token`,
      refresh_token: "synthetic-refresh-token", chatgpt_account_id: accountId };
    const account = { name: email, platform: "openai", type: "oauth", credentials, concurrency: 1, priority: 0 };
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", version: 1, proxies: [], accounts: [account] }));
    await fs.writeFile(path.join(directory, "job-meta.json"), JSON.stringify({ version: 1, email, status: "completed", result_saved: true, created_at: new Date().toISOString() }));
    remote.set(remoteId, { ...account, id: remoteId, extra: {}, status: "active", schedulable: true, group_ids: [] });
    records.push({ id, email, remoteId, directory });
  }
  const workspace = await createConsoleWorkspace({ root: folder, namespace: "synthetic-confirmation", cdkId: name,
    legacyEmails: new Set(), isEnabled: () => true, availableSlots: () => 20, requestSchedule() {},
    readMonitor: async () => null, writeMonitor: async () => {}, fingerprint,
    getRemoteBindings: (backend, email) => [...bindings.values()].filter((row) => row.owner === name && row.backend === backend && row.email === email).map(({ remoteId, email }) => ({ remoteId, email })),
    bindRemote: (backend, remoteId, email) => bindings.set(`${name}:${backend}:${remoteId}`, { owner: name, backend, remoteId, email }),
    remoteBound: (backend, remoteId) => bindings.has(`${name}:${backend}:${remoteId}`),
  });
  workspaces.push(workspace);
  return { workspace, records };
}
async function call(workspace, route, records, extra = {}) {
  const response = await workspace.dispatch("POST", route, { ids: records.map((row) => row.id), config, ...extra });
  return JSON.parse(response.body.toString());
}
async function untilEntered(pending) {
  await Promise.race([pending.entered, delay(2000).then(() => { throw Error("held upstream request did not start"); })]);
}

try {
  const first = await fixture("selected-lock", 2);
  const preview = await call(first.workspace, "/api/sub2api/upload-preview", [first.records[0]]);
  const detail = gate(first.records[0].remoteId); gates.push(detail); heldDetail = detail;
  const confirmation = call(first.workspace, "/api/sub2api/upload", [first.records[0]], { previewToken: preview.previewToken });
  await untilEntered(detail);
  let deletionFinished = false;
  const deletion = first.workspace.dispatch("POST", "/api/jobs/delete-batch", { ids: [first.records[0].id] }).then((response) => { deletionFinished = true; return response; });
  await delay(30);
  assert.equal(deletionFinished, false, "deleting the selected account waits while its confirmed push holds the account lock");
  assert.ok(first.workspace.publicJobs().some((row) => row.id === first.records[0].id), "the selected local task remains present until its push finishes");
  await fs.access(path.join(first.records[0].directory, "sub2api-import-oauth.json"));
  const unrelatedDelete = await first.workspace.dispatch("POST", "/api/jobs/delete-batch", { ids: [first.records[1].id] });
  assert.equal(unrelatedDelete.status, 200, "a push only locks selected accounts rather than the whole workspace");
  detail.release();
  const result = await confirmation;
  assert.equal(result.updated, 1);
  await deletion;
  assert.equal(deletionFinished, true);
  assert.equal(first.workspace.publicJobs().some((row) => row.id === first.records[0].id), false);
  assert.equal(writes.filter((id) => id === first.records[0].remoteId).length, 1);

  const second = await fixture("shutdown-bulk", 2);
  const bulkPreview = await call(second.workspace, "/api/sub2api/upload-preview", second.records);
  assert.equal(bulkPreview.updated, 2);
  const put = gate(second.records[0].remoteId); gates.push(put); heldPut = put;
  const bulkConfirmation = call(second.workspace, "/api/sub2api/upload", second.records, { previewToken: bulkPreview.previewToken });
  await untilEntered(put);
  const stopped = second.workspace.shutdown();
  put.release();
  const bulkResult = await bulkConfirmation;
  await stopped;
  assert.ok(bulkResult.unknown >= 1, "an interrupted upstream write remains explicitly unconfirmed");
  assert.equal(bulkResult.updated, 0, "stopping during the first upstream write cannot report a completed push");
  assert.equal(writes.filter((id) => id === second.records[0].remoteId).length, 1, "the already sent first request is not retried during shutdown");
  assert.equal(writes.filter((id) => id === second.records[1].remoteId).length, 0, "shutdown prevents the bulk loop from sending a second upstream write");
  assert.ok(![...bindings.values()].some((row) => row.owner === "shutdown-bulk"), "shutdown cannot establish new confirmed bindings from an interrupted write");
  console.log("Sub2API push confirmation passed (selected-account locking, unrelated task progress, deletion ordering, and stop-during-bulk write safety; synthetic fixtures only)");
} finally {
  for (const pending of gates) pending.release();
  await Promise.allSettled(workspaces.map((workspace) => workspace.shutdown()));
  server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
