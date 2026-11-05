import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useEffect, useId, useMemo, useRef, useState } from "react";
import * as icons from "lucide-react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";
import * as filters from "../web/src/task-filters.mjs";
import * as smsOptions from "../web/src/sms-number-options.mjs";
import * as proxyPoolUi from "./proxy-pool-ui-support.mjs";

async function load(file, names, bindings = {}, end) {
  let source = await fs.readFile(new URL(file, import.meta.url), "utf8");
  if (end) source = source.slice(0, source.indexOf(end));
  const code = source.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "");
  const compiled = await transformWithEsbuild(code, file, { loader: "jsx", jsx: "transform" });
  const usedIcons = Object.fromEntries([...code.matchAll(/<([A-Z]\w*)/g)].map((match) => match[1]).filter((name) => icons[name]).map((name) => [name, icons[name]]));
  const scope = { ...proxyPoolUi, React, useEffect, useId, useMemo, useRef, useState, ...usedIcons, ...bindings };
  return new Function(...Object.keys(scope), `${compiled.code};return {${names.join(",")}};`)(...Object.values(scope));
}

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalMedia = globalThis.matchMedia; const originalCreate = URL.createObjectURL; const originalRevoke = URL.revokeObjectURL;
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
globalThis.matchMedia = window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 100, height: 20 }] : []; };
const copied = []; const downloads = []; const objectBlobs = []; let failCopy = false;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "fixture", clipboard: { writeText: async (value) => { if (failCopy) throw new Error("fixture-clipboard-denied"); copied.push(value); } } } });
URL.createObjectURL = (blob) => { objectBlobs.push(blob); return `blob:account-export-${objectBlobs.length}`; }; URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = function () { downloads.push({ filename: this.download, href: this.href }); };

const ui = await load("../web/src/WorkspaceUi.jsx", ["Drawer", "MoreActions", "TaskFilters", "TaskOverview", "ThemeControl", "useCalendarDay", "useDialogFocus"], filters);
let auth = { authenticated: true, token: "fixture-export-token-a", account: { id: "owner-a", role: "user" }, workspace: { id: "owner-a" }, features: { bulkActions: true, sourceExport: true, atExport: true }, logout: async () => {} };
const jobs = ["one", "two", "three", "four"].map((id) => ({ id, email: `${id}@fixture.invalid`, status: "completed", createdAt: "2026-11-05T01:00:00.000Z" }));
const originalContent = "one@fixture.invalid----fixture-password----fixture-mfa\nthree@fixture.invalid----fixture-password-three";
const entries = [
  { email: "one@fixture.invalid", accessToken: "fixture-session-expired-token", source: "session", expiresAt: "2020-01-01T00:00:00.000Z", expired: true },
  { email: "three@fixture.invalid", accessToken: "fixture-oauth-unknown-token", source: "oauth", expiresAt: null, expired: null },
];
let tokenExport = { requested: 2, exported: 2, entries, skipped: [{ email: "missing@fixture.invalid", reason: "未保存 AT" }] };
const calls = []; const pending = []; let holdExport = false; let failExport = false;
const page = () => null;
const { App, AccountExportDialog } = await load("../web/src/main.jsx", ["App", "AccountExportDialog"], {
  ...filters, ...smsOptions, ...ui,
  MfaWorkspace: page, EmailRebindWorkspace: page, OfferWorkspace: page, SmsPoolWorkspace: page, SmsPoolChoice: page, SmsPoolChargeDialog: page,
  CdkWorkspace: page, CurrentCdk: page, SmsPriceSelector: page, SmsServiceSelector: page,
  readWorkspaceValue: () => null, writeWorkspaceValue() {}, flushWorkspaceSettings: async () => {},
  cdkFetch: async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null; calls.push({ url, body, signal: options.signal });
    if (url === "/api/bootstrap") return Response.json(auth);
    if (url === "/api/mail-request-config") return Response.json({ ok: true });
    if (url.startsWith("/api/jobs?")) {
      const current = Number(new URL(url, "http://fixture").searchParams.get("page") || 1);
      return Response.json({ jobs: jobs.slice((current - 1) * 2, current * 2), selection: jobs, stats: { total: 4 }, pagination: { page: current, pageSize: 2, total: 4, totalPages: 2 } });
    }
    if (url === "/api/jobs/export-source" || url === "/api/jobs/export-at") {
      const response = () => failExport ? Response.json({ error: "fixture-export-failed" }, { status: 500 }) : url.endsWith("export-at") ? Response.json(tokenExport) : new Response(originalContent, { headers: { "content-type": "text/plain", "content-disposition": "attachment; filename*=UTF-8''fixture%20source.txt" } });
      return holdExport ? new Promise((resolve) => pending.push({ signal: options.signal, complete: () => resolve(response()) })) : response();
    }
    throw new Error(`Unexpected account export UI request: ${url}`);
  },
}, "const appRoot =");
const { createRoot } = await import("react-dom/client"); const container = document.getElementById("root"); const root = createRoot(container);
const dialog = () => container.querySelector(".account-export-dialog");
const text = () => container.querySelector('[aria-label="账号导出预览内容"]');
const button = (label, scope = container) => [...scope.querySelectorAll("button")].find((element) => element.textContent.trim() === label);
const click = (label, scope) => act(async () => { const target = button(label, scope); assert.ok(target, `Missing ${label}`); target.focus(); target.click(); });
const select = (email) => act(() => container.querySelector(`[aria-label="选择 ${email}"]`).click());
const changeFormat = (value) => act(() => { const field = container.querySelector('[aria-label="AT 导出格式"]'); Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(field, value); field.dispatchEvent(new window.Event("change", { bubbles: true })); });
const exports = () => calls.filter((call) => /\/export-(?:source|at)$/.test(call.url));
const render = () => act(async () => root.render(React.createElement(App, { auth })));
const closeEscape = () => act(() => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

try {
  await render(); await select("one@fixture.invalid");
  await act(async () => container.querySelector('[aria-label="下一页"]').click()); await select("three@fixture.invalid");
  assert.match(container.querySelector(".selection-summary").textContent, /已选 2 条/);
  const menu = button("导出原始信息").closest(".more-actions");
  await act(() => menu.querySelector("summary").click());
  await click("导出原始信息");
  assert.deepEqual(exports().at(-1).body, { ids: ["one", "three"] }, "source export retains cross-page selection");
  assert.equal(downloads.length, 0, "opening a source export preview never downloads"); assert.equal(copied.length, 0);
  assert.equal(text().value, originalContent); assert.equal(text().readOnly, true);
  await click("全选内容"); assert.equal(document.activeElement, text()); assert.equal(text().selectionEnd, originalContent.length);
  await click("复制全部"); assert.deepEqual(copied, [originalContent]); assert.match(dialog().textContent, /已复制全部内容/);
  await click("下载 TXT"); assert.equal(downloads[0].filename, "fixture source.txt"); assert.equal(await objectBlobs[0].text(), originalContent);
  await closeEscape(); assert.equal(dialog(), null); assert.equal(container.querySelector("#account-export-content"), null); assert.equal(document.body.style.overflow, "");
  assert.equal(document.activeElement, menu.querySelector("summary"), "closing restores focus to the More menu trigger");

  await click("导出 AT 信息");
  assert.deepEqual(exports().at(-1).body, { ids: ["one", "three"] });
  assert.equal(container.querySelector('[aria-label="AT 导出格式"]').value, "email-at");
  const emailTokens = entries.map((entry) => `${entry.email}----${entry.accessToken}`).join("\n");
  assert.equal(text().value, emailTokens); assert.match(dialog().textContent, /跳过 1 条/); assert.match(dialog().textContent, /ChatGPT 会话 1 条 · OAuth 授权 1 条/); assert.match(dialog().textContent, /已过期 1 条 · 期限未知 1 条/); assert.match(dialog().textContent, /不自动刷新/);
  assert.equal(downloads.length, 1, "AT preview also waits for an explicit download action");
  await changeFormat("at"); const rawTokens = entries.map((entry) => entry.accessToken).join("\n"); assert.equal(text().value, rawTokens);
  failCopy = true; await click("复制全部"); assert.match(dialog().textContent, /无法访问剪贴板，内容已选中/); assert.equal(document.activeElement, text()); assert.equal(text().selectionEnd, rawTokens.length);
  failCopy = false; await click("复制全部"); assert.equal(copied.at(-1), rawTokens);
  await click("下载 TXT"); assert.match(downloads.at(-1).filename, /^chatgpt-account-at-2-accounts-/); assert.equal(await objectBlobs.at(-1).text(), rawTokens);
  assert.ok(text().value.includes("fixture-session-expired-token"), "expired AT values remain exportable");
  await act(() => dialog().dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }))); assert.ok(dialog(), "clicking inside does not dismiss the preview");
  await act(() => dialog().parentElement.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }))); assert.equal(dialog(), null);

  tokenExport = { requested: 2, exported: 0, entries: [], skipped: [{ email: "one@fixture.invalid", reason: "未保存 AT" }, { email: "three@fixture.invalid", reason: "未保存 AT" }] };
  await click("导出 AT 信息"); assert.ok(dialog()); assert.match(dialog().textContent, /所选账号没有可导出的已保存 AT/); assert.match(dialog().textContent, /跳过 2 条/);
  for (const label of ["全选内容", "复制全部", "下载 TXT"]) assert.equal(button(label).disabled, true);
  await closeEscape(); tokenExport = { requested: 2, exported: 2, entries, skipped: [] };

  await click("导出 AT 信息"); assert.equal(container.querySelector('[aria-label="AT 导出格式"]').value, "email-at", "new exports reset both format and copy status");
  assert.doesNotMatch(dialog().textContent, /已复制全部内容/);
  await click("MFA 修改", container.querySelector(".workspace-tabs")); assert.equal(dialog(), null); assert.equal(text(), null);
  await click("账号授权", container.querySelector(".workspace-tabs")); assert.equal(dialog(), null, "route changes discard the previous secret result");

  holdExport = true;
  await click("导出 AT 信息"); assert.equal(pending.length, 1);
  await click("MFA 修改", container.querySelector(".workspace-tabs")); assert.equal(pending[0].signal.aborted, true);
  await click("账号授权", container.querySelector(".workspace-tabs"));
  await act(async () => pending.shift().complete()); assert.equal(dialog(), null, "a response arriving after leaving the route cannot restore a preview");

  await click("导出原始信息"); assert.equal(pending.length, 1);
  auth = { ...auth, token: "fixture-export-token-b", workspace: { id: "owner-b" } }; await render();
  assert.equal(pending[0].signal.aborted, true);
  await act(async () => pending.shift().complete()); assert.equal(dialog(), null); assert.doesNotMatch(container.textContent, /fixture-password/);
  holdExport = false; failExport = true;
  await click("导出原始信息"); assert.equal(dialog(), null); assert.match(container.textContent, /fixture-export-failed/);
  assert.equal(downloads.length, 2);

  // Closing during a clipboard promise must not leave a secret dialog mounted.
  let finishCopy; let closeStandalone = false;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: () => new Promise((resolve) => { finishCopy = resolve; }) } } });
  await act(() => root.render(React.createElement(AccountExportDialog, { data: { kind: "source", content: originalContent, requested: 2, exported: 2, filename: "standalone.txt" }, onClose: () => { closeStandalone = true; } })));
  await click("复制全部"); await closeEscape(); assert.equal(closeStandalone, true);
  await act(() => root.render(null)); await act(async () => finishCopy()); assert.equal(dialog(), null);
  console.log("account export UI passed (source and AT previews, cross-page selection, formats, expired/missing metadata, explicit copy/download, clipboard fallback, focus, dismissal, stale responses and workspace isolation)");
} finally {
  await act(() => root.unmount()); dom.window.close(); URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; globalThis.matchMedia = originalMedia;
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else delete globalThis.navigator;
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else delete globalThis.localStorage;
}
