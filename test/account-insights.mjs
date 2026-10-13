import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { authorizationIdentity, sessionIdentity, collectAccountInsights, parseResetCredits, parseUsage, publicAccountInsights, checkAccountInsights, loadAccountInsights } from "../src/account-insights.mjs";

const authClaim = "https://api.openai.com/auth";
const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const identity = { email: "quota@example.com", accountId: "personal-account" };
const data = {
  type: "sub2api-data", accounts: [{ credentials: {
    email: identity.email, access_token: "synthetic-access-secret", refresh_token: "synthetic-refresh-secret",
    id_token: jwt({ email: identity.email, sid: "session-id", [authClaim]: { chatgpt_account_id: identity.accountId, chatgpt_plan_type: "plus" } }),
    chatgpt_account_id: "session-id",
  } }],
};
assert.equal(authorizationIdentity(data).accountId, identity.accountId);
assert.throws(() => authorizationIdentity(data, "other@example.com"), /identity_mismatch/);
const missing = structuredClone(data);
missing.accounts[0].credentials.id_token = jwt({ email: identity.email, sid: "session-id" });
assert.throws(() => authorizationIdentity(missing), /identity_missing/);
const mismatch = structuredClone(data);
mismatch.accounts[0].credentials.access_token = jwt({ [authClaim]: { chatgpt_account_id: "workspace-account" } });
assert.throws(() => authorizationIdentity(mismatch), /identity_mismatch/);
const expired = structuredClone(data);
expired.accounts[0].credentials.access_token = jwt({ exp: 1 });
assert.throws(() => authorizationIdentity(expired), /token_expired/);
const session = { type: "chatgpt-session", version: 1, email: identity.email, accessToken: jwt({ email: identity.email, exp: Math.floor(Date.now() / 1000) + 60, [authClaim]: { chatgpt_account_id: identity.accountId } }) };
assert.equal(sessionIdentity(session, identity.email).accountId, identity.accountId);
assert.throws(() => sessionIdentity(session, "other@example.com"), /identity_mismatch/);
assert.throws(() => sessionIdentity({ ...session, email: "other@example.com" }, identity.email), /identity_mismatch/);
assert.throws(() => sessionIdentity({ ...session, accessToken: jwt({ exp: 1, [authClaim]: { chatgpt_account_id: identity.accountId } }) }), /token_expired/);
assert.throws(() => sessionIdentity({ ...session, accessToken: "opaque-token" }), /identity_missing/);
assert.throws(() => authorizationIdentity(session), /authorization_invalid/, "session credentials must never be treated as Codex OAuth");
let invalidSessionRequests = 0;
const invalidSession = await collectAccountInsights({ ...session, email: "other@example.com" }, { expectedEmail: identity.email, fetcher: async () => { invalidSessionRequests++; } });
assert.equal(invalidSession.quota.error, "identity_mismatch");
assert.equal(invalidSessionRequests, 0);

const usage = {
  ...identity, account_id: identity.accountId, plan_type: "plus",
  rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 12.3, limit_window_seconds: 18000, reset_at: 1893456000 }, secondary_window: null },
  rate_limit_reset_credits: { available_count: 3 }, credits: { balance: "1200.5000000000000001", has_credits: true, unlimited: false },
};
const parsed = parseUsage(usage, identity);
assert.equal(parsed.quota.windows.length, 1, "null windows must not become zero usage");
assert.equal(parsed.quota.windows[0].remainingPercent, 87.7);
assert.equal(parsed.quota.credits.balance, "1200.5000000000000001");
assert.throws(() => parseUsage({ ...usage, account_id: "other" }, identity), /identity_mismatch/);
assert.equal(parseResetCredits({}).availableCount, null);
assert.equal(parseResetCredits(null).availableCount, null);
assert.equal(parseResetCredits({ credits: [] }).availableCount, 0);
assert.equal(parseResetCredits({ availableCount: "0", credits: "malformed" }).availableCount, 0);
assert.equal(parseResetCredits({ available_count: -1 }).availableCount, null);
assert.equal(parseResetCredits({ available_count: "3.5" }).availableCount, null);
assert.equal(parseResetCredits({ credits: [
  { id: "private-credit-id", resetType: "codex_rate_limits", status: "available", expiresAt: "2099-01-01T00:00:00Z" },
  { status: "redeemed" }, { reset_type: "other", status: "available" },
  { status: "available" }, { status: "available", expires_at: "2000-01-01T00:00:00Z" },
] }).availableCount, 2);

let replies;
let requests = [];
const fetcher = async (url, options) => {
  const target = new URL(url);
  requests.push(target.pathname);
  assert.equal(options.method, "GET");
  assert.equal(options.retryRiskControl, false);
  assert.equal(options.solveRiskControl, false);
  assert.equal(options.headers.authorization, "Bearer synthetic-access-secret");
  assert.equal(options.headers["chatgpt-account-id"], identity.accountId);
  assert.equal(options.headers.cookie, undefined);
  if (target.pathname.endsWith("subscriptions")) assert.equal(target.searchParams.get("account_id"), identity.accountId);
  const reply = replies[target.pathname];
  return new Response(JSON.stringify(reply?.data ?? { error: "synthetic-access-secret must never leak" }), { status: reply?.status || 200 });
};
const defaults = () => ({
  "/backend-api/wham/usage": { data: usage },
  "/backend-api/wham/rate-limit-reset-credits": { data: { available_count: "0", credits: [] } },
  "/backend-api/subscriptions": { data: { plan_type: "plus", active_until: "2099-01-01T00:00:00Z", will_renew: false } },
});
replies = defaults();
let snapshot = await collectAccountInsights(data, { fetcher });
assert.equal(snapshot.status, "ok");
assert.equal(snapshot.resetCredits.availableCount, 0, "explicit zero overrides usage count");
assert.equal(snapshot.subscription.expiresAt, "2099-01-01T00:00:00.000Z");
assert.equal(requests.length, 3);
assert.ok(requests.every((route) => !route.includes("consume")));

replies = defaults();
replies["/backend-api/wham/rate-limit-reset-credits"] = { status: 403 };
snapshot = await collectAccountInsights(data, { fetcher });
assert.equal(snapshot.resetCredits.availableCount, 3, "usage count remains available if detail query fails");
replies["/backend-api/subscriptions"] = { status: 403 };
replies["/backend-api/accounts/check/v4-2023-04-27"] = { data: { accounts: {
  workspace: { account: { account_id: "workspace-account", plan_type: "plus", is_default: true }, entitlement: { expires_at: "2099-01-01T00:00:00Z" } },
} } };
snapshot = await collectAccountInsights(data, { fetcher });
assert.equal(snapshot.status, "partial");
assert.equal(snapshot.subscription.status, "error", "workspace expiry cannot become personal Plus expiry");
replies["/backend-api/accounts/check/v4-2023-04-27"].data.accounts.default = {
  account: { account_id: identity.accountId, plan_type: "plus" }, entitlement: { expires_at: "2099-02-01T00:00:00Z" },
};
snapshot = await collectAccountInsights(data, { fetcher });
assert.equal(snapshot.subscription.expiresAt, "2099-02-01T00:00:00.000Z");
replies = defaults();
replies["/backend-api/subscriptions"].data = { plan_type: "free" };
assert.equal((await collectAccountInsights(data, { fetcher })).subscription.expiresAt, null);
replies = Object.fromEntries(Object.keys(defaults()).map((key) => [key, { status: 401 }]));
snapshot = await collectAccountInsights(data, { fetcher });
assert.equal(snapshot.status, "error");
assert.equal(snapshot.quota.error, "unauthorized");
assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-access-secret|synthetic-refresh-secret|private-credit-id/);
const requestCount = requests.length;
assert.equal((await collectAccountInsights(expired, { fetcher })).status, "error");
assert.equal(requests.length, requestCount, "expired authorization must not start a login or make requests");
snapshot = await collectAccountInsights(data, { fetcher: async () => { throw new Error("proxy credentials and synthetic-access-secret"); } });
assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-access-secret|proxy credentials/);

const stale = { checkedAt: "2026-01-01T00:00:00Z", status: "ok", quota: {}, subscription: {}, resetCredits: {
  status: "ok", availableCount: 2, expirations: ["2026-02-01T00:00:00Z", "2099-01-01T00:00:00Z"],
} };
assert.equal(publicAccountInsights(stale, Date.parse("2026-03-01T00:00:00Z")).resetCredits.availableCount, 1);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-insights-"));
try {
  const exportPath = path.join(tempRoot, "sub2api-import-oauth.json");
  const raw = JSON.stringify(data);
  await fs.writeFile(exportPath, raw);
  replies = defaults();
  await checkAccountInsights(exportPath, { fetcher, expectedEmail: identity.email });
  assert.equal(await fs.readFile(exportPath, "utf8"), raw, "detection cannot change OAuth export");
  assert.equal((await loadAccountInsights(exportPath, identity.email)).status, "ok");
  assert.equal(await loadAccountInsights(exportPath, "other@example.com"), null);
  await fs.appendFile(exportPath, " ");
  assert.equal(await loadAccountInsights(exportPath, identity.email), null, "snapshot must match current authorization");
} finally { await fs.rm(tempRoot, { recursive: true, force: true }); }
console.log("account insights tests passed (identity, null/zero, precision, partial failures, expiry, persistence)");
