import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConsoleWorkspace } from "../src/console-server.mjs";
import { startCdkServer } from "../src/cdk-server.mjs";

// Exercise the Linux deployment path even when this isolated test runs on Windows.
// Every account, encryption key, protocol response and output directory is synthetic.
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-mfa-vault-"));
const originalEnvironment = Object.fromEntries(["TOSUB2_ENCRYPTION_KEY", "TOSUB2_ADMIN_CDK"].map((key) => [key, process.env[key]]));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-mfa-vault-administrator";

const email = "synthetic-mfa-vault@example.com";
const jobId = crypto.randomUUID();
const oldSecret = "JBSWY3DPEHPK3PXP";
const newSecret = "NB2W45DFOIZAQWER";
const adminPassword = "synthetic-admin-mfa-password";
const ownerAPassword = "synthetic-owner-a-updated-password";
const ownerBPassword = "synthetic-owner-b-mfa-password";
const protocolScript = path.join(root, "mock-mfa.mjs");
let app;
let base;

function client() {
  let cookie = "";
  let token = "";
  return {
    async call(url, method = "GET", payload) {
      const response = await fetch(`${base}${url}`, {
        method,
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { "x-console-token": token } : {}) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      if (response.ok && data.token) token = data.token;
      return { status: response.status, data, text };
    },
  };
}

async function start() {
  app = await startCdkServer({
    root, listen: false,
    async createWorkspace(options) {
      // Keep native process locking on the host OS; only credential-store
      // construction needs the unsupported-system path to reproduce the bug.
      Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
      try { return await createConsoleWorkspace({ ...options, protocolScript }); }
      finally { Object.defineProperty(process, "platform", originalPlatform); }
    },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
}

async function login(secret) {
  const owner = client();
  assert.equal((await owner.call("/api/auth/login", "POST", { cdk: secret })).status, 200);
  return owner;
}

async function importMfa(owner, password) {
  const result = await owner.call("/api/mfa/import", "POST", { text: `${email}----${password}----${oldSecret}`, requestKey: crypto.randomUUID() });
  assert.equal(result.status, 200, `MFA import must use the application vault on Linux: ${result.text}`);
  return result.data.accounts[0].id;
}

async function rotate(owner, id) {
  const started = await owner.call("/api/mfa/start", "POST", { ids: [id], concurrency: 1 });
  assert.equal(started.status, 200, started.text);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const { data } = await owner.call("/api/mfa/accounts");
    const account = data.accounts.find((value) => value.id === id);
    if (account.status === "success") return;
    assert.notEqual(account.status, "failed", `Synthetic MFA rotation failed: ${account.error}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Synthetic MFA rotation did not settle");
}

async function assertExport(owner, id, password) {
  const result = await owner.call("/api/mfa/export", "POST", { ids: [id], format: "json" });
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.data, [{ email, password, totpSecret: newSecret }]);
}

try {
  await fs.mkdir(path.join(root, jobId));
  await fs.writeFile(path.join(root, jobId, "job-meta.json"), JSON.stringify({
    version: 1, email, status: "completed", login_mode: "password", result_saved: true,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }));
  await fs.writeFile(path.join(root, jobId, "sub2api-import-oauth.json"), JSON.stringify({
    type: "sub2api-data", version: 1, accounts: [{ credentials: { email } }],
  }));
  await fs.writeFile(protocolScript, `
import fs from ${JSON.stringify(new URL("../src/workspace-storage.mjs", import.meta.url).href)};
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes('--rotate-totp') || !process.env.CHATGPT_LOGIN_PASSWORD || process.env.CHATGPT_TOTP_SECRET !== '${oldSecret}') process.exit(99);
await fs.writeFile(arg('--mfa-session-output'), JSON.stringify({ type:'chatgpt-session', version:1, email:arg('--email'), accessToken:'synthetic-vault-session', accountId:'synthetic-vault-account', expiresAt:'2099-01-01T00:00:00Z' }));
await fs.writeFile(arg('--totp-result'), JSON.stringify({ version:1, email:arg('--email'), secret:'${newSecret}', activation_succeeded:true, activated_at:new Date().toISOString(), stage:'confirmed' }));
`);

  await start();
  let admin = await login(process.env.TOSUB2_ADMIN_CDK);
  const preview = await admin.call("/api/mfa/preview", "POST", { text: `${email}----${adminPassword}----${oldSecret}` });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.count, 1);
  assert.ok(!preview.text.includes(adminPassword) && !preview.text.includes(oldSecret), "preview exposes account identity only");
  const adminMfaId = await importMfa(admin, adminPassword);
  const generated = await admin.call("/api/admin/cdks", "POST", { count: 2, quota: 4, note: "synthetic MFA vault isolation" });
  assert.equal(generated.status, 201, generated.text);
  const [keyA, keyB] = generated.data.items;
  let ownerA = await login(keyA.secret);
  let ownerB = await login(keyB.secret);
  const ownerAId = await importMfa(ownerA, "synthetic-owner-a-original-password");
  const updatedAId = await importMfa(ownerA, ownerAPassword);
  assert.equal(updatedAId, ownerAId, "re-import updates the existing MFA account");
  const ownerBId = await importMfa(ownerB, ownerBPassword);
  assert.notEqual(ownerAId, ownerBId, "the same email is independent in two CDKs");
  assert.equal((await ownerA.call("/api/mfa/export", "POST", { ids: [ownerBId], format: "json" })).status, 400, "a CDK cannot export another CDK's MFA account");
  await rotate(admin, adminMfaId);
  await rotate(ownerA, ownerAId);
  await rotate(ownerB, ownerBId);
  await assertExport(admin, adminMfaId, adminPassword);
  await assertExport(ownerA, ownerAId, ownerAPassword);
  await assertExport(ownerB, ownerBId, ownerBPassword);
  const source = await admin.call("/api/jobs/export-source", "POST", { ids: [jobId] });
  assert.equal(source.status, 200, source.text);
  assert.equal(source.text.replace(/^\uFEFF/, "").trim(), `${email}----${adminPassword}----${newSecret}`, "successful MFA changes synchronize the authorization credentials through the same vault");
  const vaultFiles = await fs.readdir(path.join(root, "mfa", "credentials"));
  assert.ok(vaultFiles.some((name) => name.endsWith(".vault")), "MFA credentials are saved in the application vault");
  assert.ok(vaultFiles.every((name) => !name.endsWith(".dpapi") && !name.endsWith(".enc")), "Linux MFA never depends on an OS credential store");
  for (const filename of vaultFiles) {
    const content = await fs.readFile(path.join(root, "mfa", "credentials", filename), "utf8");
    assert.ok(!content.includes(adminPassword) && !content.includes(newSecret), "vault files contain encrypted credentials");
  }
  await app.close(); app = null;
  await start();
  admin = await login(process.env.TOSUB2_ADMIN_CDK);
  ownerA = await login(keyA.secret);
  ownerB = await login(keyB.secret);
  await assertExport(admin, adminMfaId, adminPassword);
  await assertExport(ownerA, ownerAId, ownerAPassword);
  await assertExport(ownerB, ownerBId, ownerBPassword);
  const restoredSource = await admin.call("/api/jobs/export-source", "POST", { ids: [jobId] });
  assert.equal(restoredSource.status, 200, restoredSource.text);
  assert.equal(restoredSource.text.replace(/^\uFEFF/, "").trim(), `${email}----${adminPassword}----${newSecret}`);
  console.log("MFA credential vault passed (Linux import/update, synthetic rotation, authorization synchronization, encrypted persistence, CDK isolation and restart)");
} finally {
  await app?.close();
  Object.defineProperty(process, "platform", originalPlatform);
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(root, { recursive: true, force: true });
}
