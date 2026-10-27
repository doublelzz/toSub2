import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useCallback, useEffect, useId, useRef, useState } from "react";
import * as icons from "lucide-react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

async function load(file, names, bindings = {}) {
  const source = await fs.readFile(new URL(file, import.meta.url), "utf8");
  const code = source.replace(/^import[^\n]+\n/gm, "").replace("export default function", "function").replace(/^export /gm, "");
  const compiled = await transformWithEsbuild(code, file, { loader: "jsx", jsx: "transform" });
  const usedIcons = Object.fromEntries([...code.matchAll(/<([A-Z]\w*)/g)].map((match) => match[1]).filter((name) => icons[name]).map((name) => [name, icons[name]]));
  const scope = { React, useCallback, useEffect, useId, useRef, useState, ...usedIcons, ...bindings };
  return new Function(...Object.keys(scope), `${compiled.code};return {${names.join(",")}};`)(...Object.values(scope));
}
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { useDialogFocus } = await load("../web/src/WorkspaceUi.jsx", ["useDialogFocus"]);
const { SmsPoolWorkspace, SmsPoolChoice } = await load("../web/src/SmsPoolWorkspace.jsx", ["SmsPoolWorkspace", "SmsPoolChoice"], { useDialogFocus, cdkFetch: async () => { throw Error("No public request expected"); } });
const { createRoot } = await import("react-dom/client"); const container = document.getElementById("root"); const root = createRoot(container);
let generation = 0;
const render = (Component, props = {}) => act(async () => root.render(React.createElement(Component, { key: ++generation, ...props })));
const field = (name) => { const element = container.querySelector(`[aria-label="${name}"]`); assert.ok(element, `Missing field ${name}`); return element; };
const button = (label, scope = container) => [...scope.querySelectorAll("button")].find((element) => element.textContent.trim() === label);
const click = (label, scope) => act(async () => { assert.ok(button(label, scope), `Missing button ${label}`); button(label, scope).click(); });
const tab = (label) => act(async () => [...container.querySelectorAll(".sp-tabs button")].find((element) => element.textContent.startsWith(label)).click());
async function fill(name, value) { const element = field(name); await act(async () => { const prototype = element.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value); element.dispatchEvent(new window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }); }
const rows = (table) => [...container.querySelectorAll(`${table} tbody tr`)];
const requestParams = (call) => new URLSearchParams(call.path.split("?")[1]);
const localDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

try {
  const summary = { byCurrency: [{ currency: "USD", confirmedPurchaseAmount: "1000000000000.45000001", confirmedOrderCount: 2, verifiedPurchaseAmount: "0", verifiedOrderCount: 1, refundUnconfirmedAmount: "0", refundUnconfirmedCount: 0 }, { currency: "RUB", confirmedPurchaseAmount: "12.3", confirmedOrderCount: 1, verifiedPurchaseAmount: "12.3", verifiedOrderCount: 1, refundUnconfirmedAmount: "0", refundUnconfirmedCount: 0 }], orderCount: 5, obtainedCount: 4, verifiedCount: 3, unknownCostCount: 1, unknownCurrencyCount: 1, unknownVerifiedCostCount: 1, unknownVerifiedCurrencyCount: 1 };
  const zeroStats = { ...summary, byCurrency: [], orderCount: 0, obtainedCount: 0, verifiedCount: 0, unknownCostCount: 0, unknownCurrencyCount: 0, unknownVerifiedCostCount: 0, unknownVerifiedCurrencyCount: 0 };
  const filterOptions = { providers: [{ providerId: "smsbower", name: "SMSBower" }, { providerId: "herosms", name: "Hero SMS" }], credentials: [{ credentialId: "cred-a", name: "Primary", providerId: "smsbower" }, { credentialId: "cred-b", name: "Backup", providerId: "herosms" }, { credentialId: "retired", name: "Retired credential", providerId: "smsbower" }], countries: [{ countryKey: "smsbower:6", country: "6", countryLabel: "Country A", providerId: "smsbower" }, { countryKey: "herosms:16", country: "16", countryLabel: "Country B", providerId: "herosms" }, { countryKey: "smsbower:90", country: "90", countryLabel: "Historical country", providerId: "smsbower" }], currencies: ["USD", "RUB"] };
  const credentials = [{ id: "cred-a", name: "Primary", providerId: "smsbower", enabled: true, hasApiKey: true, stats: summary }, { id: "cred-b", name: "Backup", providerId: "herosms", enabled: true, hasApiKey: true }];
  const rules = { enabled: true, fee: 3, noStockThreshold: 3, cooldownMinutes: 10, maxAttempts: 10, maxConcurrent: 5, buffer: { enabled: true, target: 3, lowWater: 1, perEntry: 1, refillConcurrency: 1, minRemainingSeconds: 480, idleMinutes: 10, maxOutstanding: 10, maxPerMinute: 6 } };
  const entries = [{ id: "entry-a", credentialId: "cred-a", credentialName: "Primary", providerId: "smsbower", country: "6", countryLabel: "Country A", maxPrice: "0.30", currency: "USD", state: "available", stats: summary }, { id: "entry-b", credentialId: "cred-b", credentialName: "Backup", providerId: "herosms", country: "16", countryLabel: "Country B", maxPrice: "0.50", currency: "RUB", state: "available", stats: zeroStats }, { id: "legacy", credentialId: "cred-a", providerId: "smsbower", country: "16", countryLabel: "Legacy country", maxPrice: "0.80", currency: "USD", state: "disabled" }];
  const snapshot = { rules, credentials, entries, operations: [], analyticsFilterOptions: filterOptions, costSummary: summary, buffer: { rules: rules.buffer, counts: { ready: 1, closed: 1, purchase_unknown: 1 }, items: [{ id: "ready", entryId: "entry-a", providerId: "smsbower", state: "ready", phone: "+12025550123", cost: { amount: "0", currency: "USD", source: "order" } }, { id: "closed", entryId: "entry-b", providerId: "herosms", state: "closed", phone: "+12025550124", refundStatus: "confirmed", cost: { amount: "0.5", currency: "RUB", source: "order" } }, { id: "unknown", entryId: "legacy", providerId: "smsbower", state: "purchase_unknown", phone: "+12025550125", cost: null, quote: { amount: "0.8", currency: "USD" } }] } };
  const report = { summary, byCountry: [{ countryKey: "smsbower:6", providerId: "smsbower", country: "6", countryLabel: "Country A", ...summary }], byProvider: [{ providerId: "smsbower", providerName: "SMSBower", ...summary }], byEntry: [{ entryId: "entry-a", countryKey: "smsbower:6", countryLabel: "Latest country label", providerId: "herosms", mixedRoutes: true, routeCount: 2, ...summary }, { entryId: "same-country-other-price", countryKey: "smsbower:6", countryLabel: "Country A other price", providerId: "smsbower", ...zeroStats }], filterOptions, timeBasis: "purchasedAt" };
  let reportFailure = false; let reportWaiter = null; let deferReport = false;
  const calls = [];
  const api = async (path = "", method = "GET", body) => {
    calls.push({ path, method, body });
    if (!path || path === "/buffer/warmup" || path === "/buffer/drain") return structuredClone(snapshot);
    if (path === "/rules") { snapshot.rules.buffer = { ...snapshot.rules.buffer, ...body.buffer }; snapshot.buffer.rules = snapshot.rules.buffer; return structuredClone(snapshot); }
    if (path.startsWith("/inventory?")) {
      const params = new URLSearchParams(path.split("?")[1]);
      const selected = snapshot.buffer.items.filter((row) => (params.get("scope") === "all" || (params.get("scope") === "history" ? ["closed", "consumed"].includes(row.state) : !["closed", "consumed"].includes(row.state)))
        && (!params.get("state") || row.state === params.get("state")) && (!params.get("providerId") || row.providerId === params.get("providerId"))
        && (!params.get("refundStatus") || row.refundStatus === params.get("refundStatus"))
        && (!params.get("costStatus") || params.get("costStatus") === "all" || (row.cost?.currency ? "known" : "unknown") === params.get("costStatus")));
      return { items: structuredClone(selected), page: 1, pageSize: 20, pages: 1, total: selected.length };
    }
    if (path.startsWith("/operations?")) { const params = new URLSearchParams(path.split("?")[1]); const page = Number(params.get("page")); return { items: [{ operationId: `page-${page}`, email: `page-${page}@example.invalid`, cdkLabel: "Fixture", state: "verified", fee: 3, createdAt: "2026-10-26T01:00:00Z" }], page, pageSize: 20, total: 205, pages: 11, filterOptions, timeBasis: "operationCreatedAt" }; }
    if (path.startsWith("/analytics")) { if (deferReport) return new Promise((resolve, reject) => { reportWaiter = { resolve, reject }; }); if (reportFailure) throw Error("fixture analytics offline"); return structuredClone(report); }
    throw Error(`Unexpected analytics UI request ${method} ${path}`);
  };
  await render(SmsPoolWorkspace, { api });
  await tab("国家报价");
  assert.match(container.querySelector(".sp-cost-heading").textContent, /全部历史服务商成本.*不受下方筛选影响/);
  assert.equal(calls.some((row) => row.path.startsWith("/analytics")), false, "reports load only when their tab is open");
  assert.equal(rows(".sp-entry-table").length, 3);
  assert.match(rows(".sp-entry-table")[0].textContent, /1000000000000\.45000001 USD12\.3 RUB/);
  assert.match(rows(".sp-entry-table")[0].textContent, /取号 4 个 · 验证通过 3 个/);
  assert.match(rows(".sp-entry-table")[0].textContent, /币种未知 1 个订单/);
  assert.match(rows(".sp-entry-table")[2].textContent, /统计未记录/);
  assert.doesNotMatch(rows(".sp-entry-table")[2].textContent, /取号 0/);
  await fill("报价取号记录", "yes"); assert.equal(rows(".sp-entry-table").length, 1);
  await fill("报价取号记录", "no"); assert.match(rows(".sp-entry-table")[0].textContent, /Country B/); assert.equal(rows(".sp-entry-table").length, 1, "missing legacy statistics never mean zero acquired numbers");
  await click("清除报价筛选");
  await fill("报价最低价格上限", "0.4"); await fill("报价最高价格上限", "0.6"); assert.equal(rows(".sp-entry-table").length, 1); assert.match(rows(".sp-entry-table")[0].textContent, /Country B/);
  await click("清除报价筛选"); await fill("报价服务商", "smsbower"); await fill("报价国家", "smsbower:6"); await fill("报价凭据", "cred-a"); assert.equal(rows(".sp-entry-table").length, 1);
  await fill("报价服务商", "herosms"); assert.equal(field("报价国家").value, ""); assert.equal(field("报价凭据").value, ""); assert.match(rows(".sp-entry-table")[0].textContent, /Country B/);
  await tab("设置"); assert.match(container.querySelector(".sp-credential-row").textContent, /1000000000000\.45000001 USD/); assert.match(container.querySelectorAll(".sp-credential-row")[1].textContent, /统计未记录/);

  await tab("号码库存"); await click("全部号码"); assert.equal(rows(".sp-buffer-table").length, 3);
  await fill("缓冲金额状态", "unknown"); assert.equal(rows(".sp-buffer-table").length, 1); assert.match(rows(".sp-buffer-table")[0].textContent, /购号待核实/);
  await click("清除库存筛选"); await fill("缓冲退款状态", "confirmed"); assert.equal(rows(".sp-buffer-table").length, 1); assert.match(rows(".sp-buffer-table")[0].textContent, /Hero SMS/);
  await click("清除库存筛选"); await fill("缓冲库存状态", "ready"); await fill("缓冲服务商", "smsbower"); assert.equal(rows(".sp-buffer-table").length, 1); assert.match(rows(".sp-buffer-table")[0].textContent, /0 USD/);
  await click("立即补满"); assert.ok(calls.some((row) => row.path === "/buffer/warmup" && row.method === "POST")); assert.equal(field("缓冲库存状态").value, "ready");

  await tab("接码记录"); assert.equal(field("接码记录国家").querySelector('option[value="smsbower:90"]').textContent.includes("Historical country"), true);
  await click("下一页"); assert.equal(requestParams(calls.findLast((row) => row.path.startsWith("/operations?"))).get("page"), "2");
  await fill("接码记录服务商", "smsbower"); await fill("接码记录国家", "smsbower:90"); await fill("接码记录凭据", "retired"); await fill("接码记录状态", "verified"); await fill("接码记录结果", "verified"); await fill("接码记录金额状态", "known"); await fill("接码记录币种", "USD"); await fill("接码记录搜索", "name@example.invalid");
  let params = requestParams(calls.findLast((row) => row.path.startsWith("/operations?")));
  assert.equal(params.get("page"), "1", "filter changes reset server pagination");
  for (const [key, value] of Object.entries({ providerId: "smsbower", country: "smsbower:90", credentialId: "retired", state: "verified", result: "verified", costStatus: "known", currency: "USD", search: "name@example.invalid" })) assert.equal(params.get(key), value);
  await fill("接码记录开始日期", "2026-10-25"); await fill("接码记录结束日期", "2026-10-26");
  params = requestParams(calls.findLast((row) => row.path.startsWith("/operations?"))); assert.equal(params.get("start"), new Date("2026-10-25T00:00:00").toISOString()); assert.equal(params.get("end"), new Date("2026-10-27T00:00:00").toISOString());
  await click("下一页"); params = requestParams(calls.findLast((row) => row.path.startsWith("/operations?"))); assert.equal(params.get("page"), "2"); assert.equal(params.get("country"), "smsbower:90");
  const beforeInvalidOperations = calls.length; await fill("接码记录开始日期", "2026-10-28"); assert.equal(calls.length, beforeInvalidOperations); assert.equal(rows(".sp-operation-table").length, 0); assert.match(field("接码记录筛选").textContent, /开始日期不能晚于结束日期/);

  await tab("成本统计"); assert.equal(calls.findLast((row) => row.path.startsWith("/analytics")).path, "/analytics"); assert.match(field("筛选范围取号统计").textContent, /成功取到号码4 个手机验证通过3 个/);
  assert.match(container.querySelector(".sp-analytics .sp-cost-heading").textContent, /筛选范围服务商成本.*仅统计当前筛选范围/);
  assert.match(container.querySelector(".sp-analytics-table").textContent, /1000000000000\.45000001 USD12\.3 RUB/); assert.match(container.querySelector(".sp-analytics-table").textContent, /0 USD/); assert.match(container.querySelector(".sp-analytics-table").textContent, /通过号码币种未知 1 个/);
  await click("按服务商"); assert.match(rows(".sp-analytics-table")[0].textContent, /SMSBower/);
  await click("按报价条目"); assert.equal(rows(".sp-analytics-table").length, 2, "same-country price entries have independent React keys"); assert.match(rows(".sp-analytics-table")[0].textContent, /历史多路由2 条历史路由/); assert.doesNotMatch(rows(".sp-analytics-table")[0].textContent, /Latest country label|Hero SMS/); assert.match(rows(".sp-analytics-table")[1].textContent, /Country A other price/);
  await click("按国家"); assert.equal(rows(".sp-analytics-table").length, 1); await click("按报价条目"); assert.equal(rows(".sp-analytics-table").length, 2); assert.match(rows(".sp-analytics-table")[1].textContent, /0 \/ 0/);
  await fill("成本统计服务商", "smsbower"); await fill("成本统计国家", "smsbower:90"); await fill("成本统计凭据", "retired"); await fill("成本统计结果", "verified"); await fill("成本统计币种", "USD"); await fill("成本统计金额状态", "known");
  params = requestParams(calls.findLast((row) => row.path.startsWith("/analytics"))); for (const [key, value] of Object.entries({ providerId: "smsbower", country: "smsbower:90", credentialId: "retired", result: "verified", currency: "USD", costStatus: "known" })) assert.equal(params.get(key), value);
  await click("今天", field("成本统计筛选")); params = requestParams(calls.findLast((row) => row.path.startsWith("/analytics"))); const today = new Date(); const tomorrow = new Date(`${localDate(today)}T00:00:00`); tomorrow.setDate(tomorrow.getDate() + 1); assert.equal(params.get("start"), new Date(`${localDate(today)}T00:00:00`).toISOString()); assert.equal(params.get("end"), tomorrow.toISOString());
  await fill("成本统计开始日期", "2026-10-25"); await fill("成本统计结束日期", "2026-10-26"); const beforeInvalidAnalytics = calls.length; await fill("成本统计开始日期", "2026-10-28"); assert.equal(calls.length, beforeInvalidAnalytics); assert.equal(container.querySelector(".sp-analytics-table"), null); assert.match(field("成本统计筛选").textContent, /开始日期不能晚于结束日期/);
  await click("清除筛选", field("成本统计筛选"));
  deferReport = true; await click("刷新统计"); assert.equal(container.querySelector(".sp-analytics-table"), null, "old report is cleared while loading"); assert.match(container.querySelector(".sp-analytics").textContent, /正在读取全量成本统计/); assert.equal(field("成本统计国家").value, ""); assert.ok(field("成本统计国家").querySelector('option[value="smsbower:90"]'), "historical filter options survive report refresh");
  await act(async () => reportWaiter.reject(Error("fixture deferred offline"))); assert.equal(container.querySelector(".sp-analytics-table"), null); assert.match(container.querySelector(".sp-analytics").textContent, /fixture deferred offline/);
  deferReport = false; await click("重新读取统计"); assert.equal(rows(".sp-analytics-table").length, 2);
  reportFailure = true; await fill("成本统计结果", "unverified"); assert.equal(container.querySelector(".sp-analytics-table"), null); assert.match(container.querySelector(".sp-analytics").textContent, /fixture analytics offline/);
  reportFailure = false; await click("重新读取统计"); assert.equal(rows(".sp-analytics-table").length, 2);

  await render(SmsPoolChoice, { summary: { enabled: true, available: true, status: "ready", fee: 3, hasNumbers: true, costSummary: summary, analytics: report, entries, credentials } });
  assert.doesNotMatch(container.textContent, /USD|RUB|Country|SMSBower|Hero SMS|Primary|服务商成本|购号金额|成功取号/);
  console.log("SMS pool analytics UI passed (combined quote/inventory filters, exact per-entry/provider totals, historical options, server history filtering and pagination, local date bounds, success-cost grouping, stale/error retry and ordinary CDK privacy)");
} finally { await act(() => root.unmount()); dom.window.close(); }
