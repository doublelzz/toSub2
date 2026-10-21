import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";

const source = await fs.readFile(new URL("../web/src/main.jsx", import.meta.url), "utf8");
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const code = [
  extract("function formatTokenSummary(", "async function saveDownloadResponse("),
  extract("function normalizeSub2ApiSettings(", "function readSub2ApiSettings("),
  extract("function SubscriptionInfo(", "function SmsSummary("),
].join("\n");
const transformed = await transformWithEsbuild(code, "sub2api-ui.jsx", { loader: "jsx", jsx: "transform" });
const { ExportReport, SubscriptionInfo, normalizeSub2ApiSettings, downloadSummary } = new Function("React", "X", "InsightError", "formatInsightDate",
  `${transformed.code};return { ExportReport, SubscriptionInfo, normalizeSub2ApiSettings, downloadSummary };`)(React,
  () => React.createElement("span", { "aria-hidden": true }, "close"),
  ({ item }) => React.createElement("span", null, item?.error || "unknown"), (value) => value);
assert.equal(normalizeSub2ApiSettings({}).codexFingerprintMode, "off");
for (const mode of ["off", "device", "session", "full"]) assert.equal(normalizeSub2ApiSettings({ codexFingerprintMode: mode }).codexFingerprintMode, mode);
assert.match(downloadSummary(new Response("", { headers: { "x-export-summary": JSON.stringify({ exported: 2, failed: 1, skipped: 0 }) } })), /已导出 2 条，失败 1 条/);
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root");
const root = createRoot(container);
let closed = 0;
try {
  await act(() => root.render(React.createElement(ExportReport, { onClose: () => closed++, report: {
    failed: 1, unknown: 0, tokens: { valid: 1, expiredWithRefresh: 2, expiredWithoutRefresh: 1, unknown: 3 },
    rows: [{ id: "bad", email: "bad@example.com", status: "failed", message: "账号 ID 不一致" }, { id: "good", status: "ready" }],
    result: { results: [{ jobId: "good", email: "<script>bad()</script>@example.com", success: false, message: "目标分组拒绝创建" }] },
  } })));
  assert.match(container.textContent, /已过期 2 条（含刷新凭据，未验证）/);
  assert.match(container.textContent, /期限未知 3 条/);
  assert.match(container.textContent, /目标分组/);
  assert.equal(container.querySelector("details").open, true);
  assert.equal(container.querySelectorAll("li").length, 2);
  assert.equal(container.querySelector("script"), null, "error and identity text must render as text");
  await act(() => container.querySelector("button").click());
  assert.equal(closed, 1);
  for (const planType of ["plus", "pro", "go"]) {
    await act(() => root.render(React.createElement(SubscriptionInfo, { insights: { subscription: { status: "ok", planType, expiresAt: "2099-01-01T00:00:00Z" } } })));
    assert.equal(container.querySelector("time").dateTime, "2099-01-01T00:00:00Z");
    assert.match(container.textContent, new RegExp(planType));
  }
  await act(() => root.render(React.createElement(SubscriptionInfo, { insights: { subscription: { status: "ok", planType: "go", expiresAt: null } } })));
  assert.match(container.textContent, /到期时间未知/);
  assert.equal(container.querySelector("time"), null);
  console.log("sub2api UI passed (defaults, token summary, partial failures, escaped content, subscription plans)");
} finally {
  await act(() => root.unmount());
  dom.window.close();
}
