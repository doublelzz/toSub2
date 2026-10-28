import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cdkError, normalizeClientIp, positiveInteger, randomSecret, secretHash } from "./cdk-security.mjs";
import { poolCostOrder, summarizePoolCosts, poolCostFilters, matchesPoolCost, poolCostAnalytics } from "./sms-pool-costs.mjs";

const DEFAULT_RULES = { ratePerMinute: 30, warnFailures: 5, banFailures: 10, failureWindowMinutes: 10, banMinutes: 30, escalationCount: 3, escalationHours: 24, retentionDays: 30 };
export const CDK_SMS_PROVIDER_IDS = ["custom", "luban", "smsbower", "herosms", "pool"];
const normalizeSmsPermissions = (value) => {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !CDK_SMS_PROVIDER_IDS.includes(id))) throw cdkError(422, "接码方式权限格式不正确");
  return CDK_SMS_PROVIDER_IDS.filter((id) => id === "custom" || value.includes(id));
};

export async function createCdkStore(root, vault) {
  const directory = path.join(root, ".cdk");
  const databasePath = path.join(directory, "cdk.sqlite");
  let existed = true;
  try { await fs.access(databasePath); } catch { existed = false; }
  if (!existed) {
    try { await fs.access(path.join(directory, "database.marker")); throw new Error("CDK 数据库缺失，请恢复原数据库后启动"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const entries = await fs.readdir(path.join(root, "cdk")).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    if (entries.length) throw new Error("CDK 数据库缺失但已有用户工作区，请恢复数据库备份后启动");
  }
  const db = new DatabaseSync(databasePath);
  await fs.chmod(databasePath, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace_documents (cdk_id TEXT NOT NULL REFERENCES cdks(id),name TEXT NOT NULL,payload TEXT NOT NULL,mtime REAL NOT NULL,PRIMARY KEY(cdk_id,name));
    CREATE TABLE IF NOT EXISTS cdks (id TEXT PRIMARY KEY,secret_hash TEXT UNIQUE NOT NULL,label TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','user')),status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','merged')),balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0),reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=balance),consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed>=0),ever_consumed INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,note TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,last_login INTEGER,merged_into TEXT REFERENCES cdks(id));
    CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY,cdk_id TEXT NOT NULL REFERENCES cdks(id),workspace_id TEXT NOT NULL REFERENCES cdks(id),csrf TEXT NOT NULL,version INTEGER NOT NULL,created_at INTEGER NOT NULL,last_seen INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (cdk_id TEXT NOT NULL REFERENCES cdks(id),email TEXT NOT NULL,created_at INTEGER NOT NULL,deleted_at INTEGER,PRIMARY KEY(cdk_id,email));
    CREATE TABLE IF NOT EXISTS legacy_credentials (cdk_id TEXT NOT NULL REFERENCES cdks(id),email TEXT NOT NULL,used_at INTEGER NOT NULL,PRIMARY KEY(cdk_id,email));
    CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY,cdk_id TEXT NOT NULL REFERENCES cdks(id),request_key TEXT NOT NULL,digest TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,charge INTEGER NOT NULL,emails TEXT NOT NULL,payload TEXT,result TEXT,created_at INTEGER NOT NULL,UNIQUE(cdk_id,request_key));
    CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY,cdk_id TEXT NOT NULL REFERENCES cdks(id),kind TEXT NOT NULL,delta INTEGER NOT NULL,balance INTEGER NOT NULL,reference TEXT,note TEXT NOT NULL,actor TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(cdk_id,kind,reference));
    CREATE TABLE IF NOT EXISTS merges (id TEXT PRIMARY KEY,source_id TEXT UNIQUE NOT NULL REFERENCES cdks(id),target_id TEXT NOT NULL REFERENCES cdks(id),amount INTEGER NOT NULL,request_key TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(target_id,request_key));
    CREATE TABLE IF NOT EXISTS settings (cdk_id TEXT NOT NULL REFERENCES cdks(id),name TEXT NOT NULL,value TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(cdk_id,name));
    CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS security_events (id TEXT PRIMARY KEY,ip TEXT NOT NULL,entry TEXT NOT NULL,fingerprint TEXT NOT NULL,window_start INTEGER NOT NULL,count INTEGER NOT NULL DEFAULT 1,first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,unread INTEGER NOT NULL DEFAULT 0,result TEXT NOT NULL,UNIQUE(ip,entry,window_start));
    CREATE TABLE IF NOT EXISTS verification_attempts (id INTEGER PRIMARY KEY,ip TEXT NOT NULL,created_at INTEGER NOT NULL,failed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS ip_bans (id TEXT PRIMARY KEY,ip TEXT NOT NULL,source TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER,revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS sub2api_bindings (cdk_id TEXT NOT NULL REFERENCES cdks(id),backend TEXT NOT NULL,remote_id TEXT NOT NULL,email TEXT NOT NULL,PRIMARY KEY(cdk_id,backend,remote_id));
    CREATE TABLE IF NOT EXISTS sms_pool_operations (id TEXT NOT NULL,cdk_id TEXT NOT NULL REFERENCES cdks(id),job_id TEXT NOT NULL,email TEXT NOT NULL,run_id TEXT NOT NULL,status TEXT NOT NULL,fee INTEGER NOT NULL CHECK(fee>=0),payload TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(cdk_id,id));
    CREATE UNIQUE INDEX IF NOT EXISTS sms_pool_active_job ON sms_pool_operations(cdk_id,job_id) WHERE status NOT IN ('verified','released');
    CREATE INDEX IF NOT EXISTS sms_pool_owner_time ON sms_pool_operations(cdk_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS sms_pool_inventory (id TEXT PRIMARY KEY,entry_id TEXT NOT NULL,credential_id TEXT NOT NULL,provider_id TEXT NOT NULL,order_id TEXT,phone_hash TEXT,state TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,expires_at INTEGER,next_action_at INTEGER NOT NULL DEFAULT 0,claim_owner TEXT,claim_operation TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS sms_inventory_provider_order ON sms_pool_inventory(provider_id,credential_id,order_id) WHERE order_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS sms_inventory_state_expiry ON sms_pool_inventory(state,expires_at,created_at);
    CREATE INDEX IF NOT EXISTS sms_inventory_admin_list ON sms_pool_inventory(state,created_at DESC);
    CREATE TABLE IF NOT EXISTS sms_pool_order_bindings (order_key TEXT PRIMARY KEY,provider_id TEXT NOT NULL,inventory_id TEXT,cdk_id TEXT,operation_id TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sms_pool_cost_orders (identity TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS ledger_owner_time ON ledger(cdk_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS attempts_ip_time ON verification_attempts(ip,created_at);
    CREATE INDEX IF NOT EXISTS security_time ON security_events(last_at DESC);
    CREATE INDEX IF NOT EXISTS bans_ip ON ip_bans(ip,revoked_at,expires_at);
  `);
  if (!db.prepare("PRAGMA table_info(imports)").all().some((column) => column.name === "actor_id")) db.exec("ALTER TABLE imports ADD COLUMN actor_id TEXT");
  const transaction = (operation) => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const get = (id) => db.prepare("SELECT * FROM cdks WHERE id=?").get(id);
  const audit = (actor, action, target, detail = {}) => db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)").run(crypto.randomUUID(), actor, action, target, JSON.stringify(detail), Date.now());
  const ledger = (id, kind, delta, reference, note, actor) => db.prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), id, kind, delta, get(id).balance, reference, note, actor, Date.now());
  const publicCdk = (row) => row ? { id: row.id, label: row.label, role: row.role, status: row.status, balance: row.balance - row.reserved, reserved: row.reserved, consumed: row.consumed,
    importConsumed: -db.prepare("SELECT COALESCE(SUM(delta),0) AS total FROM ledger WHERE cdk_id=? AND kind='import'").get(row.id).total,
    smsPoolConsumed: -db.prepare("SELECT COALESCE(SUM(delta),0) AS total FROM ledger WHERE cdk_id=? AND kind='sms-pool'").get(row.id).total,
    allowedSmsProviders: allowedSmsProviders(row),
    everConsumed: Boolean(row.ever_consumed), note: row.note, createdAt: new Date(row.created_at).toISOString(), lastLogin: row.last_login ? new Date(row.last_login).toISOString() : null, accounts: db.prepare("SELECT COUNT(*) AS total FROM accounts WHERE cdk_id=? AND deleted_at IS NULL").get(row.id).total } : null;
  const requireActive = (id) => { const row = get(id); if (!row || row.status !== "active") throw cdkError(403, "CDK 已失效或被禁用"); return row; };
  const setting = (id, name) => { const row = db.prepare("SELECT value FROM settings WHERE cdk_id=? AND name=?").get(id, name); return row ? vault.open(row.value, `${id}:${name}`) : null; };
  const saveSetting = (id, name, value) => db.prepare("INSERT INTO settings VALUES(?,?,?,?) ON CONFLICT(cdk_id,name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(id, name, vault.seal(value, `${id}:${name}`), Date.now());
  const allowedSmsProviders = (row) => {
    if (!row) return [];
    if (row.role === "admin") return [...CDK_SMS_PROVIDER_IDS];
    const permissions = setting(row.id, "sms-permissions");
    return CDK_SMS_PROVIDER_IDS.filter((id) => id === "custom" || permissions?.allowedSmsProviders?.includes(id));
  };
  let administrator = db.prepare("SELECT * FROM cdks WHERE role='admin' ORDER BY created_at LIMIT 1").get();
  if (!administrator) {
    const secret = process.env.TOSUB2_ADMIN_CDK || randomSecret("TS2-ADMIN");
    if (secret.length < 24 || secret.length > 200) throw new Error("初始化管理员 CDK 至少需要 24 个字符");
    const id = crypto.randomUUID();
    transaction(() => {
      db.prepare("INSERT INTO cdks(id,secret_hash,label,role,note,created_at) VALUES(?,?,?,'admin',?,?)").run(id, secretHash(secret), `TS2-ADMIN-••••-${secret.slice(-4)}`, "系统管理员", Date.now());
      saveSetting(id, "initial-secret", { secret }); saveSetting(id, "login-secret", { secret }); audit("local", "initialize-admin", id);
    });
    administrator = get(id);
  }
  const adminId = administrator.id;
  const smsOperation = (row) => row ? { ...vault.open(row.payload, `sms-pool:${row.cdk_id}:${row.id}`), operationId: row.id, ownerId: row.cdk_id, jobId: row.job_id, email: row.email, runId: row.run_id, state: row.status, fee: row.fee, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  const readSmsOperation = (id, operationId) => smsOperation(db.prepare("SELECT * FROM sms_pool_operations WHERE cdk_id=? AND id=?").get(id, operationId));
  const writeSmsOperation = (operation) => {
    db.prepare("UPDATE sms_pool_operations SET status=?,payload=?,updated_at=? WHERE cdk_id=? AND id=?").run(operation.state, vault.seal(operation, `sms-pool:${operation.ownerId}:${operation.operationId}`), Date.now(), operation.ownerId, operation.operationId);
    return readSmsOperation(operation.ownerId, operation.operationId);
  };
  const readInventory = (row) => row ? { ...vault.open(row.payload, `sms-inventory:${row.id}`), id: row.id, entryId: row.entry_id, credentialId: row.credential_id, providerId: row.provider_id, state: row.state,
    createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at, nextActionAt: row.next_action_at, claimOwner: row.claim_owner, claimOperation: row.claim_operation } : null;
  const inventoryRow = (id) => db.prepare("SELECT * FROM sms_pool_inventory WHERE id=?").get(id);
  const writeInventory = (item) => {
    db.prepare("UPDATE sms_pool_inventory SET order_id=?,phone_hash=?,state=?,payload=?,updated_at=?,expires_at=?,next_action_at=?,claim_owner=?,claim_operation=? WHERE id=?")
      .run(item.order?.requestId ? String(item.order.requestId) : null, item.order?.number ? vault.fingerprint(String(item.order.number).replace(/\D/g, "")) : null, item.state, vault.seal(item, `sms-inventory:${item.id}`), Date.now(), item.expiresAt || null, item.nextActionAt || 0, item.claimOwner || null, item.claimOperation || null, item.id);
    return readInventory(inventoryRow(item.id));
  };
  const orderKey = (item) => item.order?.requestId && item.config?.apiKey ? vault.fingerprint(JSON.stringify([item.providerId, item.config.apiKey, String(item.order.requestId)])) : null;
  const hasAttemptOrder = (history, attempt) => history.some((allocation) => allocation.allocationId === attempt.id
    || String(allocation.order?.requestId || "") === String(attempt.orderId || "") && Boolean(attempt.orderId)
      && (!attempt.providerId || allocation.providerId === attempt.providerId) && (!attempt.credentialId || allocation.credentialId === attempt.credentialId));
  let cachedCostSummary = null; let cachedCostOrders = null;
  const invalidateCostCache = () => { cachedCostSummary = null; cachedCostOrders = null; };
  const costCategory = (order) => ({ ...order, categoryId: order.categoryId || "legacy", categoryName: order.categoryName || "原接码池", categoryFeeVersion: order.categoryFeeVersion ?? null });
  const costOrders = () => cachedCostOrders ||= db.prepare("SELECT identity,payload FROM sms_pool_cost_orders ORDER BY created_at,identity").all().map((row) => costCategory(vault.open(row.payload, `sms-cost:${row.identity}`)));
  const clearUnknownCost = (identity) => { if (identity) { db.prepare("DELETE FROM sms_pool_cost_orders WHERE identity=?").run(identity); invalidateCostCache(); } };
  const recordCostOrder = (source, options = {}) => {
    const identity = options.identity || orderKey(source); if (!identity) return;
    const descriptor = poolCostOrder(source, options); const old = db.prepare("SELECT payload FROM sms_pool_cost_orders WHERE identity=?").get(identity);
    const previous = old ? vault.open(old.payload, `sms-cost:${identity}`) : null;
    if (previous) { const category = costCategory(previous); for (const field of ["categoryId", "categoryName", "categoryFeeVersion"]) descriptor[field] = category[field]; }
    if (previous?.cost && !descriptor.cost) descriptor.cost = previous.cost;
    if (previous?.refundStatus === "confirmed") descriptor.refundStatus = "confirmed";
    if (previous?.refundExpected) descriptor.refundExpected = true;
    if (previous?.verified) { descriptor.verified = true; descriptor.verifiedAt ||= previous.verifiedAt || null; }
    if (previous?.obtained) descriptor.obtained = true;
    for (const field of ["entryId", "credentialId", "country", "countryKey", "countryLabel", "providerId", "providerName", "phone"]) if (!descriptor[field] && previous?.[field]) descriptor[field] = previous[field];
    if (previous?.createdAt) descriptor.createdAt = previous.createdAt;
    if (!source.config && previous?.route) descriptor.route = previous.route;
    if (!descriptor.quote && previous?.quote) descriptor.quote = previous.quote;
    if (!descriptor.maxPrice && previous?.maxPrice) descriptor.maxPrice = previous.maxPrice;
    descriptor.feeStatus = !descriptor.cost ? "unknown_cost" : !descriptor.cost.currency ? "unknown_currency" : "confirmed_purchase";
    db.prepare("INSERT INTO sms_pool_cost_orders VALUES(?,?,?) ON CONFLICT(identity) DO UPDATE SET payload=excluded.payload")
      .run(identity, vault.seal(descriptor, `sms-cost:${identity}`), options.createdAt || source.createdAt || Date.now());
    invalidateCostCache();
  };
  const operationCostOrders = (operation) => {
    const history = [...(operation.orderHistory || [])];
    if (operation.allocation && !history.some((item) => item.allocationId === operation.allocation.allocationId)) history.push(operation.allocation);
    const result = history.map((allocation) => {
      const identity = orderKey(allocation); const row = identity && db.prepare("SELECT payload FROM sms_pool_cost_orders WHERE identity=?").get(identity);
      return row ? costCategory(vault.open(row.payload, `sms-cost:${identity}`)) : poolCostOrder(allocation, { state: allocation.abandoned ? "abandoned" : operation.state, createdAt: allocation.createdAt || operation.createdAt,
        refundExpected: allocation.abandoned || operation.state === "released", verified: operation.state === "verified" && operation.allocation?.allocationId === allocation.allocationId && !allocation.abandoned,
        verifiedAt: operation.evidence?.verifiedAt || operation.settledAt || null });
    });
    for (const attempt of operation.attempts || []) if (attempt.orderId && !hasAttemptOrder(history, attempt)) {
      result.push({ ...poolCostOrder({ ...attempt, order: { requestId: attempt.orderId } }, { state: "legacy_missing", createdAt: attempt.startedAt }), obtained: attempt.state === "allocated" });
    }
    for (const attempt of operation.attempts || []) if (attempt.state === "order_unknown" && !history.some((allocation) => allocation.allocationId === attempt.id)) {
      result.push(poolCostOrder(attempt, { state: "purchase_unknown", createdAt: attempt.startedAt }));
    }
    return result;
  };
  if (!db.prepare("SELECT 1 FROM meta WHERE key='sms-cost-orders-migrated'").get()) transaction(() => {
    for (const row of db.prepare("SELECT * FROM sms_pool_inventory").all()) {
      const item = readInventory(row); if (item.order) recordCostOrder(item, { refundExpected: ["cancel_pending", "quarantined", "closed"].includes(item.state), createdAt: item.createdAt });
      else if (item.state === "purchase_unknown" && !item.duplicateOrderId) recordCostOrder(item, { identity: `unknown-inventory:${item.id}`, createdAt: item.createdAt });
    }
    for (const row of db.prepare("SELECT * FROM sms_pool_operations").all()) {
      const operation = smsOperation(row); const history = [...(operation.orderHistory || [])];
      if (operation.allocation && !history.some((item) => item.allocationId === operation.allocation.allocationId)) history.push(operation.allocation);
      for (const allocation of history) recordCostOrder(allocation, { state: allocation.abandoned ? "abandoned" : operation.state, createdAt: allocation.createdAt || operation.createdAt,
        refundExpected: allocation.abandoned || operation.state === "released", verified: operation.state === "verified" && operation.allocation?.allocationId === allocation.allocationId && !allocation.abandoned,
        verifiedAt: operation.evidence?.verifiedAt || operation.settledAt || null });
      for (const attempt of operation.attempts || []) if (attempt.orderId && !hasAttemptOrder(history, attempt)) {
        recordCostOrder({ ...attempt, order: { requestId: attempt.orderId }, createdAt: attempt.startedAt }, { identity: `legacy-missing:${operation.ownerId}:${operation.operationId}:${attempt.id}`, state: "legacy_missing", createdAt: attempt.startedAt, obtained: attempt.state === "allocated" });
      }
      for (const attempt of operation.attempts || []) if (attempt.state === "order_unknown" && !history.some((allocation) => allocation.allocationId === attempt.id)) {
        recordCostOrder(attempt, { identity: `unknown-operation:${operation.ownerId}:${operation.operationId}:${attempt.id}`, state: "purchase_unknown", createdAt: attempt.startedAt });
      }
    }
    db.prepare("INSERT INTO meta VALUES('sms-cost-orders-migrated','1')").run();
  });
  // Enrich existing encrypted order records once, using their original purchase
  // configuration and final settlement. Never infer spend from a configured cap.
  if (!db.prepare("SELECT 1 FROM meta WHERE key='sms-cost-orders-analytics-v2'").get()) transaction(() => {
    for (const row of db.prepare("SELECT * FROM sms_pool_inventory").all()) {
      const item = readInventory(row); if (item.order) recordCostOrder(item, { refundExpected: ["cancel_pending", "quarantined", "closed"].includes(item.state), createdAt: item.createdAt });
      else if (item.state === "purchase_unknown" && !item.duplicateOrderId) recordCostOrder(item, { identity: `unknown-inventory:${item.id}`, createdAt: item.createdAt });
    }
    for (const row of db.prepare("SELECT * FROM sms_pool_operations").all()) {
      const operation = smsOperation(row); const history = [...(operation.orderHistory || [])];
      if (operation.allocation && !history.some((item) => item.allocationId === operation.allocation.allocationId)) history.push(operation.allocation);
      for (const allocation of history) {
        clearUnknownCost(`unknown-operation:${operation.ownerId}:${operation.operationId}:${allocation.allocationId}`);
        clearUnknownCost(`legacy-missing:${operation.ownerId}:${operation.operationId}:${allocation.allocationId}`);
        recordCostOrder(allocation, { state: allocation.abandoned ? "abandoned" : operation.state, createdAt: allocation.createdAt || operation.createdAt,
          refundExpected: allocation.abandoned || operation.state === "released", verified: operation.state === "verified" && operation.allocation?.allocationId === allocation.allocationId && !allocation.abandoned,
          verifiedAt: operation.evidence?.verifiedAt || operation.settledAt || null });
      }
      for (const attempt of operation.attempts || []) if (attempt.orderId && !hasAttemptOrder(history, attempt)) {
        recordCostOrder({ ...attempt, order: { requestId: attempt.orderId } }, { identity: `legacy-missing:${operation.ownerId}:${operation.operationId}:${attempt.id}`,
          state: "legacy_missing", createdAt: attempt.startedAt, obtained: attempt.state === "allocated" });
      }
      for (const attempt of operation.attempts || []) if (attempt.state === "order_unknown" && !history.some((allocation) => allocation.allocationId === attempt.id)) {
        recordCostOrder(attempt, { identity: `unknown-operation:${operation.ownerId}:${operation.operationId}:${attempt.id}`, state: "purchase_unknown", createdAt: attempt.startedAt });
      }
    }
    db.prepare("INSERT INTO meta VALUES('sms-cost-orders-analytics-v2','1')").run();
  });
  if (!db.prepare("SELECT 1 FROM meta WHERE key='sms-order-bindings-migrated'").get()) transaction(() => {
    for (const row of db.prepare("SELECT * FROM sms_pool_inventory WHERE order_id IS NOT NULL").all()) {
      const item = readInventory(row); const key = orderKey(item);
      if (key) db.prepare("INSERT OR IGNORE INTO sms_pool_order_bindings VALUES(?,?,?,NULL,NULL,?)").run(key, item.providerId, item.id, item.createdAt);
    }
    for (const row of db.prepare("SELECT * FROM sms_pool_operations").all()) {
      const operation = smsOperation(row); const allocation = operation.allocation; const key = allocation && orderKey(allocation);
      if (key) db.prepare("INSERT OR IGNORE INTO sms_pool_order_bindings VALUES(?,?,?,?,?,?)").run(key, allocation.providerId, allocation.inventoryId || null, operation.ownerId, operation.operationId, operation.createdAt);
    }
    db.prepare("INSERT INTO meta VALUES('sms-order-bindings-migrated','1')").run();
  });
  if (!setting(adminId, "login-secret")) {
    const initial = setting(adminId, "initial-secret");
    if (initial?.secret && secretHash(initial.secret) === administrator.secret_hash) saveSetting(adminId, "login-secret", initial);
  }
  await fs.writeFile(path.join(directory, "database.marker"), "1\n", { mode: 0o600, flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  const store = {
    adminId, publicCdk,
    allowedSmsProviders: (id) => allowedSmsProviders(get(id)),
    smsProviderAllowed(id, providerId) { const row = get(id); return row?.status === "active" && allowedSmsProviders(row).includes(providerId); },
    get: (id) => publicCdk(get(id)),
    list: () => db.prepare("SELECT * FROM cdks ORDER BY role,created_at DESC").all().map(publicCdk),
    rawIds: () => db.prepare("SELECT id,role,status FROM cdks").all(),
    workspaceMigrated: (id) => Boolean(db.prepare("SELECT 1 FROM meta WHERE key=?").get(`workspace-documents-v1:${id}`)),
    workspaceDocuments: (id) => db.prepare("SELECT name,payload,mtime FROM workspace_documents WHERE cdk_id=?").all(id),
    workspaceDocument: (id, name) => db.prepare("SELECT name,payload,mtime FROM workspace_documents WHERE cdk_id=? AND name=?").get(id, name),
    workspaceDocumentInfo: (id, name) => db.prepare("SELECT name,mtime FROM workspace_documents WHERE cdk_id=? AND name=?").get(id, name),
    workspaceDocumentNames: (id) => db.prepare("SELECT name,mtime FROM workspace_documents WHERE cdk_id=?").all(id),
    workspaceTaskMetadata: (id) => db.prepare("SELECT name,payload,mtime FROM workspace_documents WHERE cdk_id=? AND name GLOB '*/job-meta.json'").all(id),
    workspaceTaskIndexReady: (id) => Boolean(db.prepare("SELECT 1 FROM meta WHERE key=?").get(`workspace-task-index-v1:${id}`)),
    indexWorkspaceTasks(id, rows) { transaction(() => {
      for (const row of rows) db.prepare("INSERT INTO workspace_documents VALUES(?,?,?,?) ON CONFLICT(cdk_id,name) DO UPDATE SET payload=excluded.payload,mtime=excluded.mtime").run(id, row.name, row.payload, row.mtime);
      db.prepare("INSERT INTO meta VALUES(?,?)").run(`workspace-task-index-v1:${id}`, "1");
    }); },
    writeWorkspaceDocuments(id, rows) { if (!rows.length) return; transaction(() => { for (const row of rows) {
      if (row.deleted) db.prepare("DELETE FROM workspace_documents WHERE cdk_id=? AND name=?").run(id, row.name);
      else db.prepare("INSERT INTO workspace_documents VALUES(?,?,?,?) ON CONFLICT(cdk_id,name) DO UPDATE SET payload=excluded.payload,mtime=excluded.mtime").run(id, row.name, row.payload, row.mtime);
    } }); },
    migrateWorkspace(id, rows) { transaction(() => { for (const row of rows) db.prepare("INSERT OR IGNORE INTO workspace_documents VALUES(?,?,?,?)").run(id, row.name, row.payload, row.mtime);
      db.prepare("INSERT INTO meta VALUES(?,?)").run(`workspace-documents-v1:${id}`, "1"); }); },
    setting, saveSetting, audit,
    smsCostSummary() { if (!cachedCostSummary) cachedCostSummary = summarizePoolCosts(costOrders()); return structuredClone(cachedCostSummary); },
    smsCostOrders() { return structuredClone(costOrders()); },
    smsCostAnalytics(query = {}, config = {}) { return poolCostAnalytics(costOrders(), poolCostFilters(query), config); },
    smsOperationCostOrders: operationCostOrders,
    recordSmsCostOrder(source, options = {}) { return transaction(() => recordCostOrder(source, options)); },
    inventoryItem(id) { return readInventory(inventoryRow(id)); },
    inventoryCounts() { return Object.fromEntries(db.prepare("SELECT state,COUNT(*) AS n FROM sms_pool_inventory GROUP BY state").all().map((row) => [row.state, row.n])); },
    inventoryItems({ activeOnly = false, limit = 200 } = {}) {
      return db.prepare(`SELECT * FROM sms_pool_inventory ${activeOnly ? "WHERE state NOT IN ('closed','consumed')" : ""} ORDER BY created_at DESC,rowid DESC LIMIT ?`).all(limit).map(readInventory);
    },
    inventoryPage(query = {}) {
      const page = Number(query.page ?? 1); const pageSize = Number(query.pageSize ?? 20);
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw cdkError(422, "库存分页参数不正确");
      const scope = query.scope || "current";
      if (!["current", "history", "all"].includes(scope)) throw cdkError(422, "库存范围不正确");
      const filters = {};
      for (const key of ["state", "providerId", "country", "search", "costStatus", "refundStatus"]) {
        if (query[key] != null && typeof query[key] !== "string") throw cdkError(422, "库存筛选参数不正确");
        filters[key] = (query[key] || "").trim();
        if (filters[key].length > 200) throw cdkError(422, "库存筛选参数过长");
      }
      if (filters.state && !["ready", "checking", "assigned", "cancel_pending", "purchase_unknown", "quarantined", "closed", "consumed"].includes(filters.state)) throw cdkError(422, "库存状态筛选不正确");
      if (filters.costStatus && !["all", "known", "unknown", "unknown_currency"].includes(filters.costStatus)) throw cdkError(422, "费用状态筛选不正确");
      if (filters.refundStatus && !["confirmed", "unconfirmed"].includes(filters.refundStatus)) throw cdkError(422, "退款状态筛选不正确");
      const clauses = ["order_id IS NOT NULL"]; const parameters = [];
      if (scope === "current") clauses.push("state NOT IN ('closed','consumed')");
      if (scope === "history") clauses.push("state IN ('closed','consumed')");
      if (filters.state) { clauses.push("state=?"); parameters.push(filters.state); }
      if (filters.providerId) { clauses.push("provider_id=?"); parameters.push(filters.providerId); }
      const search = filters.search.toLocaleLowerCase();
      const rows = db.prepare(`SELECT * FROM sms_pool_inventory WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC,rowid DESC`).all(...parameters).map(readInventory).filter((item) => {
        if (!item.order?.number) return false;
        const country = String(item.config?.country ?? "");
        if (filters.country && filters.country !== country && filters.country !== `${item.providerId}:${country}`) return false;
        if (search && ![item.order.number, item.order.requestId, item.config?.countryLabel, country, item.providerId].some((value) => String(value || "").toLocaleLowerCase().includes(search))) return false;
        const descriptor = poolCostOrder(item);
        const known = Boolean(descriptor.cost?.currency && descriptor.cost?.amount != null);
        if (filters.costStatus === "known" && !known || filters.costStatus === "unknown" && known
          || filters.costStatus === "unknown_currency" && (!descriptor.cost || descriptor.cost.currency)) return false;
        return !filters.refundStatus || filters.refundStatus === descriptor.refundStatus;
      });
      return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, pages: Math.max(1, Math.ceil(rows.length / pageSize)) };
    },
    createInventoryPurchase(input, rules) {
      return transaction(() => {
        const active = db.prepare("SELECT COUNT(*) AS n FROM sms_pool_inventory WHERE state NOT IN ('closed','consumed')").get().n;
        const buffered = db.prepare("SELECT COUNT(*) AS n FROM sms_pool_inventory WHERE state IN ('ready','purchasing','checking')").get().n;
        const perEntry = db.prepare("SELECT COUNT(*) AS n FROM sms_pool_inventory WHERE entry_id=? AND state IN ('ready','purchasing','checking')").get(input.entryId).n;
        const minute = db.prepare("SELECT COUNT(*) AS n FROM sms_pool_inventory WHERE created_at>?").get(input.createdAt - 60000).n;
        if (rules.simplified === true) {
          const unresolved = db.prepare("SELECT COUNT(*) AS n FROM sms_pool_inventory WHERE state IN ('cancel_pending','purchase_unknown','quarantined')").get().n;
          if (buffered >= rules.target || unresolved >= Math.max(10, rules.target)) return null;
        } else if (active >= rules.maxOutstanding || buffered >= rules.target || perEntry >= rules.perEntry || minute >= rules.maxPerMinute) return null;
        const item = { ...input, state: "purchasing", refundStatus: "unconfirmed", nextActionAt: 0, expiresAt: null };
        db.prepare("INSERT INTO sms_pool_inventory VALUES(?,?,?,?,NULL,NULL,'purchasing',?,?,?,NULL,0,NULL,NULL)").run(item.id, item.entryId, item.credentialId, item.providerId, vault.seal(item, `sms-inventory:${item.id}`), item.createdAt, item.createdAt);
        return readInventory(inventoryRow(item.id));
      });
    },
    updateInventory(id, mutate) { return transaction(() => { const item = readInventory(inventoryRow(id)); if (!item) throw cdkError(404, "库存号码不存在"); const saved = writeInventory(mutate(item) || item);
      if (saved.order) { clearUnknownCost(`unknown-inventory:${saved.id}`); recordCostOrder(saved, { refundExpected: ["cancel_pending", "quarantined", "closed"].includes(saved.state), createdAt: saved.createdAt }); }
      else if (saved.state === "purchase_unknown" && !saved.duplicateOrderId) recordCostOrder(saved, { identity: `unknown-inventory:${saved.id}`, createdAt: saved.createdAt });
      return saved; }); },
    queueSmsOrderCancellation(allocation, { reason = "order_released", now = Date.now() } = {}) {
      return transaction(() => {
        const identity = orderKey(allocation); if (!identity) return null;
        const binding = db.prepare("SELECT cdk_id,operation_id FROM sms_pool_order_bindings WHERE order_key=?").get(identity);
        const bound = binding?.cdk_id && binding.operation_id ? readSmsOperation(binding.cdk_id, binding.operation_id) : null;
        const boundAllocation = bound?.allocation;
        if (boundAllocation && orderKey(boundAllocation) === identity
          && (bound.state === "verified" || !boundAllocation.abandoned && boundAllocation.allocationId !== allocation.allocationId)) return null;
        // A late response can repeat an order owned by another live task. It is
        // not authority to cancel that task's number, including legacy bindings.
        const protectedOrder = db.prepare("SELECT * FROM sms_pool_operations WHERE status NOT IN ('verified','released')").all().map(smsOperation)
          .some((other) => other.allocation && !other.allocation.abandoned && orderKey(other.allocation) === identity
            && (other.state === "verified" || other.allocation.allocationId !== allocation.allocationId));
        if (protectedOrder) return null;
        const existing = db.prepare("SELECT * FROM sms_pool_inventory WHERE provider_id=? AND order_id=?")
          .all(allocation.providerId, String(allocation.order.requestId)).map(readInventory).find((item) => orderKey(item) === identity);
        if (existing && ["closed", "consumed"].includes(existing.state)) return existing;
        const timestamp = (value) => value == null || value === "" ? null : typeof value === "number" ? value : Date.parse(value);
        const validTime = (value, fallback = null) => { const time = timestamp(value); return Number.isFinite(time) ? time : fallback; };
        const createdAt = existing?.createdAt ?? validTime(allocation.createdAt, now);
        const cancelAllowedAt = existing?.cancelAllowedAt ?? validTime(allocation.order.cancelAllowedAt, now);
        const item = { ...allocation, ...existing, id: existing?.id || crypto.randomUUID(),
          source: existing?.source || "direct_cancellation", state: "cancel_pending", createdAt,
          expiresAt: existing?.expiresAt ?? validTime(allocation.order.expiresAt),
          expiresSource: existing?.expiresSource || allocation.order.expiresAtSource || null,
          cancelAllowedAt, cancelBeforeAt: existing?.cancelBeforeAt ?? validTime(allocation.order.cancelBeforeAt, validTime(allocation.order.expiresAt)),
          nextActionAt: Math.max(now, cancelAllowedAt), cancelState: "pending", refundStatus: existing?.refundStatus || "unconfirmed",
          retirementReason: existing?.retirementReason || String(reason).slice(0, 200), lastError: String(reason).slice(0, 200) };
        if (!existing) db.prepare("INSERT INTO sms_pool_inventory (id,entry_id,credential_id,provider_id,state,payload,created_at,updated_at,next_action_at) VALUES(?,?,?,?,?,?,?,?,?)")
          .run(item.id, item.entryId, item.credentialId, item.providerId, item.state, vault.seal(item, `sms-inventory:${item.id}`), createdAt, now, item.nextActionAt);
        const saved = writeInventory(item);
        recordCostOrder(saved, { refundExpected: true, createdAt });
        return saved;
      });
    },
    finishInventoryPurchase(id, fields) {
      return transaction(() => {
        const item = readInventory(inventoryRow(id)); if (!item || item.state !== "purchasing") return item;
        const key = orderKey({ ...item, order: fields.order });
        if (key && db.prepare("SELECT 1 FROM sms_pool_order_bindings WHERE order_key=?").get(key)) return writeInventory({ ...item, state: "purchase_unknown", duplicateOrderId: String(fields.order.requestId), lastError: "duplicate_order", nextActionAt: 0 });
        const duplicateOrder = fields.order?.requestId && db.prepare("SELECT * FROM sms_pool_inventory WHERE id<>? AND provider_id=? AND order_id=?").all(id, item.providerId, String(fields.order.requestId))
          .map(readInventory).some((other) => other.config?.apiKey === item.config?.apiKey);
        const duplicateOperation = fields.order?.requestId && db.prepare("SELECT * FROM sms_pool_operations WHERE status NOT IN ('verified','released')").all().map(smsOperation)
          .some((other) => other.allocation && !other.allocation.abandoned && other.allocation.providerId === item.providerId && other.allocation.config?.apiKey === item.config?.apiKey && String(other.allocation.order?.requestId) === String(fields.order.requestId));
        if (duplicateOrder || duplicateOperation) return writeInventory({ ...item, state: "purchase_unknown", duplicateOrderId: String(fields.order.requestId), lastError: "duplicate_order", nextActionAt: 0 });
        const duplicate = fields.order?.number && db.prepare("SELECT 1 FROM sms_pool_inventory WHERE id<>? AND phone_hash=? AND state NOT IN ('closed','consumed')").get(id, vault.fingerprint(String(fields.order.number).replace(/\D/g, "")));
        const saved = writeInventory({ ...item, ...fields, ...(duplicate ? { state: "quarantined", lastError: "duplicate_phone", nextActionAt: fields.cancelAllowedAt || Date.now() } : {}) });
        if (saved.order?.requestId) clearUnknownCost(`unknown-inventory:${saved.id}`);
        recordCostOrder(saved, { refundExpected: ["cancel_pending", "quarantined"].includes(saved.state), createdAt: saved.createdAt });
        if (key) db.prepare("INSERT INTO sms_pool_order_bindings VALUES(?,?,?,NULL,NULL,?)").run(key, item.providerId, item.id, item.createdAt);
        return saved;
      });
    },
    allocateSmsOrder(ownerId, operationId, allocation, now = Date.now()) {
      return transaction(() => {
        const operation = readSmsOperation(ownerId, operationId); if (allocation.order?.requestId) clearUnknownCost(`unknown-operation:${ownerId}:${operationId}:${allocation.allocationId}`);
        if (!operation || !["requesting", "reserved"].includes(operation.state)) {
          const identity = orderKey(allocation);
          if (!identity || !db.prepare("SELECT 1 FROM sms_pool_order_bindings WHERE order_key=?").get(identity)) recordCostOrder(allocation, { state: "operation_stopped", createdAt: now, refundExpected: true });
          return { allocation: null, conflict: "operation_stopped" };
        }
        // The provider has already returned a purchased order. Persist it even
        // if access changed in flight; the pool then checks access and retires it.
        if (operation.categoryId) {
          const category = { categoryId: operation.categoryId, categoryName: operation.categoryName, categoryFeeVersion: operation.categoryFeeVersion };
          Object.assign(allocation, category); allocation.config = { ...allocation.config, ...category };
        }
        const phone = String(allocation.order.number).replace(/\D/g, "");
        const key = orderKey(allocation);
        const inventory = db.prepare("SELECT * FROM sms_pool_inventory WHERE state NOT IN ('closed','consumed')").all().map(readInventory);
        const otherOperations = db.prepare("SELECT * FROM sms_pool_operations WHERE status NOT IN ('verified','released') AND NOT(cdk_id=? AND id=?)").all(ownerId, operationId).map(smsOperation)
          .map((other) => other.allocation).filter((other) => other && !other.abandoned);
        const sameOrder = (other) => other.providerId === allocation.providerId && other.config?.apiKey === allocation.config?.apiKey && String(other.order?.requestId || "") === String(allocation.order.requestId);
        const duplicateOrder = Boolean(key && db.prepare("SELECT 1 FROM sms_pool_order_bindings WHERE order_key=?").get(key)) || inventory.some(sameOrder) || otherOperations.some(sameOrder);
        const duplicatePhone = inventory.some((other) => String(other.order?.number || "").replace(/\D/g, "") === phone) || otherOperations.some((other) => String(other.order?.number || "").replace(/\D/g, "") === phone);
        if (duplicateOrder || duplicatePhone) {
          const item = { id: crypto.randomUUID(), entryId: allocation.entryId, credentialId: allocation.credentialId, providerId: allocation.providerId, config: allocation.config,
            state: duplicateOrder ? "purchase_unknown" : "quarantined", source: "direct_duplicate", order: duplicateOrder ? null : allocation.order,
            duplicateOrderId: duplicateOrder ? String(allocation.order.requestId) : null, lastError: duplicateOrder ? "duplicate_order" : "duplicate_phone", createdAt: now,
            refundStatus: "unconfirmed", expiresAt: Number.isFinite(Date.parse(allocation.order.expiresAt)) ? Date.parse(allocation.order.expiresAt) : null,
            cancelAllowedAt: Number.isFinite(Date.parse(allocation.order.cancelAllowedAt)) ? Date.parse(allocation.order.cancelAllowedAt) : now, nextActionAt: duplicateOrder ? 0 : now };
          db.prepare("INSERT INTO sms_pool_inventory VALUES(?,?,?,?,NULL,NULL,?,?,?, ?,NULL,0,NULL,NULL)").run(item.id, item.entryId, item.credentialId, item.providerId, item.state, vault.seal(item, `sms-inventory:${item.id}`), now, now);
          writeInventory(item);
          if (!duplicateOrder) recordCostOrder(item, { refundExpected: true, createdAt: now });
          operation.state = "reserved"; operation.reason = item.lastError; Object.assign(operation.attempts.at(-1), { state: item.lastError, endedAt: now }); writeSmsOperation(operation);
          return { allocation: null, conflict: item.lastError };
        }
        allocation.createdAt ||= now;
        operation.state = "allocated"; operation.allocation = allocation; (operation.orderHistory ||= []).push(allocation);
        Object.assign(operation.attempts.at(-1), { state: "allocated", orderId: String(allocation.order.requestId), endedAt: now }); writeSmsOperation(operation);
        recordCostOrder(allocation, { state: "allocated", createdAt: now });
        if (key) db.prepare("INSERT INTO sms_pool_order_bindings VALUES(?,?,NULL,?,?,?)").run(key, allocation.providerId, ownerId, operationId, now);
        return { allocation, conflict: null };
      });
    },
    claimInventoryCheck(ownerId, operationId, { now, minRemainingMs, allowedEntryIds }) {
      return transaction(() => {
        const operation = readSmsOperation(ownerId, operationId); if (!operation || operation.state !== "reserved") return null;
        requireActive(ownerId);
        const rows = db.prepare("SELECT * FROM sms_pool_inventory WHERE state='ready' AND expires_at>? ORDER BY expires_at,created_at,rowid").all(now + minRemainingMs);
        const row = rows.find((item) => allowedEntryIds.includes(item.entry_id)); if (!row) return null;
        const item = readInventory(row); item.state = "checking"; item.claimOwner = ownerId; item.claimOperation = operationId; return writeInventory(item);
      });
    },
    assignInventory(ownerId, operationId, inventoryId, allocation, now, minRemainingMs) {
      return transaction(() => {
        const operation = readSmsOperation(ownerId, operationId); const item = readInventory(inventoryRow(inventoryId));
        if (!operation || operation.state !== "reserved" || !item || item.state !== "checking" || item.claimOwner !== ownerId || item.claimOperation !== operationId || item.expiresAt <= now + minRemainingMs) return null;
        requireActive(ownerId);
        const duplicateAllocation = db.prepare("SELECT * FROM sms_pool_operations WHERE status NOT IN ('verified','released') AND NOT(cdk_id=? AND id=?)").all(ownerId, operationId).map(smsOperation)
          .some((other) => other.allocation && !other.allocation.abandoned && String(other.allocation.order?.number || "").replace(/\D/g, "") === String(item.order.number).replace(/\D/g, ""));
        if (duplicateAllocation) { item.state = "quarantined"; item.lastError = "duplicate_active_phone"; item.nextActionAt = Math.max(now, item.cancelAllowedAt || 0); writeInventory(item); return null; }
        item.state = "assigned"; item.allocationId = allocation.allocationId; writeInventory(item);
        operation.state = "allocated"; operation.allocation = { ...allocation, inventoryId }; operation.attempts.push({ id: allocation.allocationId, inventoryId, entryId: item.entryId, credentialId: item.credentialId, state: "allocated", orderId: item.order.requestId, startedAt: now, endedAt: now });
        (operation.orderHistory ||= []).push(operation.allocation);
        recordCostOrder(item, { state: "assigned", createdAt: item.createdAt });
        writeSmsOperation(operation); return operation.allocation;
      });
    },
    inventoryOperationEnd(ownerId, operationId, success, now = Date.now()) {
      return transaction(() => {
        const rows = db.prepare("SELECT * FROM sms_pool_inventory WHERE claim_owner=? AND claim_operation=? AND state IN ('assigned','checking')").all(ownerId, operationId);
        for (const row of rows) { const item = readInventory(row); item.state = success ? "consumed" : "cancel_pending"; item.nextActionAt = Math.max(now, item.cancelAllowedAt || 0); writeInventory(item);
          recordCostOrder(item, { state: item.state, createdAt: item.createdAt, refundExpected: !success }); }
      });
    },
    smsPoolConfig: () => setting(adminId, "sms-pool"),
    mutateSmsPoolConfig(mutate, actor = "system", action = "sms-pool-state") {
      return transaction(() => { const next = mutate(setting(adminId, "sms-pool")); saveSetting(adminId, "sms-pool", next); if (action) audit(actor, action, "sms-pool"); return next; });
    },
    smsOperation: readSmsOperation,
    smsOperations(id = null) { return db.prepare(`SELECT * FROM sms_pool_operations ${id ? "WHERE cdk_id=?" : ""} ORDER BY created_at DESC,rowid DESC LIMIT 200`).all(...(id ? [id] : [])).map(smsOperation); },
    smsOperationPage(query = {}) {
      let { page = 1, pageSize = 50, cdkId = null, state = null } = query;
      page = Number(page); pageSize = Number(pageSize);
      if (state === "all") state = null;
      if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw cdkError(422, "接码记录分页参数不正确");
      if (state && !["reserved", "requesting", "allocated", "submitted", "unknown", "verified", "released"].includes(state)) throw cdkError(422, "接码记录状态不正确");
      const costFilters = poolCostFilters(query);
      const filters = []; const parameters = [];
      if (cdkId) { filters.push("cdk_id=?"); parameters.push(cdkId); }
      if (state) { filters.push("status=?"); parameters.push(state); }
      if (costFilters.start != null) { filters.push("created_at>=?"); parameters.push(costFilters.start); }
      if (costFilters.end != null) { filters.push("created_at<?"); parameters.push(costFilters.end); }
      const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
      const { start, end, search, categoryId, ...orderFilters } = costFilters;
      if (search || categoryId || Object.keys(orderFilters).length) {
        const selected = db.prepare(`SELECT * FROM sms_pool_operations ${where} ORDER BY created_at DESC,rowid DESC`).all(...parameters).map(smsOperation).filter((operation) => {
          if (categoryId && (operation.categoryId || "legacy") !== categoryId) return false;
          const orders = operationCostOrders(operation);
          if (search && ![operation.email, operation.operationId, operation.jobId, get(operation.ownerId)?.label, ...orders.map((order) => `${order.phone || ""} ${order.orderId || ""}`)].join(" ").toLowerCase().includes(search.toLowerCase())) return false;
          if (!Object.keys(orderFilters).length) return true;
          if (!orders.length && Object.keys(orderFilters).every((key) => key === "result") && orderFilters.result === "unverified") return operation.state !== "verified";
          return orders.some((order) => matchesPoolCost(order, orderFilters));
        });
        const total = selected.length; const pages = Math.max(1, Math.ceil(total / pageSize)); page = Math.min(page, pages);
        return { items: selected.slice((page - 1) * pageSize, page * pageSize), page, pageSize, pages, total, timeBasis: "operationCreatedAt" };
      }
      const total = db.prepare(`SELECT COUNT(*) AS total FROM sms_pool_operations ${where}`).get(...parameters).total;
      const pages = Math.max(1, Math.ceil(total / pageSize)); page = Math.min(page, pages);
      const items = db.prepare(`SELECT * FROM sms_pool_operations ${where} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`).all(...parameters, pageSize, (page - 1) * pageSize).map(smsOperation);
      return { items, page, pageSize, pages, total, timeBasis: "operationCreatedAt" };
    },
    pendingSmsOperations: () => db.prepare("SELECT * FROM sms_pool_operations WHERE status NOT IN ('verified','released')").all().map(smsOperation),
    prepareSmsOperation(id, input) {
      return transaction(() => {
        const existing = readSmsOperation(id, input.operationId);
        if (existing) {
          if (existing.jobId !== input.jobId || existing.email !== input.email || existing.runId !== input.runId) throw cdkError(409, "接码操作标识对应任务不同");
          if (input.categoryId && input.categoryId !== (existing.categoryId || "other")) throw cdkError(409, "已有接码操作不能切换分类，请先结束原操作", "SMS_POOL_CATEGORY_CHANGED");
          return existing;
        }
        const row = requireActive(id);
        if (input.actorId && input.actorId !== id && input.actorId !== "recovery") {
          const actor = requireActive(input.actorId); if (actor.role !== "admin") throw cdkError(403, "无权为其他 CDK 发起接码");
        }
        if (!db.prepare("SELECT 1 FROM accounts WHERE cdk_id=? AND email=? AND deleted_at IS NULL").get(id, input.email)) throw cdkError(409, "接码账号不属于当前 CDK");
        if (db.prepare("SELECT 1 FROM sms_pool_operations WHERE cdk_id=? AND job_id=? AND status NOT IN ('verified','released')").get(id, input.jobId)) throw cdkError(409, "此任务已有待完成的接码操作", "SMS_POOL_PENDING");
        // Limit concurrent provider requests in the pool scheduler. Waiting for
        // SMS or reconciling an earlier order must not block unrelated tasks.
        const fee = row.role === "admin" ? 0 : input.fee;
        if (!Number.isSafeInteger(fee) || fee < 0 || row.balance - row.reserved < fee) throw cdkError(409, "可用次数不足以使用接码池", "INSUFFICIENT_QUOTA");
        const operation = { ...input, ownerId: id, fee, state: "reserved", attempts: [], allocation: null, reason: "", evidence: null };
        const now = Date.now();
        db.prepare("UPDATE cdks SET reserved=reserved+? WHERE id=?").run(fee, id);
        db.prepare("INSERT INTO sms_pool_operations VALUES(?,?,?,?,?,?,?,?,?,?)").run(input.operationId, id, input.jobId, input.email, input.runId, "reserved", fee, vault.seal(operation, `sms-pool:${id}:${input.operationId}`), now, now);
        audit(input.actorId || id, "sms-pool-reserve", `${id}:${input.operationId}`, { jobId: input.jobId, fee, categoryId: input.categoryId || "legacy", categoryName: input.categoryName || "原接码池" });
        return readSmsOperation(id, input.operationId);
      });
    },
    updateSmsOperation(id, operationId, mutate) {
      return transaction(() => { const operation = readSmsOperation(id, operationId); if (!operation) throw cdkError(404, "接码操作不存在"); if (["verified", "released"].includes(operation.state)) return operation;
        const category = { categoryId: operation.categoryId, categoryName: operation.categoryName, categoryFeeVersion: operation.categoryFeeVersion, categoryFee: operation.categoryFee };
        const next = mutate(operation) || operation;
        if (category.categoryId) {
          if (next.categoryId !== category.categoryId) throw cdkError(409, "已有接码操作不能切换分类，请先结束原操作", "SMS_POOL_CATEGORY_CHANGED");
          Object.assign(next, category);
        }
        if (next.allocation?.order) {
          if (next.allocation.order.requestId) clearUnknownCost(`unknown-operation:${id}:${operationId}:${next.allocation.allocationId}`);
          if (next.allocation.order.requestId) clearUnknownCost(`legacy-missing:${id}:${operationId}:${next.allocation.allocationId}`);
          const index = (next.orderHistory ||= []).findIndex((item) => item.allocationId === next.allocation.allocationId);
          if (index < 0) next.orderHistory.push(next.allocation); else next.orderHistory[index] = next.allocation;
          recordCostOrder(next.allocation, { state: next.allocation.abandoned ? "abandoned" : next.state, createdAt: next.allocation.createdAt || next.createdAt, refundExpected: next.allocation.abandoned });
        }
        if (next.state === "unknown" && next.attempts?.at(-1)?.state === "order_unknown" && next.allocation?.allocationId !== next.attempts.at(-1).id) {
          const attempt = next.attempts.at(-1); recordCostOrder({ ...attempt, createdAt: attempt.startedAt }, { identity: `unknown-operation:${id}:${operationId}:${attempt.id}`, state: "purchase_unknown", createdAt: attempt.startedAt });
        }
        return writeSmsOperation(next); });
    },
    settleSmsOperation(id, operationId, { success = false, evidence = null, reason = "", actor = null } = {}) {
      return transaction(() => {
        const operation = readSmsOperation(id, operationId); if (!operation) throw cdkError(404, "接码操作不存在");
        if (["verified", "released"].includes(operation.state)) return operation;
        const fee = operation.fee;
        actor ||= operation.actorId || "recovery";
        if (success) {
          db.prepare("UPDATE cdks SET reserved=reserved-?,balance=balance-?,consumed=consumed+?,ever_consumed=CASE WHEN ?>0 THEN 1 ELSE ever_consumed END WHERE id=?").run(fee, fee, fee, fee, id);
          if (fee) ledger(id, "sms-pool", -fee, operationId, `接码池${operation.categoryName ? ` · ${operation.categoryName}` : ""}手机验证成功 ${fee} 次`, actor);
        } else db.prepare("UPDATE cdks SET reserved=reserved-? WHERE id=?").run(fee, id);
        operation.state = success ? "verified" : "released"; operation.evidence = evidence; operation.reason = String(reason).slice(0, 200); operation.settledAt = Date.now();
        if (operation.allocation?.order) recordCostOrder(operation.allocation, { state: operation.state, createdAt: operation.allocation.createdAt || operation.createdAt, refundExpected: !success,
          verified: success && !operation.allocation.abandoned, verifiedAt: evidence?.verifiedAt || operation.settledAt });
        const inventoryRows = db.prepare("SELECT * FROM sms_pool_inventory WHERE claim_owner=? AND claim_operation=? AND state IN ('assigned','checking')").all(id, operationId);
        for (const row of inventoryRows) { const item = readInventory(row); item.state = success ? "consumed" : "cancel_pending"; item.nextActionAt = success ? 0 : Math.max(Date.now(), item.cancelAllowedAt || 0); item.cancelState = success ? null : "pending"; writeInventory(item); }
        audit(actor, success ? "sms-pool-verified" : "sms-pool-released", `${id}:${operationId}`, { jobId: operation.jobId, fee, reason: operation.reason, categoryId: operation.categoryId || "legacy", categoryName: operation.categoryName || "原接码池" });
        return writeSmsOperation(operation);
      });
    },
    legacyUsed(id, email) { return Boolean(db.prepare("SELECT 1 FROM legacy_credentials WHERE cdk_id=? AND email=?").get(id, email.toLowerCase())); },
    markLegacyUsed(id, email) { db.prepare("INSERT INTO legacy_credentials VALUES(?,?,?) ON CONFLICT(cdk_id,email) DO NOTHING").run(id, email.toLowerCase(), Date.now()); },
    markLegacyUsedMany(id, emails) { if (emails.length) transaction(() => { for (const email of emails) store.markLegacyUsed(id, email); }); },
    readInitialSecret() { return transaction(() => { const value = setting(adminId, "initial-secret"); db.prepare("DELETE FROM settings WHERE cdk_id=? AND name='initial-secret'").run(adminId); return value?.secret || null; }); },
    generate({ count, quota, note, allowedSmsProviders: requestedProviders }, actor) {
      count = positiveInteger(count, "数量", 100); quota = positiveInteger(quota, "初始次数"); note = String(note || "").trim().slice(0, 160);
      const providers = requestedProviders === undefined ? ["custom"] : normalizeSmsPermissions(requestedProviders);
      if (requestedProviders !== undefined && get(actor)?.role !== "admin") throw cdkError(403, "需要管理员权限");
      return transaction(() => Array.from({ length: count }, () => {
        let secret; let hash;
        do { secret = randomSecret(); hash = secretHash(secret); } while (db.prepare("SELECT 1 FROM cdks WHERE secret_hash=?").get(hash));
        const id = crypto.randomUUID(); db.prepare("INSERT INTO cdks(id,secret_hash,label,role,balance,note,created_at) VALUES(?,?,?,'user',?,?,?)").run(id, hash, `TS2-••••-${secret.slice(-4)}`, quota, note, Date.now());
        saveSetting(id, "login-secret", { secret });
        saveSetting(id, "sms-permissions", { allowedSmsProviders: providers });
        ledger(id, "issue", quota, id, note || "初始发放", actor); audit(actor, "generate-cdk", id, { quota });
        return { ...publicCdk(get(id)), secret };
      }));
    },
    update(id, patch, actor) {
      return transaction(() => {
        const row = get(id); if (!row) throw cdkError(404, "CDK 不存在");
        if (Object.hasOwn(patch, "allowedSmsProviders")) {
          if (get(actor)?.role !== "admin") throw cdkError(403, "需要管理员权限");
          if (row.role === "admin") throw cdkError(409, "管理员始终拥有全部接码方式，无需配置");
          const providers = normalizeSmsPermissions(patch.allowedSmsProviders);
          saveSetting(id, "sms-permissions", { allowedSmsProviders: providers });
          audit(actor, "cdk-sms-permissions", id, { allowedSmsProviders: providers });
        }
        if (row.role === "admin" && patch.status && patch.status !== "active") throw cdkError(409, "不能禁用初始化管理员");
        if (row.status === "merged") throw cdkError(409, "已融合 CDK 不能重新启用或修改");
        if (patch.status === "disabled" && db.prepare("SELECT 1 FROM imports WHERE cdk_id=? AND status='pending'").get(id)) throw cdkError(409, "CDK 正在提交导入，请等待完成后再禁用");
        if (patch.status && !["active", "disabled"].includes(patch.status)) throw cdkError(422, "CDK 状态不正确");
        db.prepare("UPDATE cdks SET note=?,status=?,version=version+? WHERE id=?").run(Object.hasOwn(patch, "note") ? String(patch.note).slice(0, 160) : row.note, patch.status || row.status, patch.status && patch.status !== row.status ? 1 : 0, id);
        if (patch.status === "disabled") db.prepare("DELETE FROM sessions WHERE cdk_id=?").run(id);
        audit(actor, "update-cdk", id, { status: patch.status || row.status }); return publicCdk(get(id));
      });
    },
    rotate(id, actor) {
      return transaction(() => {
        const row = get(id); if (!row || row.status === "merged") throw cdkError(409, "不能轮换此 CDK");
        const secret = randomSecret(row.role === "admin" ? "TS2-ADMIN" : "TS2");
        db.prepare("UPDATE cdks SET secret_hash=?,label=?,version=version+1 WHERE id=?").run(secretHash(secret), `${row.role === "admin" ? "TS2-ADMIN" : "TS2"}-••••-${secret.slice(-4)}`, id);
        saveSetting(id, "login-secret", { secret });
        if (row.role === "admin") db.prepare("DELETE FROM settings WHERE cdk_id=? AND name='initial-secret'").run(id);
        db.prepare("DELETE FROM sessions WHERE cdk_id=?").run(id); audit(actor, "rotate-cdk", id); return { ...publicCdk(get(id)), secret };
      });
    },
    topup(id, amount, note, requestKey, actor) {
      amount = positiveInteger(amount, "追加次数"); note = String(note || "").trim().slice(0, 160);
      if (!note || !requestKey) throw cdkError(422, "追加需要备注和幂等标识");
      return transaction(() => {
        const row = get(id); if (!row || row.role !== "user" || row.status === "merged") throw cdkError(409, "不能为此 CDK 追加次数");
        const previous = db.prepare("SELECT delta,note FROM ledger WHERE cdk_id=? AND kind='topup' AND reference=?").get(id, requestKey);
        if (previous) { if (previous.delta !== amount || previous.note !== note) throw cdkError(409, "幂等标识对应内容已变化"); return publicCdk(row); }
        if (!Number.isSafeInteger(row.balance + amount)) throw cdkError(422, "追加后次数超过上限");
        db.prepare("UPDATE cdks SET balance=balance+? WHERE id=?").run(amount, id); ledger(id, "topup", amount, requestKey, note, actor); audit(actor, "topup", id, { amount }); return publicCdk(get(id));
      });
    },
    authenticate(secret) { if (typeof secret !== "string" || secret.length < 24 || secret.length > 200) return null; const row = db.prepare("SELECT * FROM cdks WHERE secret_hash=? AND status='active'").get(secretHash(secret)); return row ? publicCdk(row) : null; },
    rememberSecret(id, secret) {
      return transaction(() => {
        const row = requireActive(id);
        if (typeof secret !== "string" || secret.length < 24 || secret.length > 200 || secretHash(secret) !== row.secret_hash) throw cdkError(401, "CDK 无效或不可用", "INVALID_CDK");
        const previous = setting(id, "login-secret");
        if (previous?.secret !== secret) saveSetting(id, "login-secret", { secret });
      });
    },
    revealSecret(id, actor) {
      const identity = requireActive(actor); const row = requireActive(id);
      if (identity.id !== row.id && identity.role !== "admin") throw cdkError(403, "只能查看当前 CDK");
      const stored = setting(id, "login-secret");
      if (!stored?.secret || secretHash(stored.secret) !== row.secret_hash) throw cdkError(409, "此 CDK 来自旧版本，请验证当前 CDK 一次，之后即可查看", "CDK_SECRET_UNAVAILABLE");
      audit(actor, "reveal-current-cdk", id);
      return stored.secret;
    },
    createSession(id) {
      const row = requireActive(id); const secret = crypto.randomBytes(32).toString("base64url"); const csrf = crypto.randomBytes(24).toString("base64url"); const now = Date.now();
      db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?)").run(secretHash(secret), id, id, csrf, row.version, now, now, now + 24 * 60 * 60_000);
      db.prepare("UPDATE cdks SET last_login=? WHERE id=?").run(now, id); return { secret, csrf };
    },
    session(secret) {
      if (!secret || secret.length > 200) return null;
      const session = db.prepare("SELECT * FROM sessions WHERE id_hash=?").get(secretHash(secret)); if (!session) return null;
      const owner = get(session.cdk_id); const workspace = get(session.workspace_id); const now = Date.now();
      if (!owner || owner.status !== "active" || owner.version !== session.version || session.expires_at <= now || session.last_seen + 2 * 60 * 60_000 <= now) { db.prepare("DELETE FROM sessions WHERE id_hash=?").run(session.id_hash); return null; }
      if (!workspace || workspace.status !== "active") {
        if (owner.role !== "admin") { db.prepare("DELETE FROM sessions WHERE id_hash=?").run(session.id_hash); return null; }
        db.prepare("UPDATE sessions SET workspace_id=?,csrf=? WHERE id_hash=?").run(owner.id, crypto.randomBytes(24).toString("base64url"), session.id_hash);
        return store.session(secret);
      }
      if (now - session.last_seen > 30_000) db.prepare("UPDATE sessions SET last_seen=? WHERE id_hash=?").run(now, session.id_hash);
      return { ...session, actor: publicCdk(owner), workspace: publicCdk(workspace) };
    },
    logout(session) { db.prepare("DELETE FROM sessions WHERE id_hash=?").run(session.id_hash); },
    switchWorkspace(session, id) {
      if (session.actor.role !== "admin" && id !== session.actor.id) throw cdkError(403, "无权切换其他 CDK");
      requireActive(id); const csrf = crypto.randomBytes(24).toString("base64url"); db.prepare("UPDATE sessions SET workspace_id=?,csrf=? WHERE id_hash=?").run(id, csrf, session.id_hash); audit(session.actor.id, "switch-workspace", id); return csrf;
    },
    inventory(id, emails, { historical = false } = {}) {
      transaction(() => { for (const email of emails) db.prepare("INSERT INTO accounts VALUES(?,?,?,NULL) ON CONFLICT(cdk_id,email) DO UPDATE SET deleted_at=NULL").run(id, email.toLowerCase(), Date.now()); });
      if (historical) audit("local", "restore-inventory", id, { count: emails.length });
    },
    syncInventory(id, emails) {
      transaction(() => {
        db.prepare("UPDATE accounts SET deleted_at=? WHERE cdk_id=? AND deleted_at IS NULL").run(Date.now(), id);
        for (const email of emails) db.prepare("INSERT INTO accounts VALUES(?,?,?,NULL) ON CONFLICT(cdk_id,email) DO UPDATE SET deleted_at=NULL").run(id, email.toLowerCase(), Date.now());
      });
    },
    preview(id, emails) {
      const row = requireActive(id); const unique = [...new Set(emails.map((email) => email.trim().toLowerCase()))];
      const added = unique.filter((email) => !db.prepare("SELECT 1 FROM accounts WHERE cdk_id=? AND email=?").get(id, email));
      const charge = row.role === "admin" ? 0 : added.length;
      return { count: unique.length, added: added.length, updated: unique.length - added.length, charge, balance: row.role === "admin" ? null : row.balance - row.reserved, after: row.role === "admin" ? null : row.balance - row.reserved - charge, canImport: row.role === "admin" || row.balance - row.reserved >= charge };
    },
    prepareImport(id, mode, emails, body, requestKey, actorId = id) {
      if (!requestKey || requestKey.length > 120) throw cdkError(422, "导入缺少有效幂等标识");
      return transaction(() => {
        const digest = vault.fingerprint(JSON.stringify({ mode, body }));
        const previous = db.prepare("SELECT * FROM imports WHERE cdk_id=? AND request_key=?").get(id, requestKey);
        if (previous) { if (previous.digest !== digest) throw cdkError(409, "幂等标识对应的导入内容不同"); return previous; }
        const quote = store.preview(id, emails); if (!quote.canImport) throw cdkError(409, "可用导入次数不足", "INSUFFICIENT_QUOTA");
        const requestId = crypto.randomUUID(); const now = Date.now();
        db.prepare("UPDATE cdks SET reserved=reserved+? WHERE id=?").run(quote.charge, id);
        db.prepare("INSERT INTO imports(id,cdk_id,request_key,digest,mode,status,charge,emails,payload,result,created_at,actor_id) VALUES(?,?,?,?,?,'pending',?,?,?,?,?,?)").run(requestId, id, requestKey, digest, mode, quote.charge, JSON.stringify([...new Set(emails.map((email) => email.toLowerCase()))]), vault.seal(body, `import:${requestId}`), null, now, actorId);
        return db.prepare("SELECT * FROM imports WHERE id=?").get(requestId);
      });
    },
    findImport(id, mode, body, requestKey) {
      const row = db.prepare("SELECT * FROM imports WHERE cdk_id=? AND request_key=?").get(id, requestKey);
      if (row && row.digest !== vault.fingerprint(JSON.stringify({ mode, body }))) throw cdkError(409, "幂等标识对应的导入内容不同");
      return row || null;
    },
    importPayload(record) { return vault.open(record.payload, `import:${record.id}`); },
    pendingImports: () => db.prepare("SELECT * FROM imports WHERE status='pending' ORDER BY created_at").all(),
    finishImport(record, result, actor) {
      return transaction(() => {
        const current = db.prepare("SELECT * FROM imports WHERE id=?").get(record.id); if (current.status === "completed") return JSON.parse(current.result);
        requireActive(record.cdk_id);
        for (const email of JSON.parse(record.emails)) db.prepare("INSERT INTO accounts VALUES(?,?,?,NULL) ON CONFLICT(cdk_id,email) DO UPDATE SET deleted_at=NULL").run(record.cdk_id, email, Date.now());
        db.prepare("UPDATE cdks SET reserved=reserved-?,balance=balance-?,consumed=consumed+?,ever_consumed=CASE WHEN ?>0 THEN 1 ELSE ever_consumed END WHERE id=?").run(record.charge, record.charge, record.charge, record.charge, record.cdk_id);
        if (record.charge) ledger(record.cdk_id, "import", -record.charge, record.id, `新增账号导入 ${record.charge} 次`, actor);
        const payload = JSON.stringify(result); db.prepare("UPDATE imports SET status='completed',payload=NULL,result=? WHERE id=?").run(payload, record.id); return result;
      });
    },
    abortImport(record) { transaction(() => { const current = db.prepare("SELECT * FROM imports WHERE id=?").get(record.id); if (current?.status !== "pending") return; db.prepare("UPDATE cdks SET reserved=reserved-? WHERE id=?").run(current.charge, current.cdk_id); db.prepare("DELETE FROM imports WHERE id=?").run(record.id); }); },
    deleted(id, emails) { transaction(() => { for (const email of emails) db.prepare("UPDATE accounts SET deleted_at=? WHERE cdk_id=? AND email=?").run(Date.now(), id, email.toLowerCase()); }); },
    ledger(id = null) {
      const rows = id ? db.prepare("SELECT * FROM ledger WHERE cdk_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200").all(id) : db.prepare("SELECT * FROM ledger ORDER BY created_at DESC,rowid DESC LIMIT 200").all();
      return rows.map((row) => ({ id: row.id, cdkId: row.cdk_id, label: get(row.cdk_id)?.label, kind: row.kind, delta: row.delta, balance: row.balance, note: row.note, actorId: row.actor, at: new Date(row.created_at).toISOString() }));
    },
    mergePreview(targetId, secret) {
      const target = requireActive(targetId); const source = store.authenticate(secret);
      if (!source) throw cdkError(400, "CDK 无效或不可用", "INVALID_CDK");
      if (target.role !== "user" || source.role !== "user") throw cdkError(409, "管理员 CDK 不参与次数融合");
      if (target.id === source.id) throw cdkError(409, "不能融合当前 CDK");
      if (source.everConsumed || source.consumed > 0) throw cdkError(409, "来源 CDK 曾消耗过次数，无法融合");
      if (db.prepare("SELECT 1 FROM sms_pool_operations WHERE cdk_id=? AND status NOT IN ('verified','released')").get(source.id)) throw cdkError(409, "来源 CDK 有未完成的接码操作，请稍后重试");
      if (source.reserved || db.prepare("SELECT 1 FROM imports WHERE cdk_id=? AND status='pending'").get(source.id)) throw cdkError(409, "来源 CDK 有未完成的导入，请稍后重试");
      if (source.balance <= 0) throw cdkError(409, "来源 CDK 没有剩余次数");
      return { sourceId: source.id, sourceLabel: source.label, amount: source.balance, before: target.balance - target.reserved, after: target.balance - target.reserved + source.balance, fingerprint: vault.fingerprint(secret) };
    },
    merge(targetId, secret, requestKey, expectedFingerprint, expectedAmount) {
      if (!requestKey) throw cdkError(422, "融合缺少幂等标识");
      return transaction(() => {
        const previous = db.prepare("SELECT * FROM merges WHERE target_id=? AND request_key=?").get(targetId, requestKey);
        if (previous) {
          const source = db.prepare("SELECT id FROM cdks WHERE secret_hash=?").get(secretHash(secret));
          if (source?.id !== previous.source_id) throw cdkError(409, "融合幂等标识对应来源不同");
          return { amount: previous.amount, cdk: publicCdk(get(targetId)) };
        }
        const quote = store.mergePreview(targetId, secret);
        if (quote.fingerprint !== expectedFingerprint) throw cdkError(409, "来源已变化，请重新验证融合资格");
        if (expectedAmount !== undefined && quote.amount !== expectedAmount) throw cdkError(409, "来源余额已变化，请重新验证融合资格");
        if (!Number.isSafeInteger(get(targetId).balance + quote.amount)) throw cdkError(422, "融合后次数超过上限");
        const id = crypto.randomUUID(); db.prepare("UPDATE cdks SET balance=balance+? WHERE id=?").run(quote.amount, targetId);
        db.prepare("UPDATE cdks SET balance=0,status='merged',merged_into=?,version=version+1 WHERE id=?").run(targetId, quote.sourceId);
        db.prepare("DELETE FROM sessions WHERE cdk_id=?").run(quote.sourceId);
        db.prepare("INSERT INTO merges VALUES(?,?,?,?,?,?)").run(id, quote.sourceId, targetId, quote.amount, requestKey, Date.now());
        ledger(targetId, "merge-in", quote.amount, id, `来自 ${quote.sourceLabel}`, targetId); ledger(quote.sourceId, "merge-out", -quote.amount, id, "融合转出，源 CDK 已作废", targetId); audit(targetId, "merge", quote.sourceId, { amount: quote.amount });
        return { amount: quote.amount, cdk: publicCdk(get(targetId)) };
      });
    },
    rules() { return { ...DEFAULT_RULES, ...(setting(adminId, "security-rules") || {}) }; },
    setRules(value, actor) {
      const rules = {}; for (const key of Object.keys(DEFAULT_RULES)) rules[key] = positiveInteger(value[key], key, key === "ratePerMinute" ? 10000 : 3650);
      if (rules.warnFailures > rules.banFailures) throw cdkError(422, "告警次数不能高于封禁次数");
      saveSetting(adminId, "security-rules", rules); audit(actor, "security-rules", "system", rules); return rules;
    },
    activeBan(ip) { return db.prepare("SELECT * FROM ip_bans WHERE ip=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC LIMIT 1").get(ip, Date.now()) || null; },
    checkVerification(ip) {
      const rules = store.rules(); const now = Date.now();
      if (store.activeBan(ip)) throw cdkError(403, "当前 IP 已被封禁，请联系管理员或等待解除", "IP_BLOCKED");
      const perIp = db.prepare("SELECT COUNT(*) AS count FROM verification_attempts WHERE ip=? AND created_at>?").get(ip, now - 60000).count;
      const global = db.prepare("SELECT COUNT(*) AS count FROM verification_attempts WHERE created_at>?").get(now - 60000).count;
      if (perIp >= rules.ratePerMinute || global >= Math.max(300, rules.ratePerMinute * 50)) throw cdkError(429, "验证请求过于频繁，请稍后重试");
      const result = db.prepare("INSERT INTO verification_attempts(ip,created_at) VALUES(?,?)").run(ip, now); return Number(result.lastInsertRowid);
    },
    failedVerification(ip, entry, secret, attemptId) {
      const rules = store.rules(); const now = Date.now();
      db.prepare("UPDATE verification_attempts SET failed=1 WHERE id=? AND ip=?").run(attemptId, ip);
      const count = db.prepare("SELECT COUNT(*) AS count FROM verification_attempts WHERE ip=? AND failed=1 AND created_at>?").get(ip, now - rules.failureWindowMinutes * 60000).count;
      const window = Math.floor(now / (rules.failureWindowMinutes * 60000)) * rules.failureWindowMinutes * 60000;
      db.prepare("INSERT INTO security_events VALUES(?,?,?,?,?,1,?,?,?,?) ON CONFLICT(ip,entry,window_start) DO UPDATE SET count=count+1,last_at=excluded.last_at,unread=MAX(unread,excluded.unread),result=excluded.result").run(crypto.randomUUID(), ip, entry, vault.fingerprint(secret), window, now, now, count >= rules.warnFailures ? 1 : 0, count >= rules.banFailures ? "自动封禁" : count >= rules.warnFailures ? "待处理" : "记录验证失败");
      if (count >= rules.banFailures && !store.activeBan(ip)) {
        const previous = db.prepare("SELECT COUNT(*) AS count FROM ip_bans WHERE ip=? AND source='auto' AND created_at>?").get(ip, now - rules.escalationHours * 60 * 60000).count;
        const minutes = previous + 1 >= rules.escalationCount ? rules.escalationHours * 60 : rules.banMinutes;
        store.ban(ip, minutes, "验证失败达到封禁阈值", "system", "auto");
      }
    },
    events() { return db.prepare("SELECT * FROM security_events ORDER BY last_at DESC LIMIT 200").all().map((row) => ({ id: row.id, ip: row.ip, entry: row.entry, count: row.count, unread: Boolean(row.unread), result: row.result, at: new Date(row.last_at).toISOString(), blocked: Boolean(store.activeBan(row.ip)) })); },
    readEvent(id, actor) { db.prepare("UPDATE security_events SET unread=0 WHERE id=?").run(id); audit(actor, "read-security-event", id); },
    ban(ip, minutes, reason, actor, source = "manual") {
      ip = normalizeClientIp(ip); if (!ip) throw cdkError(422, "IP 地址格式不正确");
      reason = String(reason || "").trim().slice(0, 200); if (!reason) throw cdkError(422, "请填写封禁原因");
      if (minutes !== null) minutes = positiveInteger(minutes, "封禁分钟数", 525600);
      return transaction(() => {
        if (store.activeBan(ip)) throw cdkError(409, "该 IP 已在黑名单内");
        const id = crypto.randomUUID(); const now = Date.now();
        db.prepare("INSERT INTO ip_bans VALUES(?,?,?,?,?,?,?,NULL)").run(id, ip, source, reason, actor, now, minutes === null ? null : now + minutes * 60000);
        audit(actor, "ban-ip", ip, { minutes, source }); return id;
      });
    },
    bans() { return db.prepare("SELECT * FROM ip_bans ORDER BY created_at DESC LIMIT 200").all().map((row) => ({ id: row.id, ip: row.ip, source: row.source, reason: row.reason, actor: row.actor, createdAt: new Date(row.created_at).toISOString(), expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null, active: !row.revoked_at && (!row.expires_at || row.expires_at > Date.now()) })); },
    unban(id, actor) { const row = db.prepare("SELECT * FROM ip_bans WHERE id=?").get(id); if (!row) throw cdkError(404, "封禁记录不存在"); db.prepare("UPDATE ip_bans SET revoked_at=COALESCE(revoked_at,?) WHERE id=?").run(Date.now(), id); audit(actor, "unban-ip", row.ip); },
    bindRemote(id, backend, remoteId, email) { db.prepare("INSERT INTO sub2api_bindings VALUES(?,?,?,?) ON CONFLICT(cdk_id,backend,remote_id) DO UPDATE SET email=excluded.email").run(id, backend, String(remoteId), email.toLowerCase()); },
    getRemoteBindings(id, backend, email) {
      return db.prepare("SELECT remote_id,email FROM sub2api_bindings WHERE cdk_id=? AND backend=? AND email=? ORDER BY remote_id").all(id, backend, email.toLowerCase())
        .map((row) => ({ remoteId: Number(row.remote_id), email: row.email }));
    },
    replaceRemoteBinding(id, backend, remoteId, email) {
      const normalizedEmail = email.trim().toLowerCase();
      transaction(() => {
        db.prepare("DELETE FROM sub2api_bindings WHERE cdk_id=? AND backend=? AND email=?").run(id, backend, normalizedEmail);
        store.bindRemote(id, backend, remoteId, normalizedEmail);
      });
    },
    remoteBound(id, backend, remoteId) { return Boolean(db.prepare("SELECT 1 FROM sub2api_bindings WHERE cdk_id=? AND backend=? AND remote_id=?").get(id, backend, String(remoteId))); },
    cleanup() { const now = Date.now(); const rules = store.rules(); db.prepare("DELETE FROM sessions WHERE expires_at<? OR last_seen<?").run(now, now - 2 * 60 * 60000); db.prepare("DELETE FROM verification_attempts WHERE created_at<?").run(now - Math.max(24 * 60, rules.failureWindowMinutes) * 60000); db.prepare("DELETE FROM security_events WHERE last_at<?").run(now - rules.retentionDays * 86400000); },
    close: () => db.close(),
  };
  return store;
}
