import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import * as icons from "lucide-react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";
import * as filters from "../web/src/task-filters.mjs";
import * as smsOptions from "../web/src/sms-number-options.mjs";
import { cdkFetch, clearWorkspaceSettings, flushWorkspaceSettings, hydrateWorkspaceSettings, setImportConfirmation } from "../web/src/cdk-api.mjs";

async function load(file, names, bindings = {}, end) {
  let source = await fs.readFile(new URL(file, import.meta.url), "utf8");
  if (end) source = source.slice(0, source.indexOf(end));
  const code = source.replace(/^import[\s\S]*?;\r?\n/gm, "").replace("export default function", "function").replace(/^export /gm, "");
  const compiled = await transformWithEsbuild(code, file, { loader: "jsx", jsx: "transform" });
  const usedIcons = Object.fromEntries([...code.matchAll(/<([A-Z]\w*)/g)].map((match) => match[1]).filter((name) => icons[name]).map((name) => [name, icons[name]]));
  const scope = { React, useCallback, useEffect, useId, useMemo, useRef, useState, ...usedIcons, ...bindings };
  return new Function(...Object.keys(scope), `${compiled.code};return {${names.join(",")}};`)(...Object.values(scope));
}

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalMedia = globalThis.matchMedia;
const originalFetch = globalThis.fetch; const originalEvent = globalThis.Event; const originalCustomEvent = globalThis.CustomEvent;
globalThis.Event = window.Event; globalThis.CustomEvent = window.CustomEvent;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
globalThis.matchMedia = window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const auth = { authenticated: true, token: "fixture-pool-token", account: { id: "fixture-user", role: "user" }, workspace: { id: "fixture-user", role: "user", balance: 12, reserved: 0 },
  features: { smsProviders: [{ id: "pool", name: "接码池", fields: [] }], bulkActions: true, batchPhoneBinding: true }, logout: async () => {}, reload: async () => {} };
const baseJob = { id: "fixture-pool-job", email: "pool-actions@example.invalid", status: "phone_skipped", prompt: "等待开始接码", canStartPhoneBinding: true, phoneBindingEnabled: false, phoneBindingMode: "manual", smsStatus: "idle", createdAt: "2026-10-25T01:00:00Z", lastOperationAt: "2026-10-25T01:00:00Z", smsSummary: { verificationStatus: "not_started", historyCount: 0, orders: [] } };
let job = baseJob; const calls = []; let summaryAvailable = true; let previewOverride = null;
globalThis.fetch = async (url, options = {}) => {
  const method = options.method || "GET"; const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ url, method, body });
  if (url === "/api/bootstrap") return Response.json(auth);
  if (url === "/api/imports/preview") {
    const emails = body.mode === "single" ? [body.payload.email] : body.payload.text.split(/\r?\n/).filter(Boolean).map((line) => line.split("----")[0]);
    const count = new Set(emails.map((email) => email.toLowerCase())).size;
    const admin = auth.workspace.role === "admin"; const charge = admin ? 0 : count;
    return Response.json({ count, added: count, updated: 0, charge, balance: admin ? null : auth.workspace.balance, after: admin ? null : auth.workspace.balance - charge, canImport: admin || auth.workspace.balance >= charge, ...previewOverride });
  }
  if (url.startsWith("/api/jobs?")) return Response.json({ jobs: [job], selection: [job], stats: { total: 1, today: 1 }, pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } });
  if (url === "/api/mail-request-config") return Response.json({ ok: true });
  if (url === "/api/sms-pool") return Response.json({ enabled: true, available: summaryAvailable, fee: 3, status: summaryAvailable ? "available_on_demand" : "unavailable", hasNumbers: false, refilling: false });
  if (url === "/api/jobs/start-phone-batch") return Response.json({ started: 1, skipped: 0, failed: 0 });
  if (/\/api\/jobs\/[^/]+\/(?:start-phone|sms-number)$/.test(url)) return Response.json({ job });
  if (url === "/api/jobs") return Response.json({ job });
  if (url === "/api/jobs/batch") return Response.json({ created: 2, updated: 0, jobs: [] });
  if (/\/api\/jobs\/[^/]+\/logs$/.test(url)) return Response.json({ logs: "fixture" });
  throw Error(`Unexpected action UI request: ${method} ${url}`);
};
const ui = await load("../web/src/WorkspaceUi.jsx", ["Drawer", "MoreActions", "TaskFilters", "TaskOverview", "ThemeControl", "useCalendarDay", "useDialogFocus"], filters);
const { SmsPoolChargeDialog } = await load("../web/src/SmsPoolWorkspace.jsx", ["SmsPoolChargeDialog"], { ...ui, cdkFetch });
const { ImportChargeDialog } = await load("../web/src/ImportChargeDialog.jsx", ["ImportChargeDialog"], ui);
const { CdkGate } = await load("../web/src/CdkGate.jsx", ["CdkGate"], { ...ui, ImportChargeDialog, clearWorkspaceSettings, flushWorkspaceSettings, hydrateWorkspaceSettings, setImportConfirmation });
const empty = () => null;
const { App } = await load("../web/src/main.jsx", ["App"], {
  ...filters, ...smsOptions, ...ui, cdkFetch, SmsPoolChargeDialog,
  MfaWorkspace: empty, EmailRebindWorkspace: empty, OfferWorkspace: empty, SmsPoolWorkspace: empty, SmsPoolChoice: empty, CdkWorkspace: empty, CurrentCdk: empty, SmsPriceSelector: empty,
  readWorkspaceValue: (key) => key === "chatgpt-onboarding.sms-provider-settings-v1" ? JSON.stringify({ selectedProviderId: "pool", configs: { pool: { apiKey: "stale-secret-must-not-submit" } } }) : null,
  writeWorkspaceValue() {}, flushWorkspaceSettings: async () => {},
}, "const appRoot =");
const { createRoot } = await import("react-dom/client"); const container = document.getElementById("root"); const root = createRoot(container);
let generation = 0;
const render = async (patch = {}) => { job = { ...baseJob, ...patch }; calls.length = 0; await act(async () => root.render(React.createElement(CdkGate, { key: ++generation }, (liveAuth) => React.createElement(App, { auth: liveAuth })))); };
const button = (text, scope = container) => [...scope.querySelectorAll("button")].find((element) => element.textContent.trim() === text);
const click = (text, scope) => act(async () => { const element = button(text, scope); assert.ok(element, `Missing button: ${text}`); element.click(); });
const purchaseCalls = () => calls.filter((row) => row.method === "POST" && (row.url === "/api/jobs" || row.url === "/api/jobs/batch" || row.url === "/api/jobs/start-phone-batch" || /\/(?:start-phone|sms-number)$/.test(row.url)));
const dialog = () => container.querySelector('[role="dialog"][aria-label="确认使用接码池"]');
const importDialog = () => container.querySelector('[role="dialog"][aria-labelledby="import-quote-title"]');
async function startSingle() {
  const menu = container.querySelector(".job-row .more-actions");
  if (!menu.open) await act(() => menu.querySelector("summary").click());
  await click("开始接码", menu);
}
async function checkConfirmation(action, expectedUrl, expectedBody) {
  await action();
  assert.equal(calls.at(-1).url, "/api/sms-pool", "the current pool quote is fetched before confirmation");
  assert.ok(dialog()); assert.match(dialog().textContent, /每个账号验证成功扣除3 次/);
  assert.equal(purchaseCalls().length, 0, "opening confirmation must not start phone binding or acquire a number");
  await click("取消", dialog());
  assert.equal(dialog(), null); assert.equal(purchaseCalls().length, 0, "canceling leaves the account unchanged");
  await action();
  assert.ok(dialog()); assert.equal(purchaseCalls().length, 0);
  await click("确认开始接码", dialog());
  assert.equal(dialog(), null);
  assert.equal(purchaseCalls().length, 1);
  assert.equal(purchaseCalls()[0].url, expectedUrl);
  assert.deepEqual(purchaseCalls()[0].body, expectedBody);
  assert.doesNotMatch(JSON.stringify(purchaseCalls()), /apiKey|stale-secret-must-not-submit/);
}

async function checkImportConfirmation(action, expectedUrl, expectedBody, count) {
  await action();
  assert.equal(dialog(), null, "automatic imports do not open a standalone pool confirmation");
  assert.ok(importDialog());
  assert.equal(container.querySelectorAll(".cdk-import-backdrop").length, 1);
  assert.match(importDialog().textContent, /确认导入并使用接码池/);
  const rows = importDialog().querySelectorAll(".cdk-charge-lines > div");
  assert.match(rows[0].textContent, new RegExp(`账号导入.*${count} 次`));
  assert.match(rows[1].textContent, new RegExp(`接码池.*最多 ${count * 3} 次`));
  assert.match(importDialog().querySelector(".cdk-charge-total").textContent, new RegExp(`${count * 4} 次`));
  assert.equal(purchaseCalls().length, 0, "combined confirmation is read-only until accepted");
  await click("取消", importDialog());
  assert.equal(importDialog(), null); assert.equal(purchaseCalls().length, 0);
  await action();
  assert.ok(importDialog()); assert.equal(dialog(), null);
  await click("确认导入并创建任务", importDialog());
  assert.equal(importDialog(), null); assert.equal(dialog(), null, "no second confirmation follows acceptance");
  assert.equal(purchaseCalls().length, 1);
  assert.equal(purchaseCalls()[0].url, expectedUrl);
  assert.deepEqual(purchaseCalls()[0].body, expectedBody);
  assert.doesNotMatch(JSON.stringify(purchaseCalls()), /apiKey|stale-secret-must-not-submit/);
  assert.ok(calls.find((row) => row.url === expectedUrl && row.method === "POST"));
}

try {
  await render();
  await checkConfirmation(startSingle, `/api/jobs/${baseJob.id}/start-phone`, { smsProvider: { id: "pool", config: { quotedFee: 3 } } });

  await render({ status: "phone", canStartPhoneBinding: false, phoneBindingEnabled: true });
  await checkConfirmation(() => click("接码池取号"), `/api/jobs/${baseJob.id}/sms-number`, { providerId: "pool", config: { quotedFee: 3 } });

  await render();
  await act(() => container.querySelector(`[aria-label="选择 ${baseJob.email}"]`).click());
  await checkConfirmation(() => click("批量接码（1）"), "/api/jobs/start-phone-batch", { ids: [baseJob.id], smsProvider: { id: "pool", config: { quotedFee: 3 } } });

  summaryAvailable = false;
  await render();
  await startSingle();
  assert.equal(dialog(), null); assert.equal(purchaseCalls().length, 0);
  assert.match(container.textContent, /接码池暂时无法取号/);

  summaryAvailable = true;
  auth.workspace.balance = 2;
  await render();
  await startSingle();
  assert.equal(dialog(), null); assert.equal(purchaseCalls().length, 0);
  assert.match(container.textContent, /需要预留 3 次，当前可用 2 次/);
  auth.workspace.balance = 12;
  await render();
  await click("新建任务");
  const emailInput = container.querySelector('input[type="email"]');
  await act(() => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(emailInput, "new-pool-account@example.invalid"); emailInput.dispatchEvent(new window.Event("input", { bubbles: true })); });
  await act(() => container.querySelector('[aria-label="允许手机号接码"]').click());
  await checkImportConfirmation(() => click("添加任务"), "/api/jobs", { email: "new-pool-account@example.invalid", proxyUrl: "", phoneBindingMode: "automatic", phoneBindingEnabled: true, smsProvider: { id: "pool", config: { quotedFee: 3 } } }, 1);
  await render();
  await click("新建任务");
  await click("批量导入");
  const batchText = "first-dialog@example.invalid----fixture-one\nsecond-dialog@example.invalid----fixture-two";
  const batchInput = container.querySelector("#batch-input");
  await act(() => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(batchInput, batchText); batchInput.dispatchEvent(new window.Event("input", { bubbles: true })); });
  await act(() => container.querySelector('[aria-label="允许手机号接码"]').click());
  await click("创建 2 条任务");
  assert.equal([...container.querySelectorAll('[role="dialog"]')].at(-1), importDialog(), "combined confirmation renders after the drawer that remains mounted");
  assert.ok(importDialog().closest(".cdk-import-backdrop"), "combined fee confirmation uses the shared confirmation layer");
  assert.equal(purchaseCalls().length, 0);
  await act(() => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(importDialog(), null, "Escape cancels the pending fee confirmation");
  assert.equal(container.querySelector("#batch-input").value, batchText, "canceling preserves batch input");
  assert.equal(button("创建 2 条任务").disabled, false, "canceling clears the pending busy state");
  await checkImportConfirmation(() => click("创建 2 条任务"), "/api/jobs/batch", { text: batchText, proxyUrl: "", phoneBindingMode: "automatic", phoneBindingEnabled: true, smsProvider: { id: "pool", config: { quotedFee: 3 } } }, 2);
  assert.equal(container.querySelector("#batch-input"), null, "successful batch creation closes its drawer");
  assert.equal(document.body.style.overflow, "", "closing all batch confirmations restores scrolling");
  console.log("SMS pool action UI passed (real Gate/App/API, single and batch combined fees, unchanged separate phone actions, Escape recovery, cancellation and secret-free payloads)");
} finally {
  await act(() => root.unmount()); dom.window.close(); globalThis.matchMedia = originalMedia;
  clearWorkspaceSettings(); setImportConfirmation(null); globalThis.fetch = originalFetch; globalThis.Event = originalEvent; globalThis.CustomEvent = originalCustomEvent;
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else delete globalThis.localStorage;
}
