import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-mfa-rotation-"));
const password = "fixture-rotation-password";
const oldSecret = "JBSWY3DPEHPK3PXP";
const newSecret = "NB2W45DFOIZAQWER";
const alternateSecret = "KRUGS4ZANFZSAYJA";
const sessionValue = "fixture-session-token-private";
const accessToken = "fixture-access-token-private";
const fixtures = new Map();
let base;
const server = http.createServer((req, res) => handle(req, res).catch((error) => {
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: String(error.message) }));
}));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
base = `http://127.0.0.1:${server.address().port}`;

try {
  const basic = fixture("normal");
  let result = await run(basic);
  assert.equal(result.code, 0, result.output);
  await assertComplete(basic);
  assert.deepEqual(basic.calls, { login: 1, disable: 1, enroll: 1, activate: 1, create: 0, oauth: 0, phone: 0, logout: 0 });
  result = await run(basic);
  assert.equal(result.code, 0, result.output);
  assert.equal(basic.calls.disable, 1, "a completed checkpoint must not rotate twice");
  assert.equal(basic.calls.login, 1, "a completed checkpoint needs no new login");

  const firstSetup = fixture("first-setup", { active: "" });
  result = await run(firstSetup, { CHATGPT_TOTP_SECRET: "" });
  assert.equal(result.code, 0, result.output);
  await assertComplete(firstSetup);
  assert.equal(firstSetup.calls.disable, 0);

  const reused = fixture("reuse-authorization");
  await saveSession(reused);
  result = await run(reused, { CHATGPT_LOGIN_PASSWORD: "", CHATGPT_TOTP_SECRET: "" }, false, true);
  assert.equal(result.code, 0, result.output);
  await assertComplete(reused);
  assert.equal(reused.calls.login, 0, "authorization-page MFA must not initiate login");
  const reusedSource = JSON.parse(await fs.readFile(reused.sessionPath, "utf8"));
  assert.equal(reusedSource.accessToken, reused.accessToken);
  result = await run(reused, { CHATGPT_LOGIN_PASSWORD: "", CHATGPT_TOTP_SECRET: "" }, true);
  assert.equal(result.code, 0, result.output);
  assert.equal(reused.calls.login, 0, "logout must use the session from MFA");
  assert.equal(reused.calls.logout, 1);

  for (const [name, sessionOptions, code] of [
    ["expired-reused-session", { expiresAt: "2000-01-01T00:00:00Z", accessToken: "opaque-expired" }, "MFA_SESSION_EXPIRED"],
    ["mismatched-reused-session", { email: "someone-else@example.com" }, "MFA_SESSION_INVALID"],
  ]) {
    const value = fixture(name);
    await saveSession(value, sessionOptions);
    for (const logoutOperation of [false, true]) {
      result = await run(value, {}, logoutOperation, true);
      assert.equal(result.code, 1);
      assert.match(result.output, new RegExp(code));
      assert.equal(value.calls.login + value.calls.disable + value.calls.logout, 0);
    }
  }
  const rejectedReuse = fixture("rejected-reused-session", { authorizationRejected: true });
  await saveSession(rejectedReuse);
  result = await run(rejectedReuse, {}, false, true);
  assert.equal(result.code, 1);
  assert.match(result.output, /MFA_SESSION_EXPIRED/);
  assert.equal(rejectedReuse.calls.login + rejectedReuse.calls.disable, 0);

  const disableFailure = fixture("disable-failure", { failDisable: 1 });
  result = await run(disableFailure);
  assert.equal(result.code, 1);
  let saved = await read(disableFailure);
  assert.equal(saved.old_factor_disabled, false);
  assert.equal(saved.stage, "disable_requested");
  assert.equal(disableFailure.active, "old-factor");
  assert.equal(disableFailure.calls.enroll, 0);
  result = await run(disableFailure);
  assert.equal(result.code, 0, result.output);
  await assertComplete(disableFailure);

  const disableConfirmation = fixture("disable-confirmation-failure", { failDisableConfirmation: 1 });
  result = await run(disableConfirmation);
  assert.equal(result.code, 1);
  saved = await read(disableConfirmation);
  assert.equal(saved.stage, "disable_requested");
  assert.equal(saved.old_factor_disabled, false);
  assert.equal(disableConfirmation.active, "", "the server already disabled the old factor");
  result = await run(disableConfirmation);
  assert.equal(result.code, 0, result.output);
  assert.equal(disableConfirmation.calls.disable, 1, "retry must reconcile an ambiguous disable response");
  await assertComplete(disableConfirmation);

  const enrollFailure = fixture("enroll-failure", { failEnroll: 1 });
  result = await run(enrollFailure);
  assert.equal(result.code, 1);
  saved = await read(enrollFailure);
  assert.equal(saved.old_factor_disabled, true);
  assert.equal(saved.stage, "enroll_requested");
  result = await run(enrollFailure);
  assert.equal(result.code, 0, result.output);
  assert.equal(enrollFailure.calls.disable, 1, "recovery must not repeat a confirmed disable");
  await assertComplete(enrollFailure, alternateSecret);

  const activateFailure = fixture("activate-failure", { failActivate: 1 });
  result = await run(activateFailure);
  assert.equal(result.code, 1);
  saved = await read(activateFailure);
  assert.equal(saved.secret, newSecret);
  assert.equal(saved.activation_succeeded, false);
  assert.equal(saved.session_id, "fixture-enrollment-1");
  result = await run(activateFailure);
  assert.equal(result.code, 0, result.output);
  assert.equal(activateFailure.calls.enroll, 1, "recovery must reuse the saved inactive enrollment");
  assert.equal(activateFailure.calls.activate, 2);
  await assertComplete(activateFailure);

  const responseLost = fixture("activation-response-lost", { loseActivationResponse: true });
  result = await run(responseLost);
  assert.equal(result.code, 0, result.output);
  assert.equal(responseLost.calls.activate, 1);
  await assertComplete(responseLost);

  const confirmFailure = fixture("confirmation-failure", { failConfirmation: 1 });
  result = await run(confirmFailure);
  assert.equal(result.code, 1);
  saved = await read(confirmFailure);
  assert.equal(saved.secret, newSecret, "confirmation failure must not discard the one-time new key");
  assert.equal(saved.activation_accepted, true);
  assert.equal(saved.activation_succeeded, false, "only remote status confirmation is exportable success");
  assert.equal(saved.stage, "activating");
  // Exercise a fresh login after remote activation but before local confirmation.
  saved.cookies = [];
  await fs.writeFile(confirmFailure.resultPath, JSON.stringify(saved));
  result = await run(confirmFailure);
  assert.equal(result.code, 0, result.output);
  assert.equal(confirmFailure.calls.login, 2);
  assert.equal(confirmFailure.calls.disable, 1);
  assert.equal(confirmFailure.calls.enroll, 1);
  assert.equal(confirmFailure.calls.activate, 1, "an already active factor must not be activated again");
  await assertComplete(confirmFailure);

  const additionalFactor = fixture("additional-factor-after-activation", { additionalFactorAfterActivation: true });
  result = await run(additionalFactor);
  assert.equal(result.code, 0, result.output);
  assert.equal(additionalFactor.calls.disable, 1, "confirmation must leave unrelated factors intact");
  await assertComplete(additionalFactor);

  const expired = fixture("expired-enrollment", { expireEnrollment: 1 });
  result = await run(expired);
  assert.equal(result.code, 1);
  saved = await read(expired);
  assert.equal(saved.enrollment_expired, true);
  assert.equal(saved.secret, newSecret);
  result = await run(expired);
  assert.equal(result.code, 0, result.output);
  assert.equal(expired.calls.enroll, 2);
  assert.equal(expired.calls.disable, 1);
  await assertComplete(expired, alternateSecret);

  const identityMismatch = fixture("identity-mismatch", { sessionMismatch: true });
  result = await run(identityMismatch);
  assert.equal(result.code, 1);
  assert.match(result.output, /MFA_SESSION_INVALID/);
  assert.equal(identityMismatch.calls.disable, 0);

  const createProfile = fixture("profile-required", { active: "", profileRequired: true });
  result = await run(createProfile);
  assert.equal(result.code, 1);
  assert.match(result.output, /MFA_EXISTING_ACCOUNT_REQUIRED/);
  assert.equal(createProfile.calls.create, 0);
  assert.equal(createProfile.calls.enroll, 0);

  const badPassword = fixture("bad-password");
  result = await run(badPassword, { CHATGPT_LOGIN_PASSWORD: "incorrect-fixture-password" });
  assert.equal(result.code, 1);
  assert.match(result.output, /MFA_PASSWORD_REJECTED/);
  assert.doesNotMatch(result.output, /Password \(q=quit\)/);

  const badTotp = fixture("bad-totp", { rejectTotp: true });
  result = await run(badTotp);
  assert.equal(result.code, 1);
  assert.match(result.output, /MFA_CODE_REJECTED/);
  assert.doesNotMatch(result.output, /2FA OTP \(/);

  const loginSecurityCheck = fixture("login-security-check", { loginSecurityCheck: true });
  result = await run(loginSecurityCheck);
  assert.equal(result.code, 1);
  assert.match(result.output, /MFA_LOGIN_SECURITY_CHECK/);
  saved = await read(loginSecurityCheck);
  assert.equal(saved.error_code, "MFA_LOGIN_SECURITY_CHECK");
  assert.equal(saved.error_http_status, "403");
  assert.equal(saved.error_endpoint, "/api/accounts/authorize", "diagnostics must exclude URL query data");
  assert.equal(saved.stage, "pending");
  assert.equal(saved.old_factor_disabled, false);
  assert.equal(saved.activation_succeeded, false);
  assert.equal(loginSecurityCheck.active, "old-factor");
  assert.equal(loginSecurityCheck.calls.disable, 0);
  assert.equal(loginSecurityCheck.calls.enroll, 0);
  assert.equal(loginSecurityCheck.calls.activate, 0);

  const logout = fixture("logout-current-key", { secret: newSecret });
  result = await run(logout, { CHATGPT_TOTP_SECRET: newSecret }, true);
  assert.equal(result.code, 0, result.output);
  saved = JSON.parse(await fs.readFile(logout.logoutResultPath, "utf8"));
  assert.equal(saved.mode, "logout_all");
  assert.equal(saved.attempt_id, logout.logoutAttempt);
  assert.equal(saved.logout_succeeded, true);
  assert.equal(saved.stage, "logout_confirmed");
  assert.ok(saved.logout_at);
  assert.deepEqual(logout.calls, { login: 0, disable: 0, enroll: 0, activate: 0, create: 0, oauth: 0, phone: 0, logout: 1 });
  for (const secret of [password, oldSecret, newSecret, sessionValue, accessToken]) assert.equal(JSON.stringify(saved).includes(secret), false);
  result = await run(logout, {}, true);
  assert.equal(result.code, 1, "the server revokes the saved session after logout");
  assert.match(result.output, /MFA_SESSION_EXPIRED/);
  assert.equal(logout.calls.login, 0, "a revoked session must never trigger login with the supplied key");

  const logoutMismatch = fixture("logout-identity-mismatch", { sessionMismatch: true });
  result = await run(logoutMismatch, {}, true);
  assert.equal(result.code, 1);
  assert.match(result.output, /MFA_SESSION_INVALID/);
  assert.equal(logoutMismatch.calls.logout, 0);

  for (const [name, options, errorCode] of [
    ["logout-http-failure", { logoutHttpStatus: 503 }, "MFA_LOGOUT_HTTP_ERROR"],
    ["logout-response-invalid", { logoutInvalidResponse: true }, "MFA_LOGOUT_RESPONSE_INVALID"],
    ["logout-unconfirmed", { logoutUnconfirmed: true }, "MFA_LOGOUT_UNCONFIRMED"],
    ["logout-expired", { authorizationRejected: true }, "MFA_SESSION_EXPIRED"],
  ]) {
    const value = fixture(name, options);
    result = await run(value, {}, true);
    assert.equal(result.code, 1);
    assert.match(result.output, new RegExp(errorCode));
    saved = JSON.parse(await fs.readFile(value.logoutResultPath, "utf8"));
    assert.equal(saved.logout_succeeded, false);
    assert.equal(saved.error_code, errorCode);
    assert.equal(value.calls.disable + value.calls.enroll + value.calls.activate, 0);
  }

  const collision = fixture("checkpoint-account-mismatch");
  await fs.copyFile(basic.resultPath, collision.resultPath);
  result = await run(collision);
  assert.equal(result.code, 1);
  assert.match(result.output, /MFA_CHECKPOINT_INVALID/);
  assert.equal(collision.calls.login, 0);
  assert.equal((await read(collision)).email, basic.email, "a mismatched checkpoint must remain intact");

  for (const value of fixtures.values()) {
    assert.equal(value.calls.oauth, 0, "MFA changes must not request Codex OAuth");
    assert.equal(value.calls.phone, 0, "MFA changes must not request phone binding");
  }
  console.log("MFA rotation and logout protocol tests passed (recovery, account guards, bodyless POST, private logs)");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempRoot, { recursive: true, force: true });
}

function fixture(name, options = {}) {
  const value = {
    email: `${name}@example.com`, active: "old-factor", secret: oldSecret,
    resultPath: path.join(tempRoot, `${name}.json`),
    logoutResultPath: path.join(tempRoot, `${name}.logout.json`),
    sessionPath: path.join(tempRoot, `${name}.session.json`),
    calls: { login: 0, disable: 0, enroll: 0, activate: 0, create: 0, oauth: 0, phone: 0, logout: 0 },
    ...options,
  };
  value.accessToken = `e30.${Buffer.from(JSON.stringify({ email: value.email, exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account-id" } })).toString("base64url")}.${accessToken}`;
  fixtures.set(value.email, value);
  return value;
}

async function saveSession(value, overrides = {}) {
  await fs.writeFile(value.sessionPath, JSON.stringify({ type: "chatgpt-session", version: 1,
    email: value.sessionMismatch ? "someone-else@example.com" : value.email,
    accessToken: value.accessToken, accountId: "fixture-account-id", deviceId: "fixture-device", chatgptBase: base, ...overrides }));
}

async function run(value, extraEnv = {}, logout = false, reuse = false) {
  if (logout && !await fs.stat(value.sessionPath).catch(() => null)) await saveSession(value);
  value.logoutAttempt = crypto.randomUUID();
  const child = spawn(process.execPath, [path.join(projectRoot, "src/protocol-login.mjs"),
    "--email", value.email,
    ...(logout ? ["--logout-all", "--logout-result", value.logoutResultPath, "--logout-attempt", value.logoutAttempt] : ["--rotate-totp", "--totp-result", value.resultPath]),
    ...(logout || reuse ? ["--mfa-session", value.sessionPath] : []),
    ...(!logout ? ["--mfa-session-output", value.sessionPath] : []),
    "--chatgpt-base", base, "--auth-base", base, "--native-http", "--verbose",
  ], {
    cwd: projectRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", CHATGPT_PROXY_URL: "",
      CHATGPT_LOGIN_PASSWORD: password, CHATGPT_TOTP_SECRET: oldSecret,
      TOSUB2_TEST_SENTINEL_TOKEN: "fixture-sentinel", ...extraEnv },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode));
  }).finally(() => clearTimeout(timer));
  assert.notEqual(code, null, `noninteractive rotation hung: ${output}`);
  for (const secret of [password, oldSecret, newSecret, alternateSecret, sessionValue, accessToken, "fixture-enrollment-1", "fixture-login-private-query"]) {
    assert.equal(output.includes(secret), false, `sensitive fixture value appeared in process logs: ${output}`);
  }
  return { code, output };
}

async function read(value) {
  return JSON.parse(await fs.readFile(value.resultPath, "utf8"));
}

async function assertComplete(value, expectedSecret = newSecret) {
  const saved = await read(value);
  assert.equal(saved.version, 1);
  assert.equal(saved.email, value.email);
  assert.equal(saved.secret, expectedSecret);
  assert.equal(saved.activation_succeeded, true);
  assert.equal(saved.stage, "confirmed");
  assert.equal(saved.factor_id, value.active);
  assert.ok(saved.activated_at);
  if (process.platform !== "win32") assert.equal((await fs.stat(value.resultPath)).mode & 0o777, 0o600);
}

async function handle(req, res) {
  const url = new URL(req.url, base);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let payload = {};
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
  const cookieEmail = /(?:^|;\s*)fixture-account=([^;]+)/.exec(req.headers.cookie || "")?.[1];
  const bearerAccount = [...fixtures.values()].find((value) => req.headers.authorization === `Bearer ${value.accessToken}`);
  const email = url.searchParams.get("login_hint") || (cookieEmail ? decodeURIComponent(cookieEmail) : bearerAccount?.email || "");
  const value = fixtures.get(email);
  const send = (status, data) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const redirect = (target) => { res.writeHead(302, { location: `${base}${target}` }); res.end(); };
  const callback = () => ({ page: { type: "external_url" }, continue_url: `${base}/web-callback` });
  const leakedError = (message) => ({ error: { message, secret: newSecret, password, session: sessionValue } });
  if (url.pathname === "/") {
    res.setHeader("set-cookie", "__Host-next-auth.csrf-token=fixture-csrf; Path=/");
    return send(200, {});
  }
  if (url.pathname === "/api/auth/providers") return send(200, {});
  if (url.pathname === "/api/auth/csrf") return send(200, { csrfToken: "fixture-csrf" });
  if (!value) return send(404, { error: "unknown fixture" });
  if (url.pathname.startsWith("/oauth/")) { value.calls.oauth++; return send(500, {}); }
  if (url.pathname.includes("add-phone")) { value.calls.phone++; return send(500, {}); }
  if (url.pathname === "/api/accounts/create_account") { value.calls.create++; return send(500, {}); }
  if (url.pathname === "/api/auth/signin/openai") {
    value.calls.login++;
    assert.equal(url.searchParams.get("screen_hint"), "login");
    res.setHeader("set-cookie", `fixture-account=${encodeURIComponent(email)}; Path=/`);
    return send(200, { url: `${base}/api/accounts/authorize${value.loginSecurityCheck ? "?private=fixture-login-private-query" : ""}` });
  }
  if (url.pathname === "/api/accounts/authorize") {
    if (value.loginSecurityCheck) {
      res.writeHead(403, { "content-type": "text/html" });
      res.end("<!doctype html><title>Just a moment</title><body>Security check required</body>");
      return;
    }
    return redirect("/log-in/password");
  }
  if (url.pathname === "/log-in/password") return send(200, {});
  if (url.pathname === "/api/accounts/password/verify") {
    if (payload.password !== password) return send(401, leakedError("invalid password"));
    if (value.profileRequired) return send(200, { page: { type: "about_you" }, continue_url: `${base}/about-you` });
    if (!value.active) return send(200, callback());
    return send(200, { page: { type: "mfa_challenge" }, continue_url: `${base}/mfa-challenge/${value.active}`,
      "oai-client-auth-session": { mfa_factors: [{ factor_type: "totp", id: value.active }] } });
  }
  if (url.pathname === "/api/accounts/mfa/issue_challenge") return send(200, {});
  if (url.pathname === "/api/accounts/mfa/verify") {
    if (value.rejectTotp || payload.id !== value.active || !validTotp(payload.code, value.secret)) {
      return send(400, leakedError("invalid totp"));
    }
    return send(200, callback());
  }
  if (url.pathname === "/web-callback") {
    res.setHeader("set-cookie", `__Secure-next-auth.session-token=${sessionValue}; Path=/`);
    return redirect("/");
  }
  if (url.pathname === "/api/auth/session") {
    if (!(req.headers.cookie || "").includes(sessionValue)) return send(401, leakedError("unauthorized"));
    return send(200, { user: { email: value.sessionMismatch ? "someone-else@example.com" : email }, account: { id: "fixture-account-id" }, accessToken: value.accessToken });
  }
  if (req.headers.authorization !== `Bearer ${value.accessToken}` || value.authorizationRejected) return send(401, {});
  if (url.pathname === "/backend-api/accounts/logout_all") {
    value.calls.logout++;
    assert.equal(req.method, "POST");
    assert.equal(Buffer.concat(chunks).length, 0, "HAR logout request has no body");
    assert.equal(req.headers["chatgpt-account-id"], "fixture-account-id");
    assert.ok(req.headers["oai-did"]);
    if (value.logoutHttpStatus) return send(value.logoutHttpStatus, leakedError("logout failed"));
    if (value.logoutInvalidResponse) { res.writeHead(200); return res.end("invalid JSON"); }
    if (!value.logoutUnconfirmed) value.authorizationRejected = true;
    return send(200, value.logoutUnconfirmed ? { success: false } : null);
  }
  if (url.pathname === "/backend-api/accounts/mfa_info") {
    if (!value.active && value.calls.disable && value.failDisableConfirmation > 0) {
      value.failDisableConfirmation--;
      return send(503, leakedError("disable confirmation unavailable"));
    }
    if (value.active?.startsWith("new-factor") && value.failConfirmation > 0) {
      value.failConfirmation--;
      return send(503, leakedError("confirmation unavailable"));
    }
    const factors = value.active ? [{ id: value.active, factor_type: "totp" }] : [];
    if (value.active?.startsWith("new-factor") && value.additionalFactorAfterActivation) {
      factors.push({ id: "unrelated-factor", factor_type: "totp" });
    }
    return send(200, { mfa_enabled: Boolean(value.active), factors: { totp: factors } });
  }
  if (url.pathname === "/backend-api/accounts/mfa/user/disable_in_house") {
    value.calls.disable++;
    if (value.failDisable > 0) { value.failDisable--; return send(503, leakedError("disable failed")); }
    assert.equal(payload.factor_id, value.active);
    value.active = "";
    return send(200, { success: true });
  }
  if (url.pathname === "/backend-api/accounts/mfa/enroll") {
    value.calls.enroll++;
    if (value.failEnroll > 0) { value.failEnroll--; return send(503, leakedError("enrollment failed")); }
    assert.equal(value.active, "");
    value.enrollment = { secret: value.calls.enroll === 1 ? newSecret : alternateSecret,
      session_id: `fixture-enrollment-${value.calls.enroll}`, factor: { id: `new-factor-${value.calls.enroll}` } };
    return send(200, value.enrollment);
  }
  if (url.pathname === "/backend-api/accounts/mfa/user/activate_enrollment") {
    value.calls.activate++;
    if (value.failActivate > 0) { value.failActivate--; return send(503, leakedError("activation failed")); }
    if (value.expireEnrollment > 0) { value.expireEnrollment--; return send(400, leakedError("invalid_session")); }
    assert.equal(payload.session_id, value.enrollment.session_id);
    assert.equal(validTotp(payload.code, value.enrollment.secret), true);
    const saved = await read(value);
    assert.equal(saved.secret, value.enrollment.secret, "the key must be on disk before activation");
    assert.equal(saved.stage, "activating");
    value.active = value.enrollment.factor.id;
    value.secret = value.enrollment.secret;
    return value.loseActivationResponse ? send(503, leakedError("response lost")) : send(200, { success: true });
  }
  return send(404, { error: "not found" });
}

function validTotp(code, secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret].map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
  return [-1, 0, 1].some((offset) => {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
    const digest = crypto.createHmac("sha1", key).update(counter).digest();
    const position = digest.at(-1) & 15;
    return String((digest.readUInt32BE(position) & 0x7fffffff) % 1_000_000).padStart(6, "0") === code;
  });
}
