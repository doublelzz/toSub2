import crypto from "node:crypto";
import { mergeSub2ApiCredentials } from "./sub2api-export.mjs";

const text = (value) => typeof value === "string" ? value.trim() : "";
const normalizeEmail = (value) => text(value).toLowerCase();
const positiveId = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const emailPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const failure = (message, code = "SUB2API_LINK_CONFLICT") => Object.assign(new Error(message), { code });
const pushLocks = new Map();
const remoteVersions = new Map();

function emailsOf(account) {
  const direct = [...new Set([account?.credentials?.email, account?.extra?.email].map(normalizeEmail).filter(Boolean))];
  return direct.length ? direct : [normalizeEmail(text(account?.name).match(emailPattern)?.[0])].filter(Boolean);
}

function identityOf(account) {
  const credentials = account?.credentials || {};
  const claims = [];
  for (const token of [credentials.access_token, credentials.id_token]) {
    try { claims.push(JSON.parse(Buffer.from(text(token).split(".")[1], "base64url").toString("utf8"))["https://api.openai.com/auth"] || {}); } catch {}
  }
  const ids = [...new Set([credentials.chatgpt_account_id, ...claims.map((value) => value.chatgpt_account_id)].map(text).filter(Boolean).map((value) => value.toLowerCase()))];
  const users = [...new Set([credentials.chatgpt_user_id, ...claims.map((value) => value.chatgpt_user_id)].map(text).filter(Boolean))];
  return { accountId: ids.length === 1 ? ids[0] : "", userId: users.length === 1 ? users[0] : "", invalid: ids.length > 1 || users.length > 1 };
}

function assertTarget(account, record, ownerId, requireIdentity = true) {
  if (account?.platform !== "openai" || account?.type !== "oauth") throw failure("远端同邮箱账号不是 OpenAI OAuth 账号，已停止推送");
  const emails = emailsOf(account);
  if (!emails.length || emails.some((value) => value !== normalizeEmail(record.email))) throw failure("远端账号邮箱与本地账号不一致，已停止推送");
  if (account.extra?.tosub2_cdk_id && account.extra.tosub2_cdk_id !== ownerId) throw failure("远端账号已属于其他 CDK，无法关联或覆盖");
  if (!record.account) {
    if (requireIdentity) throw failure("本地账号尚无可核对的授权身份");
    return;
  }
  const local = identityOf(record.account), remote = identityOf(account);
  if (local.invalid || remote.invalid || !local.accountId || !remote.accountId || local.accountId !== remote.accountId || local.userId && remote.userId && local.userId !== remote.userId) {
    throw failure("远端同邮箱账号的授权身份不一致或缺失，请先核对关联");
  }
}

function unwrap(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw failure("Sub2API 返回的接口数据不完整，已停止推送以避免重复创建", "SUB2API_RESPONSE_INVALID");
  if (typeof payload.code === "number" && payload.code !== 0) throw failure(text(payload.message) || "Sub2API 拒绝请求", "SUB2API_REQUEST_FAILED");
  return payload.data && typeof payload.data === "object" ? payload.data : payload;
}

function publicAccount(account) {
  const names = new Map();
  for (const group of Array.isArray(account.groups) ? account.groups : []) {
    const id = positiveId(group?.id); if (id) names.set(id, text(group.name) || `分组 ${id}`);
  }
  for (const entry of Array.isArray(account.account_groups) ? account.account_groups : []) {
    const id = positiveId(entry?.group_id); if (id) names.set(id, text(entry.group?.name) || names.get(id) || `分组 ${id}`);
  }
  for (const value of Array.isArray(account.group_ids) ? account.group_ids : []) {
    const id = positiveId(value); if (id && !names.has(id)) names.set(id, `分组 ${id}`);
  }
  const activeIds = Array.isArray(account.group_ids) ? new Set(account.group_ids.map(positiveId).filter(Boolean)) : null;
  return { id: Number(account.id), platform: text(account.platform) || null, type: text(account.type) || null,
    status: text(account.status) || "unknown", schedulable: typeof account.schedulable === "boolean" ? account.schedulable : null,
    proxyId: positiveId(account.proxy_id), concurrency: Number.isSafeInteger(Number(account.concurrency)) ? Number(account.concurrency) : null,
    loadFactor: Number.isSafeInteger(Number(account.load_factor)) ? Number(account.load_factor) : null,
    priority: Number.isSafeInteger(Number(account.priority)) ? Number(account.priority) : null,
    groups: [...names].filter(([id]) => !activeIds || activeIds.has(id)).map(([id, name]) => ({ id, name })) };
}

function targetFingerprint(account) {
  return crypto.createHash("sha256").update(JSON.stringify({
    id: Number(account.id), platform: account.platform, type: account.type,
    emails: emailsOf(account).sort(), identity: identityOf(account),
    owner: text(account.extra?.tosub2_cdk_id),
    groups: publicAccount(account).groups.map((group) => group.id).sort((left, right) => left - right),
    status: account.status ?? null, schedulable: account.schedulable ?? null,
    proxyId: account.proxy_id ?? null, concurrency: account.concurrency ?? null,
    priority: account.priority ?? null, loadFactor: account.load_factor ?? null,
  })).digest("hex");
}

function indexSnapshot(snapshot, accounts) {
  snapshot.accounts = accounts;
  snapshot.byEmail = new Map();
  for (const account of accounts) {
    for (const email of emailsOf(account)) {
      if (!snapshot.byEmail.has(email)) snapshot.byEmail.set(email, []);
      snapshot.byEmail.get(email).push(account);
    }
  }
  return accounts;
}

function updateSnapshot(snapshot, account, version) {
  if (!snapshot.accounts) return;
  const previousIndex = snapshot.accounts.findIndex((row) => Number(row.id) === Number(account.id));
  const previous = snapshot.accounts[previousIndex];
  for (const email of previous ? emailsOf(previous) : []) {
    const rows = snapshot.byEmail.get(email)?.filter((row) => Number(row.id) !== Number(account.id)) || [];
    snapshot.byEmail.set(email, rows);
  }
  if (previousIndex >= 0) snapshot.accounts[previousIndex] = account;
  else snapshot.accounts.push(account);
  for (const email of emailsOf(account)) {
    if (!snapshot.byEmail.has(email)) snapshot.byEmail.set(email, []);
    snapshot.byEmail.get(email).push(account);
  }
  snapshot.version = version;
}

function assertExpectedTarget(expected, resolved, account = resolved.account, checkFingerprint = true) {
  const changed = () => failure("远端目标已变化，请重新预检", "SUB2API_PREVIEW_CHANGED");
  if (!expected || !["create", "update"].includes(expected.action)) throw failure("此账号未通过推送预检，请重新预检", "SUB2API_PREVIEW_BLOCKED");
  if (expected.action === "create") {
    if (resolved.kind !== "new") throw changed();
  } else if (!account || Number(account.id) !== Number(expected.remoteId) || checkFingerprint && targetFingerprint(account) !== expected.fingerprint) throw changed();
}

function safeMessage(error, config, record, remoteSecrets = []) {
  let message = text(error?.message) || "Sub2API 请求未完成，请稍后重试";
  for (const value of [config.adminApiKey, ...Object.values(record.account?.credentials || {}), ...remoteSecrets]) {
    if (typeof value === "string" && value.length > 8) message = message.split(value).join("[redacted]");
  }
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/((?:access_token|refresh_token|id_token|api[_ -]?key|authorization)["']?\s*[:=]\s*["']?)[^"',}\s]+/gi, "$1[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}\b/g, "[redacted]")
    .replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

function updatePayload(remote, account, config, ownerId) {
  const localCredentials = { ...account.credentials };
  if (!config.modelWhitelist?.length) delete localCredentials.model_mapping;
  const result = {
    credentials: mergeSub2ApiCredentials(remote.credentials || {}, localCredentials),
    extra: { ...(remote.extra || {}), ...(account.extra || {}), tosub2_cdk_id: ownerId },
  };
  if (config.groupIds?.length) result.group_ids = [...config.groupIds];
  if (positiveId(config.proxyId)) result.proxy_id = Number(config.proxyId);
  for (const [field, key] of [["concurrency", "concurrency"], ["loadFactor", "load_factor"], ["priority", "priority"]]) {
    if (config[field] !== null && config[field] !== undefined && config[field] !== "") result[key] = Number(config[field]);
  }
  return result;
}

/** The caller supplies CDK-scoped binding storage. inspect never writes bindings or remote accounts. */
export function createSub2ApiLinker({ request, ownerId, getBindings = () => [], bindRemote = () => {} }) {
  if (typeof request !== "function") throw new TypeError("Sub2API request is required");

  async function listRemoteAccounts(config) {
    const accounts = new Map();
    for (let page = 1; page <= 1000; page++) {
      // Official search only matches names; a renamed account still has to be detected by credentials.email.
      const query = new URLSearchParams({ page: String(page), page_size: "100", platform: "openai" });
      const data = unwrap(await request(config, `/api/v1/admin/accounts?${query}`));
      const items = Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : null;
      if (!items) throw failure("Sub2API 账号列表格式不正确，已停止推送以避免重复创建", "SUB2API_RESPONSE_INVALID");
      for (const account of items) {
        const id = positiveId(account?.id);
        if (!id) throw failure("Sub2API 账号列表缺少有效 ID，已停止推送", "SUB2API_RESPONSE_INVALID");
        if (accounts.has(id)) throw failure("Sub2API 分页出现重复记录，请重新读取后推送", "SUB2API_RESPONSE_INVALID");
        accounts.set(id, account);
      }
      const pages = Number(data.pages);
      if (Number.isSafeInteger(pages) && pages > 0 ? page >= pages : items.length < 100) {
        const total = Number(data.total);
        if (Number.isSafeInteger(total) && total >= 0 && accounts.size !== total) throw failure("Sub2API 分页返回数量不完整，已停止推送以避免重复创建", "SUB2API_RESPONSE_INVALID");
        return [...accounts.values()];
      }
    }
    throw failure("Sub2API 搜索分页超过限制，已停止推送以避免遗漏重复账号", "SUB2API_RESPONSE_INVALID");
  }

  async function getAccount(config, id) {
    try {
      const account = unwrap(await request(config, `/api/v1/admin/accounts/${id}`));
      if (positiveId(account.id) !== id) throw failure("Sub2API 账号详情缺少对应 ID", "SUB2API_RESPONSE_INVALID");
      return account;
    } catch (error) {
      if (error.remoteStatus === 404 || error.status === 404) return null;
      throw error;
    }
  }

  async function bindingIds(config, record) {
    return [...new Set((await getBindings(config, normalizeEmail(record.email)) || []).map((row) => positiveId(typeof row === "object" ? row.remoteId ?? row.remote_id ?? row.id : row)).filter(Boolean))];
  }

  async function resolve(config, record, requireIdentity = true, snapshot = {}, retry = 0) {
    const bindings = await bindingIds(config, record);
    if (bindings.length > 1) throw failure("本地已有多个远端关联，请选择确认的远端账号后再推送");
    if (bindings.length === 1) {
      const account = await getAccount(config, bindings[0]);
      if (!account) return { kind: "missing", account: null, remoteId: bindings[0] };
      assertTarget(account, record, ownerId, requireIdentity);
      return { kind: "linked", account };
    }
    const version = remoteVersions.get(config.baseUrl) || 0;
    if (!snapshot.promise || snapshot.version !== version) {
      snapshot.version = version;
      snapshot.promise = listRemoteAccounts(config).then((accounts) => indexSnapshot(snapshot, accounts));
    }
    await snapshot.promise;
    const candidates = snapshot.byEmail.get(normalizeEmail(record.email)) || [];
    if ((remoteVersions.get(config.baseUrl) || 0) !== snapshot.version) {
      if (retry >= 2) throw failure("远端账号正在被其他推送修改，请稍后重新核对", "SUB2API_REQUEST_FAILED");
      return resolve(config, record, requireIdentity, snapshot, retry + 1);
    }
    if (candidates.length > 1) throw failure("远端存在多个同邮箱账号，请先明确关联远端 ID；本次不会新增或覆盖");
    if (!candidates.length) return { kind: "new", account: null };
    assertTarget(candidates[0], record, ownerId, requireIdentity);
    return { kind: "candidate", account: candidates[0] };
  }

  async function inspect(config, records) {
    const items = [];
    for (const record of records) {
      const item = { id: record.id, email: normalizeEmail(record.email), accounts: [] };
      try {
        const bindings = await bindingIds(config, record);
        if (!bindings.length) {
          item.status = "unlinked"; item.message = "尚未关联，推送前预检将核对远端账号";
        } else {
          if (bindings.length > 1) throw failure("本地已有多个远端关联，请选择确认的远端账号后再推送");
          const account = await getAccount(config, bindings[0]);
          if (!account) { item.status = "missing"; item.message = "已关联的远端账号已不存在"; }
          else {
            assertTarget(account, record, ownerId, false);
            item.status = "linked"; item.message = "已关联"; item.accounts = [publicAccount(account)];
          }
        }
      } catch (error) {
        item.status = error.code === "SUB2API_LINK_CONFLICT" ? "conflict" : "error";
        item.message = safeMessage(error, config, record);
      }
      items.push(item);
    }
    return { configured: true, checkedAt: new Date().toISOString(), items };
  }

  async function preview(config, records) {
    const items = [], targets = [], snapshot = {};
    for (const record of records) {
      const item = { id: record.id, email: normalizeEmail(record.email), action: "blocked", groups: [] };
      let target = { action: "blocked" };
      try {
        if (!record.account || record.account.platform !== "openai" || record.account.type !== "oauth" || !identityOf(record.account).accountId || identityOf(record.account).invalid) throw failure("本地授权缺少可核对的 OpenAI 账号身份");
        const resolved = await resolve(config, record, true, snapshot);
        if (resolved.kind === "missing") throw failure(`已关联的远端账号 ${resolved.remoteId} 已不存在，请重新确认目标`);
        if (resolved.account) {
          const fresh = await getAccount(config, Number(resolved.account.id));
          if (!fresh) throw failure("远端账号已删除，请重新预检");
          assertTarget(fresh, record, ownerId);
          const info = publicAccount(fresh);
          item.action = "update"; item.remoteId = info.id; item.groups = info.groups;
          item.message = resolved.kind === "linked" ? "将更新已关联的远端账号" : "将关联并更新远端已有账号";
          target = { action: "update", remoteId: info.id, fingerprint: targetFingerprint(fresh) };
        } else {
          item.action = "create"; item.message = "远端不存在同邮箱账号，将新增并关联";
          target = { action: "create" };
        }
      } catch (error) { item.message = safeMessage(error, config, record); }
      items.push(item); targets.push(target);
    }
    return { configured: true, checkedAt: new Date().toISOString(), items, targets };
  }

  async function pushOne(config, record, snapshot, expected, requireExpected = false) {
    const result = { id: record.id, email: normalizeEmail(record.email), name: record.account?.name || record.email, success: false, action: "failed" };
    let changed = false;
    let writePending = false;
    const remoteSecrets = [];
    try {
      if (requireExpected && (!expected || !["create", "update"].includes(expected.action))) throw failure("此账号未通过推送预检，请重新预检", "SUB2API_PREVIEW_BLOCKED");
      if (!record.account || record.account.platform !== "openai" || record.account.type !== "oauth" || !identityOf(record.account).accountId || identityOf(record.account).invalid) throw failure("本地授权缺少可核对的 OpenAI 账号身份");
      let resolved;
      try { resolved = await resolve(config, record, true, snapshot); }
      catch (error) {
        if (requireExpected && error.code === "SUB2API_LINK_CONFLICT") throw failure("远端目标已变化，请重新预检", "SUB2API_PREVIEW_CHANGED");
        throw error;
      }
      if (requireExpected) assertExpectedTarget(expected, resolved, resolved.account, false);
      if (resolved.kind === "missing") throw failure(`已关联的远端账号 ${resolved.remoteId} 已不存在，请重新确认目标`);
      if (resolved.account) {
        remoteSecrets.push(...Object.values(resolved.account.credentials || {}));
        const remoteId = Number(resolved.account.id);
        const fresh = await getAccount(config, remoteId);
        if (!fresh) throw failure(requireExpected ? "远端目标已变化，请重新预检" : "远端账号在推送前已删除，本次不会新增");
        remoteSecrets.push(...Object.values(fresh.credentials || {}));
        if (requireExpected) assertExpectedTarget(expected, resolved, fresh);
        assertTarget(fresh, record, ownerId);
        const payload = updatePayload(fresh, record.account, config, ownerId);
        writePending = true;
        unwrap(await request(config, `/api/v1/admin/accounts/${remoteId}`, { method: "PUT", body: JSON.stringify(payload) }));
        writePending = false;
        changed = true;
        const version = (remoteVersions.get(config.baseUrl) || 0) + 1;
        remoteVersions.set(config.baseUrl, version);
        updateSnapshot(snapshot, { ...fresh, ...payload }, version);
        result.remoteId = remoteId;
        result.action = "updated";
        await bindRemote(config, remoteId, result.email);
        result.success = true;
        result.message = "已关联并更新远端已有账号";
        result.accounts = [publicAccount({ ...fresh, ...payload })];
        return result;
      }
      const account = { ...record.account, extra: { ...(record.account.extra || {}), tosub2_cdk_id: ownerId } };
      const idempotencyKey = `tosub2-create-${crypto.createHash("sha256").update(JSON.stringify([ownerId, config.baseUrl, config.adminApiKey, result.email, identityOf(account).accountId])).digest("hex")}`;
      writePending = true;
      const response = unwrap(await request(config, "/api/v1/admin/accounts/batch", { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ accounts: [account] }) }));
      writePending = false;
      remoteVersions.set(config.baseUrl, (remoteVersions.get(config.baseUrl) || 0) + 1);
      const row = Array.isArray(response.results) && response.results.length === 1 ? response.results[0] : null;
      const remoteId = positiveId(row?.id ?? row?.account_id ?? row?.accountId);
      if (row?.success === false) throw failure(text(row.error || row.message) || "Sub2API 拒绝创建账号", "SUB2API_REQUEST_FAILED");
      if (row?.success !== true || !remoteId) {
        result.success = null;
        result.action = "unknown";
        result.message = "Sub2API 未返回可确认的远端 ID；请查询远端结果，避免重复推送";
        return result;
      }
      changed = true;
      result.remoteId = remoteId;
      result.action = "created";
      updateSnapshot(snapshot, { ...account, id: remoteId }, remoteVersions.get(config.baseUrl) || 0);
      await bindRemote(config, remoteId, result.email);
      // Official v0.2.17 batch creation accepts load_factor but does not apply it.
      if (config.loadFactor !== null && config.loadFactor !== undefined && config.loadFactor !== "") {
        const fresh = await getAccount(config, remoteId);
        if (!fresh) throw failure("新建账号暂时无法读取，负载因子尚未核对");
        assertTarget(fresh, record, ownerId);
        unwrap(await request(config, `/api/v1/admin/accounts/${remoteId}`, { method: "PUT", body: JSON.stringify({ load_factor: Number(config.loadFactor) }) }));
      }
      result.success = true;
      result.message = "已创建并关联远端账号";
      result.accounts = [publicAccount({ ...account, id: remoteId })];
    } catch (error) {
      if (writePending) remoteVersions.set(config.baseUrl, (remoteVersions.get(config.baseUrl) || 0) + 1);
      const uncertain = changed || writePending && !error.remoteStatus && !["SUB2API_REQUEST_FAILED", "SUB2API_LINK_CONFLICT"].includes(error.code);
      result.success = uncertain ? null : false;
      if (uncertain) result.action = "unknown";
      result.message = `${changed ? "远端已写入，但关联或后续设置未完成：" : uncertain ? "推送结果待核实，请先刷新关联状态：" : ""}${safeMessage(error, config, record, remoteSecrets)}`;
    }
    return result;
  }

  async function serialized(config, record, snapshot, expected, requireExpected) {
    const key = crypto.createHash("sha256").update(JSON.stringify([config.baseUrl, normalizeEmail(record.email)])).digest("hex");
    const previous = pushLocks.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => pushOne(config, record, snapshot, expected, requireExpected));
    pushLocks.set(key, operation);
    try { return await operation; } finally { if (pushLocks.get(key) === operation) pushLocks.delete(key); }
  }

  async function push(config, records, { targets } = {}) {
    const results = [];
    const snapshot = {};
    const requireExpected = targets !== undefined;
    for (const [index, record] of records.entries()) results.push(await serialized(config, record, snapshot, targets?.[index], requireExpected));
    return {
      created: results.filter((row) => row.success === true && row.action === "created").length,
      updated: results.filter((row) => row.success === true && row.action === "updated").length,
      failed: results.filter((row) => row.success === false).length,
      unknown: results.filter((row) => row.success === null).length,
      results,
    };
  }

  return { inspect, preview, push };
}
