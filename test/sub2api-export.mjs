import assert from "node:assert/strict";
import { withOAuthTokenExpiry, withSub2ApiExpiry, normalizeOAuthCredentials, validateSub2ApiData, summarizeSub2ApiTokens, summarizeSub2ApiUpload, mergeSub2ApiCredentials } from "../src/sub2api-export.mjs";

const authClaim = "https://api.openai.com/auth";
const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture`;
const now = Date.parse("2026-10-18T00:00:00Z");
const exp = Math.floor(now / 1000) + 3600;
const expiresAt = "2026-10-18T01:00:00.000Z";
const credentials = {
  email: "expiry@example.com",
  access_token: jwt({ exp, [authClaim]: { chatgpt_account_id: "personal-account" } }),
  id_token: jwt({ exp: exp - 1800, email: "expiry@example.com", sid: "session-id",
    [authClaim]: { chatgpt_account_id: "personal-account", chatgpt_plan_type: "plus" } }),
  refresh_token: "fixture-refresh",
  chatgpt_account_id: "session-id",
  model_mapping: { "gpt-5": "gpt-5" },
};

assert.equal(withOAuthTokenExpiry(credentials, { expires_in: 7200 }, now).expires_at, expiresAt,
  "access-token expiry takes precedence over response lifetime and ID-token expiry");
assert.equal(withOAuthTokenExpiry({ access_token: "opaque" }, { expires_in: 3600 }, now).expires_at, expiresAt);
assert.equal(withOAuthTokenExpiry({ access_token: "opaque" }, { expires_at: exp }, now).expires_at, expiresAt);
assert.equal(withOAuthTokenExpiry({ expires_at: exp }).expires_at, expiresAt);
assert.equal(withOAuthTokenExpiry({ expires_at: expiresAt }).expires_at, expiresAt);
assert.equal(withOAuthTokenExpiry({ expires_at: "2026-10-18T01:00:00" }).expires_at, undefined,
  "expiry metadata must include its timezone");
assert.equal(withOAuthTokenExpiry({ access_token: "opaque", expires_at: expiresAt }, {}, now).expires_at, undefined,
  "a new token without expiry information must not retain the previous token's date");
assert.equal(withOAuthTokenExpiry({ ...credentials, expires_at: "2000-01-01T00:00:00Z" }).expires_at, expiresAt);
for (const value of [null, 0, -1, Infinity, "bad", 1e100]) {
  assert.equal(withOAuthTokenExpiry({ access_token: jwt({ exp: value }), expires_at: "bad" }).expires_at, undefined);
  assert.equal(withOAuthTokenExpiry({ access_token: "opaque" }, { expires_in: value }, now).expires_at, undefined);
}
assert.equal(withOAuthTokenExpiry({ id_token: credentials.id_token }).expires_at, undefined,
  "an ID-token expiry cannot substitute for access-token expiry");

const original = {
  type: "sub2api-data", version: 1, accounts: [{
    name: "expiry", platform: "openai", type: "oauth", credentials,
    expires_at: exp + 30 * 86400, auto_pause_on_expired: true,
  }],
};
const snapshot = {
  email: "expiry@example.com", accountId: "personal-account",
  subscription: { status: "ok", planType: "plus", expiresAt: "2099-01-01T00:00:00Z" },
};
const originalRaw = JSON.stringify(original);
const normalized = withSub2ApiExpiry(original, snapshot);
assert.equal(normalized.accounts[0].credentials.expires_at, expiresAt);
assert.equal(normalized.accounts[0].credentials.subscription_expires_at, "2099-01-01T00:00:00.000Z");
assert.equal(normalized.accounts[0].credentials.plan_type, "plus");
assert.deepEqual(normalized.accounts[0].credentials.model_mapping, credentials.model_mapping);
assert.equal(normalized.accounts[0].expires_at, original.accounts[0].expires_at,
  "the administrator's account deadline must be preserved independently of token expiry");
assert.equal(JSON.stringify(original), originalRaw, "normalizing downloads cannot mutate stored authorization data");
const withoutDeadline = structuredClone(original);
delete withoutDeadline.accounts[0].expires_at;
assert.equal(withSub2ApiExpiry(withoutDeadline, snapshot).accounts[0].expires_at, undefined);

for (const invalid of [
  { ...snapshot, email: "other@example.com" },
  { ...snapshot, accountId: "other-account" },
  { ...snapshot, subscription: { ...snapshot.subscription, stale: true } },
  { ...snapshot, subscription: { ...snapshot.subscription, error: "unauthorized" } },
  { ...snapshot, subscription: { ...snapshot.subscription, status: "error" } },
]) {
  assert.equal(withSub2ApiExpiry(original, invalid).accounts[0].credentials.subscription_expires_at, undefined,
    "mismatched or stale snapshots must not supply an expiry");
}
const conflicting = structuredClone(original);
conflicting.accounts[0].credentials.access_token = jwt({ exp, [authClaim]: { chatgpt_account_id: "other-account" } });
assert.equal(withSub2ApiExpiry(conflicting, snapshot).accounts[0].credentials.subscription_expires_at, undefined);
const noAccountClaims = structuredClone(original);
noAccountClaims.accounts[0].credentials.access_token = jwt({ exp });
noAccountClaims.accounts[0].credentials.id_token = jwt({ sid: "session-id" });
assert.equal(withSub2ApiExpiry(noAccountClaims, { ...snapshot, accountId: "session-id" }).accounts[0].credentials.subscription_expires_at, undefined,
  "legacy sid values are session identifiers, not subscription account IDs");
const free = withSub2ApiExpiry(normalized, { ...snapshot, checkedAt: "2026-10-18T02:00:00Z", subscription: { status: "ok", planType: "free", expiresAt: null } });
assert.equal(free.accounts[0].credentials.plan_type, "free");
assert.equal(free.accounts[0].credentials.subscription_expires_at, undefined);
const otherPlatform = structuredClone(original);
otherPlatform.accounts[0].platform = "anthropic";
assert.deepEqual(withSub2ApiExpiry(otherPlatform, snapshot), otherPlatform);
assert.deepEqual(withSub2ApiExpiry({ type: "other" }, snapshot), { type: "other" });

console.log("sub2api export expiry passed (token refresh, legacy exports, subscription identity, account deadlines)");

const identityClaims = { chatgpt_account_id: "personal-account", chatgpt_user_id: "chatgpt-user", user_id: "different-auth-user", chatgpt_plan_type: "plus", organizations: [{ id: "first-org" }, { id: "default-org", is_default: true }] };
const fresh = normalizeOAuthCredentials({
  access_token: jwt({ exp, iat: exp - 3600, [authClaim]: identityClaims }),
  id_token: jwt({ email: "expiry@example.com", sid: "session-only", sub: "different-subject", [authClaim]: identityClaims }),
  refresh_token: "refresh-secret",
}, { clientId: "actual-client", expectedEmail: "EXPIRY@example.com" });
assert.equal(fresh.chatgpt_account_id, "personal-account");
assert.equal(fresh.chatgpt_user_id, "chatgpt-user");
assert.equal(fresh.organization_id, "default-org");
assert.equal(fresh.client_id, "actual-client");
assert.equal(fresh.expires_at, expiresAt);
assert.throws(() => normalizeOAuthCredentials({ ...fresh, id_token: jwt({ email: "other@example.com", [authClaim]: identityClaims }) }), /邮箱/);
assert.throws(() => normalizeOAuthCredentials({ ...fresh, access_token: jwt({ [authClaim]: { ...identityClaims, chatgpt_account_id: "other-account" } }) }), /账号 ID/);
assert.throws(() => normalizeOAuthCredentials({ ...fresh, access_token: jwt({ [authClaim]: { ...identityClaims, chatgpt_user_id: "other-user" } }) }), /用户 ID/);
assert.throws(() => normalizeOAuthCredentials({ access_token: "opaque", id_token: jwt({ email: "expiry@example.com", sid: "session-only" }) }), /真实账号 ID/);
assert.throws(() => normalizeOAuthCredentials(fresh, { previousCredentials: { ...fresh, id_token: "", access_token: jwt({ [authClaim]: { chatgpt_account_id: "previous-account" } }) } }), /刷新返回/);

const bundle = { type: "sub2api-data", version: 1, proxies: [], accounts: [{ name: "fixture", platform: "openai", type: "oauth", credentials: fresh, concurrency: 0, priority: 0, rate_multiplier: 0 }] };
assert.equal(validateSub2ApiData(bundle, "expiry@example.com"), bundle);
const badStoredId = structuredClone(bundle);
badStoredId.accounts[0].credentials.chatgpt_account_id = "session-only";
assert.throws(() => validateSub2ApiData(badStoredId), /导出账号 ID/);
assert.equal(badStoredId.accounts[0].credentials.chatgpt_account_id, "session-only", "read-time validation must not migrate old identities");
assert.throws(() => validateSub2ApiData(bundle, "wrong@example.com"), /邮箱/);
assert.throws(() => validateSub2ApiData({ ...bundle, proxies: null }), /结构/);
assert.throws(() => validateSub2ApiData({ ...bundle, accounts: [{ ...bundle.accounts[0], concurrency: -1 }] }), /非负整数/);

const freeToken = { ...fresh, access_token: jwt({ exp, iat: exp - 3600, [authClaim]: { ...identityClaims, chatgpt_plan_type: "free" } }),
  id_token: jwt({ email: fresh.email, iat: exp - 7200, [authClaim]: identityClaims }), plan_type: "plus", subscription_expires_at: "2099-01-01T00:00:00Z" };
const freeBundle = { ...bundle, accounts: [{ ...bundle.accounts[0], credentials: freeToken }] };
const staleSnapshot = { ...snapshot, checkedAt: new Date((exp - 7200) * 1000).toISOString() };
for (const state of [null, snapshot, staleSnapshot, { ...snapshot, subscription: { ...snapshot.subscription, stale: true } }]) {
  const normalizedFree = withSub2ApiExpiry(freeBundle, state).accounts[0].credentials;
  assert.equal(normalizedFree.plan_type, "free");
  assert.equal(normalizedFree.subscription_expires_at, undefined);
}
const currentSnapshot = { ...snapshot, checkedAt: new Date(exp * 1000).toISOString(), subscription: { status: "ok", planType: "pro", expiresAt: "2099-02-01T00:00:00Z" } };
const pro = withSub2ApiExpiry(freeBundle, currentSnapshot).accounts[0].credentials;
assert.equal(pro.plan_type, "pro");
assert.equal(pro.subscription_expires_at, "2099-02-01T00:00:00.000Z");
const unknownPaidExpiry = withSub2ApiExpiry({ ...bundle, accounts: [{ ...bundle.accounts[0], credentials: pro }] }, { ...currentSnapshot, subscription: { status: "ok", planType: "go", expiresAt: null } });
assert.equal(unknownPaidExpiry.accounts[0].credentials.subscription_expires_at, undefined);
assert.equal(mergeSub2ApiCredentials({ subscription_expires_at: "2099-01-01T00:00:00Z", model_mapping: { test: "test" }, client_id: "stale-client" }, freeToken).client_id, fresh.client_id);
const merged = mergeSub2ApiCredentials({ subscription_expires_at: "2099-01-01T00:00:00Z", model_mapping: { test: "test" } }, withSub2ApiExpiry(freeBundle).accounts[0].credentials);
assert.equal(merged.subscription_expires_at, undefined);
assert.deepEqual(merged.model_mapping, { test: "test" });
assert.deepEqual(summarizeSub2ApiTokens([
  bundle.accounts[0], { credentials: { access_token: jwt({ exp: 1 }), refresh_token: "present" } },
  { credentials: { access_token: jwt({ exp: 1 }) } }, { credentials: { access_token: "opaque" } },
], now), { valid: 1, expiredWithRefresh: 1, expiredWithoutRefresh: 1, unknown: 1 });
const uploaded = [bundle.accounts[0], { ...bundle.accounts[0], name: "second" }];
const partial = summarizeSub2ApiUpload({ code: 0, data: { success: 2, failed: 0, results: [{ success: true }, { success: false, error: "invalid refresh-secret admin-secret" }] } }, uploaded, ["admin-secret"]);
assert.equal(partial.success, 1, "per-account results take precedence over inconsistent counters");
assert.equal(partial.failed, 1);
assert.doesNotMatch(JSON.stringify(partial), /refresh-secret|admin-secret/);
assert.match(partial.results[1].message, /invalid/);
assert.equal(summarizeSub2ApiUpload({ data: { success: 1, failed: 1 } }, uploaded).failed, 1);
assert.equal(summarizeSub2ApiUpload({}, uploaded).unknown, 2);
assert.equal(summarizeSub2ApiUpload({ success: 99, failed: 0 }, uploaded).success, 0);
assert.equal(summarizeSub2ApiUpload({ code: 403, message: "group denied" }, uploaded).failed, 2);
console.log("sub2api identity, subscription transitions, read-only validation and upload reporting passed");
