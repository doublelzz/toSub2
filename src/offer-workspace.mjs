import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OFFER_LABELS, OFFER_ERRORS, OFFER_STAGES, offerError, offerFailureMessage } from "./offer-checker.mjs";
import { fetchMailboxOtpCandidates, filterMailboxOtpCandidatesByRequestTime, validateMailApiUrl } from "./mail-otp.mjs";

const LIVE = new Set(["queued", "running", "waiting_input"]);
const RETRY = new Set(["failed", "interrupted", "cancelled"]);
const text = (value) => typeof value === "string" ? value.trim() : "";
const error = (message, status = 400, code = "") => Object.assign(new Error(message), { status, code });
const emailOf = (value) => text(value).toLowerCase();
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export const OFFER_ACCESS_MESSAGE = "优惠检测需要有效且可用余额至少为 1 的 CDK；检测不扣次数";
export function assertOfferAccess(canUse) { if (!canUse()) throw error(OFFER_ACCESS_MESSAGE, 403, "OFFER_BALANCE_REQUIRED"); }

export function parseOfferImport(raw, parseText) {
  if (typeof raw !== "string" || !raw.trim() || Buffer.byteLength(raw) > 900_000) throw error("请输入账号资料，内容不能超过 900 KB");
  let entries;
  if (/^[\s\uFEFF]*[\[{]/.test(raw)) {
    let data; try { data = JSON.parse(raw.replace(/^\uFEFF/, "")); } catch { throw error("JSON 格式错误"); }
    if (data?.type === "sub2api-data" && !Array.isArray(data.accounts)) throw error("授权 JSON 缺少账号列表");
    let rows = data?.type === "sub2api-data" ? data.accounts.map((account) => ({ type: "sub2api-data", version: 1, accounts: [account] }))
      : Array.isArray(data) ? data : Array.isArray(data?.accounts) ? data.accounts : [data];
    if (!rows.length || rows.length > 500) throw error("每批支持 1 至 500 个账号");
    entries = rows.map((row, index) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw error(`第 ${index + 1} 条账号格式错误`);
      const cred = row.credentials || row.input || row;
      const session = row.type === "chatgpt-session" || row.type === "sub2api-data" ? row : row.session || null;
      const email = emailOf(row.email || session?.accounts?.[0]?.credentials?.email || cred.email);
      const mailApiUrl = text(cred.mailApiUrl || cred.mail_api_url);
      const totpSecret = text(cred.totpSecret || cred.totp_secret || cred.totp);
      if (!validEmail(email) || mailApiUrl && !validateMailApiUrl(mailApiUrl) || totpSecret && !/^[A-Z2-7]{16,128}$/i.test(totpSecret)) throw error(`第 ${index + 1} 条邮箱或凭据格式错误`);
      return { email, credentials: { password: typeof cred.password === "string" ? cred.password : "", totpSecret,
        mailApiUrl, mailRequestBody: text(cred.mailRequestBody) }, session, original: typeof row.original === "string" ? row.original : JSON.stringify(row) };
    });
  } else {
    const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/).map(text).filter(Boolean);
    if (!lines.length || lines.length > 500) throw error("每批支持 1 至 500 个账号");
    entries = lines.map((line, index) => {
      let row; try { [row] = parseText(line); } catch { throw error(`第 ${index + 1} 行账号格式错误，请核对邮箱、密码、MFA 或取件信息`); }
      if (!row || !validEmail(row.email)) throw error(`第 ${index + 1} 行邮箱格式错误`);
      return { email: emailOf(row.email), credentials: { password: row.password || "", totpSecret: row.totpSecret || "",
        mailApiUrl: row.mailApiUrl || "", mailRequestBody: row.mailRequestBody || "" }, session: null, original: line };
    });
  }
  const unique = new Map(); for (const row of entries) if (!unique.has(row.email)) unique.set(row.email, row);
  return { entries: [...unique.values()], duplicateCount: entries.length - unique.size };
}

export async function createOfferWorkspace({ root, vault, parseText, resolveSource = async () => null, canUse = () => false,
  isAccountBusy = () => false, runAccount, requestSchedule = () => {}, normalizeProxy = text,
  pollMailbox = fetchMailboxOtpCandidates, mailRequest = () => ({}), now = Date.now }) {
  const directory = path.join(root, "offers"); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, "offers.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,status TEXT NOT NULL,options TEXT NOT NULL,request_key TEXT UNIQUE,digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES batches(id),position INTEGER NOT NULL,email TEXT NOT NULL,status TEXT NOT NULL,
      result TEXT,error_code TEXT NOT NULL DEFAULT '',prompt_kind TEXT NOT NULL DEFAULT '',prompt_id TEXT NOT NULL DEFAULT '',retries INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,secret TEXT NOT NULL,flags TEXT NOT NULL,history TEXT NOT NULL DEFAULT '[]',UNIQUE(batch_id,email));
    CREATE INDEX IF NOT EXISTS idx_offer_items_batch ON items(batch_id,position);
    CREATE INDEX IF NOT EXISTS idx_offer_items_status ON items(batch_id,status);`);
  db.exec("UPDATE batches SET status='interrupted' WHERE status IN ('running','paused'); UPDATE items SET status='interrupted',prompt_kind='',prompt_id='' WHERE status IN ('queued','running','waiting_input');");
  const active = new Map(); let closing = false;
  const stamp = () => new Date(now()).toISOString();
  const access = () => { if (closing) throw error("优惠检测工作区正在关闭", 503); assertOfferAccess(canUse); };
  const batch = (id) => { const row = db.prepare("SELECT * FROM batches WHERE id=?").get(text(id)); if (!row) throw error("检测批次不存在", 404); return row; };
  const item = (batchId, id) => { batch(batchId); const row = db.prepare("SELECT * FROM items WHERE batch_id=? AND id=?").get(batchId, text(id)); if (!row) throw error("检测账号不存在", 404); return row; };
  const secret = (row) => vault.open(row.secret, `item:${row.id}`);
  const saveSecret = (row, value) => db.prepare("UPDATE items SET secret=? WHERE id=?").run(vault.seal(value, `item:${row.id}`), row.id);
  function update(row, status, fields = {}) {
    const current = db.prepare("SELECT * FROM items WHERE id=?").get(row.id);
    const history = [...JSON.parse(current.history), { at: stamp(), status, code: fields.error_code || "", ...(Object.hasOwn(OFFER_STAGES, fields.error_stage) ? { stage: fields.error_stage } : {}) }].slice(-30);
    const allowed = ["result", "error_code", "prompt_kind", "prompt_id", "retries", "available_at"];
    const names = Object.keys(fields).filter((key) => allowed.includes(key));
    db.prepare(`UPDATE items SET status=?,updated_at=?,history=?${names.map((key) => `,${key}=?`).join("")} WHERE id=?`)
      .run(status, stamp(), JSON.stringify(history), ...names.map((key) => fields[key]), row.id);
  }
  function publicItem(row) {
    const history = JSON.parse(row.history); const stage = history.at(-1)?.code === row.error_code && Object.hasOwn(OFFER_STAGES, history.at(-1)?.stage) ? history.at(-1).stage : "";
    return { id: row.id, batchId: row.batch_id, email: row.email, status: row.status, result: row.result ? JSON.parse(row.result) : null,
      message: offerFailureMessage(row.error_code, stage), errorCode: row.error_code, errorStage: stage, errorStageLabel: OFFER_STAGES[stage] || "", promptKind: row.prompt_kind, promptId: row.prompt_id,
      retries: row.retries, updatedAt: row.updated_at, ...JSON.parse(row.flags), history };
  }
  function publicBatch(row) {
    const rows = db.prepare("SELECT status,CASE WHEN status='completed' THEN json_extract(result,'$.kind') END AS kind,COUNT(*) AS n FROM items WHERE batch_id=? GROUP BY status,kind").all(row.id);
    const counts = {}; const categories = {}; let total = 0;
    for (const value of rows) {
      counts[value.status] = (counts[value.status] || 0) + value.n; total += value.n;
      if (value.status === "completed" && value.kind) categories[value.kind] = (categories[value.kind] || 0) + value.n;
    }
    const offers = ["trial_1m", "half_1m", "half_2m", "half_3m", "other"].reduce((sum, key) => sum + (categories[key] || 0), 0);
    return { id: row.id, name: row.name, createdAt: row.created_at, status: row.status, total, counts, categories, offers,
      processed: (counts.completed || 0) + (counts.failed || 0), options: JSON.parse(row.options),
      hitRate: offers + (categories.none || 0) ? offers / (offers + (categories.none || 0)) : null };
  }
  function settle(batchId) {
    const row = batch(batchId);
    if (["paused", "interrupted"].includes(row.status)) return;
    const pending = db.prepare("SELECT COUNT(*) AS n FROM items WHERE batch_id=? AND status IN ('queued','running','waiting_input')").get(batchId).n;
    if (!pending) db.prepare("UPDATE batches SET status=? WHERE id=?").run(db.prepare("SELECT COUNT(*) AS n FROM items WHERE batch_id=? AND status='cancelled'").get(batchId).n ? "stopped" : "completed", batchId);
  }
  function preview(body) {
    access(); const parsed = parseOfferImport(body.text, parseText);
    return { count: parsed.entries.length, duplicateCount: parsed.duplicateCount,
      digest: crypto.createHash("sha256").update(JSON.stringify(parsed.entries)).digest("hex"),
      accounts: parsed.entries.map((row) => ({ email: row.email, hasPassword: Boolean(row.credentials.password), hasTotp: Boolean(row.credentials.totpSecret), hasMailbox: Boolean(row.credentials.mailApiUrl), hasSession: Boolean(row.session) })) };
  }
  async function start(body) {
    access(); const view = preview(body);
    if (body.digest !== view.digest) throw error("导入内容已变化，请重新预览", 409);
    const requestKey = text(body.requestKey);
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey)) throw error("缺少有效的批次请求标识");
    const previous = db.prepare("SELECT * FROM batches WHERE request_key=?").get(requestKey);
    if (previous) { if (previous.digest !== view.digest) throw error("同一请求标识不能用于不同账号资料", 409); return publicBatch(previous); }
    if (db.prepare("SELECT COUNT(*) AS n FROM batches WHERE status IN ('running','paused')").get().n) throw error("当前已有未结束批次，请先完成、继续或停止", 409);
    if (db.prepare("SELECT COUNT(*) AS n FROM batches").get().n >= 200) throw error("检测批次已达 200 批上限");
    const concurrency = Number(body.concurrency ?? 3); const maxRetries = Number(body.maxRetries ?? 1);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20 || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) throw error("并发必须为 1 至 20，额外重试必须为 0 至 3 的整数");
    const proxyUrl = normalizeProxy(body.proxyUrl || "");
    const parsed = parseOfferImport(body.text, parseText); const id = crypto.randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO batches VALUES(?,?,?,?,?,?,?)").run(id, text(body.name).slice(0, 80) || `优惠检测 ${stamp().slice(0, 16).replace("T", " ")}`, stamp(), "running", JSON.stringify({ concurrency, maxRetries, proxyConfigured: Boolean(proxyUrl) }), requestKey, view.digest);
      parsed.entries.forEach((entry, position) => {
        const itemId = crypto.randomUUID(); const payload = { ...entry, proxyUrl };
        db.prepare("INSERT INTO items(id,batch_id,position,email,status,updated_at,secret,flags) VALUES(?,?,?,?,?,?,?,?)")
          .run(itemId, id, position, entry.email, "queued", stamp(), vault.seal(payload, `item:${itemId}`), JSON.stringify(view.accounts[position]));
      });
      db.exec("COMMIT");
    } catch (failure) { db.exec("ROLLBACK"); throw failure; }
    requestSchedule(); return publicBatch(batch(id));
  }
  function where(batchId, filters = {}) {
    batch(batchId); const clauses = ["batch_id=?"]; const args = [batchId];
    if (filters.search) { clauses.push("instr(email,?)>0"); args.push(text(filters.search).toLowerCase()); }
    if (filters.status && filters.status !== "all") {
      if (![...LIVE, ...RETRY, "completed"].includes(filters.status)) throw error("检测状态筛选无效");
      clauses.push("status=?"); args.push(filters.status);
    }
    const kinds = Array.isArray(filters.kinds) ? filters.kinds : [];
    if (kinds.some((kind) => !Object.hasOwn(OFFER_LABELS, kind))) throw error("优惠类型筛选无效");
    if (kinds.length) { clauses.push(`status='completed' AND json_extract(result,'$.kind') IN (${kinds.map(() => "?").join(",")})`); args.push(...kinds); }
    for (const [key, comparison] of [["checkedAfter", ">="], ["checkedBefore", "<"]]) if (filters[key]) {
      if (!Number.isFinite(Date.parse(filters[key]))) throw error("检测时间筛选无效");
      clauses.push(`json_extract(result,'$.checkedAt') ${comparison} ?`); args.push(new Date(filters[key]).toISOString());
    }
    if (filters.ids !== undefined) {
      if (!Array.isArray(filters.ids) || !filters.ids.length || filters.ids.length > 500 || new Set(filters.ids).size !== filters.ids.length) throw error("请选择 1 至 500 个不重复账号");
      for (const id of filters.ids) item(batchId, id);
      clauses.push(`id IN (${filters.ids.map(() => "?").join(",")})`); args.push(...filters.ids);
    }
    return { sql: clauses.map((clause) => `(${clause})`).join(" AND "), args };
  }
  function query(batchId, filters = {}) {
    access(); const selection = where(batchId, filters); const total = db.prepare(`SELECT COUNT(*) AS n FROM items WHERE ${selection.sql}`).get(...selection.args).n;
    const pages = Math.max(1, Math.ceil(total / 20)); const requestedPage = Number(filters.page || 1);
    const page = Math.min(pages, Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
    return { batch: publicBatch(batch(batchId)), total, page, pages,
      items: db.prepare(`SELECT * FROM items WHERE ${selection.sql} ORDER BY position LIMIT 20 OFFSET ?`).all(...selection.args, (page - 1) * 20).map(publicItem),
      selection: db.prepare(`SELECT id FROM items WHERE ${selection.sql} ORDER BY position`).all(...selection.args).map((row) => row.id) };
  }
  function list() { access(); return { batches: db.prepare("SELECT * FROM batches ORDER BY created_at DESC,rowid DESC LIMIT 200").all().map(publicBatch) }; }
  function exportContent(batchId, body) {
    access(); const selection = where(batchId, body.ids ? { ids: body.ids } : body.filters || {});
    const rows = db.prepare(`SELECT * FROM items WHERE ${selection.sql} ORDER BY position`).all(...selection.args);
    if (!rows.length) throw error("没有符合条件的账号");
    const format = body.format || "accounts"; let content;
    if (format === "accounts") content = rows.map((row) => secret(row).original).join("\n");
    else if (format === "report") content = rows.map((row) => { const value = publicItem(row); return [value.email, value.result?.label || "未获得结论", value.status, value.result?.campaignId || "", value.result?.checkedAt || "", value.message].join("\t"); }).join("\n");
    else if (format === "json") content = JSON.stringify({ batch: publicBatch(batch(batchId)), accounts: rows.map((row) => { const value = secret(row); return { email: row.email, input: value.credentials, session: value.session, result: publicItem(row).result, status: row.status }; }) }, null, 2);
    else if (format === "csv") {
      const cell = (value) => `"${String(value || "").replace(/^[=+@-]/, "'$&").replace(/"/g, '""')}"`;
      content = [["邮箱", "优惠结果", "执行状态", "活动ID", "检测时间"], ...rows.map((row) => { const value = publicItem(row); return [row.email, value.result?.label, row.status, value.result?.campaignId, value.result?.checkedAt]; })].map((row) => row.map(cell).join(",")).join("\n");
    } else throw error("不支持的导出内容");
    return { content, count: rows.length, format, filename: `offers-${batchId.slice(0, 8)}-${format}.txt` };
  }
  async function recheck(batchId, body) {
    access(); const selection = where(batchId, body.ids ? { ids: body.ids } : body.filters || {});
    const rows = db.prepare(`SELECT * FROM items WHERE ${selection.sql} ORDER BY position`).all(...selection.args);
    const raw = JSON.stringify(rows.map((row) => { const value = secret(row); return { email: row.email, credentials: value.credentials, session: value.session, original: value.original }; }));
    const view = preview({ text: raw }); return start({ ...JSON.parse(batch(batchId).options), proxyUrl: rows.length ? secret(rows[0]).proxyUrl : "", ...body, text: raw, digest: view.digest });
  }
  function activeCount() { return [...active.values()].filter((run) => run.slot).length; }
  function isBusy(email) { return [...active.values()].some((run) => run.email === emailOf(email)); }
  function validRun(row, run) { return !closing && canUse() && !run.controller.signal.aborted && active.get(row.id) === run; }
  function inputValue(batchId, id, body) {
    access(); const row = item(batchId, id); const run = active.get(id);
    if (row.status !== "waiting_input" || !run || row.prompt_id !== body.promptId || run.answer) throw error("输入流程已变化，请刷新后再输入", 409);
    const value = typeof body.value === "string" ? body.value : "";
    if (row.prompt_kind === "password" ? !value || value.length > 256 || /[\r\n]/.test(value) : !/^\d{6}$/.test(value) && !(row.prompt_kind === "email" && value === "r")) throw error("请输入有效密码或六位验证码");
    run.answer = { id: body.promptId, value }; requestSchedule(); return { queued: true };
  }
  async function autoMail(row, run, prompt) {
    if (prompt.kind !== "email" || !run.payload.credentials.mailApiUrl || run.usedMail) return;
    const deadline = now() + 180_000;
    while (validRun(row, run) && now() < deadline && !run.answer && item(row.batch_id, row.id).prompt_id === prompt.id) {
      try {
        const candidates = filterMailboxOtpCandidatesByRequestTime(await pollMailbox(run.payload.credentials.mailApiUrl, { timeoutMs: 10_000,
          request: { ...mailRequest(), body: run.payload.credentials.mailRequestBody } }), run.requestedAt || run.startedAt)
          .filter((candidate) => !run.baseline.has(candidate.key) && (candidate.receivedAt || run.baselineKnown));
        const codes = [...new Set(candidates.map((candidate) => candidate.code))];
        if (codes.length > 1) return;
        if (codes.length === 1 && validRun(row, run) && item(row.batch_id, row.id).prompt_id === prompt.id && !run.answer) {
          run.usedMail = true; run.answer = { id: prompt.id, value: codes[0] }; requestSchedule(); return;
        }
      } catch { return; }
      await new Promise((resolve) => { const timer = setTimeout(finish, 2000); function finish() { clearTimeout(timer); run.controller.signal.removeEventListener("abort", finish); resolve(); } run.controller.signal.addEventListener("abort", finish, { once: true }); });
    }
  }
  function launch(row) {
    const run = { email: row.email, slot: true, controller: new AbortController(), startedAt: now(), requestedAt: null, baseline: new Set(), baselineKnown: false, answer: null };
    active.set(row.id, run); update(row, "running", { error_code: "", prompt_id: "", prompt_kind: "" });
    run.done = (async () => {
      const payload = secret(row); const source = await resolveSource(row.email);
      payload.session ||= source?.session || null;
      for (const key of ["password", "totpSecret", "mailApiUrl", "mailRequestBody"]) payload.credentials[key] ||= source?.credentials?.[key] || "";
      run.payload = payload;
      if (payload.credentials.mailApiUrl) {
        try { run.baseline = new Set((await pollMailbox(payload.credentials.mailApiUrl, { timeoutMs: 10_000, request: { ...mailRequest(), body: payload.credentials.mailRequestBody } })).map((candidate) => candidate.key)); run.baselineKnown = true; } catch {}
      }
      if (!validRun(row, run)) return;
      run.handle = runAccount({ email: row.email, session: payload.session, credentials: payload.credentials, proxyUrl: Object.hasOwn(payload, "proxyUrl") ? payload.proxyUrl : source?.credentials?.proxyUrl || "" }, {
        signal: run.controller.signal,
        onMailSent: (at) => { if (Number.isFinite(at)) run.requestedAt = at; },
        onSession: (session) => { if (validRun(row, run)) { payload.session = session; saveSecret(row, payload); } },
        onPrompt: (prompt) => {
          if (!validRun(row, run)) return;
          run.slot = false; update(row, "waiting_input", { prompt_kind: prompt.kind, prompt_id: prompt.id }); requestSchedule();
          void autoMail(row, run, prompt).catch(() => {});
        },
      });
      const result = await run.handle.done;
      if (validRun(row, run)) {
        if (!result || !Object.hasOwn(OFFER_LABELS, result.kind) || !Number.isFinite(Date.parse(result.checkedAt))) throw offerError("invalid_response");
        update(row, "completed", { result: JSON.stringify({ kind: result.kind, label: OFFER_LABELS[result.kind],
          campaignId: text(result.campaignId).slice(0, 160), planType: text(result.planType).slice(0, 32), checkedAt: result.checkedAt }), prompt_kind: "", prompt_id: "" });
      }
    })().catch((failure) => {
      if (!validRun(row, run)) return;
      const current = item(row.batch_id, row.id); const settings = JSON.parse(batch(row.batch_id).options);
      const code = Object.hasOwn(OFFER_ERRORS, failure.offerCode) ? failure.offerCode : "login_failed";
      const retrying = failure.retryable === true && current.retries < settings.maxRetries;
      update(row, retrying ? "queued" : "failed", { error_code: code, error_stage: failure.offerStage, prompt_kind: "", prompt_id: "", retries: current.retries + (retrying ? 1 : 0), available_at: retrying ? now() + 1000 * (current.retries + 1) : 0 });
    }).finally(() => {
      if (!closing && !canUse()) {
        const current = db.prepare("SELECT status FROM items WHERE id=?").get(row.id);
        if (current && LIVE.has(current.status)) update(row, "interrupted", { prompt_kind: "", prompt_id: "" });
        db.prepare("UPDATE batches SET status='paused' WHERE id=? AND status='running'").run(row.batch_id);
      }
      active.delete(row.id); if (!closing) { settle(row.batch_id); requestSchedule(); }
    });
  }
  function tick(slots = 20) {
    if (closing) return 0;
    if (!canUse()) {
      db.prepare("UPDATE batches SET status='paused' WHERE status='running'").run();
      for (const [id, run] of active) if (!run.controller.signal.aborted) { run.controller.abort(); update({ id }, "interrupted", { prompt_id: "", prompt_kind: "" }); }
      return 0;
    }
    let started = 0;
    for (const [id, run] of active) if (!run.slot && run.answer && started < slots) {
      const row = db.prepare("SELECT * FROM items WHERE id=?").get(id);
      const settings = JSON.parse(batch(row.batch_id).options);
      if (batch(row.batch_id).status !== "running" || activeCount() >= settings.concurrency) continue;
      const answer = run.answer; run.answer = null; run.slot = true;
      if (row.prompt_kind === "password") { run.payload.credentials.password = answer.value; saveSecret(row, run.payload); }
      update(row, "running", { prompt_kind: "", prompt_id: "" }); run.handle.reply(answer.id, answer.value); started++;
    }
    const rows = db.prepare("SELECT items.* FROM items JOIN batches ON batches.id=items.batch_id WHERE batches.status='running' AND items.status='queued' AND items.available_at<=? ORDER BY batches.created_at,position").all(now());
    for (const row of rows) {
      if (started >= slots) break;
      if (active.size >= 500 || activeCount() >= JSON.parse(batch(row.batch_id).options).concurrency || isAccountBusy(row.email) || isBusy(row.email)) continue;
      launch(row); started++;
    }
    return started;
  }
  async function stop(batchId, internal = false) {
    if (!internal) access(); batch(batchId);
    db.prepare("UPDATE batches SET status='stopped' WHERE id=?").run(batchId);
    const rows = db.prepare("SELECT * FROM items WHERE batch_id=? AND status IN ('queued','running','waiting_input')").all(batchId);
    const waits = [];
    for (const row of rows) { const run = active.get(row.id); if (run) { run.controller.abort(); waits.push(run.done); } update(row, "cancelled", { prompt_kind: "", prompt_id: "" }); }
    await Promise.allSettled(waits); requestSchedule(); return publicBatch(batch(batchId));
  }
  async function retry(batchId, body = {}) {
    access(); const current = batch(batchId);
    if (active.size || db.prepare("SELECT COUNT(*) AS n FROM batches WHERE status='running' AND id<>?").get(batchId).n) throw error("当前已有检测任务运行，请稍后重试", 409);
    const rows = db.prepare("SELECT * FROM items WHERE batch_id=?").all(batchId).filter((row) => RETRY.has(row.status) || row.status === "queued");
    if (body.ids !== undefined) where(batchId, { ids: body.ids });
    const selected = body.ids ? rows.filter((row) => body.ids.includes(row.id)) : rows;
    if (!selected.length) throw error("没有需要重试的账号");
    const updateProxy = Object.hasOwn(body, "proxyUrl");
    if (updateProxy && typeof body.proxyUrl !== "string") throw error("请提供有效的代理地址，或留空直连");
    const proxyUrl = updateProxy ? normalizeProxy(body.proxyUrl) || "" : null;
    const changes = new Map();
    if (body.credentials && selected.length === 1) {
      const row = selected[0]; const payload = secret(row); const values = body.credentials;
      if (typeof values.password === "string") payload.credentials.password = values.password.slice(0, 256);
      if (values.totpSecret) { if (!/^[A-Z2-7]{16,128}$/i.test(values.totpSecret)) throw error("MFA 密钥格式错误"); payload.credentials.totpSecret = values.totpSecret; }
      if (values.mailApiUrl) { if (!validateMailApiUrl(values.mailApiUrl)) throw error("取件 URL 无效"); payload.credentials.mailApiUrl = values.mailApiUrl; }
      changes.set(row.id, payload);
    }
    if (updateProxy) for (const row of selected) { const payload = changes.get(row.id) || secret(row); payload.proxyUrl = proxyUrl; changes.set(row.id, payload); }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of selected) {
        if (changes.has(row.id)) saveSecret(row, changes.get(row.id));
        update(row, "queued", { error_code: "", prompt_kind: "", prompt_id: "", retries: 0, available_at: 0 });
      }
      const settings = JSON.parse(current.options);
      if (updateProxy && selected.length === db.prepare("SELECT COUNT(*) AS n FROM items WHERE batch_id=?").get(batchId).n) settings.proxyConfigured = Boolean(proxyUrl);
      db.prepare("UPDATE batches SET status='running',options=? WHERE id=?").run(JSON.stringify(settings), current.id);
      db.exec("COMMIT");
    } catch (failure) { db.exec("ROLLBACK"); throw failure; }
    requestSchedule(); return publicBatch(batch(batchId));
  }
  async function shutdown() {
    closing = true;
    for (const run of active.values()) run.controller.abort();
    await Promise.allSettled([...active.values()].map((run) => run.done));
    db.exec("UPDATE batches SET status='interrupted' WHERE status IN ('running','paused'); UPDATE items SET status='interrupted',prompt_kind='',prompt_id='' WHERE status IN ('queued','running','waiting_input');");
    db.close();
  }
  return { access: () => { access(); return { allowed: true, minimumBalance: 1, charge: 0 }; }, list, preview, start, query, exportContent, recheck, input: inputValue, stop, retry, tick, activeCount, isBusy, shutdown,
    async stopAll() { for (const row of db.prepare("SELECT id FROM batches WHERE status IN ('running','paused')").all()) await stop(row.id, true); } };
}
