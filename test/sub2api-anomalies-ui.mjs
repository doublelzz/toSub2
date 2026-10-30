import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { act, useEffect, useId, useMemo, useRef, useState } from "react";
import * as icons from "lucide-react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";
import * as filters from "../web/src/task-filters.mjs";
import * as smsOptions from "../web/src/sms-number-options.mjs";

async function load(file, names, bindings = {}, end) {
  let source = await fs.readFile(new URL(file, import.meta.url), "utf8");
  if (end) source = source.slice(0, source.indexOf(end));
  const code = source.replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export /gm, "");
  const compiled = await transformWithEsbuild(code, file, { loader: "jsx", jsx: "transform" });
  const usedIcons = Object.fromEntries([...code.matchAll(/<([A-Z]\w*)/g)].map((match) => match[1]).filter((name) => icons[name]).map((name) => [name, icons[name]]));
  const scope = { React, useEffect, useId, useMemo, useRef, useState, ...usedIcons, ...bindings };
  return new Function(...Object.keys(scope), compiled.code + "; return { " + names.join(",") + " };")(...Object.values(scope));
}
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
const previousMatchMedia = globalThis.matchMedia;
globalThis.matchMedia = window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { createRoot } = await import("react-dom/client");
const container = document.getElementById("root"); const root = createRoot(container);
const ui = await load("../web/src/WorkspaceUi.jsx", ["Drawer", "MoreActions", "TaskFilters", "TaskOverview", "ThemeControl", "useCalendarDay", "useDialogFocus"], filters);
let auth = { authenticated: true, token: "fixture-anomaly-token", account: { id: "fixture-user", role: "user" }, workspace: { id: "fixture-user" }, features: { sub2apiMonitor: true, bulkActions: true }, logout: async () => {} };
const rows = Array.from({ length: 40 }, (_, index) => ({ id: `job-${index + 1}`, email: `account-${index + 1}@fixture.invalid`, status: "completed", createdAt: "2026-10-30T00:00:00.000Z", prompt: "已授权" }));
const config = { baseUrl: "https://fixture.example.invalid", adminApiKey: "synthetic-anomaly-key", monitorEnabled: true };
const saved = new Map([["chatgpt-onboarding.sub2api-upload-settings-v1", JSON.stringify(config)]]);
const queries = [], requests = [];
let report = { available: true, checkedAt: "2026-10-30T01:00:00.000Z", groupIds: [3], scanned: 30, inScope: 28, filterable: 25, items: [
  ...rows.slice(0, 25).map((row, index) => ({ remoteId: index + 100, email: row.email, jobId: row.id, status: "linked", groups: [{ id: 3, name: "plus" }] })),
  { remoteId: 501, email: "unlinked@example.invalid", jobId: null, status: "unlinked", message: "unlinked@example.invalid 未关联" },
  { remoteId: 502, email: "missing@example.invalid", jobId: null, status: "missing_task", message: "missing@example.invalid 本地无任务" },
] };
let failReport = false, holdReport = false, pendingReport;
const monitor = () => ({ enabled: true, configured: true, bindingId: "fixture-config", lastResult: { checked: 30, inScope: 28, filterable: 25, unlinked: 2, missingLocal: 1 } });
const { App, formatMonitorResult } = await load("../web/src/main.jsx", ["App", "formatMonitorResult"], {
  ...filters, ...smsOptions, ...ui,
  MfaWorkspace: () => null, EmailRebindWorkspace: () => null, OfferWorkspace: () => null, SmsPoolWorkspace: () => null,
  SmsPoolChoice: () => null, SmsPoolChargeDialog: () => null, CdkWorkspace: () => null, CurrentCdk: () => null, SmsPriceSelector: () => null,
  readWorkspaceValue: (key) => saved.get(key) || null, writeWorkspaceValue: (key, value) => saved.set(key, value), flushWorkspaceSettings: async () => {},
  cdkFetch: async (url, options = {}) => {
    requests.push({ url, method: options.method || "GET" });
    if (url === "/api/bootstrap") return Response.json(auth);
    if (url === "/api/mail-request-config") return Response.json({ ok: true });
    if (url === "/api/sub2api/monitor") return Response.json(monitor());
    if (url === "/api/sub2api/monitor/anomalies") {
      if (holdReport) return new Promise((resolve) => { pendingReport = () => resolve(Response.json(report)); });
      return failReport ? Response.json({ error: "本地报告读取失败" }, { status: 500 }) : Response.json(report);
    }
    if (url.startsWith("/api/jobs?") || url === "/api/jobs/query") {
      const query = url === "/api/jobs/query" ? JSON.parse(options.body) : Object.fromEntries(new URL(url, "http://localhost").searchParams);
      queries.push(query);
      const visible = rows.filter((row) => (!Object.hasOwn(query, "ids") || query.ids.includes(row.id)) && (!query.search || row.email.includes(query.search)));
      const page = Number(query.page || 1), start = (page - 1) * 20;
      return Response.json({ jobs: visible.slice(start, start + 20), selection: visible, stats: { total: rows.length, completed: rows.length }, pagination: { page, total: visible.length, totalPages: Math.max(1, Math.ceil(visible.length / 20)), pageSize: 20 } });
    }
    throw Error(`Unexpected request ${url}`);
  },
}, "const appRoot =");
const button = (label) => [...container.querySelectorAll("button")].find((row) => row.textContent.trim() === label);
const clickText = (label) => act(async () => { assert.ok(button(label), `Missing ${label}`); button(label).click(); });
const click = (selector) => act(async () => { assert.ok(container.querySelector(selector)); container.querySelector(selector).click(); });
try {
  assert.match(formatMonitorResult({ checked: 15, inScope: 0, filterable: 0 }), /所选分组异常 0 条，已关联本地 0 条/);
  await act(async () => root.render(React.createElement(App, { auth })));
  assert.equal(requests.filter((row) => row.url.endsWith("/anomalies")).length, 0, "no automatic report or remote lookup");
  assert.match(container.querySelector(".sub2api-anomaly-tools").textContent, /所选分组异常 28 条.*未关联 2 条/);
  await act(async () => {
    const search = container.querySelector('[aria-label="搜索邮箱"]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(search, "no-match");
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.equal(container.querySelectorAll(".job-row").length, 0);
  await clickText("筛选异常账号");
  assert.equal(container.querySelectorAll(".job-row").length, 20);
  assert.equal(queries.at(-1).ids.length, 25);
  assert.equal(queries.at(-1).search, ""); assert.equal(queries.at(-1).status, "all"); assert.equal(queries.at(-1).phoneBinding, "all");
  assert.match(container.querySelector(".sub2api-anomaly-filter").textContent, /已关联 25 个本地账号/);
  assert.match(container.querySelector(".sub2api-anomaly-report").textContent, /unlinked@example.invalid未关联/);
  assert.match(container.querySelector(".sub2api-anomaly-report").textContent, /missing@example.invalid本地无任务/);
  assert.equal(container.querySelectorAll('.job-row input[type="checkbox"]:checked').length, 0, "filtering never auto-selects accounts for operations");
  await click('[aria-label="下一页"]');
  assert.equal(container.querySelectorAll(".job-row").length, 5);
  assert.equal(queries.at(-1).page, 2); assert.equal(queries.at(-1).ids.length, 25, "filter covers all matching pages");
  await act(async () => {
    const search = container.querySelector('[aria-label="搜索邮箱"]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(search, "account-25@");
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.equal(queries.at(-1).ids.length, 25, "subsequent filters remain an intersection with the anomaly scope");
  assert.equal(container.querySelectorAll(".job-row").length, 1);
  await click('[aria-label="取消 Sub2API 异常筛选"]');
  assert.equal(Object.hasOwn(queries.at(-1), "ids"), false);
  assert.equal(container.querySelector(".sub2api-anomaly-filter"), null);

  report = { ...report, filterable: 0, items: report.items.filter((row) => row.status !== "linked") };
  await clickText("筛选异常账号");
  assert.deepEqual(queries.at(-1).ids, [], "an empty explicit ID scope must remain empty rather than returning all accounts");
  assert.equal(container.querySelectorAll(".job-row").length, 0);
  assert.match(container.querySelector(".sub2api-anomaly-report").textContent, /没有已关联的本地任务/);
  assert.ok(button("清除筛选") && !button("清除筛选").disabled);
  await clickText("清除筛选");
  assert.equal(Object.hasOwn(queries.at(-1), "ids"), false);
  assert.equal(container.querySelector(".sub2api-anomaly-report"), null);

  failReport = true; await clickText("筛选异常账号");
  assert.match(container.querySelector('[role="alert"]').textContent, /本地报告读取失败/);
  assert.equal(container.querySelector(".sub2api-anomaly-filter"), null);
  failReport = false;
  report = { available: false, message: "当前配置尚未巡检" };
  await clickText("筛选异常账号");
  assert.match(container.querySelector(".sub2api-anomaly-error").textContent, /当前配置尚未巡检/);

  holdReport = true; report = { available: true, checkedAt: "2026-10-30T01:00:00.000Z", items: [{ status: "linked", jobId: "job-1", email: rows[0].email }] };
  await act(async () => button("筛选异常账号").click());
  auth = { ...auth, token: "changed-fixture-token" };
  await act(async () => root.render(React.createElement(App, { auth })));
  await act(async () => pendingReport());
  assert.equal(container.querySelector(".sub2api-anomaly-filter"), null, "old-workspace responses cannot apply a filter after context changes");
  assert.equal(Object.hasOwn(queries.at(-1), "ids"), false);
  assert.ok(!requests.some((row) => /monitor\/check|sub2api\/upload|sub2api\/links/.test(row.url)), "filtering reads saved reports and local tasks only");
  assert.doesNotMatch(container.textContent, /synthetic-anomaly-key|fixture-anomaly-token/);
  console.log("Sub2API anomalies UI passed (explicit saved-report filter, all pages, empty ID scope, unmatched explanations, clear/reset, zero implicit writes, and stale-context protection)");
} finally {
  await act(async () => root.unmount()); dom.window.close(); globalThis.matchMedia = previousMatchMedia;
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else delete globalThis.localStorage;
}
