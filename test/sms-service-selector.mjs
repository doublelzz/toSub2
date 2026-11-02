import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const componentUrl = new URL("../web/src/SmsServiceSelector.jsx", import.meta.url);
const source = await fs.readFile(componentUrl, "utf8");
const transformed = await transformWithEsbuild(source, "SmsServiceSelector.jsx", { loader: "jsx", jsx: "automatic" });
const code = transformed.code.replace(/from\s+["']([^"']+)["']/g, (_match, specifier) => {
  const url = specifier.startsWith(".") ? new URL(specifier, componentUrl).href : import.meta.resolve(specifier);
  return `from ${JSON.stringify(url)}`;
});
const { default: SmsServiceSelector } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root");
const root = createRoot(container);
const options = Array.from({ length: 7 }, (_, index) => ({
  serviceId: String(index + 1), title: index === 0 ? "Chat GPT" : `Service ${index + 1}`,
  country: index === 0 ? "kh" : `c${index + 1}`, project: index === 0 ? "chatgpt" : `project-${index + 1}`, uses: index + 1,
}));
const selected = [];
let refreshes = 0;

function Harness({ loading = false, apiKey = "fixture-key", rows = options }) {
  const [config, setConfig] = useState({ apiKey, serviceId: "1", country: "kh", project: "chatgpt" });
  return React.createElement(SmsServiceSelector, {
    provider: { id: "daxigua", name: "大西瓜接码", config }, options: rows, loading,
    onRefresh: () => refreshes++,
    onSelect: (option) => { selected.push(option); setConfig((current) => ({ ...current, serviceId: option.serviceId, country: option.country, project: option.project })); },
  });
}
const rows = () => [...container.querySelectorAll(".sms-country-row")];
const click = (element) => act(() => element.click());
const search = (value) => act(() => {
  const input = container.querySelector('input[type="search"]');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
});

try {
  await act(() => root.render(React.createElement(Harness)));
  assert.equal(rows().length, 5);
  assert.match(rows()[0].textContent, /Chat GPT.*kh \/ chatgpt.*1 次/);
  assert.equal(rows()[0].getAttribute("aria-pressed"), "true");
  click(container.querySelector('button[aria-label="下一页服务"]'));
  assert.equal(rows().length, 2);
  search("chatgpt");
  assert.equal(rows().length, 1, "search resets pagination and matches project code");
  click(rows()[0]);
  assert.equal(selected.at(-1).serviceId, "1");
  search("service 3");
  click(rows()[0]);
  assert.equal(selected.at(-1).serviceId, "3");
  click(container.querySelector(".price-refresh-button"));
  assert.equal(refreshes, 1);
  await act(() => root.render(React.createElement(Harness, { key: "loading", loading: true })));
  assert.equal(container.querySelector("section").getAttribute("aria-busy"), "true");
  assert.ok([...container.querySelectorAll("button,input")].every((element) => element.disabled));
  await act(() => root.render(React.createElement(Harness, { key: "empty", rows: [], apiKey: "" })));
  assert.match(container.textContent, /填写 API Key 后查询服务/);
  assert.equal(container.querySelector(".price-refresh-button").disabled, true);
  console.log("SMS service selector passed (service metadata, pagination, search, selection, loading and empty states)");
} finally {
  await act(() => root.unmount());
  dom.window.close();
}
