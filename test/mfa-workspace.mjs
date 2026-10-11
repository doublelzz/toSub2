import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMfaWorkspace } from "../src/mfa-workspace.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-mfa-workspace-"));
const oldSecret = "JBSWY3DPEHPK3PXP";
const newSecret = "NB2W45DFOIZAQWER";
const childScript = path.join(root, "mock-protocol.mjs");
const workspaces = [];
await fs.writeFile(childScript, `
import fs from "node:fs/promises";
import path from "node:path";
const email = process.argv[process.argv.indexOf("--email") + 1];
if (process.argv.includes("--logout-all")) {
  const target = process.argv[process.argv.indexOf("--logout-result") + 1];
  const attempt = process.argv[process.argv.indexOf("--logout-attempt") + 1];
  const log = path.join(path.dirname(target), "mock-runs.jsonl");
  await fs.appendFile(log, JSON.stringify({email, event:"logout-start", at:Date.now()}) + "\\n");
  if (email.startsWith("logout-stale")) process.exit(1);
  await new Promise(resolve => setTimeout(resolve, 200));
  if (process.env.CHATGPT_TOTP_SECRET !== "${newSecret}") process.exit(9);
  const marker = path.join(path.dirname(target), "logout-failed-once");
  const failed = email.startsWith("logout-failed") && !(await fs.stat(marker).catch(() => null));
  if (failed) await fs.writeFile(marker, "1");
  await fs.writeFile(target, JSON.stringify({version:1, mode:"logout_all", email, attempt_id:attempt,
    logout_succeeded:!failed, logout_at:failed ? "" : new Date().toISOString(), error_code:failed ? "MFA_LOGOUT_HTTP_ERROR" : ""}));
  process.exit(failed ? 1 : 0);
}
const target = process.argv[process.argv.indexOf("--totp-result") + 1];
const log = path.join(path.dirname(target), "mock-runs.jsonl");
await fs.appendFile(log, JSON.stringify({email, event:"start", at:Date.now()}) + "\\n");
if (!process.argv.includes("--rotate-totp") || !process.env.CHATGPT_LOGIN_PASSWORD) process.exit(8);
await new Promise(resolve => setTimeout(resolve, 200));
if (email.startsWith("failed")) {
  await fs.writeFile(target, JSON.stringify({version:1, email, stage:"activating", secret:"${newSecret}", activation_accepted:true, error_code:"MFA_CONFIRMATION_PENDING"}));
  console.error("private-password raw-cookie ${oldSecret}");
  process.exit(1);
}
await fs.writeFile(target, JSON.stringify({version:1, email, stage:"confirmed", secret:"${newSecret}", activation_succeeded:true, activated_at:new Date().toISOString(), old_factor_disabled:true, cookies:"private-cookie"}));
await fs.appendFile(log, JSON.stringify({email, event:"end", at:Date.now()}) + "\\n");
`);

function mockStore() {
  const values = new Map();
  return {
    values, failNewSecret: false, beforeSave: null,
    async load(email) { return { ...(values.get(email) || { password: "", totpSecret: "", proxyUrl: "" }) }; },
    async save(email, value) {
      if (this.beforeSave) await this.beforeSave(email, value);
      if (this.failNewSecret && value.totpSecret === newSecret) throw new Error("private-credential-error");
      values.set(email, { ...value });
    },
  };
}

async function workspace(name, options = {}) {
  const directory = path.join(root, name);
  const store = options.credentialStore || mockStore();
  const instance = await createMfaWorkspace({ root: directory, protocolScript: childScript, credentialStore: store, ...options });
  workspaces.push(instance);
  return { instance, directory, store };
}

async function settled(instance) {
  const limit = Date.now() + 10000;
  while (instance.list().running) {
    assert.ok(Date.now() < limit, "MFA mock batch timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Completion changes public status before the bookkeeping finally callback.
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function logRows(directory) {
  try { return (await fs.readFile(path.join(directory, "mfa", "mock-runs.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

try {
  const busy = new Set();
  const synchronized = [];
  const { instance, directory, store } = await workspace("batch", {
    isAccountBusy: (email) => busy.has(email),
    onSuccess: async (email, credentials) => { synchronized.push({ email, ...credentials }); },
  });
  assert.throws(() => instance.preview(`valid@example.com----first\ninvalid----private-password`), { status: 400 });
  await assert.rejects(instance.importAccounts(`valid@example.com----first\ninvalid----private-password`), { status: 400 });
  assert.equal(store.values.size, 0, "invalid trailing input must not write earlier rows");
  assert.deepEqual(instance.preview(`One@EXAMPLE.COM----private-password----${oldSecret}\none@example.com----replacement----${oldSecret}`), { accounts: [{ email: "one@example.com" }], count: 1 });
  const imported = await instance.importAccounts(`One@EXAMPLE.COM----private-password----${oldSecret}\none@example.com----replacement----${oldSecret}\ntwo@example.com----password-two\nthree@example.com----password-three\nfailed@example.com----private-password----${oldSecret}`);
  assert.equal(imported.imported, 4);
  assert.equal(imported.added, 4);
  assert.equal((await store.load("one@example.com")).password, "replacement");
  assert.equal((await logRows(directory)).length, 0, "import must not spawn protocol work");
  const ids = instance.list().accounts.map((account) => account.id);
  await assert.rejects(instance.start({ ids, concurrency: 31 }), { status: 400 });
  await assert.rejects(instance.start({ ids: [] }), { status: 400 });
  await assert.rejects(instance.exportAccounts({ ids: [] }), { status: 400 });
  busy.add("one@example.com");
  await assert.rejects(instance.start({ ids, concurrency: 2 }), { status: 409 });
  busy.clear();
  const started = await instance.start({ ids, concurrency: 2, proxyUrl: "http://synthetic:proxy-password@localhost:12345" });
  assert.equal(started.started, 4);
  assert.equal(started.concurrency, 2);
  assert.equal(instance.isBusy("ONE@example.com"), true);
  await assert.rejects(instance.start({ ids: [ids[2]], concurrency: 30 }), { status: 409 });
  await assert.rejects(instance.importAccounts("one@example.com----overwrite"), { status: 409 });
  await settled(instance);
  assert.equal(instance.list().accounts.filter((account) => account.status === "success").length, 3);
  assert.equal(instance.list().accounts.find((account) => account.email === "failed@example.com").status, "failed");
  assert.equal(instance.list().accounts.find((account) => account.email === "failed@example.com").stage, "activating");
  assert.match(instance.list().accounts.find((account) => account.email === "failed@example.com").error, /生效状态尚未确认/);
  assert.equal(synchronized.length, 3);
  const runs = await logRows(directory);
  let active = 0;
  let maximum = 0;
  for (const event of runs) {
    active += event.event === "start" ? 1 : -1;
    maximum = Math.max(maximum, active);
  }
  assert.equal(maximum, 2, "all starts share the configured worker limit");
  const exported = await instance.exportAccounts({ format: "json" });
  assert.equal(exported.count, 3);
  assert.deepEqual(JSON.parse(exported.body).map((row) => row.totpSecret), Array(3).fill(newSecret));
  const text = await instance.exportAccounts({ ids: [ids[0]], format: "txt" });
  assert.equal(text.body, `\uFEFFone@example.com----replacement----${newSecret}\r\n`);
  const metadata = await fs.readFile(path.join(directory, "mfa", "accounts.json"), "utf8");
  const publicData = metadata + JSON.stringify(instance.list()) + JSON.stringify(instance.history());
  for (const secret of [oldSecret, newSecret, "private-password", "replacement", "proxy-password", "private-cookie"]) assert.equal(publicData.includes(secret), false);
  assert.equal(instance.history().items.length, 4);
  await assert.rejects(instance.importAccounts("failed@example.com----replacement"), { status: 409 });

  const deviceLogout = await workspace("device-logout");
  await deviceLogout.instance.importAccounts(`logout-a@example.com----password-a----${oldSecret}\nlogout-failed@example.com----password-b----${oldSecret}\nlogout-c@example.com----password-c----${oldSecret}\nlogout-stale@example.com----password-d----${oldSecret}\nnot-rotated@example.com----password-e----${oldSecret}`);
  const logoutIds = deviceLogout.instance.list().accounts.slice(0, 4).map((account) => account.id);
  const unrotatedId = deviceLogout.instance.list().accounts[4].id;
  await assert.rejects(deviceLogout.instance.logoutAll({ ids: [unrotatedId] }), { status: 400 });
  await deviceLogout.instance.start({ ids: logoutIds, concurrency: 2 });
  await settled(deviceLogout.instance);
  const staleAccount = deviceLogout.instance.list().accounts[3];
  await fs.writeFile(path.join(deviceLogout.directory, "mfa", `${staleAccount.id}.logout.json`), JSON.stringify({version:1, mode:"logout_all", email:staleAccount.email, attempt_id:"stale-attempt", logout_succeeded:true, logout_at:new Date().toISOString()}));
  const beforeLogout = await deviceLogout.instance.exportAccounts({ ids: logoutIds, format: "txt" });
  await assert.rejects(deviceLogout.instance.logoutAll({ ids: logoutIds, concurrency: 31 }), { status: 400 });
  await assert.rejects(deviceLogout.instance.logoutAll({ ids: logoutIds, proxyUrl: "invalid-proxy" }), { status: 400 });
  await deviceLogout.instance.logoutAll({ ids: logoutIds, concurrency: 1 });
  assert.equal(deviceLogout.instance.isBusy("logout-a@example.com"), true);
  await assert.rejects(deviceLogout.instance.start({ ids: [logoutIds[0]] }), { status: 409 });
  await assert.rejects(deviceLogout.instance.importAccounts("logout-a@example.com----overwrite"), { status: 409 });
  const logoutCanceled = await deviceLogout.instance.cancel([logoutIds[2]]);
  assert.equal(logoutCanceled.canceled, 1);
  await settled(deviceLogout.instance);
  const logoutAccounts = deviceLogout.instance.list().accounts;
  assert.equal(logoutAccounts[0].logoutStatus, "success");
  assert.ok(logoutAccounts[0].logoutAt);
  assert.equal(logoutAccounts[1].logoutStatus, "failed");
  assert.match(logoutAccounts[1].logoutError, /服务拒绝登出/);
  assert.equal(logoutAccounts[2].logoutStatus, "interrupted");
  assert.equal(logoutAccounts[3].logoutStatus, "failed", "a result from an earlier logout attempt cannot confirm a new request");
  assert.ok(logoutAccounts.slice(0, 4).every((account) => account.status === "success"), "logout outcomes must preserve MFA success");
  assert.equal((await deviceLogout.instance.exportAccounts({ ids: logoutIds, format: "txt" })).body, beforeLogout.body);
  await deviceLogout.instance.logoutAll({ ids: [logoutIds[1], logoutIds[2]], concurrency: 2 });
  await settled(deviceLogout.instance);
  assert.ok(deviceLogout.instance.list().accounts.slice(0, 3).every((account) => account.logoutStatus === "success"));
  assert.equal((await logRows(deviceLogout.directory)).filter((row) => row.event === "start").length, 4, "logout and its retries must never rotate MFA again");
  assert.ok(deviceLogout.instance.history().items.some((item) => item.operation === "logout_all" && item.status === "success"));
  await deviceLogout.instance.shutdown();
  const logoutMetadataPath = path.join(deviceLogout.directory, "mfa", "accounts.json");
  const logoutMetadata = JSON.parse(await fs.readFile(logoutMetadataPath, "utf8"));
  logoutMetadata.accounts[2].logoutStatus = "running";
  await fs.writeFile(logoutMetadataPath, JSON.stringify(logoutMetadata));
  const restoredLogout = await workspace("device-logout", { credentialStore: deviceLogout.store });
  assert.equal(restoredLogout.instance.list().accounts[0].logoutStatus, "success");
  assert.equal(restoredLogout.instance.list().accounts[2].logoutStatus, "interrupted");
  assert.equal(restoredLogout.instance.list().accounts[2].status, "success");
  assert.equal((await restoredLogout.instance.exportAccounts({ ids: logoutIds, format: "txt" })).body, beforeLogout.body);

  const corrected = await workspace("corrected-login");
  await corrected.instance.importAccounts(`correct@example.com----wrong-password----${oldSecret}`);
  const correctedAccount = corrected.instance.list().accounts[0];
  const correctedCheckpoint = path.join(corrected.directory, "mfa", `${correctedAccount.id}.checkpoint.json`);
  await fs.writeFile(correctedCheckpoint, JSON.stringify({
    version: 1, email: correctedAccount.email, mode: "rotate", stage: "pending",
    activation_succeeded: false, old_factor_disabled: false, error_code: "MFA_PASSWORD_REJECTED",
  }));
  await corrected.instance.importAccounts(`correct@example.com----correct-password----${oldSecret}`);
  assert.equal((await corrected.store.load(correctedAccount.email)).password, "correct-password");
  await assert.rejects(fs.access(correctedCheckpoint), { code: "ENOENT" });
  await corrected.instance.start({ ids: [correctedAccount.id] });
  await settled(corrected.instance);
  assert.equal(corrected.instance.list().accounts[0].status, "success", "failed login credentials must be correctable without deleting the account");

  const canceled = await workspace("cancel");
  await canceled.instance.importAccounts("a@example.com----a\nb@example.com----b\nc@example.com----c");
  const cancelIds = canceled.instance.list().accounts.map((account) => account.id);
  await canceled.instance.start({ ids: cancelIds, concurrency: 1 });
  const cancelResult = await canceled.instance.cancel(cancelIds);
  assert.equal(cancelResult.canceled, 2);
  assert.equal(cancelResult.finishing, 1);
  await settled(canceled.instance);
  assert.equal((await logRows(canceled.directory)).filter((event) => event.event === "start").length, 1);
  assert.equal(canceled.instance.list().accounts[0].status, "success", "cancel permits the active mutation to finish");

  const recovery = await workspace("recovery");
  await recovery.instance.importAccounts(`retry@example.com----private-password----${oldSecret}`);
  const recoveryId = recovery.instance.list().accounts[0].id;
  recovery.store.failNewSecret = true;
  await recovery.instance.start({ ids: [recoveryId] });
  await settled(recovery.instance);
  assert.equal(recovery.instance.list().accounts[0].status, "failed");
  assert.equal(recovery.instance.list().accounts[0].stage, "saving");
  assert.equal((await recovery.store.load("retry@example.com")).totpSecret, oldSecret);
  await fs.access(path.join(recovery.directory, "mfa", `${recoveryId}.checkpoint.json`));
  recovery.store.failNewSecret = false;
  await recovery.instance.start({ ids: [recoveryId] });
  await settled(recovery.instance);
  assert.equal(recovery.instance.list().accounts[0].status, "success");
  assert.equal((await logRows(recovery.directory)).filter((event) => event.event === "start").length, 1, "local save retry must not rotate remote MFA again");
  await assert.rejects(fs.access(path.join(recovery.directory, "mfa", `${recoveryId}.checkpoint.json`)), { code: "ENOENT" });

  const restart = await workspace("restart");
  await restart.instance.importAccounts(`restart@example.com----private-password----${oldSecret}\npending@example.com----pending`);
  await restart.instance.shutdown();
  const restartPath = path.join(restart.directory, "mfa", "accounts.json");
  const restartMetadata = JSON.parse(await fs.readFile(restartPath, "utf8"));
  for (const account of restartMetadata.accounts) account.status = "running";
  await fs.writeFile(restartPath, JSON.stringify(restartMetadata));
  const restartAccount = restartMetadata.accounts[0];
  await fs.writeFile(path.join(restart.directory, "mfa", `${restartAccount.id}.checkpoint.json`), JSON.stringify({ version: 1, email: restartAccount.email, secret: newSecret, activation_succeeded: true, activated_at: new Date().toISOString() }));
  const restarted = await workspace("restart", { credentialStore: restart.store });
  assert.equal(restarted.instance.list().accounts[0].status, "success");
  assert.equal(restarted.instance.list().accounts[1].status, "interrupted");
  assert.equal((await logRows(restart.directory)).length, 0, "confirmed startup checkpoint recovery must stay local");

  const locked = await workspace("reservations");
  let releaseSave;
  let saveStarted;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const enteredSave = new Promise((resolve) => { saveStarted = resolve; });
  locked.store.beforeSave = async () => { saveStarted(); await saveGate; };
  const importPending = locked.instance.importAccounts("locked@example.com----password");
  assert.equal(locked.instance.isBusy("LOCKED@example.com"), true, "import reserves synchronously before encrypted save");
  await enteredSave;
  await assert.rejects(locked.instance.importAccounts("locked@example.com----other"), { status: 409 });
  releaseSave();
  await importPending;
  assert.equal(locked.instance.isBusy("locked@example.com"), false);

  const corruptDirectory = path.join(root, "corrupt", "mfa");
  await fs.mkdir(corruptDirectory, { recursive: true });
  await fs.writeFile(path.join(corruptDirectory, "accounts.json"), "invalid-json");
  const corrupt = await workspace("corrupt");
  assert.match(corrupt.instance.list().error, /工作区/);
  await assert.rejects(corrupt.instance.importAccounts("new@example.com----password"), { status: 409 });
  assert.equal(await fs.readFile(path.join(corruptDirectory, "accounts.json"), "utf8"), "invalid-json", "startup must preserve unreadable metadata");
  console.log("MFA workspace tests passed");
} finally {
  await Promise.allSettled(workspaces.map((instance) => instance.shutdown()));
  await fs.rm(root, { recursive: true, force: true });
}
