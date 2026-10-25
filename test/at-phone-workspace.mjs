import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkStore } from "../src/cdk-store.mjs";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createAtPhoneWorkspace } from "../src/at-phone-workspace.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-at-phone-")); process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64"); process.env.TOSUB2_ADMIN_CDK = "at-phone-test-admin-only";
const vault = await createCdkVault(root); let store = await createCdkStore(root, vault); const admin = store.adminId; const [user] = store.generate({ count: 1, quota: 30, note: "AT fixture" }, admin); const workspace = createAtPhoneWorkspace({ store, vault, ownerId: user.id, feeProvider: () => 10 });
const token = (email, accountId = "acct-fixture") => `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ email, "https://api.openai.com/auth": { chatgpt_account_id: accountId }, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`;
try {
  const imported = workspace.importTokens([token("at-one@example.invalid"), token("at-two@example.invalid"), token("at-one@example.invalid"), "bad token"], user.id);
  assert.equal(imported.count, 2); assert.equal(imported.invalid.length, 1); assert.equal(imported.items[0].email, "at-one@example.invalid"); assert.equal(JSON.stringify(imported).includes("acct-fixture"), false);
  const all = workspace.list({ page: 1, pageSize: 20 }); assert.equal(all.total, 2); assert.equal(all.items[0].status, "running");
  const first = all.items[0]; workspace.update(first.id, (row) => ({ ...row, status: "success", identityVerified: true, verifiedAt: new Date().toISOString(), charged: 10, message: "手机验证码已通过" }), user.id);
  assert.deepEqual(workspace.exportSuccess({}), [first.email]);
  assert.throws(() => workspace.cancel(first.id, user.id), /当前任务不能取消/);
  workspace.update(first.id, (row) => ({ ...row, status: "failed", message: "AT 已过期" }), user.id); const retried = workspace.retry(first.id, token("replacement@example.invalid"), user.id); assert.equal(retried.status, "running"); assert.equal(retried.charged, 0);
  const second = workspace.list({}).items.find((row) => row.id !== first.id); workspace.cancel(second.id, user.id); assert.equal(workspace.get(second.id).status, "canceled");
  const dbBytes = await fs.readFile(path.join(root, ".cdk", "cdk.sqlite")); assert.equal(dbBytes.includes(Buffer.from("at-one@example.invalid")), false); assert.equal(store.preview(user.id, ["at-one@example.invalid"]).charge, 1);
  store.close(); store = await createCdkStore(root, vault); const restored = createAtPhoneWorkspace({ store, vault, ownerId: user.id, feeProvider: () => 10 }); assert.equal(restored.list({}).total, 2); assert.equal(restored.exportSuccess({}).length, 0);
  console.log("[ok] AT phone workspace: encrypted independent ownership, dedupe, status filters, success export, retry/cancel and ordinary import quota isolation");
} finally { store.close(); await fs.rm(root, { recursive: true, force: true }); }
