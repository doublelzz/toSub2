import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createEmailRebindWorkspace } from "../src/email-rebind-workspace.mjs";
import { rebindError } from "../src/email-rebind-protocol.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-rebind-disposable-"));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const vault = await createCdkVault(root);
const sources = ["success", "failure", "legacy", "active", "other"].map(id => ({ id, email: `${id}@example.com`, sources: ["authorization"] }));
const calls = [];
let workspace;
let aborted = 0;
const until = async callback => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = callback();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Disposable rebind fixture timed out: ${JSON.stringify(workspace?.list())}`);
};
const options = { root, vault, listSources: () => structuredClone(sources), isAccountBusy: () => false,
  resolveSource: async (_id, email) => ({ session: { type: "chatgpt-session", version: 1, email,
    accessToken: "local-private-token", accountId: email, expiresAt: "2099-01-01T00:00:00Z" }, credentials: {} }),
  runStep: async (operation, payload, signal) => {
    calls.push({ operation, email: payload.email, target: payload.newEmail });
    if (payload.email === "active@example.com" && operation === "begin") {
      await new Promise((resolve, reject) => {
        const stop = () => { aborted++; reject(rebindError("NETWORK")); };
        if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
      });
    }
    if (payload.email === "failure@example.com" && operation === "verify") throw rebindError("UNCERTAIN");
    return { data: operation === "eligibility" ? { eligible: true } : { success: true } };
  },
};
const begin = async (id, newEmail = `${id}-new@example.com`) => {
  const body = { ids: [id], text: newEmail };
  const result = await workspace.start({ ...body, digest: workspace.preview(body).digest });
  return until(() => workspace.list().items.find(row => row.batchId === result.batchId && row.status === "waiting_manual"));
};
try {
  workspace = await createEmailRebindWorkspace(options);
  const first = await begin("success");
  await workspace.submit(first.id, { code: "001234", version: first.challengeVersion });
  assert.equal(workspace.list().items.find(row => row.id === first.id).status, "success");
  assert.equal(workspace.list().sources.find(row => row.id === "success").rebound, false);
  assert.equal(workspace.isBusy(first.oldEmail), false);
  assert.equal(workspace.preview({ ids: ["other"], text: first.newEmail }).rows[0].newEmail, first.newEmail,
    "successful historical targets never reserve an email for another attempt");
  const repeated = await begin("success", first.newEmail);
  assert.notEqual(repeated.id, first.id, "repeating an identical mapping is a new independent task");
  await workspace.cancel([repeated.id]);
  const failed = await begin("failure");
  await workspace.submit(failed.id, { code: "001234", version: failed.challengeVersion });
  let result = workspace.list().items.find(row => row.id === failed.id);
  assert.equal(result.status, "failed");
  assert.match(result.message, /未收到成功确认/);
  assert.equal(result.canRetry, true);
  assert.equal(workspace.isBusy(failed.oldEmail), false);
  assert.equal(workspace.preview({ ids: ["failure"], text: failed.newEmail }).rows.length, 1);
  await workspace.retry(failed.id);
  result = await until(() => workspace.list().items.find(row => row.id === failed.id && row.status === "waiting_manual"));
  assert.equal(result.challengeVersion, 2);
  await workspace.cancel([failed.id]);

  const other = await begin("other");
  const otherBefore = workspace.list().items.find(row => row.id === other.id);
  const sourcesBefore = structuredClone(sources);
  assert.equal((await workspace.remove([first.id, repeated.id, failed.id])).deleted, 3);
  assert.deepEqual(workspace.list().items.find(row => row.id === other.id), otherBefore);
  assert.deepEqual(sources, sourcesBefore, "removing records never deletes authorization account sources");
  assert.throws(() => workspace.logs(first.id), { status: 404 });
  await assert.rejects(fs.access(path.join(root, "email-rebind/logs", `${first.id}.log.enc`)), { code: "ENOENT" });
  await assert.rejects(workspace.remove([first.id]), { status: 404 });
  await workspace.cancel([other.id]);

  const body = { ids: ["active"], text: "active-new@example.com" };
  const activeResult = await workspace.start({ ...body, digest: workspace.preview(body).digest });
  const running = await until(() => workspace.list().items.find(row => row.batchId === activeResult.batchId && row.status === "beginning"));
  await until(() => calls.some(row => row.email === "active@example.com" && row.operation === "begin"));
  assert.equal((await workspace.remove([running.id])).deleted, 1);
  assert.equal(aborted, 1, "deletion terminates the running request before dropping its record");
  assert.equal(workspace.isBusy("active@example.com"), false);
  assert.equal(workspace.list().items.some(row => row.id === running.id), false);
  await workspace.shutdown();

  const statePath = path.join(root, "email-rebind/state.enc");
  const saved = vault.open(await fs.readFile(statePath, "utf8"), "email-rebind-state");
  const legacyId = crypto.randomUUID();
  saved.items.push({ id: legacyId, batchId: crypto.randomUUID(), sourceRef: "legacy",
    oldEmail: "legacy@example.com", newEmail: "old-target@example.com", status: "uncertain", mode: "manual",
    message: "old pending result", events: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await fs.writeFile(statePath, vault.seal(saved, "email-rebind-state"));
  workspace = await createEmailRebindWorkspace(options);
  const restored = workspace.list().items.find(row => row.id === legacyId);
  assert.equal(restored.status, "failed");
  assert.equal(restored.canRetry, true);
  assert.equal(restored.canDelete, true);
  assert.equal(workspace.list().sources.find(row => row.id === "legacy").busy, false);
  assert.equal((await workspace.remove([legacyId])).deleted, 1);
  assert.equal(workspace.preview({ ids: ["legacy"], text: "old-target@example.com" }).rows.length, 1);
  assert.equal(workspace.list().items.some(row => row.id === running.id), false, "deleted runs cannot reappear after restart");
  console.log("Disposable email rebind passed (repeat mappings, no historical identity locks, retry after unconfirmed requests, record/log deletion, abort before delete, original account preservation and legacy recovery)");
} finally { await workspace?.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
