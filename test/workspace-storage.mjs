import assert from "node:assert/strict";
import crypto from "node:crypto";
import nativeFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createCdkStore } from "../src/cdk-store.mjs";
import { createCredentialStore } from "../src/credential-store.mjs";
import { protocolEnvironment } from "../src/cdk-security.mjs";
import fs, { registerWorkspaceStorage, attachWorkspaceStorage, workspaceChildOptions } from "../src/workspace-storage.mjs";

if (process.argv[2] === "--worker") {
  const root = process.env.TOSUB2_STORAGE_IPC_ROOT;
  const temporary = path.join(root, "job-a", "account-session.json.worker.tmp");
  const target = path.join(root, "job-a", "account-session.json");
  await fs.writeFile(temporary, Buffer.alloc(200_000, 97));
  assert.equal((await fs.readFile(temporary)).length, 200_000);
  await fs.rename(temporary, target);
  assert.equal((await fs.stat(target)).size, 200_000);
  assert.equal((await fs.readdir(path.dirname(target), { withFileTypes: true })).some((item) => item.name === "account-session.json" && item.isFile()), true);
  assert.equal(process.env.TOSUB2_ENCRYPTION_KEY, undefined);
} else {
  const root = await nativeFs.mkdtemp(path.join(os.tmpdir(), "tosub2-sqlite-workspace-"));
  process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
  process.env.TOSUB2_ADMIN_CDK = "test-storage-administrator-only";
  const fixture = path.join(root, "job-a", "job-meta.json");
  const old = JSON.stringify({ email: "synthetic-storage@example.com", status: "completed" });
  await nativeFs.mkdir(path.dirname(fixture));
  await nativeFs.writeFile(fixture, old);
  const vault = await createCdkVault(root);
  const store = await createCdkStore(root, vault);
  let storage;
  let second;
  try {
    storage = await registerWorkspaceStorage({ root, ownerId: store.adminId, store, vault });
    const indexed = await fs.readFile(fixture, "utf8");
    assert.equal(JSON.parse(indexed).email, "synthetic-storage@example.com");
    assert.equal(store.workspaceMigrated(store.adminId), true);
    assert.doesNotMatch(JSON.stringify(store.workspaceDocuments(store.adminId)), /synthetic-storage|completed/);
    await nativeFs.writeFile(fixture, "old files are retained as migration backups only");
    assert.equal(await fs.readFile(fixture, "utf8"), indexed, "SQLite is authoritative after migration");
    const originalRow = store.workspaceDocument(store.adminId, "job-a/job-meta.json");
    await fs.writeFile(fixture, indexed);
    assert.deepEqual(store.workspaceDocument(store.adminId, "job-a/job-meta.json"), originalRow, "identical content cannot add WAL writes");
    const temporary = `${fixture}.test.tmp`;
    await fs.writeFile(temporary, "new snapshot");
    assert.equal(store.workspaceDocument(store.adminId, "job-a/job-meta.json.test.tmp"), undefined, "atomic-write scratch data stays in memory");
    assert.equal(await fs.readFile(fixture, "utf8"), indexed);
    await fs.rename(temporary, fixture);
    assert.equal(await fs.readFile(fixture, "utf8"), "new snapshot");
    await assert.rejects(storage.batch(async () => { await fs.writeFile(fixture, "rolled back"); throw new Error("rollback fixture"); }), /rollback fixture/);
    assert.equal(await fs.readFile(fixture, "utf8"), "new snapshot");
    const owner = store.generate({ count: 1, quota: 1 }, store.adminId)[0].id;
    const secondRoot = path.join(root, "cdk", owner);
    second = await registerWorkspaceStorage({ root: secondRoot, ownerId: owner, store, vault });
    const other = path.join(secondRoot, "job-a", "job-meta.json");
    await fs.writeFile(other, "other CDK private document");
    await assert.rejects(storage.call("readFile", other, "utf8"), { code: "EACCES" });
    await assert.rejects(second.call("readFile", fixture, "utf8"), { code: "EACCES" });
    assert.equal(await fs.readFile(fixture, "utf8"), "new snapshot");
    assert.equal(await fs.readFile(other, "utf8"), "other CDK private document");
    const renamed = path.join(root, "job-a", "renamed.json");
    await fs.rename(fixture, renamed);
    assert.equal(await fs.readFile(renamed, "utf8"), "new snapshot");
    assert.equal(store.workspaceDocument(store.adminId, "job-a/job-meta.json"), undefined);
    await fs.rename(renamed, fixture);

    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--worker"], {
      env: { ...protocolEnvironment(), ...workspaceChildOptions(root) },
      stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    });
    attachWorkspaceStorage(child, root);
    let errors = ""; child.stderr.on("data", (value) => { errors += value; });
    const exit = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(exit, 0, errors);
    assert.equal((await fs.readFile(path.join(root, "job-a", "account-session.json"))).length, 200_000);
    await assert.rejects(nativeFs.access(path.join(root, "job-a", "account-session.json")), { code: "ENOENT" });

    let powershellCalls = 0;
    const credentialRoot = path.join(root, ".credentials");
    await fs.mkdir(credentialRoot, { recursive: true });
    await storage.batch(async () => { for (let index = 0; index < 558; index += 1) {
      const identity = `synthetic-${index}@example.com`;
      const hash = crypto.createHash("sha256").update(identity).digest("hex");
      await fs.writeFile(path.join(credentialRoot, `${hash}.dpapi`), Buffer.from(JSON.stringify({ password: `synthetic-password-${index}`, totpSecret: "", proxyUrl: "" })).toString("base64"));
    } });
    const credentials = createCredentialStore({ platform: "win32", windowsRoot: credentialRoot, vault,
      powerShellRunner: async (script, input) => {
        powershellCalls += 1;
        assert.match(script, /foreach/);
        const values = JSON.parse(input).map(({ id, cipher }) => ({ id, payload: Buffer.from(cipher, "base64").toString("utf8") }));
        return { code: 0, stdout: JSON.stringify(values) };
      },
    });
    await storage.batch(() => credentials.migrate());
    assert.equal(powershellCalls, 1, "558 legacy credentials use one migration helper");
    await storage.batch(() => credentials.migrate());
    for (let index = 0; index < 558; index += 1) assert.equal((await credentials.load(`synthetic-${index}@example.com`)).password, `synthetic-password-${index}`);
    assert.equal(powershellCalls, 1, "subsequent startup reads do not launch per-account PowerShell");
    assert.doesNotMatch(JSON.stringify(store.workspaceDocuments(store.adminId)), /synthetic-password/);

    await fs.rm(path.dirname(fixture), { recursive: true, force: true });
    storage.close();
    storage = await registerWorkspaceStorage({ root, ownerId: store.adminId, store, vault });
    await assert.rejects(fs.readFile(fixture), { code: "ENOENT" });
    assert.equal(await nativeFs.readFile(fixture, "utf8"), "old files are retained as migration backups only", "deleted SQLite records cannot be resurrected from backups");
    assert.equal(await fs.readFile(other, "utf8"), "other CDK private document");
    console.log("workspace SQLite passed (migration, encrypted state, atomic writes, rollback, CDK isolation, IPC, 558 credentials, no resurrection)");
  } finally {
    second?.close(); storage?.close(); store.close(); await nativeFs.rm(root, { recursive: true, force: true });
  }
}
