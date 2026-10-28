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
let publicRequest = async () => Response.json({ enabled: true, categories: [{ id: "other", name: "其他", enabled: true, available: true, fee: 3, feeVersion: 1, status: "available_on_demand" }] });
const { SmsPoolWorkspace, EntryDialog, SmsPoolChoice, SmsPoolChargeDialog } = await load("../web/src/SmsPoolWorkspace.jsx", ["SmsPoolWorkspace", "EntryDialog", "SmsPoolChoice", "SmsPoolChargeDialog"], { useDialogFocus, cdkFetch: (...args) => publicRequest(...args) });
const { createRoot } = await import("react-dom/client"); const container = document.getElementById("root"); const root = createRoot(container);
let generation = 0;
const render = (Component, props = {}) => act(async () => root.render(React.createElement(Component, { key: ++generation, ...props })));
const button = (label, scope = container) => [...scope.querySelectorAll("button")].find((element) => element.textContent.trim() === label);
const click = (label, scope) => act(async () => { assert.ok(button(label, scope), `Missing button: ${label}`); button(label, scope).click(); });
const tab = (label) => act(async () => [...container.querySelectorAll(".sp-tabs button")].find((element) => element.textContent.startsWith(label)).click());
async function fill(element, value) { await act(() => { const prototype = element.tagName === "SELECT" ? window.HTMLSelectElement.prototype : element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value); element.dispatchEvent(new window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }); }

try {
  const credentials = [{ id: "cred-a", name: "Primary", providerId: "smsbower", enabled: true, hasApiKey: true, blockedReason: "balance_insufficient" }];
  const rules = { enabled: true, fee: 3, noStockThreshold: 3, cooldownMinutes: 10, maxAttempts: 10, requestConcurrency: 3 };
  let snapshot = { categories: [{ id: "other", name: "其他", enabled: true, fee: 3, feeVersion: 1 }], rules, credentials, entries: [{ id: "entry-a", categoryId: "other", credentialId: "cred-a", country: "6", maxPrice: "0.30", providerIds: "1", state: "credential_error" }], operations: [], version: 1 };
  let failMain = false; let failHistory = false;
  const calls = [];
  const history = Array.from({ length: 205 }, (_, index) => ({ operationId: `operation-${index}`, cdkId: index % 2 ? "owner-b" : "owner-a", cdkLabel: `CDK ${index % 2}`, email: `history-${index}@example.invalid`, state: index === 0 ? "unknown" : "verified", fee: 3, reserved: index === 0 ? 3 : 0, createdAt: "2026-10-25T01:00:00Z" }));
  const api = async (path = "", method = "GET", body) => {
    calls.push({ path, method, body });
    if (!path) { if (failMain) throw Error("fixture rules offline"); return structuredClone(snapshot); }
    if (path === "/rules") { snapshot = { ...snapshot, rules: body, version: snapshot.version + 1 }; return structuredClone(snapshot); }
    if (path === "/credentials") { snapshot = { ...snapshot, credentials: snapshot.credentials.map((row) => ({ ...row, blockedReason: "" })), version: snapshot.version + 1 }; return structuredClone(snapshot); }
    if (path.startsWith("/operations?")) { if (failHistory) throw Error("fixture history offline"); const page = Number(new URLSearchParams(path.split("?")[1]).get("page")); return { items: structuredClone(history.slice((page - 1) * 20, page * 20)), page, pageSize: 20, pages: 11, total: history.length }; }
    if (path.endsWith("/reconcile")) { history[0].state = body.action === "verified" ? "verified" : "released"; return structuredClone(snapshot); }
    throw Error(`Unexpected production UI request: ${method} ${path}`);
  };
  await render(SmsPoolWorkspace, { api });
  await tab("设置");
  await fill(container.querySelector('[aria-label="取号请求并发"]'), "6");
  snapshot.rules = { ...snapshot.rules, requestConcurrency: 8 };
  await click("刷新");
  assert.equal(container.querySelector('[aria-label="取号请求并发"]').value, "6", "refresh preserves unsaved rules");
  assert.equal(container.querySelector(".sp-pool-fee strong").textContent, "3", "the category fee is independent of global rules");
  await fill(container.querySelector('[aria-label="取号请求并发"]'), "2.5");
  assert.equal(button("保存池规则").disabled, true, "all rule fields require integers");
  await fill(container.querySelector('[aria-label="取号请求并发"]'), "4");
  await click("保存池规则");
  assert.equal(calls.findLast((row) => row.path === "/rules").body.requestConcurrency, 4);
  assert.equal(Object.hasOwn(calls.findLast((row) => row.path === "/rules").body, "fee"), false);
  snapshot.rules = { ...snapshot.rules, requestConcurrency: 9 };
  await click("刷新");
  assert.equal(container.querySelector('[aria-label="取号请求并发"]').value, "9", "an unedited draft adopts current server rules");
  await tab("设置");
  assert.match(container.querySelector(".sp-credential-row").textContent, /凭据异常/);
  assert.match(container.querySelector(".sp-credential-error").textContent, /余额不足/);
  await click("充值后恢复");
  assert.deepEqual(calls.findLast((row) => row.path === "/credentials").body, { id: "cred-a", name: "Primary", providerId: "smsbower", enabled: true, resetCooldown: true });
  assert.equal(container.querySelector(".sp-credential-error"), null);

  await tab("取号记录");
  assert.equal(container.querySelectorAll(".sp-operation-table tbody tr").length, 20);
  assert.match(container.querySelector('[aria-label="取号记录分页"]').textContent, /205 条记录/);
  await click("下一页");
  assert.match(container.querySelector(".sp-operation-table tbody tr").textContent, /history-20/);
  assert.ok(calls.some((row) => row.path === "/operations?page=2&pageSize=20"));
  await click("上一页");
  await click("核实处理");
  await fill(container.querySelector('textarea'), "fixture verification evidence");
  await click("记录核实结果");
  assert.deepEqual(calls.findLast((row) => row.path.endsWith("/reconcile")).body, { action: "release", note: "fixture verification evidence", cdkId: "owner-a" });
  assert.match(container.querySelector(".sp-operation-table tbody tr").textContent, /已释放/);
  failHistory = true;
  await click("下一页");
  assert.match(container.querySelector('[role="alert"]').textContent, /fixture history offline/);
  assert.equal(container.querySelectorAll(".sp-operation-table tbody tr").length, 0, "failed page requests never display a previous page as current");
  failHistory = false; await click("重新读取记录");
  assert.match(container.querySelector(".sp-operation-table tbody tr").textContent, /history-20/);
  failMain = true; await click("刷新");
  assert.match(container.querySelector(".sp-pool-status").textContent, /读取失败/);
  assert.match(container.querySelector(".sp-pool-status").textContent, /可用条目未知/);
  assert.equal(container.querySelector(".sp-pool-fee strong").textContent, "—");

  const quotes = [{ country: "6", title: "Country A", price: 0.3, count: 5, providerIds: "1", grade: "gold" }, { country: "6", title: "Country A", price: 0.30, count: 8, providerIds: "1", grade: "gold" }, { country: "6", title: "Country A", price: 0.4, count: 4, providerIds: "2", grade: "unknown" }, { country: "16", title: "Country B", price: 0.5, count: 5, providerIds: "3", grade: "gold" }];
  const entryCalls = [];
  await render(EntryDialog, { categoryId: "other", categoryName: "其他", credentials, existingEntries: snapshot.entries, request: async (path, method, body) => { entryCalls.push({ path, method, body }); return path.endsWith("/options") ? { options: quotes } : {}; }, onClose() {}, onSaved() {} });
  await click("查询国家报价");
  assert.equal(container.querySelectorAll(".sp-quote-option").length, 3, "duplicate routes are listed once");
  assert.equal(container.querySelector(".sp-quote-option input").disabled, true, "already pooled routes cannot be added twice");
  await fill(container.querySelector('[aria-label="筛选可添加报价档位"]'), "gold");
  assert.equal(container.querySelectorAll(".sp-quote-option").length, 2);
  await act(() => container.querySelectorAll(".sp-quote-option input")[1].click());
  await fill(container.querySelector('[aria-label="筛选可添加报价档位"]'), "unknown");
  await act(() => container.querySelector(".sp-quote-option input").click());
  assert.match(container.textContent, /已选 2 条报价/);
  await click("加入接码池");
  assert.deepEqual(entryCalls.find((row) => row.path === "/entries").body.entries.map((row) => [row.country, row.providerIds, row.grade, row.gradeFilter]), [["16", "3", "gold", "gold"], ["6", "2", "unknown", "unknown"]]);

  await render(SmsPoolChoice, { value: "other", token: "fixture" });
  assert.match(container.querySelector(".sp-choice-heading").textContent, /可按需取号/);
  publicRequest = async () => { throw Error("fixture public offline"); };
  await click("刷新状态");
  assert.match(container.querySelector(".sp-choice-heading").textContent, /读取失败/);
  assert.match(container.querySelector(".sp-choice-footer").textContent, /接码池状态未知/);
  assert.equal(container.querySelector(".sp-choice-fee strong").textContent.trim(), "— 次");

  await render(SmsPoolChargeDialog, { quote: { categoryId: "other", categoryName: "其他", feeVersion: 1, fee: 3, count: 4, admin: true }, onClose() {} });
  assert.match(container.textContent, /最多扣 0 次/);
  assert.equal(container.querySelector(".sp-choice-fee strong").textContent.trim(), "0 次");
  console.log("SMS pool production UI passed (current versus draft rules, credential recovery, 205-row pagination/retry, owner-scoped reconciliation, grade routes/deduplication and stale availability)");
} finally { await act(() => root.unmount()); dom.window.close(); }
