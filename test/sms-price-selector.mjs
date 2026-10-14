import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";
import { filterSmsCountries, findSmsNumberOption, formatSmsSuccessRate, groupSmsCountries, preferredSmsNumberOption } from "../web/src/sms-number-options.mjs";

const options = [
  { country: "0", title: "俄罗斯", price: 0.12, count: 10, successRate: 90 },
  { country: "7", title: "马来西亚", price: 0.2, count: 4, successRate: 96, providerIds: "gold-2" },
  { country: "7", title: "马来西亚", price: 0.18, count: 8, successRate: 96, providerIds: "gold-1" },
  { country: "16", title: "英国", price: 0.42, count: 12, successRate: 70 },
  { country: "17", title: "荷兰", price: 0.21, count: 9, successRate: 69.9 },
  { country: "18", title: "法国", price: 0.01, count: 3 },
  { country: "19", title: "德国", price: 0.16, count: 5, successRate: 0 },
  { country: "20", title: "加拿大", price: 0.3, count: 15, successRate: 88 },
  { country: "21", title: "西班牙", price: 0.4, count: 20, successRate: 91 },
];
const countries = groupSmsCountries(options);
assert.equal(countries.length, 8, "Prices from the same country must share one country row");
assert.equal(preferredSmsNumberOption(options, "herosms").country, "7", "Quality must take precedence over the cheapest unknown offer");
assert.equal(preferredSmsNumberOption(options, "smsbower").country, "18");
assert.deepEqual(filterSmsCountries(countries, { quality: "high" }).map((item) => item.country), ["7", "21", "0"]);
assert.deepEqual(filterSmsCountries(countries, { quality: "medium" }).map((item) => item.country), ["20", "16"]);
assert.deepEqual(filterSmsCountries(countries, { quality: "low" }).map((item) => item.country), ["17", "19"]);
assert.deepEqual(filterSmsCountries(countries, { quality: "unknown" }).map((item) => item.country), ["18"]);
assert.equal(formatSmsSuccessRate(0), "0%");
assert.equal(formatSmsSuccessRate(null), "暂无数据");
assert.equal(findSmsNumberOption(options, { country: 0, maxPrice: "0.12" }).country, "0");
assert.equal(findSmsNumberOption(options, { country: "7", maxPrice: "0.2", providerIds: "gold-2" }).providerIds, "gold-2");

// Render the actual JSX so pagination and selection are tested through user events.
const componentUrl = new URL("../web/src/SmsPriceSelector.jsx", import.meta.url);
const source = await fs.readFile(componentUrl, "utf8");
const transformed = await transformWithEsbuild(source, "SmsPriceSelector.jsx", { loader: "jsx", jsx: "automatic" });
const code = transformed.code.replace(/from\s+["']([^"']+)["']/g, (_match, specifier) => {
  const url = specifier.startsWith(".") ? new URL(specifier, componentUrl).href : import.meta.resolve(specifier);
  return `from ${JSON.stringify(url)}`;
});
const { default: SmsPriceSelector } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root");
const root = createRoot(container);
const selections = [];
let refreshes = 0;

function Harness({ id = "herosms", loading = false, offers = options, apiKey = "test-key" }) {
  const [config, setConfig] = useState({ apiKey, country: "7", maxPrice: "0.2", providerIds: "gold-2" });
  return React.createElement(SmsPriceSelector, {
    provider: { id, name: id === "herosms" ? "Hero SMS" : "SMSBower", config },
    options: offers, loading,
    onRefresh: () => refreshes++,
    onSelect: (option) => {
      selections.push(option);
      setConfig((current) => ({ ...current, country: option.country, maxPrice: String(option.price), providerIds: option.providerIds || "" }));
    },
  });
}
const rows = () => [...container.querySelectorAll(".sms-country-row")];
const button = (label) => container.querySelector(`button[aria-label="${label}"]`);
const quality = () => container.querySelector(".sms-quality-filter select");
const tier = () => container.querySelector(".sms-tier-select select");
const click = (element) => act(() => element.click());
const change = (element, value) => act(() => {
  element.value = value;
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
});
const search = (value) => act(() => {
  const input = container.querySelector('input[type="search"]');
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
});

try {
  await act(() => root.render(React.createElement(Harness)));
  assert.equal(rows().length, 5);
  assert.match(rows()[0].textContent, /马来西亚.*96%/);
  assert.equal(tier().options.length, 2, "Only the selected country's tiers should be shown");
  assert.equal(tier().value, "7|0.2|gold-2");
  click(rows()[0]);
  assert.equal(selections.at(-1).providerIds, "gold-2", "Clicking the selected country must preserve its selected tier");
  change(tier(), "7|0.18|gold-1");
  assert.equal(selections.at(-1).providerIds, "gold-1", "Tier selection must carry its Gold supplier routing");
  click(button("下一页国家"));
  assert.equal(rows().length, 3);
  assert.match(rows().at(-1).textContent, /法国.*暂无数据/);
  assert.equal(tier().options.length, 2, "The selected country must remain visible below other pages");
  search("英国");
  assert.equal(rows().length, 1, "Search must reset pagination before showing matching countries");
  assert.match(rows()[0].textContent, /英国/);
  search("");
  change(quality(), "high");
  assert.equal(rows().length, 3);
  change(quality(), "unknown");
  assert.equal(rows().length, 1);
  assert.match(rows()[0].textContent, /法国/);
  click(rows()[0]);
  assert.equal(tier().options.length, 1);
  assert.equal(selections.at(-1).country, "18");
  search("no matching country");
  assert.equal(rows().length, 0);
  assert.match(container.textContent, /没有符合条件的国家/);
  search("");
  click(container.querySelector(".price-refresh-button"));
  assert.equal(refreshes, 1);

  await act(() => root.render(React.createElement(Harness, { key: "gold", id: "smsbower" })));
  assert.equal(quality(), null, "SMSBower must retain its Gold category instead of a fabricated success rate");
  assert.match(container.textContent, /Gold 供应商/);
  assert.match(rows()[0].textContent, /法国/);
  await act(() => root.render(React.createElement(Harness, { key: "loading", loading: true })));
  assert.equal(container.querySelector('section').getAttribute("aria-busy"), "true");
  assert.ok([...container.querySelectorAll("button,input,select")].every((element) => element.disabled));
  await act(() => root.render(React.createElement(Harness, { key: "empty", offers: [], apiKey: "" })));
  assert.match(container.textContent, /填写 API Key 后查询价格/);
  assert.equal(container.querySelector(".price-refresh-button").disabled, true);
} finally {
  await act(() => root.unmount());
  dom.window.close();
}
console.log("SMS selector: country grouping, quality boundaries, pagination, search and supplier selection passed");
