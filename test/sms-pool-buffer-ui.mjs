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
let publicRequest = async () => { throw Error("Public UI fixture must use its provided summary"); };
const { SmsPoolWorkspace, SmsPoolChoice } = await load("../web/src/SmsPoolWorkspace.jsx", ["SmsPoolWorkspace", "SmsPoolChoice"], { useDialogFocus, cdkFetch: (...args) => publicRequest(...args) });
const { createRoot } = await import("react-dom/client"); const container = document.getElementById("root"); const root = createRoot(container);
let generation = 0;
const render = (Component, props = {}) => act(async () => root.render(React.createElement(Component, { key: ++generation, ...props })));
const button = (label) => [...container.querySelectorAll("button")].find((element) => element.textContent.trim() === label);
const click = (label) => act(async () => { assert.ok(button(label), `Missing button: ${label}`); button(label).click(); });
async function fill(label, value) { await act(() => { const element = container.querySelector(`[aria-label="${label}"]`); assert.ok(element, label); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(element, value); element.dispatchEvent(new window.Event("input", { bubbles: true })); }); }

try {
  for (const [status, expected] of [["ready", "有号码"], ["fetching", "正在补货"], ["available_on_demand", "可即时取号"], ["unavailable", "暂无号码"], ["future_status", "状态未知"]]) {
    await render(SmsPoolChoice, { summary: { enabled: true, available: true, status, hasNumbers: true, refilling: status === "fetching", fee: 3,
      countries: ["private-country"], availableEntries: 99, providerName: "SMSBower", maxPrice: "0.13" } });
    assert.equal(container.querySelector("h3").textContent, "接码池");
    assert.match(container.querySelector(".sp-choice-heading .sp-state").textContent, new RegExp(expected));
    assert.doesNotMatch(container.textContent, /国家|条目|private-country|SMSBower|0\.13|99/);
    assert.equal(container.querySelector('svg.lucide-globe2, svg.lucide-globe-2'), null, "ordinary view must not imply country selection");
    assert.equal(container.querySelector(".sp-choice-fee strong").textContent.trim(), "3 次");
  }
  await render(SmsPoolChoice, { summary: { enabled: true, available: true, hasNumbers: true, fee: 3 } });
  assert.match(container.textContent, /状态未知/, "the legacy available flag cannot fabricate a current inventory status");
  await render(SmsPoolChoice, { summary: { enabled: false, available: true, status: "ready", hasNumbers: true, fee: 3 } });
  assert.match(container.textContent, /暂未开放/);
  publicRequest = async () => { throw Error("fixture pool offline"); };
  await render(SmsPoolChoice, { token: "fixture" });
  assert.match(container.textContent, /读取失败/); assert.match(container.textContent, /号码状态未知/);
  assert.equal(container.querySelector(".sp-choice-fee strong").textContent.trim(), "— 次");
  assert.doesNotMatch(container.textContent, /0 个|国家|条目/);

  const bufferRules = { enabled: false, target: 3, lowWater: 1, perEntry: 1, refillConcurrency: 1, minRemainingSeconds: 480, idleMinutes: 10, maxOutstanding: 10, maxPerMinute: 6 };
  const rules = { enabled: true, fee: 3, noStockThreshold: 3, cooldownMinutes: 10, maxAttempts: 10, maxConcurrent: 5 };
  let snapshot = { rules, credentials: [], entries: [{ id: "entry-a", countryLabel: "Admin only country" }], operations: [], buffer: { rules: bufferRules, counts: { ready: 1, purchasing: 1, checking: 1, assigned: 2, cancel_pending: 1, purchase_unknown: 1, closed: 2, quarantined: 1 }, refilling: false, activeDemandAt: null,
    items: [{ id: "ready", entryId: "entry-a", providerId: "smsbower", state: "ready", phone: "+12025550123", expiresAt: "2026-10-25T01:30:00Z", expiresSource: "provider" },
      { id: "cancel", providerId: "herosms", state: "cancel_pending", phone: "******0124", cancelState: "denied", nextActionAt: "2026-10-25T01:15:00Z", refundStatus: "unconfirmed" },
      { id: "closed", providerId: "herosms", state: "closed", phone: "******0125", cancelState: "confirmed", refundStatus: "unconfirmed" },
      { id: "refund", providerId: "smsbower", state: "closed", phone: "******0126", cancelState: "confirmed", refundStatus: "confirmed" },
      { id: "unknown", state: "purchase_unknown", lastError: "order_unknown", canReconcile: true }] } };
  const calls = [];
  const api = async (path = "", method = "GET", body) => { calls.push({ path, method, body }); if (path === "/rules") snapshot = { ...snapshot, rules: body, buffer: { ...snapshot.buffer, rules: body.buffer } }; if (path === "/inventory/unknown/reconcile") snapshot.buffer.items = snapshot.buffer.items.map((row) => row.id === "unknown" ? { ...row, state: "closed", canReconcile: false, refundStatus: "unconfirmed" } : row); return structuredClone(snapshot); };
  await render(SmsPoolWorkspace, { api });
  await act(() => container.querySelector(".sp-buffer-rule-settings summary").click());
  assert.equal(container.querySelector('[aria-label="启用号码缓冲"]').checked, false);
  for (const [label, value] of [["目标库存", 3], ["补货水位", 1], ["每条报价最多", 1], ["补货并发", 1], ["分配时至少剩余", 480], ["无需求回收", 10], ["未结束订单上限", 10], ["每分钟购号上限", 6]]) assert.equal(container.querySelector(`[aria-label="缓冲${label}"]`).value, String(value));
  await act(() => [...container.querySelectorAll(".sp-tabs button")].find((element) => element.textContent.startsWith("号码缓冲")).click());
  assert.equal(button("立即补货").disabled, true, "opening the inventory does not enable purchasing");
  assert.equal(calls.some((row) => row.method !== "GET"), false);
  assert.equal(container.querySelectorAll(".sp-buffer-table tbody tr").length, 5);
  assert.doesNotMatch(container.querySelector(".sp-buffer-table").textContent, /\+12025550123/);
  const closed = [...container.querySelectorAll(".sp-buffer-table tbody tr")].find((row) => row.textContent.includes("0125"));
  assert.match(closed.textContent, /取消已确认/); assert.match(closed.textContent, /退款待核实/); assert.doesNotMatch(closed.textContent, /退款已确认/);
  const refunded = [...container.querySelectorAll(".sp-buffer-table tbody tr")].find((row) => row.textContent.includes("0126"));
  assert.match(refunded.textContent, /退款已确认/);
  assert.match(container.querySelector(".sp-buffer").textContent, /可能产生服务商费用/);
  await fill("缓冲补货水位", "3"); assert.equal(button("保存池规则").disabled, true);
  await fill("缓冲补货水位", "1");
  await fill("缓冲每条报价最多", "4"); assert.equal(button("保存池规则").disabled, true);
  await fill("缓冲每条报价最多", "1");
  await fill("缓冲未结束订单上限", "2"); assert.equal(button("保存池规则").disabled, true);
  await fill("缓冲未结束订单上限", "10");
  await fill("缓冲补货并发", "1.5"); assert.equal(button("保存池规则").disabled, true);
  await fill("缓冲补货并发", "1");
  await fill("缓冲每分钟购号上限", "61"); assert.equal(button("保存池规则").disabled, true);
  await fill("缓冲每分钟购号上限", "6");
  await act(() => container.querySelector('[aria-label="启用号码缓冲"]').click());
  assert.equal(calls.some((row) => /warmup|drain/.test(row.path)), false, "changing a draft never purchases or recycles an order");
  await click("保存池规则");
  const saved = calls.find((row) => row.path === "/rules");
  assert.deepEqual(saved.body.buffer, { ...bufferRules, enabled: true });
  assert.equal(calls.some((row) => /warmup|drain/.test(row.path)), false, "saving rules does not send warmup or drain requests from the UI");
  await click("立即补货");
  assert.deepEqual(calls.filter((row) => row.path === "/buffer/warmup"), [{ path: "/buffer/warmup", method: "POST", body: {} }]);
  assert.equal(calls.some((row) => row.path === "/buffer/drain"), false);
  await click("回收未分配号码");
  assert.deepEqual(calls.filter((row) => row.path === "/buffer/drain"), [{ path: "/buffer/drain", method: "POST", body: {} }]);

  await click("核实库存");
  assert.equal(button("确认结束订单").disabled, true);
  const inventoryNote = container.querySelector('[aria-label="库存核实依据"]');
  await act(() => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(inventoryNote, "Provider order history confirms no active order"); inventoryNote.dispatchEvent(new window.Event("input", { bubbles: true })); });
  assert.equal(button("确认结束订单").disabled, true, "closing inventory requires an explicit inactive-order confirmation");
  assert.equal(container.querySelector('[aria-label="库存退款凭证"]').value, "");
  await act(() => container.querySelector('.sp-dialog input[type="checkbox"]').click());
  await click("确认结束订单");
  assert.deepEqual(calls.find((row) => row.path === "/inventory/unknown/reconcile").body, { action: "close", note: "Provider order history confirms no active order" });
  assert.equal(container.querySelector('[aria-label="核实缓冲订单"]'), null);
  assert.equal(button("核实库存"), undefined);
  assert.match(container.textContent, /CDK接码费用按原操作保留/);
  const manuallyClosed = container.querySelector(".sp-buffer-table tbody tr:last-child");
  assert.match(manuallyClosed.textContent, /退款待核实/);
  assert.doesNotMatch(manuallyClosed.textContent, /退款已确认/);

  snapshot = { ...snapshot, buffer: null };
  await click("刷新");
  assert.equal(button("立即补货").disabled, true);
  assert.equal(button("回收未分配号码").disabled, true);
  assert.ok([...container.querySelectorAll(".sp-buffer-counts strong")].every((element) => element.textContent === "—"));
  const originalSetInterval = window.setInterval; const originalClearInterval = window.clearInterval;
  const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const timers = new Map(); const cleared = []; let timerId = 0; let hidden = false;
  window.setInterval = (callback, ms) => { assert.equal(ms, 5000); const id = ++timerId; timers.set(id, callback); return id; };
  window.clearInterval = (id) => { cleared.push(id); timers.delete(id); };
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => hidden ? "hidden" : "visible" });
  try {
    await render(SmsPoolWorkspace, { api });
    assert.equal(timers.size, 0, "ordinary management tabs do not poll inventory");
    await act(() => [...container.querySelectorAll(".sp-tabs button")].find((element) => element.textContent.startsWith("号码缓冲")).click());
    assert.equal(timers.size, 1);
    await fill("验证成功扣次", "7");
    const requestsBeforePoll = calls.length; const mutationsBeforePoll = calls.filter((row) => row.method !== "GET").length;
    await act(async () => [...timers.values()][0]());
    assert.equal(calls.length, requestsBeforePoll + 1);
    assert.equal(calls.at(-1).method, "GET");
    assert.equal(container.querySelector('[aria-label="验证成功扣次"]').value, "7", "inventory polling preserves dirty rule drafts");
    assert.equal(calls.filter((row) => row.method !== "GET").length, mutationsBeforePoll, "polling never warms up or drains inventory");
    hidden = true; await act(async () => [...timers.values()][0]());
    assert.equal(calls.length, requestsBeforePoll + 1, "hidden pages skip polling");
    hidden = false;
    await act(() => [...container.querySelectorAll(".sp-tabs button")].find((element) => element.textContent.startsWith("国家报价")).click());
    assert.equal(timers.size, 0, "switching away clears the inventory interval");

    let publicGets = 0;
    publicRequest = async (url, options = {}) => { assert.equal(url, "/api/sms-pool"); assert.equal(options.method || "GET", "GET"); publicGets++; return Response.json({ enabled: true, available: true, fee: 3, status: publicGets === 1 ? "fetching" : "ready", hasNumbers: publicGets > 1 }); };
    await render(SmsPoolChoice, { token: "fixture" });
    assert.equal(timers.size, 1); assert.match(container.querySelector(".sp-choice-heading").textContent, /正在补货/);
    await act(async () => [...timers.values()][0]());
    assert.equal(publicGets, 2); assert.match(container.querySelector(".sp-choice-heading").textContent, /有号码/);
    hidden = true; await act(async () => [...timers.values()][0]()); assert.equal(publicGets, 2); hidden = false;
    await render(SmsPoolChoice, { summary: { enabled: true, available: true, fee: 3, status: "ready", hasNumbers: true } });
    assert.equal(timers.size, 0, "provided preview summaries never poll APIs");
    await render(SmsPoolChoice, { token: "fixture" }); assert.equal(timers.size, 1);
    await act(() => root.render(null)); assert.equal(timers.size, 0, "unmount clears the public interval");
    assert.ok(cleared.length >= 3);
  } finally {
    window.setInterval = originalSetInterval; window.clearInterval = originalClearInterval;
    if (visibility) Object.defineProperty(document, "visibilityState", visibility); else delete document.visibilityState;
  }
  console.log("SMS pool buffer UI passed (private public view, authoritative availability states, bounded nested rules, explicit warmup/drain, masked inventory and separate cancellation/refund evidence)");
} finally { await act(() => root.unmount()); dom.window.close(); }
