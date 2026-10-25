import { moneyAmount, moneyCurrency } from "./sms-orders.mjs";

const names = { smsbower: "SMSBower", herosms: "Hero SMS", luban: "LubanSMS", custom: "自定义接码" };
const amount = (value) => moneyAmount(value);
const money = (value, currency) => { const parsed = amount(value); return parsed === null ? null : { amount: parsed, currency: moneyCurrency(currency) }; };

export function poolCostOrder(source, { state = source.state || "", createdAt = source.createdAt || null, refundExpected = false } = {}) {
  const order = source.order || {}; const config = source.config || {};
  const actual = order.cost?.source === "order" ? money(order.cost.amount, order.cost.currency) : null;
  const cost = actual ? { ...actual, source: "order" } : null;
  return { orderId: order.requestId == null ? null : String(order.requestId), providerId: source.providerId || "", providerName: names[source.providerId] || source.providerId || "未知平台",
    countryLabel: String(config.countryLabel || config.country || "").slice(0, 160), phone: order.number ? String(order.number).replace(/.(?=.{4})/g, "*") : null,
    cost, quote: money(config.quotedPrice, config.currency), maxPrice: money(config.maxPrice, config.currency),
    refundStatus: source.refundStatus === "confirmed" && source.refundEvidence ? "confirmed" : "unconfirmed", refundExpected: Boolean(refundExpected),
    feeStatus: !cost ? "unknown_cost" : !cost.currency ? "unknown_currency" : "confirmed_purchase", state, createdAt };
}

const units = (value) => { const [whole, decimals = ""] = value.split("."); return BigInt(whole) * 100000000n + BigInt(decimals.padEnd(8, "0")); };
const decimal = (value) => { const whole = value / 100000000n; const fractional = String(value % 100000000n).padStart(8, "0").replace(/0+$/, ""); return fractional ? `${whole}.${fractional}` : String(whole); };

export function summarizePoolCosts(orders) {
  const currencies = new Map(); let unknownCostCount = 0; let unknownCurrencyCount = 0;
  for (const order of orders) {
    if (!order.cost || amount(order.cost.amount) === null || order.cost.source !== "order") { unknownCostCount++; continue; }
    const currency = moneyCurrency(order.cost.currency); if (!currency) { unknownCurrencyCount++; continue; }
    const group = currencies.get(currency) || { currency, amount: 0n, confirmedOrderCount: 0, refunds: 0n, refundUnconfirmedCount: 0 };
    group.amount += units(order.cost.amount); group.confirmedOrderCount++;
    if (order.refundExpected && order.refundStatus !== "confirmed") { group.refunds += units(order.cost.amount); group.refundUnconfirmedCount++; }
    currencies.set(currency, group);
  }
  return { byCurrency: [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map((group) => ({ currency: group.currency,
    confirmedPurchaseAmount: decimal(group.amount), confirmedOrderCount: group.confirmedOrderCount, refundUnconfirmedAmount: decimal(group.refunds), refundUnconfirmedCount: group.refundUnconfirmedCount })),
    unknownCostCount, unknownCurrencyCount, orderCount: orders.length };
}
