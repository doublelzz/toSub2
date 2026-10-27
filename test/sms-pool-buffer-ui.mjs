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
const rules = { enabled: true, fee: 3, noStockThreshold: 3, cooldownMinutes: 10, maxAttempts: 10, maxConcurrent: 5, buffer: { enabled: false, forceRefill: false, target: 3, lowWater: 1, perEntry: 1, refillConcurrency: 1, minRemainingSeconds: 480, idleMinutes: 10, maxOutstanding: 10, maxPerMinute: 6 } };
const ready = { id: "ready", entryId: "entry-a", providerId: "smsbower", state: "ready", phone: "+12025550123", country: "6", countryLabel: "Purchase snapshot country", expiresAt: Date.now() + 900000, expiresSource: "provider", cost: { amount: "0", currency: "USD", source: "order" } };

try {
  for (const [summary, expected] of [[{ status: "ready", hasNumbers: true }, "有号码"], [{ status: "fetching", hasNumbers: false }, "正在补货"], [{ status: "available_on_demand", hasNumbers: false }, "可即时取号"], [{ status: "unavailable", hasNumbers: false }, "暂无号码"]]) {
    await render(SmsPoolChoice, { summary: { enabled: true, available: true, fee: 3, countries: ["private-country"], availableEntries: 99, ...summary } });
    assert.match(container.querySelector(".sp-choice-heading .sp-state").textContent, new RegExp(expected));
    assert.doesNotMatch(container.textContent, /国家|条目|private-country|SMSBower|99/);
  }
  await render(SmsPoolChoice, { summary: { enabled: true, available: true, fee: 3 } }); assert.match(container.textContent, /状态未知/);
  await render(SmsPoolChoice, { summary: { enabled: false, available: true, fee: 3, status: "ready" } }); assert.match(container.textContent, /暂未开放/);
  publicRequest = async () => { throw Error("fixture pool offline"); };
  await render(SmsPoolChoice, { token: "fixture" }); assert.match(container.textContent, /读取失败/); assert.match(container.textContent, /号码状态未知/);

  let snapshot = { rules: structuredClone(rules), credentials: [], entries: [{ id: "entry-a", countryLabel: "Edited current country" }], operations: [], buffer: { rules: structuredClone(rules.buffer), counts: { ready: 1, purchasing: 1, assigned: 1, closed: 1 },
    progress: { state: "waiting", target: 3, ready: 1, purchasing: 1, checking: 0, remaining: 1, reason: "no_stock", nextRetryAt: Date.now() + 5000, failures: [{ entryId: "no-stock", providerId: "smsbower", countryLabel: "Empty route", kind: "no_stock", count: 5 }] },
    items: [ready, { ...ready, id: "assigned", phone: "+12025550124", state: "assigned" }, { ...ready, id: "closed", phone: "+12025550125", state: "closed", cancelState: "confirmed", refundStatus: "unconfirmed" }, { id: "unknown-attempt", state: "purchase_unknown", phone: null, canReconcile: true }] } };
  const calls = []; let inventoryFailure = false; let deferredInventory = false; let finishInventory;
  const page = (path) => { const query = new URLSearchParams(path.split("?")[1]); const all = snapshot.buffer.items.filter((row) => Boolean(row.phone) && (query.get("scope") === "all" || (query.get("scope") === "history" ? ["closed", "consumed"].includes(row.state) : !["closed", "consumed"].includes(row.state))) && (!query.get("state") || row.state === query.get("state")) && (!query.get("providerId") || row.providerId === query.get("providerId")) && (!query.get("search") || `${row.phone} ${row.countryLabel}`.includes(query.get("search")))); const number = Number(query.get("page")); return { items: structuredClone(all.slice((number - 1) * 20, number * 20)), total: all.length, page: number, pageSize: 20, pages: Math.max(1, Math.ceil(all.length / 20)) }; };
  const api = async (path = "", method = "GET", body) => {
    calls.push({ path, method, body });
    if (path.startsWith("/inventory?")) { if (inventoryFailure) throw Error("fixture inventory offline"); if (deferredInventory) return new Promise((resolve) => { finishInventory = () => resolve(page(path)); }); return page(path); }
    if (path === "/rules") { snapshot.rules = { ...snapshot.rules, ...body, buffer: { ...snapshot.rules.buffer, ...body.buffer } }; snapshot.buffer.rules = { ...snapshot.rules.buffer }; }
    if (path === "/buffer/warmup") snapshot.buffer.progress.state = "filling";
    if (path === "/inventory/unknown-attempt/reconcile") snapshot.buffer.items = snapshot.buffer.items.map((row) => row.id === "unknown-attempt" ? { ...row, state: "closed", canReconcile: false, refundStatus: "unconfirmed" } : row);
    if (path === "/buffer/pause" || path === "/buffer/drain") { snapshot.rules.buffer.forceRefill = false; snapshot.buffer.rules.forceRefill = false; snapshot.buffer.progress.state = "paused"; snapshot.buffer.progress.reason = ""; }
    return structuredClone(snapshot);
  };
  await render(SmsPoolWorkspace, { api });
  assert.equal(container.querySelector('.sp-tabs button[aria-pressed="true"]').textContent.trim(), "号码库存1");
  assert.equal(container.querySelectorAll(".sp-buffer-controls input").length, 2, "daily replenishment has only an automatic switch and a target");
  assert.equal(container.querySelector('[aria-label="缓冲补货水位"]'), null); assert.equal(container.querySelector('[aria-label="缓冲每条报价最多"]'), null);
  assert.equal(inventoryRows().length, 2, "default inventory omits historical rows and attempts without numbers");
  assert.match(inventoryRows()[0].textContent, /\+12025550123/); assert.match(inventoryRows()[0].textContent, /Purchase snapshot country/); assert.doesNotMatch(inventoryRows()[0].textContent, /Edited current country/);
  assert.match(inventoryRows()[0].textContent, /0 USD平台确认购号金额/); assert.match(container.querySelector(".sp-refill-summary").textContent, /本轮报价暂时无号/);
  assert.equal(container.querySelectorAll(".sp-refill-details:not(.sp-pending-inventory) li").length, 1, "repeated no-stock reports are grouped rather than rendered five times");
  assert.match(container.querySelector(".sp-pending-inventory").textContent, /待处理订单 1/);
  await click("核实订单"); assert.equal(button("确认结束订单").disabled, true);
  await fill("库存核实依据", "Provider confirms the purchase never created an active order");
  assert.equal(button("确认结束订单").disabled, true, "a note alone cannot settle a possibly active order");
  await act(async () => container.querySelector('.sp-dialog input[type="checkbox"]').click()); await click("确认结束订单");
  assert.deepEqual(calls.find((row) => row.path === "/inventory/unknown-attempt/reconcile").body, { action: "close", note: "Provider confirms the purchase never created an active order" });
  assert.equal(container.querySelector(".sp-pending-inventory"), null, "orders without a confirmed phone can be reconciled without putting them in the number table");
  assert.equal(inventoryRows().length, 2);
  const copyButton = [...container.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === "复制号码 +12025550123");
  assert.ok(copyButton, [...container.querySelectorAll("button[aria-label]")].map((element) => element.getAttribute("aria-label")).join(","));
  await act(async () => copyButton.click()); assert.deepEqual(copied, ["+12025550123"]);
  const mutationsBeforeDraft = calls.filter((row) => row.method !== "GET").length;
  await fill("缓冲目标数量", "21"); assert.equal(button("保存补号设置").disabled, true); assert.equal(button("立即补满").disabled, true);
  await fill("缓冲目标数量", "10"); await act(() => container.querySelector('[aria-label="自动补满号码"]').click());
  assert.equal(calls.filter((row) => row.method !== "GET").length, mutationsBeforeDraft, "editing a draft does not buy or save anything");
  await click("保存补号设置"); assert.deepEqual(calls.find((row) => row.path === "/rules").body, { buffer: { enabled: true, forceRefill: true, target: 10 } });
  await click("立即补满"); assert.equal(calls.filter((row) => row.path === "/buffer/warmup").length, 1); assert.match(container.querySelector(".sp-buffer-heading").textContent, /正在补满库存/);
  await click("暂停补号"); assert.equal(calls.filter((row) => row.path === "/buffer/pause").length, 1); assert.equal(inventoryRows().length, 2); assert.match(container.textContent, /已有号码继续保留/);
  assert.equal(container.querySelector('[aria-label="自动补满号码"]').checked, false);
  await click("回收未分配号码"); assert.equal(calls.filter((row) => row.path === "/buffer/drain").length, 1); assert.match(container.textContent, /已暂停自动补满并请求回收/);
  await click("历史号码"); assert.equal(inventoryRows().length, 1); assert.match(inventoryRows()[0].textContent, /0125/); assert.match(inventoryRows()[0].textContent, /取消已确认.*退款待核实/);
  assert.equal(new URLSearchParams(calls.findLast((row) => row.path.startsWith("/inventory?")).path.split("?")[1]).get("scope"), "history");
  inventoryFailure = true; await click("当前号码"); assert.equal(inventoryRows().length, 0); assert.match(container.textContent, /fixture inventory offline/);
  inventoryFailure = false; await click("重新读取库存"); assert.equal(inventoryRows().length, 2);
  snapshot.buffer.items = Array.from({ length: 41 }, (_, index) => ({ ...ready, id: `page-${index}`, phone: `+1202555${String(100 + index).padStart(4, "0")}` }));
  await click("刷新"); assert.equal(inventoryRows().length, 20); await click("下一页"); assert.match(inventoryRows()[0].textContent, /0120/);
  await fill("缓冲库存状态", "ready"); assert.match(inventoryRows()[0].textContent, /0100/); assert.equal(new URLSearchParams(calls.findLast((row) => row.path.startsWith("/inventory?")).path.split("?")[1]).get("page"), "1");

  const originalSetInterval = window.setInterval; const originalClearInterval = window.clearInterval; const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const timers = new Map(); let timerId = 0; let hidden = false;
  window.setInterval = (callback, ms) => { assert.equal(ms, 5000); const id = ++timerId; timers.set(id, callback); return id; }; window.clearInterval = (id) => timers.delete(id);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
  try {
    await render(SmsPoolWorkspace, { api }); assert.equal(timers.size, 1, "inventory is the default polling destination");
    await fill("缓冲目标数量", "12"); const before = calls.length; const mutations = calls.filter((row) => row.method !== "GET").length;
    deferredInventory = true; await act(async () => [...timers.values()][0]());
    assert.equal(inventoryRows().length, 20, "background refresh keeps existing rows visible until new data arrives"); assert.equal(container.querySelector('[aria-label="缓冲目标数量"]').value, "12");
    await act(async () => finishInventory()); deferredInventory = false;
    assert.equal(calls.filter((row) => row.method !== "GET").length, mutations); assert.ok(calls.length > before);
    hidden = true; const beforeHidden = calls.length; await act(async () => [...timers.values()][0]()); assert.equal(calls.length, beforeHidden); hidden = false;
    await act(() => [...container.querySelectorAll(".sp-tabs button")].find((element) => element.textContent.startsWith("国家报价")).click()); assert.equal(timers.size, 0);
  } finally { window.setInterval = originalSetInterval; window.clearInterval = originalClearInterval; if (visibility) Object.defineProperty(document, "visibilityState", visibility); else delete document.visibilityState; }

  let mode = "missing"; const confirmationCalls = [];
  let confirmation = { ...snapshot, rules: structuredClone(rules), buffer: { ...snapshot.buffer, rules: structuredClone(rules.buffer) } };
  const confirmationApi = async (path = "", method = "GET", body) => {
    confirmationCalls.push({ path, method, body });
    if (path.startsWith("/inventory?")) return { items: [], total: 0, page: 1, pages: 1 };
    if (path === "/rules") {
      if (mode === "error") throw Error("fixture save failed");
      const result = { ...body.buffer }; if (mode === "missing") delete result.forceRefill; if (mode === "false") result.forceRefill = false; if (mode === "true") result.forceRefill = true;
      confirmation = { ...confirmation, rules: { ...confirmation.rules, buffer: result }, buffer: { ...confirmation.buffer, rules: result } };
    }
    return structuredClone(confirmation);
  };
  await render(SmsPoolWorkspace, { api: confirmationApi }); await fill("缓冲目标数量", "10"); await act(() => container.querySelector('[aria-label="自动补满号码"]').click());
  for (const nextMode of ["missing", "false", "error"]) {
    mode = nextMode; const gets = confirmationCalls.filter((row) => row.method === "GET").length; await click("保存补号设置");
    assert.equal(container.querySelector('[aria-label="自动补满号码"]').checked, true); assert.equal(container.querySelector('[aria-label="缓冲目标数量"]').value, "10");
    assert.match(container.querySelector('[role="alert"]').textContent, nextMode === "error" ? /fixture save failed/ : /后台尚未加载自动补满更新/);
    assert.equal(confirmationCalls.filter((row) => row.method === "GET").length, gets, "unconfirmed saves never refresh away the draft"); assert.doesNotMatch(container.textContent, /补号设置已保存/);
  }
  await click("刷新"); assert.equal(container.querySelector('[aria-label="自动补满号码"]').checked, true);
  mode = "normal"; await click("保存补号设置"); assert.match(container.textContent, /补号设置已保存/); assert.equal(container.querySelector('[role="alert"]'), null);
  await act(() => container.querySelector('[aria-label="自动补满号码"]').click()); mode = "true"; await click("保存补号设置"); assert.match(container.textContent, /后台未确认关闭自动补满/); assert.equal(container.querySelector('[aria-label="自动补满号码"]').checked, false);
  mode = "missing"; await click("保存补号设置"); assert.match(container.textContent, /补号设置已保存/);
  console.log("SMS pool inventory UI passed (simple target/auto controls, full admin numbers/copy, purchase snapshots, task progress/pause, history pagination, polling without flicker, privacy and confirmed saves)");
} finally { await act(() => root.unmount()); dom.window.close(); if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else delete globalThis.navigator; }
