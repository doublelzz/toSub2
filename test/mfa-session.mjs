import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reusableMfaSession, readMfaSession, writeMfaSession, invalidateMfaSession } from "../src/mfa-session.mjs";

const email = "session-unit@example.com";
const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic-private-token`;
const claims = { email, exp: 4102444800, "https://api.openai.com/auth": { chatgpt_account_id: "session-account" } };
const session = { type: "chatgpt-session", version: 1, email, accessToken: jwt(claims), deviceId: "previous-device" };
assert.equal(reusableMfaSession(session, email).accountId, "session-account");
assert.equal(reusableMfaSession(session, email).deviceId, "previous-device");
assert.throws(() => reusableMfaSession({ ...session, accessToken: jwt({ ...claims, exp: 1 }) }, email), { mfaCode: "MFA_SESSION_EXPIRED" });
assert.throws(() => reusableMfaSession({ ...session, accessToken: jwt({ ...claims, email: "different@example.com" }) }, email), { mfaCode: "MFA_SESSION_INVALID" });
assert.throws(() => reusableMfaSession({ ...session, accountId: "other-account" }, email), { mfaCode: "MFA_SESSION_INVALID" });
assert.throws(() => reusableMfaSession({ ...session, type: "sub2api-data" }, email), { mfaCode: "MFA_SESSION_MISSING" });
assert.throws(() => reusableMfaSession({ ...session, accessToken: jwt({ ...claims, exp: 1e100 }) }, email), { mfaCode: "MFA_SESSION_INVALID" });
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-mfa-session-"));
try {
  const target = path.join(root, "session.json");
  await assert.rejects(readMfaSession(target, email), { mfaCode: "MFA_SESSION_MISSING" });
  await writeMfaSession(target, { ...session, cookies: "not-needed", password: "not-needed", totpSecret: "not-needed" }, email);
  assert.equal((await readMfaSession(target, email)).accessToken, session.accessToken);
  assert.doesNotMatch(await fs.readFile(target, "utf8"), /cookies|password|totpSecret|not-needed/);
  await assert.rejects(invalidateMfaSession(target, "different@example.com"), { mfaCode: "MFA_SESSION_INVALID" });
  await invalidateMfaSession(target, email);
  const invalidated = JSON.parse(await fs.readFile(target, "utf8"));
  assert.equal(invalidated.accessToken, "");
  assert.ok(invalidated.invalidatedAt);
  await assert.rejects(readMfaSession(target, email), { mfaCode: "MFA_SESSION_EXPIRED" });
  console.log("MFA reusable session tests passed (identity, expiry, minimal storage, invalidation)");
} finally { await fs.rm(root, { recursive: true, force: true }); }
