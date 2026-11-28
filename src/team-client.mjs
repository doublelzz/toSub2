import crypto from "node:crypto";
import { authorizationIdentity, sessionIdentity } from "./account-insights.mjs";
import { TlsFingerprintTransport, DEFAULT_TLS_PROFILE, browserIdentityForTlsProfile } from "./tls-transport.mjs";

const text = (value) => typeof value === "string" ? value.trim() : "";
export const teamEmail = (value) => text(value).toLowerCase();
const integer = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
export const TEAM_ERRORS = {
  TEAM_AUTH_EXPIRED: "账号授权已过期，请更新登录后重试",
  TEAM_IDENTITY: "登录信息与所选账号不一致，请更新授权",
  TEAM_FORBIDDEN: "当前账号无权执行此操作，或上游要求重新验证会话",
  TEAM_CHALLENGE: "上游返回安全验证页面，请更新登录后重试",
  TEAM_NOT_FOUND: "团队或成员已不存在，请重新同步",
  TEAM_RATE_LIMIT: "请求过于频繁，请稍后再试",
  TEAM_NETWORK: "连接团队服务失败，请稍后重试",
  TEAM_TIMEOUT: "团队请求超时，请先同步核对操作结果",
  TEAM_RESPONSE: "团队服务返回的数据无法确认，请先重新同步",
  TEAM_UNAVAILABLE: "团队服务暂时不可用，请稍后重试",
  TEAM_CANCELLED: "操作已停止",
};
export function teamError(code, status = 409, uncertain = false) {
  return Object.assign(new Error(TEAM_ERRORS[code] || "团队操作失败"), { code, status, uncertain });
}
export function publicTeamError(error) {
  return { code: Object.hasOwn(TEAM_ERRORS, error?.code) ? error.code : "TEAM_UNAVAILABLE",
    message: TEAM_ERRORS[error?.code] || TEAM_ERRORS.TEAM_UNAVAILABLE };
}
export function teamIdentity(source, email) {
  try {
    if (source?.invalidatedAt) throw new Error("token_expired");
    const identity = source?.type === "sub2api-data" ? authorizationIdentity(source, email) : sessionIdentity(source, email);
    if (source?.accountId && source.accountId !== identity.accountId) throw new Error("identity_mismatch");
    if (source?.expiresAt && Date.parse(source.expiresAt) <= Date.now()) throw new Error("token_expired");
    return identity;
  } catch (error) { throw teamError(["token_expired", "authorization_invalid"].includes(error.message) ? "TEAM_AUTH_EXPIRED" : "TEAM_IDENTITY"); }
}
export const teamRoleLabel = (role) => ({ "account-owner": "所有者", "account-admin": "管理员", "standard-user": "成员", "analytics-viewer": "分析查看者", "account-analytics-viewer": "分析查看者" })[role] || "未识别角色";
export const TEAM_INVITE_ROLES = ["standard-user", "account-admin", "account-owner"];
export const teamInviteRoleChoices = (role) => role === "account-owner" ? [...TEAM_INVITE_ROLES] : ["account-admin", "standard-user"].includes(role) ? ["standard-user"] : [];
export function teamSnapshotCapabilities(snapshot, { email, accountUserId, role: discoveredRole } = {}) {
  const current = snapshot.members?.items.find((member) => member.email === email && (!accountUserId || member.accountUserId === accountUserId));
  const role = current?.role || "", seatType = role === "account-owner" ? "default" : snapshot.settings?.defaultSeatType;
  const policyKnown = snapshot.policy?.verified === true;
  const errors = snapshot.errors || {};
  return { role, roleLabel: teamRoleLabel(role || discoveredRole), currentMemberId: current?.id || null,
    canInvite: Boolean(current && teamInviteRoleChoices(role).length && seatType === "default" && policyKnown && snapshot.invites && snapshot.subscription && !["members", "invites", "subscription", "policy", "refresh"].some((name) => errors[name])),
    canRemove: Boolean(current && ["account-owner", "account-admin"].includes(role) && !errors.members && !errors.refresh),
    canChangeRoles: Boolean(current && role === "account-owner" && !errors.members && !errors.refresh),
    inviteRoleChoices: teamInviteRoleChoices(role), inviteSeatType: seatType || null,
    inviteReason: !current ? "无法确认当前账号的团队身份，请同步成员"
      : !teamInviteRoleChoices(role).length ? "当前团队角色没有邀请权限"
      : seatType !== "default" ? "当前默认席位类型尚未接入邀请，请在官方页面操作"
      : !policyKnown ? "邀请和购买策略尚未确认，请在官方页面操作"
      : !snapshot.invites || !snapshot.subscription ? "邀请或席位数据未完整同步"
      : errors.refresh ? "团队操作结果正在自动同步确认" : "" };
}
export function teamCanRemove(role, member, current) {
  if (!member || !current || member.role === "account-owner" || member.id === current.id || member.email === current.email) return false;
  if (role === "account-owner") return true;
  return role === "account-admin" && ["standard-user", "analytics-viewer", "account-analytics-viewer"].includes(member.role);
}
export function teamRoleChoices(role, member, current, members = []) {
  if (role !== "account-owner" || !current || !member || member.scimManaged) return [];
  if (member.role === "account-owner") return members.filter((row) => row.role === "account-owner").length > 1 ? ["standard-user"] : [];
  return ["standard-user", "account-admin", "analytics-viewer", "account-analytics-viewer"].includes(member.role) ? ["account-owner"] : [];
}
function segment(value) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value || "")) throw teamError("TEAM_IDENTITY");
  return encodeURIComponent(value);
}
export function discoverTeamAccounts(data) {
  if (!data?.accounts || typeof data.accounts !== "object" || Array.isArray(data.accounts)) throw teamError("TEAM_RESPONSE");
  const result = new Map();
  for (const [key, value] of Object.entries(data.accounts)) {
    const account = value?.account;
    if (!account || typeof account !== "object") continue;
    const id = text(account.account_id) || (key !== "default" ? key : "");
    const plan = text(account.plan_type).toLowerCase();
    const structure = text(account.structure).toLowerCase();
    if (!id || account.is_deactivated || value.can_access_with_session === false || structure === "personal") continue;
    if (!["team", "business", "enterprise"].includes(plan) && !["workspace", "organization"].includes(structure)) continue;
    segment(id);
    const row = { id, name: text(account.name).slice(0, 160) || "未命名团队", role: text(account.account_user_role),
      accountUserId: text(account.account_user_id), planType: plan || "business", isTrial: account.is_trial === true,
      trialEnd: date(account.trial_state?.expires_at || account.trial_state?.end_at), discoveryEntitlement: value.entitlement || null };
    const previous = result.get(id);
    if (previous && (previous.role !== row.role || previous.accountUserId !== row.accountUserId)) throw teamError("TEAM_IDENTITY");
    if (!previous || key === id) result.set(id, row);
  }
  return [...result.values()].map(({ discoveryEntitlement, ...row }) => row);
}
export function normalizeTeamSubscription(data, team = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw teamError("TEAM_RESPONSE");
  if (data.account_id && data.account_id !== team.id) throw teamError("TEAM_IDENTITY");
  const entitlement = data.entitlement || {};
  const pools = {};
  for (const type of ["default", "prolite"]) {
    const pool = Array.isArray(data.seat_capacity) ? data.seat_capacity.find((row) => row.type === type) : null;
    pools[type] = { type, purchased: integer(pool?.paid), used: integer(data.assigned?.[type]), available: integer(pool?.available), held: integer(pool?.held) };
  }
  const renewAt = date(entitlement.renews_at), cancelAt = date(entitlement.cancels_at);
  const expiresAt = date(entitlement.expires_at || data.active_until);
  const trialEnd = date(entitlement.trial?.expires_at || entitlement.trial?.end_at || team.trialEnd || (team.isTrial ? expiresAt : null));
  const willRenew = typeof data.will_renew === "boolean" ? data.will_renew : typeof data.last_active_subscription?.will_renew === "boolean" ? data.last_active_subscription.will_renew : null;
  const event = cancelAt ? { kind: "expiry", at: cancelAt, label: "到期时间" }
    : trialEnd && (team.isTrial || entitlement.trial) ? { kind: "trial", at: trialEnd, label: "试用到期" }
    : willRenew === true && renewAt ? { kind: "renewal", at: renewAt, label: "下次续费" }
    : expiresAt ? { kind: "entitlement", at: expiresAt, label: "当前权益截止" } : { kind: "unknown", at: null, label: "订阅时间未知" };
  return { pools, used: integer(data.seats_in_use), entitled: integer(data.seats_entitled), willRenew, event,
    billingPeriod: text(data.billing_period || entitlement.billing_period), planType: text(data.plan_type || team.planType),
    active: typeof data.is_active === "boolean" ? data.is_active : null, checkedAt: new Date().toISOString() };
}
function normalizeMember(row) {
  if (!row || !text(row.id) || !teamEmail(row.email)) throw teamError("TEAM_RESPONSE");
  segment(row.id);
  return { id: row.id, accountUserId: text(row.account_user_id), name: text(row.name).slice(0, 160), email: teamEmail(row.email),
    role: text(row.role), roleLabel: teamRoleLabel(row.role), seatType: text(row.seat_type), joinedAt: date(row.created_time), scimManaged: row.is_scim_managed === true };
}
function normalizeInvite(row) {
  if (!row || !teamEmail(row.email_address)) throw teamError("TEAM_RESPONSE");
  return { id: text(row.id), email: teamEmail(row.email_address), role: text(row.role), seatType: text(row.seat_type),
    createdAt: date(row.created_time), status: typeof row.status === "number" || typeof row.status === "string" ? row.status : null };
}

export async function createTeamClient({ session, email, proxyUrl = "", chatgptBase = process.env.CHATGPT_BASE || "https://chatgpt.com", signal,
  fetcher, transportFactory = (options) => new TlsFingerprintTransport(options), timeoutMs = 30_000 }) {
  const identity = teamIdentity(session, email);
  const base = new URL(chatgptBase);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/") throw teamError("TEAM_IDENTITY");
  if (session.chatgptBase && new URL(session.chatgptBase).origin !== base.origin) throw teamError("TEAM_IDENTITY");
  const native = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && native)) throw teamError("TEAM_IDENTITY");
  const profile = text(session.tlsProfile) || process.env.TOSUB2_TLS_PROFILE || DEFAULT_TLS_PROFILE;
  const transport = fetcher ? null : transportFactory({ enabled: !native, profile, verbose: false, sameProxyRiskRetries: 0, cloudflareSolver: false, maxProxySessionAttempts: 1 });
  const deviceId = text(session.deviceId) || crypto.randomUUID();
  const abort = () => { void transport?.close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try { if (signal?.aborted) throw teamError("TEAM_CANCELLED"); await transport?.configure(proxyUrl || null); }
  catch (error) { signal?.removeEventListener("abort", abort); await transport?.close().catch(() => {}); throw error.code?.startsWith("TEAM_") ? error : teamError("TEAM_NETWORK"); }
  const fetchRequest = fetcher || ((url, options) => transport.fetch(url, options));
  async function request(path, { method = "GET", body, workspaceId = identity.accountId } = {}) {
    if (signal?.aborted) throw teamError("TEAM_CANCELLED");
    if (!path.startsWith("/backend-api/") || path.includes("..") || path.includes("\\")) throw teamError("TEAM_IDENTITY");
    const controller = new AbortController();
    const stop = () => controller.abort(); signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => { controller.abort(); if (!fetcher) void transport.close().catch(() => {}); }, timeoutMs);
    const mutation = method !== "GET";
    try {
      const browser = browserIdentityForTlsProfile(transport?.identityProfile || profile);
      const response = await fetchRequest(`${base.origin}${path}`, { method, signal: controller.signal, timeoutMs,
        redirect: "error", noSessionCookies: true, headers: { authorization: `Bearer ${identity.accessToken}`, "chatgpt-account-id": workspaceId,
          "oai-device-id": deviceId, "user-agent": browser.userAgent, "accept-language": browser.acceptLanguage,
          accept: "application/json", "content-type": "application/json", origin: base.origin, referer: `${base.origin}/admin/members` },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.status === 401) throw teamError("TEAM_AUTH_EXPIRED");
      if (response.status === 403) throw teamError(response.headers?.get?.("cf-mitigated") ? "TEAM_CHALLENGE" : "TEAM_FORBIDDEN", 403);
      if (response.status === 404) throw teamError("TEAM_NOT_FOUND", 404);
      if (response.status === 429) throw teamError("TEAM_RATE_LIMIT", 429);
      if (!response.ok) throw teamError("TEAM_UNAVAILABLE", 502, mutation && response.status >= 500);
      let data;
      try { const raw = await response.text(); if (Buffer.byteLength(raw) > 4_000_000) throw new Error(); data = JSON.parse(raw); }
      catch { throw teamError("TEAM_RESPONSE", 502, mutation); }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw teamError("TEAM_RESPONSE", 502, mutation);
      return data;
    } catch (error) {
      if (Object.hasOwn(TEAM_ERRORS, error.code)) throw error;
      throw teamError(signal?.aborted ? "TEAM_CANCELLED" : controller.signal.aborted ? "TEAM_TIMEOUT" : "TEAM_NETWORK", 502, mutation);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); }
  }
  async function discover() { return discoverTeamAccounts(await request("/backend-api/accounts/check/v4-2023-04-27")); }
  async function collection(id, type) {
    const items = []; let total = null;
    for (let offset = 0, page = 0; page < 100 && offset < 5000; page += 1) {
      const params = new URLSearchParams({ limit: "100", offset: String(offset), query: "" });
      if (type === "invites") { params.set("include_pending", "true"); params.set("include_requests", "false"); }
      const data = await request(`/backend-api/accounts/${segment(id)}/${type}?${params}`, { workspaceId: id });
      if (!Array.isArray(data.items) || integer(data.total) === null || data.items.length > 100 || data.has_more === true && data.items.length === 0) throw teamError("TEAM_RESPONSE");
      total = data.total;
      items.push(...data.items.map(type === "users" ? normalizeMember : normalizeInvite));
      if (items.length >= total && data.has_more !== true) {
        if (items.length !== total || new Set(items.map((row) => type === "users" ? row.id : row.id || row.email)).size !== items.length) throw teamError("TEAM_RESPONSE");
        return { items, total, checkedAt: new Date().toISOString() };
      }
      if (!data.items.length) throw teamError("TEAM_RESPONSE");
      offset += data.items.length;
    }
    throw teamError("TEAM_RESPONSE");
  }
  async function snapshot(team) {
    const id = team.id;
    const tasks = { members: () => collection(id, "users"), invites: () => collection(id, "invites"),
      subscription: async () => normalizeTeamSubscription(await request(`/backend-api/subscriptions?account_id=${segment(id)}`, { workspaceId: id }), team),
      settings: () => request(`/backend-api/accounts/${segment(id)}/settings?include_workspace_discovery=true`, { workspaceId: id }),
      policy: () => request("/backend-api/pageConfigs/billing", { workspaceId: id }) };
    const names = Object.keys(tasks); const values = await Promise.allSettled(names.map((name) => tasks[name]()));
    const result = { errors: {}, checkedAt: new Date().toISOString() };
    values.forEach((value, index) => {
      const name = names[index];
      if (value.status === "fulfilled") result[name] = value.value;
      else result.errors[name] = publicTeamError(value.reason);
    });
    if (Object.values(result.errors).some((error) => ["TEAM_AUTH_EXPIRED", "TEAM_IDENTITY"].includes(error.code))) throw teamError("TEAM_AUTH_EXPIRED");
    const defaultSeatType = text(result.settings?.default_seat_type);
    const policy = result.policy?.invite_prepurchase;
    if (policy?.workspace_id && policy.workspace_id !== id) throw teamError("TEAM_IDENTITY");
    const policyKnown = policy && ["prepurchase"].includes(policy.invite_purchase_mode);
    // Persist only the policy fields used by this feature, never unrelated billing data.
    result.settings = { defaultSeatType };
    result.policy = { invitePurchaseMode: text(policy?.invite_purchase_mode), verified: Boolean(policyKnown) };
    result.capabilities = teamSnapshotCapabilities(result, { email: identity.email, accountUserId: team.accountUserId, role: team.role });
    return result;
  }
  return { discover, snapshot,
    invite: (id, emails, requestKey, role = "standard-user") => {
      if (!TEAM_INVITE_ROLES.includes(role)) throw teamError("TEAM_FORBIDDEN", 403);
      return request(`/backend-api/accounts/${segment(id)}/invites`, { method: "POST", workspaceId: id,
        body: { email_addresses: emails, role, seat_type: "default", resend_emails: false, submission_id: requestKey,
          submission_surface: "admin_console_members", purchase_authorization_choice: "not_shown", entry_surface: "admin_console_members" } });
    },
    remove: (id, memberId) => request(`/backend-api/accounts/${segment(id)}/users/${segment(memberId)}`, { method: "DELETE", workspaceId: id }),
    setRole: (id, memberId, role) => request(`/backend-api/accounts/${segment(id)}/users/${segment(memberId)}`, { method: "PATCH", workspaceId: id, body: { role } }),
    close: async () => { signal?.removeEventListener("abort", abort); await transport?.close(); } };
}
