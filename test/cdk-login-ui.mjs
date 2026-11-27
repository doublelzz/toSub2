import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useEffect, useRef, useState } from "react";
import { KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
const previous = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root"); const root = createRoot(container);
const hydrated = []; const calls = []; let state = { authenticated: false }; let failCode = false; let failLogin = false; let generation = 0;
const auth = { authenticated: true, token: "synthetic-session-csrf", account: { id: "a", role: "user" }, workspace: { id: "a", balance: 10 }, features: {}, settings: {} };
globalThis.fetch = async (url, options = {}) => {
  const body = JSON.parse(options.body || "{}"); calls.push({ url, body, headers: options.headers });
  if (url === "/api/bootstrap") return Response.json(state);
  if (url === "/api/auth/login") {
    assert.deepEqual(Object.keys(body), ["cdk"]);
    if (failLogin) return Response.json({ error: "CDK 验证失败" }, { status: 401 });
    state = { authenticated: false, authState: body.cdk === "bound-cdk" ? "verify_email" : "bind_email", token: "synthetic-challenge-csrf", email: body.cdk === "bound-cdk" ? "ad***@example.com" : null, codeSent: false, retryAt: 0, expiresAt: Date.now() + 600000 };
    return Response.json(state);
  }
  if (url === "/api/auth/email/send") { assert.equal(options.headers["x-console-token"], state.token); state = { ...state, email: state.email || "us***@example.com", codeSent: true, codeExpiresAt: Date.now() + 300000, retryAt: Date.now() + 60000 }; return Response.json(state); }
  if (url === "/api/auth/email/verify") {
    if (failCode) return Response.json({ error: "验证码不正确，请重新输入", code: "OTP_INVALID" }, { status: 400 });
    assert.equal(body.code, "123456"); state = auth; return Response.json(state);
  }
  if (url === "/api/auth/logout" || url === "/api/auth/cancel") { state = { authenticated: false }; return Response.json(state); }
  throw new Error(`Unexpected request ${url}`);
};
const source = (await fs.readFile(new URL("../web/src/CdkGate.jsx", import.meta.url), "utf8")).replace(/^import[\s\S]*?;\r?\n/gm, "").replace("export default function", "function");
const compiled = await transformWithEsbuild(source, "CdkGate.jsx", { loader: "jsx", jsx: "transform" });
const bindings = { React, useEffect, useRef, useState, KeyRound, LoaderCircle, ShieldCheck, ThemeControl: () => null, ImportChargeDialog: () => null,
  clearWorkspaceSettings() {}, flushWorkspaceSettings: async () => {}, hydrateWorkspaceSettings: (value) => hydrated.push(value), refreshWorkspaceSmsPermissions() {}, setImportConfirmation() {} };
const CdkGate = new Function(...Object.keys(bindings), `${compiled.code}; return CdkGate;`)(...Object.values(bindings));
const input = async (selector, value) => act(async () => { const el = container.querySelector(selector); assert.ok(el, selector); Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, value); el.dispatchEvent(new window.Event("input", { bubbles: true })); });
const submit = () => act(async () => container.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
const click = (text) => act(async () => { const button = [...container.querySelectorAll("button")].find((b) => b.textContent.includes(text)); assert.ok(button, text); button.click(); });
const mount = () => act(async () => root.render(React.createElement(CdkGate, { key: ++generation }, (session) => React.createElement("button", { onClick: session.logout }, "退出登录"))));
try {
  window.localStorage.setItem("tosub2.remembered-cdk-v1", "old-plaintext-secret"); window.localStorage.setItem("theme", "dark");
  await mount(); assert.equal(window.localStorage.getItem("tosub2.remembered-cdk-v1"), null); assert.equal(window.localStorage.getItem("theme"), "dark");
  assert.equal(container.querySelector('input[type="password"]').value, ""); assert.equal(container.querySelector('input[type="checkbox"]'), null);
  failLogin = true; await input('input[type="password"]', "invalid"); await submit(); assert.ok(container.querySelector('[role="alert"]')); failLogin = false;
  await input('input[type="password"]', " unbound-cdk "); await submit(); assert.ok(container.textContent.includes("绑定邮箱")); assert.equal(hydrated.length, 0, "partial authentication never mounts workspace");
  assert.equal(container.querySelector('input[type="password"]'), null); assert.equal(window.localStorage.getItem("tosub2.remembered-cdk-v1"), null);
  await input('input[type="email"]', "user@example.com"); await submit(); assert.ok(container.querySelector('input[autocomplete="one-time-code"]'));
  assert.ok(container.querySelector('input[type="email"]').disabled); assert.ok([...container.querySelectorAll("button")].find((b) => b.textContent.includes("秒后可重发")).disabled);
  await mount(); assert.ok(container.querySelector('input[autocomplete="one-time-code"]'), "reload resumes challenge");
  await input('input[autocomplete="one-time-code"]', "12x3456"); assert.equal(container.querySelector('input[autocomplete="one-time-code"]').value, "123456");
  failCode = true; await submit(); assert.ok(container.textContent.includes("验证码不正确")); assert.equal(hydrated.length, 0); failCode = false;
  await submit(); assert.equal(hydrated.length, 1); assert.ok(container.textContent.includes("退出登录"));
  await click("退出登录"); assert.equal(container.querySelector('input[type="password"]').value, "");
  await input('input[type="password"]', "bound-cdk"); await submit(); assert.ok(container.textContent.includes("验证登录设备")); assert.ok(container.textContent.includes("ad***@example.com")); assert.equal(container.querySelector('input[type="email"]'), null);
  await click("返回 CDK 登录"); assert.ok(container.querySelector('input[type="password"]'));
  assert.equal(calls.filter((c) => c.url === "/api/auth/email/send").length, 1, "renders and reloads never send unsolicited email");
  console.log("CDK login UI passed (legacy secret removal, email binding/device steps, reload, cooldown, OTP paste/error, workspace gate and logout; synthetic fixtures)");
} finally { await act(async () => root.unmount()); dom.window.close(); Object.assign(globalThis, { window: previous.window, document: previous.document, HTMLElement: previous.HTMLElement, fetch: previous.fetch, IS_REACT_ACT_ENVIRONMENT: previous.act }); }
