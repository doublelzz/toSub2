import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createEmailRebindWorkspace, parseRebindTargets } from "../src/email-rebind-workspace.mjs";
import { emailRebindStep, rebindError } from "../src/email-rebind-protocol.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-rebind-unit-"));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const vault = await createCdkVault(root);
let clock = Date.now();
const sources = ["one", "two", "uncertain", "cancel"].map((name) => ({ id: name, email: `${name}@example.com`, sources: ["mfa"] }));
const calls = []; const begun = new Set(); const imported = new Map(); let instance;
const sourceSession = (email) => ({ type: "chatgpt-session", version: 1, email, accessToken: "synthetic-private-access-token", accountId: "stable-account", expiresAt: "2099-01-01T00:00:00Z" });
const credentials = { password: "synthetic-private-password", totpSecret: "JBSWY3DPEHPK3PXP", proxyUrl: "" };
const options = { root, vault, listSources: () => structuredClone(sources), isAccountBusy: () => false,
  now: () => clock, pollIntervalMs: 10,
  resolveSource: async (id, email) => ({ session: sourceSession(email), credentials: { ...credentials } }),
  lookupSync: (row) => imported.get(row.id),
  pollMailbox: async (url) => begun.has(url) ? [{ code: "001234", key: "fresh-code-fingerprint", receivedAt: clock + 1 }] : [{ code: "999999", key: "historical-code-fingerprint", receivedAt: clock - 60000 }],
  runStep: async (operation, payload) => {
    calls.push({ operation, email: payload.email, newEmail: payload.newEmail, code: payload.code });
    if (operation === "begin") begun.add("https://mail.example.com/private-retrieval-key");
    if (operation === "verify" && payload.newEmail.startsWith("uncertain")) throw rebindError("UNCERTAIN");
    if (operation === "verify" && payload.code !== "001234") throw rebindError("CODE_INVALID");
    return { data: operation === "eligibility" ? { eligible: true } : operation === "inspect" ? { email: payload.email } : { success: true } };
  },
};
const waitFor = async (predicate) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("synthetic rebind condition timed out");
};
try {
  assert.equal(parseRebindTargets("new@example.com\n\nsecond@example.com----https://mail.example.com/key", 2)[1].mode, "auto");
  assert.throws(() => parseRebindTargets("new@example.com", 2), /必须输入 2 条/);
  assert.throws(() => parseRebindTargets("new@example.com\nNEW@example.com", 2), /重复/);
  assert.throws(() => parseRebindTargets("new@example.com----", 1), /取件 URL/);
  assert.throws(() => parseRebindTargets("new@example.com----javascript:alert(1)", 1), /取件 URL/);
  assert.throws(() => parseRebindTargets("new@example.com----https://mail.example.com/shared\nsecond@example.com----https://mail.example.com/shared", 2), /取件地址重复/);
  assert.equal(parseRebindTargets("new@example.com----https://mail.example.com/key----retained", 1)[0].mailboxUrl, "https://mail.example.com/key----retained");
  let attempts = 0;
  const protocolInput = { operation: "verify", email: "one@example.com", newEmail: "new@example.com", code: "001234", session: sourceSession("one@example.com") };
  const verified = await emailRebindStep(protocolInput, async (target, request) => {
    attempts++;
    if (attempts === 1) { assert.equal(request.payload.email, "new@example.com"); return { status: 422, body: {} }; }
    assert.deepEqual(request.payload, { code: "001234" }); return { status: 200, body: { success: true } };
  });
  assert.equal(verified.success, true);
  await assert.rejects(emailRebindStep(protocolInput, async () => { throw new Error("private body and secrets"); }), { rebindCode: "UNCERTAIN" });
  await assert.rejects(emailRebindStep({ ...protocolInput, operation: "eligibility" }, async () => ({ status: 200, body: { eligible: false } })), { rebindCode: "INELIGIBLE" });
  await assert.rejects(emailRebindStep(protocolInput, async () => ({ status: 401, body: {} })), { rebindCode: "SESSION_EXPIRED" });
  await assert.rejects(emailRebindStep(protocolInput, async () => ({ status: 200, body: { success: false } })), { rebindCode: "UNCERTAIN" });
  await assert.rejects(emailRebindStep({ ...protocolInput, session: sourceSession("someone-else@example.com") }, async () => { throw new Error("must not request"); }), { rebindCode: "SESSION_INVALID" });

  instance = await createEmailRebindWorkspace(options);
  const body = { ids: ["one", "two"], text: "new-one@example.com----https://mail.example.com/private-retrieval-key\nnew-two@example.com", concurrency: 1 };
  assert.throws(() => instance.preview({ ...body, text: "new-one@example.com" }), /必须输入/);
  assert.throws(() => instance.preview({ ...body, text: "two@example.com\nnew-two@example.com" }), /已经|已在/);
  assert.throws(() => instance.preview({ ...body, ids: ["missing"] }), /不存在|必须输入/);
  assert.equal(calls.length, 0, "configuration errors cannot send requests");
  const preview = instance.preview(body);
  assert.doesNotMatch(JSON.stringify(preview), /private-retrieval-key/);
  await assert.rejects(instance.start({ ...body, digest: "stale-preview" }), /映射已变化/);
  await instance.start({ ...body, digest: preview.digest });
  await assert.rejects(instance.start({ ...body, digest: preview.digest }), /任务|占用/);
  const auto = await waitFor(() => instance.list().items.find((row) => row.oldEmail === "one@example.com" && row.status === "success"));
  let manual = await waitFor(() => instance.list().items.find((row) => row.oldEmail === "two@example.com" && row.status === "waiting_manual"));
  assert.equal(auto.newEmail, "new-one@example.com");
  assert.equal(manual.newEmail, "new-two@example.com");
  assert.equal(instance.isBusy("one@example.com"), false);
  assert.equal(instance.isBusy("two@example.com"), true);
  await assert.rejects(instance.submit(manual.id, { code: "123", version: manual.challengeVersion }), /六位/);
  await assert.rejects(instance.submit(manual.id, { code: "001234", version: manual.challengeVersion - 1 }), /最新/);
  await instance.submit(manual.id, { code: "000000", version: manual.challengeVersion });
  manual = instance.list().items.find((row) => row.id === manual.id);
  assert.equal(manual.status, "waiting_manual");
  assert.match(manual.message, /验证码不正确/);
  await assert.rejects(instance.retry(manual.id, true), /倒计时/);
  clock += 31000;
  await instance.retry(manual.id, true);
  manual = await waitFor(() => instance.list().items.find((row) => row.id === manual.id && row.status === "waiting_manual"));
  assert.equal(manual.challengeVersion, 2);
  await instance.submit(manual.id, { code: "001234", version: 2 });
  assert.equal(instance.list().items.find((row) => row.id === manual.id).status, "success");
  assert.deepEqual(calls.filter((row) => row.operation === "verify" && row.code === "001234").map((row) => [row.email, row.newEmail]), [["one@example.com", "new-one@example.com"], ["two@example.com", "new-two@example.com"]]);
  const records = instance.importRecords([auto.id, manual.id]);
  assert.equal(records[0].credentials.password, credentials.password);
  imported.set(auto.id, { id: "new-auth-job" });
  assert.equal(instance.list().items.find((row) => row.id === auto.id).syncedJobId, "new-auth-job");
  assert.doesNotMatch(JSON.stringify(instance.list()), /synthetic-private|JBSWY3DPEHPK3PXP|private-retrieval-key|001234|000000/);
  assert.doesNotMatch(await fs.readFile(path.join(root, "email-rebind/state.enc"), "utf8"), /synthetic-private-password|private-retrieval-key/);

  const unknownBody = { ids: ["uncertain"], text: "uncertain-new@example.com" };
  await instance.start({ ...unknownBody, digest: instance.preview(unknownBody).digest });
  let unknown = await waitFor(() => instance.list().items.find((row) => row.oldEmail === "uncertain@example.com" && row.status === "waiting_manual"));
  await instance.submit(unknown.id, { code: "001234", version: unknown.challengeVersion });
  unknown = instance.list().items.find((row) => row.id === unknown.id);
  assert.equal(unknown.status, "uncertain");
  await assert.rejects(instance.retry(unknown.id), /核对/);
  assert.throws(() => instance.importRecords([unknown.id]), /确认换绑成功/);
  await instance.shutdown();
  instance = await createEmailRebindWorkspace(options);
  assert.equal(instance.list().items.find((row) => row.id === unknown.id).status, "uncertain");
  sources.push({ id: "new-session", email: unknown.newEmail, sources: ["authorization"] });
  await instance.reconcile(unknown.id);
  assert.equal(instance.list().items.find((row) => row.id === unknown.id).status, "success");

  const cancelBody = { ids: ["cancel"], text: "cancel-new@example.com" };
  await instance.start({ ...cancelBody, digest: instance.preview(cancelBody).digest });
  const cancellable = await waitFor(() => instance.list().items.find((row) => row.oldEmail === "cancel@example.com" && row.status === "waiting_manual"));
  await instance.cancel([cancellable.id]);
  assert.equal(instance.list().items.find((row) => row.id === cancellable.id).status, "cancelled");
  assert.equal(instance.isBusy("cancel@example.com"), false);
  assert.equal(calls.filter((row) => row.email === "cancel@example.com" && row.operation === "verify").length, 0);
  console.log("email rebind workspace passed (exact mapping, mixed OTP, resend, uncertainty, encrypted storage and recovery)");
} finally { await instance?.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
