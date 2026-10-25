import crypto from "node:crypto";
import { createSmsProvider } from "./sms-providers.mjs";
import { cdkError } from "./cdk-security.mjs";
import { moneyAmount, moneyCurrency } from "./sms-orders.mjs";
import { createSmsBuffer, DEFAULT_BUFFER_RULES } from "./sms-buffer.mjs";

const DEFAULT_RULES = { enabled: false, fee: 2, noStockThreshold: 3, cooldownMinutes: 10, maxAttempts: 10, maxConcurrent: 5 };
const PROVIDERS = new Set(["smsbower", "herosms"]);
const CLOSED = new Set(["verified", "released"]);
const text = (value) => typeof value === "string" ? value.trim() : "";
const clone = (value) => structuredClone(value);
const fail = (code, message, options = {}) => Object.assign(cdkError(options.status || 409, message, code), { terminal: true, ...options });
const initial = () => ({ version: 1, rules: { ...DEFAULT_RULES }, credentials: [], entries: [] });
const integer = (value, name, min, max) => {
  const number = Number(value); if (!Number.isSafeInteger(number) || number < min || number > max) throw cdkError(422, `${name}必须为 ${min} 至 ${max} 的整数`); return number;
};
const validId = (value) => /^[a-zA-Z0-9_-]{1,120}$/.test(value);

export function classifyPoolError(error) {
  const code = String(error?.code || "").toUpperCase();
  if (/^(NO_NUMBERS|NO_NUMBER|NO_STOCK)$/.test(code)) return "no_stock";
  if (/^(BAD_KEY|NO_KEY|UNAUTHORIZED|INVALID_API_KEY|BANNED)/.test(code)) return "auth_invalid";
  if (/^(NO_BALANCE|PAYMENT_REQUIRED|INSUFFICIENT_BALANCE)/.test(code)) return "balance_insufficient";
  if (/429|RATE_LIMIT|TOO_MANY/.test(code) || /HTTP\s+429/i.test(error?.message || "")) return "rate_limited";
  if (/^(BAD_ACTION|BAD_SERVICE|WRONG_SERVICE|WRONG_COUNTRY|WRONG_MAX_PRICE|UNPROCESSABLE_ENTITY|BAD_COUNTRY|BAD_PRICE|INVALID_PRICE)/.test(code)) return "config_invalid";
  // A purchase may have reached the provider even when its reply never reached us.
  return "order_unknown";
}

export function createSmsPool({ store, createProvider = createSmsProvider, providerOptions = {}, now = Date.now } = {}) {
  const running = new Map(); let closing = false;
  const config = () => store.smsPoolConfig() || initial();
  const mutate = (change, actor = "system", event = null) => store.mutateSmsPoolConfig((previous) => { const value = previous || initial(); change(value); return value; }, actor, event);
  const admin = (actor) => { if (store.get(actor)?.role !== "admin") throw cdkError(403, "需要管理员权限"); };
  const operation = (ownerId, operationId) => { const value = store.smsOperation(ownerId, operationId); if (!value) throw cdkError(404, "接码操作不存在"); return value; };
  const billing = (value) => ({ operationId: value.operationId, state: value.state, fee: value.fee, reserved: CLOSED.has(value.state) ? 0 : value.fee, maxAttempts: value.maxAttempts, settledAt: value.settledAt || null, reason: value.reason || "", attempts: value.attempts?.length || 0 });
  const usableEntry = (entry, value, at = now(), ignoreLease = false) => {
    const credential = value.credentials.find((row) => row.id === entry.credentialId);
    return entry.enabled && credential?.enabled && !credential.blockedReason && entry.state !== "disabled" && (ignoreLease || !entry.halfOpen && !entry.inFlight && !credential.inFlight)
      && (!entry.cooldownUntil || entry.cooldownUntil <= at) && (!credential.cooldownUntil || credential.cooldownUntil <= at);
  };
  let buffer;
  const summary = () => {
    const value = config(); const entries = value.entries.filter((entry) => usableEntry(entry, value, now(), true));
    const inventory = buffer?.publicStatus() || { ready: false, refilling: false };
    const available = value.rules.enabled && (inventory.ready || entries.length > 0);
    return { enabled: value.rules.enabled, available, fee: value.rules.fee, hasNumbers: inventory.ready, refilling: inventory.refilling,
      status: inventory.ready ? "ready" : inventory.refilling ? "fetching" : available ? "available_on_demand" : "unavailable", version: value.version };
  };
  const publicOperation = (value) => ({ ...billing(value), cdkId: value.ownerId, cdkLabel: store.get(value.ownerId)?.label || "", actorId: value.actorId || "recovery", jobId: value.jobId, email: value.email,
    runId: value.runId, createdAt: new Date(value.createdAt).toISOString(), updatedAt: new Date(value.updatedAt).toISOString(),
    entryId: value.allocation?.entryId || value.attempts?.at(-1)?.entryId || null, orderId: value.allocation?.order?.requestId || null,
    phone: value.allocation?.order?.number?.replace(/.(?=.{4})/g, "*") || null });
  const recentOperations = () => [...new Map([...store.pendingSmsOperations(), ...store.smsOperations()].map((row) => [`${row.ownerId}:${row.operationId}`, row])).values()];
  const operationsPage = (query = {}) => { const page = store.smsOperationPage(query); return { ...page, items: page.items.map(publicOperation) }; };
  const snapshot = () => {
    const value = config();
    return { rules: value.rules, version: value.version,
      credentials: value.credentials.map(({ apiKey, inFlight, ...row }) => ({ ...row, hasApiKey: Boolean(apiKey) })),
      entries: value.entries.map((entry) => { const { inFlight, halfOpen, lastSelected, ...publicEntry } = entry; return ({ ...publicEntry, providerId: value.credentials.find((row) => row.id === entry.credentialId)?.providerId,
        state: !entry.enabled ? "disabled" : !value.credentials.find((row) => row.id === entry.credentialId)?.enabled || value.credentials.find((row) => row.id === entry.credentialId)?.blockedReason ? "credential_error"
          : entry.halfOpen ? "probing" : Math.max(entry.cooldownUntil || 0, value.credentials.find((row) => row.id === entry.credentialId)?.cooldownUntil || 0) > now() ? "cooling" : entry.state === "disabled" ? "disabled" : "available",
        credentialCooldownUntil: value.credentials.find((row) => row.id === entry.credentialId)?.cooldownUntil || 0 }); }),
      operations: recentOperations().map(publicOperation), buffer: buffer?.snapshot() || { rules: { ...DEFAULT_BUFFER_RULES }, counts: {}, items: [] } };
  };

  // Recovery never repeats an interrupted purchase or a submitted verification.
  for (const pending of store.pendingSmsOperations()) {
    if (["requesting", "submitted"].includes(pending.state)) store.updateSmsOperation(pending.ownerId, pending.operationId, (value) => ({ ...value, state: "unknown", reason: "服务重启，接码结果待核实" }));
  }
  mutate((value) => { for (const entry of value.entries) { entry.halfOpen = null; entry.inFlight = null; } for (const credential of value.credentials) credential.inFlight = null; });

  function saveRules(body, actor) {
    admin(actor);
    const previous = config().rules;
    if (Object.hasOwn(body, "enabled") && typeof body.enabled !== "boolean") throw cdkError(422, "启用状态格式不正确");
    const rules = { enabled: body.enabled ?? previous.enabled,
      fee: integer(body.fee ?? previous.fee, "成功扣次", 1, 1_000_000),
      noStockThreshold: integer(body.noStockThreshold ?? previous.noStockThreshold, "连续无号阈值", 1, 100),
      cooldownMinutes: integer(body.cooldownMinutes ?? previous.cooldownMinutes, "冷却分钟数", 1, 1440),
      maxAttempts: integer(body.maxAttempts ?? previous.maxAttempts, "最大取号次数", 1, 20),
      maxConcurrent: integer(body.maxConcurrent ?? previous.maxConcurrent, "最大并发", 1, 20) };
    const bufferInput = { ...DEFAULT_BUFFER_RULES, ...previous.buffer, ...body.buffer };
    if (typeof bufferInput.enabled !== "boolean" || body.buffer !== undefined && (!body.buffer || typeof body.buffer !== "object" || Array.isArray(body.buffer))) throw cdkError(422, "号码缓冲配置不正确");
    rules.buffer = { enabled: bufferInput.enabled, target: integer(bufferInput.target, "缓冲目标", 1, 20), lowWater: integer(bufferInput.lowWater, "补货水位", 0, 19),
      perEntry: integer(bufferInput.perEntry, "每条目库存上限", 1, 20), refillConcurrency: integer(bufferInput.refillConcurrency, "补货并发", 1, 5),
      minRemainingSeconds: integer(bufferInput.minRemainingSeconds, "最少剩余秒数", 60, 1800), idleMinutes: integer(bufferInput.idleMinutes, "空闲停止分钟数", 1, 120),
      maxOutstanding: integer(bufferInput.maxOutstanding, "未结束订单上限", 1, 100), maxPerMinute: integer(bufferInput.maxPerMinute, "每分钟补货上限", 1, 60) };
    if (rules.buffer.lowWater >= rules.buffer.target || rules.buffer.perEntry > rules.buffer.target || rules.buffer.maxOutstanding < rules.buffer.target || rules.buffer.refillConcurrency > rules.buffer.maxOutstanding) throw cdkError(422, "补货水位需小于目标，条目上限不超过目标，未结束上限不得低于目标和补货并发");
    mutate((value) => { value.rules = rules; value.version++; }, actor, "sms-pool-rules"); return snapshot();
  }
  function saveCredential(body, actor) {
    admin(actor); const value = config(); const old = body.id ? value.credentials.find((row) => row.id === body.id) : null;
    if (body.id && !old) throw cdkError(404, "接码凭据不存在");
    const providerId = text(body.providerId || old?.providerId).toLowerCase();
    if (!PROVIDERS.has(providerId)) throw cdkError(422, "接码池目前支持 SMSBower 和 Hero SMS");
    const apiKey = text(body.apiKey) || old?.apiKey || "";
    if (!/^[a-zA-Z0-9._-]{8,256}$/.test(apiKey)) throw cdkError(422, "请输入有效的接码 API Key");
    const name = text(body.name || old?.name).slice(0, 80); if (!name) throw cdkError(422, "请填写凭据名称");
    if (Object.hasOwn(body, "enabled") && typeof body.enabled !== "boolean") throw cdkError(422, "启用状态格式不正确");
    if (old && old.providerId !== providerId && value.entries.some((entry) => entry.credentialId === old.id)) throw cdkError(409, "已有池条目的凭据不能更换服务商");
    if (Object.hasOwn(body, "resetCooldown") && typeof body.resetCooldown !== "boolean") throw cdkError(422, "恢复凭据状态格式不正确");
    const sameKey = value.credentials.filter((row) => row.providerId === providerId && row.apiKey === apiKey);
    const credential = { id: old?.id || crypto.randomUUID(), providerId, name, apiKey, enabled: body.enabled ?? old?.enabled ?? true,
      blockedReason: body.resetCooldown === true ? "" : sameKey.find((row) => row.blockedReason)?.blockedReason || "",
      cooldownUntil: body.resetCooldown === true ? 0 : Math.max(0, ...sameKey.map((row) => row.cooldownUntil || 0)),
      inFlight: sameKey.find((row) => row.inFlight)?.inFlight || null };
    mutate((state) => { const index = state.credentials.findIndex((row) => row.id === credential.id); if (index < 0) state.credentials.push(credential); else state.credentials[index] = credential; state.version++; }, actor, "sms-pool-credential");
    return snapshot();
  }
  async function credentialOptions(id, body, actor) {
    admin(actor); const credential = config().credentials.find((row) => row.id === id); if (!credential) throw cdkError(404, "接码凭据不存在");
    const service = text(body.service || "dr"); if (!/^[a-z0-9_]{1,32}$/.test(service)) throw cdkError(422, "服务代码格式不正确");
    const client = createProvider(credential.providerId, { apiKey: credential.apiKey, service, country: "0", maxPrice: "1", providerIds: "1" }, providerOptions);
    try { return { options: await client.listNumberOptions() }; }
    catch (error) { throw fail("SMS_POOL_OPTIONS_FAILED", "查询国家价格失败，请检查接码凭据或稍后重试", { status: 502 }); }
  }
  function saveEntry(body, actor, id = body.id, { dryRun = false } = {}) {
    admin(actor); const value = config(); const old = id ? value.entries.find((entry) => entry.id === id) : null;
    if (id && !old) throw cdkError(404, "接码池条目不存在");
    const merged = { ...old, ...body }; const credential = value.credentials.find((row) => row.id === merged.credentialId);
    if (!credential) throw cdkError(422, "请选择已配置的接码凭据");
    const country = String(merged.country ?? ""); const maxPrice = String(merged.maxPrice ?? ""); const providerIds = String(merged.providerIds || "");
    if (!/^\d{1,5}$/.test(country) || !/^\d+(?:\.\d{1,6})?$/.test(maxPrice) || Number(maxPrice) <= 0 || Number(maxPrice) > 10000) throw cdkError(422, "请选择有效国家和价格上限");
    if (credential.providerId === "smsbower" && !/^\d{1,12}(?:,\d{1,12}){0,99}$/.test(providerIds)) throw cdkError(422, "请选择 SMSBower 供应商档位");
    const service = text(merged.service || "dr"); if (!/^[a-z0-9_]{1,32}$/.test(service)) throw cdkError(422, "服务代码格式不正确");
    const grade = merged.grade ?? "unknown"; const gradeFilter = merged.gradeFilter ?? "all";
    if (!["gold", "unknown"].includes(grade) || !["all", "gold", "unknown"].includes(gradeFilter)) throw cdkError(422, "供应商档位筛选不正确");
    if (Object.hasOwn(body, "enabled") && typeof body.enabled !== "boolean") throw cdkError(422, "启用状态格式不正确");
    if (Object.hasOwn(body, "resetCooldown") && typeof body.resetCooldown !== "boolean") throw cdkError(422, "恢复状态格式不正确");
    const routingChanged = old && ["credentialId", "country", "maxPrice", "providerIds", "service"].some((key) => old[key] !== ({ credentialId: credential.id, country, maxPrice, providerIds, service })[key]);
    const resetHealth = !old || routingChanged || body.resetCooldown === true;
    const entry = { id: old?.id || crypto.randomUUID(), credentialId: credential.id, country, countryLabel: text(merged.countryLabel).slice(0, 160), maxPrice, providerIds, service,
      quotedPrice: moneyAmount(merged.quotedPrice), currency: moneyCurrency(merged.currency),
      grade, gradeFilter,
      priority: integer(merged.priority ?? 100, "优先级", 0, 10000), enabled: merged.enabled ?? true,
      state: resetHealth ? "active" : old.state, noStockCount: resetHealth ? 0 : old.noStockCount, cooldownUntil: resetHealth ? 0 : old.cooldownUntil,
      lastError: resetHealth ? "" : old.lastError, lastUsedAt: old?.lastUsedAt || 0, lastSelected: old?.lastSelected || 0,
      halfOpen: resetHealth ? null : old.halfOpen, inFlight: resetHealth ? null : old.inFlight };
    if (dryRun) return entry;
    mutate((state) => { const index = state.entries.findIndex((row) => row.id === entry.id); if (index < 0) state.entries.push(entry); else state.entries[index] = entry; state.version++; }, actor, "sms-pool-entry"); return snapshot();
  }
  function saveEntries(body, actor) {
    admin(actor); if (!Array.isArray(body.entries)) return saveEntry(body, actor);
    if (!body.entries.length || body.entries.length > 100) throw cdkError(422, "每次请选择 1 至 100 个报价条目");
    const entries = body.entries.map((row) => { if (!row || typeof row !== "object" || Array.isArray(row)) throw cdkError(422, "池条目格式不正确"); return saveEntry(row, actor, undefined, { dryRun: true }); });
    const route = (row) => JSON.stringify([row.credentialId, row.service, row.country, row.maxPrice, row.providerIds]);
    const routes = new Set(config().entries.map(route));
    for (const entry of entries) { if (routes.has(route(entry))) throw cdkError(409, "所选报价条目重复或已经加入池"); routes.add(route(entry)); }
    mutate((state) => { state.entries.push(...entries); state.version++; }, actor, "sms-pool-entries"); return snapshot();
  }
  const sameEntry = (entry, previous) => entry && ["credentialId", "country", "maxPrice", "providerIds", "service"].every((key) => entry[key] === previous[key]);
  function recordFailure(choice, kind, attemptId) {
    mutate((value) => {
      const entry = value.entries.find((row) => row.id === choice.entry.id); const credential = choice.credential;
      if (sameEntry(entry, choice.entry)) {
        if (entry.halfOpen === attemptId) entry.halfOpen = null;
        entry.lastError = kind;
        if (kind === "no_stock") { entry.noStockCount++; if (entry.noStockCount >= value.rules.noStockThreshold) entry.cooldownUntil = now() + value.rules.cooldownMinutes * 60000; }
        else if (kind === "config_invalid") entry.state = "disabled";
      }
      if (credential && ["auth_invalid", "balance_insufficient"].includes(kind)) {
        for (const row of value.credentials) if (row.providerId === credential.providerId && row.apiKey === credential.apiKey) row.blockedReason = kind;
      } else if (credential && kind === "rate_limited") {
        for (const row of value.credentials) if (row.providerId === credential.providerId && row.apiKey === credential.apiKey) row.cooldownUntil = now() + 60000;
      }
    });
  }
  function selectLease(excluded = new Set(), filter = () => true) {
    let choice; const attemptId = crypto.randomUUID();
    const candidateConfig = config();
    if (candidateConfig.entries.some((entry) => !excluded.has(entry.id) && filter(entry) && usableEntry(entry, candidateConfig))) mutate((value) => {
      const candidates = value.entries.filter((entry) => !excluded.has(entry.id) && filter(entry) && usableEntry(entry, value)).sort((a, b) => a.priority - b.priority || (a.lastSelected || 0) - (b.lastSelected || 0) || a.id.localeCompare(b.id));
      const entry = candidates[0]; if (!entry) return;
      const credential = value.credentials.find((row) => row.id === entry.credentialId);
      if (entry.cooldownUntil) entry.halfOpen = attemptId;
      entry.inFlight = attemptId; entry.lastUsedAt = now(); entry.lastSelected = value.selectionSequence = (value.selectionSequence || 0) + 1;
      for (const row of value.credentials) if (row.providerId === credential.providerId && row.apiKey === credential.apiKey) row.inFlight = attemptId;
      choice = { entry: clone(entry), credential: clone(credential), configVersion: value.version };
    });
    return choice ? { choice, attemptId } : null;
  }
  function releaseLease(choice, attemptId) {
    mutate((value) => { const entry = value.entries.find((row) => row.id === choice.entry.id); if (entry?.inFlight === attemptId) entry.inFlight = null; if (entry?.halfOpen === attemptId) entry.halfOpen = null;
      for (const credential of value.credentials) if (credential.inFlight === attemptId) credential.inFlight = null; });
  }
  function makeProviderConfig(choice, maxAttempts) {
    return { apiKey: choice.credential.apiKey, service: choice.entry.service, country: choice.entry.country, countryLabel: choice.entry.countryLabel,
      maxPrice: choice.entry.maxPrice, quotedPrice: choice.entry.quotedPrice, currency: choice.entry.currency,
      providerIds: choice.entry.providerIds, maxRotationAttempts: String(maxAttempts), rotationIntervalSeconds: "1" };
  }
  function recordSuccess(choice, attemptId) {
    mutate((value) => { const entry = value.entries.find((row) => row.id === choice.entry.id); if (sameEntry(entry, choice.entry)) { entry.noStockCount = 0; entry.cooldownUntil = 0; entry.lastError = ""; if (entry.halfOpen === attemptId) entry.halfOpen = null; } });
  }
  buffer = createSmsBuffer({ store, config, mutate, now, createProvider, providerOptions, selectLease, releaseLease, makeConfig: makeProviderConfig,
    recordFailure, recordSuccess, classifyError: classifyPoolError, foregroundBusy: () => running.size > 0 });
  async function acquire(ownerId, operationId) {
    if (closing) throw fail("SMS_POOL_DISABLED", "接码池正在停止，请稍后重试");
    const key = `${ownerId}:${operationId}`; if (running.has(key)) return running.get(key);
    const pending = (async () => {
      let current = operation(ownerId, operationId);
      if (current.state === "unknown" || current.state === "requesting" || current.state === "submitted") throw fail("SMS_POOL_UNKNOWN", "此前接码结果待核实，不能重复取号", { uncertain: true });
      if (CLOSED.has(current.state)) throw fail("SMS_POOL_CLOSED", "此接码操作已结束");
      if (current.allocation && !current.allocation.abandoned) return { ...clone(current.allocation), operationId, poolEntryId: current.allocation.entryId };
      if (store.get(ownerId)?.status !== "active") throw fail("SMS_POOL_DISABLED", "当前 CDK 已禁用");
      if (!config().rules.enabled) throw fail("SMS_POOL_DISABLED", "管理员接码池已关闭");
      buffer.signalDemand();
      if (config().rules.buffer?.enabled) { const stocked = await buffer.claim(ownerId, operationId); if (stocked) return stocked; }
      const tried = new Set(); const waitDeadline = Date.now() + Math.max(30000, current.maxAttempts * 15000);
      while (current.attempts.length < current.maxAttempts) {
        current = operation(ownerId, operationId);
        if (CLOSED.has(current.state)) throw fail("SMS_POOL_CLOSED", "此接码操作已结束");
        if (current.state === "unknown") throw fail("SMS_POOL_UNKNOWN", "此前接码结果待核实，不能重复取号", { uncertain: true });
        if (closing || store.get(ownerId)?.status !== "active" || !config().rules.enabled) break;
        const selected = selectLease(tried); const choice = selected?.choice; const attemptId = selected?.attemptId;
        if (!choice) {
          const value = config(); const awaitingLease = value.entries.some((entry) => !tried.has(entry.id) && usableEntry(entry, value, now(), true));
          if (awaitingLease && Date.now() < waitDeadline) { await new Promise((resolve) => setTimeout(resolve, 100)); continue; }
          break;
        }
        tried.add(choice.entry.id);
        const providerId = choice.credential.providerId;
        const providerConfig = makeProviderConfig(choice, current.maxAttempts);
        current = store.updateSmsOperation(ownerId, operationId, (value) => { value.state = "requesting"; value.attempts.push({ id: attemptId, entryId: choice.entry.id, credentialId: choice.credential.id, startedAt: now(), state: "requesting" }); return value; });
        let order; let providerRequested = false;
        try {
          const client = createProvider(providerId, providerConfig, providerOptions); providerRequested = true; order = await client.getNumber();
          if (!order || !text(String(order.requestId || "")) || !/^\+[1-9]\d{6,14}$/.test(order.number || "")) throw new Error("invalid order");
          if (order.cost?.amount != null && Number(order.cost.amount) > Number(providerConfig.maxPrice)) throw new Error("order price exceeded configured ceiling");
        } catch (error) {
          const kind = providerRequested ? classifyPoolError(error) : "config_invalid"; recordFailure(choice, kind, attemptId);
          current = store.updateSmsOperation(ownerId, operationId, (value) => { value.state = kind === "order_unknown" ? "unknown" : "reserved"; value.reason = kind;
            if (order?.requestId) value.allocation = { allocationId: attemptId, entryId: choice.entry.id, credentialId: choice.credential.id, providerId, config: providerConfig, order: clone(order), configVersion: choice.configVersion, abandoned: false, submitted: false };
            Object.assign(value.attempts.at(-1), { state: kind, endedAt: now() }); return value; });
          if (kind === "order_unknown") throw fail("SMS_POOL_UNKNOWN", "取号结果未确认，已保留预留次数，请由管理员核实", { uncertain: true });
          continue;
        } finally {
          releaseLease(choice, attemptId);
        }
        const allocation = { allocationId: attemptId, entryId: choice.entry.id, credentialId: choice.credential.id, providerId, config: providerConfig,
          order: clone(order), configVersion: choice.configVersion, abandoned: false, submitted: false };
        const allocated = store.allocateSmsOrder(ownerId, operationId, allocation, now());
        if (!allocated.allocation) { current = operation(ownerId, operationId); if (allocated.conflict === "operation_stopped") throw fail("SMS_POOL_CLOSED", "接码操作已停止"); continue; }
        recordSuccess(choice, attemptId);
        return { ...clone(allocation), operationId, poolEntryId: allocation.entryId };
      }
      store.settleSmsOperation(ownerId, operationId, { reason: "没有可获取的池号码" });
      throw fail(current.attempts.length >= current.maxAttempts ? "SMS_POOL_LIMIT" : "SMS_POOL_NO_NUMBERS", "接码池暂时无可用号码，本次未扣次数");
    })();
    running.set(key, pending); try { return await pending; } finally { running.delete(key); if (config().rules.buffer?.enabled) buffer.signalDemand(); }
  }
  const requireAllocation = (value, input) => {
    const allocation = value.allocation;
    if (!allocation || allocation.abandoned || input.allocationId && input.allocationId !== allocation.allocationId
      || input.orderId && String(input.orderId) !== String(allocation.order.requestId) || input.providerId && input.providerId !== allocation.providerId) throw fail("SMS_POOL_ORDER_MISMATCH", "接码订单与当前操作不一致");
    return allocation;
  };
  function forOwner(ownerId) {
    return {
      summary,
      begin(input) {
        if (closing) throw fail("SMS_POOL_DISABLED", "接码池正在停止，请稍后重试");
        if (!validId(input.operationId) || !validId(input.jobId) || !validId(input.runId || "")) throw cdkError(422, "接码操作标识不正确");
        const email = text(input.email).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw cdkError(422, "接码账号邮箱不正确");
        const previous = store.smsOperation(ownerId, input.operationId);
        if (previous) { if (previous.email !== email || previous.jobId !== input.jobId || previous.runId !== input.runId) throw cdkError(409, "接码操作标识对应任务不同"); return billing(previous); }
        const value = config(); if (!summary().available) throw fail("SMS_POOL_DISABLED", "接码池暂时不可用，请稍后重试");
        if (input.expectedFee !== undefined && input.expectedFee !== value.rules.fee) throw fail("SMS_POOL_FEE_CHANGED", "接码池收费已变更，请重新确认后开始");
        const actorId = input.actorId || ownerId; const actor = actorId === "recovery" ? null : store.get(actorId);
        if (actorId === ownerId && actor?.status !== "active") throw cdkError(403, "CDK 已失效或被禁用");
        if (actorId !== "recovery" && (!actor || actor.status !== "active" || actorId !== ownerId && actor.role !== "admin")) throw cdkError(403, "接码操作人无权访问当前 CDK");
        const prepared = store.prepareSmsOperation(ownerId, { operationId: input.operationId, jobId: input.jobId, runId: input.runId, email, actorId,
          fee: value.rules.fee, policyVersion: value.version, maxAttempts: value.rules.maxAttempts, maxConcurrent: value.rules.maxConcurrent });
        buffer.signalDemand(); return billing(prepared);
      },
      getNumber: (input) => acquire(ownerId, typeof input === "string" ? input : input.operationId),
      acquire: (operationId) => acquire(ownerId, operationId),
      abandon(input) {
        const value = operation(ownerId, input.operationId); if (CLOSED.has(value.state)) return billing(value);
        const allocation = requireAllocation(value, input);
        if ((value.state === "unknown" || allocation.submitted) && input.confirmedFailure !== true) throw fail("SMS_POOL_UNKNOWN", "验证码提交结果待核实，不能直接换号", { uncertain: true });
        if (allocation.inventoryId) store.inventoryOperationEnd(ownerId, input.operationId, false, now());
        return billing(store.updateSmsOperation(ownerId, input.operationId, (current) => { current.allocation.abandoned = true; current.state = "reserved"; return current; }));
      },
      noteSubmitted(input) {
        const value = operation(ownerId, input.operationId); if (CLOSED.has(value.state)) return billing(value); requireAllocation(value, input);
        return billing(store.updateSmsOperation(ownerId, input.operationId, (current) => { current.state = "submitted"; current.allocation.submitted = true; return current; }));
      },
      verified(input) {
        const value = operation(ownerId, input.operationId); const allocation = requireAllocation(value, input); const evidence = input.evidence;
        if (!evidence || evidence.version !== 1 || !(evidence.type === "phone_verified" || evidence.type === "phone_verification" && evidence.state === "verified") || evidence.operationId !== value.operationId || evidence.jobId !== value.jobId
          || evidence.runId !== value.runId || String(evidence.orderId) !== String(allocation.order.requestId) || evidence.providerId !== allocation.providerId
          || evidence.allocationId && evidence.allocationId !== allocation.allocationId
          || !validId(evidence.eventId || "") || !Number.isFinite(Date.parse(evidence.verifiedAt))) throw fail("SMS_POOL_EVIDENCE_INVALID", "手机验证成功凭据不完整");
        if (value.state === "released") throw fail("SMS_POOL_CLOSED", "此接码操作已释放，不能再次扣次");
        return billing(store.settleSmsOperation(ownerId, value.operationId, { success: true, evidence, actor: value.actorId || ownerId }));
      },
      release(input) {
        const value = operation(ownerId, input.operationId); if (CLOSED.has(value.state)) return billing(value);
        if (input.uncertain || ["requesting", "unknown", "submitted"].includes(value.state)) return billing(store.updateSmsOperation(ownerId, value.operationId, (current) => ({ ...current, state: "unknown", reason: "接码结果待核实，预留次数尚未扣除" })));
        return billing(store.settleSmsOperation(ownerId, value.operationId, { reason: text(input.reason).slice(0, 160) || "接码未成功" }));
      },
      recover(operationId) { const value = operation(ownerId, typeof operationId === "string" ? operationId : operationId.operationId); return { ...billing(value), jobId: value.jobId, runId: value.runId, allocation: clone(value.allocation) }; },
      reconcile(input) { return this.recover(input.operationId); },
    };
  }
  function reconcile(id, body, actor) {
    admin(actor); const candidates = recentOperations().filter((row) => row.operationId === id);
    const value = body.cdkId ? store.smsOperation(body.cdkId, id) : candidates[0];
    if (!value || candidates.length > 1 && !body.cdkId) throw cdkError(404, "请指定需要核实的接码操作与 CDK");
    const note = text(body.note); if (!note || note.length > 200) throw cdkError(422, "请填写核实依据，最多 200 字");
    if (!["verified", "release"].includes(body.action)) throw cdkError(422, "请选择确认成功或确认失败释放");
    if (CLOSED.has(value.state)) {
      if (value.state !== (body.action === "verified" ? "verified" : "released")) throw cdkError(409, "已结算的接码操作不能改写结果");
      return snapshot();
    }
    if (value.state !== "unknown" || running.has(`${value.ownerId}:${id}`)) throw cdkError(409, "只能核实已停止的结果待核实操作，请先结束当前请求");
    if (body.action === "verified" && !value.allocation) throw cdkError(409, "没有明确订单，不能确认手机验证成功");
    store.audit(actor, "sms-pool-reconcile", `${value.ownerId}:${id}`, { action: body.action, note });
    store.settleSmsOperation(value.ownerId, id, { success: body.action === "verified", evidence: { type: "admin_reconciliation", note, actor }, reason: note, actor }); return snapshot();
  }
  return { adminSnapshot: snapshot, publicSummary: summary, operationsPage, saveRules, saveCredential, credentialOptions, saveEntry, saveEntries,
    start: () => buffer.start(), pause: () => buffer.pause(), tick: () => buffer.tick(),
    warmup: async (actor) => { admin(actor); await buffer.warmup(); return snapshot(); },
    drain: async (actor) => { admin(actor); await buffer.drain(); return snapshot(); },
    reconcileInventory: (id, body, actor) => { admin(actor); buffer.reconcile(id, body, actor); return snapshot(); },
    close: async () => { closing = true; buffer.pause(); await Promise.allSettled([...running.values()]); await buffer.close(); },
    patchEntry: (id, body, actor) => saveEntry(body, actor, id), reconcile, forOwner };
}
