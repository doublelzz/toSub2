export const CODEX_EMAIL_VERIFICATION_REQUIRED = "CODEX_EMAIL_VERIFICATION_REQUIRED";
export const LOGIN_READY_PROMPT = "登录成功，可以管理账号";
export const SUB2API_EMAIL_VERIFICATION_MESSAGE = "Sub2API 授权尚未完成：需要邮箱验证码验证后才能生成 JSON。已保存的网页登录仍可用于修改 2FA、邮箱换绑等操作。";

export function isCodexEmailVerificationRequired(message) {
  return /^SESSION_SELECTION_INVALID: session\/select returned page=email_otp_(?:send|verification), continue_path=\/api\/accounts\/email-otp\/send;/.test(String(message || ""));
}

export function sub2ApiAuthorizationError(value) {
  return value === CODEX_EMAIL_VERIFICATION_REQUIRED || isCodexEmailVerificationRequired(value)
    ? CODEX_EMAIL_VERIFICATION_REQUIRED : null;
}

export function sub2ApiExportError(job) {
  return sub2ApiAuthorizationError(job.sub2ApiAuthorizationError) ? SUB2API_EMAIL_VERIFICATION_MESSAGE : null;
}
