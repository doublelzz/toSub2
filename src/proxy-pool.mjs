import crypto from "node:crypto";

export const PROXY_POOL_SETTING_KEY = "chatgpt-onboarding.account-proxy-pool-v1";
export const LEGACY_PROXY_SETTING_KEY = "chatgpt-onboarding.account-proxy-v1";
export const MAX_PROXY_POOL_SIZE = 500;

function invalid(message) { return Object.assign(new Error(message), { status: 400, code: "INVALID_PROXY_CONFIG" }); }

export function normalizeProxyUrl(value) {
  if (value == null || value === "") return "";
  if (typeof value !== "string") throw invalid("代理地址必须是字符串");
  const text = value.trim();
  if (!text) return "";
  let parsed;
  try { parsed = new URL(text); } catch { throw invalid("账号代理必须是完整的 http://、https://、socks5:// 或 socks5h:// 地址"); }
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(parsed.protocol) || !parsed.hostname || /[\r\n\t]/.test(text)) {
    throw invalid("账号代理只支持 http、https、socks5 和 socks5h 协议，每行填写一个完整地址");
  }
  if (text.length > 8192) throw invalid("代理地址过长");
  return parsed.toString();
}

export function normalizeProxyPool(value) {
  if (value == null || value === "") return [];
  const lines = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : null;
  if (!lines) throw invalid("代理池必须是代理数组或每行一个代理的文本");
  if (lines.length > MAX_PROXY_POOL_SIZE * 2) throw invalid(`代理池最多填写 ${MAX_PROXY_POOL_SIZE} 条代理`);
  const proxies = [];
  for (const [index, line] of lines.entries()) {
    if (typeof line !== "string") throw invalid(`第 ${index + 1} 行代理必须是字符串`);
    if (!line.trim()) continue;
    try { proxies.push(normalizeProxyUrl(line)); }
    catch (error) { throw invalid(`第 ${index + 1} 行代理格式错误：${error.message}`); }
  }
  if (proxies.length > MAX_PROXY_POOL_SIZE) throw invalid(`代理池最多填写 ${MAX_PROXY_POOL_SIZE} 条代理`);
  return proxies;
}

export function workspaceProxyPool(settings = {}) {
  if (!Object.hasOwn(settings, PROXY_POOL_SETTING_KEY)) return normalizeProxyPool(settings[LEGACY_PROXY_SETTING_KEY]);
  let value = settings[PROXY_POOL_SETTING_KEY];
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try { value = JSON.parse(value); } catch { throw invalid("代理池配置格式错误，请重新保存"); }
  }
  return normalizeProxyPool(value);
}

export function normalizeProxySelection(body = {}) {
  const modes = [Object.hasOwn(body, "useProxyPool"), Object.hasOwn(body, "proxyPool"), Object.hasOwn(body, "proxyUrl")];
  if (modes.filter(Boolean).length > 1) throw invalid("请只指定一种代理方式");
  if (modes[0]) {
    if (body.useProxyPool !== true) throw invalid("工作区代理池选项必须为 true");
    return { mode: "workspace" };
  }
  if (modes[1]) return { mode: "pool", proxies: normalizeProxyPool(body.proxyPool) };
  if (modes[2]) return { mode: "fixed", proxyUrl: normalizeProxyUrl(body.proxyUrl) };
  return null;
}

// This allocator is owned by a single CDK workspace. Reads and writes are
// synchronous, so advancing the cursor completes before another task can take.
export function createProxyPool({ readPool = () => [], readState, writeState, fingerprint = (value) => crypto.createHash("sha256").update(value).digest("hex") } = {}) {
  let memory = {};
  const load = () => structuredClone((readState ? readState() : memory) || {});
  const save = (state) => { if (writeState) writeState(state); else memory = state; };
  const current = () => normalizeProxyPool(readPool());
  const revision = (pool) => fingerprint(JSON.stringify(pool));
  function take(value) {
    const pool = value === undefined ? current() : normalizeProxyPool(value);
    if (!pool.length) return "";
    const poolRevision = revision(pool);
    const isWorkspace = value === undefined || poolRevision === revision(current());
    const state = load();
    const key = isWorkspace ? "workspace" : `custom:${poolRevision}`;
    const record = state[key];
    const index = record?.revision === poolRevision && Number.isSafeInteger(record.nextIndex) && record.nextIndex >= 0 ? record.nextIndex % pool.length : 0;
    state[key] = { revision: poolRevision, nextIndex: (index + 1) % pool.length };
    // Bound custom pool history without exposing any proxy addresses in state.
    for (const stale of Object.keys(state).filter((entry) => entry !== "workspace" && entry !== key).slice(0, Math.max(0, Object.keys(state).length - 33))) delete state[stale];
    save(state);
    return pool[index];
  }
  return {
    current, take, normalizeSelection: normalizeProxySelection,
    resolve(selection) {
      if (!selection) return "";
      if (selection.mode === "workspace") return take();
      if (selection.mode === "pool") return take(selection.proxies);
      if (selection.mode === "fixed") return normalizeProxyUrl(selection.proxyUrl);
      throw invalid("未知的代理方式");
    },
    canRotate(selection) { return selection?.mode === "workspace" ? current().length > 1 : selection?.mode === "pool" && normalizeProxyPool(selection.proxies).length > 1; },
    reset() { const state = load(); delete state.workspace; save(state); },
  };
}
