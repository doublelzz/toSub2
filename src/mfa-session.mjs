import crypto from "node:crypto";
import fs from "./workspace-storage.mjs";
import path from "node:path";

const text = (value) => typeof value === "string" ? value.trim() : "";
const email = (value) => text(value).toLowerCase();
const failure = (code, message) => Object.assign(new Error(`${code}: ${message}`), { mfaCode: code });

export function reusableMfaSession(source, expectedEmail, now = Date.now()) {
  if (source?.type !== "chatgpt-session" || source.version !== 1 || !text(source.accessToken)) {
    throw failure(source?.invalidatedAt ? "MFA_SESSION_EXPIRED" : "MFA_SESSION_MISSING", "请在账号授权页重新登录后重试，本次不会自动登录");
  }
  let claims = {};
  try { claims = JSON.parse(Buffer.from(source.accessToken.split(".")[1], "base64url").toString("utf8")) || {}; } catch {}
  const emails = [source.email, claims.email, claims["https://api.openai.com/profile"]?.email].map(email).filter(Boolean);
  if (!email(expectedEmail) || !email(source.email) || emails.some((value) => value !== email(expectedEmail))) {
    throw failure("MFA_SESSION_INVALID", "已有授权与目标账号不一致");
  }
  const claimId = text(claims["https://api.openai.com/auth"]?.chatgpt_account_id);
  const storedId = text(source.accountId);
  if (claimId && storedId && claimId.toLowerCase() !== storedId.toLowerCase()) throw failure("MFA_SESSION_INVALID", "已有授权的账号 ID 不一致");
  const accountId = claimId || storedId;
  if (!accountId) throw failure("MFA_SESSION_INVALID", "已有授权缺少账号 ID");
  const expiresAt = typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp * 1000 : Date.parse(source.expiresAt);
  if (Number.isFinite(expiresAt) && !Number.isFinite(new Date(expiresAt).getTime())) throw failure("MFA_SESSION_INVALID", "已有授权的过期时间无效");
  if (source.invalidatedAt || (Number.isFinite(expiresAt) && expiresAt <= now)) throw failure("MFA_SESSION_EXPIRED", "已有授权已过期，请在账号授权页重新登录后重试");
  return {
    type: "chatgpt-session", version: 1, email: email(expectedEmail), accessToken: source.accessToken, accountId,
    deviceId: text(source.deviceId), ...(Number.isFinite(expiresAt) ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
    ...(text(source.chatgptBase) ? { chatgptBase: source.chatgptBase } : {}),
  };
}

export async function readMfaSession(filePath, expectedEmail) {
  if (!filePath) throw failure("MFA_SESSION_MISSING", "没有可复用的账号授权，请先在账号授权页登录");
  let source;
  try { source = JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) { throw failure(error?.code === "ENOENT" ? "MFA_SESSION_MISSING" : "MFA_SESSION_INVALID", "无法读取已有账号授权，请在账号授权页重新登录后重试"); }
  return reusableMfaSession(source, expectedEmail);
}

export async function writeMfaSession(filePath, source, expectedEmail) {
  const session = reusableMfaSession(source, expectedEmail);
  await writeSessionFile(filePath, session);
  return session;
}

export async function invalidateMfaSession(filePath, expectedEmail) {
  if (!filePath) return;
  let source;
  try { source = JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  if (email(source.email) !== email(expectedEmail)) throw failure("MFA_SESSION_INVALID", "已有授权与目标账号不一致");
  await writeSessionFile(filePath, { type: "chatgpt-session", version: 1, email: email(expectedEmail), accessToken: "", invalidatedAt: new Date().toISOString() });
}

async function writeSessionFile(filePath, source) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(source, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}
