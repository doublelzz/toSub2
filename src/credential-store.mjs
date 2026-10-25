import crypto from "node:crypto";
import fs from "./workspace-storage.mjs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const KEYCHAIN_SERVICE = "com.local.chatgpt-onboarding.credentials";
const MAC_CREDENTIAL_ROOT = path.join(os.homedir(), "Library", "Application Support", "toSub2", "credentials");
const WINDOWS_ENTROPY = "toSub2.credentials.v1";

const WINDOWS_PROTECT_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$plainText = [Console]::In.ReadToEnd()
$plainBytes = [Text.Encoding]::UTF8.GetBytes($plainText)
$entropy = [Text.Encoding]::UTF8.GetBytes("${WINDOWS_ENTROPY}")
$cipherBytes = [Security.Cryptography.ProtectedData]::Protect(
  $plainBytes,
  $entropy,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Convert]::ToBase64String($cipherBytes))
`;

const WINDOWS_UNPROTECT_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$cipherText = [Console]::In.ReadToEnd().Trim()
$cipherBytes = [Convert]::FromBase64String($cipherText)
$entropy = [Text.Encoding]::UTF8.GetBytes("${WINDOWS_ENTROPY}")
$plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
  $cipherBytes,
  $entropy,
  [Security.Cryptography.DataProtectionScope]::CurrentUser
)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plainBytes))
`;

const WINDOWS_UNPROTECT_BATCH_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$items = ConvertFrom-Json ([Console]::In.ReadToEnd())
$entropy = [Text.Encoding]::UTF8.GetBytes("${WINDOWS_ENTROPY}")
$results = @(
  foreach ($item in $items) {
    try {
      $bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($item.cipher), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
      @{ id = $item.id; payload = [Text.Encoding]::UTF8.GetString($bytes) }
    } catch { @{ id = $item.id; failed = $true } }
  }
)
[Console]::Out.Write((ConvertTo-Json -InputObject $results -Depth 4 -Compress))
`;

export function createCredentialStore(options = {}) {
  const platform = options.platform || process.platform;
  const windowsRoot = path.resolve(options.windowsRoot || defaultWindowsCredentialRoot());
  const macRoot = path.resolve(options.macRoot || process.env.TOSUB2_MAC_CREDENTIAL_ROOT || MAC_CREDENTIAL_ROOT);
  const securityRunner = options.securityRunner || runSecurity;
  const powerShellRunner = options.powerShellRunner || runPowerShell;
  const vaultPath = (identity) => path.join(platform === "darwin" ? macRoot : windowsRoot, `${crypto.createHash("sha256").update(credentialAccount(identity)).digest("hex")}.vault`);

  return {
    async save(email, credentials) {
      const payload = JSON.stringify({
        version: 2,
        password: typeof credentials.password === "string" ? credentials.password : "",
        totpSecret: typeof credentials.totpSecret === "string" ? credentials.totpSecret : "",
        proxyUrl: typeof credentials.proxyUrl === "string" ? credentials.proxyUrl : "",
      });
      if (options.vault) {
        await fs.mkdir(path.dirname(vaultPath(email)), { recursive: true });
        await fs.writeFile(vaultPath(email), options.vault.seal(JSON.parse(payload), path.basename(vaultPath(email))), { mode: 0o600 });
        return;
      }
      if (platform === "darwin") {
        await saveMacCredential(macRoot, email, payload, securityRunner);
        return;
      }
      if (platform === "win32") {
        let result;
        try {
          result = await powerShellRunner(WINDOWS_PROTECT_SCRIPT, payload);
        } catch {
          result = { code: 1, stdout: "" };
        }
        if (result.code !== 0 || !isBase64(result.stdout)) {
          throw credentialError(500, "无法使用 Windows DPAPI（数据保护接口）保存登录凭据和代理配置，请确认 PowerShell 可正常运行");
        }
        await fs.mkdir(windowsRoot, { recursive: true });
        const filePath = windowsCredentialPath(windowsRoot, email);
        await fs.writeFile(filePath, `${result.stdout.trim()}\n`, { mode: 0o600 });
        return;
      }
      throw credentialError(501, "持久保存登录凭据和代理配置目前支持 macOS Keychain（钥匙串）和 Windows DPAPI（数据保护接口）");
    },

    async load(email) {
      if (options.vault) {
        try { return parseCredentialPayload(JSON.stringify(options.vault.open(await fs.readFile(vaultPath(email), "utf8"), path.basename(vaultPath(email))))); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (platform === "darwin") {
        const credentials = await loadMacCredential(macRoot, email, securityRunner);
        if (options.vault && Object.values(credentials).some(Boolean)) await this.save(email, credentials);
        return credentials;
      }
      if (platform === "win32") {
        let cipherText;
        try {
          cipherText = await fs.readFile(windowsCredentialPath(windowsRoot, email), "utf8");
        } catch (error) {
          if (error?.code === "ENOENT") return emptyCredentials();
          return emptyCredentials();
        }
        try {
          const result = await powerShellRunner(WINDOWS_UNPROTECT_SCRIPT, cipherText);
          const credentials = result.code === 0 ? parseCredentialPayload(result.stdout) : emptyCredentials();
          if (options.vault && result.code === 0) await this.save(email, credentials);
          return credentials;
        } catch {
          return emptyCredentials();
        }
      }
      return emptyCredentials();
    },

    async delete(email) {
      if (options.vault) await fs.rm(vaultPath(email), { force: true });
      if (platform === "darwin") {
        const result = await securityRunner([
          "delete-generic-password",
          "-a",
          credentialAccount(email),
          "-s",
          KEYCHAIN_SERVICE,
        ]);
        if (![0, 44].includes(result.code)) {
          throw credentialError(500, "无法从 macOS Keychain（钥匙串）删除该邮箱的登录凭据");
        }
        await fs.rm(macCredentialPath(macRoot, email), { force: true });
        return;
      }
      if (platform === "win32") {
        try {
          await fs.unlink(windowsCredentialPath(windowsRoot, email));
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw credentialError(500, "无法删除 Windows DPAPI（数据保护接口）凭据文件");
          }
        }
      }
    },

    async migrate(legacyAliases = []) {
      if (!options.vault || platform !== "win32") return [];
      const copied = new Map();
      for (const { identity, email } of legacyAliases) {
        const id = crypto.createHash("sha256").update(credentialAccount(identity)).digest("hex");
        try { await fs.access(path.join(windowsRoot, `${id}.vault`)); continue; } catch (error) { if (error.code !== "ENOENT") throw error; }
        try { await fs.access(path.join(windowsRoot, `${id}.dpapi`)); continue; } catch (error) { if (error.code !== "ENOENT") throw error; }
        let ciphertext;
        try { ciphertext = await fs.readFile(windowsCredentialPath(defaultWindowsCredentialRoot(), email), "utf8"); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        await fs.mkdir(windowsRoot, { recursive: true });
        await fs.writeFile(path.join(windowsRoot, `${id}.dpapi`), ciphertext, { mode: 0o600 });
        copied.set(id, email);
      }
      const files = await fs.readdir(windowsRoot).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
      const items = [];
      for (const filename of files.filter((value) => /^[a-f0-9]{64}\.dpapi$/.test(value))) {
        const id = filename.slice(0, -6);
        try { await fs.access(path.join(windowsRoot, `${id}.vault`)); continue; } catch (error) { if (error.code !== "ENOENT") throw error; }
        items.push({ id, cipher: (await fs.readFile(path.join(windowsRoot, filename), "utf8")).trim() });
      }
      if (!items.length) return [];
      // One DPAPI process converts the old per-account files. Later launches
      // decrypt only SQLite vault records in this Node process.
      const result = await powerShellRunner(WINDOWS_UNPROTECT_BATCH_SCRIPT, JSON.stringify(items), { maxOutputChars: 16 * 1024 * 1024 });
      if (result.code !== 0) throw credentialError(500, "旧版凭据迁移失败，原始加密数据已保留");
      let values;
      try { values = JSON.parse(result.stdout); } catch { throw credentialError(500, "旧版凭据迁移响应不完整，原始加密数据已保留"); }
      if (!Array.isArray(values) || values.length !== items.length) throw credentialError(500, "旧版凭据迁移响应不完整，原始加密数据已保留");
      const allowed = new Set(items.map((value) => value.id));
      const migratedLegacy = [];
      for (const value of values) {
        if (!allowed.delete(value.id)) throw credentialError(500, "旧版凭据迁移响应无效");
        if (value.failed) continue;
        if (typeof value.payload !== "string") throw credentialError(500, "旧版凭据迁移响应无效");
        const filename = `${value.id}.vault`;
        await fs.writeFile(path.join(windowsRoot, filename), options.vault.seal(parseCredentialPayload(value.payload), filename), { mode: 0o600 });
        await fs.unlink(path.join(windowsRoot, `${value.id}.dpapi`));
        if (copied.has(value.id)) migratedLegacy.push(copied.get(value.id));
      }
      return migratedLegacy;
    },
  };
}

function defaultWindowsCredentialRoot() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(localAppData, "toSub2", "credentials");
}

function windowsCredentialPath(root, email) {
  const id = crypto.createHash("sha256").update(credentialAccount(email)).digest("hex");
  return path.join(root, `${id}.dpapi`);
}

function macCredentialPath(root, email) {
  const id = crypto.createHash("sha256").update(credentialAccount(email)).digest("hex");
  return path.join(root, `${id}.enc`);
}

async function saveMacCredential(root, email, payload, securityRunner) {
  const filePath = macCredentialPath(root, email);
  const existingFile = await fileExists(filePath);
  const keychainValue = await readMacKeychainValue(email, securityRunner);
  let key = keychainValue.key;
  if (!key) {
    if (existingFile) {
      throw credentialError(500, "macOS Keychain（钥匙串）中的加密密钥无法读取，已保留现有凭据文件");
    }
    key = crypto.randomBytes(32);
    const keyResult = await securityRunner([
      "add-generic-password",
      "-a",
      credentialAccount(email),
      "-s",
      KEYCHAIN_SERVICE,
      "-U",
      "-w",
    ], `${key.toString("base64")}\n${key.toString("base64")}\n`);
    if (keyResult.code !== 0) {
      throw credentialError(500, "无法将登录凭据密钥保存到 macOS Keychain（钥匙串），请先解锁登录钥匙串");
    }
  }
  const encrypted = encryptCredentialPayload(key, payload);
  await fs.mkdir(root, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(encrypted)}\n`, { mode: 0o600 });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw credentialError(500, `无法写入 macOS 凭据文件：${error.message}`);
  }
}

async function loadMacCredential(root, email, securityRunner) {
  let encrypted;
  try {
    encrypted = JSON.parse(await fs.readFile(macCredentialPath(root, email), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") return emptyCredentials();
    const legacy = await readMacKeychainValue(email, securityRunner);
    return legacy.payload ? parseCredentialPayload(legacy.payload) : emptyCredentials();
  }
  const keychainValue = await readMacKeychainValue(email, securityRunner);
  if (!keychainValue.key) return emptyCredentials();
  try {
    return parseCredentialPayload(decryptCredentialPayload(keychainValue.key, encrypted));
  } catch {
    return emptyCredentials();
  }
}

async function readMacKeychainValue(email, securityRunner) {
  const result = await securityRunner([
    "find-generic-password",
    "-a",
    credentialAccount(email),
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (result.code !== 0) return { key: null, payload: null };
  const value = String(result.stdout || "").trim();
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(value)) {
    try {
      const key = Buffer.from(value, "base64");
      if (key.length === 32) return { key, payload: null };
    } catch {}
  }
  return { key: null, payload: value };
}

function encryptCredentialPayload(key, payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64"),
  };
}

function decryptCredentialPayload(key, encrypted) {
  if (encrypted?.version !== 1) throw new Error("Unsupported encrypted credential version");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function credentialAccount(email) {
  return String(email || "").trim().toLowerCase();
}

function parseCredentialPayload(value) {
  const raw = String(value || "").trim();
  try {
    const data = JSON.parse(raw);
    return {
      password: typeof data.password === "string" ? data.password : "",
      totpSecret: typeof data.totpSecret === "string" ? data.totpSecret : "",
      proxyUrl: typeof data.proxyUrl === "string" ? data.proxyUrl : "",
    };
  } catch {
    // Older macOS writes used the interactive `security -w` prompt, which
    // truncated long payloads at 128 bytes. Recover fields that were fully
    // written before the truncated tail so users do not lose passwords or
    // TOTP keys after upgrading.
    return {
      password: extractCompleteJsonString(raw, "password"),
      totpSecret: extractCompleteJsonString(raw, "totpSecret"),
      proxyUrl: extractCompleteJsonString(raw, "proxyUrl"),
    };
  }
}

function extractCompleteJsonString(raw, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"${escapedKey}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(raw);
  if (!match) return "";
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function emptyCredentials() {
  return { password: "", totpSecret: "", proxyUrl: "" };
}

function isBase64(value) {
  const normalized = String(value || "").trim();
  return normalized.length > 0 && normalized.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(normalized);
}

function credentialError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function runSecurity(args, input = "") {
  return runCredentialHelper("/usr/bin/security", args, input, { detached: true });
}

let activeHelpers = 0;
const helperWaiters = [];

function runPowerShell(script, input = "", options = {}) {
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
  return runCredentialHelper(
    process.env.TOSUB2_POWERSHELL || "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
    input,
    { windowsHide: true, ...options },
  );
}

async function runCredentialHelper(command, args, input, options) {
  if (activeHelpers >= 4) await new Promise((resolve) => helperWaiters.push(resolve));
  else activeHelpers += 1;
  try { return await runChild(command, args, input, options); }
  finally { const next = helperWaiters.shift(); if (next) next(); else activeHelpers -= 1; }
}

function runChild(command, args, input, options = {}) {
  const { maxOutputChars = 65_536, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...spawnOptions,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-maxOutputChars);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.end(input);
  });
}
