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
  unauthorized: "登录信息已失效，请恢复登录后重试", identity_mismatch: "登录身份与账号不一致，请核对资料",
  identity_missing: "登录信息缺少账号身份", authorization_invalid: "没有可用登录信息，请补充账号资料",
  token_expired: "登录信息已过期", forbidden: "服务拒绝访问，尚未获得优惠结论",
  rate_limited: "请求过于频繁，请稍后重试", network: "网络请求未完成", invalid_response: "优惠响应异常，尚未获得结论",
  login_failed: "登录未完成，请核对资料或重新输入验证码", cancelled: "检测已停止", timeout: "等待超时，请重试",
};
export const offerError = (code, retryable = false) => Object.assign(new Error(OFFER_ERRORS[code] || OFFER_ERRORS.login_failed), { offerCode: code, retryable });
export function offerIdentity(source, email) {
  try { return source?.type === "sub2api-data" ? authorizationIdentity(source, email) : sessionIdentity(source, email); }
  catch (error) { throw offerError(Object.hasOwn(OFFER_ERRORS, error.message) ? error.message : "authorization_invalid"); }
}
export function classifyOffer(data, identity) {
  if (!data || typeof data !== "object" || !data.accounts || typeof data.accounts !== "object" || Array.isArray(data.accounts)) throw offerError("invalid_response");
  const entries = Object.entries(data.accounts).filter(([key, value]) => String(value?.account?.account_id || key).toLowerCase() === identity.accountId.toLowerCase());
  if (entries.length !== 1) throw offerError("identity_mismatch");
  const info = entries[0][1]; const account = info?.account;
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
  return { kind, label: OFFER_LABELS[kind], campaignId, planType, checkedAt: new Date().toISOString() };
}
export async function checkOffer(source, email, request) {
  const identity = offerIdentity(source, email);
  let response;
  try { response = await request("/backend-api/accounts/check/v4-2023-04-27", identity); }
  catch (error) { if (error.offerCode) throw error; throw offerError("network", true); }
  let data; try { data = typeof response.body === "string" ? JSON.parse(response.body) : response.body; } catch {}
  if ([401, 403].includes(response.status) && ["account_deactivated", "account_deleted"].includes(data?.error?.code || data?.code)) {
    return { kind: "banned", label: OFFER_LABELS.banned, campaignId: "", planType: "", checkedAt: new Date().toISOString() };
  }
  if (response.status !== 200) throw offerError(response.status === 401 ? "unauthorized" : response.status === 403 ? "forbidden" : response.status === 429 ? "rate_limited" : "network", response.status === 429 || response.status >= 500);
  return classifyOffer(data, identity);
}
