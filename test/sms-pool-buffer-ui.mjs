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
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator"); const copied = [];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "fixture", clipboard: { writeText: async (value) => copied.push(value) } } });
const { useDialogFocus } = await load("../web/src/WorkspaceUi.jsx", ["useDialogFocus"]);
let publicRequest = async () => { throw Error("Public fixture must supply a summary"); };
const { SmsPoolWorkspace, SmsPoolChoice } = await load("../web/src/SmsPoolWorkspace.jsx", ["SmsPoolWorkspace", "SmsPoolChoice"], { useDialogFocus, cdkFetch: (...args) => publicRequest(...args) });
const { createRoot } = await import("react-dom/client"); const container = document.getElementById("root"); const root = createRoot(container);
let generation = 0;
const render = (Component, props = {}) => act(async () => root.render(React.createElement(Component, { key: ++generation, ...props })));
const button = (label) => [...container.querySelectorAll("button")].find((element) => element.textContent.trim() === label);
const click = (label) => act(async () => { assert.ok(button(label), `Missing button: ${label}`); button(label).click(); });
async function fill(label, value) { await act(async () => { const element = container.querySelector(`[aria-label="${label}"]`); assert.ok(element, label); const prototype = element.tagName === "SELECT" ? window.HTMLSelectElement.prototype : element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value); element.dispatchEvent(new window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }); }
const inventoryRows = () => [...container.querySelectorAll(".sp-buffer-table tbody tr")];
const rules = { enabled: true, fee: 3, noStockThreshold: 3, cooldownMinutes: 10, maxAttempts: 10, requestConcurrency: 3 };
const ready = { id: "ready", entryId: "entry-a", providerId: "smsbower", state: "ready", phone: "+12025550123", country: "6", countryLabel: "Purchase snapshot country", expiresAt: Date.now() + 900000, expiresSource: "provider", cost: { amount: "0", currency: "USD", source: "order" } };

try {
  for (const [summary, expected] of [[{ status: "available_on_demand", available: true }, "可按需取号"], [{ status: "unavailable", available: false }, "暂不可用"]]) {
    await render(SmsPoolChoice, { value: "other", summary: { enabled: true, categories: [{ id: "other", name: "其他", enabled: true, fee: 3, ...summary }], countries: ["private-country"], availableEntries: 99 } });
    assert.match(container.querySelector(".sp-choice-heading .sp-state").textContent, new RegExp(expected));
    assert.match(container.textContent, /按需取号/);
    assert.doesNotMatch(container.textContent, /库存|现货|补货|国家|条目|private-country|SMSBower|99/);
  }
  await render(SmsPoolChoice, { value: "other", summary: { enabled: true, categories: [] } }); assert.match(container.textContent, /请重新选择/);
  await render(SmsPoolChoice, { value: "other", summary: { enabled: false, categories: [{ id: "other", name: "其他", enabled: true, fee: 3 }] } }); assert.match(container.textContent, /暂未开放/);
  publicRequest = async () => { throw Error("fixture pool offline"); };
  await render(SmsPoolChoice, { value: "other", token: "fixture" }); assert.match(container.textContent, /读取失败/); assert.match(container.textContent, /接码池状态未知/);

  let snapshot = { categories: [{ id: "other", name: "其他", enabled: true, fee: 3, feeVersion: 1 }], rules: structuredClone(rules), credentials: [], entries: [{ id: "entry-a", categoryId: "other", countryLabel: "Edited current country" }], operations: [], legacyInventory: { counts: { ready: 1, purchasing: 1, assigned: 1, closed: 1 },
    progress: { state: "waiting", target: 3, ready: 1, purchasing: 1, checking: 0, remaining: 1, reason: "no_stock", nextRetryAt: Date.now() + 5000, failures: [{ entryId: "no-stock", providerId: "smsbower", countryLabel: "Empty route", kind: "no_stock", count: 5 }] },
    items: [ready, { ...ready, id: "assigned", phone: "+12025550124", state: "assigned" }, { ...ready, id: "closed", phone: "+12025550125", state: "closed", cancelState: "confirmed", refundStatus: "unconfirmed", retirementReason: "legacy_inventory_retired" }, { id: "unknown-attempt", state: "purchase_unknown", phone: null, canReconcile: true }] } };
  const calls = []; let inventoryFailure = false; let deferredInventory = false; let finishInventory;
  const page = (path) => { const query = new URLSearchParams(path.split("?")[1]); const all = snapshot.legacyInventory.items.filter((row) => Boolean(row.phone) && (query.get("scope") === "all" || (query.get("scope") === "history" ? ["closed", "consumed"].includes(row.state) : !["closed", "consumed"].includes(row.state))) && (!query.get("state") || row.state === query.get("state")) && (!query.get("providerId") || row.providerId === query.get("providerId")) && (!query.get("search") || `${row.phone} ${row.countryLabel}`.includes(query.get("search")))); const number = Number(query.get("page")); return { items: structuredClone(all.slice((number - 1) * 20, number * 20)), total: all.length, page: number, pageSize: 20, pages: Math.max(1, Math.ceil(all.length / 20)) }; };
  const api = async (path = "", method = "GET", body) => {
    calls.push({ path, method, body });
    if (path.startsWith("/inventory?")) { if (inventoryFailure) throw Error("fixture inventory offline"); if (deferredInventory) return new Promise((resolve) => { finishInventory = () => resolve(page(path)); }); return page(path); }
    if (path === "/inventory/unknown-attempt/reconcile") snapshot.legacyInventory.items = snapshot.legacyInventory.items.map((row) => row.id === "unknown-attempt" ? { ...row, state: "closed", canReconcile: false, refundStatus: "unconfirmed" } : row);
    if (path === "/buffer/drain") snapshot.legacyInventory.items = snapshot.legacyInventory.items.map((row) => row.state === "ready" ? { ...row, state: "cancel_pending" } : row);
    return structuredClone(snapshot);
  };
  await render(SmsPoolWorkspace, { api });
  assert.ok(container.querySelector('.sp-tabs button[aria-pressed="true"]').textContent.startsWith("国家报价"));
  assert.equal(calls.some((row) => row.path.startsWith("/inventory")), false, "legacy inventory does not load in the main workflow");
  assert.doesNotMatch(container.textContent, /缓冲目标|自动补满|立即补满|暂停补号|号码库存/);
  await act(() => [...container.querySelectorAll(".sp-tabs button")].find((element) => element.textContent === "设置").click());
  const legacy = container.querySelector(".sp-legacy-orders"); assert.equal(legacy.open, false);
  await act(async () => { legacy.open = true; legacy.dispatchEvent(new window.Event("toggle", { bubbles: true })); });
  assert.equal(container.querySelector(".sp-buffer-controls"), null);
  assert.equal(inventoryRows().length, 2, "default inventory omits historical rows and attempts without numbers");
  assert.match(inventoryRows()[0].textContent, /\+12025550123/); assert.match(inventoryRows()[0].textContent, /Purchase snapshot country/); assert.doesNotMatch(inventoryRows()[0].textContent, /Edited current country/);
  assert.match(inventoryRows()[0].textContent, /0 USD平台确认购号金额/);
  assert.match(container.querySelector(".sp-pending-inventory").textContent, /待处理订单 1/);
  await click("核实订单"); assert.equal(button("确认结束订单").disabled, true);
  await fill("旧订单核实依据", "Provider confirms the purchase never created an active order");
  assert.equal(button("确认结束订单").disabled, true, "a note alone cannot settle a possibly active order");
  await act(async () => container.querySelector('.sp-dialog input[type="checkbox"]').click()); await click("确认结束订单");
  assert.deepEqual(calls.find((row) => row.path === "/inventory/unknown-attempt/reconcile").body, { action: "close", note: "Provider confirms the purchase never created an active order" });
  assert.equal(container.querySelector(".sp-pending-inventory"), null, "orders without a confirmed phone can be reconciled without putting them in the number table");
  assert.equal(inventoryRows().length, 2);
  const copyButton = [...container.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === "复制号码 +12025550123");
  assert.ok(copyButton, [...container.querySelectorAll("button[aria-label]")].map((element) => element.getAttribute("aria-label")).join(","));
  await act(async () => copyButton.click()); assert.deepEqual(copied, ["+12025550123"]);
  await click("回收未分配旧号码"); assert.equal(calls.filter((row) => row.path === "/buffer/drain").length, 1);
  assert.equal(calls.some((row) => ["/buffer/warmup", "/buffer/pause"].includes(row.path)), false, "legacy recovery never starts a pre-purchase job");
  await click("历史号码"); assert.equal(inventoryRows().length, 1); assert.match(inventoryRows()[0].textContent, /0125/); assert.match(inventoryRows()[0].textContent, /取消已确认.*退款待核实/); assert.match(inventoryRows()[0].textContent, /处理原因：已切换为按需取号/); assert.match(inventoryRows()[0].querySelector('[data-label="有效期"]').textContent, /订单已结束.*原有效期/); assert.doesNotMatch(inventoryRows()[0].querySelector('[data-label="有效期"]').textContent, /分 \d+ 秒/);
  assert.equal(new URLSearchParams(calls.findLast((row) => row.path.startsWith("/inventory?")).path.split("?")[1]).get("scope"), "history");
  inventoryFailure = true; await click("当前号码"); assert.equal(inventoryRows().length, 0); assert.match(container.textContent, /fixture inventory offline/);
  inventoryFailure = false; await click("重新读取库存"); assert.equal(inventoryRows().length, 2);
  snapshot.legacyInventory.items = Array.from({ length: 41 }, (_, index) => ({ ...ready, id: `page-${index}`, phone: `+1202555${String(100 + index).padStart(4, "0")}` }));
  await click("刷新"); assert.equal(inventoryRows().length, 20); await click("下一页"); assert.match(inventoryRows()[0].textContent, /0120/);
  await fill("旧订单状态", "ready"); assert.match(inventoryRows()[0].textContent, /0100/); assert.equal(new URLSearchParams(calls.findLast((row) => row.path.startsWith("/inventory?")).path.split("?")[1]).get("page"), "1");

  console.log("SMS pool inventory UI passed (on-demand choice privacy, no pre-purchase controls, secondary legacy entry, full admin numbers/copy, purchase snapshots, reconciliation and history pagination)");
} finally { await act(() => root.unmount()); dom.window.close(); if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else delete globalThis.navigator; }
