import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  store = await createCdkStore(root, vault);
  assert.deepEqual(store.getRemoteBindings(first.id, "connection-A", email), [{ remoteId: 94, email }], "resolved association survives reopening the SQLite store");
  assert.equal(store.remoteBound(first.id, "connection-A", 91), false);
  assert.equal(store.remoteBound(first.id, "connection-A", 94), true);
  console.log("Sub2API binding store passed (CDK, email and connection isolation; explicit replacement and SQLite restart)");
} finally {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
}
