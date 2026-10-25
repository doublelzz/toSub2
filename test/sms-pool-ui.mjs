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
let publicRequest = async () => Response.json({ enabled: true, available: true, fee: 3, status: "ready", hasNumbers: true });
const { SmsPoolWorkspace, EntryDialog, CredentialDialog, SmsPoolChoice, SmsPoolChargeDialog } = await load("../web/src/SmsPoolWorkspace.jsx", ["SmsPoolWorkspace", "EntryDialog", "CredentialDialog", "SmsPoolChoice", "SmsPoolChargeDialog"], {
  useDialogFocus, Drawer: ({ children }) => React.createElement("section", null, children), cdkFetch: (...args) => publicRequest(...args),
});
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root"); const root = createRoot(container);
const button = (text, scope = container) => [...scope.querySelectorAll("button")].find((element) => element.textContent.trim() === text);
const click = (text, scope) => act(async () => { const element = button(text, scope); assert.ok(element, `Missing button: ${text}`); element.click(); });
const render = (Component, props = {}, key = Math.random()) => act(async () => root.render(React.createElement(Component, { key, ...props })));
async function fill(element, value) {
  assert.ok(element, "Input must exist");
  await act(async () => {
    const prototype = element.tagName === "SELECT" ? window.HTMLSelectElement.prototype : element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
  });
}
const credentials = [{ id: "cred-a", name: "Primary", providerId: "smsbower", enabled: true, hasApiKey: true }, { id: "cred-b", name: "Backup", providerId: "herosms", enabled: true, hasApiKey: true }];
const rules = { enabled: true, fee: 3, noStockThreshold: 3, cooldownMinutes: 10, maxAttempts: 10, maxConcurrent: 5, buffer: { enabled: false, target: 3, lowWater: 1, perEntry: 1, refillConcurrency: 1, minRemainingSeconds: 480, idleMinutes: 10, maxOutstanding: 10, maxPerMinute: 6 } };
const issues = []; const check = (condition, message) => { if (!condition) issues.push(message); };

try {
  let snapshot = { rules, credentials, entries: [{ id: "entry-a", credentialId: "cred-a", providerId: "smsbower", country: "6", countryLabel: "Country A", maxPrice: "0.30", priority: 10, enabled: true, state: "available", noStockCount: 0 }], operations: [] };
  const calls = [];
  const api = async (path = "", method = "GET", body) => { calls.push({ path, method, body }); if (path === "/rules") snapshot = { ...snapshot, rules: body }; return structuredClone(snapshot); };
  await render(SmsPoolWorkspace, { api });
  assert.match(container.querySelector(".sp-pool-status").textContent, /1 个可用条目/);
  const switchInput = container.querySelector('[role="switch"]');
  await act(() => switchInput.click());
  await fill(container.querySelector('[aria-label="验证成功扣次"]'), "1.5");
  assert.equal(button("保存池规则").disabled, true, "fractional CDK fees cannot be saved");
  for (const [label, value] of [["验证成功扣次", "4"], ["连续无号暂停阈值", "5"], ["首次冷却分钟", "8"], ["单次取号尝试上限", "7"], ["池并发上限", "3"]]) await fill(container.querySelector(`[aria-label="${label}"]`), value);
  await click("保存池规则");
  const submittedRules = calls.find((row) => row.path === "/rules");
  assert.deepEqual(submittedRules.body, { enabled: false, fee: 4, noStockThreshold: 5, cooldownMinutes: 8, maxAttempts: 7, maxConcurrent: 3, buffer: rules.buffer });
  assert.match(container.textContent, /接码池已关闭/);
  check(container.querySelector('[aria-label="单次取号尝试上限"]').max === "20", "UI maximum attempts must match server limit 20");

  const closeEvents = []; const savedCredentials = [];
  await render(CredentialDialog, { row: { ...credentials[0], apiKey: "fixture-secret-never-render" }, onClose: () => closeEvents.push("close"), onSave: async (body) => savedCredentials.push(body), onSaved: async () => {} });
  assert.equal(container.querySelector('input[type="password"]').value, "");
  assert.doesNotMatch(container.innerHTML, /fixture-secret-never-render/);
  await fill(container.querySelector('input[maxlength="80"]'), "Renamed");
  await click("保存凭据");
  assert.equal(savedCredentials[0].name, "Renamed");
  assert.equal(Object.hasOwn(savedCredentials[0], "apiKey"), false, "editing a saved credential leaves its key on the server");
  await act(() => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(closeEvents.length, 1);

  let finishCredentialSave; let busyCloseCount = 0;
  await render(CredentialDialog, { row: credentials[0], onClose: () => { busyCloseCount++; }, onSave: () => new Promise((resolve) => { finishCredentialSave = resolve; }), onSaved: async () => {} });
  await click("保存凭据");
  await act(() => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  check(busyCloseCount === 0, "Escape must not close a credential save while its request is pending");
  await act(async () => finishCredentialSave());

  const entryCalls = []; let entrySaved = 0;
  const quotes = [{ country: "6", title: "Country A", price: 0.3, count: 4, providerIds: "1", grade: "gold" }, { country: "6", name: "Country A", price: 0.4, count: 7, providerIds: "2" }, { country: "16", name: { eng: "Unexpected object" }, price: 0.5, count: 8, providerIds: "3" }];
  const request = async (path, method, body) => { entryCalls.push({ path, method, body }); return path.endsWith("/options") ? { options: quotes } : {}; };
  await render(EntryDialog, { credentials, request, onClose() {}, onSaved: () => { entrySaved++; } });
  assert.equal(button("加入接码池").disabled, true);

  await click("查询国家报价");
  assert.equal(container.querySelectorAll('.sp-quote-option input[type="checkbox"]').length, 3);
  assert.match(container.querySelectorAll(".sp-quote-option strong")[4].textContent, /国家 16/);
  await act(() => container.querySelectorAll('.sp-quote-option input[type="checkbox"]')[0].click());
  await act(() => container.querySelectorAll('.sp-quote-option input[type="checkbox"]')[1].click());
  await fill(container.querySelector('[aria-label="搜索可添加国家"]'), "16");
  assert.match(container.textContent, /已选 2 条报价/);
  await click("加入接码池");
  const addition = entryCalls.find((row) => row.path === "/entries");
  assert.equal(addition.body.entries.length, 2);
  assert.deepEqual(addition.body.entries.map((row) => [row.credentialId, row.maxPrice, row.providerIds, row.priority]), [["cred-a", "0.3", "1", 10], ["cred-a", "0.4", "2", 10]]);
  assert.equal(entrySaved, 1);
  await fill(container.querySelector('[aria-label="选择服务商凭据"]'), "cred-b");
  assert.equal(container.querySelectorAll(".sp-quote-option").length, 0);
  assert.match(container.textContent, /已选 0 条报价/);
  assert.equal(button("加入接码池").disabled, true);

  const confirmations = [];
  await render(SmsPoolChargeDialog, { quote: { fee: 3, count: 2 }, onClose: (value) => confirmations.push(value) });
  assert.match(container.textContent, /最多扣 6 次/);
  await click("确认开始接码");
  assert.deepEqual(confirmations[0], { id: "pool", config: { quotedFee: 3 } });

  let resolveSummary;
  publicRequest = () => new Promise((resolve) => { resolveSummary = resolve; });
  await render(SmsPoolChoice, { token: "fixture" });
  check(container.querySelector(".sp-choice-fee strong").textContent.trim().startsWith("—"), "Loading must not invent a default fee");
  check(!container.querySelector(".sp-choice-footer").textContent.includes("0 个可用条目"), "Loading must not claim zero available entries");
  await act(async () => resolveSummary(Response.json({ enabled: false, available: false, fee: 4, status: "ready", hasNumbers: true })));
  assert.match(container.querySelector(".sp-choice-heading").textContent, /暂未开放/);
  assert.match(container.querySelector(".sp-choice-fee").textContent, /4 次/);

  publicRequest = async () => Response.json({ error: "fixture unavailable" }, { status: 503 });
  await render(SmsPoolChoice, { token: "fixture" });
  assert.match(container.querySelector('[role="alert"]').textContent, /fixture unavailable/);
  check(!container.querySelector(".sp-choice-heading").textContent.includes("正在读取"), "Failed public summary must not stay in a perpetual loading state");

  let resolveAdmin;
  await render(SmsPoolWorkspace, { api: () => new Promise((resolve) => { resolveAdmin = resolve; }) });
  const status = container.querySelector(".sp-pool-status");
  check(!status?.textContent.includes("接码池已关闭") && !status?.textContent.includes("验证成功扣 2 次"), "Loading admin rules must not show invented closed/default-fee values");
  await act(async () => resolveAdmin(structuredClone(snapshot)));
  assert.equal(container.querySelector(".sp-heading h2").textContent, "接码池");
  assert.deepEqual(issues, []);
  console.log("SMS pool UI passed (numeric rules, pool switch, secret retention, multi-tier selection, provider reset, Escape and unknown/loading/error summaries)");
} finally { await act(() => root.unmount()); dom.window.close(); }
