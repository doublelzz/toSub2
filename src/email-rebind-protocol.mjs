import { reusableMfaSession } from "./mfa-session.mjs";

export const REBIND_ERRORS = {
  SESSION_EXPIRED: "登录信息已失效，请先恢复该账号登录后重试",
  SESSION_INVALID: "登录身份不一致或会话不可读取，请核对账号",
  INELIGIBLE: "当前账号不允许更换邮箱，请核对账号资格",
  TARGET_IN_USE: "新邮箱已被使用，请核对目标邮箱",
  CODE_INVALID: "验证码不正确或已过期，请重新输入或重新发送",
  SENSITIVE_ACTION_COOLDOWN: "为保护账户安全，本次电子邮箱更改将暂缓 24 小时",
  REQUEST_FAILED: "服务拒绝请求，请稍后重试",
  NETWORK: "网络请求未完成，请稍后重试",
  UNCERTAIN: "尚不能确认换绑结果，请核对新邮箱登录状态，不要重新换绑",
  RESPONSE_INVALID: "服务响应异常，请核对结果后重试",
};
export const rebindError = (code, diagnostic, message) => Object.assign(new Error(message || REBIND_ERRORS[code] || REBIND_ERRORS.REQUEST_FAILED), { rebindCode: code, status: 409, ...(diagnostic ? { diagnostic } : {}) });

export async function emailRebindStep({ operation, email, newEmail, session: source, code }, request) {
  let session;
  try { session = reusableMfaSession(source, email); }
  catch (error) { throw rebindError(/EXPIRED|MISSING/.test(error.mfaCode) ? "SESSION_EXPIRED" : "SESSION_INVALID"); }
  if (!["eligibility", "begin", "verify", "inspect"].includes(operation)) throw rebindError("REQUEST_FAILED");
  const path = operation === "inspect" ? "/backend-api/me" : `/backend-api/accounts/change_email/${operation}`;
  if (operation !== "eligibility" && operation !== "inspect" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail || "")) throw rebindError("TARGET_IN_USE");
  if (operation === "verify" && !/^\d{6}$/.test(code || "")) throw rebindError("CODE_INVALID");
  let diagnostic = { operation, path };
  const fail = (code, message) => rebindError(code, diagnostic, message);
  const send = async (payload) => {
    let result;
    try { result = await request(path, { session, method: ["eligibility", "inspect"].includes(operation) ? "GET" : "POST", payload }); }
    catch (error) { throw Object.assign(fail(operation === "verify" ? "UNCERTAIN" : "NETWORK"), { cause: error }); }
    diagnostic = { ...diagnostic, httpStatus: result.status };
    return result;
  };
  let response = await send(operation === "begin" ? { email: newEmail } : operation === "verify" ? { email: newEmail, code } : null);
  if (operation === "verify" && response.status === 422) response = await send({ code });
  if (response.status === 401) throw fail("SESSION_EXPIRED");
  let data;
  try { data = typeof response.body === "string" ? JSON.parse(response.body) : response.body; } catch {}
  const upstreamCode = String(data?.error?.code || data?.code || data?.error?.type || "");
  if (upstreamCode) diagnostic.upstreamCode = upstreamCode;
  const upstreamMessage = String(data?.error?.message || data?.message || "");
  if (upstreamMessage) diagnostic.upstreamMessage = upstreamMessage;
  const cooldownParam = Number(data?.error?.param || data?.param);
  if (upstreamCode === "sensitive_action_cooldown") {
    diagnostic.retryAfter = Number.isFinite(cooldownParam) && cooldownParam > 0 ? cooldownParam : null;
    throw fail("SENSITIVE_ACTION_COOLDOWN", upstreamMessage || REBIND_ERRORS.SENSITIVE_ACTION_COOLDOWN);
  }
  if (response.status !== 200) {
    if (operation === "verify" && response.status >= 500) throw fail("UNCERTAIN");
    if (/email.*(?:taken|exists|linked|use)|already.*(?:email|linked)/i.test(upstreamCode)) throw fail("TARGET_IN_USE");
    if (operation === "verify" && [400, 422].includes(response.status)) throw fail("CODE_INVALID");
    throw fail("REQUEST_FAILED");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw fail(operation === "verify" ? "UNCERTAIN" : "RESPONSE_INVALID");
  if (operation === "eligibility") {
    if (data.eligible !== true) throw fail("INELIGIBLE");
    return { eligible: true };
  }
  if (operation === "inspect") {
    const actualEmail = String(data.email || data.user?.email || "").trim().toLowerCase();
    if (actualEmail !== email) throw fail("SESSION_INVALID");
    return { email: actualEmail, accountId: session.accountId };
  }
  if (data.success !== true) throw fail(operation === "verify"
    ? /(?:invalid|expired).*code|code.*(?:invalid|expired)/i.test(upstreamCode) ? "CODE_INVALID" : "UNCERTAIN"
    : "REQUEST_FAILED");
  return { success: true, ...(operation === "begin" && typeof data.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) ? { recipient: data.email.toLowerCase() } : {}) };
}
