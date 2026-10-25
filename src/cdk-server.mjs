import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCdkStore } from "./cdk-store.mjs";
import { createCdkVault } from "./cdk-vault.mjs";
import { acquireCdkLock } from "./cdk-lock.mjs";
import { cdkError, clientIp, normalizeClientIp, readRequestJson, requireSameOrigin } from "./cdk-security.mjs";
import { createSmsPool } from "./sms-pool.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cookieName = "tosub2_session";

function send(res, status, value) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(value));
}

function argument(name, fallback) {
  const inline = process.argv.find((item) => item.startsWith(`--${name}=`));
  const index = process.argv.indexOf(`--${name}`);
  return inline ? inline.slice(name.length + 3) : index >= 0 ? process.argv[index + 1] : fallback;
}

function cookie(req) {
  const entry = String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
  if (!entry) return null;
  try { return decodeURIComponent(entry.slice(cookieName.length + 1)); } catch { return null; }
}

async function legacyEmails(root) {
  const emails = new Set();
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries.filter((entry) => entry.isDirectory() && ![".cdk", "cdk"].includes(entry.name))) {
    if (entry.name === "mfa") {
      const data = await fs.readFile(path.join(root, "mfa", "accounts.json"), "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; });
      for (const account of data?.accounts || []) if (account.email) emails.add(account.email.toLowerCase());
    } else {
      for (const filename of ["job-meta.json", "sub2api-import-oauth.json"]) {
        const data = await fs.readFile(path.join(root, entry.name, filename), "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; });
        const email = data?.email || data?.accounts?.[0]?.credentials?.email || data?.accounts?.[0]?.name;
        if (typeof email === "string" && email.includes("@")) emails.add(email.toLowerCase());
      }
    }
  }
  return emails;
}

export async function startCdkServer({ createWorkspace, root = process.env.ONBOARDING_OUTPUT_ROOT || path.join(projectRoot, "tmp", "chatgpt-onboarding-console"), listen = true, smsPoolOptions = {} } = {}) {
  root = path.resolve(root); await fs.mkdir(root, { recursive: true });
  const processLock = await acquireCdkLock(root);
  let cleanupFailedStart = async () => {};
  try {
  const vault = await createCdkVault(root); const store = await createCdkStore(root, vault);
  const smsPool = createSmsPool({ store, ...smsPoolOptions });
  const namespace = crypto.createHash("sha256").update(root).digest("hex");
  const workspaces = new Map(); const creating = new Map(); const importing = new Map();
  const recoveryLocked = new Set();
  const trustedProxies = String(process.env.TOSUB2_TRUSTED_PROXIES || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (trustedProxies.some((address) => !normalizeClientIp(address))) throw new Error("TOSUB2_TRUSTED_PROXIES 需要有效的明确 IP 地址列表");
  let shuttingDown = false; let acceptingWork = false; let cursor = 0; let server; let queueTimer; let cleanupTimer;
  cleanupFailedStart = async () => {
    shuttingDown = true; clearInterval(queueTimer); clearInterval(cleanupTimer);
    if (server?.listening) await new Promise((resolve) => { server.close(resolve); server.closeIdleConnections?.(); });
    await Promise.allSettled([...creating.values()]); await Promise.allSettled([...workspaces.values()].map((workspace) => workspace.shutdown())); await smsPool.close(); store.close();
  };
  const initialLegacyEmails = await legacyEmails(root);
  let globalSlots = 20;
  const availableSlots = () => globalSlots;
  let scheduling = false;
  function scheduleAll() {
    const list = [...workspaces.values()]; if (!list.length || shuttingDown) return;
    globalSlots = Math.max(0, 20 - list.reduce((total, workspace) => total + workspace.activeCount(), 0));
    cursor = (cursor + 1) % list.length;
    for (let round = 0; round < 20 && availableSlots() > 0; round += 1) {
      let started = 0;
      for (let offset = 0; offset < list.length && availableSlots() > 0; offset += 1) {
        const count = list[(cursor + offset) % list.length].tick() || 0; globalSlots -= count; started += count;
      }
      if (!started) break;
    }
  }
  function requestSchedule() { if (scheduling) return; scheduling = true; setImmediate(() => { scheduling = false; scheduleAll(); }); }

  async function workspaceFor(id) {
    const cdk = store.get(id); if (!cdk) throw cdkError(404, "工作区不存在");
    if (workspaces.has(id)) return workspaces.get(id);
    if (creating.has(id)) return creating.get(id);
    const promise = (async () => {
      const workspaceRoot = id === store.adminId ? root : path.join(root, "cdk", id);
      const workspace = await createWorkspace({
        root: workspaceRoot, cdkId: id, namespace, legacyEmails: id === store.adminId ? initialLegacyEmails : new Set(),
        smsPool: smsPool.forOwner(id),
        rebindVault: { seal: (value, scope) => vault.seal(value, `rebind:${id}:${scope}`), open: (value, scope) => vault.open(value, `rebind:${id}:${scope}`) },
        legacyUsed: (email) => store.legacyUsed(id, email),
        markLegacyUsed: (email) => store.markLegacyUsed(id, email),
        isEnabled: () => acceptingWork && !shuttingDown && store.get(id)?.status === "active",
        availableSlots,
        requestSchedule,
        async readMonitor() {
          const existing = store.setting(id, "monitor"); if (existing) return existing;
          if (id !== store.adminId) return null;
          const legacy = await fs.readFile(path.join(root, "sub2api-monitor.json"), "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
          if (!legacy || legacy.migratedToCdk) return null;
          legacy.enabled = false; store.saveSetting(id, "monitor", legacy);
          await fs.writeFile(path.join(root, "sub2api-monitor.json"), JSON.stringify({ migratedToCdk: true }), { mode: 0o600 });
          return legacy;
        },
        writeMonitor: async (value) => store.saveSetting(id, "monitor", value),
        remoteBound: (backend, remoteId) => store.remoteBound(id, backend, remoteId),
        bindRemote: (backend, remoteId, email) => store.bindRemote(id, backend, remoteId, email),
        fingerprint: vault.fingerprint,
      });
      workspaces.set(id, workspace);
      const pending = store.pendingImports().some((record) => record.cdk_id === id);
      if (!pending) { store.inventory(id, workspace.inventory()); if (cdk.status === "active") workspace.resume(); }
      return workspace;
    })();
    creating.set(id, promise);
    try { return await promise; } finally { creating.delete(id); }
  }

  async function importFor(id, mode, body, requestKey, actor) {
    const previous = importing.get(id) || Promise.resolve();
    let release; const gate = new Promise((resolve) => { release = resolve; }); importing.set(id, gate);
    await previous;
    let workspace; let record; let applied = false;
    try {
      workspace = await workspaceFor(id); workspace.pause();
      const prior = store.findImport(id, mode, body, requestKey);
      if (prior?.status === "completed") return JSON.parse(prior.result);
      const pending = store.pendingImports().filter((item) => item.cdk_id === id);
      if (pending.length && (!prior || prior.status !== "pending")) {
        recoveryLocked.add(id);
        throw cdkError(409, "工作区有待恢复的导入，请先完成原导入，不能提交新的导入");
      }
      const emails = workspace.planImport(mode, body);
      record = store.prepareImport(id, mode, emails, body, requestKey, actor);
      if (record.status === "completed") return JSON.parse(record.result);
      const response = await workspace.applyImport(mode, body, record.actor_id || actor);
      applied = true;
      const completed = store.finishImport(record, response, actor);
      if (!store.pendingImports().some((item) => item.cdk_id === id)) recoveryLocked.delete(id);
      return completed;
    } catch (error) {
      if (record?.status === "pending" && (error.importRolledBack || error.importUpdateOnly && record.charge === 0) && !applied) store.abortImport(record);
      else if (record?.status === "pending") recoveryLocked.add(id);
      throw error;
    } finally {
      if (store.pendingImports().some((item) => item.cdk_id === id)) recoveryLocked.add(id); else recoveryLocked.delete(id);
      if (!recoveryLocked.has(id)) workspace?.resume(); release(); if (importing.get(id) === gate) importing.delete(id);
    }
  }

  await workspaceFor(store.adminId);
  for (const record of store.pendingImports()) {
    const workspace = await workspaceFor(record.cdk_id); workspace.pause();
    if (store.get(record.cdk_id)?.status !== "active") continue;
    try {
      const result = await workspace.applyImport(record.mode, store.importPayload(record), record.actor_id || "recovery");
      store.finishImport(record, result, "recovery"); workspace.resume();
    } catch {
      recoveryLocked.add(record.cdk_id);
      console.error("[cdk] An import requires recovery; its workspace remains paused. Inspect the admin import recovery view.");
    }
  }
  for (const record of store.rawIds()) {
    if (record.id === store.adminId || record.status !== "active") continue;
    const folder = path.join(root, "cdk", record.id);
    try { await fs.access(folder); await workspaceFor(record.id); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  function authenticated(req) {
    const session = store.session(cookie(req));
    if (!session) throw cdkError(401, "请验证 CDK 后继续", "AUTH_REQUIRED");
    if (!["GET", "HEAD"].includes(req.method) || req.headers["x-console-token"] !== undefined) {
      const supplied = String(req.headers["x-console-token"] || "");
      if (!/^[A-Za-z0-9_-]+$/.test(supplied) || Buffer.byteLength(supplied) !== Buffer.byteLength(session.csrf) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(session.csrf))) throw cdkError(403, "页面验证已失效，请刷新后重试", "CSRF_INVALID");
    }
    return session;
  }

  async function bootstrap(session) {
    const workspace = await workspaceFor(session.workspace.id);
    const response = await workspace.dispatch("GET", "/api/bootstrap");
    const original = JSON.parse(response.body.toString());
    return { authenticated: true, token: session.csrf, account: store.get(session.actor.id), workspace: store.get(session.workspace.id), settings: store.setting(session.workspace.id, "workspace") || {}, features: { ...original.features, cdk: true, admin: session.actor.role === "admin" } };
  }

  function sessionCookie(req, value, expired = false) {
    const direct = normalizeClientIp(req.socket?.remoteAddress);
    const secure = Boolean(req.socket?.encrypted) || trustedProxies.map(normalizeClientIp).includes(direct) && req.headers["x-forwarded-proto"] === "https";
    return `${cookieName}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${expired ? 0 : 86400}${secure ? "; Secure" : ""}`;
  }

  async function api(req, res, url, ip) {
    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      const attempt = store.checkVerification(ip); const body = await readRequestJson(req); const cdk = store.authenticate(body.cdk);
      if (!cdk) {
        store.failedVerification(ip, "login", String(body.cdk || "").slice(0, 200), attempt);
        const blocked = store.activeBan(ip);
        if (blocked) { send(res, 403, { error: "验证失败次数过多，当前 IP 已临时封禁", code: "IP_BLOCKED", expiresAt: blocked.expires_at ? new Date(blocked.expires_at).toISOString() : null }); return; }
        throw cdkError(401, "CDK 无效或不可用", "INVALID_CDK");
      }
      store.rememberSecret(cdk.id, body.cdk);
      const created = store.createSession(cdk.id); res.setHeader("set-cookie", sessionCookie(req, created.secret));
      send(res, 200, await bootstrap(store.session(created.secret))); return;
    }
    if (url.pathname === "/api/bootstrap" && req.method === "GET") {
      const session = store.session(cookie(req)); send(res, 200, session ? await bootstrap(session) : { authenticated: false, features: { cdk: true } }); return;
    }
    const session = authenticated(req); const actor = session.actor.id; const owner = session.workspace.id;
    req.actorId = actor;
    const writeScopedHead = res.writeHead;
    res.writeHead = function (...args) {
      const cdk = store.get(owner);
      if (cdk) { this.setHeader("x-cdk-id", owner); this.setHeader("x-cdk-balance", String(cdk.balance)); this.setHeader("x-cdk-reserved", String(cdk.reserved)); }
      return writeScopedHead.apply(this, args);
    };
    if (url.pathname === "/api/sms-pool" && req.method === "GET") { send(res, 200, smsPool.publicSummary()); return; }
    if (url.pathname === "/api/auth/me" && req.method === "GET") { send(res, 200, await bootstrap(session)); return; }
    if (url.pathname === "/api/auth/logout" && req.method === "POST") { store.logout(session); res.setHeader("set-cookie", sessionCookie(req, "", true)); send(res, 200, { ok: true }); return; }
    if (url.pathname === "/api/auth/workspace" && req.method === "POST") {
      const body = await readRequestJson(req); const csrf = store.switchWorkspace(session, String(body.cdkId || actor));
      const updated = store.session(cookie(req)); updated.csrf = csrf; send(res, 200, await bootstrap(updated)); return;
    }
    if (url.pathname === "/api/settings/workspace") {
      if (req.method === "GET") send(res, 200, { settings: store.setting(owner, "workspace") || {} });
      else if (req.method === "PUT") {
        const body = await readRequestJson(req);
        if (body.workspaceId !== owner) throw cdkError(409, "工作区已变化，请重新加载配置");
        const allowed = new Set(["chatgpt-onboarding.sms-provider-settings-v1", "chatgpt-onboarding.mail-request-settings-v1", "chatgpt-onboarding.sub2api-upload-settings-v1", "chatgpt-onboarding.account-proxy-v1", "chatgpt-onboarding.luban-api-key", "chatgpt-onboarding.luban-service-id"]);
        const settings = Object.fromEntries(Object.entries(body.settings || {}).filter(([key]) => allowed.has(key)));
        store.saveSetting(owner, "workspace", settings); send(res, 200, { ok: true });
      } else throw cdkError(405, "请求方法不支持");
      return;
    }
    if (url.pathname === "/api/cdk/ledger" && req.method === "GET") { send(res, 200, { cdk: store.get(owner), items: store.ledger(owner) }); return; }
    if (url.pathname === "/api/cdk/reveal" && req.method === "POST") {
      const body = await readRequestJson(req);
      if (Object.hasOwn(body, "cdk")) {
        const attempt = store.checkVerification(ip);
        const verified = store.authenticate(body.cdk);
        if (!verified || verified.id !== owner) {
          store.failedVerification(ip, "current-cdk", String(body.cdk || "").slice(0, 200), attempt);
          throw cdkError(400, "CDK 无效或不属于当前工作区", "INVALID_CURRENT_CDK");
        }
        store.rememberSecret(owner, body.cdk);
      }
      send(res, 200, { cdkId: owner, secret: store.revealSecret(owner, actor) }); return;
    }
    if (["/api/cdk/merge-preview", "/api/cdk/merge"].includes(url.pathname) && req.method === "POST") {
      if (session.actor.id !== owner) throw cdkError(403, "请切回自己的 CDK 后融合次数");
      const attempt = store.checkVerification(ip); const body = await readRequestJson(req);
      try {
        if (url.pathname.endsWith("merge-preview")) send(res, 200, store.mergePreview(owner, body.sourceCdk));
        else { const result = store.merge(owner, body.sourceCdk, body.requestKey, body.fingerprint, body.amount); send(res, 200, result); }
      } catch (error) { if (error.code === "INVALID_CDK") store.failedVerification(ip, "merge", String(body.sourceCdk || "").slice(0, 200), attempt); throw error; }
      return;
    }
    if (url.pathname.startsWith("/api/admin/")) {
      if (session.actor.role !== "admin") throw cdkError(403, "需要管理员权限");
      if (url.pathname === "/api/admin/sms-pool" && req.method === "GET") { send(res, 200, smsPool.adminSnapshot()); return; }
      if (url.pathname === "/api/admin/sms-pool/rules" && req.method === "PUT") { send(res, 200, smsPool.saveRules(await readRequestJson(req), actor)); return; }
      if (url.pathname === "/api/admin/sms-pool/buffer/warmup" && req.method === "POST") {
        send(res, 200, await smsPool.warmup(actor));
        return;
      }
      if (url.pathname === "/api/admin/sms-pool/buffer/drain" && req.method === "POST") {
        send(res, 200, await smsPool.drain(actor));
        return;
      }
      const inventoryReconcileMatch = /^\/api\/admin\/sms-pool\/inventory\/([a-f0-9-]+)\/reconcile$/.exec(url.pathname);
      if (inventoryReconcileMatch && req.method === "POST") {
        send(res, 200, smsPool.reconcileInventory(inventoryReconcileMatch[1], await readRequestJson(req), actor));
        return;
      }
      if (url.pathname === "/api/admin/sms-pool/credentials" && req.method === "POST") { send(res, 200, smsPool.saveCredential(await readRequestJson(req), actor)); return; }
      const poolCredentialMatch = /^\/api\/admin\/sms-pool\/credentials\/([a-f0-9-]+)(?:\/(options))?$/.exec(url.pathname);
      if (poolCredentialMatch && req.method === "POST" && poolCredentialMatch[2] === "options") { send(res, 200, await smsPool.credentialOptions(poolCredentialMatch[1], await readRequestJson(req), actor)); return; }
      if (poolCredentialMatch && req.method === "PATCH" && !poolCredentialMatch[2]) { send(res, 200, smsPool.saveCredential({ ...await readRequestJson(req), id: poolCredentialMatch[1] }, actor)); return; }
      if (url.pathname === "/api/admin/sms-pool/entries" && req.method === "POST") { send(res, 200, smsPool.saveEntries(await readRequestJson(req), actor)); return; }
      if (url.pathname === "/api/admin/sms-pool/operations" && req.method === "GET") {
        send(res, 200, smsPool.operationsPage(Object.fromEntries(url.searchParams)));
        return;
      }
      const poolEntryMatch = /^\/api\/admin\/sms-pool\/entries\/([a-f0-9-]+)$/.exec(url.pathname);
      if (poolEntryMatch && req.method === "PATCH") { send(res, 200, smsPool.patchEntry(poolEntryMatch[1], await readRequestJson(req), actor)); return; }
      const poolReconcileMatch = /^\/api\/admin\/sms-pool\/operations\/([a-zA-Z0-9_-]+)\/reconcile$/.exec(url.pathname);
      if (poolReconcileMatch && req.method === "POST") {
        const body = await readRequestJson(req);
        const result = smsPool.reconcile(poolReconcileMatch[1], body, actor);
        const ownerId = body.cdkId || result.operations.find((item) => item.operationId === poolReconcileMatch[1])?.cdkId;
        if (ownerId) {
          try { await workspaces.get(ownerId)?.refreshPoolStatus?.(); }
          catch { console.warn("[sms-pool] Settlement was saved; workspace status will refresh on its next request."); }
        }
        send(res, 200, result);
        return;
      }
      const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readRequestJson(req) : {};
      if (url.pathname === "/api/admin/cdks") {
        if (req.method === "GET") send(res, 200, { items: store.list() });
        else if (req.method === "POST") send(res, 201, { items: store.generate(body, actor) });
        else throw cdkError(405, "请求方法不支持");
        return;
      }
      const cdkMatch = /^\/api\/admin\/cdks\/([a-f0-9-]+)(?:\/(topups|rotate|ledger))?$/.exec(url.pathname);
      if (cdkMatch) {
        const id = cdkMatch[1]; const action = cdkMatch[2];
        if (req.method === "GET" && action === "ledger") send(res, 200, { cdk: store.get(id), items: store.ledger(id) });
        else if (req.method === "PATCH" && !action) { const result = store.update(id, body, actor); if (result.status === "disabled") await workspaces.get(id)?.stop(); else workspaces.get(id)?.resume(); send(res, 200, result); }
        else if (req.method === "POST" && action === "topups") send(res, 200, store.topup(id, body.amount, body.note, body.requestKey, actor));
        else if (req.method === "POST" && action === "rotate") send(res, 200, store.rotate(id, actor));
        else throw cdkError(405, "请求方法不支持");
        return;
      }
      if (url.pathname === "/api/admin/ledger" && req.method === "GET") { send(res, 200, { items: store.ledger() }); return; }
      if (url.pathname === "/api/admin/tasks" && req.method === "GET") {
        const items = []; for (const cdk of store.list()) { const workspace = await workspaceFor(cdk.id); items.push(...workspace.publicJobs().map((job) => ({ ...job, cdkId: cdk.id, cdkLabel: cdk.label }))); }
        send(res, 200, { items }); return;
      }
      if (url.pathname === "/api/admin/imports" && req.method === "GET") { send(res, 200, { items: store.pendingImports().map((record) => ({ id: record.id, cdkId: record.cdk_id, mode: record.mode, charge: record.charge, createdAt: new Date(record.created_at).toISOString() })) }); return; }
      const retryImport = /^\/api\/admin\/imports\/([a-f0-9-]+)\/retry$/.exec(url.pathname);
      if (retryImport && req.method === "POST") {
        const record = store.pendingImports().find((item) => item.id === retryImport[1]);
        if (!record) throw cdkError(404, "待恢复导入不存在");
        const result = await importFor(record.cdk_id, record.mode, store.importPayload(record), record.request_key, actor); send(res, 200, result.data); return;
      }
      if (url.pathname === "/api/admin/security/events" && req.method === "GET") { send(res, 200, { items: store.events() }); return; }
      if (url.pathname === "/api/admin/security/events" && req.method === "PATCH") { store.readEvent(body.id, actor); send(res, 200, { ok: true }); return; }
      if (url.pathname === "/api/admin/security/ip-bans") {
        if (req.method === "GET") send(res, 200, { items: store.bans() });
        else if (req.method === "POST") { const id = store.ban(body.ip, body.minutes === null ? null : body.minutes, body.reason, actor); send(res, 201, { id }); }
        else throw cdkError(405, "请求方法不支持");
        return;
      }
      const revoke = /^\/api\/admin\/security\/ip-bans\/([a-f0-9-]+)\/revoke$/.exec(url.pathname);
      if (revoke && req.method === "POST") { store.unban(revoke[1], actor); send(res, 200, { ok: true }); return; }
      if (url.pathname === "/api/admin/security/rules") {
        if (req.method === "GET") send(res, 200, store.rules());
        else if (req.method === "PUT") send(res, 200, store.setRules(body, actor));
        else throw cdkError(405, "请求方法不支持");
        return;
      }
      throw cdkError(404, "管理接口不存在");
    }
    const workspace = await workspaceFor(owner);
    if (url.pathname === "/api/sub2api/bind" && req.method === "POST") {
      const body = await readRequestJson(req);
      const stored = store.setting(owner, "workspace") || {};
      const value = stored["chatgpt-onboarding.sub2api-upload-settings-v1"];
      let config; try { config = typeof value === "string" ? JSON.parse(value) : value; } catch { throw cdkError(422, "请先保存 Sub2API 配置"); }
      await workspace.bindRemote(body.remoteId, body.email, config); send(res, 200, { ok: true }); return;
    }
    if (url.pathname === "/api/imports/preview" && req.method === "POST") {
      const body = await readRequestJson(req); const mode = ["single", "authorization", "mfa", "rebind"].includes(body.mode) ? body.mode : "authorization";
      const emails = workspace.planImport(mode, body.payload || {}); send(res, 200, store.preview(owner, emails)); return;
    }
    const importMode = req.method === "POST" && ({ "/api/jobs": "single", "/api/jobs/batch": "authorization", "/api/mfa/import": "mfa", "/api/rebind/sync": "rebind" })[url.pathname];
    if (importMode) {
      const body = await readRequestJson(req); const result = await importFor(owner, importMode, body, String(req.headers["idempotency-key"] || body.requestKey || ""), actor);
      res.setHeader("x-cdk-balance", String(store.get(owner).balance)); send(res, result.status, result.data); return;
    }
    if (!["GET", "HEAD"].includes(req.method)) req.jsonBody = await readRequestJson(req);
    if (!["GET", "HEAD"].includes(req.method) && (importing.has(owner) || recoveryLocked.has(owner))) throw cdkError(409, "此工作区正在导入或恢复，请稍后再操作");
    if (url.pathname === "/api/jobs/delete-batch") {
      const response = await workspace.dispatch(req.method, url.pathname, req.jsonBody, actor);
      if (response.status < 400) store.syncInventory(owner, workspace.inventory());
      res.writeHead(response.status, response.headers); res.end(response.body); return;
    }
    await workspace.handle(req, res, url);
  }

  async function staticPage(req, res, url) {
    if (!["GET", "HEAD"].includes(req.method)) throw cdkError(405, "请求方法不支持");
    const directory = path.join(projectRoot, "web", "dist");
    let pathname; try { pathname = decodeURIComponent(url.pathname); } catch { throw cdkError(400, "路径格式错误"); }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(directory, relative);
    if (path.relative(directory, target).startsWith("..") || path.isAbsolute(path.relative(directory, target))) throw cdkError(404, "页面不存在");
    let data;
    try { data = await fs.readFile(target); } catch (error) { if (error.code !== "ENOENT") throw error; if (relative === "index.html") throw cdkError(503, "前端尚未构建，请先运行 npm run build"); throw cdkError(404, "页面不存在"); }
    const mime = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" }[path.extname(target)] || "application/octet-stream";
    res.writeHead(200, { "content-type": mime, "cache-control": relative === "index.html" ? "no-store" : "public,max-age=3600" }); res.end(req.method === "HEAD" ? undefined : data);
  }

  server = http.createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff"); res.setHeader("x-frame-options", "DENY"); res.setHeader("referrer-policy", "same-origin");
    try {
      const url = new URL(req.url || "/", "http://console.internal");
      if (url.pathname === "/api/health") { send(res, 200, { ok: true }); return; }
      const ip = clientIp(req, trustedProxies); const ban = store.activeBan(ip);
      if (ban) { send(res, 403, { error: "当前 IP 已被封禁，请联系管理员或等待解除", code: "IP_BLOCKED", expiresAt: ban.expires_at ? new Date(ban.expires_at).toISOString() : null }); return; }
      requireSameOrigin(req, process.env.TOSUB2_PUBLIC_ORIGIN ? [process.env.TOSUB2_PUBLIC_ORIGIN] : []);
      if (url.pathname.startsWith("/api/")) await api(req, res, url, ip); else await staticPage(req, res, url);
    } catch (error) { send(res, error.status || 500, { error: error.status ? error.message : "请求未完成，请检查服务状态", code: error.code || "" }); if (!error.status) console.error("[cdk] Request failed:", error.constructor?.name || "Error", String(error.stack || "").split("\n").slice(1, 5).join("\n")); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  queueTimer = setInterval(scheduleAll, 150); queueTimer.unref();
  cleanupTimer = setInterval(() => store.cleanup(), 60000); cleanupTimer.unref();
  if (listen) {
    const host = String(argument("host", process.env.ONBOARDING_HOST || "127.0.0.1")); const port = Number(argument("port", process.env.ONBOARDING_PORT || 4399));
    if (!host || host.startsWith("--") || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("监听地址或端口无效");
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
    console.log(`[ok] CDK console listening on ${host}:${port}`); console.log("[info] Initial administrator CDK: node src/cdk-admin.mjs initial (local operator only)");
  }
  acceptingWork = true; smsPool.start?.(); requestSchedule();
  let closing;
  const close = () => closing ||= (async () => {
    shuttingDown = true; clearInterval(queueTimer); clearInterval(cleanupTimer);
    smsPool.pause?.();
    const closed = server.listening ? new Promise((resolve) => { server.close(resolve); server.closeIdleConnections?.(); }) : Promise.resolve();
    await Promise.allSettled([...creating.values(), ...importing.values()]);
    await Promise.allSettled([...workspaces.values()].map((workspace) => workspace.shutdown()));
    await smsPool.close();
    let timer; await Promise.race([closed, new Promise((resolve) => { timer = setTimeout(() => { server.closeAllConnections?.(); resolve(); }, 3000); })]); clearTimeout(timer);
    store.close(); await processLock.close();
  })();
  if (listen) {
    const terminate = () => void close().catch(() => { process.exitCode = 1; }); process.once("SIGINT", terminate); process.once("SIGTERM", terminate);
    if (process.send) process.on("message", (message) => {
      if (message === "shutdown" || message?.type === "tosub2:shutdown") void close().then(() => { if (process.connected) process.disconnect(); }).catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
    });
  }
  return { server, store, workspaceFor, close, importFor, smsPool };
  } catch (error) { await cleanupFailedStart(); await processLock.close(); throw error; }
}
