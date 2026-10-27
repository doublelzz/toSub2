import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { checkOffer, classifyOffer, OFFER_CAMPAIGNS, offerProtocolFailure } from "../src/offer-checker.mjs";
import { createOfferWorkspace, parseOfferImport } from "../src/offer-workspace.mjs";

const identity = { email: "fixture@example.com", accountId: "personal-id" };
const response = (campaign = null, extra = {}) => ({ accounts: { unrelated: { account: { account_id: "team-id", plan_type: "plus" } },
  "personal-id": { account: { account_id: "personal-id", plan_type: "free", ...extra }, eligible_promo_campaigns: campaign ? { plus: { id: campaign } } : {} } } });
for (const [campaign, kind] of Object.entries(OFFER_CAMPAIGNS)) assert.equal(classifyOffer(response(campaign), identity).kind, kind);
assert.equal(classifyOffer(response(), identity).kind, "none");
assert.equal(classifyOffer(response("unknown-offer"), identity).kind, "other");
assert.equal(classifyOffer(response("plus-1-month-free", { plan_type: "pro" }), identity).kind, "subscribed");
assert.equal(classifyOffer(response("plus-1-month-free", { is_deactivated: true }), identity).kind, "banned");
assert.throws(() => classifyOffer({ accounts: { other: { account: { plan_type: "free" }, eligible_promo_campaigns: {} } } }, identity), /身份/);
assert.throws(() => classifyOffer({ accounts: { "personal-id": { account: { plan_type: "free" } } } }, identity), /响应/);
// A single verified account may be returned under both an alias and its ID.
const personal = response("plus-1-month-free").accounts["personal-id"];
for (const accounts of [{ default: personal, "personal-id": personal }, { "personal-id": personal, default: personal },
  { team: response().accounts.unrelated, default: personal, alias: personal, "PERSONAL-ID": personal }]) {
  assert.equal(classifyOffer({ accounts }, identity).kind, "trial_1m");
}
assert.equal(classifyOffer({ accounts: { default: { ...personal, account: { ...personal.account, name: "default display" } }, "personal-id": personal } }, identity).kind, "trial_1m", "display metadata does not change the same account conclusion");
assert.equal(classifyOffer({ accounts: { "personal-id": { ...personal, account: { plan_type: "free" } } } }, identity).kind, "trial_1m", "exact map key supports an omitted inner ID");
for (const other of [response().accounts["personal-id"], response("plus-2-months-50-pct-off").accounts["personal-id"],
  response("plus-1-month-free", { plan_type: "plus" }).accounts["personal-id"]]) {
  assert.throws(() => classifyOffer({ accounts: { default: personal, "personal-id": other } }, identity),
    (error) => error.offerCode === "invalid_response" && error.offerStage === "account_alias_conflict", "conflicting aliases must not choose whichever offer is preferred");
}
assert.throws(() => classifyOffer({ accounts: { default: personal, "personal-id": { ...personal, account: { account_id: "another-account", plan_type: "free" } } } }, identity),
  (error) => error.offerCode === "identity_mismatch" && error.offerStage === "offer_response", "canonical map key cannot conceal a different explicit account ID");
for (const accounts of [{ default: { account: { plan_type: "free" }, eligible_promo_campaigns: {} } },
  { default: { ...personal, account: { account_id: "team-id", plan_type: "free" } } }]) {
  assert.throws(() => classifyOffer({ accounts }, identity), (error) => error.offerCode === "identity_mismatch" && error.offerStage === "offer_response");
}
for (const account of [null, [], { account_id: {}, plan_type: "free" }]) {
  assert.throws(() => classifyOffer({ accounts: { "personal-id": { account, eligible_promo_campaigns: {} } } }, identity), (error) => error.offerCode === "invalid_response");
}
const token = `e30.${Buffer.from(JSON.stringify({ email: identity.email, exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: identity.accountId } })).toString("base64url")}.fixture`;
const session = { type: "chatgpt-session", version: 1, email: identity.email, accessToken: token };
await assert.rejects(checkOffer(session, identity.email, async () => ({ status: 403, body: { error: { code: "forbidden" } } })), (failure) => failure.offerCode === "forbidden");
await assert.rejects(checkOffer(session, "wrong@example.invalid", () => { throw Error("no request should be made"); }), (failure) => failure.offerCode === "identity_mismatch" && failure.offerStage === "session_identity");
await assert.rejects(checkOffer(session, identity.email, async () => ({ status: 403, body: {} })), (failure) => failure.offerStage === "offer_request");
assert.equal((await checkOffer(session, identity.email, async () => ({ status: 403, body: { error: { code: "account_deactivated" } } }))).kind, "banned");
for (const [message, proxy, expected] of [
  ["DNSError: curl: (6) Could not resolve host: fixture.invalid", true, "proxy_dns"],
  ["Could not resolve host: fixture.invalid", false, "network_dns"],
  ["Failed to perform, curl: (56) CONNECT tunnel failed, response 407", true, "proxy_connection"],
  ["Failed to perform, curl: (28) Operation timed out", true, "network_timeout"],
  ["PROXY_RISK_CONTROL: security-check page", true, "forbidden"],
  ["Password was rejected", true, "login_failed"],
]) {
  const failure = offerProtocolFailure(new Error(`${message} PRIVATE_DIAGNOSTIC_SHOULD_NOT_ESCAPE`), "login", proxy);
  assert.equal(failure.offerCode, expected); assert.equal(failure.offerStage, "login");
  assert.doesNotMatch(failure.message, /PRIVATE_DIAGNOSTIC|fixture\.invalid|407/);
}
const parseText = (value) => value.split("\n").map((line) => { const [email, password = ""] = line.split("----"); if (!email.includes("@")) throw Error(); return { email, password }; });
assert.equal(parseOfferImport("a@example.com----private-password\na@example.com----second", parseText).duplicateCount, 1);
assert.throws(() => parseOfferImport('{"type":"sub2api-data"}', parseText), /列表/);

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-offer-unit-"));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const vault = await createCdkVault(root);
let allowed = true; let workspace; let promptMode = false; let hold = false; const executions = [];
const result = (email) => ({ kind: email.startsWith("half") ? "half_2m" : "none", campaignId: "", planType: "free", checkedAt: new Date().toISOString() });
const runner = (payload, callbacks) => {
  executions.push(payload.email);
  let resolve; let reject; const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  callbacks.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  if (promptMode && payload.email.startsWith("manual")) callbacks.onPrompt({ kind: "email", id: "challenge-one" });
  else if (!hold) resolve(result(payload.email));
  return { done, reply: (id, value) => { assert.equal(id, "challenge-one"); assert.equal(value, "001234"); resolve(result(payload.email)); } };
};
const wait = async (predicate) => { for (let step = 0; step < 150; step++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw Error("fixture state timed out"); };
async function start(text, options = {}) { const preview = workspace.preview({ text }); return workspace.start({ text, digest: preview.digest, requestKey: crypto.randomUUID(), maxRetries: 0, ...options }); }
try {
  workspace = await createOfferWorkspace({ root, vault, parseText, canUse: () => allowed, runAccount: runner });
  const raw = Array.from({ length: 25 }, (_, index) => `${index < 22 ? "half" : "none"}${index}@example.com----fixture-private-password`).join("\n");
  const run = await start(raw);
  for (let step = 0; step < 30 && workspace.list().batches[0].status === "running"; step++) { assert.ok(workspace.tick(20) <= 3); await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.equal(workspace.list().batches[0].counts.completed, 25);
  assert.equal(workspace.list().batches[0].offers, 22);
  assert.equal(workspace.query(run.id, { kinds: ["half_2m"], page: 2 }).items.length, 2);
  assert.equal(workspace.query(run.id, { search: "half" }).total, 22);
  assert.equal(workspace.exportContent(run.id, { filters: { kinds: ["half_2m"] } }).count, 22, "export covers every filtered page");
  const selectedId = workspace.query(run.id).items[0].id;
  assert.equal(workspace.exportContent(run.id, { ids: [selectedId] }).count, 1);
  assert.throws(() => workspace.exportContent(run.id, { ids: [crypto.randomUUID()] }), /不存在/);
  assert.doesNotMatch(JSON.stringify(workspace.list()) + JSON.stringify(workspace.query(run.id)), /fixture-private-password/);
  for (const format of ["accounts", "report", "csv", "json"]) assert.ok(workspace.exportContent(run.id, { format }).content);
  promptMode = true;
  const manual = await start("manual@example.com----password\nother@example.com----password", { concurrency: 1 });
  workspace.tick(1); await wait(() => workspace.query(manual.id).items[0].status === "waiting_input");
  assert.equal(workspace.activeCount(), 0, "waiting input releases global execution capacity");
  assert.equal(workspace.tick(1), 1, "next account can execute while input is pending");
  await wait(() => workspace.query(manual.id).items[1].status === "completed");
  const row = workspace.query(manual.id).items[0];
  assert.throws(() => workspace.input(manual.id, row.id, { promptId: "old", value: "001234" }), /变化/);
  workspace.input(manual.id, row.id, { promptId: "challenge-one", value: "001234" });
  workspace.tick(1); await wait(() => workspace.query(manual.id).items[0].status === "completed");
  assert.doesNotMatch(JSON.stringify(workspace.query(manual.id)), /001234/);
  const repeated = await workspace.recheck(run.id, { filters: { search: "none" }, requestKey: crypto.randomUUID() });
  assert.equal(repeated.total, 3); assert.equal(workspace.exportContent(repeated.id, {}).content.split("\n")[0], "none22@example.com----fixture-private-password"); await workspace.stop(repeated.id);
  hold = true;
  const blocked = await start("held@example.com----private-password", { concurrency: 1 });
  workspace.tick(1); await wait(() => executions.includes("held@example.com"));
  allowed = false; workspace.tick(0);
  for (const action of [() => workspace.list(), () => workspace.preview({ text: raw }), () => workspace.query(blocked.id), () => workspace.exportContent(run.id, {})]) assert.throws(action, (failure) => failure.status === 403);
  await new Promise((resolve) => setTimeout(resolve, 20)); allowed = true;
  assert.equal(workspace.query(blocked.id).batch.status, "paused");
  assert.equal(workspace.query(blocked.id).items[0].status, "interrupted");
  await workspace.shutdown();
  workspace = await createOfferWorkspace({ root, vault, parseText, canUse: () => allowed, runAccount: runner });
  assert.equal(workspace.query(blocked.id).items[0].status, "interrupted");
  assert.equal(workspace.tick(), 0, "restart cannot silently replay login operations");
  await workspace.shutdown(); workspace = null;
  const database = await fs.readFile(path.join(root, "offers/offers.sqlite"));
  assert.equal(database.includes(Buffer.from("fixture-private-password")), false, "private imports remain encrypted on disk");
  console.log("offer workspace passed (classifications, exact identity, batch statistics, filtered export, manual input slots, balance gate and restart)");
} finally { await workspace?.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
