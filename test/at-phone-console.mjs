import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConsoleWorkspace } from "../src/console-server.mjs";
import { startCdkServer } from "../src/cdk-server.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-at-phone-console-"));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "at-phone-console-admin-fixture";
let app; let base;
const client = (ip) => { let cookie = ""; let csrf = ""; return { async call(url, method = "GET", body) {
  const response = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(cookie ? { cookie } : {}), ...(csrf ? { "x-console-token": csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0]; const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; } if (data?.token) csrf = data.token; return { response, data, status: response.status };
}, csrf: () => csrf }; };
const fixtureToken = (email) => `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ email, "https://api.openai.com/auth": { chatgpt_account_id: "at-console-account" }, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`;
try {
  app = await startCdkServer({ createWorkspace: createConsoleWorkspace, root, listen: false });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  const admin = client("198.51.100.41"); const other = client("198.51.100.42");
  assert.equal((await admin.call("/api/auth/login", "POST", { cdk: process.env.TOSUB2_ADMIN_CDK })).status, 200);
  const generated = app.store.generate({ count: 1, quota: 20, note: "AT console fixture" }, app.store.adminId)[0];
  assert.equal((await other.call("/api/auth/login", "POST", { cdk: generated.secret })).status, 200);
  const token = fixtureToken("at-console@example.invalid");
  const imported = await other.call("/api/at-phone/import", "POST", { tokens: [token, token, "bad token"] });
  assert.equal(imported.status, 201); assert.equal(imported.data.count, 1); assert.equal(imported.data.invalid.length, 1); assert.equal(JSON.stringify(imported.data).includes("fixture"), false);
  const list = await other.call("/api/at-phone?status=queued&page=1&pageSize=20"); assert.equal(list.status, 200); assert.equal(list.data.total, 1); assert.equal(list.data.items[0].status, "queued");
  const exportResponse = await other.call("/api/at-phone/export?status=success"); assert.deepEqual(exportResponse.data, { emails: [], count: 0 });
  const ordinaryPreview = await other.call("/api/imports/preview", "POST", { mode: "single", payload: { email: "at-console@example.invalid" } }); assert.equal(ordinaryPreview.status, 200); assert.equal(ordinaryPreview.data.charge, 1, "AT task ownership does not waive ordinary import charge");
  const adminList = await admin.call("/api/at-phone"); assert.equal(adminList.status, 200); assert.equal(adminList.data.total, 0, "CDK task data is owner isolated");
  const anonymous = client("198.51.100.43"); assert.equal((await anonymous.call("/api/at-phone")).status, 401);
  console.log("[ok] AT phone console: authenticated routes, owner isolation, encrypted token redaction, export contract and ordinary import quota isolation");
} finally { await app?.close(); await fs.rm(root, { recursive: true, force: true }); }
