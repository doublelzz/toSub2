import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import * as icons from "lucide-react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";
import * as filters from "../web/src/task-filters.mjs";
import * as smsOptions from "../web/src/sms-number-options.mjs";
import * as proxyUi from "./proxy-pool-ui-support.mjs";

async function load(file, names, bindings = {}, end) {
  let source = await fs.readFile(new URL(file, import.meta.url), "utf8");
  if (end) source = source.slice(0, source.indexOf(end));
  const code = source.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export default /gm, "").replace(/^export /gm, "");
  const compiled = await transformWithEsbuild(code, file, { loader: "jsx", jsx: "transform" });
  const usedIcons = Object.fromEntries([...code.matchAll(/<([A-Z]\w*)/g)].map(match => match[1]).filter(name => icons[name]).map(name => [name, icons[name]]));
  const scope = { ...proxyUi, React, useCallback, useEffect, useId, useMemo, useRef, useState, ...usedIcons, ...bindings };
  return new Function(...Object.keys(scope), `${compiled.code};return {${names.join(",")}};`)(...Object.values(scope));
}
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const oldStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
const oldMedia = globalThis.matchMedia;
globalThis.matchMedia = window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 100, height: 20 }] : []; };
const ui = await load("../web/src/WorkspaceUi.jsx", ["Drawer", "MoreActions", "TaskFilters", "TaskOverview", "ThemeControl", "useCalendarDay", "useDialogFocus"], filters);
let auth = { authenticated: true, token: "fixture-rebind-owner", account: { id: "owner", role: "user" }, workspace: { id: "owner" }, features: { bulkActions: true }, logout() {} };
const jobs = ["one", "two", "three", "four"].map(id => ({ id, email: `${id}@fixture.invalid`, status: "login_ready", canRebindEmail: id !== "four", canLogoutDevices: id !== "four", prompt: "登录成功，可以管理账号", createdAt: "2026-11-11T01:00:00Z" }));
const calls = []; let busySource = false; let holdState = false; const pendingState = []; let pendingStart; let holdStart = false;
const states = () => ({ sources: [...jobs].reverse().map(job => ({ id: `authorization:${job.id}`, email: job.email, sources: ["authorization"], busy: busySource, rebound: false })), items: [] });
const cdkFetch = async (route, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ route, body, signal: options.signal });
  if (route === "/api/mail-request-config") return Response.json({ ok: true });
  if (route.startsWith("/api/jobs?")) {
    const page = Number(new URL(route, "http://fixture").searchParams.get("page") || 1);
    return Response.json({ jobs: jobs.slice((page - 1) * 2, page * 2), selection: jobs, stats: { total: 4 }, pagination: { page, pageSize: 2, total: 4, totalPages: 2 } });
  }
  if (route === "/api/rebind/state") return holdState
    ? new Promise(resolve => pendingState.push({ signal: options.signal, complete: () => resolve(Response.json(states())) })) : Response.json(states());
  if (route === "/api/rebind/preview") return Response.json({ digest: "fixture-reviewed-mapping", rows: body.ids.map((id, index) => ({ oldEmail: states().sources.find(row => row.id === id).email, newEmail: body.text.split("\n")[index], mode: "manual" })) });
  if (route === "/api/rebind/start") return holdStart ? new Promise(resolve => { pendingStart = () => resolve(Response.json({ batchId: "fixture-batch", count: body.ids.length })); }) : Response.json({ batchId: "fixture-batch", count: body.ids.length });
  if (route === "/api/jobs/logout-devices-batch") return Response.json({ accountId: "logout-task", started: body.ids.length });
  throw Error(`Unexpected authorization rebind request: ${route}`);
};
const rebind = await load("../web/src/EmailRebindWorkspace.jsx", ["AuthorizationRebindDialog"], { ...ui, cdkFetch, prepareProxyNetworkOptions: async () => ({}) });
const noop = () => null;
const { App } = await load("../web/src/main.jsx", ["App"], {
  ...filters, ...smsOptions, ...ui, ...rebind, cdkFetch,
  MfaWorkspace: noop, OfferWorkspace: noop, SmsPoolWorkspace: noop, SmsPoolChoice: noop, SmsPoolChargeDialog: noop,
  CdkWorkspace: noop, CurrentCdk: noop, SmsPriceSelector: noop, SmsServiceSelector: noop,
  EmailRebindWorkspace: ({ initialTab }) => React.createElement("div", { "data-testid": "rebind-records" }, `换绑视图：${initialTab}`),
  readWorkspaceValue: () => null, writeWorkspaceValue() {}, flushWorkspaceSettings: async () => {},
}, "const appRoot =");
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root"); const root = createRoot(container);
const button = (label, scope = container) => [...scope.querySelectorAll("button")].find(row => row.textContent.trim() === label);
const click = (label, scope) => act(async () => { const target = button(label, scope); assert.ok(target, label); target.focus(); target.click(); });
const select = email => act(() => container.querySelector(`[aria-label="选择 ${email}"]`).click());
const close = () => act(() => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
const fill = value => act(() => {
  const field = container.querySelector(".rebind-mapping-dialog textarea");
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(field, value);
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
});
const render = () => act(async () => root.render(React.createElement(App, { auth })));
try {
  await render();
  const firstRow = container.querySelector(".authorization-table tbody tr");
  assert.equal(button("邮箱换绑", firstRow).closest(".more-actions"), null, "single-account action is directly visible");
  await act(async () => button("邮箱换绑", firstRow).click());
  assert.equal(container.querySelectorAll(".rebind-map-review li").length, 1);
  assert.match(container.querySelector(".rebind-map-review").textContent, /one@fixture.invalid/);
  assert.equal(calls.some(call => call.route === "/api/rebind/start"), false, "opening configuration cannot start a rebind");
  await close();
  assert.equal(container.querySelector(".rebind-mapping-dialog"), null);
  await select("one@fixture.invalid");
  await act(async () => container.querySelector('[aria-label="下一页"]').click());
  await select("three@fixture.invalid");
  await click("邮箱换绑（2）");
  const mapped = [...container.querySelectorAll(".rebind-map-review li")].map(row => row.textContent);
  assert.match(mapped[0], /one@fixture.invalid/); assert.match(mapped[1], /three@fixture.invalid/);
  await fill("new-one@example.com\nnew-three@example.com");
  await click("核对映射");
  assert.deepEqual(calls.find(call => call.route === "/api/rebind/preview").body.ids, ["authorization:one", "authorization:three"]);
  holdStart = true;
  await click("确认并开始换绑（2）");
  assert.equal(button("确认并开始换绑（2）").disabled, true);
  assert.equal(calls.filter(call => call.route === "/api/rebind/start").length, 1);
  await act(async () => pendingStart());
  assert.match(container.querySelector('[data-testid="rebind-records"]').textContent, /records/);
  assert.equal(container.querySelector(".rebind-mapping-dialog"), null);

  await click("账号授权");
  const unavailable = [...container.querySelectorAll(".authorization-table tbody tr")].find(row => row.textContent.includes("four@fixture.invalid"));
  assert.equal(button("邮箱换绑", unavailable).disabled, true);
  busySource = true;
  await click("邮箱换绑", container.querySelector(".authorization-table"));
  assert.match(container.textContent, /正在执行其他操作或已完成换绑/);
  await close(); busySource = false;

  holdState = true;
  await click("邮箱换绑", container.querySelector(".authorization-table"));
  assert.equal(pendingState.length, 1);
  await click("MFA 修改");
  assert.equal(pendingState[0].signal.aborted, true);
  await act(async () => pendingState.shift().complete());
  await click("账号授权");
  assert.equal(container.querySelector(".rebind-mapping-dialog"), null, "leaving authorization clears pending account selection");
  await click("邮箱换绑", container.querySelector(".authorization-table"));
  auth = { ...auth, token: "fixture-new-scope", workspace: { id: "different-owner" } };
  await render();
  assert.equal(pendingState[0].signal.aborted, true);
  await act(async () => pendingState.shift().complete());
  assert.equal(container.querySelector(".rebind-mapping-dialog"), null, "old workspace response cannot open another workspace's dialog");
  holdState = false;
  await select("three@fixture.invalid");
  await act(async () => container.querySelector('[aria-label="上一页"]').click());
  await select("one@fixture.invalid");
  let confirmLogout = false;
  window.confirm = () => confirmLogout;
  await click("登出设备（2）");
  assert.equal(calls.some(call => call.route === "/api/jobs/logout-devices-batch"), false);
  confirmLogout = true;
  await click("登出设备（2）");
  assert.deepEqual(calls.find(call => call.route === "/api/jobs/logout-devices-batch").body.ids, ["three", "one"]);
  assert.equal(calls.some(call => call.route.endsWith("/change-mfa")), false);
  console.log("Authorization email rebind UI passed (direct row action, cross-page batch, fixed mapping, confirmation, busy guards, record navigation, cancellation and CDK isolation).");
} finally {
  await act(() => root.unmount()); dom.window.close(); globalThis.matchMedia = oldMedia;
  if (oldStorage) Object.defineProperty(globalThis, "localStorage", oldStorage); else delete globalThis.localStorage;
}
