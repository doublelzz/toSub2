import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useEffect, useId, useMemo, useRef, useState } from "react";
import * as icons from "lucide-react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";
import * as filters from "../web/src/task-filters.mjs";
import * as smsOptions from "../web/src/sms-number-options.mjs";

async function loadComponents(file, names, bindings, end) {
  let source = await fs.readFile(new URL(file, import.meta.url), "utf8");
  if (end) source = source.slice(0, source.indexOf(end));
  const code = source.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "");
  const compiled = await transformWithEsbuild(code, file, { loader: "jsx", jsx: "transform" });
  const usedIcons = Object.fromEntries([...code.matchAll(/<([A-Z]\w*)/g)]
    .map((match) => match[1]).filter((name) => icons[name]).map((name) => [name, icons[name]]));
  const scope = { React, useEffect, useId, useMemo, useRef, useState, ...usedIcons, ...bindings };
  return new Function(...Object.keys(scope), `${compiled.code}; return { ${names.join(",")} };`)(...Object.values(scope));
}

const ui = await loadComponents("../web/src/WorkspaceUi.jsx", ["Drawer", "MoreActions", "TaskFilters", "TaskOverview", "ThemeControl", "useCalendarDay", "useDialogFocus"], filters);
const auth = {
  authenticated: true, token: "synthetic-settings-token",
  account: { id: "fixture-admin", role: "admin" }, workspace: { id: "fixture-admin" },
  features: { smsProviders: [{ id: "fixture", name: "测试接码平台", fields: [] }] },
  logout: async () => {},
};
const requests = [];
const page = (name) => () => React.createElement("section", { "data-fixture-page": name });
const { App } = await loadComponents("../web/src/main.jsx", ["App"], {
  ...filters, ...smsOptions, ...ui,
  MfaWorkspace: page("mfa"), EmailRebindWorkspace: page("rebind"),
  OfferWorkspace: page("offers"),
  SmsPoolWorkspace: page("sms-pool"), SmsPoolChoice: () => null, SmsPoolChargeDialog: () => null,
  CdkWorkspace: ({ section }) => React.createElement("section", { "data-fixture-page": `cdk-${section}` }),
  CurrentCdk: () => null, SmsPriceSelector: () => null,
  readWorkspaceValue: () => null, writeWorkspaceValue: () => {}, flushWorkspaceSettings: async () => {},
  cdkFetch: async (url, options = {}) => {
    requests.push({ url, method: options.method || "GET" });
    if (url === "/api/bootstrap") return Response.json(auth);
    if (url.startsWith("/api/jobs?")) return Response.json({ jobs: [], selection: [], stats: {} });
    if (url === "/api/mail-request-config") return Response.json({ ok: true });
    throw new Error(`Unexpected request: ${url}`);
  },
}, "const appRoot =");

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalMatchMedia = globalThis.matchMedia;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.matchMedia = globalThis.matchMedia;
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root");
const root = createRoot(container);
const button = (scope, text) => [...scope.querySelectorAll("button")].find((element) => element.textContent.trim() === text);
const dialog = () => container.querySelector('[role="dialog"]');
async function close() {
  await act(() => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(dialog(), null, "Escape closes the configuration on the current page");
  assert.equal(document.body.style.overflow, "", "closing restores page scrolling");
}

try {
  await act(async () => root.render(React.createElement(App, { auth })));
  for (const label of ["CDK 管理", "安全中心", "我的 CDK", "MFA 修改", "邮箱换绑", "优惠检测", "接码池", "账号授权"]) {
    await act(() => button(container.querySelector(".workspace-tabs"), label).click());
    const currentPage = container.querySelector(".workspace-path strong").textContent;
    for (const [selector, title] of [[".sub2api-toolbar", "Sub2API 配置"], [".mail-request-toolbar", "邮件 API 请求配置"], [".sms-provider-toolbar", "接码平台配置"]]) {
      await act(() => button(container.querySelector(".topbar-actions"), "系统配置").click());
      assert.match(dialog().textContent, /系统配置/);
      await act(() => button(dialog().querySelector(selector), "配置").click());
      assert.ok(dialog(), `${label}: ${title} must render without switching workspaces`);
      assert.equal(container.querySelectorAll('[role="dialog"]').length, 1, "the settings drawer is replaced by its configuration dialog");
      assert.equal(dialog().querySelector("h2").textContent, title);
      assert.equal(container.querySelector(".workspace-path strong").textContent, currentPage, "opening a configuration preserves the current workspace");
      assert.equal(document.body.style.overflow, "hidden");
      await close();
    }
  }
  assert.equal(container.querySelector(".global-error"), null);
  assert.equal(requests.some((request) => /sub2api|sms/.test(request.url)), false, "opening configuration must not contact remote account services");
  console.log("workspace settings UI passed (all eight workspaces, three shared configurations, Escape and scroll restoration)");
} finally {
  await act(() => root.unmount());
  dom.window.close();
  globalThis.matchMedia = originalMatchMedia;
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else delete globalThis.localStorage;
}
