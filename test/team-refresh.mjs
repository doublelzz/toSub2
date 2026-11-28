import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createTeamWorkspace } from "../src/team-workspace.mjs";
import { createTeamClient } from "../src/team-client.mjs";
import { createTeamFixture, fixtureSession, TEAM_A } from "./team-fixture.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-team-refresh-")), fixture = await createTeamFixture();
const previousKey = process.env.TOSUB2_ENCRYPTION_KEY;
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const vault = await createCdkVault(root);
let workspace;
const writes = () => fixture.state.requests.filter((row) => row.method !== "GET");
const key = () => crypto.randomUUID();
async function wait() {
  const until = Date.now() + 5000;
  while (Date.now() < until) { workspace.tick(3); if (!workspace.query().overview.active && !workspace.activeCount()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("Team refresh fixture did not settle");
}
try {
  fixture.state.spaces.get(TEAM_A).purchased = 30;
  workspace = await createTeamWorkspace({ root, vault, parseText: () => [], refreshRetryDelayMs: 0,
    clientFactory: (input) => createTeamClient({ ...input, chatgptBase: fixture.base }) });
  const text = JSON.stringify(["owner@example.com", "admin@example.com", "member@example.com"].map((email) => fixtureSession(email, fixture.base)));
  const preview = workspace.preview({ text });
  const imported = await workspace.importAccounts({ text, digest: preview.digest, requestKey: key() }, "fixture-actor"); await wait();
  const owner = imported.accounts.find((row) => row.email === "owner@example.com"), admin = imported.accounts.find((row) => row.email === "admin@example.com"), member = imported.accounts.find((row) => row.email === "member@example.com");
  const team = workspace.query().rows.find((row) => row.workspaceId === TEAM_A);
  const elevated = { accountId: admin.id, role: "account-owner", emails: ["not-authorized@example.com"] };
  assert.equal(workspace.invitePreview(team.id, elevated).canInvite, false);
  assert.deepEqual(workspace.detail(team.id, { accountId: admin.id }).team.capabilities.inviteRoleChoices, ["standard-user"]);
  await assert.rejects(workspace.mutate(team.id, { ...elevated, requestKey: key() }, "fixture-actor", "invite"), { status: 403 });
  await assert.rejects(workspace.mutate(team.id, { ...elevated, role: "invalid", requestKey: key() }, "fixture-actor", "invite"), { status: 422 });
  assert.equal(writes().length, 0, "unauthorized roles must never reach the upstream write endpoint");
  for (const [index, role] of ["standard-user", "account-admin", "account-owner"].entries()) {
    const body = { accountId: owner.id, role, emails: [`role-${index}@example.com`], requestKey: key() };
    const view = workspace.invitePreview(team.id, body); assert.equal(view.canInvite, true); assert.equal(view.role, role);
    fixture.state.nextInviteLagReads = 2;
    const before = writes().length;
    const result = await workspace.mutate(team.id, body, "fixture-actor", "invite");
    assert.equal(result.results[0].status, "invited"); assert.equal(result.role, role);
    assert.deepEqual(result.refreshErrors, {}); assert.equal(result.verifying, undefined);
    assert.equal(writes().length, before + 1, "lag retries must only read, never resend invitations");
    assert.equal(writes().at(-1).body.role, role);
    for (const account of imported.accounts) {
      const detail = workspace.detail(team.id, { accountId: account.id, tab: "invites" });
      assert.equal(detail.total, index + 1); assert.equal(detail.items.find((row) => row.email === body.emails[0]).role, role);
      assert.deepEqual(detail.team.errors, {}, "all management accounts share refreshed team data");
    }
    await workspace.mutate(team.id, body, "fixture-actor", "invite"); assert.equal(writes().length, before + 1);
    await assert.rejects(workspace.mutate(team.id, { ...body, role: role === "account-owner" ? "standard-user" : "account-owner" }, "fixture-actor", "invite"), { status: 409 });
  }
  fixture.state.nextRoleLagReads = 2;
  const promoted = await workspace.mutate(team.id, { accountId: owner.id, memberId: "user-admin", memberEmail: admin.email, previousRole: "account-admin", role: "account-owner", requestKey: key() }, "fixture-actor", "role");
  assert.equal(promoted.verifying, undefined); assert.deepEqual(promoted.refreshErrors, {});
  assert.equal(workspace.detail(team.id, { accountId: admin.id }).team.capabilities.canChangeRoles, true);
  const beforeSwitch = fixture.state.requests.length;
  await workspace.selectAccount(team.id, admin.id, "fixture-actor");
  assert.equal(fixture.state.requests.length, beforeSwitch, "switching to the newly promoted owner needs no manual recognition");
  assert.equal(workspace.detail(team.id).team.capabilities.canChangeRoles, true);
  const demoted = await workspace.mutate(team.id, { accountId: owner.id, memberId: "user-owner", memberEmail: owner.email, previousRole: "account-owner", role: "standard-user", requestKey: key() }, "fixture-actor", "role");
  assert.equal(demoted.selfChanged, true);
  assert.equal(workspace.detail(team.id, { accountId: owner.id }).team.capabilities.canChangeRoles, false);
  assert.equal(workspace.detail(team.id).items.find((row) => row.email === owner.email).role, "standard-user");
  fixture.state.nextRoleLagReads = 8;
  const beforeDelayed = writes().length;
  const delayed = await workspace.mutate(team.id, { accountId: admin.id, memberId: "user-member", memberEmail: member.email, previousRole: "standard-user", role: "account-owner", requestKey: key() }, "fixture-actor", "role");
  assert.equal(delayed.verifying, true); assert.ok(delayed.refreshErrors.refresh);
  assert.equal(writes().length, beforeDelayed + 1, "an unconfirmed refresh must not repeat the role mutation");
  fixture.state.staleCollections.clear();
  await workspace.queue({ ids: [admin.id] }, "fixture-actor"); await wait();
  for (const account of imported.accounts) {
    const detail = workspace.detail(team.id, { accountId: account.id });
    assert.deepEqual(detail.team.errors, {});
    assert.equal(detail.items.find((row) => row.email === member.email).role, "account-owner");
  }
  assert.equal(workspace.detail(team.id, { accountId: member.id }).team.capabilities.canChangeRoles, true);
  assert.equal(writes().length, beforeDelayed + 1);
  console.log("Team refresh passed: selected invite roles, permission guards, delayed read visibility, one write per action, refreshed peer snapshots and self-demotion permissions");
} finally {
  await workspace?.shutdown(); await fixture.close(); await fs.rm(root, { recursive: true, force: true });
  if (previousKey === undefined) delete process.env.TOSUB2_ENCRYPTION_KEY; else process.env.TOSUB2_ENCRYPTION_KEY = previousKey;
}
