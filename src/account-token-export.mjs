import fs from "./workspace-storage.mjs";
import path from "node:path";

const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const email = (value) => typeof value === "string" ? value.trim().toLowerCase() : "";
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const messages = {
  missing: "未保存访问令牌",
  session_invalid: "登录会话文件损坏或格式不正确",
  oauth_invalid: "OAuth 授权文件损坏或格式不正确",
  invalidated: "登录会话已登出或失效，请重新登录后再导出",
  token_invalid: "访问令牌格式不正确",
  identity_missing: "令牌资料缺少可核对的账号身份",
  identity_mismatch: "令牌身份与当前账号不一致",
  unreadable: "无法读取已保存的访问令牌",
};
const failure = (code) => Object.assign(new Error(messages[code]), { tokenExportCode: code });

function decodeAccessToken(token) {
  if (typeof token !== "string" || !token || token.length > 131_072 || /[\s\x00-\x1f\x7f-\x9f]/u.test(token)) throw failure("token_invalid");
  const parts = token.split(".");
  if (parts.length !== 3) return {};
  if (!parts.every(Boolean) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) throw failure("token_invalid");
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { throw failure("token_invalid"); }
  if (!object(claims)) throw failure("token_invalid");
  return claims;
}

function timestamp(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const result = new Date(value * 1000);
  return Number.isFinite(result.getTime()) ? result.toISOString() : null;
}

function storedExpiry(value, numeric) {
  if (numeric && (typeof value === "number" || typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value))) return timestamp(Number(value));
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// This export intentionally permits expired ATs. It never refreshes or validates
// them against a network service, and never substitutes a subscription deadline.
export function accountAccessToken(data, source, expectedEmail, now = Date.now()) {
  const targetEmail = email(expectedEmail);
  if (!validEmail(targetEmail)) throw failure("identity_missing");
  let token; let storedEmail; let storedAccountId; let storedDeadline;
  if (source === "session") {
    if (!object(data) || data.type !== "chatgpt-session" || data.version !== 1) throw failure("session_invalid");
    if (data.invalidatedAt) throw failure("invalidated");
    token = data.accessToken; storedEmail = data.email; storedAccountId = data.accountId;
  } else if (source === "oauth") {
    if (!object(data) || data.type !== "sub2api-data" || data.version !== 1 || !Array.isArray(data.accounts) || data.accounts.length !== 1) throw failure("oauth_invalid");
    const account = data.accounts[0];
    if (!object(account) || account.platform !== "openai" || account.type !== "oauth" || !object(account.credentials)) throw failure("oauth_invalid");
    const credentials = account.credentials;
    token = credentials.access_token; storedEmail = credentials.email;
    storedAccountId = credentials.chatgpt_account_id; storedDeadline = credentials.expires_at;
  } else throw failure("token_invalid");
  if (!validEmail(email(storedEmail))) throw failure("identity_missing");
  if (email(storedEmail) !== targetEmail) throw failure("identity_mismatch");
  if (storedAccountId != null && (typeof storedAccountId !== "string" || /[\x00-\x1f\x7f-\x9f]/.test(storedAccountId))) throw failure("identity_mismatch");
  if (token == null || token === "") throw failure("missing");
  const claims = decodeAccessToken(token);
  if (claims[PROFILE_CLAIM] != null && !object(claims[PROFILE_CLAIM]) || claims[AUTH_CLAIM] != null && !object(claims[AUTH_CLAIM])) throw failure("token_invalid");
  const emails = [storedEmail, claims.email, claims[PROFILE_CLAIM]?.email].filter((value) => value != null);
  if (emails.some((value) => typeof value !== "string" || !validEmail(email(value)) || email(value) !== targetEmail)) throw failure("identity_mismatch");
  const claimAccountId = claims[AUTH_CLAIM]?.chatgpt_account_id;
  const ids = [storedAccountId, claimAccountId].filter((value) => value != null && value !== "");
  if (ids.some((value) => typeof value !== "string" || !value.trim() || /[\x00-\x1f\x7f-\x9f]/.test(value))) throw failure("identity_mismatch");
  if (!ids.length) throw failure("identity_missing");
  if (ids.some((value) => value.trim().toLowerCase() !== ids[0].trim().toLowerCase())) throw failure("identity_mismatch");
  // ChatGPT's session.expiresAt is a session lifetime, not the AT lifetime.
  const expiresAt = Object.hasOwn(claims, "exp") ? timestamp(claims.exp) : source === "oauth" ? storedExpiry(storedDeadline, true) : null;
  return { email: targetEmail, accessToken: token, source, expiresAt, expired: expiresAt === null ? null : Date.parse(expiresAt) <= now };
}

export async function loadAccountAccessToken(job, { readFile = fs.readFile, now = Date.now() } = {}) {
  async function load(source, target) {
    let raw;
    try { raw = await readFile(target, "utf8"); }
    catch (error) { throw failure(error?.code === "ENOENT" ? "missing" : "unreadable"); }
    let data;
    try { data = JSON.parse(raw); } catch { throw failure(source === "session" ? "session_invalid" : "oauth_invalid"); }
    return accountAccessToken(data, source, job.email, now);
  }
  try { return await load("session", path.join(path.dirname(job.outputPath), "account-session.json")); }
  catch (error) {
    // detectLoginSession may save an empty, identity-matched placeholder when
    // ChatGPT session retrieval failed while the later OAuth flow succeeded.
    if (error?.tokenExportCode !== "missing") throw error;
    return load("oauth", job.outputPath);
  }
}

export async function exportAccountAccessTokens(jobs, options = {}) {
  const entries = []; const skipped = [];
  for (const job of jobs) {
    try { entries.push(await loadAccountAccessToken(job, options)); }
    catch (error) { skipped.push({ email: job.email, reason: messages[error?.tokenExportCode] || messages.unreadable }); }
  }
  return { requested: jobs.length, exported: entries.length, entries, skipped };
}
