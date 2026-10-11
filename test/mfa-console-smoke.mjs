import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCredentialStore } from "../src/credential-store.mjs";

// These HTTP tests use synthetic accounts, isolated output, and a local protocol fixture.
if (!["win32", "darwin"].includes(process.platform)) {
  console.log("MFA console persistence smoke skipped: system credential storage unavailable");
  process.exit(0);
}
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-mfa-http-"));
const id = crypto.randomUUID();
const email = `mfa-http-${id}@example.com`;
const queuedEmail = `mfa-queued-${id}@example.com`;
const password = "Fixture-password-4826!";
const oldSecret = "JBSWY3DPEHPK3PXP";
const newSecret = "NB2W45DFOIZAQWER";
const jobDir = path.join(root, id);
const protocolScript = path.join(root, "mock-mfa.mjs");
await fs.mkdir(jobDir);
await fs.writeFile(path.join(jobDir, "sub2api-import-oauth.json"), JSON.stringify({
  type: "sub2api-data", version: 1, accounts: [{ credentials: { email } }],
}));
await fs.writeFile(path.join(jobDir, "job-meta.json"), JSON.stringify({
  version: 1, email, status: "completed", result_saved: true, login_mode: "email_otp",
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
}));
await fs.writeFile(protocolScript, `
import fs from 'node:fs/promises';
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
if (process.argv.includes('--logout-all')) {
  if (process.env.CHATGPT_TOTP_SECRET !== '${newSecret}') process.exit(98);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await fs.writeFile(arg('--logout-result'), JSON.stringify({
    version:1, mode:'logout_all', email:arg('--email'), attempt_id:arg('--logout-attempt'),
    logout_succeeded:true, logout_at:new Date().toISOString(), stage:'logout_confirmed',
  }));
  process.exit(0);
}
if (!process.argv.includes('--rotate-totp')) process.exit(99);
await new Promise((resolve) => setTimeout(resolve, 1600));
await fs.writeFile(arg('--totp-result'), JSON.stringify({
  version: 1, email: arg('--email'), secret: '${newSecret}',
  activation_succeeded: true, activated_at: new Date().toISOString(), stage: 'confirmed',
}));
`);
const port = await availablePort();
const base = `http://127.0.0.1:${port}`;
let child;
let logs = "";
let token = "";
try {
  await startServer();
  const unauthenticated = await fetch(`${base}/api/mfa/accounts`);
  assert.equal(unauthenticated.status, 403);
  const invalid = await request("preview", { text: "bad-input" });
  assert.equal(invalid.status, 400);
  const input = `${email}----${password}----${oldSecret}\n${queuedEmail}----${password}----${oldSecret}`;
  const preview = await request("preview", { text: input });
  assert.equal(preview.status, 200);
  const previewText = await preview.text();
  assert.equal(JSON.parse(previewText).count, 2);
  assert.doesNotMatch(previewText, new RegExp(`${password}|${oldSecret}`));
  const imported = await request("import", { text: input });
  assert.equal(imported.status, 200, await imported.clone().text());
  assert.equal((await imported.json()).imported, 2);
  const state = await (await request("accounts")).json();
  const ids = state.accounts.map((account) => account.id);
  const primaryId = state.accounts.find((account) => account.email === email).id;
  const queuedId = state.accounts.find((account) => account.email === queuedEmail).id;
  assert.equal((await request("logout-all", { ids: [primaryId] })).status, 400);
  assert.equal((await request("start", { ids, concurrency: 31 })).status, 400);
  assert.equal((await request("start", { ids, concurrency: 1, proxyUrl: "invalid-proxy" })).status, 400);
  const started = await request("start", { ids: [primaryId, queuedId], concurrency: 1, proxyUrl: "" });
  assert.equal(started.status, 200, await started.clone().text());
  assert.equal((await started.json()).started, 2);
  const conflict = await fetch(`${base}/api/jobs/${id}/relogin`, {
    method: "POST", headers: headers(), body: JSON.stringify({}),
  });
  assert.equal(conflict.status, 409, await conflict.text());
  const canceled = await request("cancel", { ids: [queuedId] });
  assert.equal(canceled.status, 200);
  await until(async () => {
    const { accounts } = await (await request("accounts")).json();
    return accounts.find((account) => account.id === primaryId)?.status === "success";
  });
  const publicResponse = await request("accounts");
  assert.equal(publicResponse.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await publicResponse.text(), new RegExp(`${password}|${oldSecret}|${newSecret}|cookies`));
  const txt = await request("export", { format: "txt" });
  assert.equal(txt.status, 200, await txt.clone().text());
  assert.equal(txt.headers.get("cache-control"), "no-store");
  assert.match(txt.headers.get("content-disposition"), /attachment; filename=/);
  assert.equal((await txt.text()).replace(/^\uFEFF/, "").trim(), `${email}----${password}----${newSecret}`);
  const json = await request("export", { ids, format: "json" });
  assert.equal(json.status, 200);
  assert.deepEqual(await json.json(), [{ email, password, totpSecret: newSecret }]);
  assert.equal((await request("export", { ids: [], format: "txt" })).status, 400);
  const source = await fetch(`${base}/api/jobs/export-source`, {
    method: "POST", headers: headers(), body: JSON.stringify({ ids: [id] }),
  });
  assert.equal(source.status, 200);
  assert.equal((await source.text()).replace(/^\uFEFF/, "").trim(), `${email}----${password}----${newSecret}`);
  assert.equal((await request("logout-all", { ids: [primaryId], concurrency: 31 })).status, 400);
  const logout = await request("logout-all", { ids: [primaryId], concurrency: 1, proxyUrl: "http://127.0.0.1:7890" });
  assert.equal(logout.status, 200, await logout.clone().text());
  assert.equal((await logout.json()).started, 1);
  const logoutConflict = await fetch(`${base}/api/jobs/${id}/relogin`, { method:"POST", headers:headers(), body:"{}" });
  assert.equal(logoutConflict.status, 409);
  await until(async () => (await (await request("accounts")).json()).accounts.find((account) => account.id === primaryId)?.logoutStatus === "success");
  const afterLogout = (await (await request("accounts")).json()).accounts.find((account) => account.id === primaryId);
  assert.equal(afterLogout.status, "success");
  assert.ok(afterLogout.logoutAt);
  assert.equal((await request("export", { ids: [primaryId], format:"txt" })).status, 200);
  const history = await (await request("history")).json();
  assert.ok(history.items.some((item) => item.email === email && item.status === "success"));
  assert.ok(history.items.some((item) => item.email === email && item.operation === "logout_all" && item.status === "success"));
  await stopServer();
  await startServer();
  const restored = await (await request("accounts")).json();
  assert.equal(restored.accounts.find((account) => account.id === primaryId).status, "success");
  assert.equal(restored.accounts.find((account) => account.id === primaryId).logoutStatus, "success");
  const restoredExport = await request("export", { ids: [primaryId], format: "txt" });
  assert.equal((await restoredExport.text()).replace(/^\uFEFF/, "").trim(), `${email}----${password}----${newSecret}`);
  console.log("MFA console API, synchronization, export, and restart smoke passed");
} catch (error) {
  error.message += `\nConsole output:\n${logs}`;
  throw error;
} finally {
  await stopServer();
  await createCredentialStore().delete(email);
  const isolatedStore = createCredentialStore({ windowsRoot: path.join(root, "mfa", "credentials"), macRoot: path.join(root, "mfa", "credentials") });
  const prefix = `mfa:${crypto.createHash("sha256").update(root).digest("hex")}:`;
  await Promise.all([email, queuedEmail].map((value) => isolatedStore.delete(`${prefix}${value}`)));
  // All paths removed below belong to the mkdtemp fixture directory.
  await fs.rm(root, { recursive: true, force: true });
}

function headers() { return { "content-type": "application/json", "x-console-token": token }; }
function request(action, body) {
  return fetch(`${base}/api/mfa/${action}`, {
    method: body === undefined ? "GET" : "POST", headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function startServer() {
  child = spawn(process.execPath, [path.join(projectRoot, "src", "console-server.mjs"), "--port", String(port)], {
    cwd: projectRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ONBOARDING_OUTPUT_ROOT: root, ONBOARDING_PROTOCOL_SCRIPT: protocolScript },
  });
  child.stdout.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-8000); });
  child.stderr.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-8000); });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/api/bootstrap`);
      if (!response.ok) return false;
      const data = await response.json();
      token = data.token;
      assert.equal(data.features.mfaChange, true);
      return true;
    } catch { return false; }
  });
}
async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 9000);
  try { await closed; } finally { clearTimeout(timer); }
}
async function until(check) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("MFA HTTP test timed out");
}
function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
