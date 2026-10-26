import crypto from "node:crypto";
import fs, { attachWorkspaceStorage, workspaceChildOptions } from "./workspace-storage.mjs";
import path from "node:path";
import { spawn } from "node:child_process";
import { protocolEnvironment } from "./cdk-security.mjs";
import { fetchMailboxOtpCandidates, filterMailboxOtpCandidatesByRequestTime, validateMailApiUrl } from "./mail-otp.mjs";
import { REBIND_ERRORS, rebindError } from "./email-rebind-protocol.mjs";
import { createRebindLogStore, describeRebindError } from "./email-rebind-logs.mjs";

const ACTIVE = new Set(["queued", "checking", "beginning", "waiting_auto", "waiting_manual", "verifying", "uncertain"]);
const STATES = new Set([...ACTIVE, "success", "failed", "cancelled", "interrupted"]);
const text = (value) => typeof value === "string" ? value.trim() : "";
const email = (value) => text(value).toLowerCase();
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const error = (message, status = 409) => Object.assign(new Error(message), { status });

export function parseRebindTargets(raw, count) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 512_000) throw error("新邮箱输入内容无效或过长", 400);
  const rows = raw.replace(/^\uFEFF/, "").split(/\r?\n/).map((value, index) => ({ value: value.trim(), line: index + 1 })).filter((row) => row.value);
  if (rows.length !== count) throw error(`已选 ${count} 个账号，必须输入 ${count} 条新邮箱，当前为 ${rows.length} 条`, 400);
  const emails = new Set(); const urls = new Set();
  return rows.map(({ value, line }) => {
    const separator = value.indexOf("----");
    const newEmail = email(separator < 0 ? value : value.slice(0, separator));
    const mailboxUrl = separator < 0 ? "" : text(value.slice(separator + 4));
    if (!validEmail(newEmail)) throw error(`第 ${line} 行邮箱格式不正确`, 400);
    if (emails.has(newEmail)) throw error(`第 ${line} 行新邮箱重复`, 400);
    if (separator >= 0 && !validateMailApiUrl(mailboxUrl)) throw error(`第 ${line} 行取件 URL 必须为有效 HTTP 或 HTTPS 地址；纯邮箱请移除分隔符`, 400);
    if (mailboxUrl && urls.has(mailboxUrl)) throw error(`第 ${line} 行取件地址重复，请使用独立地址或改为手动收码`, 400);
    emails.add(newEmail); if (mailboxUrl) urls.add(mailboxUrl);
    return { newEmail, mailboxUrl, mode: mailboxUrl ? "auto" : "manual" };
  });
}

export function createRebindRunner(protocolScript, directory) {
  return async (operation, payload, signal, onLog = () => {}) => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const resultPath = path.join(directory, `${crypto.randomUUID()}.result.json`);
    let child; let timer; let aborted; let timedOut = false;
    let logTail = Promise.resolve();
    const buffers = new Map();
    const record = (message) => { logTail = logTail.then(() => onLog(message)); logTail.catch(() => {}); };
    const capture = (stream, label) => {
      buffers.set(label, ""); stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        let value = buffers.get(label) + chunk; let index;
        while ((index = value.indexOf("\n")) >= 0) { record(`[${label}] ${value.slice(0, index)}\n`); value = value.slice(index + 1); }
        buffers.set(label, value);
      });
    };
    try {
      await onLog(`[process] 启动协议步骤 ${operation}`);
      const exit = await new Promise((resolve, reject) => {
        child = spawn(process.execPath, [protocolScript, "--rebind-operation", operation, "--rebind-result", resultPath], {
          env: { ...protocolEnvironment(), ...workspaceChildOptions(directory), CHATGPT_PROXY_URL: payload.proxyUrl || "", CHATGPT_LOGIN_PASSWORD: "", CHATGPT_TOTP_SECRET: "" },
          stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true,
        });
        attachWorkspaceStorage(child, directory);
        capture(child.stdout, "stdout"); capture(child.stderr, "stderr");
        aborted = () => child.kill("SIGTERM");
        signal?.addEventListener("abort", aborted, { once: true });
        if (signal?.aborted) aborted();
        timer = setTimeout(() => { timedOut = true; aborted(); }, 35_000);
        child.once("error", reject); child.once("close", (code, terminationSignal) => {
          for (const [label, value] of buffers) if (value) record(`[${label}] ${value}\n`);
          record(`[process] 步骤 ${operation} 退出，code=${code}，signal=${terminationSignal || "none"}${timedOut ? "，超过 35 秒执行时限" : ""}`);
          resolve(code);
        });
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify(payload));
      });
      await logTail;
      if (exit !== 0) throw rebindError(operation === "verify" ? "UNCERTAIN" : "NETWORK");
      const result = JSON.parse(await fs.readFile(resultPath, "utf8"));
      if (result.ok !== true) throw rebindError(Object.hasOwn(REBIND_ERRORS, result.code) ? result.code : "REQUEST_FAILED", result.diagnostic);
      return result;
    } catch (failure) {
      await logTail.catch(() => {});
      await onLog(`[process:error] ${operation}\n${describeRebindError(failure)}`);
      throw failure.rebindCode ? failure : Object.assign(rebindError(operation === "verify" ? "UNCERTAIN" : "NETWORK"), { cause: failure });
    }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", aborted); await fs.rm(resultPath, { force: true }).catch(() => {}); }
  };
}

export async function createEmailRebindWorkspace({ root, vault, listSources, resolveSource, isAccountBusy, lookupSync = () => null, runStep,
  pollMailbox = fetchMailboxOtpCandidates, pollIntervalMs = 2000, now = Date.now }) {
  const directory = path.join(root, "email-rebind");
  const statePath = path.join(directory, "state.enc");
  const items = new Map(); const active = new Map();
  let serial = Promise.resolve(); let stopping = false; let initializationError = ""; let concurrency = 1;
  const scope = "email-rebind-state";
  const journal = createRebindLogStore({ directory, vault, now });
  const serialize = (callback) => { const result = serial.then(callback); serial = result.catch(() => {}); return result; };
  const available = () => { if (initializationError) throw error(initializationError); if (stopping) throw error("邮箱换绑工作区正在关闭"); };
  const privateItem = (id) => { const item = items.get(id); if (!item) throw error("换绑记录不存在", 404); return item; };
  const isBusy = (value) => [...items.values()].some((item) => ACTIVE.has(item.status)
    && (item.oldEmail === email(value) || (item.status !== "uncertain" && item.newEmail === email(value))));
  const selected = (ids) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || new Set(ids).size !== ids.length) throw error("请选择 1 至 500 条不重复的记录", 400);
    return ids.map(privateItem);
  };
  async function persist() {
    const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
    const savedItems = [...items.values()].map((item) => ({ ...item, snapshot: undefined,
      snapshotSealed: item.snapshot ? vault.seal(item.snapshot, `email-rebind-snapshot:${item.id}`) : item.snapshotSealed || null }));
    try { await fs.writeFile(temporary, vault.seal({ version: 1, concurrency, items: savedItems }, scope), { mode: 0o600 }); await fs.rename(temporary, statePath); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  function accountSnapshot(item) {
    if (!item.snapshot && item.snapshotSealed) item.snapshot = vault.open(item.snapshotSealed, `email-rebind-snapshot:${item.id}`);
    return item.snapshot;
  }
  function transition(item, status, message = "") {
    item.status = status; item.message = message; item.updatedAt = new Date(now()).toISOString();
    (item.events ||= []).push({ at: item.updatedAt, status, message }); item.events = item.events.slice(-30);
    void journal.append(item, `[state:${status}] ${message}`).catch(() => {});
  }
  async function update(item, status, message = "") { await serialize(async () => { transition(item, status, message); await persist(); }); }
  function publicItem(item) {
    const sync = lookupSync(item);
    return { id: item.id, batchId: item.batchId, sourceRef: item.sourceRef, oldEmail: item.oldEmail, newEmail: item.newEmail,
      mode: item.mode, hasMailboxUrl: Boolean(item.mailboxUrl), status: item.status, message: item.message || "", createdAt: item.createdAt,
      updatedAt: item.updatedAt, confirmedAt: item.confirmedAt || null, requestedAt: item.requestedAt || null,
      challengeVersion: item.challengeVersion || 0, nextSendAt: item.nextSendAt || null,
      syncedJobId: sync?.id || null, credentialStatus: item.status === "success" ? "needs_login" : "unchanged",
      retryAfter: item.retryAfter || null,
      canRetry: ["failed", "cancelled", "interrupted"].includes(item.status) && (!item.retryAfter || now() >= item.retryAfter), events: item.events || [] };
  }
  function sources() {
    return listSources().map((source) => ({ ...source, busy: source.busy || isBusy(source.email),
      rebound: [...items.values()].some((item) => item.oldEmail === source.email && item.status === "success") }));
  }
  function preview(body) {
    available();
    const ids = body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || new Set(ids).size !== ids.length) throw error("请选择 1 至 500 个不重复的账号", 400);
    const candidates = new Map(sources().map((source) => [source.id, source]));
    const targets = parseRebindTargets(body.text, ids.length);
    const rows = ids.map((id, index) => {
      const source = candidates.get(id);
      if (!source) throw error("部分原账号不存在或不属于当前工作区", 400);
      if (source.busy || source.rebound || isAccountBusy(source.email)) throw error("部分原账号正在执行任务或已完成换绑，请重新选择");
      const target = targets[index];
      if ([...candidates.values()].some((candidate) => candidate.email === target.newEmail)) throw error(`第 ${index + 1} 行目标邮箱已在当前工作区存在`, 400);
      if ([...items.values()].some((item) => item.newEmail === target.newEmail && (ACTIVE.has(item.status) || item.status === "success"))) throw error(`第 ${index + 1} 行目标邮箱已被换绑任务占用`);
      return { sourceRef: source.id, oldEmail: source.email, ...target };
    });
    const digest = crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    return { rows, digest };
  }
  function publicPreview(body) {
    const value = preview(body);
    return { digest: value.digest, count: value.rows.length, rows: value.rows.map(({ mailboxUrl, ...row }) => ({ ...row, hasMailboxUrl: Boolean(mailboxUrl) })) };
  }
  function list() {
    return { sources: sources(), items: [...items.values()].reverse().map(publicItem), concurrency, ...(initializationError ? { error: initializationError } : {}) };
  }
  async function sourceSnapshot(item) {
    if (isAccountBusy(item.oldEmail)) throw error("原账号正在执行其他任务");
    try { return await resolveSource(item.sourceRef, item.oldEmail); }
    catch (failure) { throw failure.rebindCode ? failure : Object.assign(rebindError(/EXPIRED|MISSING/.test(failure.mfaCode || "") ? "SESSION_EXPIRED" : "SESSION_INVALID"), { cause: failure }); }
  }
  async function start(body) {
    available();
    const desiredConcurrency = body.concurrency === undefined ? 1 : Number(body.concurrency);
    if (!Number.isInteger(desiredConcurrency) || desiredConcurrency < 1 || desiredConcurrency > 30) throw error("并发数必须为 1 至 30 的整数", 400);
    const timeout = body.timeout === undefined ? 180 : Number(body.timeout);
    if (!Number.isInteger(timeout) || timeout < 30 || timeout > 600) throw error("验证码等待时间必须为 30 至 600 秒", 400);
    const batchId = crypto.randomUUID();
    await serialize(async () => {
      const value = preview(body);
      if (body.digest !== value.digest) throw error("映射已变化，请重新核对原账号和新邮箱");
      if (items.size + value.rows.length > 5000) throw error("换绑记录已达 5000 条上限");
      const added = [];
      for (const row of value.rows) {
        const item = { ...row, id: crypto.randomUUID(), batchId, status: "queued", createdAt: new Date(now()).toISOString(), timeout,
          events: [], challengeVersion: 0, message: "等待检查登录信息" };
        item.updatedAt = item.createdAt;
        // Reserve both identities before yielding to credential reads.
        items.set(item.id, item); added.push(item);
      }
      try { for (const item of added) { try { item.snapshot = await sourceSnapshot(item); } catch { item.snapshot = null; } } concurrency = desiredConcurrency; await persist(); }
      catch (failure) { for (const item of added) items.delete(item.id); throw failure; }
    });
    pump(); return { batchId, count: body.ids.length };
  }
  async function step(item, operation, code, signal) {
    const snapshot = accountSnapshot(item);
    if (!snapshot?.session) throw rebindError("SESSION_EXPIRED");
    await journal.append(item, `[step:${operation}] 开始 ${item.oldEmail} -> ${item.newEmail}`);
    const result = await runStep(operation, { email: item.oldEmail, newEmail: item.newEmail, session: snapshot.session,
      cookies: snapshot.cookies || [], proxyUrl: snapshot.credentials?.proxyUrl || "", ...(code ? { code } : {}) }, signal, (message) => journal.append(item, message));
    if (Array.isArray(result.cookies)) snapshot.cookies = result.cookies;
    await journal.append(item, `[step:${operation}] 完成\n${JSON.stringify(result.data, null, 2)}`);
    return result.data;
  }
  async function baseline(item) {
    item.baseline = []; item.baselineKnown = false;
    if (!item.mailboxUrl) return;
    await journal.append(item, `[mail] 建立历史邮件基线 ${item.mailboxUrl}`);
    try { item.baseline = (await pollMailbox(item.mailboxUrl, { timeoutMs: 10_000 })).map((candidate) => candidate.key); item.baselineKnown = true; await journal.append(item, `[mail] 基线已保存，历史候选 ${item.baseline.length} 条`); }
    catch (failure) { await journal.append(item, `[mail:error] 建立基线失败\n${describeRebindError(failure)}`); }
  }
  async function fail(item, failure, operation = "") {
    await journal.append(item, `[error:${failure.rebindCode || "REQUEST_FAILED"}] ${operation}\n${describeRebindError(failure)}`);
    if (stopping && operation !== "verify") { await update(item, "interrupted", "服务已停止，可重试恢复当前映射"); return; }
    const code = failure.rebindCode || "REQUEST_FAILED";
    const uncertain = code === "UNCERTAIN" || (operation === "verify" && !failure.rebindCode);
    const httpStatus = failure.diagnostic?.httpStatus;
    if (code === "SENSITIVE_ACTION_COOLDOWN") item.retryAfter = Number.isFinite(failure.diagnostic?.retryAfter) ? failure.diagnostic.retryAfter : null;
    const upstreamMessage = failure.diagnostic?.upstreamMessage;
    const message = upstreamMessage
      ? `${upstreamMessage}${Number.isInteger(httpStatus) ? `（HTTP ${httpStatus}）` : ""}`
      : `${REBIND_ERRORS[code] || "请求未完成，请稍后重试"}${Number.isInteger(httpStatus) ? `（HTTP ${httpStatus}）` : ""}`;
    await update(item, uncertain ? "uncertain" : "failed", message);
  }
  async function begin(item, run) {
    try {
      item.attempt = (item.attempt || 0) + 1;
      await journal.append(item, `[attempt:${item.attempt}] ${item.oldEmail} -> ${item.newEmail}，收码方式=${item.mode}`);
      await update(item, "checking", "检查已有登录信息和换绑资格");
      item.snapshot = await sourceSnapshot(item);
      await step(item, "eligibility", null, run.controller.signal);
      if (item.cancelRequested || stopping) { await update(item, "cancelled", "已停止，未确认换绑"); return; }
      await baseline(item);
      await serialize(async () => {
        transition(item, "beginning", "正在提交新邮箱并发送验证码");
        item.requestedAt = now(); item.nextSendAt = now() + 30_000; item.challengeVersion++;
        await persist();
      });
      await step(item, "begin", null, run.controller.signal);
      if (item.cancelRequested || stopping) { await update(item, "cancelled", "已停止，未确认换绑"); return; }
      await update(item, item.mode === "auto" ? "waiting_auto" : "waiting_manual", item.mode === "auto" ? "正在自动收码" : "请输入本次换绑验证码，请检查新邮箱及原邮箱");
      if (item.mode === "auto") await poll(item, run);
    } catch (failure) { await fail(item, failure); }
  }
  async function poll(item, run) {
    while (!stopping && !item.cancelRequested && item.status === "waiting_auto") {
      if (now() >= item.requestedAt + item.timeout * 1000) { await update(item, "waiting_manual", "自动取码超时，可手动输入或重新发送"); return; }
      try {
        await journal.append(item, `[mail] 检查本次发码后的新邮件 ${item.mailboxUrl}`);
        const candidates = filterMailboxOtpCandidatesByRequestTime(await pollMailbox(item.mailboxUrl, { timeoutMs: 10_000 }), item.requestedAt)
          .filter((candidate) => !item.baseline.includes(candidate.key) && (candidate.receivedAt || item.baselineKnown));
        if (item.status !== "waiting_auto") return;
        const codes = [...new Set(candidates.map((candidate) => candidate.code))];
        await journal.append(item, `[mail] 新候选 ${candidates.length} 条，不同验证码 ${codes.length} 个`);
        if (codes.length > 1) { await update(item, "waiting_manual", "收到多个验证码，请手动确认后输入"); return; }
        if (codes.length === 1) { await verify(item, codes[0], item.challengeVersion, run); return; }
      } catch (failure) { await journal.append(item, `[mail:error]\n${describeRebindError(failure)}`); if (item.status === "waiting_auto") await update(item, "waiting_manual", "取件接口不可用，可手动输入验证码"); return; }
      await new Promise((resolve) => {
        const finish = () => { clearTimeout(timer); run.controller.signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, pollIntervalMs);
        run.controller.signal.addEventListener("abort", finish, { once: true });
        if (run.controller.signal.aborted) finish();
      });
    }
    if (item.cancelRequested && item.status === "waiting_auto") await update(item, "cancelled", "已停止，未确认换绑");
  }
  async function verify(item, code, version, run) {
    await serialize(async () => {
      if (!["waiting_auto", "waiting_manual"].includes(item.status) || version !== item.challengeVersion) throw error("验证码流程已变化，请重新输入");
      transition(item, "verifying", "正在校验验证码并确认换绑"); await persist();
    });
    try {
      await step(item, "verify", code, run.controller.signal);
      await serialize(async () => {
        item.confirmedAt = new Date(now()).toISOString();
        transition(item, "success", "邮箱换绑已确认；原授权和 MFA 资料未更新，新邮箱登录待恢复");
        await persist();
      });
    } catch (failure) {
      if (failure.rebindCode === "CODE_INVALID") { await journal.append(item, `[verify:rejected]\n${describeRebindError(failure)}`); await update(item, "waiting_manual", REBIND_ERRORS.CODE_INVALID); }
      else await fail(item, failure, "verify");
    }
  }
  function track(item, callback) {
    const run = { controller: new AbortController(), done: null };
    active.set(item.id, run);
    run.done = Promise.resolve().then(() => callback(run)).catch(async () => {
      // A save failure after verification cannot be downgraded to a definite failure.
      if (["verifying", "success", "uncertain"].includes(item.status)) { item.status = "uncertain"; item.message = REBIND_ERRORS.UNCERTAIN; }
      else { item.status = "interrupted"; item.message = "任务保存未完成，请重试恢复"; }
      await serialize(persist).catch(() => {});
    }).finally(async () => {
      if (item.cancelRequested && ["queued", "checking", "beginning", "waiting_auto", "waiting_manual"].includes(item.status)) {
        await update(item, "cancelled", "已停止，未确认换绑").catch(() => {});
      }
      active.delete(item.id); pump();
    });
    return run.done;
  }
  function pump() {
    if (stopping) return;
    for (const item of items.values()) {
      if (active.size >= concurrency) break;
      if (item.status === "queued" && !active.has(item.id)) track(item, (run) => begin(item, run));
    }
  }
  async function submit(id, body) {
    available(); const item = privateItem(id);
    if (!/^\d{6}$/.test(body.code || "")) throw error("请输入六位数字验证码", 400);
    if (body.version !== item.challengeVersion) throw error("验证码已重新发送，请输入最新验证码");
    await manual(id);
    if (active.size >= concurrency) throw error("正在执行其他请求，请稍后提交验证码");
    if (body.version !== item.challengeVersion) throw error("验证码已重新发送，请输入最新验证码");
    await track(item, (run) => verify(item, body.code, body.version, run));
    return publicItem(item);
  }
  async function manual(id) {
    available(); const item = privateItem(id);
    if (!["waiting_auto", "waiting_manual"].includes(item.status)) throw error("当前任务不在等待验证码阶段");
    await serialize(async () => {
      if (!["waiting_auto", "waiting_manual"].includes(item.status)) throw error("当前任务不在等待验证码阶段");
      item.mode = "manual"; transition(item, "waiting_manual", "等待手动验证码"); await persist();
    });
    const run = active.get(id); if (run) { run.controller.abort(); await run.done; }
    return publicItem(item);
  }
  async function retry(id, resend = false) {
    available(); const item = privateItem(id);
    if (!resend && item.retryAfter && now() < item.retryAfter) throw error(`安全冷却中，暂时不能重试；开放时间：${new Date(item.retryAfter).toLocaleString("zh-CN", { hour12: false })}`);
    if (resend) { if (now() < (item.nextSendAt || 0)) throw error("请等待重新发送倒计时结束"); await manual(id); }
    else if (!["failed", "cancelled", "interrupted"].includes(item.status)) throw error("该结果不能重新换绑，请先核对结果");
    if (active.has(id) || isAccountBusy(item.oldEmail)) throw error("账号正在执行其他任务");
    if ([...items.values()].some((other) => other.id !== id && (ACTIVE.has(other.status) || other.status === "success") && [other.oldEmail, other.newEmail].some((value) => [item.oldEmail, item.newEmail].includes(value)))) throw error("账号或新邮箱已被其他任务占用");
    await serialize(async () => { item.cancelRequested = false; transition(item, "queued", "等待按原映射重试"); await persist(); }); pump();
    return publicItem(item);
  }
  async function cancel(ids) {
    available(); let finishing = 0;
    await serialize(async () => {
      for (const item of selected(ids)) {
        if (item.status === "uncertain") continue;
        if (active.has(item.id)) { item.cancelRequested = true; finishing++; }
        else if (ACTIVE.has(item.status)) transition(item, "cancelled", "已停止，未确认换绑");
      }
      await persist();
    }); return { finishing };
  }
  function importRecords(ids) {
    available();
    return selected(ids).map((item) => {
      if (item.status !== "success" || !item.confirmedAt) throw error("只有确认换绑成功的记录才能同步");
      return { id: item.id, oldEmail: item.oldEmail, newEmail: item.newEmail, mailboxUrl: item.mailboxUrl, credentials: { ...accountSnapshot(item)?.credentials } };
    });
  }
  async function reconcile(id) {
    available(); const item = privateItem(id);
    if (item.status !== "uncertain") throw error("当前记录无需核对");
    const candidate = listSources().find((source) => source.email === item.newEmail);
    if (!candidate) throw error("请先使用新邮箱登录到账号授权页，再核对换绑结果");
    const snapshot = await resolveSource(candidate.id, item.newEmail);
    if (snapshot.session.accountId !== accountSnapshot(item)?.session?.accountId) throw error("新邮箱登录的账号 ID 与原账号不一致");
    await journal.append(item, `[reconcile] 使用新邮箱会话核对换绑结果 ${item.newEmail}`);
    let result;
    try { result = await runStep("inspect", { email: item.newEmail, session: snapshot.session, cookies: snapshot.cookies || [], proxyUrl: snapshot.credentials?.proxyUrl || "" }, undefined, (message) => journal.append(item, message)); }
    catch (failure) { await journal.append(item, `[reconcile:error]\n${describeRebindError(failure)}`); throw failure; }
    if (result.data.email !== item.newEmail) throw error("尚未确认新邮箱身份");
    await serialize(async () => { item.confirmedAt = new Date(now()).toISOString(); transition(item, "success", "已通过新邮箱会话核对换绑成功"); await persist(); });
    return publicItem(item);
  }
  async function shutdown() {
    stopping = true;
    if (initializationError) return;
    for (const run of active.values()) run.controller.abort();
    await Promise.allSettled([...active.values()].map((run) => run.done));
    await serialize(async () => { for (const item of items.values()) if (ACTIVE.has(item.status) && item.status !== "uncertain") transition(item, "interrupted", "服务已停止，可重试恢复原映射"); await persist(); });
    await journal.flush();
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    let stored;
    try { stored = vault.open(await fs.readFile(statePath, "utf8"), scope); } catch (failure) { if (failure.code !== "ENOENT") throw failure; }
    if (stored) {
      if (stored.version !== 1 || !Array.isArray(stored.items) || stored.items.length > 5000) throw error("换绑数据无效");
      concurrency = Number.isInteger(stored.concurrency) && stored.concurrency >= 1 && stored.concurrency <= 30 ? stored.concurrency : 1;
      for (const item of stored.items) {
        if (item.snapshot) { item.snapshotSealed = vault.seal(item.snapshot, `email-rebind-snapshot:${item.id}`); delete item.snapshot; }
        if (!/^[a-f0-9-]{36}$/.test(item.id) || !validEmail(item.oldEmail) || !validEmail(item.newEmail) || !STATES.has(item.status)) throw error("换绑数据无效");
        if (["verifying", "beginning"].includes(item.status)) transition(item, "uncertain", REBIND_ERRORS.UNCERTAIN);
        else if (ACTIVE.has(item.status) && item.status !== "uncertain") transition(item, "interrupted", "服务重启，保留原映射，请手动重试或核对");
        items.set(item.id, item);
      }
    }
    await persist();
  } catch { initializationError = "换绑工作区无法读取或保存，请检查本地存储"; }
  return { list, logs: (id, options) => journal.read(privateItem(id), options), preview: publicPreview, start, submit, manual, retry, cancel, reconcile, importRecords, isBusy, shutdown };
}
