import React, { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronRight, Globe2, KeyRound, LogIn, Settings2, ShieldCheck } from "lucide-react";
import "./styles.css";
import "./workspace.css";
import { ThemeControl } from "./WorkspaceUi.jsx";
import SmsPoolWorkspace, { SmsPoolChoice } from "./SmsPoolWorkspace.jsx";
import ImportChargeDialog from "./ImportChargeDialog.jsx";

// Isolated design fixtures. This entry has no connection to the CDK or SMS APIs.
const DEMO_DAY_MS = 86400000;
const demoDayStart = (at) => Math.floor((at + 28800000) / DEMO_DAY_MS) * DEMO_DAY_MS - 28800000;
const demoDayLabel = (at) => new Date(at + 28800000).toISOString().slice(0, 10);
const demoToday = demoDayStart(Date.now());
const demoOrders = [
  { orderId: "preview-order-1", entryId: "preview-2", credentialId: "preview-hero", providerId: "herosms", providerName: "Hero SMS", country: "16", countryLabel: "英国", obtained: true, verified: false, phone: "*******6630", quote: { amount: "0.40", currency: "USD" }, maxPrice: { amount: "0.42", currency: "USD" }, cost: null, refundExpected: true, refundStatus: "unconfirmed", createdAt: demoToday - 120000 },
  { orderId: "preview-order-2", categoryId: "other", categoryName: "其他", categoryFeeVersion: 1, entryId: "preview-1", credentialId: "preview-bower", providerId: "smsbower", providerName: "SMSBower", country: "6", countryLabel: "印度尼西亚", obtained: true, verified: true, phone: "*******0118", cost: { amount: "0.24", currency: "USD", source: "order" }, refundExpected: false, refundStatus: "unconfirmed", createdAt: demoToday - 60000, verifiedAt: demoToday + 1000 },
];
const demoAssignedOrder = { orderId: "preview-order-3", categoryId: "vip", categoryName: "专线", categoryFeeVersion: 1, entryId: "preview-4", credentialId: "preview-hero", country: "4", obtained: true, verified: false, providerId: "herosms", providerName: "Hero SMS", countryLabel: "菲律宾", phone: "*******2261", cost: { amount: "0.22", currency: "USD", source: "order" }, refundExpected: false, refundStatus: "unconfirmed", createdAt: Date.now() - 180000 };
const demoEstimatedOrder = { orderId: "preview-order-4", categoryId: "other", categoryName: "其他", categoryFeeVersion: 1, entryId: "preview-6", credentialId: "preview-bower", country: "31", obtained: true, verified: true, providerId: "smsbower", providerName: "SMSBower", countryLabel: "南非", phone: "*******4107", cost: null,
  quote: { amount: "0.074", currency: null }, maxPrice: { amount: "0.09", currency: null }, refundExpected: false, refundStatus: "unconfirmed", createdAt: demoToday + 1000, verifiedAt: demoToday + 2000 };
const demoUsOrder = { orderId: "preview-order-5", categoryId: "us", categoryName: "美区", categoryFeeVersion: 1, entryId: "preview-7", credentialId: "preview-bower", country: "12", obtained: true, verified: true, providerId: "smsbower", providerName: "SMSBower", countryLabel: "美国", phone: "*******0142",
  cost: { amount: "0.8", currency: "USD", source: "order" }, refundExpected: false, refundStatus: "unconfirmed", createdAt: demoToday - 12 * 3600000, verifiedAt: demoToday - 11 * 3600000 };
const initial = {
  rules: { enabled: true, noStockThreshold: 3, cooldownMinutes: 10, maxAttempts: 10, requestConcurrency: 3 },
  categories: [{ id: "us", name: "美区", enabled: false, fee: 4, feeVersion: 1, archivedAt: null }, { id: "other", name: "其他", enabled: true, fee: 2, feeVersion: 1, archivedAt: null }, { id: "vip", name: "专线", enabled: true, fee: 3, feeVersion: 1, archivedAt: null }],
  credentials: [{ id: "preview-bower", name: "SMSBower 主账户", providerId: "smsbower", enabled: true, hasApiKey: true }, { id: "preview-hero", name: "Hero 备用账户", providerId: "herosms", enabled: true, hasApiKey: true }],
  entries: [
    { id: "preview-1", categoryId: "other", credentialId: "preview-bower", providerId: "smsbower", credentialName: "SMSBower 主账户", country: "6", countryLabel: "印度尼西亚", maxPrice: "0.28", currency: "USD", priority: 10, enabled: true, state: "available", noStockCount: 0 },
    { id: "preview-2", categoryId: "other", credentialId: "preview-hero", providerId: "herosms", credentialName: "Hero 备用账户", country: "16", countryLabel: "英国", maxPrice: "0.42", currency: "USD", priority: 10, enabled: true, state: "available", noStockCount: 1 },
    { id: "preview-3", categoryId: "other", credentialId: "preview-bower", providerId: "smsbower", credentialName: "SMSBower 主账户", country: "36", countryLabel: "加拿大", maxPrice: "0.35", currency: "USD", priority: 20, enabled: true, state: "cooling", noStockCount: 3, cooldownUntil: Date.now() + 8 * 60000 },
    { id: "preview-4", categoryId: "vip", credentialId: "preview-hero", providerId: "herosms", credentialName: "Hero 备用账户", country: "4", countryLabel: "菲律宾", maxPrice: "0.31", currency: "USD", priority: 20, enabled: true, state: "available", noStockCount: 0 },
    { id: "preview-5", categoryId: "other", credentialId: "preview-bower", providerId: "smsbower", credentialName: "SMSBower 主账户", country: "43", countryLabel: "德国", maxPrice: "0.61", currency: "USD", priority: 30, enabled: false, state: "disabled", noStockCount: 0 },
    { id: "preview-6", categoryId: "other", credentialId: "preview-bower", providerId: "smsbower", credentialName: "SMSBower 主账户", country: "31", countryLabel: "南非", quotedPrice: "0.074", maxPrice: "0.09", currency: null, priority: 10, enabled: true, state: "available", noStockCount: 0 },
    { id: "preview-7", categoryId: "us", credentialId: "preview-bower", providerId: "smsbower", credentialName: "SMSBower 主账户", country: "12", countryLabel: "美国", quotedPrice: "0.8", maxPrice: "0.8", currency: "USD", providerIds: "12", priority: 10, enabled: true, state: "available", noStockCount: 0 },
  ],
  legacyInventory: { counts: {}, items: [
    { id: "preview-stock-1", entryId: "preview-1", providerId: "smsbower", country: "6", countryLabel: "印度尼西亚", state: "closed", phone: "+12025550101", cost: { amount: "0.28", currency: "USD", source: "order" }, createdAt: demoToday - DEMO_DAY_MS, expiresAt: demoToday - DEMO_DAY_MS + 1500000, expiresSource: "provider_policy", cancelState: "confirmed", refundStatus: "unconfirmed" },
    { id: "preview-stock-4", entryId: "preview-1", providerId: "smsbower", country: "6", countryLabel: "印度尼西亚", state: "cancel_pending", phone: "+12025550104", cost: { amount: "0.28", currency: "USD", source: "order" }, refundExpected: true, createdAt: Date.now() - 700000, expiresAt: Date.now() + 4 * 60000, expiresSource: "provider_policy", nextActionAt: Date.now() + 30000, cancelState: "unknown", refundStatus: "unconfirmed" },
    { id: "preview-stock-5", entryId: "preview-2", providerId: "herosms", state: "purchase_unknown", phone: null, createdAt: Date.now() - 90000, expiresAt: null, cancelState: "unknown", refundStatus: "unconfirmed", lastError: "interrupted_purchase", canReconcile: true },
  ] },
  operations: [{ id: "preview-op-1", categoryId: "other", categoryName: "其他", categoryFeeVersion: 1, email: "sample-01@example.invalid", cdkLabel: "页面示例 CDK", state: "verified", fee: 2, attempts: 2, cost: demoOrders[1].cost, costOrders: demoOrders, createdAt: demoToday - 120000 },
    { id: "preview-op-2", categoryId: "vip", categoryName: "专线", categoryFeeVersion: 1, email: "sample-02@example.invalid", cdkLabel: "页面示例 CDK", state: "unknown", fee: 3, attempts: 1, cost: demoAssignedOrder.cost, costOrders: [demoAssignedOrder], reason: "验证响应中断，等待核实", createdAt: Date.now() - 180000 },
    { id: "preview-op-3", categoryId: "other", categoryName: "其他", categoryFeeVersion: 1, email: "sample-03@example.invalid", cdkLabel: "页面示例 CDK", state: "verified", fee: 2, attempts: 1, quote: demoEstimatedOrder.quote, maxPrice: demoEstimatedOrder.maxPrice, cost: null, costOrders: [demoEstimatedOrder], createdAt: demoToday + 1000 },
    { id: "preview-op-4", categoryId: "us", categoryName: "美区", categoryFeeVersion: 1, email: "sample-us@example.invalid", cdkLabel: "页面示例 CDK", state: "verified", fee: 4, attempts: 1, cost: demoUsOrder.cost, costOrders: [demoUsOrder], createdAt: demoUsOrder.createdAt }],
};
const quotes = [{ country: "6", title: "印度尼西亚", price: 0.28, count: 28, currency: "USD", providerIds: "1", grade: "gold" }, { country: "6", title: "印度尼西亚", price: 0.32, count: 45, currency: "USD", providerIds: "2", grade: "unknown" }, { country: "73", title: "巴西", price: 0.39, count: 16, currency: "USD", providerIds: "3", grade: "unknown" }, { country: "16", title: "英国", price: 0.42, count: 12, currency: "USD", providerIds: "4", grade: "gold" }, { country: "36", title: "加拿大", price: 0.35, count: 8, currency: "USD", providerIds: "5", grade: "unknown" }];
let snapshot = structuredClone(initial);
const demoUnits = (value) => { const [whole, fraction = ""] = String(value).split("."); return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, "0")); };
const demoAmount = (value) => { const fraction = String(value % 100000000n).padStart(8, "0").replace(/0+$/, ""); return `${value / 100000000n}${fraction ? `.${fraction}` : ""}`; };
const demoTimestamp = (value) => value == null || value === "" ? null : typeof value === "number" ? value : Date.parse(value);
const demoInRange = (value, start, end) => { const at = demoTimestamp(value); return Number.isFinite(at) && (start == null || at >= start) && (end == null || at < end); };
function demoCostSummary(orders, start = null, end = null) {
  const byCurrency = new Map(); let unknownCostCount = 0; let unknownCurrencyCount = 0; let unknownVerifiedCostCount = 0; let unknownVerifiedCurrencyCount = 0;
  const estimates = new Map(); let estimatedVerifiedCount = 0; let missingVerifiedEstimateCount = 0; let unknownVerifiedEstimateCurrencyCount = 0; let missingVerifiedAtCount = 0;
  let orderCount = 0; let obtainedCount = 0; let verifiedCount = 0;
  const getGroup = (currency) => {
    if (!byCurrency.has(currency)) byCurrency.set(currency, { currency, total: 0n, verified: 0n, estimated: 0n, refunds: 0n, confirmedOrderCount: 0, verifiedOrderCount: 0, estimatedVerifiedOrderCount: 0, refundUnconfirmedCount: 0 });
    return byCurrency.get(currency);
  };
  for (const row of orders) {
    const purchased = start == null && end == null || demoInRange(row.createdAt, start, end);
    const verified = row.verified && (start == null && end == null || demoInRange(row.verifiedAt, start, end));
    if (!purchased && !verified) continue;
    orderCount++; if (purchased && row.obtained) obtainedCount++;
    if (verified) { verifiedCount++; if (!Number.isFinite(demoTimestamp(row.verifiedAt))) missingVerifiedAtCount++; }
    if (!row.cost || row.cost.source !== "order") {
      if (purchased) unknownCostCount++;
      if (verified) {
        unknownVerifiedCostCount++;
        if (row.quote?.amount == null) missingVerifiedEstimateCount++;
        else {
          const currency = row.quote.currency || null; const key = JSON.stringify([row.providerId, currency]);
          const estimate = estimates.get(key) || { providerId: row.providerId, providerName: row.providerName, currency, value: 0n, count: 0 };
          estimate.value += demoUnits(row.quote.amount); estimate.count++; estimates.set(key, estimate); estimatedVerifiedCount++;
          if (currency) { const group = getGroup(currency); group.estimated += demoUnits(row.quote.amount); group.estimatedVerifiedOrderCount++; }
          else unknownVerifiedEstimateCurrencyCount++;
        }
      }
      continue;
    }
    if (!row.cost.currency) { if (purchased) unknownCurrencyCount++; if (verified) unknownVerifiedCurrencyCount++; continue; }
    const group = getGroup(row.cost.currency);
    if (purchased) { group.total += demoUnits(row.cost.amount); group.confirmedOrderCount++;
      if (row.refundExpected && row.refundStatus !== "confirmed") { group.refunds += demoUnits(row.cost.amount); group.refundUnconfirmedCount++; } }
    if (verified) { group.verified += demoUnits(row.cost.amount); group.verifiedOrderCount++; }
  }
  return { orderCount, obtainedCount, verifiedCount, unknownCostCount, unknownCurrencyCount, unknownVerifiedCostCount, unknownVerifiedCurrencyCount,
    estimatedVerifiedCount, missingVerifiedEstimateCount, unknownVerifiedEstimateCurrencyCount, missingVerifiedAtCount,
    estimatesByProviderCurrency: [...estimates.values()].map((row) => ({ providerId: row.providerId, providerName: row.providerName, currency: row.currency, estimatedVerifiedAmount: demoAmount(row.value), estimatedVerifiedOrderCount: row.count })),
    byCurrency: [...byCurrency.values()].map((group) => ({ currency: group.currency, confirmedPurchaseAmount: demoAmount(group.total), verifiedPurchaseAmount: demoAmount(group.verified), confirmedOrderCount: group.confirmedOrderCount, verifiedOrderCount: group.verifiedOrderCount,
      estimatedVerifiedAmount: demoAmount(group.estimated), estimatedVerifiedOrderCount: group.estimatedVerifiedOrderCount, refundUnconfirmedAmount: demoAmount(group.refunds), refundUnconfirmedCount: group.refundUnconfirmedCount })) };
}
function demoOrdersSnapshot() {
  const records = [...snapshot.legacyInventory.items.map((item) => ({ ...item, orderId: item.orderId || item.id, obtained: Boolean(item.phone), verified: item.state === "consumed" })), ...snapshot.operations.flatMap((row) => row.costOrders || [])];
  const unique = new Map();
  for (const row of records) {
    const entry = snapshot.entries.find((entry) => entry.id === row.entryId);
    const merged = { ...row, categoryId: row.categoryId || "legacy", categoryName: row.categoryName || ((row.categoryId || "legacy") === "legacy" ? "原接码池" : row.categoryId),
      categoryFeeVersion: row.categoryFeeVersion ?? null, entryId: row.entryId || "", providerId: row.providerId || entry?.providerId || "", credentialId: row.credentialId || entry?.credentialId || "", country: row.country || entry?.country || "", countryLabel: row.countryLabel || entry?.countryLabel || "", providerName: row.providerName || (row.providerId === "herosms" ? "Hero SMS" : "SMSBower") };
    merged.countryKey = `${merged.providerId}:${merged.country}`;
    const key = `${merged.providerId}:${merged.credentialId}:${merged.orderId}`; const previous = unique.get(key); unique.set(key, { ...previous, ...merged, verified: Boolean(previous?.verified || merged.verified) });
  }
  return [...unique.values()];
}
function demoMatches(row, query) {
  return (!query.categoryId || (row.categoryId || "legacy") === query.categoryId) && (!query.providerId || row.providerId === query.providerId) && (!query.credentialId || row.credentialId === query.credentialId) && (!query.country || row.countryKey === query.country) && (!query.entryId || row.entryId === query.entryId)
    && (!query.currency || row.cost?.currency === query.currency) && (!query.start || new Date(row.createdAt).getTime() >= Date.parse(query.start)) && (!query.end || new Date(row.createdAt).getTime() < Date.parse(query.end))
    && (!query.result || query.result === "all" || query.result === "obtained" && row.obtained || query.result === "verified" && row.verified || query.result === "unverified" && !row.verified)
    && (!query.costStatus || query.costStatus === "all" || query.costStatus === "known" && row.cost?.currency || query.costStatus === "unknown" && !row.cost?.currency);
}
function demoAnalytics(query = {}) {
  const { start: startText, end: endText, ...otherFilters } = query; const start = startText ? Date.parse(startText) : null; const end = endText ? Date.parse(endText) : null;
  const all = demoOrdersSnapshot(); const eligible = all.filter((row) => demoMatches(row, otherFilters));
  const filtered = eligible.filter((row) => start == null && end == null || demoInRange(row.createdAt, start, end) || row.verified && demoInRange(row.verifiedAt, start, end));
  const groups = (key) => [...new Set(filtered.map((row) => row[key]))].map((value) => { const records = filtered.filter((row) => row[key] === value); const first = records[0]; return { [key]: value, categoryId: first.categoryId, categoryName: first.categoryName, entryId: first.entryId, providerId: first.providerId, providerName: first.providerName, country: first.country, countryKey: first.countryKey, countryLabel: first.countryLabel, ...demoCostSummary(records, start, end) }; });
  const categoryOptions = new Map(snapshot.categories.map((row) => [row.id, { ...row, categoryId: row.id, categoryName: row.name, historicalNames: [] }]));
  for (const row of all) { const category = categoryOptions.get(row.categoryId) || { id: row.categoryId, name: row.categoryName, categoryId: row.categoryId, categoryName: row.categoryName, enabled: false, archivedAt: null, historicalNames: [] };
    if (!category.historicalNames.includes(row.categoryName)) category.historicalNames.push(row.categoryName); categoryOptions.set(row.categoryId, category); }
  const filterOptions = { countries: [...new Map(all.filter((row) => row.country).map((row) => [row.countryKey, { countryKey: row.countryKey, key: row.countryKey, value: row.countryKey, country: row.country, providerId: row.providerId, countryLabel: row.countryLabel, label: `${row.countryLabel} / ${row.providerName}` }])).values()],
    categories: [...categoryOptions.values()], providers: [{ providerId: "smsbower", id: "smsbower", name: "SMSBower" }, { providerId: "herosms", id: "herosms", name: "Hero SMS" }], credentials: snapshot.credentials.map((row) => ({ ...row, credentialId: row.id })), currencies: [...new Set(all.map((row) => row.cost?.currency).filter(Boolean))] };
  const dailyEnd = end ?? Math.max(demoToday + DEMO_DAY_MS, start == null ? 0 : demoDayStart(start) + DEMO_DAY_MS);
  const dailyStart = start ?? demoDayStart(dailyEnd - 1) - 29 * DEMO_DAY_MS; const firstDay = demoDayStart(dailyStart); const lastDay = demoDayStart(dailyEnd - 1);
  if ((lastDay - firstDay) / DEMO_DAY_MS + 1 > 3660) throw Object.assign(new Error("每日统计最多查询 3660 天，请缩小日期范围"), { status: 422 });
  const byDay = [];
  for (let day = lastDay; day >= firstDay; day -= DEMO_DAY_MS) byDay.push({ date: demoDayLabel(day), ...demoCostSummary(eligible, Math.max(day, dailyStart), Math.min(day + DEMO_DAY_MS, dailyEnd)) });
  return { summary: demoCostSummary(filtered, start, end), dailySummary: demoCostSummary(eligible, dailyStart, dailyEnd), today: { date: demoDayLabel(demoToday), ...demoCostSummary(eligible, demoToday, demoToday + DEMO_DAY_MS) }, byDay,
    byCategory: groups("categoryId"), byEntry: groups("entryId"), byProvider: groups("providerId"), byCountry: groups("countryKey"), filterOptions, timeBasis: "events", timeZone: "Asia/Shanghai", eventTimeBasis: { obtained: "createdAt", verified: "verifiedAt" } };
}
function demoSnapshot() {
  const value = structuredClone(snapshot); const orders = demoOrdersSnapshot(); const report = demoAnalytics(); value.costSummary = report.summary; value.today = report.today; value.analyticsFilterOptions = report.filterOptions;
  value.legacyInventory.counts = { ready: 0, purchasing: 0, checking: 0, assigned: 0, cancel_pending: 0, purchase_unknown: 0, quarantined: 0, closed: 0, consumed: 0 };
  for (const row of value.legacyInventory.items) value.legacyInventory.counts[row.state] = (value.legacyInventory.counts[row.state] || 0) + 1;
  value.entries = value.entries.map((row) => ({ ...row, stats: demoCostSummary(orders.filter((item) => item.entryId === row.id && item.categoryId === row.categoryId)) }));
  value.credentials = value.credentials.map((row) => ({ ...row, stats: demoCostSummary(orders.filter((item) => item.credentialId === row.id)) }));
  return value;
}
function demoPublicSummary() {
  const categories = snapshot.categories.filter((row) => !row.archivedAt).map(({ id, name, fee, feeVersion, enabled }) => {
    const available = snapshot.rules.enabled && enabled && snapshot.entries.some((entry) => entry.categoryId === id && entry.enabled && entry.state === "available");
    return { id, name, fee, feeVersion, enabled, available, status: available ? "available_on_demand" : "unavailable" };
  });
  return { enabled: snapshot.rules.enabled, version: 1, categories, available: categories.some((row) => row.available), status: categories.some((row) => row.available) ? "available_on_demand" : "unavailable" };
}
async function previewApi(path = "", method = "GET", body) {
  let savedCategory;
  if (!path) return demoSnapshot();
  if (path.startsWith("/inventory?")) {
    const query = Object.fromEntries(new URLSearchParams(path.split("?")[1]));
    const rows = demoSnapshot().legacyInventory.items.filter((row) => Boolean(row.phone) && (query.scope === "all" || (query.scope === "history" ? ["closed", "consumed"].includes(row.state) : !["closed", "consumed"].includes(row.state)))
      && (!query.state || row.state === query.state) && (!query.providerId || row.providerId === query.providerId) && (!query.country || `${row.providerId}:${row.country}` === query.country)
      && (!query.search || `${row.phone || ""} ${row.countryLabel || ""}`.includes(query.search)) && (!query.refundStatus || row.refundStatus === query.refundStatus)
      && (!query.costStatus || query.costStatus === "all" || (row.cost?.source === "order" && row.cost.currency ? "known" : "unknown") === query.costStatus));
    const page = Number(query.page || 1); const pageSize = Number(query.pageSize || 20);
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, pages: Math.max(1, Math.ceil(rows.length / pageSize)) };
  }
  if (path.startsWith("/analytics")) return demoAnalytics(Object.fromEntries(new URLSearchParams(path.split("?")[1] || "")));
  if (path.startsWith("/operations?")) {
    const query = Object.fromEntries(new URLSearchParams(path.split("?")[1]));
    const records = snapshot.operations.filter((row) => (!query.state || query.state === "all" || row.state === query.state)
      && (!query.search || [row.email, row.cdkLabel, row.id, ...(row.costOrders || []).map((item) => item.phone)].join(" ").toLowerCase().includes(query.search.toLowerCase()))
      && (!query.start || row.createdAt >= Date.parse(query.start)) && (!query.end || row.createdAt < Date.parse(query.end))
      && (row.costOrders || []).some((item) => demoMatches({ ...item, countryKey: `${item.providerId}:${item.country || snapshot.entries.find((entry) => entry.id === item.entryId)?.country || ""}` }, { ...query, start: "", end: "" })));
    const page = Number(query.page || 1); const pageSize = Number(query.pageSize || 20);
    return { items: records.slice((page - 1) * pageSize, page * pageSize), total: records.length, page, pageSize, pages: Math.max(1, Math.ceil(records.length / pageSize)), filterOptions: demoAnalytics().filterOptions, timeBasis: "operationCreatedAt" };
  }
  if (path.endsWith("/options")) return { options: quotes };
  if (path === "/rules") snapshot.rules = { ...snapshot.rules, ...body };
  else if (path === "/categories" && method === "POST") { savedCategory = { id: `preview-category-${Date.now()}`, name: body.name, fee: Number(body.fee), feeVersion: 1, enabled: body.enabled ?? true, archivedAt: null }; snapshot.categories.push(savedCategory); }
  else if (path.startsWith("/categories/") && method === "PATCH") {
    const category = snapshot.categories.find((row) => row.id === path.split("/")[2]); if (!category || category.archivedAt) throw new Error("分类不存在或已归档");
    if (body.name != null) category.name = body.name; if (body.fee != null && Number(body.fee) !== category.fee) { category.fee = Number(body.fee); category.feeVersion++; }
    if (body.enabled != null) category.enabled = body.enabled; if (body.archived === true) { category.archivedAt = Date.now(); category.enabled = false; }
    savedCategory = category;
  }
  else if (path.startsWith("/inventory/") && path.endsWith("/reconcile")) { const row = snapshot.legacyInventory.items.find((item) => item.id === path.split("/")[2]); if (row) { row.state = "closed"; row.cancelState = "confirmed"; row.canReconcile = false; row.refundStatus = body.refundEvidence ? "confirmed" : "unconfirmed"; } }
  else if (path === "/credentials") { const row = { ...body, id: body.id || `preview-cred-${Date.now()}`, hasApiKey: true }; delete row.apiKey; snapshot.credentials = [...snapshot.credentials.filter((item) => item.id !== row.id), row]; }
  else if (path === "/entries") { for (const item of body.entries) { const credential = snapshot.credentials.find((row) => row.id === item.credentialId); snapshot.entries.push({ ...item, id: `preview-${Date.now()}-${snapshot.entries.length}`, providerId: credential.providerId, credentialName: credential.name, state: "available", noStockCount: 0 }); } }
  else if (path.startsWith("/entries/")) { const row = snapshot.entries.find((item) => item.id === path.split("/")[2]); Object.assign(row, body); row.state = row.enabled ? "available" : "disabled"; if (body.resetCooldown) row.noStockCount = 0; }
  else if (path.endsWith("/reconcile")) { const row = snapshot.operations.find((item) => item.id === path.split("/")[2]); if (row) { row.state = body.action === "verified" ? "verified" : "released";
    const order = row.costOrders?.at(-1); if (order) { order.verified = body.action === "verified"; order.verifiedAt = order.verified ? Date.now() : null; order.refundExpected = !order.verified; } } }
  else throw new Error(`演示接口未实现：${method} ${path}`);
  return { ...demoSnapshot(), ...(savedCategory ? { savedCategory } : {}) };
}
function Preview() {
  const [view, setView] = useState("admin"); const [version, setVersion] = useState(0);
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [chargePreview, setChargePreview] = useState(false);
  const api = useCallback((...args) => previewApi(...args), []);
  const summary = demoPublicSummary();
  return <><div className="sp-preview-banner"><span>页面设计预览：国家、价格和记录均为演示数据，操作不会取号或扣次。</span><button onClick={() => setView(view === "admin" ? "user" : "admin")}>{view === "admin" ? "查看普通 CDK 配置" : "查看管理员页面"}</button><button onClick={() => setChargePreview(true)}>预览导入费用确认</button><button onClick={() => { snapshot = structuredClone(initial); setVersion((value) => value + 1); }}>重置演示</button></div><div className="app-shell"><aside className="app-sidebar"><div className="brand-block"><div className="brand-mark"><ShieldCheck size={19} /></div><h1>toSub2</h1></div><nav className="workspace-tabs" aria-label="预览工作区"><button onClick={() => setView("user")}><LogIn size={17} />账号授权</button><button className={view === "admin" ? "active" : ""} onClick={() => setView("admin")}><Globe2 size={17} />接码池</button><button onClick={() => setView("user")}><KeyRound size={17} />我的 CDK</button></nav><div className="sidebar-footer"><span>页面设计预览</span><p>管理员配置，普通 CDK 使用</p></div></aside><main className="workspace-content"><header className="topbar"><div className="workspace-path"><span>工作区</span><ChevronRight size={14} /><strong>{view === "admin" ? "接码池" : "接码平台配置"}</strong></div><div className="topbar-actions"><ThemeControl /></div></header>{view === "admin" ? <SmsPoolWorkspace key={version} api={api} /> : <section className="sp-preview-choice"><div className="sp-heading"><h2>接码平台配置</h2><Settings2 size={19} /></div><div className="provider-tabs"><button>自有接码平台</button><button className="active">接码池</button></div><SmsPoolChoice summary={summary} value={selectedCategoryId} onChange={setSelectedCategoryId} onManage={() => setView("admin")} /></section>}</main></div>{chargePreview && <ImportChargeDialog quote={{ count: 1, added: 1, updated: 0, charge: 1, balance: 30, after: 29, smsPool: { count: 1, fee: 2, maximum: 2, categoryId: "other", categoryName: "其他", feeVersion: 1, admin: false } }} onClose={() => setChargePreview(false)} />}</>;
}
createRoot(document.getElementById("root")).render(<Preview />);
