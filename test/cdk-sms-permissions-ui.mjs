import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import * as icons from "lucide-react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";
import * as filters from "../web/src/task-filters.mjs";
import * as smsOptions from "../web/src/sms-number-options.mjs";

async function load(file, names, bindings = {}, end) {
  let source = await fs.readFile(new URL(file, import.meta.url), "utf8");
  if (end) source = source.slice(0, source.indexOf(end));
  const code = source.replace(/^import[\s\S]*?;\r?\n/gm, "").replace("export default function", "function").replace(/^export /gm, "");
  const compiled = await transformWithEsbuild(code, file, { loader: "jsx", jsx: "transform" });
  const usedIcons = Object.fromEntries([...code.matchAll(/<([A-Z]\w*)/g)].map((match) => match[1]).filter((name) => icons[name]).map((name) => [name, icons[name]]));
  const scope = { React, useCallback, useEffect, useId, useMemo, useRef, useState, ...usedIcons, ...bindings };
  return new Function(...Object.keys(scope), `${compiled.code}; return { ${names.join(",")} };`)(...Object.values(scope));
}

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const previousFormData = globalThis.FormData; globalThis.FormData = window.FormData;
const previousMatchMedia = globalThis.matchMedia;
globalThis.matchMedia = window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
const { createRoot } = await import("react-dom/client"); const container = document.getElementById("root"); const root = createRoot(container);
const ui = await load("../web/src/WorkspaceUi.jsx", ["Drawer", "MoreActions", "TaskFilters", "TaskOverview", "ThemeControl", "useCalendarDay", "useDialogFocus"], filters);
const button = (label, scope = container) => [...scope.querySelectorAll("button")].find((element) => element.textContent.trim() === label);
const click = (label, scope) => act(async () => { assert.ok(button(label, scope), `Missing button ${label}`); button(label, scope).click(); });
const checkbox = (label) => { const input = container.querySelector(`[aria-label="${label}"]`); assert.ok(input, `Missing checkbox ${label}`); return input; };
const check = (label) => act(async () => checkbox(label).click());
const fill = async (element, value) => act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(element, value); element.dispatchEvent(new window.Event("input", { bubbles: true })); });

try {
  let ordinary = { id: "fixture-user", label: "TS2-fixture-user", role: "user", status: "active", balance: 20, reserved: 0, consumed: 0, accounts: 0, note: "Fixture" };
  const administrator = { id: "fixture-admin", label: "TS2-fixture-admin", role: "admin", status: "active", balance: 0, consumed: 0, accounts: 0 };
  const calls = [];
  const adminAuth = { account: administrator, workspace: administrator, token: "fixture-token", reload: async () => {}, switchWorkspace: async () => {} };
  const { CdkWorkspace } = await load("../web/src/CdkWorkspace.jsx", ["CdkWorkspace"], { ...ui, requestId: () => "fixture-id", cdkFetch: async (url, options = {}) => {
    const method = options.method || "GET"; const body = options.body ? JSON.parse(options.body) : null; calls.push({ url, method, body });
    if (url === "/api/admin/cdks" && method === "GET") return Response.json({ items: [ordinary, administrator] });
    if (url === "/api/admin/security/events" || url === "/api/admin/imports") return Response.json({ items: [] });
    if (url.endsWith("/ledger")) return Response.json({ cdk: ordinary, items: [] });
    if (url === `/api/admin/cdks/${ordinary.id}` && method === "PATCH") { ordinary = { ...ordinary, ...body }; return Response.json(ordinary); }
    if (url === "/api/admin/cdks" && method === "POST") return Response.json({ items: [{ ...ordinary, allowedSmsProviders: body.allowedSmsProviders, secret: "fixture-issued-cdk" }] });
    throw Error(`Unexpected administrator request ${method} ${url}`);
  } });
  await act(async () => root.render(React.createElement(CdkWorkspace, { auth: adminAuth, section: "management", onNavigate() {} })));
  await click("详情");
  assert.equal(checkbox("允许自定义接码").checked, true); assert.equal(checkbox("允许自定义接码").disabled, true);
  for (const label of ["允许鲁班接码", "允许SMSBower", "允许Hero SMS", "允许接码池"]) assert.equal(checkbox(label).checked, false, "old and new ordinary CDKs default to custom only");
  await check("允许SMSBower"); await click("保存接码权限");
  assert.deepEqual(calls.findLast((call) => call.method === "PATCH").body, { allowedSmsProviders: ["custom", "smsbower"] });
  assert.equal(checkbox("允许SMSBower").checked, true); assert.match(container.textContent, /接码方式权限已保存/);
  await check("允许SMSBower"); await click("保存接码权限");
  assert.deepEqual(calls.findLast((call) => call.method === "PATCH").body, { allowedSmsProviders: ["custom"] });
  await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await click("生成 CDK");
  assert.equal(checkbox("允许SMSBower").checked, false); await check("允许Hero SMS");
  await fill(container.querySelector('input[name="note"]'), "New fixture");
  await click("生成并显示 CDK");
  assert.deepEqual(calls.findLast((call) => call.method === "POST").body.allowedSmsProviders, ["custom", "herosms"], "generation can grant providers before the CDK is issued");

  const definitions = [
    { id: "luban", name: "鲁班接码", fields: [{ key: "apiKey", label: "API Key" }] },
    { id: "smsbower", name: "SMSBower", fields: [{ key: "apiKey", label: "API Key" }] },
    { id: "herosms", name: "Hero SMS", fields: [{ key: "apiKey", label: "API Key" }] },
    { id: "custom", name: "自定义接码", fields: [{ key: "entries", label: "号码与接码 API", type: "textarea" }] },
    { id: "pool", name: "接码池", fields: [] },
  ];
  let featureProviders = [definitions[3]];
  let permissionChanges = 0;
  window.addEventListener("cdk-sms-permissions-changed", () => { permissionChanges++; });
  const savedSettings = [];
  let stored = { selectedProviderId: "herosms", configs: { custom: { entries: "+12025550123----https://fixture.example.invalid/code" }, herosms: { apiKey: "hidden-fixture-key" } } };
  const auth = () => ({ authenticated: true, token: "fixture-user-token", account: ordinary, workspace: ordinary, features: { smsProviders: featureProviders, allowedSmsProviders: featureProviders.map((row) => row.id), bulkActions: true }, logout: async () => {} });
  const { App, withSmsProviderDefaults } = await load("../web/src/main.jsx", ["App", "withSmsProviderDefaults"], {
    ...filters, ...smsOptions, ...ui,
    MfaWorkspace: () => null, EmailRebindWorkspace: () => null, OfferWorkspace: () => null, SmsPoolWorkspace: () => null, SmsPoolChoice: () => null, SmsPoolChargeDialog: () => null,
    CdkWorkspace: () => null, CurrentCdk: () => null, SmsPriceSelector: () => null,
    readWorkspaceValue: (key) => key === "chatgpt-onboarding.sms-provider-settings-v1" ? JSON.stringify(stored) : null,
    writeWorkspaceValue: (key, value) => { if (key === "chatgpt-onboarding.sms-provider-settings-v1") savedSettings.push(JSON.parse(value)); }, flushWorkspaceSettings: async () => {},
    cdkFetch: async (url) => {
      if (url === "/api/bootstrap") return Response.json(auth());
      if (url.startsWith("/api/jobs?")) return Response.json({ jobs: [], selection: [], stats: {}, features: { smsProviders: featureProviders, allowedSmsProviders: featureProviders.map((row) => row.id) } });
      if (url === "/api/mail-request-config") return Response.json({ ok: true });
      throw Error(`Unexpected ordinary request ${url}`);
    },
  }, "const appRoot =");
  assert.equal(withSmsProviderDefaults(definitions, { selectedProviderId: "removed", configs: {} }).selectedProviderId, "custom", "removed providers fall back to custom even when it is not the first definition");
  await act(async () => root.render(React.createElement(App, { key: "ordinary", auth: auth() })));
  assert.equal(permissionChanges, 0, "the initial provider list never starts a refresh loop");
  await click("配置", container.querySelector(".workspace-tabs"));
  assert.equal(container.querySelector(".sms-provider-toolbar .provider-name").textContent, "自定义接码");
  await click("配置", container.querySelector(".sms-provider-toolbar"));
  assert.deepEqual([...container.querySelectorAll('.provider-tabs [role="tab"]')].map((row) => row.textContent), ["自定义接码"]);
  assert.doesNotMatch(container.querySelector('[role="dialog"]').textContent, /鲁班|SMSBower|Hero SMS|接码池/);
  assert.equal(savedSettings.at(-1).selectedProviderId, "custom"); assert.equal(savedSettings.at(-1).configs.herosms, undefined, "hidden cached provider credentials are never retained as active settings");
  featureProviders = [definitions[1], definitions[3]];
  await act(async () => root.render(React.createElement(App, { key: "ordinary", auth: auth() })));
  assert.deepEqual([...container.querySelectorAll('.provider-tabs [role="tab"]')].map((row) => row.textContent), ["SMSBower", "自定义接码"]);
  await act(async () => container.querySelector('.provider-tabs [role="tab"]').click());
  assert.equal(container.querySelector('.provider-tabs [aria-selected="true"]').textContent, "SMSBower");
  featureProviders = [definitions[3], definitions[1]];
  await act(async () => root.render(React.createElement(App, { key: "ordinary", auth: auth() })));
  assert.equal(container.querySelector('.provider-tabs [aria-selected="true"]').textContent, "SMSBower", "provider order changes do not reset the open tab");
  featureProviders = [definitions[3]];
  await act(async () => root.render(React.createElement(App, { key: "ordinary", auth: auth() })));
  assert.deepEqual([...container.querySelectorAll('.provider-tabs [role="tab"]')].map((row) => row.textContent), ["自定义接码"]);
  assert.equal(container.querySelector('.provider-tabs [aria-selected="true"]').textContent, "自定义接码", "revocation immediately repairs an open configuration draft");
  assert.doesNotMatch(container.querySelector('[role="dialog"]').textContent, /SMSBower|Hero SMS|鲁班|接码池/);
  const afterRevocation = permissionChanges;
  featureProviders = [definitions[3], definitions[4]];
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 1000)));
  assert.deepEqual([...container.querySelectorAll('.provider-tabs [role="tab"]')].map((row) => row.textContent), ["自定义接码", "接码池"], "the existing jobs poll applies newly granted providers without reloading the app");
  assert.equal(permissionChanges, afterRevocation + 1);
  const persistedAfterGrant = savedSettings.length;
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 1000)));
  assert.equal(permissionChanges, afterRevocation + 1, "identical permission snapshots do not dispatch repeated refresh events");
  assert.equal(savedSettings.length, persistedAfterGrant, "identical poll snapshots do not rewrite or reset settings drafts");
  console.log("CDK SMS permissions UI passed (custom-only defaults, administrator grant/revoke and issue-time choice, filtered platform tabs, cached credential removal and live draft fallback)");
} finally {
  await act(async () => root.unmount()); dom.window.close(); globalThis.FormData = previousFormData; globalThis.matchMedia = previousMatchMedia;
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else delete globalThis.localStorage;
}
