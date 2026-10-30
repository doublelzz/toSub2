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
const config = { baseUrl: "https://fixture.example.invalid", adminApiKey: "synthetic-links-key", groupIds: ["7"] };
const saved = new Map([["chatgpt-onboarding.sub2api-upload-settings-v1", JSON.stringify(config)]]);
const auth = { authenticated: true, token: "synthetic-links-token", account: { id: "fixture-user", role: "user" }, workspace: { id: "fixture-user" }, features: { sub2apiUpload: true, bulkActions: true }, logout: async () => {} };
const rows = ["one", "two", "three", "four"].map((id) => ({ id, email: id + "@fixture.invalid", status: "completed", canDownload: true, createdAt: "2026-10-28T00:00:00.000Z", prompt: "已授权" }));
let largePage = false;
const pendingLinks = []; const pendingPreviews = []; const pendingUploads = [];
const linkRequests = []; const previews = []; const uploads = [];
const cacheRequests = []; const cachedItems = new Map();
const pendingCache = []; let holdCacheRead = false;
const cacheKey = (value) => JSON.stringify([value.baseUrl.replace(/\/+$/, ""), value.adminApiKey]);
const { App, Sub2ApiPushPreview } = await load("../web/src/main.jsx", ["App", "Sub2ApiPushPreview"], {
  ...filters, ...smsOptions, ...ui,
  MfaWorkspace: () => null, EmailRebindWorkspace: () => null, OfferWorkspace: () => null, SmsPoolWorkspace: () => null,
  SmsPoolChoice: () => null, SmsPoolChargeDialog: () => null, CdkWorkspace: () => null, CurrentCdk: () => null, SmsPriceSelector: () => null,
  readWorkspaceValue: (key) => saved.get(key) || null,
  writeWorkspaceValue: (key, value) => saved.set(key, value), flushWorkspaceSettings: async () => {},
  cdkFetch: async (url, options = {}) => {
    if (url === "/api/bootstrap") return Response.json(auth);
    if (url === "/api/mail-request-config") return Response.json({ ok: true });
    if (url.startsWith("/api/jobs?")) {
      const page = Number(new URL(url, "http://localhost").searchParams.get("page") || 1);
      return Response.json({ jobs: largePage ? rows : rows.slice((page - 1) * 2, page * 2), selection: rows, stats: {}, pagination: { page, total: rows.length, totalPages: 2, pageSize: 2 } });
    }
    if (url === "/api/sub2api/links") {
      const body = JSON.parse(options.body); linkRequests.push(body);
      return new Promise((resolve) => pendingLinks.push((data, status = 200) => {
        if (status === 200) {
          const previous = cachedItems.get(cacheKey(body.config)) || new Map();
          for (const item of data.items || []) if (item.status === "linked" && (!previous.has(item.id) || Date.parse(item.checkedAt || "") >= Date.parse(previous.get(item.id)?.checkedAt || ""))) previous.set(item.id, { ...item, cached: true });
          cachedItems.set(cacheKey(body.config), previous);
        }
        resolve(Response.json(data, { status }));
      }));
    }
    if (url === "/api/sub2api/links-cache") {
      const body = JSON.parse(options.body); cacheRequests.push(body);
      const previous = cachedItems.get(cacheKey(body.config)) || new Map();
      const response = { configured: true, items: body.ids.map((id) => previous.get(id)).filter(Boolean) };
      return holdCacheRead ? new Promise((resolve) => pendingCache.push(() => resolve(Response.json(response)))) : Response.json(response);
    }
    if (url === "/api/sub2api/upload-preview") {
      previews.push(JSON.parse(options.body));
      return new Promise((resolve) => pendingPreviews.push((data, status = 200) => resolve(Response.json(data, { status }))));
    }
    if (url === "/api/sub2api/monitor") return Response.json({ enabled: false, configured: true });
    if (url === "/api/sub2api/upload") {
      const body = JSON.parse(options.body); uploads.push(body);
      return new Promise((resolve) => pendingUploads.push((data, status = 200) => {
        if (status === 200) {
          const previous = cachedItems.get(cacheKey(body.config)) || new Map();
          for (const row of data.result?.results || []) if (row.success && row.accounts?.length) previous.set(row.jobId || row.id, { id: row.jobId || row.id, status: "linked", accounts: row.accounts, checkedAt: row.checkedAt, metadataComplete: true, cached: true });
          cachedItems.set(cacheKey(body.config), previous);
        }
        resolve(Response.json(data, { status }));
      }));
    }
    throw new Error("Unexpected request " + url);
  },
}, "const appRoot =");
const click = async (selector) => act(async () => { const element = container.querySelector(selector); assert.ok(element, "Missing " + selector); element.click(); });
const byText = (label, scope = container) => [...scope.querySelectorAll("button")].find((button) => button.textContent.trim() === label);
const clickText = (label, scope) => act(async () => { const button = byText(label, scope); assert.ok(button, "Missing button " + label); button.click(); });
const resolveNext = (queue, data, status) => act(async () => { assert.ok(queue.length); queue.shift()(data, status); });
const queryButton = () => container.querySelector(".sub2api-link-controls button");
const linked = (id, name) => ({ id, status: "linked", checkedAt: "2026-10-30T00:00:00.000Z", metadataComplete: true, accounts: [{ id: 71, platform: "openai", type: "oauth", status: "active", schedulable: true, proxyId: 3, concurrency: 12, loadFactor: 80, priority: 2, groups: [{ id: 7, name }] }] });
const preview = (changes = {}) => ({
  previewToken: "synthetic-preview-token", expiresAt: new Date(Date.now() + 300000).toISOString(),
  selected: 2, created: 1, updated: 1, blocked: 1, skipped: 0, canPush: true,
  rows: [{ id: "one", email: "one@fixture.invalid", action: "create", groups: [{ id: 7, name: "Plus <script>" }], message: "将新增" },
    { id: "three", email: "three@fixture.invalid", action: "update", remoteId: 71, groups: [{ id: 7, name: "Plus" }], targetGroups: [{ id: 8, name: "目标号池" }], message: "将更新已有账号" },
    { id: "four", email: "four@fixture.invalid", action: "blocked", message: "多个候选，需要关联" }],
  ...changes,
});
const changeConfig = async () => {
  await clickText("配置", container.querySelector(".workspace-tabs"));
  await click(".sub2api-toolbar .provider-settings-button");
  await act(async () => {
    const input = container.querySelector('.sub2api-settings-dialog input[type="url"]');
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, "https://next-fixture.example.invalid");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector(".sub2api-settings-dialog").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
};

try {
  await act(async () => root.render(React.createElement(App, { auth })));
  assert.equal(linkRequests.length, 0);
  assert.equal(queryButton(), null, "hidden association column has no query action");
  await click('[aria-label="显示 Sub2API 关联"]');
  assert.equal(queryButton().disabled, true, "zero selection disables manual query");
  assert.equal(cacheRequests.length, 1, "showing the column loads saved local metadata once without contacting the remote service");
  assert.equal(linkRequests.length, 0, "showing the column must not query");
  assert.match(container.querySelector(".sub2api-link-column").textContent, /未查询，勾选账号后查询/);
  await click('[aria-label="选择 one@fixture.invalid"]');
  assert.equal(linkRequests.length, 0, "selecting a row must not query");
  await click('[aria-label="下一页"]');
  await click('[aria-label="选择 three@fixture.invalid"]');
  assert.equal(linkRequests.length, 0, "pagination and cross-page selection must not query");
  assert.match(queryButton().textContent, /查询已选关联（2）/);
  await act(async () => { queryButton().click(); queryButton().click(); });
  assert.equal(linkRequests.length, 1, "query has a synchronous double-click guard");
  assert.deepEqual(linkRequests[0].ids, ["one", "three"], "manual query uses cross-page selection only");
  await resolveNext(pendingLinks, { items: [linked("one", "Plus <script>"), { id: "three", status: "unlinked", message: "尚未关联" }] });
  assert.match(container.querySelector(".sub2api-link-column").textContent, /未关联/);
  await click('[aria-label="上一页"]');
  assert.match(container.querySelector(".sub2api-link-column").textContent, /已关联.*Plus <script>/);
  assert.equal(container.querySelector("script"), null);
  await click(`[aria-label="查看 ${rows[0].email} 的任务详情"]`);
  assert.match(container.querySelector(".job-detail-content").textContent, /远端 #71/);
  assert.match(container.querySelector(".job-detail-content").textContent, /正常/);
  assert.match(container.querySelector(".job-detail-content").textContent, /可调度/);
  assert.match(container.querySelector(".job-detail-content").textContent, /代理 #3/);
  assert.match(container.querySelector(".job-detail-content").textContent, /并发/);
  assert.match(container.querySelector(".job-detail-content").textContent, /负载因子/);
  assert.match(container.querySelector(".job-detail-content").textContent, /优先级/);
  assert.equal(container.querySelectorAll(".sub2api-group-tag").length > 0, true);
  await click('[aria-label="关闭面板"]');
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 1000)));
  assert.equal(linkRequests.length, 1, "ordinary polling must not query");
  const cacheReadsAfterPolling = cacheRequests.length;
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 1000)));
  assert.equal(cacheRequests.length, cacheReadsAfterPolling, "routine polling does not reload local metadata repeatedly");
  await click('[aria-label="显示 Sub2API 关联"]');
  await click('[aria-label="显示 Sub2API 关联"]');
  assert.equal(linkRequests.length, 1, "toggle only controls visibility");
  assert.doesNotMatch(container.textContent, /synthetic-links-key|synthetic-links-token/);

  await act(async () => queryButton().click());
  await resolveNext(pendingLinks, { error: "fixture failure synthetic-links-key" }, 502);
  assert.match(container.querySelector(".sub2api-link-column").textContent, /已关联.*Plus <script>/);
  assert.match(container.querySelector(".sub2api-link-column").textContent, /刷新失败，保留上次结果/);
  assert.match(container.querySelector(".sub2api-link-column").textContent, /结果更新于/);
  assert.doesNotMatch(container.textContent, /synthetic-links-key/);
  await act(async () => queryButton().click());
  await resolveNext(pendingLinks, { items: [{ id: "one", status: "missing", accounts: [], message: "远端账号已删除", checkedAt: "2026-10-30T00:02:00.000Z" }] });
  assert.match(container.querySelector(".sub2api-link-column").textContent, /远端已删除/);
  assert.equal(container.querySelector(".sub2api-link-column .sub2api-group-tags"), null, "a confirmed missing account clears old linked metadata instead of retaining it as a refresh error");
  await act(async () => queryButton().click());
  await resolveNext(pendingLinks, { items: [linked("one", "Restored group")] });

  await clickText("上传到 Sub2API", container.querySelector(".selection-toolbar"));
  assert.equal(previews.length, 1); assert.equal(uploads.length, 0);
  await resolveNext(pendingPreviews, preview());
  const modal = container.querySelector(".sub2api-push-dialog");
  assert.match(modal.textContent, /将新增1.*将更新1.*阻止1/);
  assert.match(modal.textContent, /#71/);
  assert.match(modal.textContent, /当前分组：Plus目标分组：目标号池/);
  assert.equal(modal.querySelector("script"), null);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(container.querySelector(".sub2api-push-dialog"), null);
  assert.equal(uploads.length, 0, "Escape never pushes");

  await clickText("上传到 Sub2API", container.querySelector(".selection-toolbar"));
  await resolveNext(pendingPreviews, preview());
  await clickText("取消", container.querySelector(".sub2api-push-dialog"));
  assert.equal(uploads.length, 0, "cancel never pushes");

  await act(async () => {
    const singleButton = [...container.querySelector(".job-row").querySelectorAll("button")].find((button) => button.textContent.trim() === "上传");
    assert.ok(singleButton); singleButton.click(); singleButton.click();
  });
  assert.equal(previews.length, 3, "single upload also uses a double-click guarded preview");
  assert.deepEqual(previews.at(-1).ids, ["one"]); assert.equal(uploads.length, 0);
  await resolveNext(pendingPreviews, preview({ selected: 1, created: 0, updated: 1, blocked: 0, rows: [preview().rows[1]] }));
  const snapshot = previews.at(-1);
  await click('[aria-label="选择 one@fixture.invalid"]');
  await act(async () => { const confirm = byText("确认推送 1 条"); confirm.click(); confirm.click(); });
  assert.equal(uploads.length, 1, "confirmation has a synchronous double-click guard");
  assert.deepEqual(uploads[0], { ...snapshot, previewToken: "synthetic-preview-token" }, "writes keep the exact preview ids, config and token despite selection changes");
  assert.equal(container.querySelector('[aria-label="关闭推送预检"]').disabled, true);
  assert.equal(byText("取消", container.querySelector(".sub2api-push-dialog")).disabled, true);
  const queriesBeforePush = linkRequests.length;
  await resolveNext(pendingUploads, { created: 0, updated: 1, linked: 1, uploaded: 1, result: { results: [{ id: "one", jobId: "one", success: true, accounts: [{ ...linked("one", "Pushed group").accounts[0], id: 72 }], checkedAt: "2026-10-30T00:05:00.000Z" }] }, rows: [] });
  assert.match(container.querySelector(".global-success").textContent, /已更新 1 条，已关联 1 条/);
  assert.equal(linkRequests.length, queriesBeforePush, "successful push does not query remote associations");
  assert.match(container.querySelector(".sub2api-link-column").textContent, /已关联.*远端 #72.*Pushed group/);

  await click('[aria-label="选择 one@fixture.invalid"]');
  await act(async () => queryButton().click());
  const oldConfiguration = pendingLinks.shift();
  await clickText("上传到 Sub2API", container.querySelector(".selection-toolbar"));
  await resolveNext(pendingPreviews, preview({ selected: 1, created: 1, updated: 0 }));
  await changeConfig();
  assert.match(container.querySelector(".sub2api-push-dialog").textContent, /配置已变化.*失效/);
  assert.equal(byText("确认推送 1 条").disabled, true);
  await act(async () => oldConfiguration({ items: [linked("one", "OLD CONFIGURATION")] }));
  assert.doesNotMatch(container.textContent, /OLD CONFIGURATION/);
  assert.equal(linkRequests.length, queriesBeforePush + 1, "configuration change never automatically re-queries");
  assert.match(container.querySelector(".sub2api-link-column").textContent, /未查询/);
  await clickText("取消", container.querySelector(".sub2api-push-dialog"));

  let confirms = 0; let closes = 0;
  await act(async () => root.render(React.createElement(Sub2ApiPushPreview, { preview: preview({ created: 0, updated: 0, canPush: false }), onConfirm: () => confirms++, onClose: () => closes++ })));
  assert.equal(byText("确认推送 0 条").disabled, true);
  assert.match(container.textContent, /没有可执行的记录/);
  await act(async () => root.render(React.createElement(Sub2ApiPushPreview, { preview: preview({ expiresAt: new Date(Date.now() - 1000).toISOString() }), onConfirm: () => confirms++, onClose: () => closes++ })));
  assert.match(container.textContent, /预检已过期/);
  assert.equal(byText("确认推送 2 条").disabled, true);
  await act(async () => root.render(React.createElement(Sub2ApiPushPreview, { preview: preview({ expiresAt: new Date(Date.now() + 100).toISOString() }), onConfirm: () => confirms++, onClose: () => closes++ })));
  await act(async () => new Promise((resolve) => window.setTimeout(resolve, 150)));
  assert.match(container.textContent, /预检已过期/);
  assert.equal(confirms, 0);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(closes, 1);

  saved.set("chatgpt-onboarding.sub2api-upload-settings-v1", JSON.stringify(config));
  const remoteQueriesBeforeReload = linkRequests.length;
  await act(async () => root.render(React.createElement(App, { key: "restored-saved-association", auth })));
  assert.equal(linkRequests.length, remoteQueriesBeforeReload, "reloading a workspace restores saved associations without a remote request");
  assert.match(container.querySelector(".sub2api-link-column").textContent, /已关联.*远端 #72.*Pushed group.*结果更新于/);
  assert.equal(container.querySelector(".sub2api-link-column time").dateTime, "2026-10-30T00:05:00.000Z", "restored metadata retains its actual check time after a successful push");
  assert.equal(saved.has("tosub2.sub2api-links-cache"), false, "association snapshots are not written to browser storage");

  cachedItems.set(cacheKey(config), new Map([["one", { id: "one", status: "linked", accounts: [{ id: 490, groups: [], status: "unknown" }], metadataComplete: false, checkedAt: null, cached: true }]]));
  await act(async () => root.render(React.createElement(App, { key: "legacy-saved-association", auth })));
  assert.match(container.querySelector(".sub2api-link-column").textContent, /已关联.*远端 #490.*分组待更新.*详情待更新/);
  assert.equal(linkRequests.length, remoteQueriesBeforeReload, "legacy associations never trigger an automatic remote metadata backfill");

  holdCacheRead = true;
  await act(async () => root.render(React.createElement(App, { key: "cache-response-race", auth })));
  await click('[aria-label="选择 one@fixture.invalid"]');
  await act(async () => queryButton().click());
  await resolveNext(pendingLinks, { items: [linked("one", "Fresh manual result")] });
  assert.ok(pendingCache.length);
  await act(async () => pendingCache.shift()());
  assert.match(container.querySelector(".sub2api-link-column").textContent, /已关联.*Fresh manual result/);
  assert.doesNotMatch(container.querySelector(".sub2api-link-column").textContent, /远端 #490/, "a late local-cache response cannot replace newer manual lookup metadata");
  holdCacheRead = false;

  saved.set("chatgpt-onboarding.sub2api-upload-settings-v1", JSON.stringify({}));
  await act(async () => root.render(React.createElement(App, { key: "unconfigured", auth })));
  assert.equal(container.querySelector('[aria-label="显示 Sub2API 关联"]'), null);
  saved.set("chatgpt-onboarding.sub2api-upload-settings-v1", JSON.stringify(config));
  rows.push(...Array.from({ length: 497 }, (_, index) => ({ ...rows[0], id: "extra-" + index, email: "extra-" + index + "@fixture.invalid" })));
  largePage = true;
  await act(async () => root.render(React.createElement(App, { key: "large-page", auth })));
  if (!container.querySelector('[aria-label="显示 Sub2API 关联"]').checked) await click('[aria-label="显示 Sub2API 关联"]');
  await click('[aria-label="选择当前页全部任务"]');
  assert.match(queryButton().textContent, /查询已选关联（501）/);
  assert.equal(queryButton().disabled, true, "more than 500 selections cannot be queried as one batch");
  assert.match(container.textContent, /每次最多查询 500 个账号/);
  console.log("Sub2API UI passed (manual selected-only cross-page lookups, no implicit remote queries, preview/cancel/confirmation, immutable snapshots, double-click guards, expired/config invalidation, escaped text and hidden keys)");
} finally {
  await act(async () => root.unmount()); dom.window.close(); globalThis.matchMedia = previousMatchMedia;
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else delete globalThis.localStorage;
}
