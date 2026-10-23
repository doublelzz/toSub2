import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { readMfaSession, writeMfaSession, invalidateMfaSession } from "./mfa-session.mjs";
import { protocolEnvironment } from "./cdk-security.mjs";

const BUSY = new Set(["queued", "running"]);
const STATUSES = new Set(["ready", "queued", "running", "success", "failed", "interrupted"]);
const LOGOUT_STATUSES = new Set(["idle", "queued", "running", "success", "failed", "interrupted"]);
const STAGES = new Set(["ready", "queued", "rotating", "saving", "completed", "failed", "interrupted", "cancel_requested", "pending", "authenticated", "disable_requested", "disabled", "enroll_requested", "enrolled", "activating", "confirmed", "logout_queued", "logging_out", "logged_out", "logout_failed", "logout_interrupted"]);
const ERRORS = {
  credentials: "无法读取或保存登录凭据，请检查凭据存储后重试",
  checkpoint: "恢复检查点无法读取或与账号不匹配，请检查本地数据",
  protocol: "MFA 修改未完成，请检查登录资料或网络后重试恢复",
  synchronize: "新 MFA 已生效，但本地同步未完成，请重试保存结果",
  interrupted: "任务已中断，请重试以检查并恢复远端状态",
  canceled: "已取消排队",
  busy: "账号正在执行其他任务，请稍后重试",
  storage: "MFA 工作区无法保存，请检查本地存储后重试",
  MFA_PASSWORD_REQUIRED: "缺少登录密码，请补充账号资料后重试",
  MFA_PASSWORD_REJECTED: "登录密码验证失败，请核对账号密码",
  MFA_EMAIL_VERIFICATION_REQUIRED: "账号需要邮箱验证码，请先完成邮箱验证后重试",
  MFA_EXISTING_ACCOUNT_REQUIRED: "登录流程未找到现有账号，请核对邮箱",
  MFA_SECRET_REQUIRED: "账号需要当前 2FA 密钥，请补充后重试",
  MFA_CODE_REJECTED: "当前 2FA 验证失败，请核对密钥和系统时间",
  MFA_SESSION_UNAVAILABLE: "无法核对账号会话，请检查网络后重试",
  MFA_SESSION_INVALID: "账号会话失效或身份不匹配，请重新登录后重试",
  MFA_SESSION_EXPIRED: "已有账号授权已过期，请在账号授权页重新登录后重试，本次未自动登录",
  MFA_SESSION_MISSING: "没有可复用的账号授权，请先在账号授权页登录，本次未自动登录",
  MFA_NETWORK_ERROR: "网络请求未完成，请检查网络后重试恢复",
  MFA_HTTP_ERROR: "MFA 服务拒绝请求，请稍后重试检查远端状态",
  MFA_RESPONSE_INVALID: "MFA 服务响应异常，请重试检查远端状态",
  MFA_INFO_INVALID: "无法确认当前 2FA 设置，请重试检查远端状态",
  MFA_FACTOR_CONFLICT: "远端 2FA 设置发生变化，请核对账号后重试恢复",
  MFA_DISABLE_UNCONFIRMED: "旧 2FA 尚未确认关闭，请重试检查远端状态",
  MFA_ENROLL_INVALID: "新 2FA 注册资料不完整，请重试恢复",
  MFA_ENROLLMENT_EXPIRED: "新 2FA 激活会话已过期，请重试恢复",
  MFA_ACTIVATION_UNCONFIRMED: "新 2FA 尚未确认激活，请重试检查远端状态",
  MFA_CONFIRMATION_PENDING: "新 2FA 生效状态尚未确认，请重试检查远端状态",
  MFA_CHECKPOINT_INVALID: "恢复检查点无法读取或与账号不匹配，请检查本地数据",
  MFA_ROTATION_FAILED: "MFA 修改未完成，请检查登录资料或网络后重试恢复",
  MFA_LOGIN_PAGE_CHANGED: "登录服务返回了未支持的页面，请核对登录流程",
  MFA_LOGIN_SECURITY_CHECK: "登录需要额外安全校验，请先完成校验后重试",
  MFA_LOGIN_HTTP_ERROR: "登录服务请求失败，请检查网络后重试",
  MFA_LOGOUT_ACCOUNT_REQUIRED: "无法读取账号 ID，尚未执行登出，请重新登录后重试",
  MFA_LOGOUT_NETWORK_ERROR: "登出请求未完成，结果尚未确认，可重试登出",
  MFA_LOGOUT_HTTP_ERROR: "服务拒绝登出请求，请稍后重试",
  MFA_LOGOUT_RESPONSE_INVALID: "登出响应异常，结果尚未确认，可重试登出",
  MFA_LOGOUT_UNCONFIRMED: "所有设备登出尚未确认，可重试登出",
  MFA_LOGOUT_FAILED: "登出未完成，请检查登录资料或网络后重试",
};
const MAX_ACCOUNTS = 5000;
const MAX_HISTORY = 1000;
const MAX_LOG_CHARS = 80_000;
const MAX_LOG_LINE_CHARS = 16_000;
const STAGE_MESSAGES = {
  pending: "检查账号授权", authenticated: "账号身份已确认",
  disable_requested: "准备关闭旧 2FA", disabled: "旧 2FA 已关闭",
  enroll_requested: "准备申请新 2FA", enrolled: "新密钥已保存，等待激活",
  activating: "正在激活新 2FA", confirmed: "新 2FA 已确认生效",
  logout_requested: "正在请求登出所有设备", logout_confirmed: "所有设备登出已确认",
};

function sanitizeProtocolLog(value, credentials = {}) {
  let text = String(value).replace(/\x1b\[[0-9;]*m/g, "");
  for (const secret of [credentials.password, credentials.totpSecret].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("<redacted>");
  }
  return text
    .replace(/([?&](?:code|token|state|csrf|nonce|otp|code_challenge)=)[^&\s]+/gi, "$1<redacted>")
    .replace(/(["']?\b(?:access_token|accessToken|refresh_token|id_token|password|totp_secret|totpSecret|2fa_key|secret|session_id|cookie|cookies|authorization|code|otp|csrf|token)["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi, "$1<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted>")
    .replace(/otpauth:\/\/[^\s]+/gi, "<redacted>");
}

function requestError(status, message) {
  return Object.assign(new Error(message), { status });
}

function operationError(code) {
  return Object.assign(requestError(409, ERRORS[code]), { mfaCode: code });
}

function normalizeEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function normalizeSecret(value) {
  const secret = typeof value === "string" ? value.toUpperCase().replace(/\s/g, "") : "";
  if (!/^[A-Z2-7]{16,128}={0,6}$/.test(secret)) throw operationError("credentials");
  return secret.replace(/=+$/, "");
}

function parseImport(text) {
  if (typeof text !== "string") throw requestError(400, "请填写账号导入文本");
  const rows = new Map();
  let count = 0;
  for (const [index, raw] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    if (++count > MAX_ACCOUNTS) throw requestError(400, `每次最多导入 ${MAX_ACCOUNTS} 行账号`);
    const separator = raw.indexOf("----");
    const email = normalizeEmail(raw.slice(0, separator));
    if (separator < 0 || !email) throw requestError(400, `第 ${index + 1} 行邮箱或分隔格式错误`);
    const rest = raw.slice(separator + 4);
    const lastSeparator = rest.lastIndexOf("----");
    const password = lastSeparator < 0 ? rest : rest.slice(0, lastSeparator);
    const inputSecret = lastSeparator < 0 ? "" : rest.slice(lastSeparator + 4).trim();
    if (!password || /[\x00\r\n]/.test(password)) throw requestError(400, `第 ${index + 1} 行密码不能为空或包含控制字符`);
    let totpSecret = "";
    if (inputSecret) {
      try { totpSecret = normalizeSecret(inputSecret); }
      catch { throw requestError(400, `第 ${index + 1} 行 2FA 密钥必须为 16 至 128 位 Base32 字符`); }
    }
    rows.set(email, { email, password, totpSecret });
  }
  if (!rows.size) throw requestError(400, "请至少填写一行账号信息");
  return [...rows.values()];
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "";
}

function publicAccount(account) {
  return {
    id: account.id, email: account.email, status: account.status,
    stage: account.stage, error: account.error || "",
    hasPassword: Boolean(account.hasPassword), hasTotpKey: Boolean(account.hasTotpKey),
    createdAt: validDate(account.createdAt), updatedAt: account.updatedAt, changedAt: account.changedAt || "",
    importedAt: validDate(account.importedAt),
    importOrder: Number.isSafeInteger(account.importOrder) && account.importOrder > 0 ? account.importOrder : 0,
    logoutStatus: LOGOUT_STATUSES.has(account.logoutStatus) ? account.logoutStatus : "idle",
    logoutError: Object.values(ERRORS).includes(account.logoutError) ? account.logoutError : "",
    logoutAt: validDate(account.logoutAt),
    sessionOnly: account.sessionOnly === true,
  };
}

function processing(account) {
  return BUSY.has(account.status) || BUSY.has(account.logoutStatus);
}

function credentialsOnly(value = {}) {
  return {
    password: typeof value.password === "string" ? value.password : "",
    totpSecret: typeof value.totpSecret === "string" ? value.totpSecret : "",
    proxyUrl: typeof value.proxyUrl === "string" ? value.proxyUrl : "",
  };
}

export async function createMfaWorkspace({ root, protocolScript, credentialStore, isAccountBusy = () => false, onSuccess = async () => {}, resolveAuthorization = async () => null, onLogout = async () => {}, onSyncAuthorization = async () => { throw requestError(409, "账号授权同步暂不可用"); } }) {
  const directory = path.join(path.resolve(root), "mfa");
  const metadataPath = path.join(directory, "accounts.json");
  const accounts = new Map();
  const reservations = new Map();
  const activeTasks = new Map();
  const activeCredentials = new Map();
  const logWrites = new Map();
  const logErrors = new Map();
  let events = [];
  let concurrency = 3;
  let stopping = false;
  let initializationError = "";
  let serial = Promise.resolve();
  let shutdownPromise;

  function serialize(callback) {
    const operation = serial.then(callback);
    serial = operation.catch(() => {});
    return operation;
  }

  function ensureAvailable() {
    if (initializationError) throw requestError(409, initializationError);
    if (stopping) throw requestError(409, "MFA 工作区正在关闭");
  }

  function isBusy(email) {
    const normalized = normalizeEmail(email);
    return reservations.has(normalized) || [...accounts.values()].some((account) => account.email === normalized && processing(account));
  }

  // Reservations are acquired before the first await, so the main job workspace
  // can see imports/starts while their encrypted credential writes are pending.
  function reserve(emails, { allowRunning = false } = {}) {
    const token = Symbol("mfa-operation");
    for (const email of emails) {
      if (reservations.has(email) || (!allowRunning && isBusy(email)) || isAccountBusy(email)) throw operationError("busy");
    }
    for (const email of emails) reservations.set(email, token);
    return () => {
      for (const email of emails) if (reservations.get(email) === token) reservations.delete(email);
    };
  }

  function selectedAccounts(ids, { optional = false } = {}) {
    if (ids === undefined && optional) return [...accounts.values()];
    if (!Array.isArray(ids) || ids.length === 0) throw requestError(400, "请至少选择一个账号");
    const selected = [...new Set(ids)].map((id) => accounts.get(id));
    if (selected.some((account) => !account)) throw requestError(400, "所选账号不存在");
    return selected;
  }

  function list() {
    return {
      accounts: [...accounts.values()].sort((a, b) =>
        (b.importOrder || Date.parse(b.importedAt || b.createdAt) || 0) - (a.importOrder || Date.parse(a.importedAt || a.createdAt) || 0)
      ).map(publicAccount), concurrency,
      running: [...accounts.values()].some(processing),
      ...(initializationError ? { error: initializationError } : {}),
    };
  }

  function history() {
    return { items: events.map((event) => ({ ...event })) };
  }

  function logPath(account) {
    return path.join(directory, "logs", `${account.id}.log`);
  }

  function appendLog(account, message, credentials = activeCredentials.get(account.id)) {
    const timestamp = new Date().toISOString();
    const text = sanitizeProtocolLog(message, credentials);
    const previous = logWrites.get(account.id) || Promise.resolve();
    const write = previous.then(async () => {
      const target = logPath(account);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      let existing = "";
      try { existing = await fs.readFile(target, "utf8"); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      const content = `${existing}${text.split(/\r?\n/).filter(Boolean).map((line) => `[${timestamp}] ${line}\n`).join("")}`.slice(-MAX_LOG_CHARS);
      const temporary = `${target}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, content, { mode: 0o600 });
        await fs.rename(temporary, target);
        logErrors.delete(account.id);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    }).catch(() => { logErrors.set(account.id, "详情日志保存失败，请检查本地存储"); }); // Preserve confirmed remote changes.
    logWrites.set(account.id, write);
    void write.finally(() => { if (logWrites.get(account.id) === write) logWrites.delete(account.id); });
    return write;
  }

  async function logs(id) {
    const account = accounts.get(id);
    if (!account) throw requestError(404, "MFA 账号不存在");
    await logWrites.get(id);
    let text = "";
    try { text = await fs.readFile(logPath(account), "utf8"); }
    catch (error) { if (error?.code !== "ENOENT") throw requestError(500, "无法读取详情日志，请检查本地存储"); }
    return { accountId: id, logs: text, running: processing(account), error: logErrors.get(id) || "" };
  }

  async function runProtocol(account, entry, args, credentials) {
    await appendLog(account, `[process] 开始${entry.operation === "logout_all" ? "登出所有设备" : "修改 2FA"}，账号：${account.email}`);
    await appendLog(account, `[proxy] ${credentials.proxyUrl || "直连"}`);
    return new Promise((resolve) => {
      const reuseOnly = args.includes("--mfa-session") || entry.operation === "logout_all";
      const child = spawn(process.execPath, [protocolScript, ...args, "--verbose"], {
        env: { ...protocolEnvironment(), CHATGPT_LOGIN_PASSWORD: reuseOnly ? "" : credentials.password, CHATGPT_TOTP_SECRET: reuseOnly ? "" : credentials.totpSecret, CHATGPT_PROXY_URL: credentials.proxyUrl },
        stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      entry.child = child;
      const flushers = [];
      for (const [stream, source] of [[child.stdout, "protocol"], [child.stderr, "http/error"]]) {
        let pending = "";
        let skipping = false;
        const emit = (line) => {
          if (!line.trim()) return;
          const stage = /^\[mfa-stage\] ([a-z_]+)\b/.exec(line)?.[1];
          void appendLog(account, Object.hasOwn(STAGE_MESSAGES, stage) ? `[stage] ${STAGE_MESSAGES[stage]} (${stage})` : `[${source}] ${line}`, credentials);
          if (entry.operation === "rotate" && Object.hasOwn(STAGE_MESSAGES, stage)) {
            void serialize(async () => {
              if (account.status !== "running" || account.stage === "cancel_requested" || entry.interrupted) return;
              mark(account, "running", stage);
              await persist();
            }).catch(() => {});
          }
        };
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          const lines = `${pending}${chunk}`.split(/\r?\n/);
          pending = lines.pop();
          for (const line of lines) {
            if (!skipping && line.length <= MAX_LOG_LINE_CHARS) emit(line);
            else if (!skipping) void appendLog(account, `[${source}] 单行输出过长，已省略`);
            skipping = false;
          }
          if (pending.length > MAX_LOG_LINE_CHARS) {
            if (!skipping) void appendLog(account, `[${source}] 单行输出过长，已省略`);
            pending = "";
            skipping = true;
          }
        });
        flushers.push(() => { if (!skipping) emit(pending); pending = ""; });
      }
      child.once("error", (error) => { void appendLog(account, `[process] 启动失败：${error.message}`, credentials); });
      child.once("close", (code, signal) => {
        flushers.forEach((flush) => flush());
        void appendLog(account, `[process] 进程结束，退出码：${code ?? "无"}${signal ? `，信号：${signal}` : ""}`, credentials);
        resolve();
      });
    });
  }

  async function persist() {
    const temporary = path.join(directory, `.accounts-${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, concurrency, accounts: [...accounts.values()].map(publicAccount), history: events }, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, metadataPath);
    } catch {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw operationError("storage");
    }
  }

  function mark(account, status, stage, code = "") {
    account.status = status;
    account.stage = stage;
    account.error = ERRORS[code] || "";
    account.updatedAt = new Date().toISOString();
  }

  function markLogout(account, status, code = "") {
    account.logoutStatus = status;
    account.logoutError = ERRORS[code] || "";
    account.updatedAt = new Date().toISOString();
  }

  function record(account, operation = "rotate") {
    const logout = operation === "logout_all";
    events.unshift({
      id: crypto.randomUUID(), accountId: account.id, email: account.email,
      operation,
      status: logout ? account.logoutStatus : account.status,
      stage: logout ? ({ success: "logged_out", failed: "logout_failed", interrupted: "logout_interrupted" }[account.logoutStatus] || "logging_out") : account.stage,
      error: (logout ? account.logoutError : account.error) || "",
      startedAt: (logout ? account.logoutStartedAt : account.startedAt) || account.updatedAt, finishedAt: account.updatedAt,
      changedAt: account.changedAt || "",
    });
    events = events.slice(0, MAX_HISTORY);
  }

  function checkpointPath(account) {
    return path.join(directory, `${account.id}.checkpoint.json`);
  }

  function logoutResultPath(account) {
    return path.join(directory, `${account.id}.logout.json`);
  }

  function sessionPath(account) {
    return path.join(directory, `${account.id}.session.json`);
  }

  async function reusableSessionPath(account, required = false) {
    const ownPath = sessionPath(account);
    try {
      await fs.access(ownPath);
      // An expired session must never trigger a fresh login or silently select another account.
      await readMfaSession(ownPath, account.email);
      return ownPath;
    } catch (error) {
      if (error?.code !== "ENOENT") throw operationError(error?.mfaCode || "MFA_SESSION_INVALID");
    }
    if (required || account.sessionOnly) {
      const authorization = await resolveAuthorization(account.email);
      if (!authorization?.sessionPath) throw operationError("MFA_SESSION_MISSING");
      const session = await readMfaSession(authorization.sessionPath, account.email);
      await writeMfaSession(ownPath, session, account.email);
      return ownPath;
    }
    return null;
  }

  async function readCheckpoint(account) {
    let raw;
    try { raw = await fs.readFile(checkpointPath(account), "utf8"); }
    catch (error) { if (error?.code === "ENOENT") return null; throw operationError("checkpoint"); }
    try {
      const checkpoint = JSON.parse(raw);
      if (checkpoint.version !== 1 || normalizeEmail(checkpoint.email) !== account.email) throw new Error();
      if (checkpoint.activation_succeeded === true) normalizeSecret(checkpoint.secret);
      return checkpoint;
    } catch { throw operationError("checkpoint"); }
  }

  async function loadCredentials(account, requirePassword = !account.sessionOnly) {
    try {
      const credentials = credentialsOnly(await credentialStore.load(account.email));
      if (requirePassword && !credentials.password) throw new Error();
      if (credentials.totpSecret) credentials.totpSecret = normalizeSecret(credentials.totpSecret);
      return credentials;
    } catch { throw operationError("credentials"); }
  }

  async function finishCheckpoint(account, checkpoint, entry) {
    if (entry?.interrupted) throw operationError("interrupted");
    await serialize(async () => {
      mark(account, "running", "saving");
      await persist();
    });
    await appendLog(account, "[saving] 远端新 2FA 已生效，正在保存并同步登录凭据");
    try {
      const credentials = activeCredentials.get(account.id) || await loadCredentials(account);
      const updated = { ...credentials, totpSecret: normalizeSecret(checkpoint.secret) };
      await credentialStore.save(account.email, updated);
      await onSuccess(account.email, { ...updated });
    } catch { throw operationError("synchronize"); }
    if (entry?.interrupted) throw operationError("interrupted");
    await serialize(async () => {
      mark(account, "success", "completed");
      account.hasPassword = Boolean((activeCredentials.get(account.id) || await loadCredentials(account, false)).password);
      account.hasTotpKey = true;
      account.changedAt = validDate(checkpoint.activated_at) || new Date().toISOString();
      record(account);
      await persist();
    });
    // The durable success record must precede removal. If cleanup fails, retry
    // finalizes this checkpoint again instead of modifying the remote factor.
    await fs.rm(checkpointPath(account), { force: true }).catch(() => {});
    await appendLog(account, "[success] 2FA 修改完成，新密钥已保存，可导出成功结果");
  }

  async function failAccount(account, code, stage = "") {
    await appendLog(account, `[error] ${code}：${ERRORS[code] || ERRORS.protocol}${stage ? `，阶段：${STAGE_MESSAGES[stage] || stage}` : ""}`);
    await serialize(async () => {
      mark(account, code === "interrupted" ? "interrupted" : "failed", STAGES.has(stage) ? stage : code === "synchronize" ? "saving" : code === "interrupted" ? "interrupted" : "failed", code);
      record(account);
      await persist();
    }).catch(() => {
      mark(account, "failed", "failed", "storage");
    });
  }

  async function runAccount(account, entry) {
    try {
      await serialize(persist);
      if (entry.interrupted) throw operationError("interrupted");
      let checkpoint = await readCheckpoint(account);
      if (checkpoint?.activation_succeeded !== true) {
        if (isAccountBusy(account.email)) throw operationError("busy");
        const credentials = activeCredentials.get(account.id) || await loadCredentials(account);
        const reusable = await reusableSessionPath(account, account.sessionOnly);
        if (entry.interrupted) throw operationError("interrupted");
        if (checkpoint) await appendLog(account, `[resume] 从检查点继续，阶段：${STAGE_MESSAGES[checkpoint.stage] || checkpoint.stage}`);
        await runProtocol(account, entry, ["--rotate-totp", "--email", account.email, "--totp-result", checkpointPath(account),
          "--mfa-session-output", sessionPath(account), ...(reusable ? ["--mfa-session", reusable] : [])], credentials);
        if (entry.interrupted) throw operationError("interrupted");
        checkpoint = await readCheckpoint(account);
        if (checkpoint?.activation_succeeded !== true) {
          const code = typeof checkpoint?.error_code === "string" && Object.hasOwn(ERRORS, checkpoint.error_code) ? checkpoint.error_code : "protocol";
          throw Object.assign(operationError(code), { mfaStage: STAGES.has(checkpoint?.stage) ? checkpoint.stage : "failed" });
        }
        // Remote confirmation is authoritative even when a child failed after
        // writing it. Retrying such a result must never rotate a second time.
      } else {
        await appendLog(account, "[resume] 远端修改已确认，仅恢复本地保存与同步");
      }
      await finishCheckpoint(account, checkpoint, entry);
    } catch (error) {
      await failAccount(account, entry.interrupted ? "interrupted" : error?.mfaCode || "protocol", entry.interrupted ? "interrupted" : error?.mfaStage);
    }
  }

  async function runLogout(account, entry) {
    try {
      await serialize(persist);
      if (entry.interrupted) throw operationError("interrupted");
      const credentials = activeCredentials.get(account.id) || await loadCredentials(account, false);
      const reusable = await reusableSessionPath(account, true);
      const attemptId = crypto.randomUUID();
      await runProtocol(account, entry, ["--logout-all", "--email", account.email,
        "--logout-result", logoutResultPath(account), "--logout-attempt", attemptId, "--mfa-session", reusable], credentials);
      if (entry.interrupted) throw operationError("interrupted");
      let result;
      try { result = JSON.parse(await fs.readFile(logoutResultPath(account), "utf8")); } catch {}
      if (result?.version !== 1 || result.mode !== "logout_all" || result.email !== account.email || result.attempt_id !== attemptId) {
        throw operationError("MFA_LOGOUT_FAILED");
      }
      if (result.logout_succeeded !== true || !validDate(result.logout_at)) {
        throw operationError(Object.hasOwn(ERRORS, result.error_code) ? result.error_code : "MFA_LOGOUT_FAILED");
      }
      try {
        await invalidateMfaSession(sessionPath(account), account.email);
        await onLogout(account.email);
      } catch {
        await appendLog(account, "[warning] 远端已确认登出，本地会话失效标记保存未完成；再次使用时仍会校验授权");
      }
      await serialize(async () => {
        markLogout(account, "success");
        account.logoutAt = validDate(result.logout_at);
        record(account, "logout_all");
        await persist();
      });
      await appendLog(account, "[success] 所有设备登出已确认");
    } catch (error) {
      const code = entry.interrupted ? "interrupted" : error?.mfaCode || "MFA_LOGOUT_FAILED";
      await appendLog(account, `[error] ${code}：${ERRORS[code] || ERRORS.MFA_LOGOUT_FAILED}`);
      await serialize(async () => {
        markLogout(account, entry.interrupted ? "interrupted" : "failed", entry.interrupted ? "interrupted" : error?.mfaCode || "MFA_LOGOUT_FAILED");
        record(account, "logout_all");
        await persist();
      }).catch(() => { markLogout(account, "failed", "storage"); });
    }
  }

  function pump() {
    if (stopping) return;
    while (activeTasks.size < concurrency) {
      const account = [...accounts.values()].find((item) => item.status === "queued" || item.logoutStatus === "queued");
      if (!account) break;
      const logout = account.logoutStatus === "queued";
      if (logout) markLogout(account, "running");
      else mark(account, "running", "rotating");
      const entry = { child: null, done: null, interrupted: false, operation: logout ? "logout_all" : "rotate" };
      activeTasks.set(account.id, entry);
      entry.done = (logout ? runLogout(account, entry) : runAccount(account, entry)).finally(() => {
        activeTasks.delete(account.id);
        activeCredentials.delete(account.id);
        pump();
      });
    }
  }

  async function importAccounts(text) {
    ensureAvailable();
    const parsed = parseImport(text);
    const release = reserve(parsed.map((row) => row.email));
    try {
      return await serialize(async () => {
        const byEmail = new Map([...accounts.values()].map((account) => [account.email, account]));
        const added = parsed.filter((row) => !byEmail.has(row.email)).length;
        if (accounts.size + added > MAX_ACCOUNTS) throw requestError(400, `工作区最多保存 ${MAX_ACCOUNTS} 个账号`);
        const untouchedCheckpoints = [];
        for (const row of parsed) {
          const existing = byEmail.get(row.email);
          const checkpoint = existing ? await readCheckpoint(existing) : null;
          if (!checkpoint) continue;
          // Failed login attempts can be corrected by importing credentials again.
          // Once any remote mutation has been attempted, keep its recovery state.
          const untouched = ["pending", "authenticated"].includes(checkpoint.stage)
            && !checkpoint.old_factor_disabled && !checkpoint.old_factor_id
            && !checkpoint.secret && !checkpoint.factor_id && !checkpoint.session_id
            && !checkpoint.activation_succeeded && !checkpoint.activation_accepted;
          if (!untouched) throw requestError(409, "账号有待恢复的 MFA 检查点，请先重试完成恢复");
          untouchedCheckpoints.push(checkpointPath(existing));
        }
        // All input and account locks are validated before the first write.
        const previous = new Map();
        for (const row of parsed) {
          try { previous.set(row.email, credentialsOnly(await credentialStore.load(row.email))); }
          catch { throw operationError("credentials"); }
        }
        const written = [];
        try {
          for (const row of parsed) {
            await credentialStore.save(row.email, { password: row.password, totpSecret: row.totpSecret, proxyUrl: previous.get(row.email).proxyUrl });
            written.push(row.email);
          }
        } catch {
          for (const email of written) await credentialStore.save(email, previous.get(email)).catch(() => {});
          throw operationError("credentials");
        }
        const previousAccounts = new Map(parsed.map((row) => {
          const account = byEmail.get(row.email);
          return [row.email, account ? { ...account } : null];
        }));
        const importedAt = new Date().toISOString();
        const importOrder = Math.max(Date.now(), ...[...accounts.values()].map((account) => account.importOrder || 0)) + parsed.length;
        const imported = parsed.map((row, index) => {
          const account = byEmail.get(row.email) || { id: crypto.randomUUID(), email: row.email, createdAt: importedAt, changedAt: "" };
          account.importedAt = importedAt;
          account.importOrder = importOrder - index;
          mark(account, "ready", "ready");
          markLogout(account, "idle");
          account.logoutAt = "";
          account.hasPassword = true;
          account.hasTotpKey = Boolean(row.totpSecret);
          accounts.set(account.id, account);
          return publicAccount(account);
        });
        try { await persist(); }
        catch (error) {
          for (const account of imported) {
            const previousAccount = previousAccounts.get(account.email);
            if (previousAccount) Object.assign(accounts.get(account.id), previousAccount);
            else accounts.delete(account.id);
          }
          for (const email of written) await credentialStore.save(email, previous.get(email)).catch(() => {});
          throw error;
        }
        // Removal happens only after the new credentials and metadata are saved.
        // These checkpoints contain no remote changes to reconcile.
        for (const filePath of untouchedCheckpoints) await fs.rm(filePath, { force: true });
        return { accounts: imported, imported: parsed.length, count: parsed.length, added, updated: parsed.length - added };
      });
    } finally { release(); }
  }

  async function start(options = {}, operation = "rotate") {
    ensureAvailable();
    const selected = selectedAccounts(options.ids);
    const logout = operation === "logout_all";
    if (logout && selected.some((account) => account.status !== "success")) throw requestError(400, "只能为 MFA 修改成功的账号登出所有设备");
    const requestedConcurrency = options.concurrency === undefined ? 3 : Number(options.concurrency);
    if (!Number.isInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > 30) throw requestError(400, "并发数必须为 1 至 30 的整数");
    if ([...accounts.values()].some(processing) || activeTasks.size) throw requestError(409, "请等待当前批次结束后再启动下一批");
    let proxyUrl;
    if (options.proxyUrl !== undefined) {
      if (typeof options.proxyUrl !== "string") throw requestError(400, "代理地址格式错误");
      proxyUrl = options.proxyUrl.trim();
      if (proxyUrl) {
        try { if (!["http:", "https:", "socks5:", "socks5h:"].includes(new URL(proxyUrl).protocol)) throw new Error(); }
        catch { throw requestError(400, "代理地址必须使用 http、https、socks5 或 socks5h"); }
      }
    }
    const release = reserve(selected.map((account) => account.email));
    try {
      await serialize(async () => {
        if ([...accounts.values()].some(processing)) throw requestError(409, "已有批次正在运行");
        const loaded = [];
        for (const account of selected) {
          const credentials = await loadCredentials(account, !logout && !account.sessionOnly);
          const checkpoint = await readCheckpoint(account);
          if (logout && checkpoint) throw requestError(409, "账号有待恢复的 MFA 检查点，请先重试完成恢复");
          if (proxyUrl !== undefined) credentials.proxyUrl = proxyUrl;
          loaded.push([account.id, credentials]);
        }
        concurrency = requestedConcurrency;
        const previous = selected.map((account) => ({ ...account }));
        for (const account of selected) {
          if (logout) {
            markLogout(account, "queued");
            account.logoutStartedAt = account.updatedAt;
            account.logoutAt = "";
          } else {
            mark(account, "queued", "queued");
            markLogout(account, "idle");
            account.logoutAt = "";
            account.startedAt = account.updatedAt;
          }
        }
        try { await persist(); }
        catch (error) { for (const account of previous) Object.assign(accounts.get(account.id), account); throw error; }
        for (const [id, credentials] of loaded) activeCredentials.set(id, credentials);
        for (const account of selected) await appendLog(account, `[queued] 已加入${logout ? "设备登出" : "2FA 修改"}队列，并发数：${concurrency}`);
      });
    } finally { release(); }
    pump();
    return { ...list(), started: selected.length, count: selected.length };
  }

  async function startFromAuthorization(emailValue) {
    ensureAvailable();
    const email = normalizeEmail(emailValue);
    if (!email) throw requestError(400, "账号邮箱不正确");
    const release = reserve([email]);
    let target;
    try {
      await serialize(async () => {
        if ([...accounts.values()].some(processing) || activeTasks.size) throw requestError(409, "请等待当前 MFA 批次结束后重试");
        const authorization = await resolveAuthorization(email);
        if (!authorization?.sessionPath) throw operationError("MFA_SESSION_MISSING");
        let session;
        try { session = await readMfaSession(authorization.sessionPath, email); }
        catch (error) { throw operationError(error.mfaCode || "MFA_SESSION_INVALID"); }
        const existing = [...accounts.values()].find((account) => account.email === email);
        if (!existing && accounts.size >= MAX_ACCOUNTS) throw requestError(400, `工作区最多保存 ${MAX_ACCOUNTS} 个账号`);
        target = existing || { id: crypto.randomUUID(), email, createdAt: new Date().toISOString(), changedAt: "" };
        const credentials = credentialsOnly(authorization.credentials);
        if (credentials.totpSecret) credentials.totpSecret = normalizeSecret(credentials.totpSecret);
        const previous = existing ? { ...existing } : null;
        const previousCredentials = credentialsOnly(await credentialStore.load(email));
        let previousSession;
        try { previousSession = await fs.readFile(sessionPath(target)); } catch (error) { if (error.code !== "ENOENT") throw operationError("storage"); }
        try {
          await credentialStore.save(email, credentials);
          await writeMfaSession(sessionPath(target), session, email);
          target.sessionOnly = true;
          target.hasPassword = Boolean(credentials.password);
          target.hasTotpKey = Boolean(credentials.totpSecret);
          mark(target, "queued", "queued");
          markLogout(target, "idle");
          target.logoutAt = "";
          target.startedAt = target.updatedAt;
          accounts.set(target.id, target);
          await persist();
        } catch (error) {
          if (previous) Object.assign(target, previous);
          else accounts.delete(target.id);
          await credentialStore.save(email, previousCredentials).catch(() => {});
          if (previousSession) await fs.writeFile(sessionPath(target), previousSession, { mode: 0o600 }).catch(() => {});
          else await fs.rm(sessionPath(target), { force: true }).catch(() => {});
          throw operationError(error.mfaCode || "storage");
        }
        activeCredentials.set(target.id, credentials);
        await appendLog(target, "[queued] 从账号授权页发起 MFA 修改，复用已有授权；失效时停止并提示，不自动登录");
      });
    } finally { release(); }
    pump();
    return { ...list(), accountId: target.id, started: 1, count: 1 };
  }

  async function syncToAuthorization(options = {}) {
    ensureAvailable();
    const selected = selectedAccounts(options.ids);
    const results = [];
    for (const account of selected) {
      let release;
      try {
        release = reserve([account.email]);
        const result = await serialize(async () => {
          if (await readCheckpoint(account)) throw requestError(409, "账号有待恢复的 MFA 检查点，请先完成恢复再同步");
          const credentials = await loadCredentials(account, false);
          const source = await reusableSessionPath(account, true);
          const session = await readMfaSession(source, account.email);
          return onSyncAuthorization(account.email, credentials, session);
        });
        results.push({ id: account.id, email: account.email, success: true, ...result });
      } catch (error) {
        results.push({ id: account.id, email: account.email, success: false,
          message: ERRORS[error?.mfaCode] || (error?.status === 409 ? error.message : "同步未完成，请稍后重试") });
      } finally { release?.(); }
    }
    return { synced: results.filter((row) => row.success).length, failed: results.filter((row) => !row.success).length, results };
  }

  async function cancel(ids) {
    ensureAvailable();
    const selected = selectedAccounts(ids, { optional: true });
    let canceled = 0;
    let finishing = 0;
    await serialize(async () => {
      for (const account of selected) {
        if (account.logoutStatus === "queued") {
          markLogout(account, "interrupted", "canceled");
          activeCredentials.delete(account.id);
          record(account, "logout_all");
          await appendLog(account, "[cancel] 已取消排队中的设备登出任务");
          canceled++;
        } else if (account.logoutStatus === "running") {
          finishing++;
        } else if (account.status === "queued") {
          mark(account, "interrupted", "interrupted", "canceled");
          activeCredentials.delete(account.id);
          record(account);
          await appendLog(account, "[cancel] 已取消排队中的 2FA 修改任务");
          canceled++;
        } else if (account.status === "running") {
          mark(account, "running", "cancel_requested");
          await appendLog(account, "[cancel] 已请求停止，正在等待当前操作完成");
          finishing++;
        }
      }
      await persist();
    });
    return { ...list(), canceled, finishing, count: canceled };
  }

  async function exportAccounts(options = {}) {
    ensureAvailable();
    const format = options.format || "txt";
    if (!["txt", "json"].includes(format)) throw requestError(400, "导出格式必须为 txt 或 json");
    const selected = selectedAccounts(options.ids, { optional: true }).filter((account) => account.status === "success");
    if (!selected.length) throw requestError(400, "没有可导出的成功账号");
    const release = reserve(selected.map((account) => account.email));
    try {
      return await serialize(async () => {
        const rows = [];
        for (const account of selected) {
          const credentials = await loadCredentials(account);
          if (!credentials.totpSecret) throw operationError("credentials");
          rows.push({ email: account.email, password: credentials.password, totpSecret: credentials.totpSecret });
        }
        return {
          body: format === "json" ? JSON.stringify(rows, null, 2) : `\uFEFF${rows.map((row) => `${row.email}----${row.password}----${row.totpSecret}`).join("\r\n")}\r\n`,
          contentType: format === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
          filename: `mfa-accounts-${new Date().toISOString().replace(/[:.]/g, "-")}.${format}`,
          count: rows.length,
        };
      });
    } finally { release(); }
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      await serialize(async () => {
        for (const account of accounts.values()) {
          if (account.logoutStatus === "queued") {
            markLogout(account, "interrupted", "interrupted");
            activeCredentials.delete(account.id);
            record(account, "logout_all");
          } else if (account.status === "queued") {
            mark(account, "interrupted", "interrupted", "interrupted");
            activeCredentials.delete(account.id);
            record(account);
          }
        }
        if (!initializationError) await persist();
      }).catch(() => {});
      const tasks = [...activeTasks.values()];
      let timer;
      await Promise.race([
        Promise.allSettled(tasks.map((entry) => entry.done)),
        new Promise((resolve) => { timer = setTimeout(resolve, 5000); }),
      ]);
      clearTimeout(timer);
      for (const [id, entry] of activeTasks) {
        entry.interrupted = true;
        entry.child?.kill();
        entry.child?.unref();
        if (entry.operation === "logout_all") markLogout(accounts.get(id), "interrupted", "interrupted");
        else mark(accounts.get(id), "interrupted", "interrupted", "interrupted");
      }
      await serialize(async () => { if (!initializationError) await persist(); }).catch(() => {});
      await Promise.allSettled([...logWrites.values()]);
    })();
    return shutdownPromise;
  }

  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let stored;
    try { stored = JSON.parse(await fs.readFile(metadataPath, "utf8")); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (stored) {
      if (stored.version !== 1 || !Array.isArray(stored.accounts) || stored.accounts.length > MAX_ACCOUNTS) throw new Error();
      concurrency = Number.isInteger(stored.concurrency) && stored.concurrency >= 1 && stored.concurrency <= 30 ? stored.concurrency : 3;
      const emails = new Set();
      for (const value of stored.accounts) {
        const email = normalizeEmail(value.email);
        if (!email || emails.has(email) || typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id) || accounts.has(value.id)) throw new Error();
        emails.add(email);
        const account = publicAccount({
          ...value, email,
          status: STATUSES.has(value.status) ? value.status : "interrupted",
          stage: STAGES.has(value.stage) ? value.stage : "interrupted",
          error: Object.values(ERRORS).includes(value.error) ? value.error : "",
          updatedAt: validDate(value.updatedAt) || new Date().toISOString(), changedAt: validDate(value.changedAt),
        });
        accounts.set(account.id, account);
      }
      events = (Array.isArray(stored.history) ? stored.history : []).slice(0, MAX_HISTORY).flatMap((value) => {
        const email = normalizeEmail(value.email);
        if (!email || !STATUSES.has(value.status)) return [];
        return [{
          id: typeof value.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value.id) ? value.id : crypto.randomUUID(),
          accountId: accounts.has(value.accountId) ? value.accountId : "", email,
          operation: value.operation === "logout_all" ? "logout_all" : "rotate",
          status: value.status, stage: STAGES.has(value.stage) ? value.stage : "interrupted",
          error: Object.values(ERRORS).includes(value.error) ? value.error : "",
          startedAt: validDate(value.startedAt), finishedAt: validDate(value.finishedAt), changedAt: validDate(value.changedAt),
        }];
      });
    }
    for (const account of accounts.values()) {
      if (BUSY.has(account.logoutStatus)) { markLogout(account, "interrupted", "interrupted"); record(account, "logout_all"); await appendLog(account, "[restore] 服务重启，设备登出结果未确认，可重试登出"); }
      if (BUSY.has(account.status)) { mark(account, "interrupted", "interrupted", "interrupted"); record(account); await appendLog(account, "[restore] 服务重启，2FA 修改被中断，可继续恢复"); }
      try {
        const checkpoint = await readCheckpoint(account);
        if (checkpoint?.activation_succeeded === true) {
          if (isAccountBusy(account.email)) throw operationError("busy");
          const release = reserve([account.email]);
          try { await finishCheckpoint(account, checkpoint); } finally { release(); }
        }
      } catch (error) { await failAccount(account, error?.mfaCode || "checkpoint"); }
    }
    await persist();
  } catch {
    initializationError = "MFA 工作区资料无法读取或保存，请检查本地数据文件";
  }

  return { list, logs, preview: (text) => { const rows = parseImport(text); return { accounts: rows.map(({ email }) => ({ email })), count: rows.length }; }, importAccounts, start, startFromAuthorization, syncToAuthorization, logoutAll: (options) => start(options, "logout_all"), cancel, exportAccounts, history, isBusy, shutdown };
}
