import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as icons from "lucide-react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";
import { DEFAULT_FILTERS, matchesDate } from "../web/src/task-filters.mjs";

const source = await fs.readFile(new URL("../web/src/MfaWorkspace.jsx", import.meta.url), "utf8");
const code = source.replace(/^import[^\n]+\n/gm, "").replace("export default function", "function");
const compiled = await transformWithEsbuild(code, "MfaWorkspace.jsx", { loader: "jsx", jsx: "transform" });
const usedIcons = Object.fromEntries([...code.matchAll(/<([A-Z]\w*)/g)].map((match) => match[1]).filter((name) => icons[name]).map((name) => [name, icons[name]]));
const rows = Array.from({ length: 25 }, (_, index) => ({ id: `row-${index}`, email: `row-${index}@example.com`, status: "ready", stage: "ready", hasPassword: true }));
let accounts = [...rows];
const calls = [];
const newRow = { ...rows[0], id: "newest", email: "newest@example.com" };
const bindings = { React, useCallback, useEffect, useMemo, useRef, useState, ...usedIcons, DEFAULT_FILTERS, matchesDate,
  useDialogFocus: () => {}, useCalendarDay: () => "2026-10-23", TaskOverview: () => null, TaskFilters: () => null,
  Drawer: ({ children }) => React.createElement("section", null, children),
  MoreActions: ({ children }) => React.createElement("details", null, React.createElement("summary", null, "more"), children),
  cdkFetch: async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url.endsWith("/accounts")) return Response.json({ accounts, running: false, concurrency: 3 });
    if (url.endsWith("/sync-authorization")) {
      const ids = JSON.parse(options.body).ids;
      return Response.json({ synced: 1, failed: ids.length - 1, results: ids.map((id, index) => ({ id, email: rows.find((row) => row.id === id).email, success: index === 0, message: index === 0 ? "已安排额度检测" : "已有授权已过期，请重新登录" })) });
    }
    if (url.endsWith("/preview")) return Response.json({ count: 1, accounts: [newRow] });
    if (url.endsWith("/import")) { accounts = [newRow, ...accounts]; return Response.json({ imported: 1 }); }
    throw new Error(`Unexpected synthetic request: ${url}`);
  },
};
const MfaWorkspace = new Function(...Object.keys(bindings), `${compiled.code};return MfaWorkspace;`)(...Object.values(bindings));
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root");
const root = createRoot(container);
let opened = 0;
const button = (label) => [...container.querySelectorAll("button")].find((item) => item.textContent.includes(label));
try {
  await act(async () => root.render(React.createElement(MfaWorkspace, { token: "fixture-token", onOpenAuthorization: () => opened++ })));
  assert.match(container.textContent, /最近导入在前/);
  await act(() => container.querySelector('[aria-label="选择 MFA 账号 row-0@example.com"]').click());
  await act(() => container.querySelector('[title="MFA 下一页"]').click());
  await act(() => container.querySelector('[aria-label="选择 MFA 账号 row-20@example.com"]').click());
  assert.match(button("同步到账号授权").textContent, /（2）/);
  await act(() => button("同步到账号授权").click());
  assert.deepEqual(calls.find((call) => call.url.endsWith("/sync-authorization")).body.ids, ["row-0", "row-20"]);
  assert.match(container.textContent, /成功 1 条，失败 1 条/);
  assert.match(container.textContent, /已有授权已过期/);
  await act(() => button("查看账号授权 · 未接码").click());
  assert.equal(opened, 1);
  await act(() => button("导入账号").click());
  const textarea = container.querySelector("textarea");
  await act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(textarea, "newest@example.com----fixture-password");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(() => container.querySelector('form[role="dialog"]').dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  await act(() => button("确认导入").click());
  assert.equal(container.querySelector(".mfa-email").textContent, "newest@example.com", "import resets pagination so new accounts are visible first");
  assert.equal(container.querySelectorAll('input[aria-label^="选择 MFA 账号"]:checked').length, 0);
  assert.ok(calls.every((call) => !/start|logout|jobs\/batch/.test(call.url)), "sync and import UI must not start MFA/login/phone workflows");
  console.log("MFA sync UI passed (cross-page selection, partial errors, destination navigation and newest import visibility)");
} finally { await act(() => root.unmount()); dom.window.close(); }
