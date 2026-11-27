import crypto from "node:crypto";
import { cdkError, secretHash } from "./cdk-security.mjs";

export const ADMIN_EMAIL = "jczheng666@gmail.com";
export const DEVICE_TTL = 30 * 86400000;
const OTP_TTL = 5 * 60000;
const PENDING_TTL = 10 * 60000;
const random = () => crypto.randomBytes(32).toString("base64url");
export function normalizeLoginEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(email) || email.split("@")[0].length > 64) throw cdkError(422, "请输入有效的邮箱地址");
  return email;
}
export function maskLoginEmail(email) {
  if (!email) return null;
  const [name, domain] = email.split("@");
  return `${name.slice(0, 2)}***@${domain}`;
}

export function createCdkEmailAuth({ db, vault, createSession, now = () => Date.now() }) {
  const columns = new Set(db.prepare("PRAGMA table_info(cdks)").all().map((column) => column.name));
  for (const [name, type] of [["bound_email", "TEXT"], ["email_bound_at", "INTEGER"], ["email_verified_at", "INTEGER"]]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE cdks ADD COLUMN ${name} ${type}`);
  }
  if (!db.prepare("PRAGMA table_info(sessions)").all().some((column) => column.name === "device_id")) db.exec("ALTER TABLE sessions ADD COLUMN device_id TEXT");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS cdk_unique_bound_email ON cdks(bound_email) WHERE bound_email IS NOT NULL;
    CREATE TABLE IF NOT EXISTS login_challenges (id_hash TEXT PRIMARY KEY,cdk_id TEXT NOT NULL REFERENCES cdks(id),version INTEGER NOT NULL,csrf TEXT NOT NULL,original_email TEXT,email TEXT,code_hash TEXT,generation TEXT,code_expires_at INTEGER,code_sent INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,ip TEXT NOT NULL,user_agent TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_email_sends (id TEXT PRIMARY KEY,cdk_id TEXT NOT NULL,email TEXT NOT NULL,ip TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS login_email_sends_time ON login_email_sends(created_at);
    CREATE TABLE IF NOT EXISTS login_email_failures (cdk_id TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS login_email_failures_time ON login_email_failures(cdk_id,created_at);
    CREATE TABLE IF NOT EXISTS trusted_devices (id TEXT PRIMARY KEY,cdk_id TEXT NOT NULL REFERENCES cdks(id),token_hash TEXT NOT NULL,version INTEGER NOT NULL,user_agent TEXT NOT NULL,created_at INTEGER NOT NULL,last_seen INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER,UNIQUE(cdk_id,token_hash));
    CREATE INDEX IF NOT EXISTS trusted_devices_owner ON trusted_devices(cdk_id);`);
  db.prepare("UPDATE cdks SET bound_email=?,email_bound_at=? WHERE role='admin' AND bound_email IS NULL").run(ADMIN_EMAIL, now());
  const transaction = (fn) => { db.exec("BEGIN IMMEDIATE"); try { const value = fn(); db.exec("COMMIT"); return value; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const owner = (id) => db.prepare("SELECT * FROM cdks WHERE id=?").get(id);
  const audit = (id, action, target = id) => db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)").run(crypto.randomUUID(), id, action, target, "{}", now());
  const pending = (token) => {
    const row = typeof token === "string" && token.length <= 200 ? db.prepare("SELECT * FROM login_challenges WHERE id_hash=?").get(secretHash(token)) : null;
    const cdk = row && owner(row.cdk_id);
    if (!row || row.expires_at <= now() || !cdk || cdk.status !== "active" || cdk.version !== row.version || cdk.bound_email !== row.original_email) throw cdkError(401, "登录验证已过期，请重新输入 CDK", "AUTH_CHALLENGE_EXPIRED");
    return row;
  };
  const retryAt = (id) => (db.prepare("SELECT MAX(created_at) AS at FROM login_email_sends WHERE cdk_id=?").get(id)?.at || 0) + 60000;
  const publicChallenge = (row) => ({ authenticated: false, authState: row.original_email ? "verify_email" : "bind_email", token: row.csrf,
    email: maskLoginEmail(row.original_email || row.email), codeSent: Boolean(row.code_sent), expiresAt: row.expires_at,
    codeExpiresAt: row.code_expires_at, retryAt: retryAt(row.cdk_id) });
  const validDevice = (cdkId, token) => {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const cdk = owner(cdkId);
    if (!cdk?.bound_email || !cdk.email_verified_at || cdk.status !== "active") return null;
    return db.prepare("SELECT * FROM trusted_devices WHERE cdk_id=? AND token_hash=? AND version=? AND revoked_at IS NULL AND expires_at>?").get(cdkId, secretHash(token), cdk.version, now()) || null;
  };
  return {
    begin(id, ip, userAgent = "") {
      return transaction(() => {
        const cdk = owner(id); if (!cdk || cdk.status !== "active") throw cdkError(401, "CDK 不可用");
        const token = random(); const csrf = random();
        db.prepare("DELETE FROM login_challenges WHERE expires_at<=?").run(now());
        const count = db.prepare("SELECT COUNT(*) AS n FROM login_challenges WHERE cdk_id=?").get(id).n;
        if (count >= 20) throw cdkError(429, "登录请求过多，请稍后重试");
        db.prepare("INSERT INTO login_challenges(id_hash,cdk_id,version,csrf,original_email,ip,user_agent,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)")
          .run(secretHash(token), id, cdk.version, csrf, cdk.bound_email, ip, String(userAgent).slice(0, 300), now(), now() + PENDING_TTL);
        return { secret: token, ...publicChallenge(pending(token)) };
      });
    },
    challenge: (token) => publicChallenge(pending(token)),
    checkCsrf(token, supplied) {
      const row = pending(token);
      if (typeof supplied !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(row.csrf))) throw cdkError(403, "验证页面已失效，请重新登录", "CSRF_INVALID");
    },
    cancel(token) { if (token) db.prepare("DELETE FROM login_challenges WHERE id_hash=?").run(secretHash(token)); },
    prepareSend(token, requestedEmail, ip) {
      return transaction(() => {
        const row = pending(token);
        if (row.failures >= 5) throw cdkError(429, "验证码错误次数过多，请重新登录", "OTP_ATTEMPTS_EXHAUSTED");
        const email = row.original_email || normalizeLoginEmail(requestedEmail || row.email);
        if (db.prepare("SELECT 1 FROM cdks WHERE bound_email=? AND id<>?").get(email, row.cdk_id)) throw cdkError(409, "此邮箱已绑定其他 CDK，请登录原账号后融合未绑定的次数卡");
        if (retryAt(row.cdk_id) > now()) throw cdkError(429, "发送过于频繁，请间隔 60 秒重试");
        const counts = db.prepare("SELECT SUM(cdk_id=?) AS account,SUM(email=?) AS mailbox,SUM(ip=?) AS address,COUNT(*) AS total FROM login_email_sends WHERE created_at>?").get(row.cdk_id, email, ip, now() - 3600000);
        if (counts.account >= 10 || counts.mailbox >= 10 || counts.address >= 30 || counts.total >= 300) throw cdkError(429, "验证码发送次数过多，请稍后重试");
        const failures = db.prepare("SELECT COUNT(*) AS n FROM login_email_failures WHERE cdk_id=? AND created_at>?").get(row.cdk_id, now() - PENDING_TTL).n;
        if (failures >= 10) throw cdkError(429, "验证码错误次数过多，请稍后重试");
        const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0"); const generation = random();
        const hash = vault.fingerprint(`login-email:${row.id_hash}:${generation}:${code}`);
        db.prepare("UPDATE login_challenges SET email=?,code_hash=?,generation=?,code_expires_at=?,code_sent=0 WHERE id_hash=?").run(email, hash, generation, now() + OTP_TTL, row.id_hash);
        db.prepare("INSERT INTO login_email_sends VALUES(?,?,?,?,?)").run(crypto.randomUUID(), row.cdk_id, email, ip, now());
        return { email, code, generation, purpose: row.original_email ? "新设备登录验证" : "首次绑定邮箱" };
      });
    },
    sent(token, generation, success) {
      db.prepare("UPDATE login_challenges SET code_sent=?,code_hash=CASE WHEN ? THEN code_hash ELSE NULL END WHERE id_hash=? AND generation=?").run(success ? 1 : 0, success ? 1 : 0, secretHash(token), generation);
    },
    verify(token, code) {
      const row = pending(token);
      if (db.prepare("SELECT COUNT(*) AS n FROM login_email_failures WHERE cdk_id=? AND created_at>?").get(row.cdk_id, now() - PENDING_TTL).n >= 10) throw cdkError(429, "验证码错误次数过多，请稍后重试");
      if (row.failures >= 5) throw cdkError(429, "验证码错误次数过多，请重新登录", "OTP_ATTEMPTS_EXHAUSTED");
      if (!row.code_sent || !row.code_hash) throw cdkError(409, "请先发送邮箱验证码");
      if (row.code_expires_at <= now()) throw cdkError(410, "验证码已过期，请重新发送", "OTP_EXPIRED");
      const expected = vault.fingerprint(`login-email:${row.id_hash}:${row.generation}:${String(code || "")}`);
      if (!/^\d{6}$/.test(String(code || "")) || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(row.code_hash))) {
        db.prepare("UPDATE login_challenges SET failures=failures+1 WHERE id_hash=?").run(row.id_hash);
        db.prepare("INSERT INTO login_email_failures VALUES(?,?)").run(row.cdk_id, now());
        throw cdkError(400, "验证码不正确，请重新输入", "OTP_INVALID");
      }
      return transaction(() => {
        const fresh = pending(token);
        if (fresh.generation !== row.generation) throw cdkError(409, "验证码已更新，请使用最新验证码");
        if (!fresh.original_email) {
          if (db.prepare("SELECT 1 FROM cdks WHERE bound_email=?").get(fresh.email)) throw cdkError(409, "此邮箱已绑定其他 CDK");
          db.prepare("UPDATE cdks SET bound_email=?,email_bound_at=?,email_verified_at=? WHERE id=? AND bound_email IS NULL").run(fresh.email, now(), now(), fresh.cdk_id);
          audit(fresh.cdk_id, "bind-login-email");
        } else db.prepare("UPDATE cdks SET email_verified_at=? WHERE id=?").run(now(), fresh.cdk_id);
        // Reverification always rotates the credential, including after a previous revocation.
        const secret = random();
        const device = crypto.randomUUID();
        db.prepare("INSERT INTO trusted_devices VALUES(?,?,?,?,?,?,?,?,NULL) ON CONFLICT(cdk_id,token_hash) DO UPDATE SET version=excluded.version,user_agent=excluded.user_agent,last_seen=excluded.last_seen,expires_at=excluded.expires_at,revoked_at=NULL")
          .run(device, fresh.cdk_id, secretHash(secret), fresh.version, fresh.user_agent, now(), now(), now() + DEVICE_TTL);
        const trusted = validDevice(fresh.cdk_id, secret);
        const session = createSession(fresh.cdk_id, trusted.id);
        db.prepare("DELETE FROM login_challenges WHERE cdk_id=?").run(fresh.cdk_id);
        audit(fresh.cdk_id, "verify-login-device", trusted.id);
        return { session, deviceSecret: secret, cdkId: fresh.cdk_id };
      });
    },
    loginWithDevice(id, token) {
      const device = validDevice(id, token);
      if (!device) return null;
      db.prepare("UPDATE trusted_devices SET last_seen=? WHERE id=?").run(now(), device.id);
      return createSession(id, device.id);
    },
    acceptsSession(session, token) {
      const device = session && validDevice(session.cdk_id, token);
      return Boolean(device && session.device_id === device.id);
    },
    devices(id, currentId) {
      return db.prepare("SELECT id,user_agent,created_at,last_seen,expires_at FROM trusted_devices WHERE cdk_id=? AND version=? AND revoked_at IS NULL AND expires_at>? ORDER BY last_seen DESC")
        .all(id, owner(id).version, now()).map((row) => ({ id: row.id, description: row.user_agent, createdAt: row.created_at, lastSeen: row.last_seen, expiresAt: row.expires_at, current: row.id === currentId }));
    },
    revoke(id, deviceId) {
      return transaction(() => {
        if (!db.prepare("SELECT 1 FROM trusted_devices WHERE id=? AND cdk_id=?").get(deviceId, id)) throw cdkError(404, "设备不存在");
        db.prepare("UPDATE trusted_devices SET revoked_at=? WHERE id=? AND cdk_id=?").run(now(), deviceId, id);
        db.prepare("DELETE FROM sessions WHERE cdk_id=? AND device_id=?").run(id, deviceId);
        audit(id, "revoke-login-device", deviceId);
      });
    },
    cleanup() {
      db.prepare("DELETE FROM login_challenges WHERE expires_at<?").run(now() - PENDING_TTL);
      db.prepare("DELETE FROM login_email_sends WHERE created_at<?").run(now() - 86400000);
      db.prepare("DELETE FROM login_email_failures WHERE created_at<?").run(now() - 86400000);
      db.prepare("DELETE FROM trusted_devices WHERE expires_at<? OR revoked_at<?").run(now() - 86400000, now() - 86400000);
    },
  };
}
