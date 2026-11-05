import assert from "node:assert/strict";
import path from "node:path";
import { accountAccessToken, loadAccountAccessToken, exportAccountAccessTokens } from "../src/account-token-export.mjs";

const now = Date.parse("2026-11-05T08:00:00Z");
const auth = "https://api.openai.com/auth";
const profile = "https://api.openai.com/profile";
const email = "fixture@example.com";
const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic-signature`;
const token = jwt({ email, [profile]: { email }, [auth]: { chatgpt_account_id: "account-one" }, exp: now / 1000 + 3600 });
const session = { type: "chatgpt-session", version: 1, email, accountId: "account-one", accessToken: token, expiresAt: "2099-01-01T00:00:00Z" };
const oauth = { type: "sub2api-data", version: 1, accounts: [{ platform: "openai", type: "oauth", expires_at: 4_000_000_000,
  credentials: { email, chatgpt_account_id: "account-one", access_token: token, expires_at: "2099-01-01T00:00:00Z", subscription_expires_at: "2098-01-01T00:00:00Z" } }] };
assert.deepEqual(accountAccessToken(session, "session", email.toUpperCase(), now), { email, accessToken: token, source: "session", expiresAt: "2026-11-05T09:00:00.000Z", expired: false });
assert.equal(accountAccessToken(oauth, "oauth", email, now).expiresAt, "2026-11-05T09:00:00.000Z");
for (const exp of [0, 1, now / 1000]) {
  const source = { ...session, accessToken: jwt({ exp, [auth]: { chatgpt_account_id: "account-one" } }) };
  const entry = accountAccessToken(source, "session", email, now);
  assert.equal(entry.expired, true, "expired ATs including exp=0 are exported unchanged");
  assert.equal(entry.accessToken, source.accessToken);
  assert.equal(entry.expiresAt, new Date(exp * 1000).toISOString());
}
for (const exp of [null, "123456", {}, 1e100]) {
  const source = structuredClone(oauth); source.accounts[0].credentials.access_token = jwt({ exp });
  assert.equal(accountAccessToken(source, "oauth", email, now).expiresAt, null, "an invalid JWT expiry stays unknown instead of using a conflicting stored date");
}
const opaqueSession = { ...session, accessToken: "synthetic-opaque-session" };
assert.deepEqual(accountAccessToken(opaqueSession, "session", email, now), { email, accessToken: opaqueSession.accessToken, source: "session", expiresAt: null, expired: null }, "a session lifetime does not stand in for an AT expiry");
const opaqueOauth = structuredClone(oauth); opaqueOauth.accounts[0].credentials.access_token = "synthetic-opaque-oauth";
assert.equal(accountAccessToken(opaqueOauth, "oauth", email, now).expiresAt, "2099-01-01T00:00:00.000Z");
opaqueOauth.accounts[0].credentials.expires_at = now / 1000 - 1;
assert.equal(accountAccessToken(opaqueOauth, "oauth", email, now).expired, true, "stored OAuth token deadlines also accept Unix seconds");
delete opaqueOauth.accounts[0].credentials.expires_at;
assert.equal(accountAccessToken(opaqueOauth, "oauth", email, now).expiresAt, null, "subscription and account management deadlines are never token expiry");
for (const accessToken of ["secret\nsecond", "secret\r", "secret\tvalue", "secret\x00value", "secret\u2028value", " secret", {}, "e30.bad-json.sig", `e30.${Buffer.from("[]").toString("base64url")}.sig`]) {
  assert.throws(() => accountAccessToken({ ...session, accessToken }, "session", email, now), { tokenExportCode: "token_invalid" });
}
for (const source of [
  { ...session, email: "other@example.com" },
  { ...session, accessToken: jwt({ email: "other@example.com" }) },
  { ...session, accessToken: jwt({ [profile]: { email: "other@example.com" } }) },
  { ...session, accountId: "wrong-account" },
  { ...session, accessToken: jwt({ [auth]: { chatgpt_account_id: "wrong-account" } }) },
]) assert.throws(() => accountAccessToken(source, "session", email, now), { tokenExportCode: "identity_mismatch" });
assert.throws(() => accountAccessToken({ ...opaqueSession, accountId: "" }, "session", email, now), { tokenExportCode: "identity_missing" });
assert.throws(() => accountAccessToken({ ...session, invalidatedAt: "2026-11-05T00:00:00Z" }, "session", email, now), { tokenExportCode: "invalidated" });
assert.throws(() => accountAccessToken({ ...session, version: 2 }, "session", email, now), { tokenExportCode: "session_invalid" });
for (const source of [{ ...oauth, accounts: [] }, { ...oauth, accounts: [oauth.accounts[0], oauth.accounts[0]] }, { ...oauth, accounts: [{ ...oauth.accounts[0], platform: "other" }] }]) {
  assert.throws(() => accountAccessToken(source, "oauth", email, now), { tokenExportCode: "oauth_invalid" });
}

const outputPath = path.resolve("synthetic-token-export", "job", "sub2api-import-oauth.json");
const sessionPath = path.join(path.dirname(outputPath), "account-session.json");
const files = new Map([[sessionPath, JSON.stringify(session)], [outputPath, JSON.stringify(oauth)]]);
const reads = [];
const readFile = async (target) => { reads.push(target); if (!files.has(target)) throw Object.assign(new Error("synthetic missing"), { code: "ENOENT" }); return files.get(target); };
const job = { email, outputPath };
assert.equal((await loadAccountAccessToken(job, { readFile, now })).source, "session");
assert.deepEqual(reads, [sessionPath], "session precedence never reads OAuth or login credentials");
files.delete(sessionPath);
assert.equal((await loadAccountAccessToken(job, { readFile, now })).source, "oauth");
files.set(sessionPath, JSON.stringify({ type: "chatgpt-session", version: 1, email, accessToken: "" }));
assert.equal((await loadAccountAccessToken(job, { readFile, now })).source, "oauth", "the real writer's empty session placeholder allows OAuth fallback");
for (const value of [JSON.stringify({ ...session, invalidatedAt: "2026-11-05T00:00:00Z" }), "{invalid-json", JSON.stringify({ ...session, email: "other@example.com", accessToken: "" })]) {
  files.set(sessionPath, value); reads.length = 0;
  const report = await exportAccountAccessTokens([job], { readFile, now });
  assert.equal(report.exported, 0);
  assert.equal(report.skipped.length, 1);
  assert.deepEqual(reads, [sessionPath], "invalidated, corrupt or mismatched sessions cannot silently fall back to old OAuth credentials");
  assert.doesNotMatch(JSON.stringify(report), /synthetic-signature|accessToken|account-one/);
}
files.clear();
assert.deepEqual(await exportAccountAccessTokens([job], { readFile, now }), { requested: 1, exported: 0, entries: [], skipped: [{ email, reason: "未保存访问令牌" }] });
const safe = await exportAccountAccessTokens([job], { now, readFile: async () => { throw new Error("secret-path PRIVATE_TOKEN"); } });
assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_TOKEN|secret-path/);
console.log("account AT export passed (source precedence, empty-session fallback, identity checks, expired/unknown expiry, invalidation, safe partial results; no network)");
