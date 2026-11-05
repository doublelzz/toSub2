import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useEffect, useRef, useState } from "react";
import { KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
const previous = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root");
const root = createRoot(container);
const calls = [];
const hydrated = [];
let serverAuthenticated = false;
let rejectLogin = false;
let holdLogin = false;
let finishLogin;
let generation = 0;
const auth = { authenticated: true, token: "synthetic-cdk-token", account: { id: "fixture-owner", role: "user" }, workspace: { id: "fixture-owner", allowedSmsProviders: ["custom"] }, settings: {} };
globalThis.fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null;
  calls.push({ url, method: options.method || "GET", body });
  if (url === "/api/bootstrap") return Response.json(serverAuthenticated ? auth : { authenticated: false });
  if (url === "/api/auth/login") {
    assert.deepEqual(Object.keys(body), ["cdk"], "remember preference stays in this browser and does not change the login protocol");
    if (holdLogin) await new Promise((resolve) => { finishLogin = resolve; });
    if (rejectLogin) return Response.json({ error: "CDK 验证失败" }, { status: 401 });
    serverAuthenticated = true;
    return Response.json(auth);
  }
  if (url === "/api/auth/logout") { serverAuthenticated = false; return Response.json({ ok: true }); }
  throw new Error(`Unexpected login request: ${url}`);
};

const componentSource = (await fs.readFile(new URL("../web/src/CdkGate.jsx", import.meta.url), "utf8"))
  .replace(/^import[\s\S]*?;\r?\n/gm, "").replace("export default function", "function");
const compiled = await transformWithEsbuild(componentSource, "CdkGate.jsx", { loader: "jsx", jsx: "transform" });
const bindings = {
  React, useEffect, useRef, useState, KeyRound, LoaderCircle, ShieldCheck,
  ThemeControl: () => null, ImportChargeDialog: () => null,
  clearWorkspaceSettings() {}, flushWorkspaceSettings: async () => {},
  hydrateWorkspaceSettings: (value) => hydrated.push(value), refreshWorkspaceSmsPermissions() {}, setImportConfirmation() {},
};
const { CdkGate, REMEMBERED_CDK_STORAGE_KEY: storageKey } = new Function(...Object.keys(bindings), `${compiled.code}; return { CdkGate, REMEMBERED_CDK_STORAGE_KEY };`)(...Object.values(bindings));
const storage = window.localStorage;
const storagePrototype = window.Storage.prototype;
const originalGet = storagePrototype.getItem;
const originalSet = storagePrototype.setItem;
const originalRemove = storagePrototype.removeItem;
let readBlocked = false; let writeBlocked = false; let removeBlocked = false;
storagePrototype.getItem = function (key) { if (readBlocked) throw new Error("fixture storage unavailable"); return originalGet.call(this, key); };
storagePrototype.setItem = function (key, value) { if (writeBlocked) throw new Error("fixture quota exceeded"); return originalSet.call(this, key, value); };
storagePrototype.removeItem = function (key) { if (removeBlocked) throw new Error("fixture clear denied"); return originalRemove.call(this, key); };
const cdkInput = () => container.querySelector('input[type="password"]');
const remember = () => container.querySelector('input[type="checkbox"]');
const input = async (value) => act(async () => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(cdkInput(), value);
  cdkInput().dispatchEvent(new window.Event("input", { bubbles: true }));
});
const clickRemember = () => act(async () => remember().click());
const submit = () => act(async () => container.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
const logout = () => act(async () => container.querySelector('[data-action="logout"]').click());
const mount = () => act(async () => root.render(React.createElement(CdkGate, { key: ++generation },
  (session) => React.createElement("button", { "data-action": "logout", onClick: session.logout }, "退出登录"))));
const loginCount = () => calls.filter((call) => call.url === "/api/auth/login").length;

try {
  storage.setItem("theme", "dark");
  await mount();
  assert.equal(cdkInput().value, "");
  assert.equal(remember().checked, false, "fresh browser defaults to opt-in");
  assert.equal(loginCount(), 0);
  await input("  synthetic-cdk-first  ");
  await clickRemember();
  assert.equal(storage.getItem(storageKey), null, "checking alone does not save an unverified CDK");
  rejectLogin = true;
  await submit();
  assert.match(container.querySelector('[role="alert"]').textContent, /CDK 验证失败/);
  assert.equal(storage.getItem(storageKey), null, "failed login never caches its input");
  rejectLogin = false;
  await submit();
  assert.ok(container.querySelector('[data-action="logout"]'));
  assert.equal(storage.getItem(storageKey), "synthetic-cdk-first");
  assert.equal(storage.getItem("theme"), "dark");
  await logout();
  assert.equal(cdkInput().value, "synthetic-cdk-first", "logout restores the saved CDK without logging in again");
  assert.equal(remember().checked, true);
  const previousLogins = loginCount();
  await mount();
  assert.equal(cdkInput().value, "synthetic-cdk-first", "reload restores browser-local cache");
  assert.equal(cdkInput().type, "password");
  assert.equal(loginCount(), previousLogins, "restoring a remembered CDK does not trigger automatic login");

  await input("synthetic-invalid-replacement");
  rejectLogin = true;
  await submit();
  assert.equal(storage.getItem(storageKey), "synthetic-cdk-first", "invalid replacement preserves the last verified CDK");
  await clickRemember();
  assert.equal(storage.getItem(storageKey), null, "unchecking immediately removes the saved CDK without another login");
  assert.equal(storage.getItem("theme"), "dark", "clearing login memory preserves unrelated preferences");
  rejectLogin = false;
  await input("synthetic-not-remembered");
  await submit();
  assert.equal(storage.getItem(storageKey), null);
  await logout();
  assert.equal(cdkInput().value, "");
  assert.equal(remember().checked, false);

  await input("synthetic-cdk-second");
  await clickRemember();
  holdLogin = true;
  await submit();
  assert.equal(remember().disabled, true);
  assert.equal(cdkInput().disabled, true);
  assert.equal(storage.getItem(storageKey), null);
  await act(async () => { finishLogin(); });
  holdLogin = false;
  assert.equal(storage.getItem(storageKey), "synthetic-cdk-second");
  serverAuthenticated = false;
  await act(async () => window.dispatchEvent(new window.Event("cdk-session-refresh")));
  assert.equal(cdkInput().value, "synthetic-cdk-second", "session expiry refills the saved CDK");
  assert.equal(remember().checked, true);
  removeBlocked = true;
  await clickRemember();
  assert.equal(remember().checked, true, "failed clear must not pretend the saved key was removed");
  assert.match(container.querySelector('[role="alert"]').textContent, /无法清除/);
  removeBlocked = false;
  await clickRemember();
  assert.equal(storage.getItem(storageKey), null);

  readBlocked = true;
  await mount();
  assert.equal(cdkInput().value, "", "unavailable browser storage does not block rendering");
  assert.equal(remember().checked, false);
  readBlocked = false;
  writeBlocked = true;
  await input("synthetic-storage-failure");
  await clickRemember();
  await submit();
  assert.ok(container.querySelector('[data-action="logout"]'), "cache-write failure must not turn a valid login into a failure");
  assert.match(container.querySelector('[role="status"]').textContent, /浏览器未能记住/);
  writeBlocked = false;
  assert.equal(storage.getItem(storageKey), null);
  assert.ok(hydrated.length >= 3);
  console.log("CDK remember-me UI passed (opt-in, verified-only storage, reload/logout/expiry refill, immediate clear, failed login, disabled controls and unavailable storage; synthetic fixtures only)");
} finally {
  await act(async () => root.unmount());
  storagePrototype.getItem = originalGet;
  storagePrototype.setItem = originalSet;
  storagePrototype.removeItem = originalRemove;
  dom.window.close();
  globalThis.window = previous.window; globalThis.document = previous.document; globalThis.HTMLElement = previous.HTMLElement;
  globalThis.fetch = previous.fetch; globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
}
