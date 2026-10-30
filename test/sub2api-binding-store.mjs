import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createCdkStore } from "../src/cdk-store.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-sub2api-binding-store-"));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-sub2api-binding-administrator";
const vault = await createCdkVault(root);
let store = await createCdkStore(root, vault);
try {
  const admin = store.authenticate(process.env.TOSUB2_ADMIN_CDK);
  const [first, second] = store.generate({ count: 2, quota: 1, note: "Synthetic binding fixtures" }, admin.id);
  const email = "binding@example.invalid";
  store.bindRemote(first.id, "connection-A", 91, email);
  store.bindRemote(first.id, "connection-B", 92, email);
  store.bindRemote(second.id, "connection-A", 93, email);
  assert.deepEqual(store.getRemoteBindings(first.id, "connection-A", email.toUpperCase()), [{ remoteId: 91, email }]);
  assert.deepEqual(store.getRemoteBindings(first.id, "connection-A", "other@example.invalid"), []);
  assert.deepEqual(store.getRemoteBindings(first.id, "unknown", email), []);
  assert.deepEqual(store.getRemoteBindings(second.id, "connection-A", email), [{ remoteId: 93, email }]);
  store.bindRemote(first.id, "connection-A", 94, email);
  assert.equal(store.getRemoteBindings(first.id, "connection-A", email).length, 2, "legacy ambiguous associations remain visible for explicit resolution");
  store.replaceRemoteBinding(first.id, "connection-A", 94, email.toUpperCase());
  assert.deepEqual(store.getRemoteBindings(first.id, "connection-A", email), [{ remoteId: 94, email }]);
  assert.deepEqual(store.getRemoteBindings(first.id, "connection-B", email), [{ remoteId: 92, email }]);
  assert.deepEqual(store.getRemoteBindings(second.id, "connection-A", email), [{ remoteId: 93, email }]);
  store.close();
  const legacy = new DatabaseSync(path.join(root, ".cdk", "cdk.sqlite"));
  legacy.exec("DROP TABLE sub2api_link_snapshots"); legacy.close();
  store = await createCdkStore(root, vault);
  assert.deepEqual(store.getRemoteBindings(first.id, "connection-A", email), [{ remoteId: 94, email }], "resolved association survives reopening the SQLite store");
  assert.equal(store.remoteBound(first.id, "connection-A", 91), false);
  assert.equal(store.remoteBound(first.id, "connection-A", 94), true);
  assert.deepEqual(store.getSub2ApiLinkSnapshots(first.id, "connection-A", [email]), [], "opening an existing schema adds the snapshot table without changing bindings");
  const checkedAt = "2026-10-30T03:04:05.000Z";
  const snapshot = { email: "ignored@example.invalid", status: "linked", message: "已关联", checkedAt, metadataComplete: true,
    bindingIds: [94, 94, null, -1], adminApiKey: "snapshot-secret-admin-key", credentials: { access_token: "snapshot-secret-access" },
    accounts: [{ id: 94, platform: "openai", type: "oauth", status: "active", schedulable: false, proxyId: 7,
      concurrency: 0, loadFactor: null, priority: 0, groups: [{ id: 3, name: "Snapshot plus", credentials: "snapshot-group-secret" }],
      credentials: { access_token: "snapshot-secret-access" }, extra: { private: "snapshot-extra-secret" } }] };
  store.saveSub2ApiLinkSnapshot(first.id, "connection-A", email.toUpperCase(), snapshot);
  store.saveSub2ApiLinkSnapshot(first.id, "connection-B", email, { ...snapshot, checkedAt: null, metadataComplete: false, bindingIds: [92], accounts: [{ id: 92, groups: [] }] });
  store.saveSub2ApiLinkSnapshot(second.id, "connection-A", email, { ...snapshot, bindingIds: [93], accounts: [{ id: 93, groups: [{ id: 4, name: "Second scope" }] }] });
  const cached = store.getSub2ApiLinkSnapshots(first.id, "connection-A", [email.toUpperCase(), email, "unknown@example.invalid"]);
  assert.equal(cached.length, 1);
  assert.equal(cached[0].email, email, "the normalized lookup key determines the stored email");
  assert.equal(cached[0].checkedAt, checkedAt);
  assert.equal(cached[0].metadataComplete, true);
  assert.deepEqual(cached[0].bindingIds, [94]);
  assert.equal(cached[0].accounts[0].concurrency, 0, "real numeric zero survives");
  assert.equal(cached[0].accounts[0].loadFactor, null, "missing numeric metadata never becomes a fake zero");
  assert.equal(cached[0].accounts[0].priority, 0);
  assert.equal(cached[0].accounts[0].schedulable, false);
  assert.equal(cached[0].accounts[0].groups[0].name, "Snapshot plus");
  assert.ok(Number.isFinite(Date.parse(cached[0].updatedAt)));
  assert.doesNotMatch(JSON.stringify(cached), /snapshot-secret|snapshot-group-secret|snapshot-extra-secret|credentials|adminApiKey|extra/);
  assert.deepEqual(store.getSub2ApiLinkSnapshots(first.id, "other-connection", [email]), []);
  assert.deepEqual(store.getSub2ApiLinkSnapshots(first.id, "connection-A", []), []);
  assert.equal(store.getSub2ApiLinkSnapshots(first.id, "connection-B", [email])[0].metadataComplete, false);
  assert.equal(store.getSub2ApiLinkSnapshots(first.id, "connection-B", [email])[0].checkedAt, null);
  assert.equal(store.getSub2ApiLinkSnapshots(second.id, "connection-A", [email])[0].accounts[0].id, 93);
  store.saveSub2ApiLinkSnapshot(first.id, "connection-A", "unbound@example.invalid", { status: "linked", bindingIds: [999], accounts: [{ id: 999, groups: [] }] });
  assert.equal(store.remoteBound(first.id, "connection-A", 999), false, "a display snapshot never establishes account ownership");
  store.close();
  const persisted = new DatabaseSync(path.join(root, ".cdk", "cdk.sqlite"), { readOnly: true });
  const encrypted = persisted.prepare("SELECT payload FROM sub2api_link_snapshots WHERE cdk_id=? AND backend=? AND email=?").get(first.id, "connection-A", email).payload;
  assert.doesNotMatch(encrypted, /Snapshot plus|snapshot-secret-access|snapshot-secret-admin-key/);
  const cleartext = JSON.stringify(vault.open(encrypted, `sub2api-link:${first.id}:connection-A:${email}`));
  assert.doesNotMatch(cleartext, /snapshot-secret|snapshot-group-secret|snapshot-extra-secret|credentials|adminApiKey|extra/);
  persisted.close();
  store = await createCdkStore(root, vault);
  assert.deepEqual(store.getSub2ApiLinkSnapshots(first.id, "connection-A", [email]), cached, "cached status, groups and query time survive reopening SQLite");
  assert.equal(store.remoteBound(first.id, "connection-A", 94), true);
  console.log("Sub2API binding store passed (binding and encrypted snapshot isolation, safe metadata, legacy schema migration and SQLite restart)");
} finally {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
}
