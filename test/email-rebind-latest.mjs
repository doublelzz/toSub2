import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { extractMailboxOtpCandidates, selectLatestMailboxOtpCandidate } from "../src/mail-otp.mjs";
import { createEmailRebindWorkspace } from "../src/email-rebind-workspace.mjs";
import { rebindError } from "../src/email-rebind-protocol.mjs";

const requestedAt = Date.parse("2026-11-26T03:32:21.421Z");
const checkedAt = requestedAt + 5000;
const candidate = (code, receivedAt, score = 50, key = code) => ({ code, receivedAt, score, key });
const oldest = candidate("111111", requestedAt - 1, 1000);
const earlier = candidate("222222", requestedAt + 1000, 1000);
const latest = candidate("001234", requestedAt + 3000, 5);
const untimed = candidate("333333", null, 9999);
const invalid = candidate("444444", NaN, 9999);
const future = candidate("555555", checkedAt + 1, 9999);
const mixed = [earlier, future, latest, untimed, oldest, invalid];
assert.equal(selectLatestMailboxOtpCandidate(mixed, requestedAt, checkedAt), latest);
assert.equal(selectLatestMailboxOtpCandidate([...mixed].reverse(), requestedAt, checkedAt), latest);
assert.equal(selectLatestMailboxOtpCandidate([oldest, untimed, invalid, future], requestedAt, checkedAt), null);
assert.equal(selectLatestMailboxOtpCandidate(mixed, NaN, checkedAt), null);
assert.equal(selectLatestMailboxOtpCandidate(mixed, requestedAt, requestedAt - 1), null);
assert.equal(selectLatestMailboxOtpCandidate([candidate("000123", requestedAt)], requestedAt, checkedAt)?.code, "000123");
const primary = candidate("001234", checkedAt, 74);
assert.equal(selectLatestMailboxOtpCandidate([candidate("654321", checkedAt, 56), primary], requestedAt, checkedAt), primary);

const extracted = extractMailboxOtpCandidates(JSON.stringify({ messages: [
  { id: "old", updated_at: new Date(checkedAt).toISOString(), created_at: new Date(checkedAt).toISOString(),
    received_at: new Date(requestedAt - 1).toISOString(), code: "111111" },
  { id: "earlier", received_at: new Date(requestedAt + 1000).toISOString(), code: "222222" },
  { id: "latest", received_at: "2026-11-26T11:32:24.421+08:00", code: "001234" },
] }));
assert.equal(selectLatestMailboxOtpCandidate(extracted, requestedAt, checkedAt)?.code, "001234",
  "receive time must outrank creation/update time, with timezone offsets normalized");
const seconds = extractMailboxOtpCandidates(JSON.stringify({ code: "001234", received_at: Math.floor((requestedAt + 2000) / 1000) }));
assert.equal(selectLatestMailboxOtpCandidate(seconds, requestedAt, checkedAt)?.code, "001234");
const milliseconds = extractMailboxOtpCandidates(JSON.stringify({ code: "001234", received_at: requestedAt + 2000 }));
assert.equal(selectLatestMailboxOtpCandidate(milliseconds, requestedAt, checkedAt)?.code, "001234");
const expiryOnly = extractMailboxOtpCandidates(JSON.stringify({ code: "001234", expired_date: new Date(checkedAt).toISOString() }));
assert.equal(selectLatestMailboxOtpCandidate(expiryOnly, requestedAt, checkedAt), null, "expiration time is not mail delivery time");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-rebind-latest-"));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const vault = await createCdkVault(root);
let workspace;
const until = async callback => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = callback();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`latest-mail scenario timed out: ${JSON.stringify(workspace?.list())}`);
};
async function scenario(name, mode) {
  let clock = requestedAt;
  let sentAt = 0;
  let sends = 0;
  let polls = 0;
  const verified = [];
  const sources = [{ id: "source", email: `${name}@example.com`, sources: ["authorization"] }];
  workspace = await createEmailRebindWorkspace({ root: path.join(root, name), vault, pollIntervalMs: 1,
    now: () => clock, listSources: () => sources, isAccountBusy: () => false,
    resolveSource: async (_id, email) => ({ session: { type: "chatgpt-session", version: 1, email,
      accessToken: "local-fixture-token", accountId: name, expiresAt: "2099-01-01T00:00:00Z" }, credentials: {} }),
    pollMailbox: async () => {
      if (!sentAt) return [candidate("999999", requestedAt - 1000, 100, "baseline")];
      polls++;
      clock += 1000;
      if (mode === "untimed") return [candidate("001234", null)];
      if (mode === "wait" && polls === 1) return [candidate("111111", sentAt - 1000), candidate("222222", null), candidate("333333", clock + 3600000)];
      if (mode === "resend" && sends === 1) return [candidate("123456", clock), candidate("999999", requestedAt - 1000, 100, "baseline")];
      if (mode === "resend" && polls === 2) return [candidate("123456", requestedAt + 1000)];
      return [candidate("111111", sentAt - 1, 999), candidate("222222", clock - 500, 999),
        candidate("001234", clock, 74), candidate("654321", clock, 56),
        candidate("333333", null, 999), candidate("444444", clock + 3600000, 999),
        candidate("999999", clock, 999, "baseline")];
    },
    runStep: async (operation, payload) => {
      if (operation === "begin") { sentAt = clock; sends++; }
      if (operation === "verify") {
        verified.push(payload.code);
        if (mode === "resend" && sends === 1) throw rebindError("CODE_INVALID");
      }
      return { data: operation === "eligibility" ? { eligible: true } : { success: true } };
    },
  });
  const body = { ids: ["source"], text: `${name}-new@example.com----https://mail.fixture.invalid/inbox`, timeout: 30 };
  await workspace.start({ ...body, digest: workspace.preview(body).digest });
  let item = await until(() => workspace.list().items.find(row => ["success", "failed"].includes(row.status) && row.canRetry));
  if (mode === "untimed") {
    assert.equal(item.status, "failed");
    assert.match(item.message, /超时/);
    assert.deepEqual(verified, [], "a baseline alone cannot prove the time of an undated code");
  } else {
    if (mode === "resend") {
      assert.equal(item.status, "failed");
      clock = item.nextSendAt + 1;
      await workspace.retry(item.id);
      item = await until(() => workspace.list().items.find(row => row.status === "success"));
      assert.equal(item.challengeVersion, 2);
      assert.deepEqual(verified, ["123456", "001234"], "resending invalidates codes from the earlier request window");
    } else {
      assert.equal(item.status, "success");
      assert.deepEqual(verified, ["001234"], "only the latest time-verified code is submitted");
      assert.ok(item.events.every(event => event.status !== "waiting_manual"), "multiple candidates must not force manual entry");
    }
  }
  const logs = (await workspace.logs(item.id)).logs;
  assert.match(logs, /发码时间=/);
  assert.match(logs, /检查时间=/);
  if (mode !== "untimed") assert.match(logs, /选取最新一条验证码：邮件时间=/);
  await workspace.shutdown();
}
try {
  await scenario("latest", "latest");
  await scenario("wait", "wait");
  await scenario("untimed", "untimed");
  await scenario("resend", "resend");
  console.log("email rebind latest mail passed (latest-only submission, verified time window, timezone/epoch parsing, stale/future/undated rejection, resend and diagnostic timestamps)");
} finally {
  await workspace?.shutdown();
  await fs.rm(root, { recursive: true, force: true });
}
