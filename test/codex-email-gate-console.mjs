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
  if (arg('--email').includes('-password@')) process.argv = process.argv.filter(value => value !== '--verbose');
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
const gate = async config => (await fetch(`${upstream}/__email-gate`, config ? {
  method: "POST", body: JSON.stringify(config),
} : undefined)).json();
const phoneSetup = { id: "custom", config: { entries: `+60123456789----${upstream}/__phone-requests` } };
async function until(operation) {
  for (let i = 0; i < 250; i++) {
    const value = await operation();
    if (value) return value;
    await delay(80);
  }
  const logs = id ? await request(`/api/jobs/${id}/logs`) : {};
  const state = await request("/api/jobs");
  throw new Error(`email gate fixture timed out: ${JSON.stringify(state.data.jobs?.find(job => job.id === id))}\n${JSON.stringify(logs)}\n${processLogs}`);
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
    try { const response = await fetch(`${base}/api/bootstrap`); return response.ok && (await response.json()).token; }
    catch { return null; }
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
  const created = await request("/api/jobs", "POST", { email, phoneBindingEnabled: false });
  assert.equal(created.status, 201);
  id = created.data.job.id;
  await currentJob(job => job.status === "email_otp");
  assert.equal((await request(`/api/jobs/${id}/input`, "POST", { action: "email_otp", value: "123456" })).status, 200);
  let job = await currentJob(job => job.status === "phone_skipped");
  assert.equal(job.autoEmailOtp, false);
  assert.equal(job.canStartPhoneBinding, true, "a missing mail link must not block starting phone binding");
  assert.equal((await gate()).sent, 0, "no extra email should be sent before phone binding starts");
  assert.equal((await request(`/api/jobs/${id}/input`, "POST", { action: "email_otp", value: "222222" })).status, 409);
  assert.equal((await request(`/api/jobs/${id}/start-phone`, "POST", { smsProvider: phoneSetup })).status, 200);
  job = await currentJob(job => job.status === "email_otp" && job.canSetupTotp === false && !job.autoEmailOtp);
  await until(async () => (await gate()).sent === 1);
  assert.equal(job.mailStatus, "manual");
  assert.equal(job.canDownload, false);
  assert.equal(job.canStartPhoneBinding, false, "phone binding cannot start before the additional email verification");
  const folder = path.join(outputRoot, id);
  const checkpoint = await files.readFile(path.join(folder, "login-checkpoint.json"), "utf8");
  const session = await files.readFile(path.join(folder, "account-session.json"), "utf8");
  assert.equal(JSON.parse(checkpoint).stage, "email_verified");
  assert.ok(JSON.parse(session).accessToken);
  assert.equal((await gate()).logins, 1);
  assert.deepEqual(await (await fetch(`${upstream}/__phone-requests`)).json(), { send: 0, validate: 0 });
  assert.equal((await request(`/api/jobs/${id}/input`, "POST", { action: "email_otp", value: "000000" })).status, 200);
  await currentJob(job => job.status === "email_otp" && /验证码错误/.test(job.prompt));
  assert.equal((await request(`/api/jobs/${id}/input`, "POST", { action: "resend_email" })).status, 200);
  await until(async () => (await gate()).sent === 2);
  await currentJob(job => job.status === "email_otp");
  assert.equal((await request(`/api/jobs/${id}/input`, "POST", { action: "email_otp", value: "222222" })).status, 200);
  await currentJob(job => job.status === "phone_otp");
  assert.equal((await gate()).validations, 1);
  assert.equal((await request(`/api/jobs/${id}/input`, "POST", { action: "phone_otp", value: "654321" })).status, 200);
  job = await currentJob(job => job.status === "completed");
  assert.equal(job.canDownload, true);
  assert.equal((await gate()).logins, 1, "the extra email challenge must reuse the web login");

  const noChallenge = await request("/api/jobs", "POST", { email: "codex-email-gate-deferred@example.com",
    password: "fixture-password", totpSecret: "NB2W45DFOIZAQWER", phoneBindingEnabled: false });
  assert.equal(noChallenge.status, 201);
  id = noChallenge.data.job.id;
  await currentJob(job => job.status === "phone_skipped");
  const sentBeforeStart = (await gate()).sent;
  const deferredLogs = (await request(`/api/jobs/${id}/logs`)).data.logs;
  assert.doesNotMatch(deferredLogs, /Email OTP \(r=resend/,
    "password login without a mail link must not show a manual email prompt before phone binding starts");
  await gate({ enabled: false });
  assert.equal((await request("/api/jobs/start-phone-batch", "POST", { ids: [id], smsProvider: phoneSetup })).status, 200);
  await currentJob(job => job.status === "completed");
  assert.equal((await gate()).sent, sentBeforeStart, "no email is sent when Codex no longer requires the challenge");
  assert.doesNotMatch((await request(`/api/jobs/${id}/logs`)).data.logs, /Email OTP \(r=resend/);

  await gate({ nextStep: "callback" });
  for (const [account, pageType, credentials] of [["codex-email-gate-auto@example.com", "email_otp_send", {}],
    ["codex-email-gate-verification@example.com", "email_otp_verification", {}],
    ["codex-email-gate-password@example.com", "email_otp_send", { password: "fixture-password", totpSecret: "NB2W45DFOIZAQWER" }]]) {
    await gate({ pageType });
    const before = await gate();
    const result = await request("/api/jobs", "POST", { email: account, mailApiUrl: `${upstream}/__email-gate/mail`, phoneBindingEnabled: false, ...credentials });
    assert.equal(result.status, 201);
    id = result.data.job.id;
    job = await currentJob(job => job.status === "completed");
    assert.equal(job.autoEmailOtp, true);
    assert.equal(job.canDownload, true);
    const after = await gate();
    assert.equal(after.sent, before.sent + 1, "an already issued verification challenge must not send a duplicate email");
    assert.equal(after.validations, before.validations + 1);
    const logs = (await request(`/api/jobs/${id}/logs`)).data.logs;
    assert.equal((logs.match(/已从收码接口自动取得新验证码并提交/g) || []).length, credentials.password ? 1 : 2,
      "both the web login and the Codex challenge must automatically read their own fresh code");
    assert.doesNotMatch(logs, /synthetic-session-signature/);
  }

  assert.equal((await request("/api/jobs/delete-batch", "POST", { ids: [created.data.job.id] })).status, 200);
  await stop(child);
  const legacyError = "SESSION_SELECTION_INVALID: session/select returned page=email_otp_send, continue_path=/api/accounts/email-otp/send; the selected account session is not ready for Codex authorization";
  const legacyId = crypto.randomUUID();
  const invalidId = crypto.randomUUID();
  for (const [target, valid] of [[created.data.job.id, true], [legacyId, true], [invalidId, false]]) {
    const restoredEmail = target === created.data.job.id ? email : `${target}@example.com`;
    const targetFolder = path.join(outputRoot, target);
    await fs.mkdir(targetFolder, { recursive: true });
    const metadata = { version: 1, task_metadata_version: 2, email: restoredEmail,
      status: target === created.data.job.id ? "login_ready" : "failed", prompt: "old status",
      last_error: target === created.data.job.id ? null : legacyError, result_saved: false,
      account_session_available: valid, sub2api_authorization_error: target === created.data.job.id ? "CODEX_EMAIL_VERIFICATION_REQUIRED" : null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (target === created.data.job.id) metadata.phone_binding_enabled = false;
    await files.writeFile(path.join(targetFolder, "job-meta.json"), JSON.stringify(metadata));
    if (valid) {
      const data = { ...JSON.parse(session), email: restoredEmail };
      const claims = { email: restoredEmail, exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_account_id: data.accountId } };
      data.accessToken = `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
      await files.writeFile(path.join(targetFolder, "account-session.json"), JSON.stringify(data));
      await files.writeFile(path.join(targetFolder, "login-checkpoint.json"), JSON.stringify({ ...JSON.parse(checkpoint), email: restoredEmail }));
    }
  }
  id = created.data.job.id;
  await start();
  const restored = (await request("/api/jobs")).data.jobs;
  for (const target of [id, legacyId]) {
    const item = restored.find(job => job.id === target);
    assert.equal(item.status, target === id ? "phone_skipped" : "resume_available");
    assert.match(item.prompt, target === id ? /待接码/ : /待邮箱验证/);
    assert.equal(item.canResume, target !== id);
    assert.equal(item.canStartPhoneBinding, true);
    assert.equal(item.canChangeMfa, true);
    assert.equal(item.canDownload, false);
  }
  assert.equal(restored.find(job => job.id === invalidId).status, "failed");
  assert.equal((await request(`/api/jobs/${id}/download`)).status, 409);
  assert.equal((await request("/api/jobs/export-at", "POST", { ids: [id] })).data.exported, 1);
  await gate({ email });
  const beforeDeferredRetry = await gate();
  assert.equal((await request(`/api/jobs/${id}/retry`, "POST", {})).status, 200);
  await currentJob(job => job.status === "phone_skipped");
  assert.equal((await gate()).sent, beforeDeferredRetry.sent);
  const sources = (await request("/api/rebind/state")).data.sources;
  const source = sources.find(item => item.email === email);
  assert.equal(source.busy, false);
  const body = { ids: [source.id], text: "target-email-gate@example.com", concurrency: 1 };
  const preview = await request("/api/rebind/preview", "POST", body);
  assert.equal(preview.status, 200);
  assert.equal((await request("/api/rebind/start", "POST", { ...body, digest: preview.data.digest })).status, 200);
  const rebind = await until(async () => (await request("/api/rebind/state")).data.items.find(item => item.status === "waiting_manual"));
  assert.equal((await request(`/api/rebind/${rebind.id}/code`, "POST", { code: "123456", version: rebind.challengeVersion })).status, 200);
  await until(async () => (await request("/api/rebind/state")).data.items.find(item => item.status === "success"));
  assert.deepEqual((await gate()).rebind, ["eligibility", "begin", "verify"]);
  assert.equal((await request(`/api/jobs/${id}/setup-2fa`, "POST", {})).status, 200);
  await currentJob(job => job.status === "resume_available" && job.hasTotpKey);
  assert.equal((await request(`/api/jobs/${id}/change-mfa`, "POST", {})).status, 200);
  await until(async () => (await request("/api/mfa/accounts")).data.accounts.find(item => item.email === email && item.status === "success"));
  await currentJob(job => job.status === "resume_available" && job.canChangeMfa);
  await gate({ email });
  const loginsBeforeStart = (await gate()).logins;
  assert.equal((await request(`/api/jobs/${id}/start-phone`, "POST", { smsProvider: phoneSetup })).status, 200);
  await currentJob(job => job.status === "email_otp");
  assert.equal((await gate()).logins, loginsBeforeStart, "starting phone binding must preserve the saved web login");
  assert.equal((await request(`/api/jobs/${id}/input`, "POST", { action: "email_otp", value: "222222" })).status, 200);
  job = await currentJob(job => job.status === "completed");
  assert.equal(job.canDownload, true);
  assert.doesNotMatch(JSON.stringify(job), /accessToken|refresh_token|synthetic-session-signature/);
  console.log("Codex email verification: manual/automatic codes, resend, existing challenge, phone continuation, saved web login and legacy recovery passed (local fixtures).");
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
