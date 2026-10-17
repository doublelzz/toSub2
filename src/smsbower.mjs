import { parseNumberOrder } from "./sms-orders.mjs";
const DEFAULT_API_BASE = "https://smsbower.page/stubs/handler_api.php";
const DEFAULT_TIMEOUT_MS = 12_000;

export class SmsBowerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "SmsBowerError";
    this.code = options.code ?? null;
    this.terminal = Boolean(options.terminal);
  }
}

export function createSmsBowerClient(options = {}) {
  const apiKey = String(options.apiKey || "").trim();
  const apiBase = new URL(options.apiBase || DEFAULT_API_BASE);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!apiKey) return null;
  if (!/^https?:$/.test(apiBase.protocol)) throw new Error("SMSBower API 地址必须使用 HTTP 或 HTTPS");

  async function request(action, params = {}) {
    const url = new URL(apiBase);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("action", action);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "text/plain,application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      const text = (await response.text()).trim();
      if (!response.ok) throw new SmsBowerError(`接码平台返回 HTTP ${response.status}`, { terminal: response.status < 500 });
      if (!text) throw new SmsBowerError("接码平台返回了空响应");
      return text;
    } catch (error) {
      if (error?.name === "AbortError") throw new SmsBowerError("接码平台请求超时");
      if (error instanceof SmsBowerError) throw error;
      throw new SmsBowerError(`接码平台请求失败：${safeMessage(error?.message)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function setStatus(activationId, status) {
    const text = await request("setStatus", { id: activationId, status });
    if (["ACCESS_READY", "ACCESS_RETRY_GET", "ACCESS_ACTIVATION", "ACCESS_CANCEL"].includes(text)) return true;
    throw responseError(text, "更新号码状态失败");
  }

  return {
    async getNumber(service, country, maxPrice = "", providerIds = "") {
      const params = { service, country };
      if (maxPrice !== "") params.maxPrice = maxPrice;
      if (providerIds !== "") params.providerIds = providerIds;
      const text = await request("getNumber", params);
      const order = parseNumberOrder(text);
      if (!order) throw responseError(text, "获取手机号失败");
      return { ...order, number: normalizePhoneNumber(order.number) };
    },

    async getPriceOptions(service) {
      const [pricesText, countriesText, goldText] = await Promise.all([
        request("getPricesV3", { service }),
        request("getCountries"),
        request("getTopCountriesByService", { service }).catch(() => null),
      ]);
      let goldPrices = {};
      if (goldText) {
        try { goldPrices = parseJsonResponse(goldText, "Gold 分类返回格式不正确"); } catch {}
      }
      return normalizePriceOptions(
        parseJsonResponse(pricesText, "价格接口返回格式不正确"),
        parseJsonResponse(countriesText, "国家接口返回格式不正确"),
        service,
        goldPrices,
      );
    },

    async getSms(activationId) {
      const text = await request("getStatus", { id: activationId });
      if (text === "STATUS_WAIT_CODE" || text.startsWith("STATUS_WAIT_RETRY")) return { status: "waiting" };
      if (text === "STATUS_CANCEL") throw new SmsBowerError("号码激活已被平台取消", { code: text, terminal: true });
      if (text.startsWith("STATUS_OK:")) {
        const code = findSixDigitCode(text.slice("STATUS_OK:".length));
        if (!code) throw new SmsBowerError("接码平台返回内容中没有找到独立的 6 位数字验证码", { terminal: true });
        return { status: "received", code };
      }
      throw responseError(text, "获取短信失败");
    },

    markReady(activationId) {
      return setStatus(activationId, 1);
    },

    complete(activationId) {
      return setStatus(activationId, 6);
    },

    release(activationId) {
      return setStatus(activationId, 8);
    },
  };
}

function responseError(value, fallback) {
  const code = safeMessage(value) || "UNKNOWN_ERROR";
  const descriptions = {
    BAD_KEY: "API Key 不正确",
    BAD_ACTION: "接口动作不正确",
    BAD_SERVICE: "服务代码不正确",
    NO_NUMBERS: "当前国家和服务暂无可用号码",
    NO_BALANCE: "账户余额不足",
    NO_ACTIVATION: "激活订单不存在",
    BAD_STATUS: "号码状态不正确",
    EARLY_CANCEL_DENIED: "当前订单暂时不允许取消",
  };
  const terminal = /^(?:BAD_KEY|BAD_ACTION|BAD_SERVICE|NO_BALANCE|NO_ACTIVATION|BAD_STATUS|BANNED)/.test(code);
  return new SmsBowerError(`${fallback}：${descriptions[code] || code}`, { code, terminal });
}

function findSixDigitCode(value) {
  return /(?:^|\D)(\d{6})(?!\d)/.exec(String(value || ""))?.[1] || null;
}

function parseJsonResponse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    throw responseError(value, fallback);
  }
}

function normalizePriceOptions(pricesValue, countries, service, goldValue) {
  const prices = unwrapDataObject(pricesValue);
  if (!prices || typeof prices !== "object" || Array.isArray(prices)) {
    throw new SmsBowerError("价格接口返回格式不正确", { terminal: true });
  }
  const countryList = collectCountryRecords(countries);
  const countryIndex = new Map();
  countryList.forEach((country) => {
    const keys = [
      country.activate_org_code,
      country.id,
      country.slug,
      country.title,
      country.eng,
      country.chn,
      country.iso,
      country.__alias,
      ...Object.values(country.alternative_params || {}),
      ...String(country.alternative_title_locale || "").split("|"),
    ];
    keys.filter((key) => key !== undefined && key !== null && key !== "").forEach((key) => {
      countryIndex.set(normalizeCountryAlias(key), country);
    });
    const countryCode = String(country.activate_org_code ?? country.id ?? "");
    if (countryCode === "12") countryIndex.set("usa", country);
    if (countryCode === "187") countryIndex.set("usaphysical", country);
    if (countryCode === "16") countryIndex.set("england", country);
  });

  const goldProviders = new Set();
  const goldPrices = unwrapDataObject(goldValue);
  if (goldPrices && typeof goldPrices === "object" && !Array.isArray(goldPrices)) {
    Object.entries(goldPrices).forEach(([countryKey, partners]) => {
      if (!partners || typeof partners !== "object" || Array.isArray(partners)) return;
      const info = countryIndex.get(normalizeCountryAlias(countryKey));
      const country = String(info?.activate_org_code ?? info?.id ?? countryKey);
      Object.entries(partners).forEach(([key, details]) => {
        const providerId = String(details?.provider_id ?? key);
        if (/^\d{1,5}$/.test(country) && /^\d{1,12}$/.test(providerId)) goldProviders.add(`${country}|${providerId}`);
      });
    });
  }

  const options = new Map();
  Object.entries(prices).forEach(([countryKey, services]) => {
    const partners = services?.[service];
    if (!partners || typeof partners !== "object" || Array.isArray(partners)) return;
    const countryInfo = countryIndex.get(normalizeCountryAlias(countryKey)) || {};
    const country = String(countryInfo.activate_org_code ?? countryInfo.id ?? countryKey);
    if (!/^\d{1,5}$/.test(country)) return;
    Object.entries(partners).forEach(([providerKey, details]) => {
      const providerId = String(details?.provider_id ?? providerKey);
      const price = Number(details?.price ?? details?.cost);
      const count = Number(details?.count);
      if (!/^\d{1,12}$/.test(providerId)) return;
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(count) || count <= 0) return;

      const grade = goldProviders.has(`${country}|${providerId}`) ? "gold" : "unknown";
      const optionKey = `${country}|${price}|${grade}`;
      const existing = options.get(optionKey);
      if (existing) {
        if (existing.providerIds.split(",").includes(providerId)) return;
        existing.count += Math.floor(count);
        existing.providerIds += `,${providerId}`;
        return;
      }
      options.set(optionKey, {
        country,
        title: safeMessage(countryInfo.chn || countryInfo.title || countryInfo.eng || fallbackCountryName(country)),
        iso: /^[A-Z]{2}$/.test(String(countryInfo.iso || "").toUpperCase())
          ? String(countryInfo.iso).toUpperCase()
          : "",
        prefix: String(countryInfo.prefix || "").replace(/\D/g, "").slice(0, 4),
        price,
        count: Math.floor(count),
        providerIds: providerId,
        grade,
      });
    });
  });

  const result = [...options.values()].sort((left, right) => (
    left.price - right.price
    || right.count - left.count
    || left.title.localeCompare(right.title)
  ));
  if (!result.length) throw new SmsBowerError("当前服务没有可购买的号码", { terminal: true });
  return result;
}

function unwrapDataObject(value) {
  if (
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && value.data
    && typeof value.data === "object"
    && !Array.isArray(value.data)
  ) return value.data;
  return value;
}

function collectCountryRecords(value) {
  const records = [];
  const visit = (item, alias = "", depth = 0) => {
    if (!item || depth > 5) return;
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, String(index), depth + 1));
      return;
    }
    if (typeof item !== "object") return;
    if (item.id !== undefined && (item.chn || item.eng || item.title || item.iso)) {
      records.push({ ...item, __alias: alias });
      return;
    }
    Object.entries(item).forEach(([key, entry]) => visit(entry, key, depth + 1));
  };
  visit(value);
  return records;
}

function normalizeCountryAlias(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\p{L}]+/gu, "");
}

function fallbackCountryName(country) {
  return {
    7: "马来西亚",
    12: "美国（虚拟号码）",
    16: "英国",
    187: "美国",
    1001: "日本",
  }[country] || `国家 ${country}`;
}

function normalizePhoneNumber(value) {
  let phone = String(value || "").trim().replace(/[\s()-]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  else if (!phone.startsWith("+")) phone = `+${phone}`;
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) {
    throw new SmsBowerError("接码平台返回的手机号不是有效的国际格式", { terminal: true });
  }
  return phone;
}

function safeMessage(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, 240);
}
