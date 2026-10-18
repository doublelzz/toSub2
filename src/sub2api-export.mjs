const AUTH_CLAIM = "https://api.openai.com/auth";
const text = (value) => typeof value === "string" ? value.trim() : "";
const email = (value) => text(value).toLowerCase();
const plan = (value) => /^[a-z0-9_-]{1,80}$/i.test(text(value)) ? text(value).toLowerCase() : "";

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
      const tokenPlan = plan(id[AUTH_CLAIM]?.chatgpt_plan_type) || plan(access[AUTH_CLAIM]?.chatgpt_plan_type);
      if (!credentials.plan_type && tokenPlan) credentials.plan_type = tokenPlan;
      const subscription = matchingSubscription(credentials, snapshot, id, access);
      const subscriptionPlan = plan(subscription?.planType);
      if (subscriptionPlan) {
        credentials.plan_type = subscriptionPlan;
        if (["free", "basic", "xbasic"].includes(subscriptionPlan)) delete credentials.subscription_expires_at;
        else {
          const expiresAt = isoDate(subscription.expiresAt);
          if (expiresAt) credentials.subscription_expires_at = expiresAt;
        }
      }
      // Account-level expires_at is an administrator's scheduling deadline, not token expiry.
      return { ...account, credentials };
    }),
  };
}
