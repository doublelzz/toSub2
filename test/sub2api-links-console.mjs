import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createConsoleWorkspace } from "../src/console-server.mjs";

// Everything in this test, including OAuth tokens and upstream accounts, is synthetic.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-sub2api-links-"));
const owner = "synthetic-links-owner";
const authClaim = "https://api.openai.com/auth";
const fixtures = Object.fromEntries(["existing", "renamed", "ambiguous", "foreign", "identity", "new", "partial-new", "query-failed", "detail-race", "html"].map((name) => [name, {
  id: crypto.randomUUID(), email: `${name}@links.example.invalid`, accountId: `fixture-account-${name}`,
}]));
const secrets = ["synthetic-links-admin-key", "synthetic-links-admin-key-B", "fixture-refresh-secret", "fixture-access-secret", "upstream-secret-field"];
const bindings = new Map();
const remote = new Map();
const requests = [];
let created = 0;
let updated = 0;
let nextId = 200;
let listFailureEmail = "";
let listHtmlEmail = "";
let detailRaceId = 0;
let workspace;

const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture-access-secret`;
function credentials(fixture) {
  return { email: fixture.email, access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 86400, [authClaim]: { chatgpt_account_id: fixture.accountId } }),
    refresh_token: "fixture-refresh-secret", chatgpt_account_id: fixture.accountId };
}
function account(id, name, patch = {}) {
  const fixture = fixtures[name];
  return { id, name: fixture.email, platform: "openai", type: "oauth", credentials: { ...credentials(fixture), upstream_only: "upstream-secret-field" },
    extra: { retained: "preserve-me" }, status: "disabled", schedulable: false, concurrency: 8, priority: 3, proxy_id: 19,
    group_ids: [7], account_groups: [{ group_id: 7 }], groups: [{ id: 7, name: "Fixture group" }], ...patch };
}
remote.set(91, account(91, "existing"));
remote.set(92, account(92, "ambiguous"));
remote.set(93, account(93, "ambiguous"));
remote.set(94, account(94, "foreign", { extra: { tosub2_cdk_id: "another-cdk" } }));
remote.set(95, account(95, "identity", { credentials: { ...credentials(fixtures.identity), chatgpt_account_id: "different-real-account" } }));
remote.set(96, account(96, "detail-race"));
remote.set(98, account(98, "renamed", { name: "User renamed this upstream record" }));

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function respond(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: status === 200 ? 0 : status, data, ...(status === 200 ? {} : { message: "fixture upstream unavailable" }) }));
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://fixture.invalid");
    const route = url.pathname;
    requests.push({ method: req.method, route, query: Object.fromEntries(url.searchParams) });
    if (!secrets.slice(0, 2).includes(req.headers["x-api-key"])) return respond(res, null, 401);
    if (req.method === "GET" && route === "/api/v1/admin/accounts") {
      const search = String(url.searchParams.get("search") || "").toLowerCase();
      if (listFailureEmail && (!search || search === listFailureEmail)) return respond(res, null, 503);
      if (listHtmlEmail && (!search || search === listHtmlEmail)) { res.writeHead(200, { "content-type": "text/html" }); res.end("<!DOCTYPE html><title>fixture gateway</title>"); return; }
      const items = [...remote.values()].filter((row) => (!search || String(row.name).toLowerCase().includes(search))
        && (!url.searchParams.get("platform") || row.platform === url.searchParams.get("platform"))
        && (!url.searchParams.get("type") || row.type === url.searchParams.get("type")));
      return respond(res, { items, total: items.length, page: 1, page_size: 100, pages: 1 });
    }
    if (req.method === "GET" && route === "/api/v1/admin/groups/all") return respond(res, [{ id: 7, name: "Fixture group", platform: "openai" }]);
    const detail = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(route);
    if (detail && req.method === "GET") {
      const id = Number(detail[1]);
      const row = remote.get(id);
      if (!row) return respond(res, null, 404);
      return respond(res, id === detailRaceId ? { ...row, credentials: { ...row.credentials, chatgpt_account_id: "identity-changed-after-list" } } : row);
    }
    if (detail && req.method === "PUT") {
      const id = Number(detail[1]);
      const row = remote.get(id);
      if (!row) return respond(res, null, 404);
      const patch = await readJson(req);
      updated++;
      remote.set(id, { ...row, ...patch });
      return respond(res, remote.get(id));
    }
    if (req.method === "POST" && route === "/api/v1/admin/accounts/batch") {
      const body = await readJson(req);
      const results = body.accounts.map((row) => { const id = nextId++; created++; remote.set(id, { id, ...row,
        groups: (row.group_ids || []).map((groupId) => ({ id: groupId, name: "Fixture group" })) }); return { name: row.name, id, success: true }; });
      return respond(res, { success: results.length, failed: 0, results });
    }
    respond(res, null, 404);
  } catch (error) { respond(res, { message: String(error.message) }, 500); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const config = { baseUrl, adminApiKey: secrets[0], groupIds: [], codexFingerprintMode: "off" };
const fingerprint = (value) => crypto.createHmac("sha256", "synthetic-links-fingerprint").update(String(value)).digest("hex").slice(0, 20);

async function writeFixtures(folder) {
  for (const fixture of Object.values(fixtures)) {
    const directory = path.join(folder, fixture.id);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", version: 1, proxies: [], accounts: [{
      name: fixture.email, platform: "openai", type: "oauth", credentials: credentials(fixture), concurrency: 1, priority: 0,
    }] }));
    await fs.writeFile(path.join(directory, "job-meta.json"), JSON.stringify({ version: 1, email: fixture.email, status: "completed", result_saved: true, created_at: new Date().toISOString() }));
  }
}
async function start(ownerId = owner, workspaceOptions = {}) {
  const folder = path.join(root, ownerId);
  await writeFixtures(folder);
  return createConsoleWorkspace({ root: folder, cdkId: ownerId, namespace: "synthetic-links-test", legacyEmails: new Set(),
    isEnabled: () => true, availableSlots: () => 20, requestSchedule() {}, readMonitor: async () => null, writeMonitor: async () => {}, fingerprint,
    getRemoteBindings: (backend, email) => [...bindings.values()].filter((row) => row.ownerId === ownerId && row.backend === backend && (!email || row.email === email.toLowerCase())).map(({ remoteId, email }) => ({ remoteId, email })),
    bindRemote: (backend, id, email) => bindings.set(`${ownerId}:${backend}:${id}`, { ownerId, backend, remoteId: Number(id), email: email.toLowerCase() }),
    remoteBound: (backend, id) => bindings.has(`${ownerId}:${backend}:${id}`),
    ...workspaceOptions,
  });
}
async function call(route, name = "existing", override = {}, extra = {}) {
  const names = Array.isArray(name) ? name : [name];
  const response = await workspace.dispatch("POST", route, { ids: names.map((value) => fixtures[value].id), config: { ...config, ...override }, ...extra });
  return JSON.parse(response.body.toString());
}
const preview = (name, override) => call("/api/sub2api/upload-preview", name, override);
const confirm = (plan, name, override) => call("/api/sub2api/upload", name, override, { previewToken: plan.previewToken });
const push = async (name, override) => {
  const plan = await preview(name, override);
  return plan.canPush ? confirm(plan, name, override) : { preview: plan, result: { success: 0 } };
};
const links = (name, override) => call("/api/sub2api/links", name, override);
const successful = (result) => Number(result.uploaded || result.created || result.updated || result.result?.success || 0) > 0;
const assertSafe = (value) => { const text = JSON.stringify(value); for (const secret of secrets) assert.ok(!text.includes(secret), "public responses cannot contain upstream credentials"); assert.ok(!text.includes("access_token") && !text.includes("refresh_token"), "public responses contain metadata only"); };

try {
  workspace = await start();
  assert.equal(workspace.publicJobs().length, Object.keys(fixtures).length, "completed fixtures restore without starting account workflows");
  const beforeLinks = { created, updated, bindings: bindings.size };
  const initial = await links("existing");
  assert.equal(initial.items.length, 1);
  assert.notEqual(initial.items[0].status, "linked", "an email match alone is not an already confirmed link");
  assert.deepEqual({ created, updated, bindings: bindings.size }, beforeLinks, "reading links cannot mutate upstream accounts or confirmed bindings");
  assertSafe(initial);

  await assert.rejects(() => call("/api/sub2api/upload", "existing"), (error) => error.status === 409, "direct upload without preview confirmation is rejected");
  assert.deepEqual({ created, updated, bindings: bindings.size }, beforeLinks, "missing confirmation cannot mutate upstream accounts or bindings");
  const canceledPlan = await preview(["existing", "new", "ambiguous"]);
  assert.equal(canceledPlan.created, 1);
  assert.equal(canceledPlan.updated, 1);
  assert.equal(canceledPlan.blocked, 1);
  assert.equal(canceledPlan.rows.find((row) => row.id === fixtures.existing.id).remoteId, 91);
  assert.equal(canceledPlan.rows.find((row) => row.id === fixtures.new.id).action, "create");
  assert.equal(canceledPlan.rows.find((row) => row.id === fixtures.ambiguous.id).action, "blocked");
  assert.ok(canceledPlan.previewToken && Number.isFinite(Date.parse(canceledPlan.expiresAt)));
  assert.deepEqual({ created, updated, bindings: bindings.size }, beforeLinks, "canceling after preflight leaves accounts and bindings untouched");
  assertSafe(canceledPlan);
  await assert.rejects(() => confirm(canceledPlan, ["new", "existing", "ambiguous"]), (error) => error.status === 409, "reordering the selected accounts invalidates the preview mapping");
  const blockedPlan = await preview("ambiguous");
  assert.equal(blockedPlan.canPush, false);
  await assert.rejects(() => confirm(blockedPlan, "ambiguous"), (error) => error.status === 409, "a preview with no executable rows cannot be confirmed");
  assert.deepEqual({ created, updated, bindings: bindings.size }, beforeLinks);

  const idsPlan = await preview("existing");
  await assert.rejects(() => confirm(idsPlan, "renamed"), (error) => error.status === 409, "confirmation cannot replace the previewed local account ids");
  const configPlan = await preview("existing");
  await assert.rejects(() => confirm(configPlan, "existing", { groupIds: [8] }), (error) => error.status === 409, "configuration changes require a new preview");
  const localPlan = await preview("existing");
  const existingExportPath = path.join(root, owner, fixtures.existing.id, "sub2api-import-oauth.json");
  const existingExport = await fs.readFile(existingExportPath, "utf8");
  const changedExport = JSON.parse(existingExport);
  changedExport.accounts[0].priority = 9;
  await fs.writeFile(existingExportPath, JSON.stringify(changedExport));
  await assert.rejects(() => confirm(localPlan, "existing"), (error) => error.status === 409, "changed local authorization data invalidates its old preview");
  await fs.writeFile(existingExportPath, existingExport);
  assert.deepEqual({ created, updated, bindings: bindings.size }, beforeLinks, "rejected stale preview confirmations perform no writes");

  const firstPlan = await preview("existing");
  const first = await confirm(firstPlan, "existing");
  assert.equal(created, 0, "an existing unique matching identity is updated instead of duplicated");
  assert.equal(updated, 1);
  assert.ok(successful(first));
  assert.equal(remote.get(91).status, "disabled", "pushing credentials preserves administrator-disabled status");
  assert.equal(remote.get(91).schedulable, false, "pushing credentials does not restore scheduling implicitly");
  assert.equal(remote.get(91).proxy_id, 19, "empty configuration preserves the remote proxy");
  assert.deepEqual(remote.get(91).group_ids, [7], "empty group selection preserves existing remote groups");
  assert.equal(remote.get(91).extra.retained, "preserve-me");
  assertSafe(first);
  await assert.rejects(() => confirm(firstPlan, "existing"), (error) => error.status === 409, "a successful confirmation token cannot be replayed");
  assert.equal(updated, 1, "replaying a consumed token cannot repeat the update");
  const linked = await links("existing");
  assert.equal(linked.items[0].status, "linked");
  assert.equal(linked.items[0].accounts[0].id, 91);
  assert.ok(linked.items[0].accounts[0].groups.some((group) => group.id === 7 && group.name === "Fixture group"));
  assertSafe(linked);

  const policyChanged = await links("existing", { groupIds: [8], concurrency: "12", proxyId: "27" });
  assert.equal(policyChanged.items[0].status, "linked", "changing routing policy preserves the confirmed connection association");
  assert.deepEqual(policyChanged.items[0].accounts[0].groups, [{ id: 7, name: "Fixture group" }], "the association column reports remote groups rather than configured upload target groups");

  const renamed = await push("renamed");
  assert.ok(successful(renamed));
  assert.equal(created, 0, "upstream name-only search must not miss an account renamed by its administrator");
  assert.equal(updated, 2);
  assert.equal(remote.get(98).name, "User renamed this upstream record", "credential updates preserve the upstream display name");

  remote.set(97, account(97, "existing"));
  const legacy = [...bindings.values()].find((row) => row.ownerId === owner && row.email === fixtures.existing.email && !row.backend.startsWith("sub2api-connection-v1:"));
  bindings.set(`${owner}:${legacy.backend}:97`, { ...legacy, remoteId: 97 });
  assert.equal((await links("existing")).items[0].accounts[0].id, 91, "confirmed connection bindings take precedence over stale monitor associations");
  await push("existing");
  assert.equal(created, 0, "an explicit binding survives a later duplicate email upstream");
  assert.equal(updated, 3, "repeated pushes update the confirmed remote id");
  assert.equal(remote.get(97).extra.tosub2_cdk_id, undefined, "the unrelated duplicate is not claimed");

  for (const name of ["ambiguous", "foreign", "identity"]) {
    const before = { created, updated };
    const result = await push(name);
    assert.equal(successful(result), false, `${name} does not report a successful push`);
    assert.deepEqual({ created, updated }, before, `${name} rejects updates and duplicate creation`);
    assertSafe(result);
  }

  const added = await push("new");
  assert.ok(successful(added));
  assert.equal(created, 1, "only an absent account is created");
  await push("new");
  assert.equal(created, 1, "a second push of a new account reuses its saved association");
  assert.equal((await links("new")).items[0].status, "linked");

  const beforeFailure = { created, updated };
  listFailureEmail = fixtures["query-failed"].email;
  await push("query-failed").catch(() => null);
  listFailureEmail = "";
  listHtmlEmail = fixtures.html.email;
  await push("html").catch(() => null);
  listHtmlEmail = "";
  assert.deepEqual({ created, updated }, beforeFailure, "failed or non-JSON searches never fall through to account creation");
  const racePlan = await preview("detail-race");
  assert.equal(racePlan.rows[0].action, "update");
  detailRaceId = 96;
  const raced = await confirm(racePlan, "detail-race");
  assert.equal(successful(raced), false);
  assert.deepEqual({ created, updated }, beforeFailure, "remote identity is revalidated immediately before PUT");
  detailRaceId = 0;

  const partialPlan = await preview(["partial-new", "ambiguous"]);
  assert.equal(partialPlan.created, 1);
  assert.equal(partialPlan.blocked, 1);
  const beforePartial = created;
  const partial = await confirm(partialPlan, ["partial-new", "ambiguous"]);
  assert.equal(partial.created, 1);
  assert.equal(created, beforePartial + 1, "only executable preview rows reach the upstream create endpoint");
  assert.equal([...remote.values()].filter((row) => row.credentials.email === fixtures.ambiguous.email).length, 2, "blocked duplicate candidates remain unchanged");
  assertSafe(partial);

  const changedKey = await links("existing", { adminApiKey: secrets[1] });
  assert.notEqual(changedKey.items[0].status, "linked", "changing credentials cannot display old confirmed bindings as current");
  assertSafe(changedKey);
  await workspace.shutdown(); workspace = null;
  workspace = await start();
  assert.equal((await links("new")).items[0].status, "linked", "confirmed associations survive workspace restart");
  const otherWorkspacePlan = await preview("existing");
  await workspace.shutdown(); workspace = null;
  workspace = await start("another-local-cdk");
  const beforeCrossToken = { created, updated, bindings: bindings.size };
  await assert.rejects(() => confirm(otherWorkspacePlan, "existing"), (error) => error.status === 409, "preview tokens are scoped to their original CDK workspace");
  assert.deepEqual({ created, updated, bindings: bindings.size }, beforeCrossToken);
  const crossOwner = await links("new");
  assert.notEqual(crossOwner.items[0].status, "linked", "same local email in another CDK cannot reuse the original CDK association");
  const beforeForeign = { created, updated };
  const rejected = await push("new");
  assert.equal(successful(rejected), false);
  assert.deepEqual({ created, updated }, beforeForeign, "another CDK cannot overwrite or duplicate the first CDK's remote account");
  assertSafe(crossOwner); assertSafe(rejected);
  await workspace.shutdown(); workspace = null;
  workspace = await start(owner, { sub2ApiUploadPreviewTtlMs: 0 });
  const expiredPlan = await preview("existing");
  const beforeExpired = { created, updated, bindings: bindings.size };
  await assert.rejects(() => confirm(expiredPlan, "existing"), (error) => error.status === 409, "expired previews cannot authorize a push");
  assert.deepEqual({ created, updated, bindings: bindings.size }, beforeExpired);
  assert.ok(!requests.some((request) => /clear-error|schedulable|oauth|refresh/.test(request.route)), "explicit pushes perform no login, token refresh, error clearing, or scheduling recovery");
  console.log("Sub2API links console passed (identity upsert, repeat push, conflicts, CDK isolation, read-only metadata, failure guards, and restart; synthetic fixtures only)");
} finally {
  await workspace?.shutdown(); server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
