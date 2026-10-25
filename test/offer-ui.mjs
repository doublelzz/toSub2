import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useCallback, useEffect, useRef, useState } from "react";
import * as icons from "lucide-react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const source = await fs.readFile(new URL("../web/src/OfferWorkspace.jsx", import.meta.url), "utf8");
const code = source.replace(/^import[^\n]+\n/gm, "").replace("export default function", "function").replace(/^export /gm, "");
const compiled = await transformWithEsbuild(code, "OfferWorkspace.jsx", { loader: "jsx", jsx: "transform" });
const usedIcons = Object.fromEntries([...code.matchAll(/<([A-Z]\w*)/g)].map((match) => match[1]).filter((name) => icons[name]).map((name) => [name, icons[name]]));
const allRows = Array.from({ length: 25 }, (_, index) => ({ id: `row-${index}`, email: `fixture-${index}@example.com`, status: "completed", hasPassword: true,
  result: { kind: "half_2m", label: "Plus 半价 2 个月", checkedAt: "2026-10-24T02:00:00Z" }, history: [] }));
const batch = (id) => ({ id, name: id, status: "completed", total: 25, processed: 25, counts: { completed: 25 }, categories: { half_2m: 25 }, offers: 25, hitRate: 1 });
const calls = []; let access = true;
const cdkFetch = async (url, options = {}) => {
  calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
  if (!access) return Response.json({ error: "余额至少为 1", code: "OFFER_BALANCE_REQUIRED" }, { status: 403 });
  if (url.endsWith("/batches")) return Response.json({ batches: [batch("recent"), batch("older")] });
  if (url.endsWith("/query")) {
    const body = JSON.parse(options.body); const page = body.page || 1;
    return Response.json({ batch: batch(url.split("/").at(-2)), total: 25, page, pages: 2, items: allRows.slice((page - 1) * 20, page * 20), selection: allRows.map((row) => row.id) });
  }
  if (url.endsWith("/export")) { const body = JSON.parse(options.body); return Response.json({ content: "fixture export", count: body.ids?.length || 25, filename: "fixture.txt" }); }
  if (url.endsWith("/access")) return Response.json({ allowed: true });
  throw Error(`Unexpected UI request: ${url}`);
};
const bindings = { React, useCallback, useEffect, useRef, useState, ...usedIcons, useDialogFocus: () => {},
  Drawer: ({ children }) => React.createElement("section", null, children), cdkFetch, readWorkspaceValue: () => "" };
const { OfferWorkspace, OfferImportDialog, OfferExportDialog, OfferInput } = new Function(...Object.keys(bindings), `${compiled.code};return {OfferWorkspace,OfferImportDialog,OfferExportDialog,OfferInput};`)(...Object.values(bindings));
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const copied = []; const downloads = []; let downloadCount = 0;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "fixture", clipboard: { writeText: async (value) => copied.push(value) } } });
const originalCreate = URL.createObjectURL; const originalRevoke = URL.revokeObjectURL;
URL.createObjectURL = (value) => { downloads.push(value); return "blob:fixture"; }; URL.revokeObjectURL = () => {};
window.HTMLAnchorElement.prototype.click = () => { downloadCount++; };
const { createRoot } = await import("react-dom/client"); const container = document.getElementById("root"); const root = createRoot(container);
const button = (label) => [...container.querySelectorAll("button")].find((element) => element.textContent.trim() === label);
const click = (label) => act(async () => { button(label).click(); });
async function fill(element, value) { await act(async () => { Object.getOwnPropertyDescriptor(element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : element.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype, "value").set.call(element, value); element.dispatchEvent(new window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true })); }); }
try {
  let verified = 0;
  const exportData = { count: 2, content: "first@example.com----password\nsecond@example.com", filename: "fixture.txt" };
  await act(() => root.render(React.createElement(OfferExportDialog, { data: exportData, onClose() {}, verifyAccess: async () => { verified++; if (!access) throw Error("余额不足"); } })));
  assert.equal(downloadCount, 0, "opening export must only preview, never download"); assert.equal(copied.length, 0);
  await click("复制内容"); assert.deepEqual(copied, [exportData.content]); assert.equal(verified, 1);
  await click("下载 TXT"); assert.equal(downloadCount, 1); assert.equal(await downloads[0].text(), exportData.content);
  access = false; await click("复制内容"); assert.equal(copied.length, 1, "copy revalidates eligibility"); access = true;
  const starts = []; const importRequests = [];
  await act(() => root.render(React.createElement(OfferImportDialog, { onClose() {}, onStarted: (value) => starts.push(value), request: async (route, options) => {
    importRequests.push({ route, body: JSON.parse(options.body) });
    return route === "preview" ? { count: 1, duplicateCount: 1, digest: "reviewed", accounts: [{ email: "first@example.com", hasPassword: true }] } : { id: "new-batch" };
  } })));
  await fill(container.querySelector("textarea"), "first@example.com----password\nfirst@example.com----password");
  await click("预览账号"); assert.match(container.textContent, /同批重复 1 条/);
  await fill(container.querySelector('input[max="20"]'), "21"); assert.equal(button("开始检测（1）").disabled, true);
  await fill(container.querySelector('input[max="20"]'), "2"); await click("开始检测（1）"); assert.equal(starts[0].id, "new-batch");
  assert.equal(importRequests[1].body.digest, "reviewed"); assert.equal(importRequests[1].body.concurrency, 2);
  await fill(container.querySelector("textarea"), "changed@example.com"); assert.equal(button("开始检测").disabled, true, "editing input invalidates preview");
  const inputs = [];
  await act(() => root.render(React.createElement(OfferInput, { row: { email: "first@example.com", promptKind: "email" }, onSubmit: (value) => inputs.push(value) })));
  await fill(container.querySelector("input"), "001234"); await click("继续"); assert.deepEqual(inputs, ["001234"]);
  await act(async () => root.render(React.createElement(OfferWorkspace, { token: "fixture", balance: 1 })));
  assert.equal(container.querySelectorAll("tbody tr").length, 20);
  await act(async () => container.querySelector('[aria-label="选择检测账号 fixture-0@example.com"]').click());
  await act(async () => container.querySelector('[aria-label="优惠下一页"]').click());
  await act(async () => container.querySelector('[aria-label="选择检测账号 fixture-20@example.com"]').click());
  assert.match(container.textContent, /已选 2 个/);
  const beforeExport = downloadCount;
  await click("导出所选"); assert.equal(downloadCount, beforeExport);
  assert.deepEqual(calls.findLast((value) => value.url.endsWith("/export")).body.ids, ["row-0", "row-20"]);
  await act(async () => container.querySelector('[aria-label="关闭优惠导出"]').click());
  await click("导出筛选结果"); assert.equal(container.querySelector('[aria-label="优惠导出预览内容"]').value, "fixture export");
  assert.equal(calls.findLast((value) => value.url.endsWith("/export")).body.ids, undefined);
  await act(async () => container.querySelector('[aria-label="关闭优惠导出"]').click());
  await fill(container.querySelector('[aria-label="选择检测批次"]'), "older"); assert.match(container.textContent, /已选 0 个/);
  access = false; await click("刷新"); assert.match(container.textContent, /可用余额至少为 1/); assert.equal(container.querySelector("table"), null);
  console.log("offer UI passed (import preview, settings, OTP leading zeroes, cross-page selection, batch reset, balance gate and copy/TXT preview)");
} finally {
  await act(() => root.unmount()); dom.window.close(); URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else delete globalThis.navigator;
}
