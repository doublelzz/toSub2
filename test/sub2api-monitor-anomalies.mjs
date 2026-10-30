import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createConsoleWorkspace } from "../src/console-server.mjs";

// All identities, credentials, upstream data and tasks in this regression are synthetic.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-monitor-anomalies-"));
const owner = "synthetic-anomaly-owner";
const secret = "synthetic-anomaly-admin-secret";
const fixtures = Array.from({ length: 25 }, (_, index) => ({ id: crypto.randomUUID(), email: `linked-${index}@anomaly.example.invalid`, remoteId: 101 + index }));
const unbound = { id: crypto.randomUUID(), email: "unbound-local@anomaly.example.invalid" };
const ordinary = { id: crypto.randomUUID(), email: "ordinary@anomaly.example.invalid" };
const missingTaskEmail = "deleted-local@anomaly.example.invalid";
const remoteOnlyEmail = "remote-only@anomaly.example.invalid";
const outsideEmail = "outside-group@anomaly.example.invalid";
const foreignEmail = "foreign-private@anomaly.example.invalid";
const bindings = new Map();
let savedMonitor = null;
let remoteGets = 0;
let remoteWrites = 0;
let workspace;

const remoteAccount = (id, email, patch = {}) => ({ id, name: email || "Untitled synthetic account", platform: "openai", type: "oauth", status: "error",
  credentials: { ...(email ? { email } : {}), access_token: "synthetic-anomaly-access-secret", refresh_token: "synthetic-anomaly-refresh-secret" },
  extra: {}, group_ids: [7], account_groups: [{ group_id: 7 }], groups: [{ id: 7, name: "Synthetic selected group" }], ...patch });
const remoteAccounts = [
  ...fixtures.map((fixture) => remoteAccount(fixture.remoteId, fixture.email)),
  remoteAccount(201, unbound.email), remoteAccount(202, remoteOnlyEmail), remoteAccount(203, missingTaskEmail), remoteAccount(204, null),
  remoteAccount(205, outsideEmail, { group_ids: [8], account_groups: [{ group_id: 8 }], groups: [{ id: 8, name: "Other group" }] }),
  remoteAccount(206, foreignEmail, { extra: { tosub2_cdk_id: "another-cdk" } }),
];
const backend = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture.invalid");
  res.setHeader("content-type", "application/json");
  if (req.headers["x-api-key"] !== secret) { res.writeHead(401); res.end(JSON.stringify({ message: "Invalid synthetic key" })); return; }
  if (req.method !== "GET") { remoteWrites++; res.writeHead(500); res.end(JSON.stringify({ message: "This read-only fixture rejects remote writes" })); return; }
  remoteGets++;
  if (url.pathname === "/api/v1/admin/accounts") {
    const group = url.searchParams.get("group");
    const items = remoteAccounts.filter((account) => (!group || account.group_ids.includes(Number(group)))
      && (!url.searchParams.get("status") || account.status === url.searchParams.get("status")));
    res.end(JSON.stringify({ code: 0, data: { items, total: items.length, page: 1, page_size: 100, pages: 1 } }));
    return;
  }
  const detail = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(url.pathname);
  if (detail) {
    const account = remoteAccounts.find((row) => row.id === Number(detail[1]));
    if (account) { res.end(JSON.stringify({ code: 0, data: account })); return; }
  }
  res.writeHead(404); res.end(JSON.stringify({ message: "Not found" }));
});
await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${backend.address().port}`;
const config = { baseUrl, adminApiKey: secret, groupIds: [7] };
const fingerprint = (value) => crypto.createHmac("sha256", "synthetic-anomaly-fingerprint").update(String(value)).digest("hex").slice(0, 20);

async function writeFixtures() {
  for (const fixture of [...fixtures, unbound, ordinary]) {
    const directory = path.join(root, fixture.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "job-meta.json"), JSON.stringify({ version: 1, email: fixture.email, status: "completed", result_saved: true,
      created_at: "2026-10-30T00:00:00.000Z", last_auth_automated: false }));
    await fs.writeFile(path.join(directory, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", version: 1, proxies: [], accounts: [{
      name: fixture.email, platform: "openai", type: "oauth", concurrency: 1, priority: 0,
      credentials: { email: fixture.email, chatgpt_account_id: `synthetic-account-${fixture.id}`, access_token: "synthetic-local-token" },
    }] }));
  }
}
async function start() {
  workspace = await createConsoleWorkspace({ root, cdkId: owner, namespace: "synthetic-anomaly-test", legacyEmails: new Set(),
    isEnabled: () => true, availableSlots: () => 0, requestSchedule() {},
    readMonitor: async () => savedMonitor, writeMonitor: async (value) => { savedMonitor = structuredClone(value); }, fingerprint,
    credentialVault: { seal: (value) => JSON.stringify(value), open: (value) => JSON.parse(value) },
    remoteBound: (backendIdentity, id) => bindings.has(`${backendIdentity}:${id}`),
    bindRemote: (backendIdentity, id, email) => bindings.set(`${backendIdentity}:${id}`, { remoteId: Number(id), email: email.toLowerCase() }),
    getRemoteBindings: (backendIdentity, email) => [...bindings.entries()].filter(([key, row]) => key.startsWith(`${backendIdentity}:`) && row.email === email.toLowerCase()).map(([, row]) => row),
  });
  workspace.resume();
}
async function call(method, route, body = {}) {
  const response = await workspace.dispatch(method, route, body);
  return JSON.parse(response.body.toString());
}
const report = () => call("GET", "/api/sub2api/monitor/anomalies");
const query = (body) => call("POST", "/api/jobs/query", body);
const checkSafe = (value) => assert.doesNotMatch(JSON.stringify(value), /synthetic-anomaly-(?:admin|access|refresh)-secret|credentials|access_token|refresh_token|another-cdk|foreign-private/);

try {
  await writeFixtures();
  await start();
  const initial = await report();
  assert.equal(initial.available, false, "there is no fake report before a successful scan");
  assert.equal(remoteGets, 0, "loading the saved report never queries remote accounts");
  const monitor = await call("POST", "/api/sub2api/monitor", { enabled: true, config });
  const connectionIdentity = `sub2api-connection-v1:${fingerprint(JSON.stringify({ cdkId: owner, baseUrl, adminApiKey: secret }))}`;
  for (const [index, fixture] of fixtures.entries()) bindings.set(`${index === 0 ? connectionIdentity : monitor.bindingId}:${fixture.remoteId}`, { remoteId: fixture.remoteId, email: fixture.email });
  bindings.set(`${monitor.bindingId}:203`, { remoteId: 203, email: missingTaskEmail });
  const scanned = await call("POST", "/api/sub2api/monitor/check");
  assert.equal(scanned.result.started, 0, "read-only fixture accounts are not eligible for automatic login");
  assert.equal(remoteWrites, 0);
  const afterScanGets = remoteGets;
  const first = await report();
  assert.equal(first.available, true);
  assert.ok(Number.isFinite(Date.parse(first.checkedAt)));
  assert.deepEqual(first.groupIds, [7]);
  assert.equal(first.filterable, 25);
  assert.equal(first.inScope, 30, "the selected-group total does not hide out-of-owner exclusions");
  assert.equal(first.outsideScope, 1, "foreign CDK details are counted without exposure");
  assert.equal(scanned.result.filterable, 25, "the result summary reports linked tasks after scope filtering");
  assert.equal(scanned.result.unlinked, 2);
  assert.equal(scanned.result.missingLocal, 1);
  assert.equal(remoteGets, afterScanGets, "reading anomalies uses the successful saved scan only");
  const linked = first.items.filter((item) => item.status === "linked");
  assert.equal(linked.length, 25);
  assert.deepEqual(new Set(linked.map((item) => item.jobId)), new Set(fixtures.map((fixture) => fixture.id)));
  assert.equal(first.items.find((item) => item.email === unbound.email).status, "unlinked", "a local email alone does not establish association");
  assert.match(first.items.find((item) => item.email === unbound.email).message, /未关联/);
  assert.ok(first.items.find((item) => item.email === unbound.email).message.includes(unbound.email), "the unmatched explanation names the account that could not be filtered");
  assert.equal(first.items.find((item) => item.email === remoteOnlyEmail).status, "unlinked");
  assert.equal(first.items.find((item) => item.email === missingTaskEmail).status, "missing_task");
  assert.ok(first.items.find((item) => item.email === missingTaskEmail).message.includes(missingTaskEmail));
  assert.ok(first.items.some((item) => item.status === "missing_email"));
  assert.ok(!first.items.some((item) => item.email === outsideEmail), "other selected-group scopes are not filter candidates");
  checkSafe(first);
  checkSafe(savedMonitor.state.anomalies);

  const ids = linked.map((item) => item.jobId);
  const firstPage = await query({ page: 1, ids });
  assert.equal(firstPage.jobs.length, 20, "id filtering runs before pagination");
  assert.equal(firstPage.pagination.total, 25);
  assert.equal(firstPage.selection.length, 25, "cross-page selection covers all filtered linked anomaly jobs");
  assert.equal(firstPage.stats.total, 27, "global statistics remain independent of the anomaly filter");
  const secondPage = await query({ page: 2, ids });
  assert.equal(secondPage.jobs.length, 5);
  assert.ok(secondPage.jobs.every((job) => ids.includes(job.id)));
  assert.equal((await query({ ids: [], page: 1 })).pagination.total, 0, "an explicitly empty anomaly id set cannot fall back to all tasks");
  assert.equal((await query({ ids: [crypto.randomUUID()] })).pagination.total, 0, "unknown or another workspace ids never expose unrelated local tasks");
  assert.equal((await query({ ids, search: fixtures[0].email })).pagination.total, 1, "normal search can intersect the saved anomaly result");
  assert.equal((await query({ ids, status: "failed" })).pagination.total, 0, "normal status filters intersect anomaly ids");

  await workspace.shutdown(); workspace = null;
  await start();
  const beforeRestoreRead = remoteGets;
  const restored = await report();
  assert.equal(restored.available, true);
  assert.equal(restored.filterable, 25);
  assert.equal(restored.checkedAt, first.checkedAt);
  assert.equal(remoteGets, beforeRestoreRead, "restart restores the safe report without remote queries");
  checkSafe(restored);

  bindings.set(`${monitor.bindingId}:${fixtures[2].remoteId}`, { remoteId: fixtures[2].remoteId, email: ordinary.email });
  const reassignedNow = await report();
  assert.equal(reassignedNow.items.find((item) => item.remoteId === fixtures[2].remoteId).status, "unlinked", "an id-only binding reassigned to another email cannot authorize the old report email");
  assert.equal(reassignedNow.filterable, 24);
  assert.ok(!reassignedNow.items.some((item) => item.jobId === ordinary.id), "a reassigned remote id never makes an unrelated local account a filter candidate");
  bindings.set(`${monitor.bindingId}:${fixtures[2].remoteId}`, { remoteId: fixtures[2].remoteId, email: fixtures[2].email });

  bindings.delete(`${connectionIdentity}:${fixtures[0].remoteId}`);
  const unboundNow = await report();
  assert.equal(unboundNow.items.find((item) => item.remoteId === fixtures[0].remoteId).status, "unlinked", "report reads revalidate current local bindings");
  assert.equal(unboundNow.filterable, 24);
  await call("POST", "/api/jobs/delete-batch", { ids: [fixtures[1].id] });
  const deletedNow = await report();
  assert.equal(deletedNow.items.find((item) => item.remoteId === fixtures[1].remoteId).status, "missing_task", "a deleted local job is not reported as filterable");
  assert.equal(deletedNow.filterable, 23);
  assert.equal(remoteGets, beforeRestoreRead, "local deletion and binding checks never trigger remote queries");
  await call("POST", "/api/sub2api/monitor", { enabled: true, config: { ...config, groupIds: [8] } });
  assert.equal((await report()).available, false, "changing monitor scope does not present an older report as current");
  assert.equal(remoteWrites, 0);
  console.log("Sub2API anomaly report passed (saved read-only scope, explicit associations, unmatched reasons, persistence, revalidation and cross-page id filtering; synthetic fixtures only)");
} finally {
  await workspace?.shutdown();
  backend.closeAllConnections?.();
  await new Promise((resolve) => backend.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
