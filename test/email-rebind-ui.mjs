import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as icons from "lucide-react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const source = await fs.readFile(new URL("../web/src/EmailRebindWorkspace.jsx", import.meta.url), "utf8");
const code = source.replace(/^import[^\n]+\n/gm, "").replace("export default function", "function").replace(/export function/g, "function");
const compiled = await transformWithEsbuild(code, "EmailRebindWorkspace.jsx", { loader: "jsx", jsx: "transform" });
const usedIcons = Object.fromEntries([...code.matchAll(/<([A-Z]\w*)/g)].map((match) => match[1]).filter((name) => icons[name]).map((name) => [name, icons[name]]));
const bindings = { React, useCallback, useEffect, useMemo, useRef, useState, ...usedIcons, useDialogFocus: () => {},
  Drawer: ({ children }) => React.createElement("section", null, children), cdkFetch: () => { throw new Error("Unexpected external request"); } };
const { MappingDialog, CodeForm } = new Function(...Object.keys(bindings), `${compiled.code};return {MappingDialog,CodeForm};`)(...Object.values(bindings));
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root"); const root = createRoot(container);
const selected = [{ id: "first", email: "first@example.com" }, { id: "second", email: "second@example.com" }];
const started = []; const requests = [];
const request = async (route, options) => {
  const body = JSON.parse(options.body); requests.push({ route, body });
  return { digest: "confirmed-mapping", rows: [{ oldEmail: selected[0].email, newEmail: "new-first@example.com", mode: "auto" }, { oldEmail: selected[1].email, newEmail: "new-second@example.com", mode: "manual" }] };
};
async function fill(element, value) {
  const prototype = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  await act(() => { Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value); element.dispatchEvent(new window.Event("input", { bubbles: true })); });
}
const button = (label) => [...container.querySelectorAll("button")].find((element) => element.textContent.includes(label));
try {
  await act(() => root.render(React.createElement(MappingDialog, { sources: selected, concurrency: 1, timeout: 180, request, onClose: () => {}, onStart: (body) => started.push(body) })));
  assert.equal(button("核对映射").disabled, true);
  await fill(container.querySelector("textarea"), "new-first@example.com");
  assert.equal(button("核对映射").disabled, true);
  await fill(container.querySelector("textarea"), "new-first@example.com----https://mail.example.com/private-key\nnew-second@example.com");
  await act(async () => { button("核对映射").click(); });
  assert.match(container.textContent, /自动 1 条，手动 1 条/);
  assert.deepEqual(requests[0].body.ids, ["first", "second"]);
  assert.equal(container.querySelectorAll(".rebind-map-review li")[0].textContent.includes("new-first@example.com"), true);
  assert.equal(button("确认并开始换绑").disabled, false);
  await fill(container.querySelector('[aria-label="换绑并发数"]'), "31");
  assert.equal(button("确认并开始换绑").disabled, true);
  await fill(container.querySelector('[aria-label="换绑并发数"]'), "2");
  await act(async () => { button("确认并开始换绑").click(); });
  assert.equal(started.length, 1);
  assert.equal(started[0].digest, "confirmed-mapping");
  assert.equal(started[0].concurrency, 2);
  await fill(container.querySelector("textarea"), "another@example.com\nsecond-new@example.com");
  assert.equal(button("确认并开始换绑").disabled, true, "editing targets invalidates the reviewed mapping");
  const codes = [];
  await act(() => root.render(React.createElement(CodeForm, { item: { id: "task", newEmail: "new@example.com", challengeVersion: 1 }, onSubmit: (value) => codes.push(value) })));
  await fill(container.querySelector("input"), "001234");
  await act(() => container.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  assert.deepEqual(codes, ["001234"], "leading zeroes must not be lost");
  await act(() => root.render(React.createElement(CodeForm, { item: { id: "task", newEmail: "new@example.com", challengeVersion: 2 }, onSubmit: (value) => codes.push(value) })));
  assert.equal(container.querySelector("input").value, "", "resending invalidates the previous input");

  // Exercise the actual charged-import client path and its explicit confirmation.
  const originalFetch = globalThis.fetch; const originalEvent = globalThis.Event;
  globalThis.Event = window.Event;
  try {
    const { cdkFetch, setImportConfirmation } = await import("../web/src/cdk-api.mjs");
    const importCalls = [];
    globalThis.fetch = async (route, options) => { importCalls.push({ route, options }); return Response.json(route === "/api/imports/preview"
      ? { count: 1, added: 1, updated: 0, charge: 1, balance: 3, after: 2, canImport: true } : { created: 1 }); };
    setImportConfirmation(async (quote) => { assert.equal(quote.charge, 1); return false; });
    await assert.rejects(cdkFetch("/api/rebind/sync", { method: "POST", body: JSON.stringify({ ids: ["confirmed-task"] }) }), /已取消/);
    assert.equal(importCalls.length, 1, "cancelled confirmation cannot import or charge");
    assert.equal(JSON.parse(importCalls[0].options.body).mode, "rebind");
    setImportConfirmation(async () => true);
    await cdkFetch("/api/rebind/sync", { method: "POST", body: JSON.stringify({ ids: ["confirmed-task"] }) });
    assert.equal(importCalls.at(-1).route, "/api/rebind/sync");
    assert.ok(importCalls.at(-1).options.headers.get("idempotency-key"));
    setImportConfirmation(null);
  } finally { globalThis.fetch = originalFetch; globalThis.Event = originalEvent; }
  console.log("email rebind UI passed (exact cardinality, immutable mapping, mixed input, OTP generation and charged import confirmation)");
} finally { await act(() => root.unmount()); dom.window.close(); }
