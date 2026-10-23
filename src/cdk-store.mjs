import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cdkError, normalizeClientIp, positiveInteger, randomSecret, secretHash } from "./cdk-security.mjs";

const DEFAULT_RULES = { ratePerMinute: 30, warnFailures: 5, banFailures: 10, failureWindowMinutes: 10, banMinutes: 30, escalationCount: 3, escalationHours: 24, retentionDays: 30 };

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
    CREATE INDEX IF NOT EXISTS ledger_owner_time ON ledger(cdk_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS attempts_ip_time ON verification_attempts(ip,created_at);
    CREATE INDEX IF NOT EXISTS security_time ON security_events(last_at DESC);
    CREATE INDEX IF NOT EXISTS bans_ip ON ip_bans(ip,revoked_at,expires_at);
  `);
  const transaction = (operation) => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const get = (id) => db.prepare("SELECT * FROM cdks WHERE id=?").get(id);
  const audit = (actor, action, target, detail = {}) => db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)").run(crypto.randomUUID(), actor, action, target, JSON.stringify(detail), Date.now());
  const ledger = (id, kind, delta, reference, note, actor) => db.prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?,?)").run(crypto.randomUUID(), id, kind, delta, get(id).balance, reference, note, actor, Date.now());
  const publicCdk = (row) => row ? { id: row.id, label: row.label, role: row.role, status: row.status, balance: row.balance - row.reserved, reserved: row.reserved, consumed: row.consumed, everConsumed: Boolean(row.ever_consumed), note: row.note, createdAt: new Date(row.created_at).toISOString(), lastLogin: row.last_login ? new Date(row.last_login).toISOString() : null, accounts: db.prepare("SELECT COUNT(*) AS total FROM accounts WHERE cdk_id=? AND deleted_at IS NULL").get(row.id).total } : null;
  const requireActive = (id) => { const row = get(id); if (!row || row.status !== "active") throw cdkError(403, "CDK 已失效或被禁用"); return row; };
  const setting = (id, name) => { const row = db.prepare("SELECT value FROM settings WHERE cdk_id=? AND name=?").get(id, name); return row ? vault.open(row.value, `${id}:${name}`) : null; };
  const saveSetting = (id, name, value) => db.prepare("INSERT INTO settings VALUES(?,?,?,?) ON CONFLICT(cdk_id,name) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").run(id, name, vault.seal(value, `${id}:${name}`), Date.now());
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
  if (!setting(adminId, "login-secret")) {
    const initial = setting(adminId, "initial-secret");
    if (initial?.secret && secretHash(initial.secret) === administrator.secret_hash) saveSetting(adminId, "login-secret", initial);
  }
  await fs.writeFile(path.join(directory, "database.marker"), "1\n", { mode: 0o600, flag: "wx" }).catch((error) => { if (error.code !== "EEXIST") throw error; });
  const store = {
    adminId, publicCdk,
    get: (id) => publicCdk(get(id)),
    list: () => db.prepare("SELECT * FROM cdks ORDER BY role,created_at DESC").all().map(publicCdk),
    rawIds: () => db.prepare("SELECT id,role,status FROM cdks").all(),
    setting, saveSetting, audit,
    legacyUsed(id, email) { return Boolean(db.prepare("SELECT 1 FROM legacy_credentials WHERE cdk_id=? AND email=?").get(id, email.toLowerCase())); },
    markLegacyUsed(id, email) { db.prepare("INSERT INTO legacy_credentials VALUES(?,?,?) ON CONFLICT(cdk_id,email) DO NOTHING").run(id, email.toLowerCase(), Date.now()); },
    readInitialSecret() { return transaction(() => { const value = setting(adminId, "initial-secret"); db.prepare("DELETE FROM settings WHERE cdk_id=? AND name='initial-secret'").run(adminId); return value?.secret || null; }); },
    generate({ count, quota, note }, actor) {
      count = positiveInteger(count, "数量", 100); quota = positiveInteger(quota, "初始次数"); note = String(note || "").trim().slice(0, 160);
      return transaction(() => Array.from({ length: count }, () => {
        let secret; let hash;
        do { secret = randomSecret(); hash = secretHash(secret); } while (db.prepare("SELECT 1 FROM cdks WHERE secret_hash=?").get(hash));
        const id = crypto.randomUUID(); db.prepare("INSERT INTO cdks(id,secret_hash,label,role,balance,note,created_at) VALUES(?,?,?,'user',?,?,?)").run(id, hash, `TS2-••••-${secret.slice(-4)}`, quota, note, Date.now());
        saveSetting(id, "login-secret", { secret });
        ledger(id, "issue", quota, id, note || "初始发放", actor); audit(actor, "generate-cdk", id, { quota });
        return { ...publicCdk(get(id)), secret };
      }));
    },
    update(id, patch, actor) {
      return transaction(() => {
        const row = get(id); if (!row) throw cdkError(404, "CDK 不存在");
        if (row.role === "admin" && patch.status && patch.status !== "active") throw cdkError(409, "不能禁用初始化管理员");
        if (row.status === "merged") throw cdkError(409, "已融合 CDK 不能重新启用或修改");
        if (patch.status === "disabled" && row.reserved > 0) throw cdkError(409, "CDK 正在提交导入，请等待完成后再禁用");
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
    prepareImport(id, mode, emails, body, requestKey) {
      if (!requestKey || requestKey.length > 120) throw cdkError(422, "导入缺少有效幂等标识");
      return transaction(() => {
        const digest = vault.fingerprint(JSON.stringify({ mode, body }));
        const previous = db.prepare("SELECT * FROM imports WHERE cdk_id=? AND request_key=?").get(id, requestKey);
        if (previous) { if (previous.digest !== digest) throw cdkError(409, "幂等标识对应的导入内容不同"); return previous; }
        const quote = store.preview(id, emails); if (!quote.canImport) throw cdkError(409, "可用导入次数不足", "INSUFFICIENT_QUOTA");
        const requestId = crypto.randomUUID(); const now = Date.now();
        db.prepare("UPDATE cdks SET reserved=reserved+? WHERE id=?").run(quote.charge, id);
        db.prepare("INSERT INTO imports VALUES(?,?,?,?,?,'pending',?,?,?,?,?)").run(requestId, id, requestKey, digest, mode, quote.charge, JSON.stringify([...new Set(emails.map((email) => email.toLowerCase()))]), vault.seal(body, `import:${requestId}`), null, now);
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
      return rows.map((row) => ({ id: row.id, cdkId: row.cdk_id, label: get(row.cdk_id)?.label, kind: row.kind, delta: row.delta, balance: row.balance, note: row.note, at: new Date(row.created_at).toISOString() }));
    },
    mergePreview(targetId, secret) {
      const target = requireActive(targetId); const source = store.authenticate(secret);
      if (!source) throw cdkError(400, "CDK 无效或不可用", "INVALID_CDK");
      if (target.role !== "user" || source.role !== "user") throw cdkError(409, "管理员 CDK 不参与次数融合");
      if (target.id === source.id) throw cdkError(409, "不能融合当前 CDK");
      if (source.everConsumed || source.consumed > 0) throw cdkError(409, "来源 CDK 曾消耗过次数，无法融合");
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
    remoteBound(id, backend, remoteId) { return Boolean(db.prepare("SELECT 1 FROM sub2api_bindings WHERE cdk_id=? AND backend=? AND remote_id=?").get(id, backend, String(remoteId))); },
    cleanup() { const now = Date.now(); const rules = store.rules(); db.prepare("DELETE FROM sessions WHERE expires_at<? OR last_seen<?").run(now, now - 2 * 60 * 60000); db.prepare("DELETE FROM verification_attempts WHERE created_at<?").run(now - Math.max(24 * 60, rules.failureWindowMinutes) * 60000); db.prepare("DELETE FROM security_events WHERE last_at<?").run(now - rules.retentionDays * 86400000); },
    close: () => db.close(),
  };
  return store;
}
