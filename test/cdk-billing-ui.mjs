import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useEffect, useId, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as icons from "lucide-react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

async function load(file, names, bindings = {}) {
  const source = await fs.readFile(new URL(file, import.meta.url), "utf8");
  const code = source.replace(/^import[^\n]+\n/gm, "").replace("export default function", "function");
  const compiled = await transformWithEsbuild(code, file, { loader: "jsx", jsx: "transform" });
  const usedIcons = Object.fromEntries([...code.matchAll(/<([A-Z]\w*)/g)].map((match) => match[1]).filter((name) => icons[name]).map((name) => [name, icons[name]]));
  const scope = { React, useEffect, useId, useRef, useState, ...usedIcons, ...bindings };
  return new Function(...Object.keys(scope), `${compiled.code};return {${names.join(",")}};`)(...Object.values(scope));
}

const workspace = { id: "user-workspace", label: "TS2-fixture", role: "user", status: "active", balance: 12, reserved: 5, consumed: 9, importConsumed: 3, smsPoolConsumed: 6, accounts: 3 };
const auth = { token: "fixture", account: { id: "admin-actor", role: "admin" }, workspace, reload: async () => {} };
const { CurrentCdk } = await load("../web/src/CurrentCdk.jsx", ["CurrentCdk"], { cdkFetch: async () => { throw Error("Header rendering must not reveal a CDK"); } });
let markup = renderToStaticMarkup(React.createElement(CurrentCdk, { auth, onOpen() {} }));
assert.match(markup, /可用 12 次/);
assert.match(markup, /处理中预留 5 次/);
assert.doesNotMatch(markup, /管理员不限次数|可用 7 次/);
markup = renderToStaticMarkup(React.createElement(CurrentCdk, { auth: { ...auth, workspace: { ...workspace, role: "admin" } }, onOpen() {} }));
assert.match(markup, /管理员不限次数/);
assert.doesNotMatch(markup, /处理中预留/);

let current = workspace;
const { CdkWorkspace, ConsumptionDetails, Ledger } = await load("../web/src/CdkWorkspace.jsx", ["CdkWorkspace", "ConsumptionDetails", "Ledger"], {
  Drawer: ({ children }) => React.createElement("section", null, children), requestId: () => "fixture-request",
  cdkFetch: async (url) => {
    assert.equal(url, "/api/cdk/ledger");
    return Response.json({ cdk: current, items: [{ id: "fee", kind: "sms-pool", delta: -3, balance: 17, note: "fixture", at: "2026-10-25T01:00:00Z" }] });
  },
});
markup = renderToStaticMarkup(React.createElement("dl", null, React.createElement(ConsumptionDetails, { cdk: { role: "user", consumed: 9 } })));
assert.doesNotMatch(markup, /账号导入消耗|接码池消耗|预留/);
markup = renderToStaticMarkup(React.createElement("dl", null, React.createElement(ConsumptionDetails, { cdk: { ...workspace, importConsumed: null, smsPoolConsumed: -1 } })));
assert.doesNotMatch(markup, /账号导入消耗|接码池消耗/);
markup = renderToStaticMarkup(React.createElement(Ledger, { items: [{ id: "fee", kind: "sms-pool", delta: -3, balance: 17, at: "2026-10-25T01:00:00Z" }] }));
assert.match(markup, /接码池成功扣次/);

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root"); const root = createRoot(container);
try {
  await act(async () => root.render(React.createElement(CdkWorkspace, { auth, section: "mine", onNavigate() {} })));
  assert.equal(container.querySelector(".cdk-account-summary strong").textContent, "12", "balance is already net of reserved quota");
  const summary = Object.fromEntries([...container.querySelectorAll(".cdk-account-summary dl div")].map((row) => [row.querySelector("dt").textContent, row.querySelector("dd").textContent]));
  assert.equal(summary["累计消耗"], "9 次");
  assert.equal(summary["账号导入消耗"], "3 次");
  assert.equal(summary["接码池消耗"], "6 次");
  assert.equal(summary["处理中预留"], "5 次");
  assert.doesNotMatch(container.textContent, /累计导入消耗|可用导入次数/);
  assert.match(container.textContent, /接码池成功扣次/);
  current = { ...workspace }; delete current.importConsumed; delete current.smsPoolConsumed;
  await act(async () => root.render(React.createElement(CdkWorkspace, { key: "legacy", auth: { ...auth, workspace: current }, section: "mine", onNavigate() {} })));
  assert.doesNotMatch(container.querySelector(".cdk-account-summary").textContent, /账号导入消耗|接码池消耗/);
  console.log("CDK billing UI passed (workspace ownership, available and reserved quota, consumption breakdown, missing legacy fields and pool ledger labels)");
} finally { await act(() => root.unmount()); dom.window.close(); }
