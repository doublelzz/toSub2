import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createTeamClient, normalizeTeamSubscription, discoverTeamAccounts, teamCanRemove, teamIdentity } from "../src/team-client.mjs";
import { createTeamWorkspace, parseTeamEmails } from "../src/team-workspace.mjs";
import { createTeamFixture, fixtureSession, fixtureToken, TEAM_A, TEAM_B } from "./team-fixture.mjs";

assert.deepEqual(parseTeamEmails("A@example.com,a@example.com；b@example.com"), ["a@example.com", "b@example.com"]);
assert.throws(() => parseTeamEmails("invalid"));
assert.throws(() => parseTeamEmails(Array(51).fill(null).map((_, i) => `person-${i}@example.com`)));
const renew = normalizeTeamSubscription({ assigned: { default: 2, prolite: 0 }, seat_capacity: [{ type: "default", paid: 5, available: 1, held: 2 }], maximum_seats: 999,
  entitlement: { renews_at: "2026-12-27T00:00:00Z", expires_at: "2026-12-27T00:00:00Z", discount: { discount_expires_at: "2026-11-28T00:00:00Z" } }, will_renew: true });
assert.equal(renew.pools.default.available, 1, "official available count must not be recomputed from purchased minus used");
assert.equal(renew.pools.prolite.purchased, null, "unknown must not become zero");
assert.equal(renew.event.kind, "renewal"); assert.equal(renew.event.at, "2026-12-27T00:00:00.000Z");
assert.equal(normalizeTeamSubscription({ entitlement: { cancels_at: "2026-12-01T00:00:00Z" }, will_renew: false }).event.kind, "expiry");
assert.equal(normalizeTeamSubscription({ entitlement: { expires_at: "2026-12-01T00:00:00Z" } }, { isTrial: true }).event.kind, "trial");
assert.equal(normalizeTeamSubscription({ active_until: "2026-12-01T00:00:00Z" }).event.kind, "entitlement");
assert.throws(() => teamIdentity(fixtureSession("a@example.com", "https://chatgpt.com"), "b@example.com"), { code: "TEAM_IDENTITY" });
assert.throws(() => teamIdentity(fixtureSession("a@example.com", "https://chatgpt.com", { accessToken: fixtureToken("a@example.com", { exp: 1 }) }), "a@example.com"), { code: "TEAM_AUTH_EXPIRED" });
assert.deepEqual(discoverTeamAccounts({ accounts: { default: { account: { structure: "personal", plan_type: "free" } } } }), []);
assert.throws(() => discoverTeamAccounts({ accounts: { bad: { account: { account_id: "../other", plan_type: "team" } } } }));
const owner = { id: "user-owner", email: "owner@example.com", role: "account-owner" };
assert.equal(teamCanRemove("account-owner", owner, owner), false);
assert.equal(teamCanRemove("account-admin", { id: "other", role: "account-admin", email: "other@example.com" }, owner), false);
assert.equal(teamCanRemove("standard-user", { id: "other", role: "standard-user", email: "other@example.com" }, owner), false);

const fixture = await createTeamFixture(), root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-teams-"));
const previousKey = process.env.TOSUB2_ENCRYPTION_KEY;
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const vault = await createCdkVault(root);
let workspace;
const clientFactory = (options) => createTeamClient({ ...options, chatgptBase: fixture.base });
const parseText = (value) => { const [email, password = "", totpSecret = ""] = value.split("----"); return [{ email, password, totpSecret }]; };
async function waitFor(check) { const until = Date.now() + 8000; while (Date.now() < until) { workspace?.tick(3); const result = check(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 15)); } throw new Error("Team fixture did not settle"); }
async function importSession(email, extra = {}) {
  const text = JSON.stringify(fixtureSession(email, fixture.base)); const preview = workspace.preview({ text, ...extra });
  return workspace.importAccounts({ text, digest: preview.digest, requestKey: crypto.randomUUID(), ...extra }, "fixture-actor");
}
try {
  workspace = await createTeamWorkspace({ root, vault, parseText, clientFactory });
  fixture.state.clamp = 2;
  const imported = await importSession("owner@example.com");
  await waitFor(() => workspace.query().overview.active === 0);
  let state = workspace.query(); assert.equal(state.overview.teams, 2); assert.equal(state.overview.accounts, 1);
  const teamA = state.rows.find((row) => row.workspaceId === TEAM_A), teamB = state.rows.find((row) => row.workspaceId === TEAM_B);
  assert.equal(teamB.membersTotal, 26, "server-clamped pagination must not skip members");
  assert.equal(workspace.detail(teamB.id, { page: 2 }).items.length, 6);
  assert.equal(workspace.detail(teamB.id, { search: "research-24" }).total, 1);
  assert.equal(teamA.capabilities.canInvite, true); assert.equal(teamA.subscription.event.kind, "renewal");
  assert.equal(workspace.query({ expiring: true }).total, 0, "renewals must not count as expiry");
  const select = workspace.detail(teamA.id).items; assert.equal(select.find((row) => row.email === "owner@example.com").canRemove, false);
  assert.equal(select.find((row) => row.email === "other-owner@example.com").canRemove, false);
  assert.equal(select.find((row) => row.email === "member@example.com").canRemove, true);
  const key = crypto.randomUUID();
  const result = await workspace.mutate(teamA.id, { emails: "new@example.com,fail@example.com,member@example.com", requestKey: key }, "fixture-actor", "invite");
  assert.deepEqual(result.results.map((row) => row.status).sort(), ["already_member", "failed", "invited"]);
  assert.equal(workspace.detail(teamA.id).team.membersTotal, 5, "invites cannot change used members");
  assert.equal(workspace.detail(teamA.id).team.pendingInvites, 1);
  const inviteCount = () => fixture.state.requests.filter((row) => row.method === "POST" && row.path.endsWith("/invites")).length;
  const beforeReplay = inviteCount(); assert.deepEqual(await workspace.mutate(teamA.id, { emails: "new@example.com,fail@example.com,member@example.com", requestKey: key }, "fixture-actor", "invite"), result);
  assert.equal(inviteCount(), beforeReplay, "same request cannot replay the upstream mutation");
  await assert.rejects(workspace.mutate(teamA.id, { emails: "different@example.com", requestKey: key }, "fixture-actor", "invite"), /同一请求/);
  const duplicatePreview = workspace.invitePreview(teamA.id, { emails: "new@example.com,member@example.com" }); assert.equal(duplicatePreview.added, 0);
  const removeBody = { memberId: "user-member", memberEmail: "member@example.com", requestKey: crypto.randomUUID() };
  await assert.rejects(workspace.mutate(teamA.id, { ...removeBody, memberEmail: "wrong@example.com" }, "fixture-actor", "remove"), /身份/);
  await workspace.mutate(teamA.id, { ...removeBody, requestKey: crypto.randomUUID() }, "fixture-actor", "remove");
  assert.equal(workspace.detail(teamA.id).team.membersTotal, 4); assert.equal(workspace.detail(teamA.id).team.subscription.pools.default.purchased, 10);
  assert.equal(workspace.detail(teamA.id).team.subscription.pools.default.used, 4);
  await assert.rejects(workspace.mutate(teamA.id, { memberId: "user-owner", memberEmail: "owner@example.com", requestKey: crypto.randomUUID() }, "fixture-actor", "remove"), /不允许移除/);
  const beforeInvalid = workspace.query().overview.accounts;
  assert.throws(() => workspace.preview({ text: JSON.stringify([{ email: "new-owner@example.com" }, fixtureSession("owner@example.com", fixture.base, { email: "wrong@example.com" })]) }));
  assert.equal(workspace.query().overview.accounts, beforeInvalid, "invalid mixed imports must leave state untouched");
  await importSession("other-owner@example.com"); await waitFor(() => workspace.query().overview.active === 0);
  assert.equal(workspace.query().overview.teams, 2, "multiple management accounts must merge by workspace");
  assert.equal(workspace.detail(teamA.id).team.accounts.length, 2);
  const adminClient = await clientFactory({ session: fixtureSession("admin@example.com", fixture.base), email: "admin@example.com" });
  try { const found = await adminClient.discover(); fixture.state.defaultSeat = "prolite"; const snapshot = await adminClient.snapshot(found[0]); assert.equal(snapshot.capabilities.canInvite, false, "admin cannot override a premium default seat"); fixture.state.defaultSeat = "default"; }
  finally { await adminClient.close(); }
  fixture.state.failModule = "subscriptions";
  await workspace.queue({ ids: [imported.accounts[0].id] }, "fixture-actor"); await waitFor(() => workspace.query().overview.active === 0);
  const partial = workspace.detail(teamA.id).team;
  assert.ok(partial.errors.subscription); assert.equal(partial.subscription.pools.default.purchased, 10); assert.equal(partial.capabilities.canInvite, false);
  fixture.state.failModule = "";
  await workspace.queue({ ids: [imported.accounts[0].id] }, "fixture-actor"); await waitFor(() => workspace.query().overview.active === 0);
  const raw = await fs.readFile(path.join(root, "team-space", "state.json"), "utf8");
  assert.doesNotMatch(raw, /fixture-private-access-token|upstream-private-diagnostic/);
  assert.doesNotMatch(JSON.stringify(workspace.query()), /accessToken|totpSecret|fixture-private-access-token/);
  const writes = fixture.state.requests.filter((row) => row.method !== "GET");
  assert.ok(writes.every((row) => /\/invites$|\/users\/user-/.test(row.path)), "no billing, role, password or OAuth mutations");
  assert.ok(fixture.state.requests.every((row) => row.device === "fixture-stable-device"));
  const uncertainKey = crypto.randomUUID(); fixture.state.nextInvite = "disconnect";
  await assert.rejects(workspace.mutate(teamA.id, { emails: "uncertain@example.com", requestKey: uncertainKey }, "fixture-actor", "invite"), { code: "TEAM_NETWORK" });
  const afterUncertain = inviteCount();
  await assert.rejects(workspace.mutate(teamA.id, { emails: "uncertain@example.com", requestKey: uncertainKey }, "fixture-actor", "invite"), /同步核对/);
  assert.equal(inviteCount(), afterUncertain);
  await assert.rejects(workspace.mutate(teamA.id, { emails: "uncertain@example.com", requestKey: crypto.randomUUID() }, "fixture-actor", "invite"), /尚未确认/);
  await workspace.queue({ ids: [imported.accounts[0].id] }, "fixture-actor"); await waitFor(() => workspace.query().overview.active === 0);
  const reconciled = await workspace.mutate(teamA.id, { emails: "uncertain@example.com", requestKey: uncertainKey }, "fixture-actor", "invite");
  assert.equal(reconciled.reconciled, true); assert.equal(inviteCount(), afterUncertain, "read synchronization reconciles an uncertain write without replaying it");
  await workspace.shutdown();
  workspace = await createTeamWorkspace({ root, vault, parseText, clientFactory });
  assert.equal(workspace.query().overview.teams, 2); assert.equal(workspace.detail(teamA.id).team.accounts.length, 2);
  await workspace.invalidate("owner@example.com"); assert.equal(workspace.query().overview.expired, 1);
  await assert.rejects(workspace.mutate(teamA.id, { emails: "never@example.com", requestKey: crypto.randomUUID() }, "fixture-actor", "invite"), { code: "TEAM_AUTH_EXPIRED" });
  let releaseSource;
  const sourceReady = new Promise((resolve) => { releaseSource = resolve; });
  const raceRoot = path.join(root, "invalidate-race");
  const racing = await createTeamWorkspace({ root: raceRoot, vault, parseText, clientFactory,
    listSources: () => [{ id: "authorization:fixture-race", email: "owner@example.com", sources: ["authorization"] }],
    resolveSource: () => sourceReady });
  try {
    const body = { sourceIds: ["authorization:fixture-race"] }, view = racing.preview(body);
    await racing.importAccounts({ ...body, digest: view.digest, requestKey: crypto.randomUUID() }, "fixture-actor");
    racing.tick(1); await racing.invalidate("owner@example.com");
    const beforeRace = fixture.state.requests.length;
    releaseSource({ session: fixtureSession("owner@example.com", fixture.base), credentials: {} });
    const until = Date.now() + 5000;
    while (racing.query().rows[0].busy && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(racing.query().rows[0].status, "auth_expired"); assert.equal(fixture.state.requests.length, beforeRace);
    const storedRace = JSON.parse(await fs.readFile(path.join(raceRoot, "team-space", "state.json"), "utf8"));
    assert.equal(vault.open(storedRace.accounts[0].secret, `account:${storedRace.accounts[0].id}`).session, null, "an interrupted discovery cannot restore an invalidated session");
  } finally { releaseSource(null); await racing.shutdown(); }
  console.log("Team workspace tests passed: identity, encrypted persistence, pagination, merged spaces, role/seat checks, partial success, idempotency, removal protection, stale sections and uncertain writes");
} finally { await workspace?.shutdown(); await fixture.close(); await fs.rm(root, { recursive: true, force: true }); if (previousKey === undefined) delete process.env.TOSUB2_ENCRYPTION_KEY; else process.env.TOSUB2_ENCRYPTION_KEY = previousKey; }
