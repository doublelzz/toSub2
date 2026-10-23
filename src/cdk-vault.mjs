import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createCredentialStore } from "./credential-store.mjs";

export async function createCdkVault(root) {
  const directory = path.join(root, ".cdk");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const marker = path.join(directory, "vault.json");
  const configured = process.env.TOSUB2_ENCRYPTION_KEY;
  let key;
  if (configured) {
    key = Buffer.from(configured, "base64");
    if (key.length !== 32) throw new Error("TOSUB2_ENCRYPTION_KEY 必须为 32 字节密钥的 Base64 编码");
  } else if (["win32", "darwin"].includes(process.platform)) {
    const store = createCredentialStore({ windowsRoot: path.join(directory, "keys"), macRoot: path.join(directory, "keys") });
    const identity = `tosub2-cdk-vault:${crypto.createHash("sha256").update(path.resolve(root)).digest("hex")}`;
    const stored = await store.load(identity);
    if (stored.password) key = Buffer.from(stored.password, "base64");
    else {
      try { await fs.access(marker); throw new Error("应用加密密钥不可读取，请恢复原系统凭据或提供原加密密钥"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      key = crypto.randomBytes(32);
      await store.save(identity, { password: key.toString("base64") });
    }
  } else {
    throw new Error("此系统需要配置 TOSUB2_ENCRYPTION_KEY 后启用 CDK。请提供 32 字节随机密钥的 Base64 编码并持久保存");
  }
  if (key.length !== 32) throw new Error("应用加密密钥无效");
  const identity = crypto.createHmac("sha256", key).update("tosub2-vault-v1").digest("hex");
  try {
    const previous = JSON.parse(await fs.readFile(marker, "utf8"));
    if (previous.identity !== identity) throw new Error("应用加密密钥与现有数据不一致");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.writeFile(marker, JSON.stringify({ version: 1, identity }), { mode: 0o600, flag: "wx" });
  }
  return {
    seal(value, scope) {
      const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(scope));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
      return JSON.stringify({ version: 1, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") });
    },
    open(value, scope) {
      const stored = JSON.parse(value); if (stored.version !== 1) throw new Error("无法读取加密数据版本");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(stored.nonce, "base64"));
      decipher.setAAD(Buffer.from(scope)); decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.data, "base64")), decipher.final()]).toString("utf8"));
    },
    fingerprint(value) { return crypto.createHmac("sha256", key).update("audit:").update(String(value)).digest("hex").slice(0, 20); },
  };
}
