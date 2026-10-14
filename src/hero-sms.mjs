const DEFAULT_API_BASE = "https://hero-sms.com/stubs/handler_api.php";
const DEFAULT_TIMEOUT_MS = 12_000;

export class HeroSmsError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "HeroSmsError";
    this.code = options.code ?? null;
    this.terminal = Boolean(options.terminal);
  }
}

export function createHeroSmsClient(options = {}) {
  const apiKey = String(options.apiKey || "").trim();
  const apiBase = new URL(options.apiBase || DEFAULT_API_BASE);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!apiKey) return null;
  if (!/^https?:$/.test(apiBase.protocol)) throw new Error("Hero SMS API 地址必须使用 HTTP 或 HTTPS");

  async function request(action, params = {}) {
    const isOffers = action === "offers";
    const url = isOffers ? new URL("/api/v1/activations/offers/sms", apiBase) : new URL(apiBase);
    const headers = { accept: "text/plain,application/json" };
    if (isOffers) headers.authorization = `ApiKey ${apiKey}`;
    else {
      url.searchParams.set("api_key", apiKey);
      url.searchParams.set("action", action);
    }
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: controller.signal,
      });
      let text = (await response.text()).trim();
      if (!response.ok) {
        let body;
        try { body = JSON.parse(text); } catch {}
        if (body?.title) throw responseError(body.title, "Hero SMS 请求失败", apiKey);
        throw new HeroSmsError(`Hero SMS 返回 HTTP ${response.status}`, { terminal: response.status < 500 && ![408, 429].includes(response.status) });
      }
      if (!text) throw new HeroSmsError("Hero SMS 返回了空响应");
      if (text.startsWith('"')) {
        try { const parsed = JSON.parse(text); if (typeof parsed === "string") text = parsed; } catch {}
      }
      return text;
    } catch (error) {
      if (error?.name === "AbortError") throw new HeroSmsError("Hero SMS 请求超时");
      if (error instanceof HeroSmsError) {
        error.message = safeMessage(error.message, apiKey);
        if (typeof error.code === "string") error.code = safeMessage(error.code, apiKey);
        throw error;
      }
      throw new HeroSmsError(`Hero SMS 请求失败：${safeMessage(error?.message, apiKey)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function setStatus(activationId, status, expected) {
    const text = await request("setStatus", { id: activationId, status });
    if (text === expected) return true;
    throw responseError(text, "更新号码状态失败", apiKey);
  }

  return {
    async getNumber(service, country, maxPrice) {
      const text = await request("getNumber", { service, country, maxPrice, fixedPrice: "true" });
      const match = /^ACCESS_NUMBER:([^:]+):(\+?\d+)$/.exec(text);
      if (!match) throw responseError(text, "获取手机号失败", apiKey);
      const number = match[2].startsWith("+") ? match[2] : `+${match[2]}`;
      if (!/^\+[1-9]\d{6,14}$/.test(number)) {
        throw new HeroSmsError("Hero SMS 返回的手机号不是有效的国际格式", { terminal: true });
      }
      return { number, requestId: match[1] };
    },

    async getPriceOptions(service) {
      const [pricesText, countriesText] = await Promise.all([
        request("offers", { services: service }),
        request("getCountries"),
      ]);
      return normalizePriceOptions(
        parseJsonResponse(pricesText, "价格接口返回格式不正确", apiKey),
        parseJsonResponse(countriesText, "国家接口返回格式不正确", apiKey),
        service,
      );
    },

    async getSms(activationId) {
      const text = await request("getStatus", { id: activationId });
      if (text === "STATUS_WAIT_CODE" || text === "STATUS_WAIT_RESEND" || text.startsWith("STATUS_WAIT_RETRY:")) {
        return { status: "waiting" };
      }
      if (text === "STATUS_CANCEL") {
        throw new HeroSmsError("号码激活已被平台取消", { code: text, terminal: true });
      }
      if (text.startsWith("STATUS_OK:")) {
        const code = /(?:^|\D)(\d{6})(?!\d)/.exec(text.slice("STATUS_OK:".length))?.[1];
        if (!code) throw new HeroSmsError("Hero SMS 返回内容中没有找到独立的 6 位数字验证码", { terminal: true });
        return { status: "received", code };
      }
      throw responseError(text, "获取短信失败", apiKey);
    },

    complete: (activationId) => setStatus(activationId, 6, "ACCESS_ACTIVATION"),
    release: (activationId) => setStatus(activationId, 8, "ACCESS_CANCEL"),
  };
}

function normalizePriceOptions(offers, countries, service) {
  if (!offers?.data || typeof offers.data !== "object" || Array.isArray(offers.data)) {
    throw new HeroSmsError("价格接口返回格式不正确", { terminal: true });
  }
  if (!countries || typeof countries !== "object") {
    throw new HeroSmsError("国家接口返回格式不正确", { terminal: true });
  }
  const countryIndex = new Map(Object.entries(countries).map(([key, country]) => [String(country?.id ?? key), country]));
  const options = [];
  const countryOffers = offers.data[service] ?? {};
  if (!countryOffers || typeof countryOffers !== "object" || Array.isArray(countryOffers)) {
    throw new HeroSmsError("价格接口返回格式不正确", { terminal: true });
  }
  for (const [country, details] of Object.entries(countryOffers)) {
    if (!/^\d{1,5}$/.test(country)) continue;
    const info = countryIndex.get(country) || {};
    const tiers = details?.map && typeof details.map === "object" && !Array.isArray(details.map)
      ? Object.entries(details.map)
      : [[details?.prices?.default, details?.counts?.defaultPrice]];
    for (const [priceValue, countValue] of tiers) {
      const price = Number(priceValue);
      const count = Number(countValue);
      if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(count) || count <= 0) continue;
      options.push({ country, title: info.chn || info.eng || info.rus || `国家 ${country}`, iso: "", prefix: "", price, count });
    }
  }
  return options.sort((a, b) => a.price - b.price || b.count - a.count || a.country.localeCompare(b.country));
}

function parseJsonResponse(value, fallback, apiKey) {
  let data;
  try { data = JSON.parse(value); } catch { throw responseError(value, fallback, apiKey); }
  if (data?.title) throw responseError(data.title, fallback, apiKey);
  return data;
}

function responseError(value, fallback, apiKey) {
  let body;
  try { body = JSON.parse(value); } catch {}
  const code = safeMessage(body?.title || value, apiKey) || "UNKNOWN_ERROR";
  const descriptions = {
    BAD_KEY: "API Key 不正确",
    NO_KEY: "请填写 API Key",
    UNAUTHORIZED: "API Key 不正确",
    BAD_ACTION: "接口动作不正确",
    BAD_SERVICE: "服务代码不正确",
    WRONG_SERVICE: "服务代码不正确",
    WRONG_COUNTRY: "国家 ID 不正确",
    NO_NUMBERS: "当前国家和价格暂无可用号码，请重新查询价格",
    NO_BALANCE: "账户余额不足",
    PAYMENT_REQUIRED: "账户余额不足",
    NO_ACTIVATION: "激活订单不存在",
    ACTIVATION_NOT_FOUND: "激活订单不存在",
    ACTIVATION_NOT_ACTIVE: "订单已结束，无法继续收码",
    BAD_STATUS: "号码状态不正确",
    EARLY_CANCEL_DENIED: "当前订单暂时不允许取消，请在平台控制台检查订单",
    FREE_CANCELLATION_EXPIRED: "已超过可取消时间，请在平台控制台检查订单",
    OTP_RECEIVED: "订单已收到验证码，请在平台控制台检查订单",
    NEW_OTP_RECEIVED: "订单收到新的验证码，请在平台控制台确认结束",
    TOO_MANY_REQUESTS: "请求过于频繁，请稍后重试",
    WRONG_MAX_PRICE: "价格参数不正确，请重新查询价格",
    UNPROCESSABLE_ENTITY: "请求参数不正确，请检查 API Key、国家和价格",
    BANNED: "API Key 已被平台限制",
  };
  const terminal = /^(?:BAD_KEY|NO_KEY|UNAUTHORIZED|BAD_ACTION|BAD_SERVICE|WRONG_SERVICE|WRONG_COUNTRY|WRONG_MAX_PRICE|NO_BALANCE|PAYMENT_REQUIRED|NO_ACTIVATION|ACTIVATION_NOT_FOUND|ACTIVATION_NOT_ACTIVE|BAD_STATUS|BANNED|UNPROCESSABLE_ENTITY)/.test(code);
  return new HeroSmsError(`${fallback}：${descriptions[code] || code}`, { code, terminal });
}

function safeMessage(value, apiKey) {
  const text = String(value || "");
  return (apiKey ? text.replaceAll(apiKey, "[redacted]") : text).replace(/[\r\n]+/g, " ").trim().slice(0, 240);
}
