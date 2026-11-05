import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import workspaceFs from "../src/workspace-storage.mjs";
import { createCredentialStore } from "../src/credential-store.mjs";
import { LEGACY_PROXY_SETTING_KEY, PROXY_POOL_SETTING_KEY, normalizeProxyPool } from "../src/proxy-pool.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-proxy-pool-console-"));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-proxy-pool-admin-only";
process.env.TOSUB2_TRUSTED_PROXIES = "127.0.0.1";
process.env.LOCALAPPDATA = path.join(root, "os-credentials");
process.env.ONBOARDING_PROTOCOL_SCRIPT = path.join(project, "test", "mock-proxy-pool-protocol.mjs");
process.env.PROXY_CONNECTION_RETRY_BASE_MS = "1";
const { createConsoleWorkspace } = await import("../src/console-server.mjs");
const { startCdkServer } = await import("../src/cdk-server.mjs");
const proxies = normalizeProxyPool([
  "http://fixture-user:fixture-private@proxy-a.example.invalid:8080",
  "socks5h://fixture-user:fixture-private@proxy-b.example.invalid:1080",
  "https://fixture-user:fixture-private@proxy-c.example.invalid:8443",
]);
const captured = new Map();
let app;
let base;

function client(ip) {
  let cookie = ""; let token = "";
  return {
    async call(url, method = "GET", body, extra = {}) {
      const response = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json", "x-forwarded-for": ip, ...(cookie ? { cookie } : {}), ...(token ? { "x-console-token": token } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const setCookie = response.headers.get("set-cookie"); if (setCookie) cookie = setCookie.split(";")[0];
      const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
      if (response.ok && data.token) token = data.token;
      return { status: response.status, data };
    },
  };
}
async function start() {
  captured.clear();
  app = await startCdkServer({ root, listen: false, createWorkspace: async (options) => {
    captured.set(options.cdkId, options);
    return createConsoleWorkspace(options);
  } });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
async function save(owner, id, value, key = PROXY_POOL_SETTING_KEY, extra = {}) {
  const response = await owner.call("/api/settings/workspace", "PUT", { workspaceId: id, settings: { [key]: typeof value === "string" ? value : JSON.stringify(value), ...extra } });
  assert.equal(response.status, 200, JSON.stringify(response.data));
}
async function login(owner, secret) {
  const response = await owner.call("/api/auth/login", "POST", { cdk: secret });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data.account.id;
}
async function credentials(id, email) {
  const options = captured.get(id);
  assert.ok(options);
  const store = createCredentialStore({ windowsRoot: path.join(options.root, ".credentials"), macRoot: path.join(options.root, ".credentials"), vault: options.credentialVault });
  return store.load(`cdk:${options.namespace}:${id}:${email}`);
}
async function metadata(id, jobId) {
  const options = captured.get(id);
  return JSON.parse(await workspaceFs.readFile(path.join(options.root, jobId, "job-meta.json"), "utf8"));
}
async function waitForMetadata(id, jobId, predicate, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  let latest;
  do {
    latest = await metadata(id, jobId);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw Error(`fixture metadata did not persist in time: ${JSON.stringify(latest)}`);
}
const cursor = (id) => structuredClone(app.store.setting(id, "proxy-pool-state"));
async function create(owner, email, requestKey, network = { useProxyPool: true }) {
  const body = { email, password: "synthetic-fixture-password", phoneBindingMode: "manual", ...network };
  const response = await owner.call("/api/jobs", "POST", body, { "idempotency-key": requestKey });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return { job: response.data.job, body };
}
async function waitFor(owner, id, predicate, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let latest;
  do {
    const response = await owner.call("/api/jobs/query", "POST", { ids: [id] });
    assert.equal(response.status, 200);
    latest = response.data.jobs.find((job) => job.id === id);
    if (latest && predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 30));
  } while (Date.now() < deadline);
  throw Error(`fixture job timed out: ${JSON.stringify(latest)}`);
}
async function proxyLogs(owner, id) {
  const response = await owner.call(`/api/jobs/${id}/logs`);
  assert.equal(response.status, 200);
  const text = response.data.logs;
  assert.equal(text.includes("fixture-private"), false);
  return [...text.matchAll(/\[fixture-proxy\] (\{[^\r\n]+\})/g)].map((match) => JSON.parse(match[1]));
}

try {
  await start();
  const admin = client("198.51.100.2"); await login(admin, process.env.TOSUB2_ADMIN_CDK);
  const generated = await admin.call("/api/admin/cdks", "POST", { count: 2, quota: 50, note: "proxy pool synthetic fixtures" });
  assert.equal(generated.status, 201);
  const [keyA, keyB] = generated.data.items;
  const ownerA = client("198.51.100.10"); const ownerB = client("198.51.100.11");
  await login(ownerA, keyA.secret); await login(ownerB, keyB.secret);
  await save(ownerA, keyA.id, proxies);
  await save(ownerB, keyB.id, proxies[2], LEGACY_PROXY_SETTING_KEY);
  assert.deepEqual((await ownerA.call("/api/settings/workspace")).data.settings[PROXY_POOL_SETTING_KEY], JSON.stringify(proxies));
  assert.equal((await ownerB.call("/api/settings/workspace")).data.settings[PROXY_POOL_SETTING_KEY], undefined);
  const previewBody = { text: "order-1@example.invalid----synthetic-fixture-password\norder-2@example.invalid----synthetic-fixture-password\norder-3@example.invalid----synthetic-fixture-password\norder-4@example.invalid----synthetic-fixture-password", useProxyPool: true, phoneBindingMode: "manual" };
  const beforePreview = cursor(keyA.id);
  const preview = await ownerA.call("/api/imports/preview", "POST", { mode: "authorization", payload: previewBody });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(cursor(keyA.id), beforePreview, "import preview must not consume a proxy");
  const batch = await ownerA.call("/api/jobs/batch", "POST", previewBody, { "idempotency-key": "ordered-fixture-batch" });
  assert.equal(batch.status, 201, JSON.stringify(batch.data));
  const batchJobs = batch.data.jobs;
  assert.equal(batchJobs.length, 4);
  for (const [index, job] of batchJobs.entries()) {
    assert.equal(job.email, `order-${index + 1}@example.invalid`);
    assert.equal((await credentials(keyA.id, job.email)).proxyUrl, proxies[index % 3]);
    const saved = await metadata(keyA.id, job.id);
    assert.equal(saved.proxy_source, "workspace");
    assert.equal(JSON.stringify(saved).includes("fixture-private"), false);
    assert.equal(saved.proxyUrl, undefined);
  }
  const beforeReplay = cursor(keyA.id);
  const replay = await ownerA.call("/api/jobs/batch", "POST", previewBody, { "idempotency-key": "ordered-fixture-batch" });
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.data.jobs.map((job) => job.id), batchJobs.map((job) => job.id));
  assert.deepEqual(cursor(keyA.id), beforeReplay, "idempotency replay must not allocate again");
  const continued = await create(ownerA, "continued@example.invalid", "continued-fixture");
  assert.equal((await credentials(keyA.id, continued.job.email)).proxyUrl, proxies[1]);
  const otherTenant = await create(ownerB, "continued@example.invalid", "other-tenant-fixture");
  assert.equal((await credentials(keyB.id, otherTenant.job.email)).proxyUrl, proxies[2], "legacy setting is a one-entry pool in a separate CDK");
  assert.deepEqual(cursor(keyA.id).workspace.nextIndex, 2);
  const beforeForge = cursor(keyA.id);
  await save(ownerA, keyA.id, proxies, PROXY_POOL_SETTING_KEY, { "proxy-pool-state": { workspace: { nextIndex: 0, revision: "forged" } } });
  assert.deepEqual(cursor(keyA.id), beforeForge, "public settings cannot overwrite the server cursor");
  assert.equal((await ownerA.call("/api/settings/workspace")).data.settings["proxy-pool-state"], undefined);
  assert.equal((await ownerA.call("/api/settings/proxy-pool-state", "PUT", { nextIndex: 0 })).status, 404);
  const persisted = cursor(keyA.id);
  await app.close(); await start();
  await login(ownerA, keyA.secret); await login(ownerB, keyB.secret);
  await ownerA.call("/api/jobs");
  assert.deepEqual(cursor(keyA.id), persisted, "server restart retains the pool cursor");
  assert.equal((await metadata(keyA.id, continued.job.id)).proxy_source, "workspace");
  assert.equal((await credentials(keyA.id, continued.job.email)).proxyUrl, proxies[1], "restored tasks keep their assigned proxy");
  const afterRestart = await create(ownerA, "after-restart@example.invalid", "after-restart-fixture");
  assert.equal((await credentials(keyA.id, afterRestart.job.email)).proxyUrl, proxies[2]);
  await save(ownerA, keyA.id, [proxies[1], proxies[0]]);
  const changed = await create(ownerA, "changed@example.invalid", "changed-fixture");
  assert.equal((await credentials(keyA.id, changed.job.email)).proxyUrl, proxies[1]);
  await save(ownerA, keyA.id, proxies);
  const changedBack = await create(ownerA, "changed-back@example.invalid", "changed-back-fixture");
  assert.equal((await credentials(keyA.id, changedBack.job.email)).proxyUrl, proxies[0]);
  await save(ownerA, keyA.id, []);
  // A stale legacy write cannot repopulate an explicitly cleared new pool.
  await save(ownerA, keyA.id, proxies[0], LEGACY_PROXY_SETTING_KEY);
  const direct = await create(ownerA, "direct@example.invalid", "direct-fixture");
  assert.equal((await credentials(keyA.id, direct.job.email)).proxyUrl, "");
  assert.deepEqual((await ownerA.call("/api/settings/workspace")).data.settings[PROXY_POOL_SETTING_KEY], "[]");
  await save(ownerA, keyA.id, proxies);
  const restoredList = await create(ownerA, "restored-list@example.invalid", "restored-list-fixture");
  assert.equal((await credentials(keyA.id, restoredList.job.email)).proxyUrl, proxies[0]);
  await ownerA.call("/api/jobs/cancel-all", "POST", {});
  await ownerB.call("/api/jobs/cancel-all", "POST", {});

  const beforeInvalidPhone = cursor(keyA.id);
  const invalidPhoneSingle = await ownerA.call("/api/jobs", "POST", { email: "invalid-phone-single@example.invalid", useProxyPool: true, phoneBindingMode: "invalid" }, { "idempotency-key": "invalid-phone-single-fixture" });
  assert.equal(invalidPhoneSingle.status, 400);
  const invalidPhoneBatch = await ownerA.call("/api/jobs/batch", "POST", { text: "invalid-phone-batch@example.invalid----synthetic-password", useProxyPool: true, phoneBindingMode: "invalid" }, { "idempotency-key": "invalid-phone-batch-fixture" });
  assert.equal(invalidPhoneBatch.status, 400);
  assert.deepEqual(cursor(keyA.id), beforeInvalidPhone, "invalid phone policy must not consume a pool slot");

  const checkpointPath = path.join(captured.get(keyA.id).root, continued.job.id, "login-checkpoint.json");
  const checkpoint = { version: 1, stage: "email_verified", email: continued.job.email, updated_at: new Date().toISOString(), cookies: [] };
  await workspaceFs.writeFile(checkpointPath, JSON.stringify(checkpoint), { mode: 0o600 });
  const originalCheckpointProxy = (await credentials(keyA.id, continued.job.email)).proxyUrl;
  const beforeSingleResume = cursor(keyA.id);
  const singleResume = await ownerA.call(`/api/jobs/${continued.job.id}/retry`, "POST", { useProxyPool: true });
  assert.equal(singleResume.status, 200, JSON.stringify(singleResume.data));
  await waitFor(ownerA, continued.job.id, (job) => job.status === "email_otp");
  assert.deepEqual(cursor(keyA.id), beforeSingleResume, "resuming one verified checkpoint must retain the cursor");
  assert.equal((await credentials(keyA.id, continued.job.email)).proxyUrl, originalCheckpointProxy);
  assert.deepEqual(JSON.parse(await workspaceFs.readFile(checkpointPath, "utf8")), checkpoint);
  const checkpointLogs = (await ownerA.call(`/api/jobs/${continued.job.id}/logs`)).data.logs;
  assert.match(checkpointLogs, /\[fixture-checkpoint\].*"stage":"email_verified"/);
  await ownerA.call(`/api/jobs/${continued.job.id}/cancel`, "POST", {});

  await save(ownerA, keyA.id, [proxies[2], proxies[0], proxies[1]]);
  const mixed = await ownerA.call("/api/jobs/reauthorize-batch", "POST", {
    ids: [changedBack.job.id, continued.job.id, changed.job.id, restoredList.job.id], useProxyPool: true,
  });
  assert.equal(mixed.status, 200, JSON.stringify(mixed.data));
  assert.equal((await credentials(keyA.id, changedBack.job.email)).proxyUrl, proxies[2]);
  assert.equal((await credentials(keyA.id, continued.job.email)).proxyUrl, originalCheckpointProxy, "a checkpoint in a mixed batch keeps its original exit");
  assert.equal((await credentials(keyA.id, changed.job.email)).proxyUrl, proxies[0]);
  assert.equal((await credentials(keyA.id, restoredList.job.email)).proxyUrl, proxies[1]);
  assert.equal(cursor(keyA.id).workspace.nextIndex, 0, "only the three fresh flows consume slots, in selection order");
  await ownerA.call("/api/jobs/cancel-all", "POST", {});

  await save(ownerA, keyA.id, [proxies[0], proxies[1]]);
  const switching = await create(ownerA, "pool-switch-once@example.invalid", "switch-once-fixture");
  await waitFor(ownerA, switching.job.id, (job) => job.status === "email_otp");
  assert.deepEqual((await proxyLogs(ownerA, switching.job.id)).map((entry) => entry.host), ["proxy-a.example.invalid", "proxy-b.example.invalid"]);
  assert.equal((await credentials(keyA.id, switching.job.email)).proxyUrl, proxies[1]);
  await ownerA.call(`/api/jobs/${switching.job.id}/cancel`, "POST", {});

  // Saving a changed list resets the sequence before each bounded failure test.
  await save(ownerA, keyA.id, [proxies[1], proxies[0]]);
  const blocked = await create(ownerA, "pool-risk-always@example.invalid", "risk-always-fixture");
  await waitFor(ownerA, blocked.job.id, (job) => ["failed", "reauth_required"].includes(job.status));
  const blockedAttempts = await proxyLogs(ownerA, blocked.job.id);
  assert.equal(blockedAttempts.length, 10, "HTTP security failures stop after ten attempted exits");
  assert.ok(blockedAttempts.every((entry) => entry.poolEnabled));
  assert.deepEqual(blockedAttempts.map((entry) => entry.host), Array.from({ length: 10 }, (_, index) => index % 2 ? "proxy-a.example.invalid" : "proxy-b.example.invalid"));
  const blockedMetadata = await waitForMetadata(keyA.id, blocked.job.id, (saved) => saved.proxy_risk_retry_count === 10);
  assert.equal(blockedMetadata.proxy_risk_retry_count, 10);
  await save(ownerA, keyA.id, [proxies[0], proxies[1]]);
  const disconnected = await create(ownerA, "pool-connect-always@example.invalid", "connect-always-fixture");
  await waitFor(ownerA, disconnected.job.id, (job) => ["failed", "reauth_required"].includes(job.status));
  assert.equal((await proxyLogs(ownerA, disconnected.job.id)).length, 20, "connection failures stop after twenty attempts");
  const connectionMetadata = await waitForMetadata(keyA.id, disconnected.job.id, (saved) => saved.proxy_connection_failure_count === 20);
  assert.equal(connectionMetadata.proxy_risk_retry_count, 0);
  assert.equal(connectionMetadata.proxy_connection_failure_count, 20);
  console.log("proxy pool console passed (API configuration, isolation, preview, order, idempotency, restart, direct mode and bounded fixed-proxy failover; synthetic protocol only)");
} finally {
  await app?.close();
  await fs.rm(root, { recursive: true, force: true });
}
