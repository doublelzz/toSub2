import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createConsoleWorkspace } from "../src/console-server.mjs";
import { startCdkServer } from "../src/cdk-server.mjs";
import { createTeamClient } from "../src/team-client.mjs";
import { createTeamFixture, fixtureSession, TEAM_A } from "./team-fixture.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-team-console-")), upstream = await createTeamFixture();
const envNames = ["TOSUB2_ADMIN_CDK", "TOSUB2_ENCRYPTION_KEY", "CHATGPT_BASE", "AUTH_BASE", "NODE_ENV", "TOSUB2_TEST_SENTINEL_TOKEN"];
const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
Object.assign(process.env, { TOSUB2_ADMIN_CDK: "team-integration-administrator-fixture", TOSUB2_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
  CHATGPT_BASE: upstream.base, AUTH_BASE: upstream.base, NODE_ENV: "test", TOSUB2_TEST_SENTINEL_TOKEN: "team-fixture-sentinel" });
const wrapper = path.join(root, "team-login-fixture.mjs");
await fs.writeFile(wrapper, `if(!process.argv.includes('--team-login'))process.exit(97);process.argv.push('--native-http');await import(${JSON.stringify(pathToFileURL(path.resolve("src/protocol-login.mjs")).href)});`);
const requests = [];
let app, base, owner, other, credentials, administrator;
async function start() {
  app = await startCdkServer({ emailVerification: false, root, listen: false, createWorkspace: (options) => createConsoleWorkspace({ ...options, protocolScript: wrapper,
    teamClientFactory: (input) => createTeamClient({ ...input, chatgptBase: upstream.base }) }) });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
}
async function login(secret) {
  const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cdk: secret }) });
  assert.equal(response.status, 200); const body = await response.json(); return { cookie: response.headers.get("set-cookie").split(";")[0], token: body.token };
}
async function call(route, body, auth = credentials, extra = {}, method) {
  const response = await fetch(`${base}${route}`, { method: method || (body === undefined ? "GET" : "POST"), headers: { "content-type": "application/json", cookie: auth?.cookie || "", "x-console-token": auth?.token || "", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); requests.push({ route, status: response.status }); return { status: response.status, data };
}
async function waitFor(operation) { const until = Date.now() + 20_000; while (Date.now() < until) { const value = await operation(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error("Team console fixture did not settle"); }
async function add(text, extra = {}) {
  const preview = await call("/api/teams/import/preview", { text, ...extra }); assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const body = { text, digest: preview.data.digest, requestKey: crypto.randomUUID(), ...extra };
  const result = await call("/api/teams/import", body); assert.equal(result.status, 200, JSON.stringify(result.data)); return { result: result.data, body };
}
try {
  await start();
  assert.equal((await call("/api/teams/state")).status, 401);
  [owner, other] = app.store.generate({ count: 2, quota: 10, note: "Team isolated fixtures" }, app.store.adminId);
  const spent = app.store.prepareImport(owner.id, "single", ["previous-import@example.com"], { email: "previous-import@example.com" }, crypto.randomUUID());
  app.store.finishImport(spent, { status: 201, data: { created: true } }, owner.id);
  credentials = await login(owner.secret);
  administrator = await login(process.env.TOSUB2_ADMIN_CDK);
  assert.equal((await call("/api/bootstrap")).data.features.teamManagement, false);
  assert.equal((await call("/api/teams/state")).status, 403);
  assert.equal((await call("/api/imports/preview", { mode: "team", payload: { text: "owner@example.com" } })).status, 403);
  assert.equal((await call(`/api/admin/cdks/${owner.id}`, { teamManagementEnabled: true })).status, 403);
  assert.equal(app.store.get(owner.id).teamManagementEnabled, false);
  assert.equal((await call(`/api/admin/cdks/${owner.id}`, { teamManagementEnabled: "true" }, administrator, {}, "PATCH")).status, 422);
  assert.equal((await call(`/api/admin/cdks/${app.store.adminId}`, { teamManagementEnabled: false }, administrator, {}, "PATCH")).status, 409);
  assert.equal((await call(`/api/admin/cdks/${owner.id}`, { teamManagementEnabled: true }, administrator, {}, "PATCH")).status, 200);
  assert.equal((await call(`/api/admin/cdks/${other.id}`, { teamManagementEnabled: true }, administrator, {}, "PATCH")).status, 200);
  assert.equal((await call("/api/bootstrap")).data.features.teamManagement, true);
  assert.equal((await call("/api/teams/query", {}, credentials, { "x-console-token": "invalid" })).status, 403);
  const ledger = app.store.ledger(owner.id);
  const { result, body } = await add(JSON.stringify(fixtureSession("owner@example.com", upstream.base)));
  assert.deepEqual((await call("/api/teams/import", body)).data.accounts.map((row) => row.id), result.accounts.map((row) => row.id));
  await waitFor(async () => { const data = (await call("/api/teams/state")).data; return data.overview.active === 0 && data.overview.teams === 2 && data; });
  const list = (await call("/api/teams/state")).data, team = list.rows.find((row) => row.workspaceId === TEAM_A);
  assert.equal(team.accounts.length, 1);
  assert.equal((await call(`/api/teams/${team.id}/query`, { search: "member@example.com" })).data.total, 1);
  assert.equal((await call(`/api/teams/${team.id}/invite`, { emails: ["new-integration@example.com"], role: "account-owner", requestKey: crypto.randomUUID() })).status, 200);
  const pending = (await call(`/api/teams/${team.id}/query`, { tab: "invites" })).data;
  assert.equal(pending.total, 1); assert.equal(pending.team.membersTotal, 5);
  assert.equal(pending.items[0].role, "account-owner", "the HTTP invitation endpoint forwards the selected role and refreshes pending invitations");
  const self = await call(`/api/teams/${team.id}/remove`, { memberId: "user-owner", memberEmail: "owner@example.com", requestKey: crypto.randomUUID() });
  assert.equal(self.status, 403);
  const removed = await call(`/api/teams/${team.id}/remove`, { memberId: "user-member", memberEmail: "member@example.com", requestKey: crypto.randomUUID() });
  assert.equal(removed.status, 200); assert.equal(removed.data.success, true);
  const otherAuth = await login(other.secret);
  assert.equal((await call("/api/teams/state", undefined, otherAuth)).data.total, 0);
  assert.equal((await call(`/api/teams/${team.id}/query`, {}, otherAuth)).status, 404);
  assert.equal((await call(`/api/teams/${team.id}/remove`, { memberId: "user-admin", memberEmail: "admin@example.com", requestKey: crypto.randomUUID() }, otherAuth)).status, 404);
  assert.equal((await call("/api/teams/delete", { id: team.id, kind: "team" }, otherAuth)).status, 404);
  assert.equal((await call(`/api/teams/accounts/${result.accounts[0].id}/login`, {}, otherAuth)).status, 404);
  assert.equal(app.store.get(owner.id).balance, 8);
  assert.equal(app.store.ledger(owner.id).length, ledger.length + 1);
  assert.deepEqual((await app.workspaceFor(owner.id)).inventory(), ["owner@example.com"], "Team accounts share the account import billing inventory");
  const repeatText = JSON.stringify(fixtureSession("owner@example.com", upstream.base));
  const repeatPreview = await call("/api/teams/import/preview", { text: repeatText });
  assert.equal(repeatPreview.data.billing.charge, 0); assert.equal(repeatPreview.data.billing.balance, 8);
  await add(repeatText); await waitFor(async () => (await call("/api/teams/state")).data.overview.active === 0);
  assert.equal(app.store.get(owner.id).balance, 8, "new request keys must not charge an already imported email twice");
  assert.doesNotMatch(JSON.stringify(list), /accessToken|fixture-private-access-token|fixture-private-password/);
  // Exercise the real protocol's isolated web-login branch, including manual OTP.
  const loginImport = await add("password-owner@example.com----fixture-private-password");
  await waitFor(async () => (await call("/api/teams/query", { search: "password-owner" })).data.rows.find((row) => row.status === "no_team"));
  assert.ok(upstream.state.requests.some((row) => row.path === "/api/accounts/password/verify"));
  const manual = await add(JSON.stringify({ email: "manual@example.com" }));
  const waiting = await waitFor(async () => (await call("/api/teams/state")).data.tasks.find((row) => row.email === "manual@example.com" && row.status === "waiting_input"));
  assert.equal((await call(`/api/teams/accounts/${manual.result.accounts[0].id}/input`, { promptId: "stale-prompt", value: "001234" })).status, 409);
  assert.equal((await call(`/api/teams/accounts/${manual.result.accounts[0].id}/input`, { promptId: waiting.prompt.id, value: "001234" })).status, 200);
  await waitFor(async () => (await call("/api/teams/query", { search: "manual@example.com" })).data.rows.find((row) => row.status === "no_team"));
  await add(JSON.stringify({ email: "auto@example.com", credentials: { mailApiUrl: `${upstream.base}/mail/team-auto` } }));
  await waitFor(async () => (await call("/api/teams/query", { search: "auto@example.com" })).data.rows.find((row) => row.status === "no_team"));
  assert.ok(upstream.state.requests.some((row) => row.path === "/mail/team-auto"), "mailbox imports can complete login without manual input");
  assert.doesNotMatch(JSON.stringify((await call("/api/teams/state")).data), /001234|fixture-private-password|fixture-private-access-token/);
  assert.equal(upstream.state.requests.some((row) => /oauth\/token|phone|change_email|mfa\/(disable|enroll)|subscriptions\/update/.test(row.path)), false);
  const rootNames = await fs.readdir(root); assert.equal(rootNames.some((name) => name.includes("fixture-private")), false);
  const balanceBeforeDeletion = app.store.get(owner.id).balance, ledgerBeforeDeletion = app.store.ledger(owner.id).length;
  assert.equal((await call("/api/teams/delete", { id: team.id, kind: "team" }, credentials, { "x-console-token": "invalid" })).status, 403);
  const upstreamBeforeDeletion = upstream.state.requests.length;
  assert.equal((await call("/api/teams/delete", { id: team.id, kind: "team" })).data.deleted, 1);
  assert.equal((await call("/api/teams/delete", { id: team.id, kind: "team" })).data.deleted, 0);
  assert.equal(upstream.state.requests.length, upstreamBeforeDeletion, "local deletion must not call upstream");
  assert.equal((await call(`/api/teams/${team.id}/query`, {})).status, 404);
  assert.equal((await call("/api/teams/delete", { id: loginImport.result.accounts[0].id, kind: "account" })).data.deleted, 1);
  assert.equal((await call("/api/teams/state")).data.rows.some((row) => row.id === loginImport.result.accounts[0].id), false);
  assert.equal(app.store.get(owner.id).balance, balanceBeforeDeletion);
  assert.equal(app.store.ledger(owner.id).length, ledgerBeforeDeletion);
  assert.ok((await app.workspaceFor(owner.id)).inventory().includes("owner@example.com"), "deletion preserves billed identities");
  const before = (await call("/api/teams/state")).data.overview.teams;
  await app.close(); await start(); credentials = await login(owner.secret);
  assert.equal((await call("/api/teams/state")).data.overview.teams, before);
  assert.equal((await call("/api/teams/sources")).data.accounts.length, 0);
  assert.equal((await call("/api/teams/sync", { ids: [result.accounts[0].id] })).status, 200);
  await waitFor(async () => (await call("/api/teams/state")).data.overview.active === 0);
  assert.equal((await call("/api/teams/state")).data.overview.teams, before, "sync after restart preserves deletions");
  assert.equal((await call("/api/teams/import/preview", { text: repeatText })).data.billing.charge, 0);
  await add(repeatText);
  await waitFor(async () => { const state = (await call("/api/teams/state")).data; return state.overview.active === 0 && state.overview.teams === 2; });
  assert.equal(app.store.get(owner.id).balance, balanceBeforeDeletion, "restoring management does not charge an imported account again");
  assert.equal(app.store.ledger(owner.id).length, ledgerBeforeDeletion);
  assert.equal(app.store.get(owner.id).balance, 5, "three additional new login accounts each consume one quota");
  const invalidText = JSON.stringify(fixtureSession("invalid-preview@example.com", upstream.base));
  const badImport = await call("/api/teams/import", { text: invalidText, digest: "bad-preview", requestKey: crypto.randomUUID() });
  assert.equal(badImport.status, 409); assert.equal(app.store.get(owner.id).balance, 5); assert.equal(app.store.get(owner.id).reserved, 0);
  assert.equal(app.store.pendingImports().length, 0, "invalid preview rolls back the reservation without locking the workspace");
  const generated = await call("/api/admin/cdks", { count: 1, quota: 1, note: "one remaining credit", teamManagementEnabled: true }, administrator);
  assert.equal(generated.status, 201); const poor = generated.data.items[0], poorAuth = await login(poor.secret);
  const makePoorBody = async (email) => { const text = JSON.stringify(fixtureSession(email, upstream.base)); const preview = await call("/api/teams/import/preview", { text }, poorAuth); assert.equal(preview.data.billing.charge, 1); return { text, digest: preview.data.digest, requestKey: crypto.randomUUID() }; };
  const poorBodies = [await makePoorBody("poor-first@example.com"), await makePoorBody("poor-second@example.com")];
  const concurrent = await Promise.all(poorBodies.map((body) => call("/api/teams/import", body, poorAuth)));
  assert.deepEqual(concurrent.map((row) => row.status).sort(), [200, 409]); assert.equal(app.store.get(poor.id).balance, 0); assert.equal(app.store.get(poor.id).reserved, 0);
  const poorRejected = await call("/api/teams/import/preview", { text: JSON.stringify(fixtureSession("too-many@example.com", upstream.base)) }, poorAuth);
  assert.equal(poorRejected.data.billing.canImport, false); assert.equal(poorRejected.data.billing.after, -1);
  assert.equal(app.store.ledger(poor.id).filter((row) => row.kind === "import").length, 1);
  assert.equal((await call(`/api/admin/cdks/${owner.id}`, { teamManagementEnabled: false }, administrator, {}, "PATCH")).status, 200);
  assert.equal((await call("/api/bootstrap")).data.features.teamManagement, false);
  for (const [route, body] of [["/api/teams/state", undefined], ["/api/teams/import/preview", { text: repeatText }], [`/api/teams/${team.id}/query`, {}], [`/api/teams/${team.id}/role`, {}], ["/api/teams/delete", { id: team.id, kind: "team" }], ["/api/teams/import", {}]]) assert.equal((await call(route, body)).status, 403);
  assert.equal((await call("/api/health")).status, 200);
  const [recoverOwner] = app.store.generate({ count: 1, quota: 2, teamManagementEnabled: true }, app.store.adminId);
  const recoverWorkspace = await app.workspaceFor(recoverOwner.id), recoverText = JSON.stringify(fixtureSession("recovery@example.com", upstream.base));
  const recoverPreview = JSON.parse((await recoverWorkspace.dispatch("POST", "/api/teams/import/preview", { text: recoverText })).body.toString());
  const recoveryBody = { text: recoverText, digest: recoverPreview.digest, requestKey: crypto.randomUUID() };
  app.store.prepareImport(recoverOwner.id, "team", ["recovery@example.com"], recoveryBody, recoveryBody.requestKey, recoverOwner.id);
  await recoverWorkspace.applyImport("team", recoveryBody, recoverOwner.id);
  assert.equal(app.store.get(recoverOwner.id).reserved, 1);
  await app.close(); await start();
  assert.equal(app.store.pendingImports().length, 0, "Team import recovery completes while the startup scheduler is still paused");
  assert.equal(app.store.get(recoverOwner.id).balance, 1); assert.equal(app.store.get(recoverOwner.id).reserved, 0);
  assert.equal(app.store.ledger(recoverOwner.id).filter((row) => row.kind === "import").length, 1);
  console.log("Team console tests passed: CDK menu grants, scoped API denial/revocation, import charging/deduplication, password/OTP/mailbox login, members/invites/removal and restart persistence");
} finally {
  await app?.close(); await upstream.close(); await fs.rm(root, { recursive: true, force: true });
  for (const name of envNames) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
}
