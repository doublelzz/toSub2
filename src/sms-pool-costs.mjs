import { moneyAmount, moneyCurrency } from "./sms-orders.mjs";

const names = { smsbower: "SMSBower", herosms: "Hero SMS", luban: "LubanSMS", custom: "自定义接码" };
const amount = (value) => moneyAmount(value);
const money = (value, currency) => { const parsed = amount(value); return parsed === null ? null : { amount: parsed, currency: moneyCurrency(currency) }; };

export function poolCostOrder(source, { state = source.state || "", createdAt = source.createdAt || null, refundExpected = false,
  obtained = null, verified = state === "verified" && source.abandoned !== true, verifiedAt = null } = {}) {
  const order = source.order || {}; const config = source.config || {};
  const actual = order.cost?.source === "order" ? money(order.cost.amount, order.cost.currency) : null;
  const cost = actual ? { ...actual, source: "order" } : null;
  const providerId = source.providerId || ""; const country = String(config.country ?? "");
  return { orderId: order.requestId == null ? null : String(order.requestId), providerId, providerName: names[providerId] || providerId || "未知平台",
    entryId: source.entryId || null, credentialId: source.credentialId || null, country, countryKey: providerId && country ? `${providerId}:${country}` : "",
    countryLabel: String(config.countryLabel || country || "").slice(0, 160), phone: order.number ? String(order.number).replace(/.(?=.{4})/g, "*") : null,
    route: { service: String(config.service || "dr"), providerIds: String(config.providerIds || ""), maxPrice: String(config.maxPrice || ""), currency: moneyCurrency(config.currency) },
    obtained: obtained === true || Boolean(order.requestId && /^\+[1-9]\d{6,14}$/.test(order.number || "")), verified: Boolean(verified && order.requestId), verifiedAt: verifiedAt || null,
    cost, quote: money(config.quotedPrice, config.currency), maxPrice: money(config.maxPrice, config.currency),
    refundStatus: source.refundStatus === "confirmed" && source.refundEvidence ? "confirmed" : "unconfirmed", refundExpected: Boolean(refundExpected),
    feeStatus: !cost ? "unknown_cost" : !cost.currency ? "unknown_currency" : "confirmed_purchase", state, createdAt };
}

const units = (value) => { const [whole, decimals = ""] = value.split("."); return BigInt(whole) * 100000000n + BigInt(decimals.padEnd(8, "0")); };
const decimal = (value) => { const whole = value / 100000000n; const fractional = String(value % 100000000n).padStart(8, "0").replace(/0+$/, ""); return fractional ? `${whole}.${fractional}` : String(whole); };

export function summarizePoolCosts(orders) {
  const currencies = new Map(); let unknownCostCount = 0; let unknownCurrencyCount = 0; let obtainedCount = 0; let verifiedCount = 0;
  let unknownVerifiedCostCount = 0; let unknownVerifiedCurrencyCount = 0;
  for (const order of orders) {
    if (order.obtained === true) obtainedCount++;
    if (order.verified === true) verifiedCount++;
    if (!order.cost || amount(order.cost.amount) === null || order.cost.source !== "order") { unknownCostCount++; if (order.verified) unknownVerifiedCostCount++; continue; }
    const currency = moneyCurrency(order.cost.currency); if (!currency) { unknownCurrencyCount++; if (order.verified) unknownVerifiedCurrencyCount++; continue; }
    const group = currencies.get(currency) || { currency, amount: 0n, confirmedOrderCount: 0, refunds: 0n, refundUnconfirmedCount: 0, verifiedAmount: 0n, verifiedOrderCount: 0 };
    group.amount += units(order.cost.amount); group.confirmedOrderCount++;
    if (order.verified) { group.verifiedAmount += units(order.cost.amount); group.verifiedOrderCount++; }
    if (order.refundExpected && order.refundStatus !== "confirmed") { group.refunds += units(order.cost.amount); group.refundUnconfirmedCount++; }
    currencies.set(currency, group);
  }
  return { byCurrency: [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map((group) => ({ currency: group.currency,
    confirmedPurchaseAmount: decimal(group.amount), confirmedOrderCount: group.confirmedOrderCount, refundUnconfirmedAmount: decimal(group.refunds), refundUnconfirmedCount: group.refundUnconfirmedCount,
    verifiedPurchaseAmount: decimal(group.verifiedAmount), verifiedOrderCount: group.verifiedOrderCount })),
    unknownCostCount, unknownCurrencyCount, unknownVerifiedCostCount, unknownVerifiedCurrencyCount, obtainedCount, verifiedCount, orderCount: orders.length };
}

const text = (value) => typeof value === "string" ? value.trim() : "";
export function poolCostFilters(query = {}) {
  const filters = {};
  for (const name of ["providerId", "credentialId", "country", "entryId", "currency", "costStatus", "result", "search"]) {
    const value = text(query[name]); if (value.length > 200) throw Object.assign(new Error("接码池筛选参数过长"), { status: 422 });
    if (value && value !== "all") filters[name] = value;
  }
  if (filters.costStatus && !["known", "unknown", "unknown_currency"].includes(filters.costStatus)) throw Object.assign(new Error("费用状态筛选不正确"), { status: 422 });
  if (filters.result && !["obtained", "verified", "unverified"].includes(filters.result)) throw Object.assign(new Error("取号结果筛选不正确"), { status: 422 });
  if (filters.currency && !moneyCurrency(filters.currency)) throw Object.assign(new Error("币种筛选不正确"), { status: 422 });
  if (filters.currency) filters.currency = moneyCurrency(filters.currency);
  for (const name of ["start", "end"]) if (query[name] != null && query[name] !== "") {
    const value = Date.parse(query[name]); if (!Number.isFinite(value)) throw Object.assign(new Error("接码池时间筛选不正确"), { status: 422 }); filters[name] = value;
  }
  if (filters.start != null && filters.end != null && filters.start >= filters.end) throw Object.assign(new Error("结束时间必须晚于开始时间"), { status: 422 });
  return filters;
}

export function matchesPoolCost(order, filters = {}) {
  for (const field of ["providerId", "credentialId", "entryId"]) if (filters[field] && String(order[field] || "") !== filters[field]) return false;
  if (filters.country && (order.countryKey || "") !== filters.country) return false;
  if (filters.currency && order.cost?.currency !== filters.currency) return false;
  const known = order.cost?.source === "order" && amount(order.cost.amount) !== null && Boolean(moneyCurrency(order.cost.currency));
  if (filters.costStatus === "known" && !known || filters.costStatus === "unknown" && known
    || filters.costStatus === "unknown_currency" && (!order.cost || order.cost.currency)) return false;
  if (filters.result === "obtained" && !order.obtained || filters.result === "verified" && !order.verified || filters.result === "unverified" && order.verified) return false;
  const created = typeof order.createdAt === "number" ? order.createdAt : Date.parse(order.createdAt);
  if (filters.start != null && (!Number.isFinite(created) || created < filters.start) || filters.end != null && (!Number.isFinite(created) || created >= filters.end)) return false;
  return true;
}

function groups(orders, keyFields, displayFields = []) {
  const grouped = new Map();
  for (const order of orders) { const key = JSON.stringify(keyFields.map((field) => order[field] || "")); if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(order); }
  return [...grouped.values()].map((rows) => ({ ...Object.fromEntries([...keyFields, ...displayFields].map((field) => [field, rows.at(-1)[field] || ""])), ...summarizePoolCosts(rows) }));
}

export function poolCostAnalytics(orders, filters = {}, config = {}) {
  const selected = orders.filter((order) => matchesPoolCost(order, filters));
  const credentials = config.credentials || []; const namesById = new Map(credentials.map((row) => [row.id, row]));
  const providers = new Map(); const countries = new Map(); const currencies = new Set(); const credentialOptions = new Map();
  for (const order of orders) {
    if (order.providerId) providers.set(order.providerId, { providerId: order.providerId, name: names[order.providerId] || order.providerName || order.providerId });
    if (order.countryKey) countries.set(order.countryKey, { countryKey: order.countryKey, providerId: order.providerId, country: order.country, countryLabel: order.countryLabel || order.country });
    if (order.cost?.currency) currencies.add(order.cost.currency);
    if (order.credentialId) credentialOptions.set(order.credentialId, { credentialId: order.credentialId, name: namesById.get(order.credentialId)?.name || "历史服务商凭据", providerId: order.providerId });
  }
  for (const credential of credentials) { providers.set(credential.providerId, { providerId: credential.providerId, name: names[credential.providerId] || credential.providerId }); credentialOptions.set(credential.id, { credentialId: credential.id, providerId: credential.providerId, name: credential.name }); }
  for (const entry of config.entries || []) { const providerId = namesById.get(entry.credentialId)?.providerId; if (providerId) { const countryKey = `${providerId}:${entry.country}`; countries.set(countryKey, { countryKey, providerId, country: entry.country, countryLabel: entry.countryLabel || entry.country }); } if (entry.currency) currencies.add(entry.currency); }
  const byEntry = groups(selected, ["entryId"], ["providerId", "providerName", "credentialId", "countryKey", "country", "countryLabel"]);
  const entryRoutes = new Map();
  for (const order of selected) {
    const id = order.entryId || ""; if (!entryRoutes.has(id)) entryRoutes.set(id, new Set());
    entryRoutes.get(id).add(JSON.stringify([order.providerId, order.credentialId, order.countryKey, order.route]));
  }
  for (const group of byEntry) {
    group.routeCount = entryRoutes.get(group.entryId).size;
    group.mixedRoutes = group.routeCount > 1;
    group.credentialName = namesById.get(group.credentialId)?.name || "";
  }
  return { timeBasis: "purchasedAt", summary: summarizePoolCosts(selected), byEntry, byProvider: groups(selected, ["providerId"], ["providerName"]), byCountry: groups(selected, ["providerId", "countryKey"], ["country", "countryLabel"]),
    filterOptions: { providers: [...providers.values()], credentials: [...credentialOptions.values()], countries: [...countries.values()], currencies: [...currencies].sort() } };
}

export function matchesCurrentEntry(order, entry, credential) {
  const route = order.route || {};
  const samePrice = amount(route.maxPrice) !== null && amount(entry.maxPrice) !== null && units(route.maxPrice) === units(entry.maxPrice);
  return order.entryId === entry.id && order.credentialId === entry.credentialId && order.providerId === credential?.providerId && order.country === String(entry.country)
    && route.service === String(entry.service || "dr") && route.providerIds === String(entry.providerIds || "") && samePrice && route.currency === moneyCurrency(entry.currency);
}
