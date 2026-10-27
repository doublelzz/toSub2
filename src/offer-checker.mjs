import { authorizationIdentity, sessionIdentity } from "./account-insights.mjs";

export const OFFER_LABELS = {
  trial_1m: "Plus 免费试用 1 个月", half_1m: "Plus 半价 1 个月", half_2m: "Plus 半价 2 个月",
  half_3m: "Plus 半价 3 个月", subscribed: "已订阅", none: "无优惠", other: "其他优惠／待识别", banned: "账号已停用",
};
export const OFFER_CAMPAIGNS = {
  "plus-1-month-free": "trial_1m", "plus-1-month-50-pct-off": "half_1m",
  "plus-2-months-50-pct-off": "half_2m", "plus-3-months-50-pct-off": "half_3m",
};
export const OFFER_ERRORS = {
  unauthorized: "登录信息已失效，请恢复登录后重试", identity_mismatch: "未能确认登录身份与目标账号一致，已停止检测",
  identity_missing: "登录信息缺少账号身份", authorization_invalid: "没有可用登录信息，请补充账号资料",
  token_expired: "登录信息已过期", forbidden: "服务拒绝访问，尚未获得优惠结论",
  rate_limited: "请求过于频繁，请稍后重试", network: "网络请求未完成", invalid_response: "优惠响应异常，尚未获得结论",
  login_failed: "登录未完成，请核对资料或重新输入验证码", cancelled: "检测已停止", timeout: "等待超时，请重试",
  proxy_connection: "本批次代理连接失败，请检查代理后重试",
  proxy_dns: "代理地址或目标地址无法解析，请检查本批次代理",
  network_dns: "目标地址无法解析，请检查网络",
  network_timeout: "网络连接超时，尚未开始或完成登录",
  runtime_unavailable: "检测运行环境不可用，请联系管理员检查",
};
export const OFFER_STAGES = { input: "导入校验", login: "账号登录", session_request: "读取登录会话", session_identity: "登录会话身份校验", offer_request: "请求优惠信息", offer_response: "解析优惠响应", account_alias_conflict: "优惠账号别名结果冲突" };
export const offerError = (code, retryable = false, stage = "") => Object.assign(new Error(OFFER_ERRORS[code] || OFFER_ERRORS.login_failed), { offerCode: code, retryable, ...(Object.hasOwn(OFFER_STAGES, stage) ? { offerStage: stage } : {}) });
export function offerProtocolFailure(error, stage, proxyConfigured = false) {
  if (error?.offerCode && Object.hasOwn(OFFER_ERRORS, error.offerCode)) return error;
  const message = String(error?.message || "");
  const curlCode = Number(/curl:\s*\((\d+)\)/i.exec(message)?.[1] || 0);
  if (/PROXY_RISK_CONTROL|security-check page/i.test(message)) return offerError("forbidden", false, stage);
  if ([5, 6].includes(curlCode) || /ENOTFOUND|EAI_AGAIN|Could not resolve (?:proxy|host)/i.test(message)) return offerError(proxyConfigured ? "proxy_dns" : "network_dns", false, stage);
  if (curlCode === 28 || /timed out|ETIMEDOUT/i.test(message)) return offerError("network_timeout", true, stage);
  if (proxyConfigured && ([7, 35, 56, 60, 97].includes(curlCode) || /CONNECT tunnel|proxy authentication|PROXY_CONNECTION_RETRY/i.test(message))) return offerError("proxy_connection", false, stage);
  if (curlCode || /ECONNRESET|ECONNREFUSED|socket hang up|fetch failed/i.test(message)) return offerError("network", true, stage);
  if (/Python.*curl_cffi|ModuleNotFoundError|未找到可用的 Python/i.test(message)) return offerError("runtime_unavailable", false, stage);
  return offerError("login_failed", false, stage);
}
export function offerFailureMessage(code, stage) {
  if (stage === "offer_response" && code === "identity_mismatch") return "优惠响应未返回目标账号，已停止检测";
  if (stage === "account_alias_conflict") return "同一账号的优惠响应存在冲突，尚未获得结论";
  return OFFER_ERRORS[code] || "";
}
export function offerIdentity(source, email) {
  try { return source?.type === "sub2api-data" ? authorizationIdentity(source, email) : sessionIdentity(source, email); }
  catch (error) { throw offerError(Object.hasOwn(OFFER_ERRORS, error.message) ? error.message : "authorization_invalid"); }
}
function classifyAccount(info) {
  const account = info?.account;
  if (!account || typeof account !== "object" || Array.isArray(account)) throw offerError("invalid_response");
  const planType = typeof account.plan_type === "string" ? account.plan_type.toLowerCase() : "";
  const campaign = info.eligible_promo_campaigns?.plus;
  const campaignId = typeof campaign?.id === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(campaign.id) ? campaign.id : "";
  let kind;
  if (account.is_deactivated === true) kind = "banned";
  else if (["plus", "pro", "go", "team", "business", "enterprise"].includes(planType) || info.entitlement?.has_active_subscription === true) kind = "subscribed";
  else if (campaignId) kind = OFFER_CAMPAIGNS[campaignId] || "other";
  else if (campaign && Object.keys(campaign).length) kind = "other";
  else if (["free", "basic", "xbasic"].includes(planType) && Object.hasOwn(info, "eligible_promo_campaigns")
    && info.eligible_promo_campaigns !== null && typeof info.eligible_promo_campaigns === "object" && !Array.isArray(info.eligible_promo_campaigns)) kind = "none";
  else throw offerError("invalid_response");
  return { kind, label: OFFER_LABELS[kind], campaignId, planType };
}
export function classifyOffer(data, identity) {
  try {
    if (!data || typeof data !== "object" || !data.accounts || typeof data.accounts !== "object" || Array.isArray(data.accounts)) throw offerError("invalid_response");
    const expected = identity.accountId.trim().toLowerCase(); const entries = [];
    for (const [key, info] of Object.entries(data.accounts)) {
      const keyed = key.trim().toLowerCase() === expected;
      const explicit = info?.account?.account_id;
      if (explicit != null && typeof explicit !== "string") { if (keyed) throw offerError("invalid_response"); continue; }
      const accountId = typeof explicit === "string" ? explicit.trim().toLowerCase() : "";
      if (keyed && accountId && accountId !== expected) throw offerError("identity_mismatch");
      if (accountId === expected || keyed && !accountId) entries.push(info);
    }
    if (!entries.length) throw offerError("identity_mismatch");
    // The response may expose the same account under "default" and its ID.
    // Compare their conclusions instead of treating two aliases as two users.
    const conclusions = entries.map(classifyAccount);
    if (conclusions.some((value) => JSON.stringify(value) !== JSON.stringify(conclusions[0]))) throw offerError("invalid_response", false, "account_alias_conflict");
    return { ...conclusions[0], checkedAt: new Date().toISOString() };
  } catch (error) { if (!error.offerStage) error.offerStage = "offer_response"; throw error; }
}
export async function checkOffer(source, email, request) {
  let identity;
  try { identity = offerIdentity(source, email); } catch (error) { error.offerStage = "session_identity"; throw error; }
  let response;
  try { response = await request("/backend-api/accounts/check/v4-2023-04-27", identity); }
  catch (error) { if (error.offerCode) { error.offerStage ||= "offer_request"; throw error; } throw offerError("network", true, "offer_request"); }
  let data; try { data = typeof response.body === "string" ? JSON.parse(response.body) : response.body; } catch {}
  if ([401, 403].includes(response.status) && ["account_deactivated", "account_deleted"].includes(data?.error?.code || data?.code)) {
    return { kind: "banned", label: OFFER_LABELS.banned, campaignId: "", planType: "", checkedAt: new Date().toISOString() };
  }
  if (response.status !== 200) throw offerError(response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : response.status === 429 ? "rate_limited" : "network", response.status === 429 || response.status >= 500, "offer_request");
  return classifyOffer(data, identity);
}
