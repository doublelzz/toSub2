import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createTeamWorkspace } from "../src/team-workspace.mjs";
import { createTeamClient } from "../src/team-client.mjs";
import { createTeamFixture, fixtureSession, TEAM_A, TEAM_B } from "./team-fixture.mjs";

const fixture = await createTeamFixture(), root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-team-deletion-"));
const previousKey = process.env.TOSUB2_ENCRYPTION_KEY;
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const vault = await createCdkVault(root);
let workspace, snapshotGate;
const options = { root, vault, parseText: (email) => [{ email }], clientFactory: async (input) => {
  const client = await createTeamClient({ ...input, chatgptBase: fixture.base });
  const snapshot = client.snapshot.bind(client);
  client.snapshot = async (...args) => {
    if (snapshotGate) { const gate = snapshotGate; snapshotGate = null; gate.started(); await gate.pending; }
    return snapshot(...args);
  };
  return client;
} };
async function add(email) {
  const text = JSON.stringify(fixtureSession(email, fixture.base));
  const preview = workspace.preview({ text }), body = { text, digest: preview.digest, requestKey: crypto.randomUUID() };
  return { ...(await workspace.importAccounts(body, "fixture-actor")), body };
}
async function wait() {
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    workspace.tick(3);
    if (workspace.query().overview.active === 0 && workspace.activeCount() === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Team deletion fixture did not settle");
}
try {
  workspace = await createTeamWorkspace(options);
  const owner = await add("owner@example.com"), admin = await add("admin@example.com"); await wait();
  const team = workspace.query().rows.find((row) => row.workspaceId === TEAM_A);
  const second = workspace.query().rows.find((row) => row.workspaceId === TEAM_B);
  assert.equal(team.accounts.length, 2); assert.equal(team.canDelete, true);
  await workspace.queue({ ids: [admin.accounts[0].id] }, "fixture-actor");
  assert.equal(workspace.detail(team.id).team.canDelete, false, "all linked accounts must be idle, including a nonselected account");
  await assert.rejects(workspace.deleteRecord({ kind: "team", id: team.id }), { status: 409 });
  await workspace.cancel(admin.accounts[0].id);
  await workspace.queue({ ids: [admin.accounts[0].id] }, "fixture-actor"); await wait();
  await assert.rejects(workspace.deleteRecord({ kind: "account", id: owner.accounts[0].id }), { status: 409 });
  let release, started;
  const pending = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { started = resolve; });
  snapshotGate = { pending, started };
  const invitation = workspace.mutate(team.id, { emails: ["local-deletion-invite@example.com"], requestKey: crypto.randomUUID() }, "fixture-actor", "invite");
  try {
    await entered;
    assert.equal(workspace.detail(team.id).team.canDelete, false);
    await assert.rejects(workspace.deleteRecord({ kind: "team", id: team.id }), { status: 409 });
  } finally { release(); await invitation; }
  // An import queued before deletion must not restore a team deleted afterward.
  await add("viewer@example.com");
  const upstreamBefore = fixture.state.requests.length;
  const storedBefore = JSON.parse(await fs.readFile(path.join(root, "team-space/state.json"), "utf8"));
  assert.equal((await workspace.deleteRecord({ kind: "team", id: team.id })).deleted, 1);
  assert.equal(fixture.state.requests.length, upstreamBefore, "local deletion must not call the upstream service");
  assert.equal((await workspace.deleteRecord({ kind: "team", id: team.id })).deleted, 0, "deletion retries are harmless");
  assert.throws(() => workspace.detail(team.id), { status: 404 });
  const storedAfter = JSON.parse(await fs.readFile(path.join(root, "team-space/state.json"), "utf8"));
  assert.equal(storedAfter.teams.some((row) => row.id === team.id), false);
  assert.equal(storedAfter.requests.some((row) => row.teamId === team.id), false);
  assert.deepEqual(storedAfter.accounts.map((row) => row.secret), storedBefore.accounts.map((row) => row.secret), "deletion preserves encrypted credentials");
  await wait();
  assert.equal(workspace.query().total, 1); assert.equal(workspace.query().overview.accounts, 1);
  assert.equal(workspace.query().rows[0].workspaceId, TEAM_B);
  assert.equal(workspace.query().rows[0].accounts[0].id, owner.accounts[0].id);
  assert.deepEqual(workspace.inventory().sort(), ["owner@example.com", "admin@example.com", "viewer@example.com"].sort());
  const beforeSync = fixture.state.requests.length;
  await workspace.queue({ ids: [owner.accounts[0].id] }, "fixture-actor"); await wait();
  assert.equal(workspace.query().total, 1, "ordinary synchronization must not resurrect a deleted team");
  assert.equal(fixture.state.requests.slice(beforeSync).some((row) => row.workspace === TEAM_A || row.path.includes(TEAM_A)), false, "deleted teams receive no snapshot requests");
  await workspace.shutdown(); workspace = await createTeamWorkspace(options);
  assert.equal(workspace.query().total, 1, "deletion survives restart");
  assert.equal((await workspace.deleteRecord({ kind: "team", id: second.id })).deleted, 1);
  assert.equal(workspace.query().total, 0); assert.equal(workspace.query().overview.accounts, 0);
  assert.equal(workspace.query().tasks.length, 0, "hidden accounts must not reappear as login tasks");
  await assert.rejects(workspace.queue({ ids: [owner.accounts[0].id] }, "fixture-actor"), { status: 409 });
  await workspace.importAccounts(owner.body, "fixture-actor");
  assert.equal(workspace.query().total, 0, "replaying an old import must not restore a deleted record");
  await add("owner@example.com"); await wait();
  assert.equal(workspace.query().overview.teams, 2, "an explicit new import restores management");
  assert.equal(workspace.query().overview.accounts, 1);
  const isolated = await add("unrelated@example.com");
  await assert.rejects(workspace.deleteRecord({ kind: "account", id: isolated.accounts[0].id }), { status: 409 });
  await wait();
  const row = workspace.query().rows.find((row) => row.kind === "account");
  assert.equal(row.canDelete, true);
  const accountRequests = fixture.state.requests.length;
  await workspace.deleteRecord({ kind: "account", id: row.id });
  assert.equal(fixture.state.requests.length, accountRequests);
  assert.equal(workspace.query().rows.some((item) => item.id === row.id), false);
  assert.ok(workspace.hasAccount("unrelated@example.com"));
  await assert.rejects(workspace.deleteRecord({ kind: "team", id: crypto.randomUUID() }), { status: 404 });
  await assert.rejects(workspace.deleteRecord({ kind: "invalid", id: row.id }), { status: 400 });
  await workspace.shutdown(); workspace = await createTeamWorkspace(options);
  assert.equal(workspace.query().total, 2); assert.equal(workspace.query().overview.accounts, 1);
  console.log("Team deletion passed: local-only deletion, shared credentials, busy guards, persistent suppression, import races/replay/restoration and unrecognized account records");
} finally {
  await workspace?.shutdown(); await fixture.close(); await fs.rm(root, { recursive: true, force: true });
  if (previousKey === undefined) delete process.env.TOSUB2_ENCRYPTION_KEY; else process.env.TOSUB2_ENCRYPTION_KEY = previousKey;
}
