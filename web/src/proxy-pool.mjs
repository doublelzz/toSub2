export const PROXY_POOL_STORAGE_KEY = "chatgpt-onboarding.account-proxy-pool-v1";
export const LEGACY_PROXY_STORAGE_KEY = "chatgpt-onboarding.account-proxy-v1";

export function proxyPoolText(value) {
  if (Array.isArray(value)) return value.join("\n");
  if (typeof value !== "string") return "";
  try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed.join("\n"); } catch {}
  return value;
}

export function parseProxyPoolText(value) {
  const proxies = []; const errors = [];
  for (const [index, raw] of String(value || "").split(/\r?\n/).entries()) {
    const proxy = raw.trim(); if (!proxy) continue;
    proxies.push(proxy);
    if (proxies.length > 500) { errors.push(`第 ${index + 1} 行超出上限，代理池最多填写 500 个代理`); continue; }
    try {
      if (proxy.length > 8192 || /[\t\r\n]/.test(proxy)) throw new Error();
      const url = new URL(proxy);
      if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) || !url.hostname) throw new Error();
    } catch { errors.push(`第 ${index + 1} 行代理格式错误，请填写完整的 http://、https://、socks5:// 或 socks5h:// 地址`); }
  }
  return { proxies, errors };
}

export function proxyNetworkPayload(mode, text) {
  if (mode === "keep") return {};
  if (mode === "workspace") return { useProxyPool: true };
  if (mode === "direct") return { proxyUrl: "" };
  const { proxies, errors } = parseProxyPoolText(text);
  if (errors.length) throw new Error(errors.join("；"));
  return { proxyPool: proxies };
}
