import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as icons from "lucide-react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";
import { createAnnouncementSanitizer, MAX_ANNOUNCEMENT_BYTES } from "../src/announcement-html.mjs";
import * as readState from "../web/src/announcement-read-state.mjs";
import * as filters from "../web/src/task-filters.mjs";
import * as smsOptions from "../web/src/sms-number-options.mjs";

async function load(file, names, bindings = {}, end) {
  let source = await fs.readFile(new URL(file, import.meta.url), "utf8");
  if (end) source = source.slice(0, source.indexOf(end));
  const code = source.replace(/^import[\s\S]*?;\r?\n/gm, "")
    .replace("export default function", "function").replace(/^export /gm, "");
  const compiled = await transformWithEsbuild(code, file, { loader: "jsx", jsx: "transform" });
  const usedIcons = Object.fromEntries([...code.matchAll(/<([A-Z]\w*)/g)]
    .map((match) => match[1]).filter((name) => icons[name]).map((name) => [name, icons[name]]));
  const scope = { React, useCallback, useEffect, useId, useMemo, useRef, useState, createPortal, ...usedIcons, ...bindings };
  return new Function(...Object.keys(scope), `${compiled.code}; return { ${names.join(",")} };`)(...Object.values(scope));
}

const dom = new JSDOM('<button id="outside">Outside</button><div id="root"></div>', { url: "http://localhost" });
const globals = new Map(["window", "document", "HTMLElement", "MutationObserver", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"]
  .map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver, navigator: dom.window.navigator, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
window.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 10, height: 10 }] : []; };
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const copied = [];
Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async (value) => copied.push(value) } });
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root");
const root = createRoot(container);
const { useDialogFocus } = await load("../web/src/WorkspaceUi.jsx", ["useDialogFocus"]);
let assertions = 0;
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const check = (condition, message) => { assert.ok(condition, message); assertions++; };
const match = (actual, expression, message) => { assert.match(actual, expression, message); assertions++; };
const settle = async () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
async function render(element) { await act(async () => root.render(element)); await settle(); }
const button = (label, scope = document) => [...scope.querySelectorAll("button")].find((element) => element.textContent.trim() === label);
async function click(label, scope = document) {
  const element = button(label, scope); assert.ok(element, `Missing button: ${label}`);
  await act(async () => element.click()); await settle();
}
async function fill(element, value) {
  assert.ok(element, "Missing form field");
  const prototype = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await settle();
}
async function escape() {
  await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await settle();
}
const dialog = () => document.querySelector(".announcement-dialog");
const fixtureContent = '<h2>📖 导入教程</h2><p class="notice-warning modal-backdrop" style="color: #916015; font-weight: 600; position: fixed">重点 😂</p>'
  + '<table><thead><tr><th>字段</th></tr></thead><tbody><tr><td>邮箱</td></tr></tbody></table>'
  + '<pre><code>a@example.com----example-password\nb@example.com----another-password</code></pre>'
  + '<a href="https://example.com/help">详细说明</a><img src="https://example.com/guide.png" alt="示例" onerror="window.bad=true">'
  + '<script>window.bad=true</script><iframe src="https://example.com"></iframe>';
const fixture = (id, patch = {}) => ({ enabled: true, id, title: "使用说明", content: fixtureContent,
  publishedAt: "2026-11-01T02:00:00.000Z", updatedAt: "2026-11-01T02:00:00.000Z", ...patch });

let saved = fixture("manager-v1", { content: "<p>原始教程</p>" });
let conflicts = false;
let revision = 0;
let heldSave = null;
const calls = [];
const changes = [];
const editorStates = [];
const recordEditorState = (value) => editorStates.push(value);
const cdkFetch = async (url, options = {}) => {
  equal(url, "/api/admin/announcement", "editor uses the administrator announcement endpoint");
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ method, body, token: options.headers?.["x-console-token"] });
  if (method === "GET") return Response.json({ announcement: saved });
  if (heldSave) await heldSave;
  if (conflicts) {
    conflicts = false;
    saved = { ...saved, title: "其他管理窗口的修改", updatedAt: "2026-11-01T03:00:00.000Z" };
    return Response.json({ error: "公告已在其他窗口修改，请重新读取" }, { status: 409 });
  }
  revision++;
  saved = { ...saved, title: body.title, content: createAnnouncementSanitizer(window)(body.content), enabled: body.enabled,
    updatedAt: `2026-11-01T02:00:${String(revision).padStart(2, "0")}.000Z`,
    ...(body.publish ? { id: `manager-published-${revision}`, publishedAt: `2026-11-01T02:00:${String(revision).padStart(2, "0")}.000Z` } : {}) };
  return Response.json({ announcement: saved });
};
const components = await load("../web/src/Announcement.jsx", ["AnnouncementContent", "AnnouncementDialog", "AnnouncementManager"],
  { useDialogFocus, createAnnouncementSanitizer, MAX_ANNOUNCEMENT_BYTES, cdkFetch });
const { AnnouncementEntry } = await load("../web/src/AnnouncementEntry.jsx", ["AnnouncementEntry"], { ...components, ...readState });

try {
  await render(React.createElement(AnnouncementEntry, { announcement: fixture("reader-v1") }));
  check(dialog(), "an unread announcement opens automatically");
  equal(document.body.style.overflow, "hidden", "opening announcement protects reading focus and scroll");
  const content = dialog().querySelector(".announcement-content");
  match(content.textContent, /重点 😂/, "Unicode emoji and tutorial text survive rendering");
  check(content.querySelector("table th"), "tutorial tables render");
  check(content.querySelector(".notice-warning").style.color, "limited inline text colors are retained");
  equal(content.querySelector(".notice-warning").style.position, "", "layout-changing styles are removed");
  equal(content.querySelector(".modal-backdrop"), null, "application-wide classes cannot leak into announcement markup");
  equal(content.querySelector("script, iframe, [onerror]"), null, "unsafe HTML never reaches the live content");
  equal(window.bad, undefined, "unsafe HTML does not execute");
  equal(content.querySelector("a").getAttribute("rel"), "noopener noreferrer", "tutorial links isolate the new tab");
  await click("复制示例", dialog());
  equal(copied.at(-1), "a@example.com----example-password\nb@example.com----another-password", "copy preserves the exact example without button labels");
  match(dialog().textContent, /示例已复制/, "successful copy has readable feedback");
  window.navigator.clipboard.writeText = async () => { throw new Error("Synthetic clipboard denial"); };
  await click("复制示例", dialog());
  equal(window.getSelection().toString(), copied.at(-1), "clipboard denial selects the example for manual copy");
  match(dialog().textContent, /请手动复制/, "clipboard denial has a usable fallback");
  window.navigator.clipboard.writeText = async (value) => copied.push(value);
  await act(async () => dialog().parentElement.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true })));
  check(dialog(), "clicking the backdrop does not silently dismiss a tutorial");
  await escape();
  equal(dialog(), null, "Escape closes the announcement");
  check(JSON.parse(window.localStorage.getItem(readState.ANNOUNCEMENT_READ_KEY)).includes("reader-v1"), "closing persists the displayed revision in browser storage");
  equal(document.body.style.overflow, "", "closing restores page scrolling");

  await render(null);
  const freshState = await import(`../web/src/announcement-read-state.mjs?announcement-ui=${Date.now()}`);
  const { AnnouncementEntry: FreshEntry } = await load("../web/src/AnnouncementEntry.jsx", ["AnnouncementEntry"], { ...components, ...freshState });
  await render(React.createElement(FreshEntry, { key: "another-cdk", announcement: fixture("reader-v1") }));
  equal(dialog(), null, "a new component and fresh module read the persisted revision, including after changing CDK");
  await render(React.createElement(FreshEntry, { key: "another-cdk", announcement: fixture("reader-v1", { content: "<p>修正一个错别字</p>" }) }));
  equal(dialog(), null, "saving content with the same revision does not interrupt the reader again");
  await click("公告 / 教程");
  match(dialog().textContent, /修正一个错别字/, "the permanent entry reopens the latest content of a dismissed revision");
  await click("我知道了，本版不再提示");
  await render(React.createElement(FreshEntry, { announcement: fixture("reader-v2") }));
  check(dialog(), "publishing a new revision opens an announcement again");
  await act(async () => dialog().querySelector('[aria-label="关闭公告，本版不再提示"]').click());
  await settle();
  equal(dialog(), null, "the close icon also dismisses the current revision");
  await render(React.createElement(FreshEntry, { announcement: fixture("reader-v2", { enabled: false }) }));
  equal(document.querySelector(".announcement-entry"), null, "disabled announcements hide both popup and manual entry");

  const blocker = document.createElement("section");
  blocker.setAttribute("role", "dialog"); blocker.setAttribute("aria-modal", "true");
  blocker.textContent = "Another task confirmation"; document.body.append(blocker);
  await render(React.createElement(FreshEntry, { announcement: fixture("reader-delayed") }));
  equal(dialog(), null, "an announcement waits while another task dialog is active");
  await act(async () => blocker.remove()); await settle();
  check(dialog(), "the pending announcement opens after the task dialog closes");
  await act(async () => {
    window.localStorage.setItem(readState.ANNOUNCEMENT_READ_KEY, JSON.stringify(["reader-delayed"]));
    window.dispatchEvent(new window.StorageEvent("storage", { key: readState.ANNOUNCEMENT_READ_KEY, storageArea: window.localStorage }));
  });
  equal(dialog(), null, "dismissal in another browser tab closes the same displayed revision");

  await render(null);
  const storageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("Synthetic unavailable storage"); } });
  try {
    await render(React.createElement(FreshEntry, { key: "storage-denied", announcement: fixture("reader-no-storage") }));
    check(dialog(), "an announcement remains readable when browser storage is unavailable");
    await escape();
    await render(null);
    await render(React.createElement(FreshEntry, { key: "storage-denied-remount", announcement: fixture("reader-no-storage") }));
    equal(dialog(), null, "memory fallback prevents repeat prompts in the current session");
  } finally { Object.defineProperty(window, "localStorage", storageDescriptor); }

  await render(React.createElement(React.StrictMode, null, React.createElement(components.AnnouncementContent, { content: fixtureContent })));
  equal(container.querySelectorAll(".announcement-code-copy").length, 1, "StrictMode effect replay does not duplicate copy controls");
  await render(React.createElement(React.StrictMode, null, React.createElement(components.AnnouncementContent, { content: fixtureContent, className: "rerender-fixture" })));
  equal(container.querySelectorAll(".announcement-code-copy").length, 1, "rerendering identical HTML retains exactly one copy control");
  const copiesBeforeRepeat = copied.length;
  await click("复制示例", container); await click("复制示例", container);
  equal(copied.length, copiesBeforeRepeat + 2, "copy feedback leaves the same example usable repeatedly");
  await render(React.createElement(React.StrictMode, null, React.createElement(components.AnnouncementContent,
    { content: "<pre><code>updated-one</code></pre><pre><code>updated-two</code></pre>" })));
  equal(container.querySelectorAll(".announcement-code-copy").length, 2, "updating HTML rebuilds controls for the new code blocks without stale wrappers");

  await render(React.createElement(components.AnnouncementManager, { token: "fixture-admin-token", onChanged: (value) => changes.push(value), onStateChange: recordEditorState }));
  equal(editorStates.at(-1), { dirty: false, busy: false }, "editor reports its initial clean and idle state to the containing page");
  equal(container.querySelector(".announcement-title-field input").value, "使用说明", "administrator editor loads the persisted title");
  equal(container.querySelector("textarea").value, "<p>原始教程</p>", "administrator editor loads the persisted HTML");
  equal(calls.at(-1).token, "fixture-admin-token", "administrator requests send the authenticated token");
  await fill(container.querySelector("textarea"), fixtureContent);
  equal(editorStates.at(-1), { dirty: true, busy: false }, "editing reports an unsaved draft to navigation guards");
  match(container.querySelector(".announcement-preview-pane").textContent, /重点 😂/, "editing updates the live HTML preview");
  equal(container.querySelector(".announcement-preview-pane script"), null, "the live editor preview shares HTML cleaning");
  match(container.textContent, /有未保存的修改/, "edited content has a visible unsaved state");
  const readsBeforePreview = window.localStorage.getItem(readState.ANNOUNCEMENT_READ_KEY);
  await click("弹窗预览");
  check(dialog(), "administrator can inspect the actual user popup");
  match(dialog().textContent, /不会记录为已读/, "preview distinguishes itself from a user announcement");
  await escape();
  equal(window.localStorage.getItem(readState.ANNOUNCEMENT_READ_KEY), readsBeforePreview, "preview close does not change any read receipt");
  await click("保存修改");
  const update = calls.findLast((call) => call.method === "PUT").body;
  equal(update.publish, false, "save modification preserves the existing publication instead of republishing");
  equal(update.expectedUpdatedAt, "2026-11-01T02:00:00.000Z", "save checks the version the editor actually loaded");
  equal(saved.id, "manager-v1", "ordinary save keeps the announcement revision");
  match(container.textContent, /已关闭本版的浏览器不会再次提醒/, "save feedback explains the reader impact");
  await act(async () => container.querySelector('.announcement-enabled input').click());
  await click("发布新版本");
  const publication = calls.findLast((call) => call.method === "PUT").body;
  equal(publication.publish, true, "publishing explicitly requests a new revision");
  equal(publication.enabled, true, "publishing enables the announcement even if the editor toggle was off");
  check(saved.id !== "manager-v1", "new publication has a different read-receipt identity");
  equal(changes.length, 2, "successful updates refresh the application's published state");
  await fill(container.querySelector(".announcement-title-field input"), "当前窗口的未保存内容");
  conflicts = true;
  await click("保存修改");
  match(container.querySelector('[role="alert"]').textContent, /其他窗口修改/, "concurrent edits surface a useful conflict error");
  equal(container.querySelector(".announcement-title-field input").value, "当前窗口的未保存内容", "a conflict does not discard the user's draft");
  await click("重新读取（替换未保存内容）");
  equal(container.querySelector(".announcement-title-field input").value, "其他管理窗口的修改", "explicit reload resolves the editor to the new persisted content");
  await fill(container.querySelector("textarea"), "字".repeat(34_000));
  equal(button("保存修改").disabled, true, "UTF-8 byte limits prevent oversize saves");
  equal(button("发布新版本").disabled, true, "UTF-8 byte limits prevent oversize publication");
  match(container.querySelector(".announcement-preview-pane").textContent, /超过 100 KB/, "oversize content explains how to restore the preview");
  await render(null);
  equal(editorStates.at(-1), { dirty: false, busy: false }, "unmounting clears the editor guard state");

  let logoutCalls = 0;
  let confirmLeave = false;
  const confirmationMessages = [];
  window.confirm = (message) => { confirmationMessages.push(message); return confirmLeave; };
  const auth = {
    authenticated: true, token: "fixture-admin-token", account: { id: "fixture-admin", role: "admin" },
    workspace: { id: "fixture-admin", balance: 10 }, features: { smsProviders: [] },
    reload: async () => {}, logout: async () => { logoutCalls++; }, switchWorkspace: async () => {},
  };
  const ui = await load("../web/src/WorkspaceUi.jsx", ["Drawer", "MoreActions", "TaskFilters", "TaskOverview", "ThemeControl", "useCalendarDay", "useDialogFocus"], filters);
  const empty = () => null;
  const { App } = await load("../web/src/main.jsx", ["App"], {
    ...filters, ...smsOptions, ...ui,
    AnnouncementManager: components.AnnouncementManager, AnnouncementEntry: empty,
    MfaWorkspace: empty, EmailRebindWorkspace: empty, OfferWorkspace: empty, SmsPoolWorkspace: empty,
    SmsPoolChoice: empty, SmsPoolChargeDialog: empty, CdkWorkspace: empty, SmsPriceSelector: empty,
    CurrentCdk: ({ onOpen }) => React.createElement("button", { type: "button", onClick: onOpen }, "查看当前 CDK"),
    readWorkspaceValue: () => null, writeWorkspaceValue() {}, flushWorkspaceSettings: async () => {},
    cdkFetch: async (url) => {
      if (url === "/api/bootstrap") return Response.json(auth);
      if (url.startsWith("/api/jobs?")) return Response.json({ jobs: [], selection: [], stats: {} });
      if (url === "/api/mail-request-config") return Response.json({ ok: true });
      throw new Error(`Unexpected app request: ${url}`);
    },
  }, "const appRoot =");
  await render(React.createElement(App, { auth }));
  await click("公告管理", container.querySelector(".workspace-tabs"));
  await fill(container.querySelector(".announcement-title-field input"), "保留当前未保存的教程");
  const leaveActions = [
    ["MFA 修改", ".workspace-tabs"], ["查看当前 CDK", ".topbar-actions"],
    ["切换用户视角", ".topbar-actions"], ["退出", ".topbar-actions"],
  ];
  for (const [label, selector] of leaveActions) {
    await click(label, container.querySelector(selector));
    equal(container.querySelector(".workspace-path strong").textContent, "公告管理", `${label}: cancelling keeps the editor page`);
    equal(container.querySelector(".announcement-title-field input").value, "保留当前未保存的教程", `${label}: cancelling preserves the exact draft`);
  }
  equal(logoutCalls, 0, "cancelled exit never calls the authenticated logout action");
  equal(confirmationMessages.length, 4, "all four exit paths ask once about the unsaved draft");

  let releaseSave;
  heldSave = new Promise((resolve) => { releaseSave = resolve; });
  await click("保存修改");
  const confirmationsBeforeBusyNavigation = confirmationMessages.length;
  await click("MFA 修改", container.querySelector(".workspace-tabs"));
  await click("退出", container.querySelector(".topbar-actions"));
  equal(container.querySelector(".workspace-path strong").textContent, "公告管理", "in-flight saves prevent leaving the editor");
  equal(logoutCalls, 0, "in-flight saves prevent logging out");
  equal(confirmationMessages.length, confirmationsBeforeBusyNavigation, "busy navigation is blocked without offering to discard an active save");
  await act(async () => { releaseSave(); }); await settle(); heldSave = null;

  confirmLeave = true;
  for (const [label, selector, destination] of [
    ["MFA 修改", ".workspace-tabs", "MFA 修改"],
    ["查看当前 CDK", ".topbar-actions", "我的 CDK"],
    ["切换用户视角", ".topbar-actions", "账号授权"],
  ]) {
    await fill(container.querySelector(".announcement-title-field input"), `将离开：${label}`);
    await click(label, container.querySelector(selector));
    equal(container.querySelector(".workspace-path strong").textContent, destination, `${label}: accepting the prompt allows the intended navigation`);
    if (label === "切换用户视角") await click("返回管理视角", container.querySelector(".topbar-actions"));
    await click("公告管理", container.querySelector(".workspace-tabs"));
  }
  await fill(container.querySelector(".announcement-title-field input"), "确认退出时放弃的稿件");
  await click("退出", container.querySelector(".topbar-actions"));
  equal(logoutCalls, 1, "accepting exit invokes authenticated logout exactly once");
  console.log(`announcement UI passed (${assertions} assertions; reader revisions, persistent dismissal, dialog coordination, HTML rendering and copy, administrator preview/save/publish/conflicts)`);
} finally {
  await act(async () => root.unmount());
  dom.window.close();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}
