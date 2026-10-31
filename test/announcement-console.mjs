import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startCdkServer } from "../src/cdk-server.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-announcement-console-"));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-announcement-administrator-only";
let app;
let base;
let assertions = 0;
const equal = (actual, expected, description) => { assert.deepEqual(actual, expected, description); assertions++; };
const check = (value, description) => { assert.ok(value, description); assertions++; };

function client() {
  let cookie = "";
  let token = "";
  return async (route, method = "GET", body, headers = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(token ? { "x-console-token": token } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.headers.get("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    const data = await response.json();
    if (response.ok && data.token) token = data.token;
    return { status: response.status, data };
  };
}

async function start() {
  app = await startCdkServer({ root, listen: false, createWorkspace: async () => ({
    activeCount: () => 0, tick: () => 0, inventory: () => [], publicJobs: () => [],
    pause() {}, resume() {}, stop: async () => {}, shutdown: async () => {},
    dispatch: async () => ({ status: 200, body: Buffer.from(JSON.stringify({ features: {} })) }),
  }) });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
}

try {
  await start();
  const anonymous = client();
  const admin = client();
  const user = client();
  const endpoint = "/api/admin/announcement";
  equal((await anonymous(endpoint)).status, 401, "announcement management requires a session");
  equal((await anonymous(endpoint, "PUT", {})).status, 401, "anonymous writes are rejected");
  equal(Object.hasOwn((await anonymous("/api/bootstrap")).data, "announcement"), false, "anonymous bootstrap does not reveal tutorials");
  const login = await admin("/api/auth/login", "POST", { cdk: process.env.TOSUB2_ADMIN_CDK });
  equal(login.status, 200, "admin fixture logs in");
  equal(login.data.announcement, null, "initial bootstrap has no active announcement");
  const adminId = login.data.account.id;
  const userKey = app.store.generate({ count: 1, quota: 1, note: "announcement fixture" }, adminId)[0];
  await user("/api/auth/login", "POST", { cdk: userKey.secret });
  equal((await user(endpoint)).status, 403, "ordinary users cannot read the management endpoint");
  equal((await user(endpoint, "PUT", {})).status, 403, "ordinary users cannot edit announcements");

  let current = (await admin(endpoint)).data.announcement;
  equal(current, { enabled: false, id: null, title: "", content: "", format: "html", publishedAt: null, updatedAt: null }, "management starts with an empty disabled announcement");
  const request = (patch = {}) => ({ title: current.title, content: current.content, enabled: current.enabled, expectedUpdatedAt: current.updatedAt, ...patch });
  const save = async (patch = {}) => {
    const result = await admin(endpoint, "PUT", request(patch));
    if (result.status === 200) current = result.data.announcement;
    return result;
  };
  equal((await admin(endpoint, "PUT", request(), { "x-console-token": "wrong-token" })).status, 403, "writes require the current CSRF token");
  equal((await admin(endpoint, "PUT", request(), { origin: "https://untrusted.invalid" })).status, 403, "cross-origin writes are rejected");
  equal((await admin(endpoint, "POST", request())).status, 405, "unsupported management methods are rejected");
  equal((await save({ enabled: true })).status, 422, "empty announcements cannot be enabled");
  equal((await save({ publish: true })).status, 422, "empty announcements cannot be published");
  equal((await save({ title: "Tutorial", enabled: true, content: "<script>alert(1)</script><p>&nbsp;</p>" })).status, 422, "content removed by sanitization cannot be enabled");
  equal((await save({ content: "汉".repeat(34_000) })).status, 413, "content limit is measured in UTF-8 bytes");
  equal((await save({ content: '<a href="https://example.invalid">go</a>'.repeat(1_500) })).status, 413, "sanitizer-added link attributes cannot exceed the persisted content limit");
  equal((await save({ title: "x".repeat(101) })).status, 422, "oversized titles are rejected");
  equal((await save({ format: "md" })).status, 422, "unexpected content formats are rejected");
  equal((await admin(endpoint, "PUT", { title: "Draft", content: "<p>Body</p>", enabled: false })).status, 422, "writes require a version guard");
  equal((await save({ enabled: "true" })).status, 422, "enabled state must be a boolean");

  equal((await save({ title: "入门教程", content: "<h2>账号导入</h2><p>保存草稿</p>" })).status, 200, "disabled content can be saved before publishing");
  equal(current.id, null, "saving an unpublished draft does not create a publication");
  check(current.updatedAt, "draft saves expose their concurrency version");
  equal((await user("/api/bootstrap")).data.announcement, null, "disabled drafts are hidden from users");
  equal((await save({ enabled: true, content: '<h2 onclick="alert(1)">🚀 使用教程</h2><p style="color:#dc2626">第一步</p><script>alert(1)</script><a href="javascript:alert(1)">链接</a><pre><code>email----password</code></pre>' })).status, 200, "first enable publishes sanitized HTML");
  const firstId = current.id;
  const firstPublishedAt = current.publishedAt;
  check(firstId && firstPublishedAt, "first publication has a server-generated identity and time");
  equal(/<script|onclick=|javascript:/i.test(current.content), false, "stored content has no scripts, event handlers, or script URLs");
  check(current.content.includes("🚀") && current.content.includes("email----password"), "tutorial emoji and code content survive sanitization");
  equal(app.store.setting(adminId, "site-announcement").content, current.content, "HTML is cleaned before persistence");
  equal((await user("/api/bootstrap")).data.announcement, current, "authenticated users receive the active publication");
  equal(Object.hasOwn((await anonymous("/api/bootstrap")).data, "announcement"), false, "active tutorial contents remain unavailable anonymously");

  const switched = await admin("/api/auth/workspace", "POST", { cdkId: userKey.id });
  equal(switched.data.announcement.id, firstId, "admin workspace switches retain the same global announcement");
  equal((await save({ title: "修订后的入门教程", content: "<p>修正文字</p>" })).status, 200, "admin can edit the global announcement from a selected user workspace");
  equal(current.id, firstId, "ordinary saves keep the publication identity");
  equal(current.publishedAt, firstPublishedAt, "ordinary saves keep the publication time");
  equal(app.store.setting(userKey.id, "site-announcement"), null, "global content is not saved in the selected tenant");
  equal((await user("/api/bootstrap")).data.announcement.title, current.title, "global edits are immediately visible to users");
  equal((await save({ enabled: false })).status, 200, "announcement can be taken offline");
  equal(current.id, firstId, "taking a publication offline retains its identity");
  equal((await user("/api/bootstrap")).data.announcement, null, "disabled publication is excluded from bootstrap");
  equal((await admin(endpoint)).data.announcement.id, firstId, "disabled publication remains editable");
  equal((await save({ enabled: true })).status, 200, "existing publication can be enabled again");
  equal(current.id, firstId, "re-enabling does not create a new popup version");

  const stale = request({ title: "Stale revision" });
  const previousVersion = current.updatedAt;
  equal((await save({ publish: true, title: "新版教程" })).status, 200, "explicit publication succeeds");
  check(current.id !== firstId, "explicit publication changes the identity");
  check(current.publishedAt !== firstPublishedAt && current.updatedAt > previousVersion, "publication updates the times monotonically");
  const published = current;
  const conflict = await admin(endpoint, "PUT", stale);
  equal(conflict.status, 409, "stale editors cannot overwrite newer content");
  equal(conflict.data.code, "ANNOUNCEMENT_CONFLICT", "conflicts expose a stable error code");
  equal((await admin(endpoint)).data.announcement, published, "a rejected stale write preserves the publication");
  const racing = await Promise.all(["A", "B"].map((title) => admin(endpoint, "PUT", request({ title }))));
  equal(racing.map((item) => item.status).sort(), [200, 409], "concurrent writers cannot both replace the same revision");
  current = racing.find((item) => item.status === 200).data.announcement;
  equal(current.id, published.id, "winning ordinary save still retains the publication identity");

  app.store.saveSetting(adminId, "site-announcement", { ...current, content: '<p>Historical tutorial</p><img src="https://example.invalid/tutorial.png" onerror="alert(1)"><script>alert(1)</script>' });
  const cleanedHistorical = (await user("/api/bootstrap")).data.announcement;
  equal(/<script|onerror=/i.test(cleanedHistorical.content), false, "historical settings are sanitized on read");
  current = (await admin(endpoint)).data.announcement;
  equal(current.content, cleanedHistorical.content, "admin and user reads share sanitization");
  equal((await save({ title: "Final tutorial", content: "<p>Persisted body ✅</p>" })).status, 200, "valid content remains editable after historical cleanup");
  const persisted = current;
  app.store.saveSetting(adminId, "site-announcement", { ...current, content: "<script>alert(1)</script>" });
  equal((await user("/api/bootstrap")).data.announcement, null, "legacy enabled content with no safe body is suppressed");
  app.store.saveSetting(adminId, "site-announcement", persisted);
  await app.close(); app = null;
  await start();
  const restartedAdmin = client();
  const restartedLogin = await restartedAdmin("/api/auth/login", "POST", { cdk: process.env.TOSUB2_ADMIN_CDK });
  equal(restartedLogin.data.announcement, persisted, "publication persists across process restart");
  equal((await restartedAdmin(endpoint)).data.announcement, persisted, "editable announcement persists in the existing settings store");
  console.log(`[ok] announcement console: ${assertions} assertions`);
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
