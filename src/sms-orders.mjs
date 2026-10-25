import crypto from "node:crypto";
import { providerOrderLifecycle } from "./sms-order-lifecycle.mjs";

export const moneyAmount = value => /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(String(value ?? "")) ? String(value) : null;
export function moneyCurrency(value) {
  const code = String(value ?? "").toUpperCase();
  return ({ 840: "USD", 643: "RUB", 978: "EUR", 156: "CNY" })[code] || (/^[A-Z]{3}$/.test(code) ? code : null);
}

// Accept the legacy text response and an optional structured response from the same number API.
export function parseNumberOrder(text) {
  const legacy = /^ACCESS_NUMBER:([^:]+):(\+?\d+)$/.exec(text);
  if (legacy) return { requestId: legacy[1], number: legacy[2].startsWith("+") ? legacy[2] : `+${legacy[2]}` };
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!data?.activationId || !/^\+?\d+$/.test(String(data.phoneNumber))) return null;
  const amount = moneyAmount(data.activationCost);
  return { requestId: String(data.activationId), number: String(data.phoneNumber).startsWith("+") ? String(data.phoneNumber) : `+${data.phoneNumber}`,
    ...providerOrderLifecycle(data),
    ...(amount !== null ? { cost: { amount, currency: moneyCurrency(data.activationCurrency ?? data.currency), source: "order" } } : {}) };
}

export function hasPhoneAttempt(job) {
  return Boolean(job.phoneBindingStartedAt || job.phoneVerifiedAt || job.smsOrders?.length || job.smsOrderId || ["number_acquired", "submitted", "manual_submitted", "completed"].includes(job.smsStatus));
}

export function phoneVerificationStatus(job) {
  if (job.phoneVerifiedAt || job.smsOrders?.some(order => order.verifiedAt) || job.smsStatus === "completed") return "verified";
  if (hasPhoneAttempt(job)) {
    if (["phone", "phone_otp"].includes(job.status) || (job.phoneBindingRequested && !["canceled", "failed", "phone_skipped", "resume_available", "reauth_required"].includes(job.status))) return "processing";
    return job.status === "canceled" ? "canceled" : "failed";
  }
  return job.status === "completed" ? "not_required" : "not_started";
}

export function recordSmsOrder(job, order) {
  const existing = job.smsOrders?.find(item => item.providerId === job.smsProviderId && item.orderId === order.requestId);
  if (existing) return existing;
  const record = { id: crypto.randomUUID(), orderId: String(order.requestId), providerId: job.smsProviderId,
    providerName: job.smsProviderName, country: String(job.smsProviderConfig?.countryLabel || job.smsProviderConfig?.country || "").slice(0, 160),
    phone: String(order.number).replace(/.(?=.{4})/g, "*"), createdAt: new Date().toISOString(), endedAt: null,
    status: "acquired", verifiedAt: null, refundStatus: "unconfirmed",
    amount: moneyAmount(order.cost?.amount), currency: moneyCurrency(order.cost?.currency), amountSource: order.cost?.source === "order" ? "order" : null,
    quote: moneyAmount(job.smsProviderConfig?.quotedPrice || job.smsProviderConfig?.maxPrice), maxPrice: moneyAmount(job.smsProviderConfig?.maxPrice), quoteCurrency: moneyCurrency(job.smsProviderConfig?.currency) };
  (job.smsOrders ||= []).push(record);
  return record;
}

export function publicSmsSummary(job) {
  const orders = Array.isArray(job.smsOrders) ? job.smsOrders : [];
  const latest = [...orders].reverse().find(order => order.verifiedAt) || orders.at(-1);
  const totals = new Map();
  let unknown = 0;
  for (const order of orders) {
    if (!order.verifiedAt || order.status !== "completed" || !order.currency || moneyAmount(order.amount) === null) { unknown++; continue; }
    const [whole, decimals = ""] = order.amount.split(".");
    const units = BigInt(whole) * 100000000n + BigInt(decimals.padEnd(8, "0"));
    totals.set(order.currency, (totals.get(order.currency) || 0n) + units);
  }
  return { verificationStatus: phoneVerificationStatus(job), historyCount: orders.length, unknownCount: unknown,
    latest: latest ? { ...latest } : null,
    totals: [...totals].map(([currency, units]) => ({ currency, amount: `${units / 100000000n}.${String(units % 100000000n).padStart(8, "0")}`.replace(/\.?0+$/, "") })),
    orders: orders.map(order => ({ ...order })) };
}
