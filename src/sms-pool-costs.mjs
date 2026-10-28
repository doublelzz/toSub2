import { moneyAmount, moneyCurrency } from "./sms-orders.mjs";

const names = { smsbower: "SMSBower", herosms: "Hero SMS", luban: "LubanSMS", custom: "自定义接码" };
const amount = (value) => moneyAmount(value);
const money = (value, currency) => { const parsed = amount(value); return parsed === null ? null : { amount: parsed, currency: moneyCurrency(currency) }; };
const categoryId = (order) => order.categoryId || "legacy";
const categoryName = (order) => order.categoryName || (categoryId(order) === "legacy" ? "原接码池" : categoryId(order));

export function poolCostOrder(source, { state = source.state || "", createdAt = source.createdAt || null, refundExpected = false,
  obtained = null, verified = state === "verified" && source.abandoned !== true, verifiedAt = null } = {}) {
  const order = source.order || {}; const config = source.config || {};
  const actual = order.cost?.source === "order" ? money(order.cost.amount, order.cost.currency) : null;
  const cost = actual ? { ...actual, source: "order" } : null;
  const providerId = source.providerId || ""; const country = String(config.country ?? "");
  const purchasedCategoryId = source.categoryId || config.categoryId || "legacy";
  return { orderId: order.requestId == null ? null : String(order.requestId), providerId, providerName: names[providerId] || providerId || "未知平台",
    categoryId: purchasedCategoryId, categoryName: source.categoryName || config.categoryName || (purchasedCategoryId === "legacy" ? "原接码池" : purchasedCategoryId),
    categoryFeeVersion: source.categoryFeeVersion ?? config.categoryFeeVersion ?? null,
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

export function summarizePoolCosts(orders, { purchaseInRange = () => true, verifiedInRange = () => true } = {}) {
  const currencies = new Map(); let unknownCostCount = 0; let unknownCurrencyCount = 0; let obtainedCount = 0; let verifiedCount = 0;
  const estimates = new Map(); let estimatedVerifiedCount = 0; let missingVerifiedEstimateCount = 0; let unknownVerifiedEstimateCurrencyCount = 0;
  let unknownVerifiedCostCount = 0; let unknownVerifiedCurrencyCount = 0; let missingVerifiedAtCount = 0; let orderCount = 0;
  const currencyGroup = (currency) => {
    if (!currencies.has(currency)) currencies.set(currency, { currency, amount: 0n, confirmedOrderCount: 0, refunds: 0n, refundUnconfirmedCount: 0,
      verifiedAmount: 0n, verifiedOrderCount: 0, estimatedVerifiedAmount: 0n, estimatedVerifiedOrderCount: 0 });
    return currencies.get(currency);
  };
  for (const order of orders) {
    const purchased = purchaseInRange(order); const verified = order.verified === true && verifiedInRange(order);
    if (!purchased && !verified) continue;
    orderCount++;
    if (purchased && order.obtained === true) obtainedCount++;
    if (verified) { verifiedCount++; if (timestamp(order.verifiedAt) === null) missingVerifiedAtCount++; }
    const actual = order.cost?.source === "order" ? amount(order.cost.amount) : null;
    if (actual === null) {
      if (purchased) unknownCostCount++;
      if (verified) {
        unknownVerifiedCostCount++;
        // An estimate is the quote saved with this purchase, never its price ceiling.
        const quoted = amount(order.quote?.amount);
        if (quoted === null) missingVerifiedEstimateCount++;
        else {
          estimatedVerifiedCount++;
          const currency = moneyCurrency(order.quote.currency); const providerId = order.providerId || "";
          if (!currency) unknownVerifiedEstimateCurrencyCount++;
          const key = JSON.stringify([providerId, currency]);
          const estimate = estimates.get(key) || { providerId, providerName: names[providerId] || order.providerName || providerId || "未知平台", currency, amount: 0n, count: 0 };
          estimate.amount += units(quoted); estimate.count++; estimates.set(key, estimate);
          if (currency) { const group = currencyGroup(currency); group.estimatedVerifiedAmount += units(quoted); group.estimatedVerifiedOrderCount++; }
        }
      }
      continue;
    }
    const currency = moneyCurrency(order.cost.currency);
    if (!currency) { if (purchased) unknownCurrencyCount++; if (verified) unknownVerifiedCurrencyCount++; continue; }
    const group = currencyGroup(currency);
    if (purchased) {
      group.amount += units(actual); group.confirmedOrderCount++;
      if (order.refundExpected && order.refundStatus !== "confirmed") { group.refunds += units(actual); group.refundUnconfirmedCount++; }
    }
    if (verified) { group.verifiedAmount += units(actual); group.verifiedOrderCount++; }
  }
  return { byCurrency: [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map((group) => ({ currency: group.currency,
    confirmedPurchaseAmount: decimal(group.amount), confirmedOrderCount: group.confirmedOrderCount, refundUnconfirmedAmount: decimal(group.refunds), refundUnconfirmedCount: group.refundUnconfirmedCount,
    verifiedPurchaseAmount: decimal(group.verifiedAmount), verifiedOrderCount: group.verifiedOrderCount,
    estimatedVerifiedAmount: decimal(group.estimatedVerifiedAmount), estimatedVerifiedOrderCount: group.estimatedVerifiedOrderCount })),
    estimatesByProviderCurrency: [...estimates.values()].sort((a, b) => a.providerId.localeCompare(b.providerId) || String(a.currency || "").localeCompare(String(b.currency || "")))
      .map((row) => ({ providerId: row.providerId, providerName: row.providerName, currency: row.currency, estimatedVerifiedAmount: decimal(row.amount), estimatedVerifiedOrderCount: row.count })),
    unknownCostCount, unknownCurrencyCount, unknownVerifiedCostCount, unknownVerifiedCurrencyCount, estimatedVerifiedCount, missingVerifiedEstimateCount,
    unknownVerifiedEstimateCurrencyCount, missingVerifiedAtCount, obtainedCount, verifiedCount, orderCount };
}

const TIME_ZONE = "Asia/Shanghai";
const DAY_MS = 86400000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const timestamp = (value) => { if (value == null || value === "") return null; const at = typeof value === "number" ? value : Date.parse(value); return Number.isFinite(at) ? at : null; };
const dayStart = (at) => Math.floor((at + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
const dayLabel = (at) => new Date(at + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
const inRange = (value, start, end) => { const at = timestamp(value); return at !== null && (start == null || at >= start) && (end == null || at < end); };
const eventRange = (start, end) => ({ purchaseInRange: (order) => start == null && end == null || inRange(order.createdAt, start, end),
  verifiedInRange: (order) => start == null && end == null || inRange(order.verifiedAt, start, end) });

const text = (value) => typeof value === "string" ? value.trim() : "";
export function poolCostFilters(query = {}) {
  const filters = {};
  for (const name of ["categoryId", "providerId", "credentialId", "country", "entryId", "currency", "costStatus", "result", "search"]) {
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
  if (filters.categoryId && categoryId(order) !== filters.categoryId) return false;
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

function groups(orders, keyFields, displayFields = [], range = {}) {
  const grouped = new Map();
  for (const order of orders) { const key = JSON.stringify(keyFields.map((field) => order[field] || "")); if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(order); }
  return [...grouped.values()].map((rows) => ({ ...Object.fromEntries([...keyFields, ...displayFields].map((field) => [field, rows.at(-1)[field] || ""])), ...summarizePoolCosts(rows, range) }));
}

export function poolCostAnalytics(orders, filters = {}, config = {}) {
  const { start, end, ...otherFilters } = filters;
  const normalized = orders.map((order) => ({ ...order, categoryId: categoryId(order), categoryName: categoryName(order), categoryFeeVersion: order.categoryFeeVersion ?? null }));
  const eligible = normalized.filter((order) => matchesPoolCost(order, otherFilters));
  const range = eventRange(start, end);
  const selected = eligible.filter((order) => range.purchaseInRange(order) || order.verified && range.verifiedInRange(order));
  const now = timestamp(typeof config.now === "function" ? config.now() : config.now) ?? Date.now(); const todayStart = dayStart(now);
  const dailyEnd = end ?? Math.max(todayStart + DAY_MS, start == null ? 0 : dayStart(start) + DAY_MS);
  const dailyStart = start ?? dayStart(dailyEnd - 1) - 29 * DAY_MS;
  const firstDay = dayStart(dailyStart); const lastDay = dayStart(dailyEnd - 1);
  if ((lastDay - firstDay) / DAY_MS + 1 > 3660) throw Object.assign(new Error("每日统计最多查询 3660 天，请缩小日期范围"), { status: 422 });
  const dailyOrders = new Map();
  const addDaily = (day, order, purchased, verified) => {
    if (!dailyOrders.has(day)) dailyOrders.set(day, []);
    dailyOrders.get(day).push({ ...order, purchasedInDay: purchased, verifiedInDay: verified });
  };
  for (const order of eligible) {
    const purchased = inRange(order.createdAt, dailyStart, dailyEnd); const verified = order.verified && inRange(order.verifiedAt, dailyStart, dailyEnd);
    const purchasedDay = purchased ? dayStart(timestamp(order.createdAt)) : null; const verifiedDay = verified ? dayStart(timestamp(order.verifiedAt)) : null;
    if (purchased) addDaily(purchasedDay, order, true, verified && verifiedDay === purchasedDay);
    if (verified && verifiedDay !== purchasedDay) addDaily(verifiedDay, order, false, true);
  }
  const byDay = [];
  const dailyRange = { purchaseInRange: (order) => order.purchasedInDay, verifiedInRange: (order) => order.verifiedInDay };
  for (let day = lastDay; day >= firstDay; day -= DAY_MS) byDay.push({ date: dayLabel(day), ...summarizePoolCosts(dailyOrders.get(day) || [], dailyRange) });
  const dailySummary = summarizePoolCosts(eligible, eventRange(dailyStart, dailyEnd));
  const today = { date: dayLabel(todayStart), ...summarizePoolCosts(eligible, eventRange(todayStart, todayStart + DAY_MS)) };
  const credentials = config.credentials || []; const namesById = new Map(credentials.map((row) => [row.id, row]));
  const providers = new Map(); const countries = new Map(); const currencies = new Set(); const credentialOptions = new Map(); const categories = new Map();
  for (const category of config.categories || []) categories.set(category.id, { ...category, categoryId: category.id, categoryName: category.name, historicalNames: [] });
  for (const order of normalized) {
    const id = categoryId(order); const label = categoryName(order);
    const category = categories.get(id) || { id, name: label, categoryId: id, categoryName: label, enabled: false, archivedAt: null, historicalNames: [] };
    if (!category.historicalNames.includes(label)) category.historicalNames.push(label);
    categories.set(id, category);
    if (order.providerId) providers.set(order.providerId, { providerId: order.providerId, name: names[order.providerId] || order.providerName || order.providerId });
    if (order.countryKey) countries.set(order.countryKey, { countryKey: order.countryKey, providerId: order.providerId, country: order.country, countryLabel: order.countryLabel || order.country });
    if (order.cost?.currency) currencies.add(order.cost.currency);
    if (order.credentialId) credentialOptions.set(order.credentialId, { credentialId: order.credentialId, name: namesById.get(order.credentialId)?.name || "历史服务商凭据", providerId: order.providerId });
  }
  for (const credential of credentials) { providers.set(credential.providerId, { providerId: credential.providerId, name: names[credential.providerId] || credential.providerId }); credentialOptions.set(credential.id, { credentialId: credential.id, providerId: credential.providerId, name: credential.name }); }
  for (const entry of config.entries || []) { const providerId = namesById.get(entry.credentialId)?.providerId; if (providerId) { const countryKey = `${providerId}:${entry.country}`; countries.set(countryKey, { countryKey, providerId, country: entry.country, countryLabel: entry.countryLabel || entry.country }); } if (entry.currency) currencies.add(entry.currency); }
  const byEntry = groups(selected, ["entryId"], ["providerId", "providerName", "credentialId", "countryKey", "country", "countryLabel", "categoryId", "categoryName"], range);
  const entryRoutes = new Map();
  for (const order of selected) {
    const id = order.entryId || ""; if (!entryRoutes.has(id)) entryRoutes.set(id, new Set());
    entryRoutes.get(id).add(JSON.stringify([order.categoryId, order.providerId, order.credentialId, order.countryKey, order.route]));
  }
  for (const group of byEntry) {
    group.routeCount = entryRoutes.get(group.entryId).size;
    group.mixedRoutes = group.routeCount > 1;
    group.credentialName = namesById.get(group.credentialId)?.name || "";
  }
  return { timeBasis: "events", timeZone: TIME_ZONE, eventTimeBasis: { obtained: "createdAt", verified: "verifiedAt" },
    summary: summarizePoolCosts(selected, range), dailySummary, today, byDay, byEntry,
    byCategory: groups(selected, ["categoryId"], ["categoryName"], range),
    byProvider: groups(selected, ["providerId"], ["providerName"], range), byCountry: groups(selected, ["providerId", "countryKey"], ["country", "countryLabel"], range),
    filterOptions: { categories: [...categories.values()], providers: [...providers.values()], credentials: [...credentialOptions.values()], countries: [...countries.values()], currencies: [...currencies].sort() } };
}

export function matchesCurrentEntry(order, entry, credential) {
  const route = order.route || {};
  const samePrice = amount(route.maxPrice) !== null && amount(entry.maxPrice) !== null && units(route.maxPrice) === units(entry.maxPrice);
  return categoryId(order) === categoryId(entry) && order.entryId === entry.id && order.credentialId === entry.credentialId && order.providerId === credential?.providerId && order.country === String(entry.country)
    && route.service === String(entry.service || "dr") && route.providerIds === String(entry.providerIds || "") && samePrice && route.currency === moneyCurrency(entry.currency);
}
