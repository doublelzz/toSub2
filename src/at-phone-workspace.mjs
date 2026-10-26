import crypto from "node:crypto";

const ACTIVE = new Set(["queued", "identity_checking", "running", "waiting_sms", "verifying", "unknown"]);
const PUBLIC_STATES = new Set(["queued", "identity_checking", "running", "waiting_sms", "verifying", "success", "failed", "unknown", "skipped", "canceled"]);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function safeDate(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : null; }
function decodePayload(token) {
  const parts = String(token).split("."); if (parts.length < 2) return null;
  try { return JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64url").toString("utf8")); } catch { return null; }
}
function identityFromToken(token) {
  const claims = decodePayload(token); if (!claims || (claims.exp && Number(claims.exp) * 1000 <= Date.now())) return { email: null, accountId: null, valid: false };
  const profile = claims["https://api.openai.com/profile"] || {};
  const email = text(claims.email || profile.email).toLowerCase();
  const auth = claims["https://api.openai.com/auth"] || {};
  const accountId = text(auth.chatgpt_account_id);
  return { email: emailPattern.test(email) ? email : null, accountId: accountId || null, valid: Boolean(email && accountId) };
}
function maskEmail(email) { return email || "待识别邮箱"; }
function statusLabel(status) { return ({ queued: "排队中", identity_checking: "校验 AT", running: "接码中", waiting_sms: "等待短信", verifying: "验证中", success: "成功", failed: "失败", unknown: "待核实", skipped: "无需接码", canceled: "已取消" })[status] || "状态未知"; }
function publicStatus(status) { return ACTIVE.has(status) && status !== "unknown" ? "running" : status; }

export function createAtPhoneWorkspace({ store, vault, ownerId, now = Date.now, feeProvider = null }) {
  const keyScope = (id) => `at-phone:${ownerId}:${id}`;
  const read = (row) => row ? ({ ...vault.open(row.payload, keyScope(row.id)), id: row.id, ownerId: row.owner_id, createdAt: row.created_at, updatedAt: row.updated_at }) : null;
  const write = (value) => {
    const current = now();
    store.updateAtPhoneTask(value.id, ownerId, vault.seal({ ...value, id: undefined, ownerId: undefined, createdAt: undefined, updatedAt: undefined }, keyScope(value.id)), current);
    return read(store.atPhoneTask(value.id, ownerId));
  };
  const publicRow = (value) => {
    const row = read(value); if (!row) return null;
    return { id: row.id, email: row.email || null, status: PUBLIC_STATES.has(row.status) ? publicStatus(row.status) : "failed", statusLabel: statusLabel(row.status), reference: row.reference, message: row.message || "", phone: row.phone ? String(row.phone).replace(/.(?=.{4})/g, "*") : null, createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(), verifiedAt: safeDate(row.verifiedAt), charged: Number(row.charged) || 0, reserved: Number(row.reserved) || 0, identityVerified: Boolean(row.identityVerified), attemptCount: Number(row.attemptCount) || 0 };
  };
  function createTask(token, reference, index) {
    const value = text(token).replace(/^Bearer\s+/i, "");
    if (!value || /\s/.test(value)) return { invalid: true, reason: "AT 格式包含空格" };
    const identity = identityFromToken(value);
    const id = crypto.randomUUID(); const created = now();
    const task = { id, ownerId, token: value, email: identity.email, accountId: identity.accountId, identityVerified: false, status: "queued", message: identity.valid ? "排队中，等待校验 AT" : "AT 无法识别账号身份", reference: reference || `导入行 #${String(index + 1).padStart(2, "0")}`, phone: null, charged: 0, reserved: 0, attemptCount: 0, verifiedAt: null };
    store.insertAtPhoneTask({ id, ownerId, payload: vault.seal(task, keyScope(id)), createdAt: created, updatedAt: created });
    return publicRow(store.atPhoneTask(id, ownerId));
  }
  function list(query = {}) {
    const rows = store.atPhoneTasks(ownerId).map(publicRow).filter(Boolean);
    const search = text(query.search).toLowerCase(); const status = text(query.status) || "all"; const dateField = query.dateField === "verifiedAt" ? "verifiedAt" : "createdAt";
    const start = safeDate(query.start || query.after); const end = safeDate(query.end || query.before);
    const todayStart = safeDate(query.todayStart); const todayEnd = safeDate(query.todayEnd);
    const filtered = rows.filter((row) => (!search || `${row.email || ""} ${row.reference}`.toLowerCase().includes(search)) && (status === "all" || row.status === status) && (!start || Date.parse(row[dateField] || "") >= Date.parse(start)) && (!end || Date.parse(row[dateField] || "") < Date.parse(end)));
    const page = Math.max(1, Number(query.page) || 1); const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20)); const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const todayRows = todayStart && todayEnd ? rows.filter((row) => Date.parse(row.createdAt) >= Date.parse(todayStart) && Date.parse(row.createdAt) < Date.parse(todayEnd)) : [];
    const todaySuccess = todayStart && todayEnd ? rows.filter((row) => row.status === "success" && row.verifiedAt && Date.parse(row.verifiedAt) >= Date.parse(todayStart) && Date.parse(row.verifiedAt) < Date.parse(todayEnd)) : [];
    return { items: filtered.slice((page - 1) * pageSize, page * pageSize), page, pageSize, pages, total: filtered.length, counts: Object.fromEntries([...PUBLIC_STATES].map((key) => [key, rows.filter((row) => row.status === key).length])), today: { created: todayRows.length, success: todaySuccess.length, charged: todaySuccess.reduce((sum, row) => sum + (Number(row.charged) || 0), 0) } };
  }
  function importTokens(tokens, actor) {
    if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > 500) throw Object.assign(new Error("请提供 1 至 500 行 AT"), { status: 422 });
    const seen = new Set(); const items = []; const invalid = []; const existing = new Set(store.atPhoneTasks(ownerId).map((row) => { try { return crypto.createHash("sha256").update(String(vault.open(row.payload, keyScope(row.id)).token || "")).digest("hex"); } catch { return ""; } }).filter(Boolean));
    for (let index = 0; index < tokens.length; index += 1) {
      const value = text(tokens[index]).replace(/^Bearer\s+/i, ""); const fingerprint = value ? crypto.createHash("sha256").update(value).digest("hex") : "";
      if (!value || seen.has(fingerprint) || existing.has(fingerprint)) continue; seen.add(fingerprint);
      const result = createTask(value, `导入行 #${String(index + 1).padStart(2, "0")}`, index); if (result.invalid) invalid.push({ line: index + 1, reason: result.reason }); else items.push(result);
    }
    store.audit(actor || ownerId, "at-phone-import", ownerId, { count: items.length, invalid: invalid.length });
    return { items, count: items.length, invalid, fee: Number(feeProvider?.() || 0) };
  }
  function update(id, mutate, actor) {
    const current = read(store.atPhoneTask(id, ownerId)); if (!current) throw Object.assign(new Error("AT 接码任务不存在"), { status: 404 });
    const next = mutate({ ...current }); if (!next || !PUBLIC_STATES.has(next.status)) throw Object.assign(new Error("AT 接码状态无效"), { status: 422 });
    next.updatedAt = now(); write(next); store.audit(actor || ownerId, `at-phone-${next.status}`, `${ownerId}:${id}`, { email: next.email || null, charged: next.charged || 0 }); return publicRow(store.atPhoneTask(id, ownerId));
  }
  function retry(id, token, actor) { return update(id, (row) => { if (!["failed", "canceled"].includes(row.status)) throw Object.assign(new Error("只有失败或已取消任务可以重试"), { status: 409 }); const value = text(token).replace(/^Bearer\s+/i, ""); if (!value || /\s/.test(value)) throw Object.assign(new Error("AT 格式无效"), { status: 422 }); const identity = identityFromToken(value); return { ...row, token: value, email: identity.email, accountId: identity.accountId, identityVerified: false, status: "queued", message: identity.valid ? "已更新 AT，等待重新校验" : "AT 无法识别账号身份", charged: 0, reserved: 0, verifiedAt: null }; }, actor); }
  function cancel(id, actor) { return update(id, (row) => { if (!ACTIVE.has(row.status)) throw Object.assign(new Error("当前任务不能取消"), { status: 409 }); return { ...row, status: "canceled", reserved: 0, message: "已取消，未确认成功的预留已释放" }; }, actor); }
  function exportSuccess(query = {}) { const all = list({ ...query, page: 1, pageSize: 100000 }).items; return [...new Set(all.filter((row) => row.status === "success" && row.verifiedAt && row.email).map((row) => row.email))]; }
  return { list, importTokens, retry, cancel, exportSuccess, get: (id) => publicRow(store.atPhoneTask(id, ownerId)), update };
}
