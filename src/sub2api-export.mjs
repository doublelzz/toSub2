const AUTH_CLAIM = "https://api.openai.com/auth";
const text = (value) => typeof value === "string" ? value.trim() : "";
const email = (value) => text(value).toLowerCase();
const plan = (value) => /^[a-z0-9_-]{1,80}$/i.test(text(value)) ? text(value).toLowerCase() : "";
export const isFreePlan = (value) => ["free", "basic", "xbasic"].includes(plan(value));

function decodeJwt(token) {
  try {
    const parts = text(token).split(".");
    return parts.length === 3 ? JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) || {} : {};
  } catch { return {}; }
}

function isoDate(value) {
  if (!text(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function seconds(value) {
  return (typeof value === "number" || (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)))
    && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
}

function unixDate(value) {
  const timestamp = seconds(value);
  const date = timestamp === null ? null : new Date(timestamp * 1000);
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function identityError(message) {
  return new Error(`SUB2API_IDENTITY_INVALID: ${message}`);
}

function oauthIdentity(credentials, expectedEmail = "", checkStored = true) {
  if (!text(credentials?.access_token)) throw identityError("缺少 access_token");
  const id = decodeJwt(credentials.id_token);
  const access = decodeJwt(credentials.access_token);
  const claims = [access[AUTH_CLAIM] || {}, id[AUTH_CLAIM] || {}];
  const emails = [expectedEmail, credentials.email, id.email, access.email, access["https://api.openai.com/profile"]?.email].map(email).filter(Boolean);
  if (!emails.length || emails.some((value) => value !== emails[0])) throw identityError("邮箱缺失或令牌邮箱不一致");
  const ids = claims.map((value) => text(value.chatgpt_account_id)).filter(Boolean);
  if (ids.some((value) => value.toLowerCase() !== ids[0].toLowerCase())) throw identityError("不同令牌的账号 ID 不一致");
  const storedId = text(credentials.chatgpt_account_id);
  const accountId = ids[0] || (storedId && storedId !== text(id.sid) ? storedId : "");
  if (!accountId) throw identityError("缺少真实账号 ID，请重新授权");
  if (checkStored && (!storedId || storedId.toLowerCase() !== accountId.toLowerCase())) throw identityError("导出账号 ID 与令牌不一致，请重新授权");
  const userIds = claims.map((value) => text(value.chatgpt_user_id)).filter(Boolean);
  if (userIds.some((value) => value !== userIds[0])) throw identityError("不同令牌的用户 ID 不一致");
  if (checkStored && userIds[0] && text(credentials.chatgpt_user_id) && credentials.chatgpt_user_id !== userIds[0]) throw identityError("导出用户 ID 与令牌不一致");
  const organizations = Array.isArray(id[AUTH_CLAIM]?.organizations) ? id[AUTH_CLAIM].organizations : [];
  const organizationId = text(organizations.find((value) => value?.is_default)?.id)
    || text(organizations[0]?.id) || text(access[AUTH_CLAIM]?.poid);
  return { email: emails[0], accountId, userId: userIds[0] || "", organizationId };
}

// Used only when generating or explicitly refreshing credentials; never migrates saved files.
export function normalizeOAuthCredentials(credentials, { tokenSet = null, clientId = "", expectedEmail = "", previousCredentials = null, now = Date.now() } = {}) {
  const identity = oauthIdentity(credentials, expectedEmail, false);
  if (previousCredentials) {
    const previous = oauthIdentity(previousCredentials, expectedEmail, false);
    if (previous.accountId.toLowerCase() !== identity.accountId.toLowerCase()
      || (previous.userId && identity.userId && previous.userId !== identity.userId)) throw identityError("刷新返回的账号身份发生变化");
  }
  const next = withOAuthTokenExpiry(credentials, tokenSet, now);
  next.email = identity.email;
  next.chatgpt_account_id = identity.accountId;
  for (const [key, value] of Object.entries({ client_id: text(clientId) || text(credentials.client_id), chatgpt_user_id: identity.userId, organization_id: identity.organizationId })) {
    if (value) next[key] = value;
    else delete next[key];
  }
  return withSub2ApiExpiry({ type: "sub2api-data", accounts: [{ platform: "openai", type: "oauth", credentials: next }] }).accounts[0].credentials;
}

export function validateSub2ApiData(data, expectedEmail = "") {
  if (data?.type !== "sub2api-data" || data.version !== 1 || !Array.isArray(data.proxies) || !Array.isArray(data.accounts) || !data.accounts.length) {
    throw new Error("Sub2API 导入文件结构不正确");
  }
  for (const account of data.accounts) {
    if (!text(account?.name) || account.platform !== "openai" || account.type !== "oauth") throw new Error("Sub2API 账号类型或名称不正确");
    for (const key of ["concurrency", "priority"]) {
      if (!Number.isInteger(account[key]) || account[key] < 0) throw new Error(`Sub2API ${key} 必须是非负整数`);
    }
    if (account.rate_multiplier != null && (typeof account.rate_multiplier !== "number" || !Number.isFinite(account.rate_multiplier) || account.rate_multiplier < 0)) throw new Error("Sub2API 倍率不正确");
    if (account.expires_at != null && (!Number.isSafeInteger(account.expires_at) || account.expires_at < 0)) throw new Error("账号管理期限必须是 Unix 秒整数");
    oauthIdentity(account.credentials, expectedEmail);
  }
  return data;
}

export function summarizeSub2ApiTokens(accounts, now = Date.now()) {
  const summary = { valid: 0, expiredWithRefresh: 0, expiredWithoutRefresh: 0, unknown: 0 };
  for (const account of accounts) {
    const credentials = account.credentials || {};
    const expiry = unixDate(decodeJwt(credentials.access_token).exp) || isoDate(credentials.expires_at);
    const state = !expiry ? "unknown" : Date.parse(expiry) > now ? "valid"
      : text(credentials.refresh_token) ? "expiredWithRefresh" : "expiredWithoutRefresh";
    summary[state]++;
  }
  return summary;
}

export function mergeSub2ApiCredentials(remote, current) {
  const merged = { ...remote };
  for (const key of ["access_token", "refresh_token", "id_token", "client_id", "email", "chatgpt_account_id", "chatgpt_user_id", "organization_id", "plan_type", "expires_at", "subscription_expires_at"]) delete merged[key];
  return { ...merged, ...current };
}

export function summarizeSub2ApiUpload(payload, accounts, secrets = []) {
  const result = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const rows = Array.isArray(result?.results) ? result.results : [];
  const sensitive = [...secrets, ...accounts.flatMap((account) => [account.credentials?.access_token, account.credentials?.refresh_token, account.credentials?.id_token])].filter((value) => typeof value === "string" && value.length);
  const errorMessage = (value) => {
    let message = text(value) || "Sub2API 拒绝创建，请在目标后台查看原因";
    for (const secret of sensitive) message = message.split(secret).join("[redacted]");
    return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/[\r\n\t]+/g, " ").slice(0, 500);
  };
  if (typeof payload?.code === "number" && payload.code !== 0) return {
    success: 0, failed: accounts.length, unknown: 0,
    results: accounts.map((account) => ({ name: account.name, success: false, message: errorMessage(payload.message) })),
  };
  const count = (value) => Number.isInteger(value) && value >= 0 && value <= accounts.length ? value : null;
  const completeRows = rows.length === accounts.length && rows.every((row) => typeof row?.success === "boolean");
  let success = completeRows ? rows.filter((row) => row.success).length : count(result?.success ?? result?.account_created);
  let failed = completeRows ? rows.filter((row) => !row.success).length : count(result?.failed ?? result?.account_failed);
  if (success === null || failed === null || success + failed > accounts.length) { success = 0; failed = 0; }
  // Return only result fields, with supplied credentials removed from upstream errors.
  return { success, failed, unknown: accounts.length - success - failed, results: accounts.map((account, index) => ({
    name: account.name,
    success: completeRows ? rows[index].success : success === accounts.length ? true : failed === accounts.length ? false : null,
    message: completeRows ? (rows[index].success ? "已创建" : errorMessage(rows[index].error || rows[index].message))
      : success === accounts.length ? "已创建" : failed === accounts.length ? "Sub2API 拒绝创建" : "上游未提供可核对的逐条结果",
  })) };
}

export function withOAuthTokenExpiry(credentials, tokenSet = null, now = Date.now()) {
  const next = { ...credentials };
  const lifetime = seconds(tokenSet?.expires_in);
  const expiresAt = unixDate(decodeJwt(next.access_token).exp)
    || (tokenSet && (unixDate(tokenSet.expires_at) || isoDate(tokenSet.expires_at)
      || (lifetime === null ? null : unixDate(Math.floor(now / 1000) + lifetime))))
    || (!tokenSet && (unixDate(next.expires_at) || isoDate(next.expires_at)));
  if (expiresAt) next.expires_at = expiresAt;
  else delete next.expires_at;
  return next;
}

function matchingSubscription(credentials, snapshot, id, access) {
  const subscription = snapshot?.subscription;
  if (subscription?.status !== "ok" || subscription.stale || subscription.error || subscription.refreshError) return null;
  const issuedAt = Math.max(seconds(id.iat) || 0, seconds(access.iat) || 0) * 1000;
  const checkedAt = Date.parse(subscription.checkedAt || snapshot.checkedAt);
  if (issuedAt && (!Number.isFinite(checkedAt) || checkedAt < issuedAt)) return null;
  if (!Number.isFinite(checkedAt) && plan(credentials.plan_type) && plan(subscription.planType) !== plan(credentials.plan_type)) return null;
  const expectedEmail = email(snapshot.email);
  const emails = [credentials.email, id.email, access.email, access["https://api.openai.com/profile"]?.email]
    .map(email).filter(Boolean);
  if (!expectedEmail || !emails.length || emails.some((value) => value !== expectedEmail)) return null;
  const ids = [id[AUTH_CLAIM]?.chatgpt_account_id, access[AUTH_CLAIM]?.chatgpt_account_id].map(text).filter(Boolean);
  if (ids.some((value) => value !== ids[0])) return null;
  const storedId = text(credentials.chatgpt_account_id);
  const accountId = ids[0] || (storedId && storedId !== id.sid ? storedId : "");
  return accountId && accountId === text(snapshot.accountId) ? subscription : null;
}

export function withSub2ApiExpiry(data, snapshot = null) {
  if (data?.type !== "sub2api-data" || !Array.isArray(data.accounts)) return data;
  return {
    ...data,
    accounts: data.accounts.map((account) => {
      if (account?.platform !== "openai" || account.type !== "oauth" || !account.credentials) return account;
      const credentials = withOAuthTokenExpiry(account.credentials);
      const id = decodeJwt(credentials.id_token);
      const access = decodeJwt(credentials.access_token);
      const tokens = (seconds(id.iat) || 0) > (seconds(access.iat) || 0) ? [id, access] : [access, id];
      const tokenPlan = tokens.map((token) => plan(token[AUTH_CLAIM]?.chatgpt_plan_type)).find(Boolean);
      if (tokenPlan) {
        if (plan(credentials.plan_type) !== tokenPlan || isFreePlan(tokenPlan)) delete credentials.subscription_expires_at;
        credentials.plan_type = tokenPlan;
      }
      const subscription = matchingSubscription(credentials, snapshot, id, access);
      const subscriptionPlan = plan(subscription?.planType);
      if (subscriptionPlan) {
        credentials.plan_type = subscriptionPlan;
        if (isFreePlan(subscriptionPlan)) delete credentials.subscription_expires_at;
        else {
          const expiresAt = isoDate(subscription.expiresAt);
          if (expiresAt) credentials.subscription_expires_at = expiresAt;
          else delete credentials.subscription_expires_at;
        }
      } else if (snapshot?.subscription) delete credentials.subscription_expires_at;
      // Account-level expires_at is an administrator's scheduling deadline, not token expiry.
      return { ...account, credentials };
    }),
  };
}
