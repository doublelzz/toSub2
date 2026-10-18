import assert from "node:assert/strict";
import { withOAuthTokenExpiry, withSub2ApiExpiry } from "../src/sub2api-export.mjs";

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
const free = withSub2ApiExpiry(normalized, { ...snapshot, subscription: { status: "ok", planType: "free", expiresAt: null } });
assert.equal(free.accounts[0].credentials.plan_type, "free");
assert.equal(free.accounts[0].credentials.subscription_expires_at, undefined);
const otherPlatform = structuredClone(original);
otherPlatform.accounts[0].platform = "anthropic";
assert.deepEqual(withSub2ApiExpiry(otherPlatform, snapshot), otherPlatform);
assert.deepEqual(withSub2ApiExpiry({ type: "other" }, snapshot), { type: "other" });

console.log("sub2api export expiry passed (token refresh, legacy exports, subscription identity, account deadlines)");
