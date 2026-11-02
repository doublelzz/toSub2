import crypto from "node:crypto";
import { providerOrderLifecycle } from "./sms-order-lifecycle.mjs";

const DEFAULT_API_BASE = "https://tibosb.site/api/v1/";
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_ASSIGNMENT_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export class DaXiGuaSmsError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "DaXiGuaSmsError";
    this.code = options.code ?? null;
    this.status = options.status ?? null;
    this.terminal = Boolean(options.terminal);
    this.retryAfterMs = options.retryAfterMs ?? 0;
    this.order = options.order ?? null;
    this.idempotencyKey = options.idempotencyKey ?? null;
  }
}

export function createDaXiGuaSmsClient(options = {}) {
  const apiKey = String(options.apiKey || "").trim();
  const apiBase = normalizedBase(options.apiBase || DEFAULT_API_BASE);
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const assignmentTimeoutMs = options.assignmentTimeoutMs || DEFAULT_ASSIGNMENT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const now = options.now || Date.now;
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let pending = null;

  if (!apiKey) return null;
  if (!/^https?:$/.test(apiBase.protocol)) throw new Error("大西瓜接码 API 地址必须使用 HTTP 或 HTTPS");

  async function request(path, { method = "GET", body, idempotencyKey } = {}) {
    const url = new URL(String(path).replace(/^\/+/, ""), apiBase);
    const headers = { accept: "application/json", authorization: `Bearer ${apiKey}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        redirect: "error",
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = (await response.text()).trim();
      let payload;
      try { payload = text ? JSON.parse(text) : null; } catch {
        throw new DaXiGuaSmsError(`大西瓜接码返回 HTTP ${response.status}，但响应不是有效 JSON`, {
          status: response.status,
          terminal: response.status < 500 && ![408, 429].includes(response.status),
        });
      }
      if (!response.ok || payload?.success !== true) {
        throw responseError(payload, response.status, response.headers.get("retry-after"), apiKey);
      }
      if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
        throw new DaXiGuaSmsError("大西瓜接码返回的数据格式不正确", { terminal: true });
      }
      return payload.data;
    } catch (error) {
      if (error?.name === "AbortError") throw new DaXiGuaSmsError("大西瓜接码请求超时");
      if (error instanceof DaXiGuaSmsError) {
        error.message = safeMessage(error.message, apiKey);
        if (typeof error.code === "string") error.code = safeMessage(error.code, apiKey);
        throw error;
      }
      throw new DaXiGuaSmsError(`大西瓜接码请求失败：${safeMessage(error?.message, apiKey)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function createOrder(country, project) {
    if (!pending) pending = { country, project, idempotencyKey: `tosub2-${crypto.randomUUID()}`, order: null };
    if (pending.country !== country || pending.project !== project) {
      throw new DaXiGuaSmsError("上一笔大西瓜接码订单尚未确认，不能切换服务重复下单", {
        code: "ORDER_PENDING",
        order: pending.order,
        idempotencyKey: pending.idempotencyKey,
      });
    }
    if (pending.order) return pending.order;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        pending.order = normalizeOrder(await request("orders", {
          method: "POST",
          body: { country, project },
          idempotencyKey: pending.idempotencyKey,
        }));
        return pending.order;
      } catch (error) {
        lastError = error;
        if (error.terminal) { pending = null; throw error; }
        if (attempt < 3) await sleep(Math.max(100, Math.min(error.retryAfterMs || attempt * 250, 5_000)));
      }
    }
    lastError.idempotencyKey = pending.idempotencyKey;
    throw lastError;
  }

  async function waitForNumber(initial) {
    const deadline = now() + assignmentTimeoutMs;
    let current = initial;
    while (true) {
      if (["assigned", "received"].includes(current.status)) {
        const number = normalizePhone(current.phone_number);
        if (!number) throw orderError(current, "大西瓜接码返回的手机号不是有效的国际格式", "INVALID_PHONE", true);
        return { requestId: String(current.id), number, ...providerOrderLifecycle(current) };
      }
      if (current.status === "failed") throw orderError(current, current.failure_reason || "大西瓜接码取号失败，次数已退回", "NO_NUMBERS");
      if (current.status === "cancelled") throw orderError(current, "大西瓜接码订单已取消，次数已退回", "ORDER_CANCELLED");
      if (current.status === "review") throw orderError(current, current.failure_reason || "大西瓜接码订单待人工核查", "ORDER_REVIEW", true);
      if (current.status !== "creating") throw orderError(current, "大西瓜接码返回了未知订单状态", "UNKNOWN_ORDER_STATUS", true);
      if (now() >= deadline) {
        throw orderError(current, "大西瓜接码订单仍在取号，请稍后继续查询，勿重复创建订单", "ORDER_PENDING");
      }
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
      try {
        current = normalizeOrder(await request(`orders/${encodeURIComponent(String(current.id))}`));
      } catch (error) {
        error.order ||= { requestId: String(current.id), number: normalizePhone(current.phone_number) || "", ...providerOrderLifecycle(current) };
        throw error;
      }
      pending.order = current;
    }
  }

  async function orderStatus(orderId) {
    return normalizeOrder(await request(`orders/${encodeURIComponent(String(orderId))}`));
  }

  async function cancelStrict(orderId) {
    const order = normalizeOrder(await request(`orders/${encodeURIComponent(String(orderId))}/cancel`, { method: "POST" }));
    if (!["cancelled", "failed"].includes(order.status)) {
      throw orderError(order, "大西瓜接码未确认订单已取消", "CANCEL_NOT_CONFIRMED");
    }
    return { requestId: String(order.id), cancelled: true, receipt: order.status, refundStatus: "confirmed" };
  }

  return {
    async getServiceOptions() {
      const data = await request("services");
      if (!Array.isArray(data.services)) throw new DaXiGuaSmsError("大西瓜接码服务列表格式不正确", { terminal: true });
      return data.services.map(normalizeService).filter(Boolean).sort((left, right) => (
        left.uses - right.uses || left.title.localeCompare(right.title, "zh-CN") || left.serviceId.localeCompare(right.serviceId)
      ));
    },

    async getNumber(countryValue, projectValue) {
      const country = String(countryValue || "").trim();
      const project = String(projectValue || "").trim();
      if (!/^[a-zA-Z0-9_-]{1,16}$/.test(country) || !/^[a-zA-Z0-9_-]{1,80}$/.test(project)) {
        throw new DaXiGuaSmsError("请先查询并选择大西瓜接码服务", { code: "INVALID_SERVICE", terminal: true });
      }
      const order = await createOrder(country, project);
      try {
        const result = await waitForNumber(order);
        pending = null;
        return result;
      } catch (error) {
        if (["NO_NUMBERS", "ORDER_CANCELLED", "INVALID_PHONE"].includes(error.code)) pending = null;
        throw error;
      }
    },

    async getSms(orderId) {
      const order = await orderStatus(orderId);
      if (["creating", "assigned"].includes(order.status)) return { status: "waiting" };
      if (order.status === "received") {
        const code = /(?:^|\D)(\d{6})(?!\d)/.exec(String(order.sms_content || ""))?.[1];
        if (!code) throw orderError(order, "大西瓜接码短信中没有找到独立的 6 位数字验证码", "INVALID_SMS", true);
        return { status: "received", code };
      }
      if (order.status === "failed") throw orderError(order, order.failure_reason || "大西瓜接码订单失败，次数已退回", "ORDER_FAILED", true);
      if (order.status === "cancelled") throw orderError(order, "大西瓜接码订单已取消，次数已退回", "ORDER_CANCELLED", true);
      if (order.status === "review") throw orderError(order, order.failure_reason || "大西瓜接码订单待人工核查", "ORDER_REVIEW", true);
      throw orderError(order, "大西瓜接码返回了未知订单状态", "UNKNOWN_ORDER_STATUS", true);
    },

    async inspect(orderId) {
      const order = await orderStatus(orderId);
      if (["creating", "assigned"].includes(order.status)) return { state: "waiting", hasSms: false };
      if (order.status === "received") return { state: "received", hasSms: Boolean(String(order.sms_content || "").trim()) };
      if (["failed", "cancelled"].includes(order.status)) return { state: "cancelled", hasSms: false };
      return { state: "unknown", hasSms: false };
    },

    cancelStrict,
    cancelReceipt: cancelStrict,
    release: cancelStrict,
  };
}

function normalizedBase(value) {
  const base = new URL(value);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return base;
}

function normalizeService(value) {
  const serviceId = String(value?.id ?? "").trim();
  const name = String(value?.name || "").trim();
  const country = String(value?.country || "").trim();
  const project = String(value?.project || "").trim();
  const uses = Number(value?.uses);
  if (!/^\d{1,20}$/.test(serviceId) || !name || !/^[a-zA-Z0-9_-]{1,16}$/.test(country)
    || !/^[a-zA-Z0-9_-]{1,80}$/.test(project) || !Number.isSafeInteger(uses) || uses < 1) return null;
  return { serviceId, country, project, uses, title: name, label: `${name} / ${country}`, price: uses, count: 1, currency: "次" };
}

function normalizeOrder(value) {
  const id = String(value?.id ?? "").trim();
  const status = String(value?.status || "").trim().toLowerCase();
  if (!/^\d{1,30}$/.test(id) || !status) throw new DaXiGuaSmsError("大西瓜接码订单格式不正确", { terminal: true });
  return { ...value, id, status };
}

function normalizePhone(value) {
  const digits = String(value || "").trim();
  const number = digits.startsWith("+") ? digits : digits ? `+${digits}` : "";
  return /^\+[1-9]\d{6,14}$/.test(number) ? number : null;
}

function orderError(order, message, code, terminal = false) {
  return new DaXiGuaSmsError(message, {
    code,
    terminal,
    order: { requestId: String(order.id), number: normalizePhone(order.phone_number) || "", ...providerOrderLifecycle(order) },
  });
}

function responseError(payload, status, retryAfter, apiKey) {
  const code = safeMessage(String(payload?.error?.code || `HTTP_${status}`), apiKey).toLowerCase();
  const supplied = safeMessage(String(payload?.error?.message || "").trim(), apiKey);
  const descriptions = {
    unauthorized: "大西瓜接码 API Key 不正确或已失效",
    api_disabled: "大西瓜接码账户尚未开通 API 权限",
    invalid_service: "大西瓜接码服务参数不正确，请重新查询服务",
    invalid_idempotency_key: "大西瓜接码幂等键格式不正确",
    idempotency_conflict: "大西瓜接码幂等键与原订单服务冲突",
    insufficient_uses: "大西瓜接码可用次数不足",
    service_unavailable: "所选大西瓜接码服务当前不可用，请重新查询服务",
    order_not_found: "大西瓜接码订单不存在",
    order_rejected: "大西瓜接码拒绝创建订单",
    order_not_cancellable: "大西瓜接码订单当前不能取消",
    cancel_not_confirmed: "大西瓜接码尚未确认取消，请查询订单状态",
    rate_limited: "大西瓜接码请求过于频繁，请稍后重试",
  };
  const terminalCodes = new Set(["unauthorized", "api_disabled", "invalid_service", "invalid_idempotency_key", "idempotency_conflict", "insufficient_uses", "order_not_found", "order_rejected", "order_not_cancellable"]);
  const message = descriptions[code] || supplied || `大西瓜接码返回 HTTP ${status}`;
  const seconds = Number(retryAfter);
  return new DaXiGuaSmsError(supplied && descriptions[code] && supplied !== descriptions[code] ? `${message}：${supplied}` : message, {
    code: code.toUpperCase(),
    status,
    terminal: terminalCodes.has(code) || status >= 400 && status < 500 && ![408, 429].includes(status) && code !== "cancel_not_confirmed" && code !== "service_unavailable",
    retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 0,
  });
}

function safeMessage(value, apiKey) {
  const text = String(value || "");
  return apiKey ? text.split(apiKey).join("[redacted]") : text;
}
