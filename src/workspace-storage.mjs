import nativeFs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

const registrations = new Map();
const MESSAGE = "tosub2:workspace-storage";
const methods = new Set(["readFile", "writeFile", "appendFile", "rename", "unlink", "rm", "mkdir", "stat", "access", "chmod", "readdir", "copyFile"]);
const pending = new Map();
let sequence = 0;

const failure = (code, target) => Object.assign(new Error(`${code}: workspace document ${path.basename(String(target))}`), { code });
const inside = (root, target) => { const relative = path.relative(root, target); return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); };
const isTemporary = (name) => name.endsWith(".tmp");

function entry(name, directory) {
  return { name, isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false };
}

// Persistent documents retain their logical paths so protocol checkpoints and
// existing export formats can share one transactional SQLite store.
export async function registerWorkspaceStorage({ root, ownerId, store, vault }) {
  root = path.resolve(root);
  if (registrations.has(root)) return registrations.get(root);
  const scope = (name) => `workspace-document:${ownerId}:${name}`;
  if (!store.workspaceMigrated(ownerId)) {
    const imported = [];
    async function scan(directory) {
      const entries = await nativeFs.readdir(directory, { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
      // Bounded sequential traversal is intentional: the previous restoration
      // started hundreds of file operations and PowerShell children at once.
      for (const item of entries) {
        const target = path.join(directory, item.name);
        const name = path.relative(root, target).split(path.sep).join("/");
        if (item.isSymbolicLink() || isTemporary(name) || name === ".cdk" || name === "cdk" || name === "offers") continue;
        if (item.isDirectory()) await scan(target);
        else if (item.isFile()) {
          const [content, stat] = await Promise.all([nativeFs.readFile(target), nativeFs.stat(target)]);
          imported.push({ name, payload: vault.seal(content.toString("base64"), scope(name)), mtime: stat.mtimeMs });
        }
      }
    }
    await scan(root);
    store.migrateWorkspace(ownerId, imported);
  }
  // One-time indexing reads legacy result/session documents only to produce
  // non-secret task metadata. Ordinary restarts never read these payloads.
  if (!store.workspaceTaskIndexReady(ownerId)) {
    const names = new Map(store.workspaceDocumentNames(ownerId).map((row) => [row.name, row]));
    const indexed = [];
    const readJson = (name) => {
      const row = store.workspaceDocument(ownerId, name);
      if (!row) return null;
      try { return JSON.parse(Buffer.from(vault.open(row.payload, scope(name)), "base64").toString("utf8")); } catch { return null; }
    };
    const taskIds = new Set([...names.keys()].flatMap((name) => /^([^/]+)\/(?:job-meta|sub2api-import-oauth|login-checkpoint)\.json$/.exec(name)?.[1] || []));
    for (const id of taskIds) {
      const name = `${id}/job-meta.json`;
      const metadata = readJson(name) || {};
      let email = metadata.email;
      const outputName = `${id}/sub2api-import-oauth.json`;
      if (!email) { const result = readJson(outputName); email = result?.accounts?.[0]?.credentials?.email || result?.accounts?.[0]?.extra?.email || result?.accounts?.[0]?.name || readJson(`${id}/login-checkpoint.json`)?.email; }
      if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      const output = names.get(outputName);
      const checkpoint = names.get(`${id}/login-checkpoint.json`);
      const mtime = names.get(name)?.mtime || output?.mtime || checkpoint?.mtime || Date.now();
      let snapshot = readJson(`${id}/account-insights.json`);
      if (snapshot?.email !== email.toLowerCase() || ![1, 2].includes(snapshot?.version)) snapshot = null;
      if (snapshot) {
        const sourceName = metadata.account_insights_source === "session" || !output ? `${id}/account-session.json` : outputName;
        const row = store.workspaceDocument(ownerId, sourceName);
        const raw = row ? Buffer.from(vault.open(row.payload, scope(sourceName)), "base64") : null;
        if (!raw || snapshot.authorizationFingerprint !== crypto.createHash("sha256").update(raw).digest("hex")) snapshot = null;
      }
      const data = { ...metadata, version: 1, email, status: metadata.status || (output ? "completed" : checkpoint ? "resume_available" : "failed"),
        result_saved: Boolean(output), completed_at: metadata.completed_at || (output ? new Date(output.mtime).toISOString() : null),
        login_checkpoint_available: Boolean(checkpoint), created_at: metadata.created_at || new Date(mtime).toISOString(),
        account_insights_snapshot: snapshot, task_metadata_version: 2 };
      indexed.push({ name, payload: vault.seal(Buffer.from(JSON.stringify(data)).toString("base64"), scope(name)), mtime });
    }
    store.indexWorkspaceTasks(ownerId, indexed);
  }
  const documents = new Map(store.workspaceDocumentNames(ownerId).map((row) => [row.name, row]));
  const decoded = new Map();
  const temporaries = new Map();
  const directories = new Set([""]);
  let batch = null;
  function rememberDirectory(name) {
    while (name && name !== ".") { directories.add(name); name = path.posix.dirname(name); }
  }
  for (const name of documents.keys()) rememberDirectory(path.posix.dirname(name));
  function relative(target) {
    target = path.resolve(target);
    if (!inside(root, target)) throw failure("EACCES", target);
    const name = path.relative(root, target).split(path.sep).join("/");
    if (/^(?:\.cdk|cdk|offers)(?:\/|$)/.test(name)) throw failure("EACCES", target);
    return name;
  }
  function bytes(name) {
    if (temporaries.has(name)) return temporaries.get(name).content;
    if (!batch || !batch.has(name)) {
      const current = store.workspaceDocument(ownerId, name);
      if (!current) { documents.delete(name); decoded.delete(name); }
      else if (current.payload !== documents.get(name)?.payload) { documents.set(name, current); decoded.delete(name); rememberDirectory(path.posix.dirname(name)); }
    }
    const row = documents.get(name);
    if (!row) throw failure("ENOENT", name);
    if (!decoded.has(name)) decoded.set(name, Buffer.from(vault.open(row.payload, scope(name)), "base64"));
    return decoded.get(name);
  }
  function put(name, content) {
    if (directories.has(name)) throw failure("EISDIR", name);
    if (documents.has(name) && bytes(name).equals(content)) return;
    const mtime = Date.now();
    rememberDirectory(path.posix.dirname(name));
    if (isTemporary(name)) { temporaries.set(name, { content, mtime }); return; }
    const row = { name, payload: vault.seal(content.toString("base64"), scope(name)), mtime };
    if (batch) batch.set(name, row); else store.writeWorkspaceDocuments(ownerId, [row]);
    documents.set(name, row); decoded.set(name, content);
  }
  function remove(name) {
    if (temporaries.delete(name)) return true;
    if (!batch && !documents.has(name)) { const row = store.workspaceDocument(ownerId, name); if (row) documents.set(name, row); }
    if (!documents.has(name)) return false;
    if (batch) batch.set(name, { name, deleted: true }); else store.writeWorkspaceDocuments(ownerId, [{ name, deleted: true }]);
    documents.delete(name); decoded.delete(name); return true;
  }
  const storage = {
    root, ownerId,
    taskMetadata(excluded = new Set()) {
      const names = new Map(store.workspaceDocumentNames(ownerId).map((row) => [row.name, row]));
      return store.workspaceTaskMetadata(ownerId).flatMap((row) => {
        const match = /^([^/]+)\/job-meta\.json$/.exec(row.name);
        if (!match || excluded.has(match[1])) return [];
        const id = match[1];
        const raw = Buffer.from(vault.open(row.payload, scope(row.name)), "base64").toString("utf8");
        let metadata;
        try { metadata = JSON.parse(raw); } catch { return []; }
        if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
        const output = names.get(`${id}/sub2api-import-oauth.json`);
        return [{ id, metadata: { ...metadata, result_saved: Boolean(output),
          result_file_mtime: output ? new Date(output.mtime).toISOString() : null,
          login_checkpoint_available: names.has(`${id}/login-checkpoint.json`),
          pending_password_recovery: names.has(`${id}/password-add-result.json`),
          pending_totp_recovery: names.has(`${id}/totp-setup-result.json`) } }];
      });
    },
    async batch(operation) {
      if (batch) throw new Error("Workspace storage batch is already running");
      const previous = new Map(documents); const previousDirectories = new Set(directories); const previousTemporaries = new Map(temporaries); batch = new Map();
      try { const result = await operation(); store.writeWorkspaceDocuments(ownerId, [...batch.values()]); return result; }
      catch (error) {
        documents.clear(); for (const [name, row] of previous) documents.set(name, row);
        directories.clear(); for (const name of previousDirectories) directories.add(name);
        temporaries.clear(); for (const [name, row] of previousTemporaries) temporaries.set(name, row);
        decoded.clear(); throw error;
      }
      finally { batch = null; }
    },
    async call(method, target, ...args) {
      const name = relative(target);
      if (method === "readFile") {
        const content = bytes(name); const encoding = typeof args[0] === "string" ? args[0] : args[0]?.encoding;
        return encoding ? content.toString(encoding) : Buffer.from(content);
      }
      if (method === "writeFile" || method === "appendFile") {
        const encoding = typeof args[1] === "string" ? args[1] : args[1]?.encoding || "utf8";
        const content = Buffer.isBuffer(args[0]) || args[0] instanceof Uint8Array ? Buffer.from(args[0]) : Buffer.from(args[0], encoding);
        if (String(args[1]?.flag || "").includes("x") && (documents.has(name) || temporaries.has(name))) throw failure("EEXIST", name);
        let previous = Buffer.alloc(0);
        if (method === "appendFile") { try { previous = bytes(name); } catch (error) { if (error.code !== "ENOENT") throw error; } }
        put(name, previous.length ? Buffer.concat([previous, content]) : content); return;
      }
      if (method === "rename" || method === "copyFile") {
        const destination = relative(args[0]);
        if (destination === name) return;
        const content = bytes(name);
        if (method === "rename" && !batch && documents.has(name) && !isTemporary(destination)) {
          if (directories.has(destination)) throw failure("EISDIR", destination);
          const row = { name: destination, payload: vault.seal(content.toString("base64"), scope(destination)), mtime: Date.now() };
          store.writeWorkspaceDocuments(ownerId, [row, { name, deleted: true }]);
          documents.set(destination, row); decoded.set(destination, content); documents.delete(name); decoded.delete(name);
          rememberDirectory(path.posix.dirname(destination)); return;
        }
        put(destination, content);
        if (method === "rename") remove(name);
        return;
      }
      if (method === "unlink") { if (!remove(name)) throw failure("ENOENT", name); return; }
      if (method === "rm") {
        if (args[0]?.recursive) {
          if (!name) throw failure("EACCES", name);
          const names = [...documents.keys(), ...temporaries.keys()].filter((value) => value === name || value.startsWith(`${name}/`));
          const rows = names.filter((value) => documents.has(value)).map((value) => ({ name: value, deleted: true }));
          if (!batch && rows.length) store.writeWorkspaceDocuments(ownerId, rows);
          for (const value of names) { if (batch && documents.has(value)) batch.set(value, { name: value, deleted: true }); documents.delete(value); decoded.delete(value); temporaries.delete(value); }
          for (const directory of directories) if (directory === name || directory.startsWith(`${name}/`)) directories.delete(directory);
        } else if (!remove(name) && !args[0]?.force) throw failure("ENOENT", name);
        return;
      }
      if (method === "mkdir") { rememberDirectory(name); return; }
      if (method === "stat" || method === "access" || method === "chmod") {
        if (!directories.has(name) && !temporaries.has(name) && !batch) {
          const info = store.workspaceDocumentInfo(ownerId, name);
          if (!info) { documents.delete(name); decoded.delete(name); }
          else if (!documents.has(name)) documents.set(name, info);
        }
        const directory = directories.has(name); const row = documents.get(name) || temporaries.get(name);
        if (!directory && !row) throw failure("ENOENT", name);
        if (method !== "stat") return;
        const mtimeMs = row?.mtime || 0;
        return { mtimeMs, mtime: new Date(mtimeMs), size: directory ? 0 : bytes(name).length, isDirectory: () => directory, isFile: () => !directory };
      }
      if (method === "readdir") {
        if (!batch) {
          const current = store.workspaceDocumentNames(ownerId);
          const present = new Set(current.map((row) => row.name));
          for (const key of documents.keys()) if (!present.has(key)) { documents.delete(key); decoded.delete(key); }
          for (const row of current) {
            if (!documents.has(row.name)) documents.set(row.name, row);
            rememberDirectory(path.posix.dirname(row.name));
          }
        }
        if (!directories.has(name)) throw failure("ENOENT", name);
        const children = new Map();
        const prefix = name ? `${name}/` : "";
        for (const value of directories) if (value.startsWith(prefix) && value !== name && !value.slice(prefix.length).includes("/")) children.set(value.slice(prefix.length), true);
        for (const value of [...documents.keys(), ...temporaries.keys()]) if (value.startsWith(prefix) && !value.slice(prefix.length).includes("/")) children.set(value.slice(prefix.length), false);
        return [...children].sort(([a], [b]) => a.localeCompare(b)).map(([child, directory]) => args[0]?.withFileTypes ? entry(child, directory) : child);
      }
      throw failure("ENOSYS", method);
    },
    close() { registrations.delete(root); documents.clear(); decoded.clear(); temporaries.clear(); },
  };
  registrations.set(root, storage); return storage;
}

function registered(target) {
  if (typeof target !== "string") return null;
  const absolute = path.resolve(target);
  const candidates = [...registrations.values()].filter((storage) => inside(storage.root, absolute)).sort((a, b) => b.root.length - a.root.length);
  const storage = candidates[0];
  if (!storage) return null;
  const name = path.relative(storage.root, absolute).split(path.sep).join("/");
  return /^(?:\.cdk|cdk|offers)(?:\/|$)/.test(name) ? null : storage;
}

export function workspaceStorageFor(target) { return registered(target); }

export function workspaceChildOptions(root) {
  const storage = registered(root);
  return storage ? { TOSUB2_STORAGE_IPC_ROOT: storage.root } : {};
}

export function attachWorkspaceStorage(child, root) {
  const storage = registered(root);
  if (!storage) return;
  child.on("message", async (message) => {
    if (message?.type !== MESSAGE || !Number.isSafeInteger(message.id)) return;
    let response;
    try {
      if (!methods.has(message.method) || !Array.isArray(message.args)) throw failure("EACCES", "operation");
      const args = message.args.map((value) => value?.buffer64 !== undefined ? Buffer.from(value.buffer64, "base64") : value);
      const result = await storage.call(message.method, ...args);
      response = { value: Buffer.isBuffer(result) ? { buffer64: result.toString("base64") } : message.method === "stat" ? { mtimeMs: result.mtimeMs, size: result.size, directory: result.isDirectory() }
        : message.method === "readdir" && args[1]?.withFileTypes ? result.map((value) => ({ name: value.name, directory: value.isDirectory() })) : result };
    } catch (error) { response = { error: { code: error.code || "EIO", message: "Workspace storage operation failed" } }; }
    if (child.connected) child.send({ type: MESSAGE, id: message.id, ...response }, () => {});
  });
}

if (process.env.TOSUB2_STORAGE_IPC_ROOT && process.send) {
  process.on("message", (message) => {
    if (message?.type !== MESSAGE || !pending.has(message.id)) return;
    const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
    if (!pending.size) process.channel?.unref();
    if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else request.resolve(message.value);
  });
  process.on("disconnect", () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failure("EPIPE", "parent")); } pending.clear(); });
  process.channel?.unref();
}

async function remote(method, args) {
  if (!process.connected) throw failure("EPIPE", args[0]);
  const value = await new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); if (!pending.size) process.channel?.unref(); reject(failure("ETIMEDOUT", args[0])); }, 30_000);
    pending.set(id, { resolve, reject, timer }); process.channel?.ref();
    process.send({ type: MESSAGE, id, method, args: args.map((item) => Buffer.isBuffer(item) || item instanceof Uint8Array ? { buffer64: Buffer.from(item).toString("base64") } : item) }, (error) => {
      if (error && pending.delete(id)) { clearTimeout(timer); if (!pending.size) process.channel?.unref(); reject(error); }
    });
  });
  if (value?.buffer64 !== undefined) return Buffer.from(value.buffer64, "base64");
  if (method === "stat") return { ...value, mtime: new Date(value.mtimeMs), isDirectory: () => value.directory, isFile: () => !value.directory };
  if (method === "readdir" && args[1]?.withFileTypes) return value.map((item) => entry(item.name, item.directory));
  return value;
}

export default new Proxy(nativeFs, {
  get(target, method) {
    if (!methods.has(method)) return target[method];
    return (...args) => {
      const storage = registered(args[0]);
      if (storage) return storage.call(method, ...args);
      if (process.env.TOSUB2_STORAGE_IPC_ROOT && process.send && typeof args[0] === "string" && inside(path.resolve(process.env.TOSUB2_STORAGE_IPC_ROOT), path.resolve(args[0]))) return remote(method, args);
      return target[method](...args);
    };
  },
});
