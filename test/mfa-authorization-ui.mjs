import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useState, useEffect } from "react";
import { JSDOM } from "jsdom";
import * as icons from "lucide-react";
import { transformWithEsbuild } from "vite";

const source = await fs.readFile(new URL("../web/src/main.jsx", import.meta.url), "utf8");
const rowSource = source.slice(source.indexOf("function JobRow("), source.indexOf("function JobLogs("));
const compiled = await transformWithEsbuild(rowSource, "JobRow.jsx", { loader: "jsx", jsx: "transform" });
const calls = [];
let response = () => Promise.resolve({ accountId: "fixture-mfa-task" });
const noop = () => null;
const usedIcons = Object.fromEntries([...rowSource.matchAll(/<([A-Z]\w*)/g)].map((match) => match[1]).filter((name) => icons[name]).map((name) => [name, icons[name]]));
const bindings = { React, useState, useEffect, ...usedIcons, getInputConfig: noop, QuotaInfo: noop, SubscriptionInfo: noop,
  SmsSummary: noop, LoginMethodBadge: noop, JobLogs: noop, StatusBadge: noop,
  MoreActions: ({ children }) => React.createElement("details", null, React.createElement("summary", null, "more"), children),
  formatInsightDate: String, formatDateTime: String, shortId: String, operationLabel: String,
  apiFetch: async (token, endpoint, options) => { calls.push({ token, endpoint, options }); return response(); },
};
const JobRow = new Function(...Object.keys(bindings), `${compiled.code}; return JobRow;`)(...Object.values(bindings));
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root");
const root = createRoot(container);
const started = [];
const errors = [];
const baseJob = { id: "fixture-job", email: "fixture-ui@example.com", status: "completed", canChangeMfa: true };
const props = { job: baseJob, token: "fixture-console-token", mfaChangeAvailable: true,
  onMfaStarted: (id) => started.push(id), onError: (error) => errors.push(error), accountProxyUrl: "" };
const render = (extra = {}) => act(() => root.render(React.createElement("table", null, React.createElement("tbody", null, React.createElement(JobRow, { ...props, ...extra })))));
try {
  await render();
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "修改 MFA");
  assert.ok(button);
  assert.equal(button.closest("details"), null, "MFA action must be directly visible on the authorization row");
  let complete;
  response = () => new Promise((resolve) => { complete = resolve; });
  await act(() => button.click());
  assert.equal(button.disabled, true);
  assert.equal(calls[0].endpoint, "/api/jobs/fixture-job/change-mfa");
  assert.equal(calls[0].options.body, "{}");
  await act(async () => complete({ accountId: "fixture-mfa-task" }));
  assert.deepEqual(started, ["fixture-mfa-task"]);
  response = async () => { throw new Error("已有账号授权已过期，请重新登录后重试"); };
  await act(() => button.click());
  assert.match(errors.at(-1), /授权已过期/);
  assert.equal(started.length, 1, "expired authorization must not navigate as if a task started");
  await render({ job: { ...baseJob, canChangeMfa: false, mfaBusy: true } });
  const busy = [...container.querySelectorAll("button")].find((item) => item.textContent === "MFA 处理中");
  assert.equal(busy.disabled, true);
  console.log("authorization MFA UI tests passed (direct action, loading, task navigation, expiry errors)");
} finally { await act(() => root.unmount()); dom.window.close(); }
