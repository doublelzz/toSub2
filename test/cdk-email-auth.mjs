import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startCdkServer } from "../src/cdk-server.mjs";
import { protocolEnvironment } from "../src/cdk-security.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-email-auth-"));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-email-auth-administrator-only";
process.env.TOSUB2_TRUSTED_PROXIES = "127.0.0.1";
process.env.TOSUB2_SMTP_PASSWORD = "synthetic-password-never-exposed";
const inbox = []; let deliveryFails = false; let app; let base; let db; let assertions = 0; let nextIp = 1;
const eq = (a, b, message) => { assert.deepEqual(a, b, message || `assertion ${assertions + 1}`); assertions++; };
const ok = (a, message) => { assert.ok(a, message || `assertion ${assertions + 1}`); assertions++; };
async function start() {
  app = await startCdkServer({ root, listen: false, mailer: { configured: true, sendCode: async (message) => { if (deliveryFails) throw Object.assign(new Error("synthetic mail failure"), { status: 503 }); inbox.push(message); } }, createWorkspace: async () => ({
    activeCount: () => 0, tick: () => 0, inventory: () => [], publicJobs: () => [], pause() {}, resume() {}, stop: async () => {}, shutdown: async () => {},
    dispatch: async () => ({ status: 200, body: Buffer.from(JSON.stringify({ features: {} })) }),
    handle: async (_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"items":[]}'); },
  }) });
  app.store.setRules({ ...app.store.rules(), ratePerMinute: 1000, banFailures: 100, warnFailures: 5 }, app.store.adminId);
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
}
function client() {
  const jar = new Map(); let token = ""; const ip = `198.51.100.${nextIp++}`;
  return { jar, async call(route, method = "GET", body, headers = {}) {
    const response = await fetch(base + route, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "x-console-token": token, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const cookies = response.headers.getSetCookie(); for (const cookie of cookies) { const [k, v] = cookie.split(";")[0].split("="); if (/Max-Age=0(?:;|$)/.test(cookie)) jar.delete(k); else jar.set(k, v); }
    const data = await response.json(); if (response.ok && data.token) token = data.token;
    return { status: response.status, data, cookies };
  } };
}
const login = (c, secret) => c.call("/api/auth/login", "POST", { cdk: secret });
const send = (c, email) => c.call("/api/auth/email/send", "POST", { email });
const verify = (c, code = inbox.at(-1)?.code) => c.call("/api/auth/email/verify", "POST", { code });
const cooldown = () => db.prepare("UPDATE login_email_sends SET created_at=created_at-61000").run();
async function bind(c, key, email) { await login(c, key.secret); eq((await send(c, email)).status, 200); const r = await verify(c); eq(r.status, 200); return r; }

try {
  await start(); db = new DatabaseSync(path.join(root, ".cdk", "cdk.sqlite"));
  eq(protocolEnvironment().TOSUB2_SMTP_PASSWORD, undefined, "SMTP secret is excluded from account protocol subprocesses");
  const admin = client(); const anon = client();
  eq((await anon.call("/api/jobs")).status, 401);
  const first = await login(admin, process.env.TOSUB2_ADMIN_CDK);
  eq(first.data.authState, "verify_email", "admin email is preset but requires verification");
  eq(first.data.authenticated, false); ok(!first.data.account && !first.data.settings);
  eq((await admin.call("/api/admin/cdks")).status, 401, "pending admin cannot reach management");
  eq((await admin.call("/api/jobs")).status, 401, "pending admin cannot read workspace");
  eq((await admin.call("/api/auth/email/send", "POST", {}, { "x-console-token": "forged" })).status, 403);
  eq((await admin.call("/api/auth/email/send", "POST", {}, { origin: "https://evil.invalid" })).status, 403);
  eq((await send(admin, "attacker@example.com")).status, 200);
  eq(inbox.at(-1).email, "jczheng666@gmail.com", "bound recipient cannot be replaced");
  const adminCode = inbox.at(-1).code;
  eq((await verify(admin, "x")).status, 400);
  eq((await send(admin)).status, 429, "resend cooldown");
  const challengeCookie = admin.jar.get("tosub2_login_challenge");
  const accepted = await admin.call("/api/auth/email/verify", "POST", { code: adminCode }, { "x-forwarded-proto": "https" });
  eq(accepted.data.authenticated, true); eq(accepted.data.account.email, "jczheng666@gmail.com");
  ok(accepted.cookies.filter((c) => !c.includes("Max-Age=0;")).every((c) => c.includes("HttpOnly") && c.includes("SameSite=Strict")));
  ok(accepted.cookies.filter((c) => !c.includes("Max-Age=0;")).every((c) => c.includes("; Secure")), "trusted HTTPS proxy produces Secure cookies");
  ok(accepted.cookies.some((c) => c.startsWith("tosub2_device_") && c.includes("Max-Age=2592000")));
  const replay = client(); replay.jar.set("tosub2_login_challenge", challengeCookie);
  eq((await replay.call("/api/auth/email/verify", "POST", { code: adminCode }, { "x-console-token": first.data.token })).status, 401, "consumed challenge cannot be replayed");
  const stolenSession = client(); stolenSession.jar.set("tosub2_session", admin.jar.get("tosub2_session"));
  eq((await stolenSession.call("/api/bootstrap")).data.authenticated, false, "session alone is insufficient without device credential");
  eq((await stolenSession.call("/api/admin/cdks")).status, 401);
  await admin.call("/api/auth/logout", "POST", {});
  eq((await login(admin, process.env.TOSUB2_ADMIN_CDK)).data.authenticated, true, "trusted browser can log in without another email");

  const keys = app.store.generate({ count: 9, quota: 10, note: "email auth fixtures" }, app.store.adminId);
  const user = client(); eq((await login(user, keys[0].secret)).data.authState, "bind_email");
  eq((await send(user, "bad\r\nemail")).status, 422);
  eq((await send(user, "jczheng666@gmail.com")).status, 409, "one mailbox belongs to one account");
  eq((await send(user, " User@One.Example ")).status, 200);
  eq(app.store.get(keys[0].id).email, null, "send alone does not bind");
  const oldCode = inbox.at(-1).code; cooldown();
  eq((await send(user)).status, 200, "resend works after reload with no plaintext email on client");
  const newCode = inbox.at(-1).code;
  if (oldCode !== newCode) eq((await verify(user, oldCode)).data.code, "OTP_INVALID", "old code is invalid after resend");
  db.prepare("UPDATE login_challenges SET code_expires_at=? WHERE cdk_id=?").run(Date.now() - 1, keys[0].id);
  eq((await verify(user, newCode)).data.code, "OTP_EXPIRED"); cooldown(); await send(user);
  const bound = await verify(user); eq(bound.data.authenticated, true); eq(bound.data.account.email, "user@one.example"); ok(bound.data.account.emailBoundAt);
  const outsider = client(); eq((await login(outsider, keys[0].secret)).data.authState, "verify_email");
  eq((await outsider.call("/api/cdk/merge", "POST", {})).status, 401, "new device cannot operate before email verification");
  const other = client(); await login(other, keys[1].secret); eq((await send(other, "USER@ONE.EXAMPLE")).status, 409);

  const source = client(); const preview = await user.call("/api/cdk/merge-preview", "POST", { sourceCdk: keys[2].secret }); eq(preview.status, 200);
  await bind(source, keys[2], "source@one.example");
  eq((await user.call("/api/cdk/merge", "POST", { sourceCdk: keys[2].secret, requestKey: "race-binding", fingerprint: preview.data.fingerprint, amount: preview.data.amount })).data.code, "CDK_EMAIL_BOUND", "binding after preview blocks merge at commit");
  eq(app.store.get(keys[0].id).balance, 10);
  const merging = client(); await login(merging, keys[3].secret); await send(merging, "merge@one.example"); const mergeCode = inbox.at(-1).code;
  const q = await user.call("/api/cdk/merge-preview", "POST", { sourceCdk: keys[3].secret });
  eq((await user.call("/api/cdk/merge", "POST", { sourceCdk: keys[3].secret, requestKey: "merge-wins", fingerprint: q.data.fingerprint, amount: q.data.amount })).status, 200);
  eq((await verify(merging, mergeCode)).status, 401, "merged card cannot finish an older binding challenge");
  eq(app.store.get(keys[0].id).balance, 20);

  const raceA = client(); const raceB = client(); await login(raceA, keys[4].secret); await login(raceB, keys[4].secret);
  await send(raceA, "winner@one.example"); const codeA = inbox.at(-1).code; cooldown(); await send(raceB, "loser@one.example"); const codeB = inbox.at(-1).code;
  eq((await verify(raceA, codeA)).status, 200); eq((await verify(raceB, codeB)).status, 401); eq(app.store.get(keys[4].id).email, "winner@one.example");

  const failures = client(); await login(failures, keys[5].secret); await send(failures, "fail@one.example");
  for (let i = 0; i < 5; i++) eq((await verify(failures, "wrong")).status, 400);
  eq((await verify(failures)).data.code, "OTP_ATTEMPTS_EXHAUSTED");
  eq((await send(failures)).data.code, "OTP_ATTEMPTS_EXHAUSTED", "resend cannot reset failed attempts");
  await failures.call("/api/auth/cancel", "POST", {}); await login(failures, keys[5].secret); cooldown(); await send(failures, "fail@one.example");
  for (let i = 0; i < 5; i++) await verify(failures, "wrong");
  await failures.call("/api/auth/cancel", "POST", {}); await login(failures, keys[5].secret); cooldown();
  eq((await send(failures, "fail@one.example")).status, 429, "cancel and restart cannot erase account failure budget");
  const smtp = client(); await login(smtp, keys[6].secret); deliveryFails = true; eq((await send(smtp, "smtp@one.example")).status, 503); deliveryFails = false;
  eq((await smtp.call("/api/bootstrap")).data.codeSent, false); eq((await verify(smtp, "123456")).status, 409); eq(app.store.get(keys[6].id).email, null);

  const legacy = client(); const legacySession = app.store.createSession(keys[7].id); legacy.jar.set("tosub2_session", legacySession.secret);
  eq((await legacy.call("/api/bootstrap")).data.authenticated, false, "pre-migration sessions have no device authentication");
  const devices = (await user.call("/api/auth/devices")).data.items; eq(devices.length, 1); eq(devices[0].current, true);
  const oldUserDeviceName = [...user.jar.keys()].find((name) => name.startsWith("tosub2_device_")); const oldUserDevice = user.jar.get(oldUserDeviceName);
  eq((await admin.call(`/api/auth/devices/${devices[0].id}`, "DELETE")).status, 404, "cannot revoke another account's device");
  const adminDeviceName = [...admin.jar.keys()].find((name) => name.startsWith("tosub2_device_"));
  const persistenceCookie = admin.jar.get(adminDeviceName); db.close(); await app.close(); await start(); db = new DatabaseSync(path.join(root, ".cdk", "cdk.sqlite"));
  eq((await login(admin, process.env.TOSUB2_ADMIN_CDK)).data.authenticated, true, "device trust persists through restart"); eq(admin.jar.get(adminDeviceName), persistenceCookie);
  eq((await user.call("/api/auth/devices")).status, 200, "existing verified session survives normal restart");
  eq((await user.call(`/api/auth/devices/${devices[0].id}`, "DELETE")).status, 200);
  eq((await user.call("/api/bootstrap")).data.authenticated, false, "revocation invalidates the active session");
  eq((await login(user, keys[0].secret)).data.authState, "verify_email", "revoked browser needs email again");
  cooldown(); eq((await send(user)).status, 200); eq((await verify(user)).status, 200);
  ok(user.jar.get(oldUserDeviceName) !== oldUserDevice, "reverification rotates the device credential");
  const revokedCopy = client(); revokedCopy.jar.set(oldUserDeviceName, oldUserDevice);
  eq((await login(revokedCopy, keys[0].secret)).data.authState, "verify_email", "reverification never restores a revoked credential");
  app.store.update(keys[2].id, { status: "disabled" }, app.store.adminId);
  eq((await source.call("/api/bootstrap")).data.authenticated, false);
  app.store.update(keys[2].id, { status: "active" }, app.store.adminId);
  eq((await login(source, keys[2].secret)).data.authState, "verify_email", "reenabling does not restore trust");
  const rotated = app.store.rotate(keys[4].id, app.store.adminId);
  eq((await raceA.call("/api/bootstrap")).data.authenticated, false); eq((await login(raceA, rotated.secret)).data.authState, "verify_email");
  db.prepare("UPDATE trusted_devices SET expires_at=? WHERE cdk_id=?").run(Date.now() - 1, app.store.adminId);
  eq((await admin.call("/api/admin/cdks")).status, 401, "device expiry is enforced on all authenticated requests");
  const secretRows = JSON.stringify(db.prepare("SELECT * FROM login_challenges").all());
  ok(!secretRows.includes('"code":'), "OTP plaintext is never stored");
  console.log(`CDK email auth passed (${assertions} assertions; HTTP gates, binding/merge races, OTP lifetime/resend/budgets, persistence, device theft/revocation/expiry, SMTP failure; synthetic mailer)`);
} finally { db?.close(); await app?.close(); await fs.rm(root, { recursive: true, force: true }); }
