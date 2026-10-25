import assert from "node:assert/strict";
import crypto from "node:crypto";
import nativeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createCdkStore } from "../src/cdk-store.mjs";
import { createCredentialStore } from "../src/credential-store.mjs";
import { startCdkServer } from "../src/cdk-server.mjs";
import { createConsoleWorkspace } from "../src/console-server.mjs";
import fs, { registerWorkspaceStorage } from "../src/workspace-storage.mjs";

const root = await nativeFs.mkdtemp(path.join(os.tmpdir(), "tosub2-lazy-credentials-"));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-lazy-storage-administrator";
const namespace = crypto.createHash("sha256").update(root).digest("hex");
const identities = Array.from({ length: 558 }, (_, index) => ({ id: crypto.randomUUID(), email: `lazy-${index}@example.com` }));
const vault = await createCdkVault(root);
const seed = await createCdkStore(root, vault);
const ownerId = seed.adminId;
const ownerVault = { seal: (value, scope) => vault.seal(value, `credentials:${ownerId}:${scope}`), open: (value, scope) => vault.open(value, `credentials:${ownerId}:${scope}`) };
const mfaId = crypto.randomUUID();
const rebindId = crypto.randomUUID();
const rebindVault = { seal: (value, scope) => vault.seal(value, `rebind:${ownerId}:${scope}`), open: (value, scope) => vault.open(value, `rebind:${ownerId}:${scope}`) };
const legacyRoot = path.join(root, "synthetic-os-store");
let legacyCiphertext;
if (process.platform === "win32") {
  const legacy = createCredentialStore({ windowsRoot: legacyRoot });
  await legacy.save("fixture@example.com", { password: "synthetic-lazy-password", totpSecret: "JBSWY3DPEHPK3PXP", proxyUrl: "http://synthetic-user:synthetic-secret@127.0.0.1:1" });
  const [filename] = await nativeFs.readdir(legacyRoot);
  legacyCiphertext = await nativeFs.readFile(path.join(legacyRoot, filename), "utf8");
}
const registered = await registerWorkspaceStorage({ root, ownerId, store: seed, vault });
const credentials = createCredentialStore({ windowsRoot: path.join(root, ".credentials"), macRoot: path.join(root, ".credentials"), vault: ownerVault });
await registered.batch(async () => {
  for (const [index, identity] of identities.entries()) {
    const qualified = `cdk:${namespace}:${ownerId}:${identity.email}`;
    if (index === 1 && legacyCiphertext) {
      const hash = crypto.createHash("sha256").update(qualified).digest("hex");
      await fs.writeFile(path.join(root, ".credentials", `${hash}.dpapi`), legacyCiphertext);
    } else if (index !== 557) await credentials.save(qualified, { password: "synthetic-lazy-password", totpSecret: "JBSWY3DPEHPK3PXP", proxyUrl: "http://synthetic-user:synthetic-secret@127.0.0.1:1" });
    await fs.writeFile(path.join(root, identity.id, "job-meta.json"), JSON.stringify({ version: 1, task_metadata_version: 2,
      email: identity.email, status: "canceled", login_mode: "password", phone_binding_mode: "manual",
      has_password: true, has_totp_key: true, has_stored_credentials: true, proxy_configured: true,
      created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z" }));
  }
  const mfaCredentials = createCredentialStore({ windowsRoot: path.join(root, "mfa", "credentials"), macRoot: path.join(root, "mfa", "credentials"), vault: ownerVault });
  const mfaPrefix = `mfa:${crypto.createHash("sha256").update(root).digest("hex")}:`;
  await mfaCredentials.save(`${mfaPrefix}${identities[0].email}`, { password: "synthetic-lazy-password", totpSecret: "JBSWY3DPEHPK3PXP", proxyUrl: "" });
  await fs.writeFile(path.join(root, "mfa", "accounts.json"), JSON.stringify({ version: 1, concurrency: 3, history: [], accounts: [{ id: mfaId,
    email: identities[0].email, status: "running", stage: "saving", hasPassword: true, hasTotpKey: true, createdAt: "2026-10-01T00:00:00.000Z" }] }));
  await fs.writeFile(path.join(root, "mfa", `${mfaId}.checkpoint.json`), JSON.stringify({ version: 1, email: identities[0].email,
    activation_succeeded: true, secret: "NB2W45DFOIZAQWER", activated_at: "2026-10-01T00:00:00.000Z" }));
  await fs.writeFile(path.join(root, "email-rebind", "state.enc"), rebindVault.seal({ version: 1, concurrency: 1, items: [{
    id: rebindId, oldEmail: identities[0].email, newEmail: "synthetic-rebound@example.com", status: "success", confirmedAt: "2026-10-01T00:00:00.000Z",
    snapshotSealed: rebindVault.seal({ credentials: { password: "synthetic-rebound-password" }, session: { accountId: "synthetic-account" } }, `email-rebind-snapshot:${rebindId}`),
  }] }, "email-rebind-state"));
});
registered.close(); seed.close();

let app; let workspace;
let helperSpawns = 0; let protocolSpawns = 0; let decrypted = []; let sensitiveReads = []; let rebindSnapshotsOpened = 0;
const originalSpawn = childProcess.spawn;
childProcess.spawn = (command, ...args) => {
  if (/powershell|\/usr\/bin\/security/i.test(command)) helperSpawns += 1;
  else if (args[0]?.some?.((value) => String(value).includes("mock-queue-protocol"))) protocolSpawns += 1;
  return originalSpawn(command, ...args);
};
syncBuiltinESMExports();
async function start() {
  app = await startCdkServer({ root, listen: false, createWorkspace: async (options) => {
    const open = options.credentialVault.open;
    options.credentialVault = { ...options.credentialVault, open: (value, scope) => { decrypted.push(scope); return open(value, scope); } };
    const openRebind = options.rebindVault.open;
    options.rebindVault = { ...options.rebindVault, open: (value, scope) => { if (scope.startsWith("email-rebind-snapshot:")) rebindSnapshotsOpened += 1; return openRebind(value, scope); } };
    const call = options.storage.call;
    options.storage.call = (method, target, ...args) => {
      if (method === "readFile" && /(?:\.credentials[\\/]|[\\/]credentials[\\/]|sub2api-import-oauth|login-checkpoint|account-session|totp-setup-result|password-add-result|\.checkpoint\.json$)/.test(target)) sensitiveReads.push(path.basename(target));
      return call(method, target, ...args);
    };
    return createConsoleWorkspace({ ...options, protocolScript: path.resolve("test/mock-queue-protocol.mjs") });
  } });
  workspace = await app.workspaceFor(ownerId);
}
const body = (response) => JSON.parse(response.body.toString("utf8"));
const exportOne = (id) => workspace.dispatch("POST", "/api/jobs/export-source", { ids: [id] });
async function waitFor(predicate) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("Synthetic lazy credential operation did not settle");
}
try {
  await start();
  assert.equal(workspace.publicJobs().length, 558);
  await workspace.dispatch("GET", "/api/jobs");
  const initialMfa = body(await workspace.dispatch("GET", "/api/mfa/accounts"));
  assert.equal(initialMfa.accounts[0].status, "interrupted", "MFA checkpoint credentials are not recovered during startup");
  await workspace.dispatch("GET", "/api/rebind/state");
  assert.equal(rebindSnapshotsOpened, 0, "rebind listings cannot decrypt saved account snapshots");
  assert.equal(decrypted.length, 0, "startup and listing cannot decrypt any account vault credential");
  assert.equal(helperSpawns, 0, "startup cannot launch a DPAPI/Keychain credential helper");
  assert.equal(sensitiveReads.length, 0, "startup cannot read credential, token, session or checkpoint payloads");
  const first = workspace.publicJobs().find((job) => job.id === identities[0].id);
  assert.equal(first.hasTotpKey, true);
  assert.equal(first.proxyConfigured, true);
  assert.equal(workspace.publicJobs().find((job) => job.id === identities[557].id).status, "canceled", "unloaded credentials cannot be reported missing at startup");
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => exportOne(identities[0].id)));
  for (const result of concurrent) assert.match(result.body.toString("utf8"), /synthetic-lazy-password/);
  assert.equal(decrypted.length, 1, "concurrent operations share the selected account's pending load");
  await exportOne(identities[0].id);
  assert.equal(decrypted.length, 1, "reusing a loaded account does not decrypt other accounts");
  const updated = await app.importFor(ownerId, "single", { email: identities[2].email, proxyUrl: null }, "lazy-proxy-update", ownerId);
  assert.equal(updated.status, 200);
  const preserved = await exportOne(identities[2].id);
  assert.match(preserved.body.toString("utf8"), /synthetic-lazy-password.*JBSWY3DPEHPK3PXP/);
  assert.equal(workspace.publicJobs().find((job) => job.id === identities[2].id).proxyConfigured, false, "proxy-only updates retain the lazily loaded password and MFA");
  workspace.pause();
  const beforeQueue = decrypted.length;
  await workspace.dispatch("POST", `/api/jobs/${identities[1].id}/retry`, {});
  assert.equal(workspace.publicJobs().find((job) => job.id === identities[1].id).status, "queued");
  assert.equal(decrypted.length, beforeQueue, "queueing alone cannot decrypt credentials before a worker slot is available");
  assert.equal(helperSpawns, 0, "queueing a legacy account cannot launch DPAPI");
  await workspace.dispatch("POST", `/api/jobs/${identities[1].id}/cancel`, {});
  workspace.resume();
  const retry = await workspace.dispatch("POST", `/api/jobs/${identities[1].id}/retry`, {});
  assert.equal(retry.status, 200);
  await waitFor(() => workspace.publicJobs().find((job) => job.id === identities[1].id)?.status === "email_otp");
  assert.equal(helperSpawns, legacyCiphertext ? 1 : 0, "only executing the selected legacy account can invoke DPAPI");
  await workspace.dispatch("POST", `/api/jobs/${identities[1].id}/cancel`, {});
  const childrenBeforeMissing = protocolSpawns;
  await workspace.dispatch("POST", `/api/jobs/${identities[557].id}/retry`, {});
  await waitFor(() => workspace.publicJobs().find((job) => job.id === identities[557].id)?.status === "failed");
  assert.equal(protocolSpawns, childrenBeforeMissing, "missing saved credentials cannot start an incomplete login or fall back to direct network access");
  const mfaStart = await workspace.dispatch("POST", "/api/mfa/start", { ids: [mfaId], concurrency: 1 });
  assert.equal(mfaStart.status, 200);
  await waitFor(async () => body(await workspace.dispatch("GET", "/api/mfa/accounts")).accounts[0].status === "success");
  assert.match((await exportOne(identities[0].id)).body.toString("utf8"), /NB2W45DFOIZAQWER/, "explicit MFA recovery synchronizes the new secret without repeating remote mutation");
  assert.equal(protocolSpawns, childrenBeforeMissing, "confirmed MFA recovery stays local after an explicit operation");
  assert.deepEqual(workspace.planImport("rebind", { ids: [rebindId] }), ["synthetic-rebound@example.com"]);
  assert.equal(rebindSnapshotsOpened, 1, "only the selected rebind operation opens its account snapshot");
  await app.close(); app = null;
  decrypted = []; sensitiveReads = []; helperSpawns = 0; rebindSnapshotsOpened = 0;
  await start();
  assert.equal(decrypted.length, 0);
  assert.equal(sensitiveReads.length, 0);
  assert.equal(helperSpawns, 0, "subsequent restarts remain metadata-only");
  assert.equal(rebindSnapshotsOpened, 0);
  assert.equal(workspace.publicJobs().find((job) => job.id === identities[2].id).proxyConfigured, false);
  console.log("lazy credentials passed (558 metadata-only tasks, zero startup/queued credential loads, selected operations, concurrent load, legacy DPAPI, proxy preservation, deferred MFA/rebind recovery, missing credentials and restart)");
} finally {
  await app?.close(); childProcess.spawn = originalSpawn; syncBuiltinESMExports(); await nativeFs.rm(root, { recursive: true, force: true });
}
