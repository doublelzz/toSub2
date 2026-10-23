import crypto from "node:crypto";
import net from "node:net";

export function normalizeClientIp(value) {
  let address = String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (address.startsWith("::ffff:")) {
    const mapped = address.slice(7);
    if (net.isIP(mapped) === 4) return mapped;
    const match = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    if (match) {
      const high = parseInt(match[1], 16); const low = parseInt(match[2], 16);
      return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
  }
  if (net.isIP(address) === 4) return address.split(".").map(Number).join(".");
  if (net.isIP(address) === 6) return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  return null;
}

export function clientIp(req, trustedProxies = []) {
  const direct = normalizeClientIp(req.socket?.remoteAddress);
  if (!direct) throw cdkError(400, "无法识别客户端 IP");
  const trusted = new Set(trustedProxies.map(normalizeClientIp).filter(Boolean));
  if (!trusted.has(direct)) return direct;
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",").map(normalizeClientIp);
  if (!forwarded.length || forwarded.some((address) => !address)) return direct;
  const chain = [...forwarded, direct];
  while (chain.length > 1 && trusted.has(chain[chain.length - 1])) chain.pop();
  return chain[chain.length - 1];
}

export function secretHash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
export function randomSecret(prefix = "TS2") { return `${prefix}-${crypto.randomBytes(24).toString("base64url")}`; }
export function cdkError(status, message, code = "") { return Object.assign(new Error(message), { status, code }); }

export function protocolEnvironment() {
  const environment = { ...process.env };
  delete environment.TOSUB2_ADMIN_CDK; delete environment.TOSUB2_ENCRYPTION_KEY;
  return environment;
}

export function requireSameOrigin(req, trustedOrigins = []) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const origin = req.headers.origin;
  if (!origin) {
    if (req.headers["sec-fetch-site"] === "cross-site") throw cdkError(403, "请求来源不被允许");
    return;
  }
  let parsed;
  try { parsed = new URL(origin); } catch { throw cdkError(403, "请求来源不被允许"); }
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === req.headers.host) return;
  if (trustedOrigins.includes(parsed.origin)) return;
  throw cdkError(403, "请求来源不被允许");
}

export async function readRequestJson(req, limit = 1_000_000) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw cdkError(413, "请求内容过大");
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw cdkError(400, "JSON 格式错误"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw cdkError(400, "请求内容必须为 JSON 对象");
  return body;
}

export function positiveInteger(value, label, maximum = 1_000_000) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) throw cdkError(422, `${label}必须为 1 至 ${maximum} 的整数`);
  return number;
}
