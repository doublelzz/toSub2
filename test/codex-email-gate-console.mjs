import assert from "node:assert/strict";
import "./console-auth.mjs";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { storedFiles } from "./stored-files.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-email-gate-"));
const outputRoot = path.join(root, "jobs");
const files = storedFiles(outputRoot);
const email = "codex-email-gate@example.com";
const upstream = `http://127.0.0.1:${await availablePort()}`;
const base = `http://127.0.0.1:${await availablePort()}`;
const wrapper = path.join(root, "protocol.mjs");
// Exercise the actual login/export and rebind protocols. MFA rotation uses a
// bounded fixture to verify session reuse without changing a real account.
await fs.writeFile(wrapper, `
import fs from ${JSON.stringify(new URL("../src/workspace-storage.mjs", import.meta.url).href)};
const arg = name => process.argv[process.argv.indexOf(name) + 1];
if (process.argv.includes('--setup-totp')) {
  const checkpoint = JSON.parse(await fs.readFile(arg('--resume-checkpoint'), 'utf8'));
  if (checkpoint.stage !== 'email_verified') process.exit(95);
  await fs.writeFile(arg('--totp-result'), JSON.stringify({ version: 1, email: checkpoint.email,
    secret: 'NB2W45DFOIZAQWER', otpauth_uri: 'otpauth://totp/OpenAI?secret=NB2W45DFOIZAQWER',
    activation_mode: 'automatic', activation_succeeded: true }));
  console.log('[ok] 2FA setup activated');
} else if (process.argv.includes('--rotate-totp')) {
  if (!process.argv.includes('--mfa-session') || process.env.CHATGPT_LOGIN_PASSWORD || process.env.CHATGPT_TOTP_SECRET) process.exit(96);
  const session = JSON.parse(await fs.readFile(arg('--mfa-session'), 'utf8'));
  if (!session.accessToken || session.email !== arg('--email')) process.exit(97);
  await fs.writeFile(arg('--mfa-session-output'), JSON.stringify(session));
  await fs.writeFile(arg('--totp-result'), JSON.stringify({ version: 1, email: session.email,
    secret: 'NB2W45DFOIZAQWER', activation_succeeded: true, activated_at: new Date().toISOString(), stage: 'confirmed' }));
  console.log('[mfa-stage] authenticated');
  console.log('[mfa-stage] confirmed');
} else {
  process.argv.push('--native-http');
  await import(${JSON.stringify(new URL("../src/protocol-login.mjs", import.meta.url).href)});
}
`);
const backend = spawn(process.execPath, ["test/mock-add-phone-page-server.mjs", new URL(upstream).port], {
  cwd: project, windowsHide: true, stdio: "ignore",
});
let child;
let headers;
let id;
let processLogs = "";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const request = async (route, method = "GET", body) => {
  const response = await fetch(`${base}${route}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
};
async function until(operation) {
  for (let i = 0; i < 250; i++) {
    const value = await operation();
    if (value) return value;
    await delay(80);
  }
  const logs = id ? await request(`/api/jobs/${id}/logs`) : {};
  throw new Error(`email gate fixture timed out: ${JSON.stringify(logs)}\n${processLogs}`);
}
async function currentJob(predicate = () => true) {
  return until(async () => {
    const state = await request("/api/jobs");
    const job = state.data.jobs?.find(item => item.id === id);
    return job && predicate(job) ? job : null;
  });
}
async function start() {
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", new URL(base).port], {
    cwd: project, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", ONBOARDING_OUTPUT_ROOT: outputRoot, ONBOARDING_PROTOCOL_SCRIPT: wrapper,
      CHATGPT_BASE: upstream, AUTH_BASE: upstream, TOSUB2_TEST_SENTINEL_TOKEN: "mock-sentinel-challenge",
      TOSUB2_TEST_SENTINEL_SO_TOKEN: "mock-so-token", LOCALAPPDATA: path.join(root, "credentials"),
      TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials") },
  });
  child.stdout.on("data", chunk => { processLogs += chunk; });
  child.stderr.on("data", chunk => { processLogs += chunk; });
  const token = await until(async () => {
    try {
      const response = await fetch(`${base}/api/bootstrap`);
      return response.ok && (await response.json()).token;
    } catch { return null; }
  });
  headers = { "x-console-token": token, "content-type": "application/json" };
}
async function stop(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const closed = new Promise(resolve => proc.once("close", resolve));
  proc.kill("SIGTERM");
  await Promise.race([closed, delay(3000)]);
  if (proc.exitCode === null && proc.signalCode === null) { proc.kill("SIGKILL"); await closed; }
}
try {
  await until(async () => { try { return (await fetch(upstream)).ok; } catch { return false; } });
  await start();
  const created = await request("/api/jobs", "POST", { email });
  assert.equal(created.status, 201);
  id = created.data.job.id;
  await currentJob(job => job.status === "email_otp");
  assert.equal((await request(`/api/jobs/${id}/input`, "POST", { action: "email_otp", value: "123456" })).status, 200);
  let job = await currentJob(job => job.status === "login_ready");
  assert.equal(job.lastError, null);
  assert.equal(job.canDownload, false, "a web AT must never produce an OAuth file");
  assert.equal(job.canExportSub2Api, true, "export must remain available to explain its own prerequisite");
  assert.equal(job.canChangeMfa, true);
  assert.equal(job.canSetupTotp, true);
  assert.equal(job.canAddPassword, true);
  assert.equal(job.canCheckAccountInsights, true);
  assert.equal(job.canStartPhoneBinding, true, "the export error does not disable other existing account actions");
  const folder = path.join(outputRoot, id);
  const checkpoint = await files.readFile(path.join(folder, "login-checkpoint.json"), "utf8");
  const session = await files.readFile(path.join(folder, "account-session.json"), "utf8");
  assert.equal(JSON.parse(checkpoint).stage, "email_verified");
  assert.ok(JSON.parse(session).accessToken);
  const gate = await (await fetch(`${upstream}/__email-gate`)).json();
  assert.equal(gate.logins, 1, "Codex email verification must not restart web login");
  assert.equal(gate.selections, 1);

  const preview = await request("/api/jobs/export-preview", "POST", { ids: [id] });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.exportable, 0);
  assert.equal(preview.data.failed, 1);
  assert.match(preview.data.rows[0].message, /邮箱验证码/);
  for (const result of [await request(`/api/jobs/${id}/download`), await request("/api/jobs/download-batch", "POST", { ids: [id] })]) {
    assert.equal(result.status, 409);
    assert.match(result.data.error, /Sub2API.*邮箱验证码/);
  }
  assert.equal((await currentJob()).status, "login_ready", "export errors cannot fail account operations");
  assert.equal((await request(`/api/jobs/${id}/retry`, "POST", {})).status, 200);
  await currentJob(item => item.status === "login_ready");
  assert.equal((await (await fetch(`${upstream}/__email-gate`)).json()).logins, 1, "a repeated Codex challenge preserves the restored web login too");
  const atExport = await request("/api/jobs/export-at", "POST", { ids: [id] });
  assert.equal(atExport.status, 200);
  assert.equal(atExport.data.exported, 1, "web AT export is independent of Codex JSON export");

  const sources = await request("/api/rebind/state");
  const source = sources.data.sources.find(item => item.email === email);
  assert.equal(source.busy, false);
  const body = { ids: [source.id], text: "target-email-gate@example.com", concurrency: 1 };
  const rebindPreview = await request("/api/rebind/preview", "POST", body);
  assert.equal(rebindPreview.status, 200);
  assert.equal((await request("/api/rebind/start", "POST", { ...body, digest: rebindPreview.data.digest })).status, 200);
  const rebound = await until(async () => {
    const state = await request("/api/rebind/state");
    return state.data.items.find(item => item.status === "waiting_manual");
  });
  assert.equal((await request(`/api/rebind/${rebound.id}/code`, "POST", { code: "123456", version: rebound.challengeVersion })).status, 200);
  await until(async () => (await request("/api/rebind/state")).data.items.find(item => item.status === "success"));
  assert.deepEqual((await (await fetch(`${upstream}/__email-gate`)).json()).rebind, ["eligibility", "begin", "verify"]);
  assert.equal((await files.readFile(path.join(folder, "account-session.json"), "utf8")), session, "rebind does not replace authorization credentials");

  assert.equal((await request(`/api/jobs/${id}/setup-2fa`, "POST", {})).status, 200);
  job = await currentJob(item => item.status === "login_ready" && item.hasTotpKey);
  assert.equal(job.lastError, null);
  assert.equal(job.canSetupTotp, false);
  assert.equal(job.canDownload, false);

  assert.equal((await request(`/api/jobs/${id}/change-mfa`, "POST", {})).status, 200);
  await until(async () => (await request("/api/mfa/accounts")).data.accounts.find(item => item.email === email && item.status === "success"));
  job = await currentJob(item => item.canChangeMfa);
  assert.equal(job.status, "login_ready");
  assert.equal(job.lastError, null);

  await stop(child);
  const legacyId = crypto.randomUUID();
  const invalidId = crypto.randomUUID();
  const legacyError = "SESSION_SELECTION_INVALID: session/select returned page=email_otp_send, continue_path=/api/accounts/email-otp/send; the selected account session is not ready for Codex authorization";
  for (const [target, valid] of [[legacyId, true], [invalidId, false]]) {
    const restoredEmail = `${target}@example.com`;
    await fs.mkdir(path.join(outputRoot, target), { recursive: true });
    const metadata = { version: 1, task_metadata_version: 2, email: restoredEmail, status: "failed", prompt: "流程失败",
      last_error: legacyError, result_saved: false, account_session_available: valid,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await files.writeFile(path.join(outputRoot, target, "job-meta.json"), JSON.stringify(metadata));
    if (valid) {
      const data = { ...JSON.parse(session), email: restoredEmail };
      const claims = { email: restoredEmail, exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: data.accountId } };
      data.accessToken = `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
      await files.writeFile(path.join(outputRoot, target, "account-session.json"), JSON.stringify(data));
    }
  }
  await start();
  const restored = await request("/api/jobs");
  const legacy = restored.data.jobs.find(item => item.id === legacyId);
  assert.equal(legacy.status, "login_ready");
  assert.equal(legacy.lastError, null);
  assert.equal(legacy.canChangeMfa, true);
  assert.equal(restored.data.jobs.find(item => item.id === invalidId).status, "failed", "missing web credentials cannot be promoted to login success");
  assert.equal((await currentJob()).status, "login_ready");
  assert.equal((await request(`/api/jobs/${id}/download`)).status, 409);
  await request(`/api/jobs/${id}/account-insights`, "POST", {});
  await currentJob(item => item.status === "login_ready" && !item.accountInsightsChecking);

  await fetch(`${upstream}/__email-gate`, { method: "POST", body: JSON.stringify({ enabled: false }) });
  assert.equal((await request(`/api/jobs/${id}/retry`, "POST", {})).status, 200);
  job = await currentJob(item => item.status === "completed");
  assert.equal(job.canDownload, true);
  assert.equal(job.lastError, null);
  assert.equal((await (await fetch(`${upstream}/__email-gate`)).json()).logins, 1, "retry must reuse the retained web checkpoint");
  assert.equal((await request(`/api/jobs/${id}/download`)).status, 200);
  const mixed = await request("/api/jobs/export-preview", "POST", { ids: [id, legacyId] });
  assert.equal(mixed.data.exportable, 1);
  assert.equal(mixed.data.failed, 1);
  const mixedDownload = await request("/api/jobs/download-batch", "POST", { ids: [id, legacyId] });
  assert.equal(mixedDownload.status, 200);
  assert.equal(mixedDownload.data.accounts.length, 1);
  assert.equal(mixedDownload.data.accounts[0].credentials.email, email);
  const metadata = JSON.parse(await files.readFile(path.join(folder, "job-meta.json"), "utf8"));
  assert.equal(metadata.sub2api_authorization_error, null, "successful authorization clears the export error");
  assert.doesNotMatch(JSON.stringify(job), /accessToken|refresh_token|synthetic-session-signature/);
  console.log("Codex email gate: retained login/checkpoint, export-only errors, MFA/rebind, restart, legacy recovery and successful retry passed (local fixtures).");
} finally {
  await stop(child);
  await stop(backend);
  await fs.rm(root, { recursive: true, force: true });
}
async function availablePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
