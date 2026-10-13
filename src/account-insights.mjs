import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const ACCOUNT_INSIGHTS_FILENAME = "account-insights.json";
const AUTH_CLAIM = "https://api.openai.com/auth";
const ERROR_MESSAGES = {
  authorization_invalid: "授权文件无效，请重新授权",
  identity_missing: "授权中缺少账号标识，请刷新授权后检测",
  identity_mismatch: "授权身份与当前账号不一致，已停止检测",
  token_expired: "访问令牌已过期，请先刷新授权",
  unauthorized: "访问令牌无效或已过期，请先刷新授权",
  forbidden: "接口拒绝访问，请检查代理或稍后重试",
  timeout: "检测超时，请稍后重试",
  network: "网络请求失败，请检查账号代理",
  http_error: "接口暂时不可用，请稍后重试",
  invalid_response: "接口未返回有效数据",
  unavailable: "接口未提供该字段",
};
const hash = (raw) => crypto.createHash("sha256").update(raw).digest("hex");
const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const text = (value) => typeof value === "string" ? value.trim() : "";
const plan = (value) => /^[a-z0-9_-]{1,80}$/i.test(text(value)) ? text(value).toLowerCase() : null;
const number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
const bool = (value) => typeof value === "boolean" ? value : null;
const count = (value) => (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim())))
  && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const date = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const failure = (error, httpStatus = null) => ({ status: "error", error: Object.hasOwn(ERROR_MESSAGES, error) ? error : "unavailable", message: ERROR_MESSAGES[error] || ERROR_MESSAGES.unavailable, httpStatus });

function decodeJwt(token) {
  try {
    const parts = text(token).split(".");
    return parts.length === 3 ? JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) : {};
  } catch { return {}; }
}

export function authorizationIdentity(data, expectedEmail = "") {
  if (data?.type !== "sub2api-data" || data.accounts?.length !== 1) throw new Error("authorization_invalid");
  const credentials = data.accounts[0]?.credentials;
  if (!text(credentials?.access_token)) throw new Error("authorization_invalid");
  const id = decodeJwt(credentials.id_token);
  const access = decodeJwt(credentials.access_token);
  const emails = [credentials.email, id.email, access.email, access["https://api.openai.com/profile"]?.email]
    .map(normalizeEmail).filter(Boolean);
  const email = normalizeEmail(expectedEmail) || emails[0];
  if (!email || emails.some((candidate) => candidate !== email)) throw new Error("identity_mismatch");
  const ids = [id[AUTH_CLAIM]?.chatgpt_account_id, access[AUTH_CLAIM]?.chatgpt_account_id].map(text).filter(Boolean);
  if (ids.some((candidate) => candidate.toLowerCase() !== ids[0].toLowerCase())) throw new Error("identity_mismatch");
  // Older exports stored sid (a session ID) here. It cannot select a subscription account.
  const storedId = text(credentials.chatgpt_account_id);
  const accountId = ids[0] || (storedId && storedId !== id.sid ? storedId : "");
  if (!accountId) throw new Error("identity_missing");
  if (number(access.exp) !== null && access.exp * 1000 <= Date.now()) throw new Error("token_expired");
  return { email, accountId, accessToken: credentials.access_token, planType: plan(id[AUTH_CLAIM]?.chatgpt_plan_type) };
}

function windowInfo(value, key) {
  if (!value || typeof value !== "object") return null;
  const used = number(value.used_percent);
  if (used === null || used < 0 || used > 100) return null;
  const seconds = number(value.limit_window_seconds);
  const resetAt = number(value.reset_at);
  const resetAfter = number(value.reset_after_seconds);
  return {
    key, usedPercent: used, remainingPercent: Math.max(0, 100 - used),
    windowSeconds: seconds > 0 ? seconds : null,
    resetAt: resetAt > 0 && Number.isFinite(new Date(resetAt * 1000).getTime()) ? new Date(resetAt * 1000).toISOString()
      : resetAfter !== null && resetAfter >= 0 ? new Date(Date.now() + resetAfter * 1000).toISOString() : null,
    resetAfterSeconds: resetAfter >= 0 ? resetAfter : null,
  };
}

export function parseUsage(data, identity) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid_response");
  if ((data.email && normalizeEmail(data.email) !== identity.email)
    || (data.account_id && text(data.account_id).toLowerCase() !== identity.accountId.toLowerCase())) throw new Error("identity_mismatch");
  const windows = [windowInfo(data.rate_limit?.primary_window, "primary"), windowInfo(data.rate_limit?.secondary_window, "secondary")].filter(Boolean);
  const credits = data.credits;
  const balance = typeof credits?.balance === "string" && /^\d+(?:\.\d+)?$/.test(credits.balance) ? credits.balance : null;
  const quota = {
    status: windows.length || typeof data.rate_limit?.allowed === "boolean" || credits ? "ok" : "error",
    planType: plan(data.plan_type), allowed: bool(data.rate_limit?.allowed), limitReached: bool(data.rate_limit?.limit_reached), windows,
    credits: credits ? { hasCredits: bool(credits.has_credits), unlimited: bool(credits.unlimited), balance } : null,
  };
  if (quota.status === "error") Object.assign(quota, failure("unavailable"));
  return { quota, resetCount: count(data.rate_limit_reset_credits?.available_count) };
}

export function parseResetCredits(data, now = Date.now()) {
  const explicit = count(data?.available_count) ?? count(data?.availableCount);
  const list = Array.isArray(data) ? data : [data?.credits, data?.rate_limit_reset_credits, data?.items, data?.data].find((item) => item != null);
  const available = Array.isArray(list) ? list.filter((item) => item && typeof item === "object"
    && (!text(item.reset_type || item.resetType) || text(item.reset_type || item.resetType).toLowerCase() === "codex_rate_limits")
    && (!text(item.status) || text(item.status).toLowerCase() === "available")) : [];
  const expirations = available.map((item) => date(item.expires_at || item.expiresAt)).filter((item) => item && Date.parse(item) > now);
  const liveCount = available.filter((item) => !date(item.expires_at || item.expiresAt) || Date.parse(item.expires_at || item.expiresAt) > now).length;
  return { availableCount: explicit ?? (Array.isArray(list) ? liveCount : null), expirations };
}

async function requestJson(fetcher, base, endpoint, identity, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(new URL(endpoint, base).toString(), {
      method: "GET", redirect: "manual", signal: controller.signal, timeoutMs, retryRiskControl: false, solveRiskControl: false, noSessionCookies: true,
      headers: {
        authorization: `Bearer ${identity.accessToken}`, "chatgpt-account-id": identity.accountId,
        "openai-beta": "codex-1", "oai-language": "zh-CN", originator: "Codex Desktop",
        origin: new URL(base).origin, referer: `${new URL(base).origin}/`, accept: "application/json",
        "sec-fetch-site": "none", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "empty", priority: "u=4, i",
      },
    });
    if (!response.ok) return { failure: failure(response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : "http_error", response.status) };
    try { return { data: await response.json() }; } catch { return { failure: failure("invalid_response") }; }
  } catch (error) {
    return { failure: failure(controller.signal.aborted || error?.name === "AbortError" || /timed out/i.test(error?.message || "") ? "timeout" : "network") };
  } finally { clearTimeout(timer); }
}

function parseSubscription(data, identity) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return failure("invalid_response");
  if (data.account_id && text(data.account_id).toLowerCase() !== identity.accountId.toLowerCase()) return failure("identity_mismatch");
  const planType = plan(data.plan_type) || identity.planType;
  const expiresAt = date(data.active_until);
  if (!planType || (planType === "plus" && !expiresAt)) return failure("unavailable");
  return { status: "ok", planType, expiresAt: planType === "plus" ? expiresAt : null, willRenew: bool(data.will_renew) };
}

export async function collectAccountInsights(data, { expectedEmail, fetcher = fetch, chatgptBase = "https://chatgpt.com", timeoutMs = 15_000 } = {}) {
  const checkedAt = new Date().toISOString();
  const snapshot = { version: 1, email: normalizeEmail(expectedEmail || data?.accounts?.[0]?.credentials?.email), checkedAt };
  let identity;
  try { identity = authorizationIdentity(data, expectedEmail); } catch (error) {
    return { ...snapshot, status: "error", quota: failure(error.message), subscription: failure(error.message), resetCredits: failure(error.message) };
  }
  snapshot.email = identity.email;
  const [usage, resets, subscription] = await Promise.all([
    requestJson(fetcher, chatgptBase, "/backend-api/wham/usage", identity, timeoutMs),
    requestJson(fetcher, chatgptBase, "/backend-api/wham/rate-limit-reset-credits", identity, timeoutMs),
    requestJson(fetcher, chatgptBase, `/backend-api/subscriptions?account_id=${encodeURIComponent(identity.accountId)}`, identity, timeoutMs),
  ]);
  let resetCount = null;
  try {
    if (usage.failure) snapshot.quota = usage.failure;
    else ({ quota: snapshot.quota, resetCount } = parseUsage(usage.data, identity));
  } catch (error) { snapshot.quota = failure(error.message); }
  // An identity mismatch invalidates all results from this authorization.
  if (snapshot.quota.error === "identity_mismatch") return { ...snapshot, status: "error", subscription: failure("identity_mismatch"), resetCredits: failure("identity_mismatch") };
  const details = resets.failure ? null : parseResetCredits(resets.data, Date.parse(checkedAt));
  const availableCount = details?.availableCount ?? resetCount;
  snapshot.resetCredits = availableCount !== null
    ? { status: "ok", availableCount, expirations: details?.expirations || [], source: details && details.availableCount !== null ? "details" : "usage" }
    : resets.failure || failure("unavailable");
  snapshot.subscription = subscription.failure || parseSubscription(subscription.data, identity);
  if (snapshot.subscription.status === "error" && snapshot.subscription.error !== "identity_mismatch") {
    // Fallback only to the exact personal account; never borrow a workspace expiry.
    const fallback = await requestJson(fetcher, chatgptBase, "/backend-api/accounts/check/v4-2023-04-27", identity, timeoutMs);
    const candidate = Object.entries(fallback.data?.accounts || {}).find(([key, item]) => text(item?.account?.account_id || key).toLowerCase() === identity.accountId.toLowerCase())?.[1];
    const planType = plan(candidate?.account?.plan_type);
    const expiresAt = date(candidate?.entitlement?.expires_at);
    if (!candidate?.account?.is_deactivated && ["free", "plus", "pro", "go"].includes(planType) && (planType !== "plus" || expiresAt)) {
      snapshot.subscription = { status: "ok", planType, expiresAt: planType === "plus" ? expiresAt : null, willRenew: null };
    } else if (identity.planType && identity.planType !== "plus" && snapshot.subscription.error === "unavailable") {
      snapshot.subscription = { status: "ok", planType: identity.planType, expiresAt: null, willRenew: null };
    }
  }
  const successes = [snapshot.quota, snapshot.subscription, snapshot.resetCredits].filter((item) => item.status === "ok").length;
  snapshot.status = successes === 3 ? "ok" : successes ? "partial" : "error";
  return snapshot;
}

export async function checkAccountInsights(exportPath, options = {}) {
  const raw = await fs.readFile(exportPath, "utf8");
  let data;
  try { data = JSON.parse(raw); } catch { data = null; }
  const snapshot = await collectAccountInsights(data, options);
  snapshot.authorizationFingerprint = hash(raw);
  if (hash(await fs.readFile(exportPath, "utf8")) !== snapshot.authorizationFingerprint) throw new Error("Authorization changed during account detection");
  const target = path.join(path.dirname(exportPath), ACCOUNT_INSIGHTS_FILENAME);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
  return snapshot;
}

export async function loadAccountInsights(exportPath, expectedEmail) {
  try {
    const [raw, stored] = await Promise.all([
      fs.readFile(exportPath, "utf8"), fs.readFile(path.join(path.dirname(exportPath), ACCOUNT_INSIGHTS_FILENAME), "utf8"),
    ]);
    const snapshot = JSON.parse(stored);
    if (!publicAccountInsights(snapshot)) return null;
    return snapshot.version === 1 && snapshot.authorizationFingerprint === hash(raw) && snapshot.email === normalizeEmail(expectedEmail)
      ? snapshot : null;
  } catch { return null; }
}

export function publicAccountInsights(snapshot, now = Date.now()) {
  if (!snapshot || !date(snapshot.checkedAt)) return null;
  const project = (item) => item?.status === "ok" ? { status: "ok" } : failure(item?.error, count(item?.httpStatus));
  const quota = project(snapshot.quota);
  if (quota.status === "ok") Object.assign(quota, {
    planType: plan(snapshot.quota.planType), allowed: bool(snapshot.quota.allowed), limitReached: bool(snapshot.quota.limitReached),
    windows: (snapshot.quota.windows || []).filter((item) => ["primary", "secondary"].includes(item.key)).map((item) => ({
      key: item.key, usedPercent: number(item.usedPercent), remainingPercent: number(item.remainingPercent),
      windowSeconds: number(item.windowSeconds), resetAt: date(item.resetAt), resetAfterSeconds: number(item.resetAfterSeconds),
    })),
    credits: snapshot.quota.credits ? {
      hasCredits: bool(snapshot.quota.credits.hasCredits), unlimited: bool(snapshot.quota.credits.unlimited),
      balance: /^\d+(?:\.\d+)?$/.test(snapshot.quota.credits.balance) ? snapshot.quota.credits.balance : null,
    } : null,
  });
  const subscription = project(snapshot.subscription);
  if (subscription.status === "ok") Object.assign(subscription, {
    planType: plan(snapshot.subscription.planType), expiresAt: date(snapshot.subscription.expiresAt), willRenew: bool(snapshot.subscription.willRenew),
  });
  const resetCredits = project(snapshot.resetCredits);
  if (resetCredits.status === "ok") {
    const expired = (snapshot.resetCredits.expirations || []).filter((item) => date(item) && Date.parse(item) > Date.parse(snapshot.checkedAt) && Date.parse(item) <= now).length;
    const availableCount = count(snapshot.resetCredits.availableCount);
    if (availableCount === null) Object.assign(resetCredits, failure("unavailable"));
    else resetCredits.availableCount = Math.max(0, availableCount - expired);
  }
  return { checkedAt: date(snapshot.checkedAt), status: ["ok", "partial", "error"].includes(snapshot.status) ? snapshot.status : "error", quota, subscription, resetCredits };
}
