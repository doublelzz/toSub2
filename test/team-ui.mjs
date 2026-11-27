import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import React, { act, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as icons from "lucide-react";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createTeamWorkspace } from "../src/team-workspace.mjs";
import { createTeamClient } from "../src/team-client.mjs";
import { createTeamFixture, fixtureSession, TEAM_A } from "./team-fixture.mjs";

const rootDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-team-ui-")), fixture = await createTeamFixture();
const oldKey = process.env.TOSUB2_ENCRYPTION_KEY; process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const vault = await createCdkVault(rootDirectory);
const workspace = await createTeamWorkspace({ root: rootDirectory, vault,
  parseText: (raw) => [{ email: raw.split("----")[0], password: raw.split("----")[1] || "" }],
  clientFactory: (options) => createTeamClient({ ...options, chatgptBase: fixture.base }) });
const rawSession = JSON.stringify(fixtureSession("owner@example.com", fixture.base)), preview = workspace.preview({ text: rawSession });
await workspace.importAccounts({ text: rawSession, digest: preview.digest, requestKey: crypto.randomUUID() }, "ui-fixture-actor");
workspace.tick(3);
const untilReady = Date.now() + 5000;
while (workspace.query().overview.active && Date.now() < untilReady) await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(workspace.query().overview.teams, 2);
const requests = [];
async function cdkFetch(url, options) {
  if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const route = url.slice("/api/teams/".length), body = options.body ? JSON.parse(options.body) : {};
  requests.push({ route, body });
  try {
    let result;
    if (route === "query") result = workspace.query(body);
    else if (route === "sources") result = workspace.sources();
    else if (route === "import/preview") result = workspace.preview(body);
    else if (route === "import") result = await workspace.importAccounts(body, "ui-fixture-actor");
    else if (route === "delete") result = await workspace.deleteRecord(body);
    else {
      const [id, action] = route.split("/");
      result = action === "query" ? workspace.detail(id, body) : action === "invite-preview" ? workspace.invitePreview(id, body)
        : action === "select-account" ? await workspace.selectAccount(id, body.accountId) : await workspace.mutate(id, body, "ui-fixture-actor", action);
    }
    return Response.json(result);
  } catch (error) { return Response.json({ error: error.status ? error.message : "Fixture route failed" }, { status: error.status || 500 }); }
}
const usedIconNames = ["CalendarDays", "Check", "ChevronLeft", "ChevronRight", "CircleAlert", "Clock3", "LoaderCircle", "Mail", "Plus", "RefreshCw", "Search", "ShieldCheck", "Trash2", "Users", "X", "ChevronDown", "Moon", "MoreHorizontal", "Sun"];
const bindings = { React, useCallback, useEffect, useMemo, useRef, useState, useId: React.useId, ...Object.fromEntries(usedIconNames.map((name) => [name, icons[name]])), cdkFetch,
  prepareProxyNetworkOptions: async (mode) => mode === "keep" ? {} : { proxyUrl: "" }, readWorkspaceProxyPoolText: () => "",
  ProxyNetworkOptions: () => React.createElement("div", null, "网络方式沿用当前工作区") };
async function load(name, exports) {
  const source = await fs.readFile(new URL(`../web/src/${name}`, import.meta.url), "utf8");
  const code = source.replace(/^import[^\n]+\n/gm, "").replace("export default function", "function").replace(/^export /gm, "");
  const compiled = await transformWithEsbuild(code, name, { loader: "jsx", jsx: "transform" });
  return new Function(...Object.keys(bindings), `${compiled.code};return {${exports}};`)(...Object.values(bindings));
}
Object.assign(bindings, await load("WorkspaceUi.jsx", "Drawer,useDialogFocus"));
const { TeamWorkspace } = await load("TeamWorkspace.jsx", "TeamWorkspace");
const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{ width: 10, height: 10 }] : []; };
const { createRoot } = await import("react-dom/client"); const root = createRoot(document.getElementById("root"));
const all = (selector) => [...document.querySelectorAll(selector)];
const button = (label, scope = document) => [...scope.querySelectorAll("button")].find((element) => element.textContent.trim() === label);
const click = async (element) => { assert.ok(element, "Expected control is present"); await act(async () => element.click()); };
async function fill(element, value) {
  assert.ok(element);
  const prototype = element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value); element.dispatchEvent(new window.Event("input", { bubbles: true })); element.dispatchEvent(new window.Event("change", { bubbles: true })); });
}
async function waitFor(check) { const until = Date.now() + 5000; while (Date.now() < until) { if (check()) return; await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); } throw new Error("Team UI did not settle"); }
try {
  await act(async () => root.render(React.createElement(TeamWorkspace, { token: "fixture-csrf" })));
  await waitFor(() => all(".team-table tbody tr").length === 2);
  const row = all(".team-table tbody tr").find((element) => element.textContent.includes("协作团队"));
  await click(button("管理", row)); await waitFor(() => all(".team-member-table tbody tr").length === 5);
  assert.equal(all('[role="dialog"]').length, 1);
  assert.equal(document.body.style.overflow, "hidden");
  assert.match(document.querySelector(".team-seat-panels").textContent, /标准席位/);
  const protectedRows = all(".team-member-table tbody tr").filter((element) => element.textContent.includes("受保护")); assert.equal(protectedRows.length, 2);
  await click(button("邀请成员")); assert.equal(all('[role="dialog"]').length, 2);
  await fill(document.querySelector('[aria-label="邀请成员邮箱"]'), "new-ui@example.com\nNEW-UI@example.com\nowner@example.com");
  await waitFor(() => button("发送邀请") && !button("发送邀请").disabled);
  const capacity = document.querySelector(".team-capacity").textContent; assert.match(capacity, /本次新增 1/);
  await click(button("发送邀请")); await waitFor(() => document.querySelector(".team-invite-results"));
  assert.match(document.querySelector(".team-invite-results").textContent, /邀请已发送/); assert.match(document.querySelector(".team-invite-results").textContent, /已是成员/);
  assert.equal(fixture.state.requests.filter((entry) => entry.method === "POST" && entry.path.endsWith("/invites")).length, 1);
  assert.equal(fixture.state.spaces.get(TEAM_A).members.length, 5);
  assert.equal(button("发送邀请").disabled, true, "successful submission cannot be sent twice");
  await click(button("完成")); assert.equal(all('[role="dialog"]').length, 1);
  await click(all(".team-detail-tabs button").find((element) => element.textContent.startsWith("待接受邀请")));
  await waitFor(() => document.querySelector(".team-member-table tbody")?.textContent.includes("new-ui@example.com"));
  await click(all(".team-detail-tabs button").find((element) => element.textContent.startsWith("现有成员")));
  await waitFor(() => document.querySelector(".team-member-table tbody")?.textContent.includes("member@example.com"));
  const roleSelect = () => document.querySelector('[aria-label="修改 admin@example.com 的角色"]');
  await act(async () => { roleSelect().value = "account-owner"; roleSelect().dispatchEvent(new window.Event("change", { bubbles: true })); });
  assert.match(document.querySelector('[role="dialog"] [role="dialog"]')?.textContent || document.querySelectorAll('[role="dialog"]')[1].textContent, /admin@example.com/);
  assert.equal(fixture.state.spaces.get(TEAM_A).members.find((row) => row.email === "admin@example.com").role, "account-admin", "role change waits for explicit confirmation");
  await click(button("确认修改为所有者")); await waitFor(() => !button("确认修改为所有者"));
  assert.equal(fixture.state.spaces.get(TEAM_A).members.find((row) => row.email === "admin@example.com").role, "account-owner");
  await act(async () => { roleSelect().value = "standard-user"; roleSelect().dispatchEvent(new window.Event("change", { bubbles: true })); });
  await click(button("确认修改为普通成员")); await waitFor(() => !button("确认修改为普通成员"));
  assert.equal(fixture.state.spaces.get(TEAM_A).members.find((row) => row.email === "admin@example.com").role, "standard-user");
  const memberRow = all(".team-member-table tbody tr").find((element) => element.textContent.includes("member@example.com"));
  await click(button("移除", memberRow)); assert.match(document.querySelector(".team-remove-target").textContent, /member@example.com/);
  assert.equal(fixture.state.spaces.get(TEAM_A).members.length, 5, "confirmation must precede removal");
  await click(button("确认移除")); await waitFor(() => !document.querySelector(".team-remove-dialog"));
  assert.equal(fixture.state.spaces.get(TEAM_A).members.length, 4); assert.equal(fixture.state.spaces.get(TEAM_A).purchased, 10);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(all('[role="dialog"]').length, 0); assert.equal(document.body.style.overflow, "");
  await click(button("导入账号")); await click(button("粘贴账号资料"));
  await fill(document.querySelector('[aria-label="团队账号资料"]'), "new-account@example.com----fixture-private-password");
  await click(button("预览导入")); await waitFor(() => document.querySelector(".team-import-preview"));
  assert.match(document.querySelector(".team-import-preview").textContent, /1 个新账号/);
  const importPreview = requests.findLast((entry) => entry.route === "import/preview"); assert.equal(importPreview.body.updateExisting, false);
  assert.match(importPreview.body.text, /fixture-private-password/);
  await click(button("取消"));
  assert.doesNotMatch(document.body.textContent, /fixture-private-access-token|fixture-private-password/);
  assert.ok(requests.some((entry) => entry.route.endsWith("/invite-preview")));
  const teamRow = () => all(".team-table tbody tr").find((element) => element.textContent.includes("协作团队"));
  await click(button("删除记录", teamRow()));
  assert.match(document.querySelector(".team-delete-record-dialog").textContent, /GPT 团队、现有成员和订阅保持不变/);
  assert.match(document.querySelector(".team-delete-record-dialog").textContent, /后续同步不会重新添加/);
  assert.equal(requests.filter((entry) => entry.route === "delete").length, 0, "record deletion waits for confirmation");
  await click(button("取消"));
  assert.equal(workspace.query().overview.teams, 2);
  await click(button("管理", teamRow())); await waitFor(() => button("删除记录", document.querySelector(".team-drawer-footer")));
  await click(button("删除记录", document.querySelector(".team-drawer-footer")));
  assert.equal(all('[role="dialog"]').length, 2);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(all('[role="dialog"]').length, 1, "Escape dismisses the delete confirmation and retains the drawer");
  await click(button("删除记录", document.querySelector(".team-drawer-footer")));
  const deletedTeamId = workspace.query().rows.find((entry) => entry.workspaceId === TEAM_A).id;
  const upstreamBeforeDelete = fixture.state.requests.length;
  await click(button("确认删除记录"));
  await waitFor(() => all(".team-table tbody tr").length === 1 && all('[role="dialog"]').length === 0);
  assert.equal(fixture.state.requests.length, upstreamBeforeDelete, "deleting a local team makes no upstream request");
  assert.equal(fixture.state.spaces.get(TEAM_A).members.length, 4);
  assert.match(document.querySelector(".team-notice").textContent, /已删除管理记录/);
  assert.deepEqual(requests.findLast((entry) => entry.route === "delete").body, { id: deletedTeamId, kind: "team" });
  await click(button("删除记录", all(".team-table tbody tr")[0]));
  await click(button("确认删除记录")); await waitFor(() => all(".team-table tbody tr").length === 0);
  assert.equal(workspace.query().overview.accounts, 0, "deleting the last team leaves no orphan account row");
  console.log("Team UI tests passed: member drawer, invitations/roles/removal, import preview and local deletion confirmation/cancellation, nested Escape, drawer closure and list refresh");
} finally {
  await act(async () => root.unmount()); dom.window.close(); await workspace.shutdown(); await fixture.close(); await fs.rm(rootDirectory, { recursive: true, force: true });
  delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  if (oldKey === undefined) delete process.env.TOSUB2_ENCRYPTION_KEY; else process.env.TOSUB2_ENCRYPTION_KEY = oldKey;
}
