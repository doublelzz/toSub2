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
const { SmsPoolWorkspace, SmsPoolChoice, SmsOrderCost, PoolCostSummary } = await load("../web/src/SmsPoolWorkspace.jsx", ["SmsPoolWorkspace", "SmsPoolChoice", "SmsOrderCost", "PoolCostSummary"], { useDialogFocus, cdkFetch: async () => { throw Error("No public request expected"); } });
const { createRoot } = await import("react-dom/client"); const container = document.getElementById("root"); const root = createRoot(container);
let generation = 0;
const render = (Component, props = {}) => act(async () => root.render(React.createElement(Component, { key: ++generation, ...props })));
const tab = (label) => act(async () => [...container.querySelectorAll(".sp-tabs button")].find((element) => element.textContent.startsWith(label)).click());
const button = (label) => [...container.querySelectorAll("button")].find((element) => element.textContent.trim() === label);

try {
  const costSummary = { byCurrency: [{ currency: "USD", confirmedPurchaseAmount: "0", confirmedOrderCount: 1, refundUnconfirmedAmount: "0", refundUnconfirmedCount: 1 }, { currency: "RUB", confirmedPurchaseAmount: "1000000000000.45000001", confirmedOrderCount: 2, refundUnconfirmedAmount: "1000000000000", refundUnconfirmedCount: 1 }], unknownCostCount: 2, unknownCurrencyCount: 1, orderCount: 6 };
  const costOrders = [{ orderId: "free-order", credentialId: "cred-a", verified: true, verifiedAt: "2026-10-25T01:05:00Z", state: "verified", providerId: "smsbower", providerName: "SMSBower", countryLabel: "Country A", phone: "+12025550123", cost: { amount: "0", currency: "USD", source: "order" }, refundStatus: "unconfirmed", createdAt: "2026-10-25T01:00:00Z" },
    { orderId: "quoted-order", credentialId: "cred-b", verified: false, state: "abandoned", providerId: "herosms", providerName: "Hero SMS", countryLabel: "Country B", phone: "******0124", cost: null, quote: { amount: "0.25", currency: "USD" }, maxPrice: { amount: "0.30", currency: "USD" }, refundStatus: "unconfirmed", refundExpected: true },
    { orderId: "free-order", credentialId: "cred-b", verified: false, state: "released", providerId: "smsbower", phone: "******0125", cost: { amount: "123.45000001", currency: "RUB", source: "order" }, refundStatus: "confirmed" }];
  const operation = { operationId: "op-cost", cdkId: "owner-a", cdkLabel: "Fixture CDK", email: "cost@example.invalid", state: "verified", fee: 3, attempts: 5, costOrders, cost: costOrders[2].cost, quote: null, maxPrice: { amount: "130", currency: "RUB" }, createdAt: "2026-10-25T01:00:00Z" };
  const bufferRules = { enabled: true, target: 3, lowWater: 1, perEntry: 1, refillConcurrency: 1, minRemainingSeconds: 480, idleMinutes: 10, maxOutstanding: 10, maxPerMinute: 6 };
  let snapshot = { categories: [{ id: "other", name: "其他", enabled: true, fee: 3, feeVersion: 1 }], rules: { enabled: true, fee: 3, noStockThreshold: 3, cooldownMinutes: 10, maxAttempts: 10, requestConcurrency: 3 }, credentials: [], entries: [], operations: [operation], costSummary,
    legacyInventory: { counts: {}, items: [{ id: "zero", state: "closed", providerId: "smsbower", phone: "******0123", cost: costOrders[0].cost, cancelState: "confirmed", refundStatus: "unconfirmed" },
      { id: "quoted", state: "ready", providerId: "herosms", phone: "******0124", quote: costOrders[1].quote, maxPrice: costOrders[1].maxPrice },
      { id: "legacy", state: "ready", providerId: "herosms", phone: "******0126", maxPrice: "0.40", currency: "USD" },
      { id: "unknown-currency", state: "ready", providerId: "smsbower", phone: "+12025550127", cost: { amount: "1.2", currency: null, source: "order" } }] } };
  let offline = false;
  const api = async (path = "") => { if (offline) throw Error("fixture cost service offline"); return path.startsWith("/operations?") ? { items: [operation], page: 1, pageSize: 20, pages: 1, total: 1 } : structuredClone(snapshot); };
  await render(PoolCostSummary, { summary: costSummary });
  const summary = container.querySelector('[aria-label="管理员服务商成本"]');
  assert.equal(summary.querySelectorAll(".sp-cost-currency").length, 2);
  assert.match(summary.querySelector(".sp-cost-currency").textContent, /已确认购号金额 0 USD/);
  assert.match(summary.textContent, /1000000000000\.45000001 RUB/, "aggregate amounts can exceed a single order's amount limit without losing precision");
  assert.match(summary.textContent, /退款待核实 1000000000000 RUB/);
  assert.match(summary.textContent, /金额未知订单 2/); assert.match(summary.textContent, /币种未知订单 1/);
  assert.match(summary.textContent, /不代表最终净成本/);

  await render(SmsPoolWorkspace, { api });
  await tab("设置");
  const legacy = container.querySelector(".sp-legacy-orders");
  await act(async () => { legacy.open = true; legacy.dispatchEvent(new window.Event("toggle", { bubbles: true })); });
  await act(async () => button("全部号码").click());
  const bufferRows = [...container.querySelectorAll(".sp-buffer-table tbody tr")];
  assert.match(bufferRows[0].querySelector('[data-label="号码费用"]').textContent, /0 USD平台确认购号金额/);
  assert.match(bufferRows[0].textContent, /取消已确认/); assert.match(bufferRows[0].textContent, /退款待核实/);
  assert.match(bufferRows[1].querySelector('[data-label="号码费用"]').textContent, /金额待确认报价 0\.25 USD最高价 0\.30 USD/);
  assert.doesNotMatch(bufferRows[1].querySelector('[data-label="号码费用"]').textContent, /平台确认/);
  assert.match(bufferRows[2].querySelector('[data-label="号码费用"]').textContent, /金额待确认最高价 0\.40 USD/);
  assert.match(bufferRows[3].querySelector('[data-label="号码费用"]').textContent, /平台金额 1\.2，币种未确认/);

  await tab("取号记录");
  const row = container.querySelector(".sp-operation-table tbody tr");
  assert.equal(row.querySelector('[data-label="CDK 扣次"]').textContent.trim(), "3 次");
  assert.match(row.querySelector('[data-label="服务商费用"]').textContent, /123\.45000001 RUB/);
  assert.match(row.querySelector('[data-label="服务商费用"]').textContent, /取号尝试 5 次，号码订单 3 个/);
  const details = row.querySelector("details.sp-cost-orders");
  await act(() => details.querySelector("summary").click());
  assert.equal(details.open, true); assert.equal(details.querySelectorAll("li").length, 3);
  assert.match(details.querySelector("li:first-child").textContent, /0 USD/);
  assert.match(details.querySelector("li:first-child").textContent, /验证成功/); assert.match(details.querySelector("li:first-child").textContent, /2026\/10\/25 09:05:00 · 北京时间/);
  assert.doesNotMatch(details.querySelector("li:first-child").textContent, /退款/, "successful consumed orders must not imply a pending refund");
  assert.match(details.querySelectorAll("li")[1].textContent, /金额待确认/); assert.match(details.querySelectorAll("li")[1].textContent, /已换号 · 未成功/);
  assert.match(details.querySelectorAll("li")[1].textContent, /退款待核实/);
  assert.match(details.querySelectorAll("li")[2].textContent, /退款已确认/); assert.match(details.querySelectorAll("li")[2].textContent, /已释放 · 未成功/); assert.equal(details.querySelectorAll(".sp-order-verified").length, 1);
  assert.doesNotMatch(details.textContent, /\+12025550123/);

  offline = true;
  await act(async () => button("刷新").click());
  assert.match(container.querySelector('[aria-label="今日取号概览"]').textContent, /统计未记录/);
  assert.doesNotMatch(container.querySelector('[aria-label="今日取号概览"]').textContent, /123\.45000001/);
  await render(PoolCostSummary, { summary: costSummary, stale: true });
  assert.match(container.querySelector('[aria-label="管理员服务商成本"]').textContent, /成本状态未知/);
  assert.equal(container.querySelectorAll(".sp-cost-currency").length, 0);
  await render(PoolCostSummary, {});
  assert.match(container.querySelector('[aria-label="管理员服务商成本"]').textContent, /成本数据尚未记录/);
  assert.doesNotMatch(container.querySelector('[aria-label="管理员服务商成本"]').textContent, /已确认购号金额 0|金额未知订单 0/);

  await render(SmsOrderCost, { order: { cost: { amount: "0.10", currency: "USD", source: "quote" }, quote: { amount: "0.1", currency: "USD" } } });
  assert.match(container.textContent, /金额待确认报价 0\.1 USD/); assert.doesNotMatch(container.textContent, /平台确认/);
  await render(SmsPoolChoice, { value: "other", summary: { enabled: true, available: true, status: "ready", fee: 3, hasNumbers: true, costSummary, costOrders, cost: { amount: "999.25", currency: "RUB", source: "order" } } });
  assert.doesNotMatch(container.textContent, /USD|RUB|999\.25|服务商成本|购号金额|报价|退款|Country/);
  assert.equal(container.querySelector('[aria-label="管理员服务商成本"]'), null);
  console.log("SMS pool cost UI passed (admin exact zero/mixed currencies, unknown versus quote/max price, per-number details, stale/legacy data and ordinary CDK privacy)");
} finally { await act(() => root.unmount()); dom.window.close(); }
