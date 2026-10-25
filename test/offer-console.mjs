import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createConsoleWorkspace } from "../src/console-server.mjs";
import { startCdkServer } from "../src/cdk-server.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-offer-http-"));
const requests = []; const issued = new Map();
const accessToken = (email) => `e30.${Buffer.from(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + 3600,
  "https://api.openai.com/auth": { chatgpt_account_id: `personal-${email}` } })).toString("base64url")}.fixture-private-session`;
const backend = http.createServer((req, res) => void upstreamRequest(req, res));
await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
const upstream = `http://127.0.0.1:${backend.address().port}`;
async function upstreamRequest(req, res) {
  const url = new URL(req.url, upstream); requests.push(url.pathname);
  const send = (value, status = 200, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)); };
  const cookie = /fixture_email=([^;]+)/.exec(req.headers.cookie || "")?.[1];
  const email = cookie ? Buffer.from(cookie, "base64url").toString() : "";
  if (url.pathname.startsWith("/mail/")) {
    const at = issued.get("auto@example.com"); send({ data: { code: at ? "001234" : "999999", message_id: at ? "fresh" : "old", received_at: new Date(at || Date.now() - 3600000).toISOString() } }); return;
  }
  if (url.pathname === "/") { send({}, 200, { "set-cookie": ["__Host-next-auth.csrf-token=fixture; Path=/", "oai-did=fixture-device; Path=/"] }); return; }
  if (url.pathname === "/api/auth/providers") { send({}); return; }
  if (url.pathname === "/api/auth/csrf") { send({ csrfToken: "fixture" }); return; }
  if (url.pathname === "/api/auth/signin/openai") {
    const target = url.searchParams.get("login_hint");
    send({ url: `${upstream}/${target.startsWith("password") ? "log-in/password" : "email-verification"}` }, 200,
      { "set-cookie": `fixture_email=${Buffer.from(target).toString("base64url")}; Path=/` }); return;
  }
  if (["/log-in/password", "/email-verification"].includes(url.pathname)) {
    if (url.pathname === "/email-verification") issued.set(email, Date.now()); send({}); return;
  }
  if (["/api/accounts/email-otp/validate", "/api/accounts/password/verify", "/api/accounts/email-otp/resend"].includes(url.pathname)) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (url.pathname.endsWith("resend")) { issued.set(email, Date.now()); send({}); return; }
    if (url.pathname.includes("email-otp") && body.code !== "001234") { send({ error: { code: "wrong_email_otp_code" } }, 400); return; }
    if (url.pathname.includes("password") && body.password !== "fixture-private-password") { send({ error: { code: "incorrect_password" } }, 400); return; }
    send({ continue_url: `${upstream}/login-callback` }); return;
  }
  if (url.pathname === "/login-callback") { send({}, 200, { "set-cookie": "__Secure-next-auth.session-token=fixture; Path=/" }); return; }
  if (url.pathname === "/api/auth/session") { send({ user: { email }, accessToken: accessToken(email), expires: "2099-01-01T00:00:00Z" }); return; }
  if (url.pathname === "/backend-api/accounts/check/v4-2023-04-27") {
    let claims; try { claims = JSON.parse(Buffer.from(req.headers.authorization.split(".")[1], "base64url")); } catch { send({}, 401); return; }
    const id = `personal-${claims.email}`;
    if (req.headers["chatgpt-account-id"] !== id) { send({}, 403); return; }
    send({ accounts: { team: { account: { account_id: "team", plan_type: "plus" } }, [id]: { account: { account_id: id, plan_type: "free" }, eligible_promo_campaigns: { plus: { id: "plus-2-months-50-pct-off" } } } } }); return;
  }
  send({ error: "Unexpected upstream route" }, 404);
}
const wrapper = path.join(root, "protocol-fixture.mjs");
await fs.writeFile(wrapper, `if(!process.argv.includes('--offer-check')) process.exit(97); process.argv.push('--native-http'); await import(${JSON.stringify(pathToFileURL(path.resolve("src/protocol-login.mjs")).href)});`);
process.env.TOSUB2_ADMIN_CDK = "offer-integration-fixture-admin-only";
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.ONBOARDING_PROTOCOL_SCRIPT = wrapper;
process.env.CHATGPT_BASE = upstream; process.env.AUTH_BASE = upstream;
process.env.NODE_ENV = "test"; process.env.TOSUB2_TEST_SENTINEL_TOKEN = "offer-fixture-sentinel";
process.env.LOCALAPPDATA = path.join(root, "isolated-credentials");
let app; let base; let cookie = ""; let token = "";
async function call(route, method = "GET", body, extra = {}) {
  const response = await fetch(`${base}${route}`, { method, headers: { "content-type": "application/json", "x-console-token": token, cookie, ...extra }, ...(body && method !== "GET" ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json() };
}
async function startServer() { app = await startCdkServer({ createWorkspace: createConsoleWorkspace, root, listen: false }); await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${app.server.address().port}`; }
async function login(secret) { const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cdk: secret }) }); assert.equal(response.status, 200); cookie = response.headers.get("set-cookie").split(";")[0]; token = (await response.json()).token; }
async function begin(raw, extra = {}) {
  const preview = await call("/api/offers/preview", "POST", { text: raw }); assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const body = { text: raw, digest: preview.data.digest, requestKey: crypto.randomUUID(), concurrency: 3, maxRetries: 0, ...extra };
  const result = await call("/api/offers/start", "POST", body); assert.equal(result.status, 200, JSON.stringify(result.data));
  return { batch: result.data, body };
}
async function waitFor(operation) { const until = Date.now() + 20000; while (Date.now() < until) { const value = await operation(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 40)); } throw Error("isolated offer fixture timed out"); }
try {
  await startServer();
  assert.equal((await call("/api/offers/batches")).status, 401);
  const [owner, other, empty] = app.store.generate({ count: 3, quota: 1, note: "offer fixture" }, app.store.adminId);
  // Reserve all available credit without consuming it: the feature uses available balance.
  const reserved = app.store.prepareImport(empty.id, "single", ["reserved@example.com"], { email: "reserved@example.com" }, crypto.randomUUID());
  await login(empty.secret); assert.equal((await call("/api/offers/access")).status, 403); app.store.abortImport(reserved);
  await login(owner.secret);
  assert.equal((await call("/api/offers/access", "GET", null, { "x-console-token": "invalid" })).status, 403);
  const ledger = app.store.ledger(owner.id); const balance = app.store.get(owner.id).balance;
  const { batch, body } = await begin(`password@example.com----fixture-private-password\nmanual@example.com----fixture-private-password\nauto@example.com----${upstream}/mail/auto`);
  assert.equal((await call("/api/offers/start", "POST", body)).data.id, batch.id, "request retry cannot create another batch");
  const query = () => call(`/api/offers/${batch.id}/query`, "POST", {});
  let manual = await waitFor(async () => (await query()).data.items?.find((row) => row.email === "manual@example.com" && row.status === "waiting_input"));
  assert.equal((await call(`/api/offers/${batch.id}/input`, "POST", { id: manual.id, promptId: manual.promptId, value: "999999" })).status, 200);
  manual = await waitFor(async () => (await query()).data.items?.find((row) => row.id === manual.id && row.status === "waiting_input" && row.promptId !== manual.promptId));
  assert.equal((await call(`/api/offers/${batch.id}/input`, "POST", { id: manual.id, promptId: manual.promptId, value: "001234" })).status, 200);
  await waitFor(async () => (await query()).data.batch?.counts.completed === 3);
  const state = await query(); assert.equal(state.data.batch.offers, 3);
  assert.ok(state.data.items.every((row) => row.result.kind === "half_2m"));
  assert.doesNotMatch(JSON.stringify(state.data), /fixture-private-password|fixture-private-session|001234/);
  assert.equal(app.store.get(owner.id).balance, balance); assert.deepEqual(app.store.ledger(owner.id), ledger);
  const workspace = await app.workspaceFor(owner.id);
  assert.deepEqual(workspace.inventory(), [], "free detection cannot enter the charged account inventory");
  assert.equal(workspace.publicJobs().length, 0);
  assert.equal(app.store.preview(owner.id, ["password@example.com"]).charge, 1);
  const exported = await call(`/api/offers/${batch.id}/export`, "POST", { format: "accounts", filters: { kinds: ["half_2m"] } });
  assert.equal(exported.data.count, 3); assert.match(exported.data.content, /fixture-private-password/); assert.match(exported.data.filename, /\.txt$/);
  assert.equal(requests.some((route) => /oauth\/token|phone|change_email|mfa\/(disable|enroll)/.test(route)), false);
  const signins = requests.filter((route) => route === "/api/auth/signin/openai").length;
  const reused = await begin(JSON.stringify({ type: "chatgpt-session", version: 1, email: "existing@example.com", accessToken: accessToken("existing@example.com"), chatgptBase: upstream }));
  await waitFor(async () => (await call(`/api/offers/${reused.batch.id}/query`, "POST", {})).data.batch?.counts.completed === 1);
  assert.equal(requests.filter((route) => route === "/api/auth/signin/openai").length, signins, "valid imported sessions must not log in again");
  assert.equal(app.store.get(owner.id).balance, balance);
  const savedCookie = cookie; const savedToken = token;
  await login(other.secret); assert.equal((await call("/api/offers/batches")).data.batches.length, 0);
  for (const action of ["query", "export", "retry", "stop", "input", "recheck"]) assert.equal((await call(`/api/offers/${batch.id}/${action}`, "POST", {})).status, 404);
  cookie = savedCookie; token = savedToken;
  await app.close(); await startServer(); await login(owner.secret);
  assert.equal((await call(`/api/offers/${batch.id}/query`, "POST", {})).data.batch.counts.completed, 3);
  assert.equal(app.store.get(owner.id).balance, 1);
  // Explicit normal import consumes the sole credit; detection never does.
  const consumed = app.store.prepareImport(owner.id, "single", ["charged@example.com"], { email: "charged@example.com" }, crypto.randomUUID());
  app.store.finishImport(consumed, { status: 200, data: { id: "fixture-charged" } }, owner.id);
  assert.equal(app.store.get(owner.id).balance, 0);
  for (const [route, method] of [["access", "GET"], ["batches", "GET"], ["preview", "POST"], ["start", "POST"], ...["query", "export", "retry", "stop", "input", "recheck"].map((action) => [`${batch.id}/${action}`, "POST"])]) {
    const denied = await call(`/api/offers/${route}`, method, {}); assert.equal(denied.status, 403); assert.equal(denied.data.code, "OFFER_BALANCE_REQUIRED");
  }
  app.store.topup(owner.id, 1, "restore fixture", crypto.randomUUID(), app.store.adminId);
  assert.equal((await call("/api/offers/access")).status, 200);
  app.store.update(owner.id, { status: "disabled" }, app.store.adminId);
  assert.equal((await call("/api/offers/access")).status, 401);
  console.log("offer console passed (actual protocol login and session checks, automatic/manual OTP, CDK >=1 gate, zero charging, isolation, export and restart)");
} finally { await app?.close(); await new Promise((resolve) => backend.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
