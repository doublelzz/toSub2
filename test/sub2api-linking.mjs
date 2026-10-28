import assert from "node:assert/strict";
import { createSub2ApiLinker } from "../src/sub2api-linking.mjs";

const ownerId = "fixture-owner";
const email = "link@example.invalid";
const config = { baseUrl: "http://fixture.invalid", adminApiKey: "synthetic-admin-key", groupIds: [], proxyId: 0, concurrency: null, loadFactor: null, priority: null, modelWhitelist: [] };
const local = (overrides = {}) => ({ id: "local-job", email, account: { name: email, platform: "openai", type: "oauth", concurrency: 10, priority: 0,
  credentials: { email, chatgpt_account_id: "fixture-account", chatgpt_user_id: "fixture-user", access_token: "synthetic-new-token", refresh_token: "synthetic-new-refresh", model_mapping: { local: "local" } }, extra: { tosub2_config_id: "fixture-config" }, ...overrides } });
const remote = (id = 41, overrides = {}) => ({ id, name: email, platform: "openai", type: "oauth", status: "disabled", schedulable: false, proxy_id: 6,
  credentials: { email, chatgpt_account_id: "fixture-account", chatgpt_user_id: "fixture-user", access_token: "synthetic-old-token", refresh_token: "synthetic-old-refresh", model_mapping: { keep: "keep" } },
  extra: { keep: "existing-extra" }, group_ids: [7], groups: [{ id: 7, name: "Existing group" }], ...overrides });

function fixture(initial = []) {
  const accounts = new Map(initial.map((row) => [row.id, structuredClone(row)]));
  const bindings = new Map(); const calls = []; let invalidList = false; let failList = false; let beforeWriteDetail; let noCreateId = false; let pageSize = 100; let reportedTotal; let failWrite = false;
  let nextId = 100;
  const getBindings = (cfg, value) => bindings.get(value) || [];
  const bindRemote = async (cfg, id, value) => bindings.set(value, [{ remoteId: id }]);
  const request = async (cfg, path, options = {}) => {
    const method = options.method || "GET"; const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method, body, headers: options.headers });
    const url = new URL(path, cfg.baseUrl);
    if (method === "GET" && url.pathname === "/api/v1/admin/accounts") {
      if (failList) throw Error("fixture disconnected");
      if (invalidList) return null;
      const search = url.searchParams.get("search"); const rows = [...accounts.values()].filter((row) => !search || row.name.toLowerCase().includes(search.toLowerCase())); const page = Number(url.searchParams.get("page"));
      return { code: 0, data: { items: rows.slice((page - 1) * pageSize, page * pageSize), total: reportedTotal ?? rows.length, pages: Math.max(1, Math.ceil(rows.length / pageSize)) } };
    }
    const detail = /^\/api\/v1\/admin\/accounts\/(\d+)$/.exec(url.pathname);
    if (method === "GET" && detail) {
      const id = Number(detail[1]); if (beforeWriteDetail) beforeWriteDetail(accounts, id);
      if (!accounts.has(id)) throw Object.assign(Error("not found"), { remoteStatus: 404 });
      return { code: 0, data: structuredClone(accounts.get(id)) };
    }
    if (method === "PUT" && detail) {
      if (failWrite) throw Error('fixture network lost access_token: "remote-secret-token"');
      const id = Number(detail[1]); accounts.set(id, { ...accounts.get(id), ...structuredClone(body) });
      return { code: 0, data: structuredClone(accounts.get(id)) };
    }
    if (method === "POST" && url.pathname === "/api/v1/admin/accounts/batch") {
      if (failWrite) throw Error('fixture network lost refresh_token="remote-secret-refresh"');
      const results = [];
      for (const row of body.accounts) {
        const id = nextId++; accounts.set(id, { ...structuredClone(row), id });
        results.push({ name: row.name, id, success: true });
      }
      return { code: 0, data: { success: results.length, failed: 0, results: noCreateId ? [] : results } };
    }
    throw Error(`Unexpected fixture request ${method} ${path}`);
  };
  return { accounts, bindings, calls, linker: createSub2ApiLinker({ request, ownerId, getBindings, bindRemote }), set invalidList(value) { invalidList = value; }, set failList(value) { failList = value; }, set beforeWriteDetail(value) { beforeWriteDetail = value; }, set noCreateId(value) { noCreateId = value; }, set pageSize(value) { pageSize = value; }, set reportedTotal(value) { reportedTotal = value; }, set failWrite(value) { failWrite = value; } };
}

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions++; };
const writes = (f) => f.calls.filter((call) => call.method !== "GET");

{
  const f = fixture([remote()]);
  const before = await f.linker.inspect(config, [local()]);
  assert.equal(before.items[0].status, "unlinked"); assert.deepEqual(before.items[0].accounts, []);
  check(f.bindings.size === 0 && writes(f).length === 0, "reading a candidate never establishes binding or writes remotely");
  check(f.calls.length === 0, "unlinked metadata does not scan remote accounts before an explicit push preflight");
  const result = await f.linker.push(config, [local()]);
  check(result.updated === 1 && result.created === 0, "same identity updates the existing remote ID instead of creating a duplicate");
  const put = writes(f)[0];
  check(put.path.endsWith("/41") && writes(f).length === 1, "an existing account uses one PUT and never batch creation, clear-error or schedulable");
  check(!Object.hasOwn(put.body, "group_ids") && !Object.hasOwn(put.body, "proxy_id") && !Object.hasOwn(put.body, "status") && !Object.hasOwn(put.body, "schedulable"), "unspecified groups/proxy and scheduling state are preserved");
  assert.deepEqual(put.body.credentials.model_mapping, { keep: "keep" });
  assert.equal(put.body.extra.keep, "existing-extra"); assert.equal(put.body.extra.tosub2_cdk_id, ownerId);
  assert.equal(f.accounts.get(41).status, "disabled"); assert.equal(f.accounts.get(41).schedulable, false);
  const after = await f.linker.inspect(config, [local()]);
  check(after.items[0].status === "linked" && after.items[0].accounts[0].id === 41, "successful explicit push persists a confirmed association with groups");
  check(!/synthetic-new-token|synthetic-old-token|synthetic-admin-key/.test(JSON.stringify(after)), "link display does not return API keys or remote credentials");
}

{
  const f = fixture();
  const [first, second] = await Promise.all([f.linker.push(config, [local()]), f.linker.push(config, [local()])]);
  check(first.created + second.created === 1 && first.updated + second.updated === 1, "concurrent pushes for an email serialize create then update");
  check(f.accounts.size === 1 && writes(f).filter((call) => call.method === "POST").length === 1, "concurrent pushes cannot create two remote accounts");
  const post = writes(f).find((call) => call.method === "POST");
  check(/^tosub2-create-[a-f0-9]+$/.test(post.headers["Idempotency-Key"]), "creation carries a stable opaque idempotency key");
}

for (const candidate of [remote(41, { credentials: { email, chatgpt_account_id: "different-account" } }), remote(41, { extra: { tosub2_cdk_id: "other-cdk" } }), remote(41, { type: "apikey" }), remote(41, { credentials: { email } })]) {
  const f = fixture([candidate]); const result = await f.linker.push(config, [local()]);
  check(result.failed === 1 && writes(f).length === 0, "same email with wrong identity, ownership, type or missing identity cannot be overwritten or duplicated");
}

{
  const f = fixture([remote(41), remote(42)]); f.pageSize = 1;
  const result = await f.linker.push(config, [local()]);
  check(result.failed === 1 && writes(f).length === 0, "duplicates on a later page block both update and creation");
  check(f.calls.some((call) => call.path.includes("page=2")), "candidate detection exhausts all search pages");
  f.bindings.set(email, [{ remoteId: 42 }]);
  const explicit = await f.linker.push(config, [local()]);
  check(explicit.updated === 1 && writes(f)[0].path.endsWith("/42"), "an explicit valid binding selects its ID despite other same-email records");
}

{
  const f = fixture([remote(41, { name: "other@example.invalid", credentials: { email: "other@example.invalid", chatgpt_account_id: "other-account" } })]);
  const result = await f.linker.push(config, [local()]);
  check(result.created === 1, "fuzzy search results for another full email are never mistaken for the target account");
}

{
  const f = fixture([remote(41, { name: "Renamed account" })]);
  const result = await f.linker.push(config, [local()]);
  check(result.updated === 1 && result.created === 0, "name-only official search cannot hide an account whose credentials email matches");
  check(!f.calls.some((call) => call.path.includes("search=")), "identity matching reads full pages instead of relying on name-only search");
}

for (const decoratedName of [`oauth---${email}`, `Alias alias@example.invalid for ${email}`]) {
  const f = fixture([remote(41, { name: decoratedName })]);
  const record = local(); record.account.name = decoratedName;
  const result = await f.linker.push(config, [record]);
  check(result.updated === 1 && result.created === 0, "explicit credentials email takes precedence over display-name prefixes and alias decoration");
}

{
  const f = fixture([remote(41, { extra: { email: "different@example.invalid" } })]);
  const result = await f.linker.push(config, [local()]);
  check(result.failed === 1 && writes(f).length === 0, "contradicting credentials.email and extra.email still blocks association");
}

{
  const f = fixture(); const record = local(); record.account.name = `oauth---${email}`; record.account.load_factor = 100;
  const result = await f.linker.push({ ...config, loadFactor: 100 }, [record]);
  check(result.created === 1 && result.unknown === 0, "created decorated account names do not block load-factor verification against the returned credentials email");
}

{
  const f = fixture([remote(41), remote(42, { name: "Renamed duplicate" })]);
  const result = await f.linker.push(config, [local()]);
  check(result.failed === 1 && writes(f).length === 0, "a renamed same-email duplicate cannot be missed by candidate discovery");
}

for (const malformed of [true, false]) {
  const f = fixture(); if (malformed) f.invalidList = true; else f.failList = true;
  const result = await f.linker.push(config, [local()]);
  check(result.failed === 1 && writes(f).length === 0, "invalid JSON or failed account search is never treated as an empty remote pool");
}

{
  const f = fixture(); f.reportedTotal = 1;
  const result = await f.linker.push(config, [local()]);
  check(result.failed === 1 && writes(f).length === 0, "nonzero total with missing account rows is never treated as an empty remote pool");
}

for (const initial of [[], [remote()]]) {
  const f = fixture(initial); f.failWrite = true;
  const result = await f.linker.push(config, [local()]);
  check(result.unknown === 1 && result.failed === 0, "a network failure after sending a create or update has an unknown result");
  check(!/remote-secret-token|remote-secret-refresh/.test(JSON.stringify(result)), "upstream error token fields are removed from public failure messages");
}

{
  const firstEmail = "first@example.invalid", secondEmail = "second@example.invalid";
  const f = fixture([remote(41, { name: firstEmail, credentials: { ...remote().credentials, email: firstEmail } }), remote(42, { name: secondEmail, credentials: { ...remote().credentials, email: secondEmail } })]);
  const records = [firstEmail, secondEmail].map((value, i) => { const row = local(); row.id = `local-${i}`; row.email = value; row.account.name = value; row.account.credentials.email = value; return row; });
  const result = await f.linker.push(config, records);
  check(result.updated === 2 && f.calls.filter((call) => call.path.includes("accounts?")).length === 1, "one batch reuses a single full candidate snapshot for its accounts");
}

{
  const f = fixture([remote()]); let reads = 0;
  f.bindings.set(email, [{ remoteId: 41 }]);
  f.beforeWriteDetail = (accounts, id) => { if (++reads === 2) accounts.get(id).extra.tosub2_cdk_id = "other-cdk"; };
  const result = await f.linker.push(config, [local()]);
  check(result.failed === 1 && writes(f).length === 0, "a fresh detail read catches ownership changes before writing credentials");
}

{
  const f = fixture(); f.bindings.set(email, [{ remoteId: 41 }]);
  const inspected = await f.linker.inspect(config, [local()]);
  check(inspected.items[0].status === "missing", "a deleted bound account is displayed as missing");
  const result = await f.linker.push(config, [local()]);
  check(result.failed === 1 && writes(f).length === 0, "deleted explicit bindings are not silently replaced by a new account");
}

{
  const f = fixture(); f.noCreateId = true;
  const result = await f.linker.push(config, [local()]);
  check(result.unknown === 1 && result.created === 0 && f.bindings.size === 0, "success counters without a remote ID cannot produce a false association");
}

{
  const f = fixture([remote()]);
  const selected = { ...config, groupIds: [9], proxyId: 8, concurrency: 0, priority: 0, loadFactor: 100, modelWhitelist: ["allowed"] };
  const record = local(); record.account.credentials.model_mapping = { allowed: "allowed" };
  const result = await f.linker.push(selected, [record]); const put = writes(f)[0];
  check(result.updated === 1 && put.body.proxy_id === 8 && put.body.concurrency === 0 && put.body.priority === 0 && put.body.load_factor === 100, "explicit configuration overrides are applied including numeric zero");
  assert.deepEqual(put.body.group_ids, [9]); assert.deepEqual(put.body.credentials.model_mapping, { allowed: "allowed" });
}

{
  const f = fixture(); const record = local(); record.account.load_factor = 100;
  const result = await f.linker.push({ ...config, loadFactor: 100 }, [record]);
  check(result.created === 1 && writes(f).some((call) => call.method === "PUT" && call.body.load_factor === 100), "new batch accounts receive load factor through the official update endpoint");
}

{
  const f = fixture([remote()]); const record = local();
  const plan = await f.linker.preview(config, [record]);
  check(plan.items[0].action === "update" && plan.items[0].remoteId === 41 && plan.targets[0].remoteId === 41, "preview reports an existing update target with its groups and confirmation target");
  check(plan.items[0].groups[0].name === "Existing group" && typeof plan.targets[0].fingerprint === "string", "preview contains group metadata and an opaque target fingerprint");
  check(writes(f).length === 0 && f.bindings.size === 0, "preview performs only GET requests without establishing bindings");
  check(!/synthetic-new-token|synthetic-old-token|synthetic-admin-key|chatgpt_account_id|refresh_token/.test(JSON.stringify(plan)), "public and internal preview targets do not contain plaintext credentials");
  const result = await f.linker.push(config, [record], { targets: plan.targets });
  check(result.updated === 1 && result.created === 0, "a confirmed unchanged preview updates the reviewed target");
}

{
  const f = fixture(); const record = local();
  const plan = await f.linker.preview(config, [record]);
  check(plan.items[0].action === "create" && writes(f).length === 0, "preview labels a genuinely absent account as create without changing upstream");
  const result = await f.linker.push(config, [record], { targets: plan.targets });
  check(result.created === 1 && result.updated === 0, "confirmation of an unchanged create preview creates exactly one account");
}

{
  const f = fixture(); const record = local();
  const plan = await f.linker.preview(config, [record]);
  f.accounts.set(41, remote());
  const result = await f.linker.push(config, [record], { targets: plan.targets });
  check(result.failed === 1 && writes(f).length === 0 && /重新预检/.test(result.results[0].message), "a new remote match after create preview cannot silently turn confirmation into an update");
}

for (const change of ["delete", "duplicate", "identity", "groups", "proxy", "status", "owner", "replace-id"]) {
  const f = fixture([remote()]); const record = local();
  const plan = await f.linker.preview(config, [record]);
  if (change === "delete") f.accounts.delete(41);
  if (change === "duplicate") f.accounts.set(42, remote(42));
  if (change === "identity") f.accounts.get(41).credentials.chatgpt_account_id = "changed-identity";
  if (change === "groups") { f.accounts.get(41).group_ids = [9]; f.accounts.get(41).groups = [{ id: 9, name: "Changed group" }]; }
  if (change === "proxy") f.accounts.get(41).proxy_id = 99;
  if (change === "status") f.accounts.get(41).status = "error";
  if (change === "owner") f.accounts.get(41).extra.tosub2_cdk_id = "other-cdk";
  if (change === "replace-id") { f.accounts.delete(41); f.accounts.set(42, remote(42)); }
  const result = await f.linker.push(config, [record], { targets: plan.targets });
  check(result.failed === 1 && writes(f).length === 0 && /重新预检/.test(result.results[0].message), `a remote ${change} after update preview blocks the confirmed write`);
}

{
  const f = fixture([remote()]); const record = local();
  const plan = await f.linker.preview(config, [record]);
  f.beforeWriteDetail = (accounts, id) => { accounts.get(id).group_ids = [9]; };
  const result = await f.linker.push(config, [record], { targets: plan.targets });
  check(result.failed === 1 && writes(f).length === 0, "the final detail fetch revalidates preview groups even after the confirmation search finished");
}

{
  const f = fixture([remote(41), remote(42)]); const record = local();
  const plan = await f.linker.preview(config, [record]);
  check(plan.items[0].action === "blocked" && plan.targets[0].action === "blocked", "ambiguous targets are blocked in the preview");
  f.accounts.delete(42);
  const result = await f.linker.push(config, [record], { targets: plan.targets });
  check(result.failed === 1 && writes(f).length === 0, "a blocked preview never becomes a write even if its conflict later disappears");
}

{
  const f = fixture([remote()]); const record = local();
  const result = await f.linker.push(config, [record], { targets: [] });
  check(result.failed === 1 && writes(f).length === 0, "a missing confirmed target cannot bypass preview validation");
}

{
  const remoteCount = 20_000, selectedCount = 500;
  const rows = Array.from({ length: remoteCount }, (_, index) => {
    const value = `bulk-${index}@example.invalid`;
    return remote(index + 1, { name: `Renamed ${index}`, credentials: { ...remote().credentials, email: value } });
  });
  const f = fixture(rows);
  const records = Array.from({ length: selectedCount }, (_, index) => {
    const record = local(); const value = `bulk-${index}@example.invalid`;
    record.id = `bulk-job-${index}`; record.email = value; record.account.name = value; record.account.credentials.email = value;
    return record;
  });
  const inspectStart = performance.now();
  const inspected = await f.linker.inspect(config, records);
  const inspectMs = performance.now() - inspectStart;
  check(inspected.items.length === selectedCount && inspected.items.every((item) => item.status === "unlinked") && f.calls.length === 0, "500 unlinked rows produce no remote list or detail requests even against a 20k-account pool");
  const previewStart = performance.now();
  const plan = await f.linker.preview(config, records);
  const previewMs = performance.now() - previewStart;
  check(plan.items.length === selectedCount && plan.items.every((item) => item.action === "update"), "large preflight resolves all 500 selected renamed accounts");
  const lists = f.calls.filter((call) => call.path.includes("accounts?"));
  const details = f.calls.filter((call) => /^\/api\/v1\/admin\/accounts\/\d+$/.test(call.path));
  check(lists.length === remoteCount / 100 && details.length === selectedCount, "20k-account preflight reads exactly 200 pages once plus one fresh detail per selected target");
  check(writes(f).length === 0 && f.bindings.size === 0, "large preflight creates no accounts or bindings");
  console.log(`[info] Synthetic scaling only: remote=${remoteCount}, selected=${selectedCount}, inspect=${inspectMs.toFixed(1)}ms/0 requests, preflight=${previewMs.toFixed(1)}ms/${lists.length} list + ${details.length} detail requests; excludes network and is not a live SLA.`);
}

console.log(`[ok] Sub2API linking: ${assertions} assertions; exact identity upsert, explicit bindings, duplicate conflicts, group preservation, pagination, failure safety and concurrent idempotency; synthetic fixtures only.`);
