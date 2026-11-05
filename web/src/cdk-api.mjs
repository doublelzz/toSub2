import { LEGACY_PROXY_STORAGE_KEY, PROXY_POOL_STORAGE_KEY, parseProxyPoolText, proxyNetworkPayload, proxyPoolText } from "./proxy-pool.mjs";

const workspaceKeys = new Set([
  "chatgpt-onboarding.sms-provider-settings-v1", "chatgpt-onboarding.mail-request-settings-v1",
  "chatgpt-onboarding.sub2api-upload-settings-v1", "chatgpt-onboarding.account-proxy-v1",
  "chatgpt-onboarding.luban-api-key", "chatgpt-onboarding.luban-service-id",
  PROXY_POOL_STORAGE_KEY,
]);
let workspace = null;
let proxyPoolDraft = null;
let saveTimer;
const workspaceSaves = new Map();
let confirmationHandler = null;
const smsSettingsKey = "chatgpt-onboarding.sms-provider-settings-v1";
const legacySmsKeys = ["chatgpt-onboarding.luban-api-key", "chatgpt-onboarding.luban-service-id"];
const smsPermissions = (bootstrap) => Array.isArray(bootstrap.workspace?.allowedSmsProviders) ? [...bootstrap.workspace.allowedSmsProviders]
  : Array.isArray(bootstrap.features?.allowedSmsProviders) ? [...bootstrap.features.allowedSmsProviders] : null;
const parseSmsSettings = (value) => { try { const parsed = typeof value === "string" ? JSON.parse(value) : value; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; } };
function assertWorkspaceCurrent(current) {
  if (workspace !== current) throw new Error("工作区已变化，请在当前工作区重新操作");
}
function scheduleWorkspaceSave() {
  clearTimeout(saveTimer); const current = workspace;
  saveTimer = setTimeout(() => {
    if (workspace !== current) return;
    void flushWorkspaceSettings().catch((error) => {
      if (workspace === current) window.dispatchEvent(new CustomEvent("cdk-settings-error", { detail: error.message }));
    });
  }, 500);
}
function restrictSmsValues(values, allowed) {
  if (!allowed) return { ...values };
  const result = { ...values };
  if (Object.hasOwn(result, smsSettingsKey)) {
    const previous = parseSmsSettings(result[smsSettingsKey]);
    const value = { selectedProviderId: allowed.includes(previous.selectedProviderId) ? previous.selectedProviderId : "custom",
      configs: Object.fromEntries(Object.entries(previous.configs || {}).filter(([id]) => allowed.includes(id))) };
    result[smsSettingsKey] = typeof result[smsSettingsKey] === "string" ? JSON.stringify(value) : value;
  }
  if (!allowed.includes("luban")) for (const key of legacySmsKeys) delete result[key];
  return result;
}

export function setImportConfirmation(handler) { confirmationHandler = handler; }
export function requestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function hydrateWorkspaceSettings(bootstrap) {
  clearTimeout(saveTimer);
  proxyPoolDraft = null;
  const allowed = smsPermissions(bootstrap);
  workspace = { id: bootstrap.workspace.id, token: bootstrap.token, quota: `${bootstrap.workspace.balance}:${bootstrap.workspace.reserved || 0}`, values: restrictSmsValues(bootstrap.settings || {}, allowed), allowedSmsProviders: allowed, dirty: false, legacyValues: {} };
  if (bootstrap.account.role === "admin" && bootstrap.workspace.id === bootstrap.account.id && !Object.keys(workspace.values).length) {
    for (const key of workspaceKeys) {
      try {
        const value = window.localStorage.getItem(key);
        if (value !== null) {
          workspace.legacyValues[key] = value;
          if (key === "chatgpt-onboarding.sub2api-upload-settings-v1") {
            const settings = JSON.parse(value); settings.monitorEnabled = false; workspace.values[key] = JSON.stringify(settings);
          } else workspace.values[key] = value;
          workspace.dirty = true;
        }
      } catch {}
    }
  }
  if (!Object.hasOwn(workspace.values, PROXY_POOL_STORAGE_KEY) && Object.hasOwn(workspace.values, LEGACY_PROXY_STORAGE_KEY)) {
    const { proxies } = parseProxyPoolText(workspace.values[LEGACY_PROXY_STORAGE_KEY]);
    workspace.values[PROXY_POOL_STORAGE_KEY] = JSON.stringify(proxies); workspace.dirty = true;
  }
  if (workspace.dirty) scheduleWorkspaceSave();
}

export function refreshWorkspaceSmsPermissions(bootstrap) {
  if (!workspace || workspace.id !== bootstrap.workspace.id || workspace.token !== bootstrap.token) { hydrateWorkspaceSettings(bootstrap); return; }
  const allowed = smsPermissions(bootstrap);
  if (!allowed) return;
  const currentSms = parseSmsSettings(workspace.values[smsSettingsKey]);
  const serverSms = parseSmsSettings(bootstrap.settings?.[smsSettingsKey]);
  const source = { ...workspace.values };
  if (Object.hasOwn(source, smsSettingsKey) || Object.hasOwn(bootstrap.settings || {}, smsSettingsKey)) {
    const settings = { ...serverSms, ...currentSms, configs: { ...serverSms.configs, ...currentSms.configs } };
    source[smsSettingsKey] = JSON.stringify(settings);
  }
  if (allowed.includes("luban")) for (const key of legacySmsKeys) if (!Object.hasOwn(source, key) && Object.hasOwn(bootstrap.settings || {}, key)) source[key] = bootstrap.settings[key];
  workspace.allowedSmsProviders = allowed;
  workspace.values = restrictSmsValues(source, allowed);
}

export function clearWorkspaceSettings() { clearTimeout(saveTimer); workspace = null; proxyPoolDraft = null; }

export function readWorkspaceValue(key) {
  if (workspaceKeys.has(key)) return workspace?.values[key] ?? null;
  try { return window.localStorage.getItem(key); } catch { return null; }
}

export function writeWorkspaceValue(key, value) {
  if (!workspaceKeys.has(key)) { try { window.localStorage.setItem(key, value); } catch {} return; }
  if (!workspace || workspace.values[key] === value) return;
  workspace.values = restrictSmsValues({ ...workspace.values, [key]: value }, workspace.allowedSmsProviders); workspace.dirty = true;
  scheduleWorkspaceSave();
}

export function readWorkspaceProxyPoolText() {
  return proxyPoolDraft ?? proxyPoolText(readWorkspaceValue(PROXY_POOL_STORAGE_KEY) ?? readWorkspaceValue(LEGACY_PROXY_STORAGE_KEY));
}

export function setWorkspaceProxyPoolDraft(text) { proxyPoolDraft = String(text || ""); }

export async function prepareWorkspaceProxyPool(text) {
  const current = workspace;
  const { proxies, errors } = parseProxyPoolText(text);
  if (errors.length) throw new Error(errors.join("；"));
  setWorkspaceProxyPoolDraft(text);
  writeWorkspaceValue(PROXY_POOL_STORAGE_KEY, JSON.stringify(proxies));
  await flushWorkspaceSettings();
  assertWorkspaceCurrent(current);
  return { useProxyPool: true };
}

export async function prepareProxyNetworkOptions(mode, text) {
  const current = workspace;
  const payload = proxyNetworkPayload(mode, text);
  if (mode === "workspace") await prepareWorkspaceProxyPool(readWorkspaceProxyPoolText());
  assertWorkspaceCurrent(current);
  return payload;
}

export async function flushWorkspaceSettings() {
  clearTimeout(saveTimer);
  const current = workspace;
  if (!current) return;
  for (;;) {
    assertWorkspaceCurrent(current);
    const pending = workspaceSaves.get(current.id);
    if (pending) { await pending; assertWorkspaceCurrent(current); continue; }
    if (!current.dirty) return;
    clearTimeout(saveTimer);
    const values = restrictSmsValues(current.values, current.allowedSmsProviders);
    const saving = saveWorkspaceSnapshot(current, values);
    workspaceSaves.set(current.id, saving);
    try { await saving; }
    finally { if (workspaceSaves.get(current.id) === saving) workspaceSaves.delete(current.id); }
    assertWorkspaceCurrent(current);
  }
}

async function saveWorkspaceSnapshot(current, values) {
  const response = await fetch("/api/settings/workspace", { method: "PUT", headers: { "content-type": "application/json", "x-console-token": current.token }, body: JSON.stringify({ workspaceId: current.id, settings: values }) });
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || "配置保存失败，请重试"); }
  if (workspace === current && JSON.stringify(current.values) === JSON.stringify(values)) current.dirty = false;
  if (workspace === current) for (const [key, value] of Object.entries(current.legacyValues)) {
    try { if (window.localStorage.getItem(key) === value) window.localStorage.removeItem(key); } catch {}
    delete current.legacyValues[key];
  }
}

export async function cdkFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const method = String(options.method || "GET").toUpperCase();
  const mode = method === "POST" && ({ "/api/jobs": "single", "/api/jobs/batch": "authorization", "/api/mfa/import": "mfa", "/api/rebind/sync": "rebind" })[url];
  let requestOptions = options;
  if (mode) {
    let payload; try { payload = JSON.parse(options.body || "{}"); } catch { throw new Error("导入内容格式错误"); }
    const preview = await fetch("/api/imports/preview", { method: "POST", headers, body: JSON.stringify({ mode, payload }), signal: options.signal });
    const quote = await preview.json();
    if (!preview.ok) { handleSessionStatus(preview, quote); throw new Error(quote.error || "无法计算导入次数"); }
    if (!quote.canImport) throw new Error(`可用次数不足：新增 ${quote.added} 个账号需要 ${quote.charge} 次，当前可用 ${quote.balance} 次`);
    const phoneMode = payload.phoneBindingMode ?? (Object.hasOwn(payload, "phoneBindingEnabled") ? payload.phoneBindingEnabled ? "automatic" : "manual" : "automatic");
    if (["single", "authorization"].includes(mode) && phoneMode === "automatic" && payload.smsProvider?.id === "pool") {
      const categoryId = String(payload.smsProvider?.config?.categoryId || "").trim();
      if (!categoryId) throw new Error("请选择接码池分类，再确认导入");
      const response = await fetch(`/api/sms-pool?categoryId=${encodeURIComponent(categoryId)}`, { headers, signal: options.signal });
      const pool = await response.json();
      if (!response.ok) { handleSessionStatus(response, pool); throw new Error(pool.error || "无法读取接码池费用"); }
      if (pool.id !== categoryId || !pool.enabled || !pool.available) throw new Error("所选接码池分类已停用或暂时无法取号，请重新选择");
      if (!Number.isSafeInteger(pool.fee) || pool.fee < 1 || !Number.isSafeInteger(pool.feeVersion) || pool.feeVersion < 1 || !Number.isSafeInteger(quote.count) || quote.count < 1) throw new Error("接码池费用尚未确认，请刷新后重试");
      const admin = quote.balance === null;
      if (!admin && quote.balance < pool.fee) throw new Error(`接码池需要预留 ${pool.fee} 次，当前可用 ${quote.balance} 次`);
      const fee = admin ? 0 : pool.fee;
      quote.smsPool = { categoryId, categoryName: pool.name, feeVersion: pool.feeVersion, count: quote.count, fee, maximum: quote.count * fee, admin };
      payload.smsProvider = { id: "pool", config: { categoryId, quotedFee: pool.fee, feeVersion: pool.feeVersion } };
      requestOptions = { ...options, body: JSON.stringify(payload) };
    }
    if (!confirmationHandler) throw new Error("导入确认尚未准备好，请稍后重试");
    if (!await confirmationHandler(quote)) throw new Error("已取消导入，未消耗次数");
    if (!headers.has("idempotency-key")) headers.set("idempotency-key", requestId());
  }
  const response = await fetch(url, { ...requestOptions, headers });
  const quotaOwner = response.headers.get("x-cdk-id");
  const balance = response.headers.get("x-cdk-balance");
  const reserved = response.headers.get("x-cdk-reserved");
  let quotaNotified = false;
  if (workspace && quotaOwner === workspace.id && balance !== null && reserved !== null) {
    const quota = `${balance}:${reserved}`;
    if (quota !== workspace.quota) { workspace.quota = quota; quotaNotified = true; window.dispatchEvent(new Event("cdk-balance-changed")); }
  }
  if ([401, 403].includes(response.status)) handleSessionStatus(response, await response.clone().json().catch(() => ({})));
  if (mode && response.ok && !quotaNotified) window.dispatchEvent(new Event("cdk-balance-changed"));
  return response;
}

function handleSessionStatus(response, body) {
  if (body.code === "IP_BLOCKED") window.dispatchEvent(new CustomEvent("cdk-access-blocked", { detail: body }));
  else if (response.status === 401 || body.code === "CSRF_INVALID") window.dispatchEvent(new Event("cdk-session-refresh"));
}
