import nativeFs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCdkVault } from "../src/cdk-vault.mjs";
import runtimeFs, { workspaceStorageFor } from "../src/workspace-storage.mjs";

// Tests that run the console in another process inspect the authoritative
// database rather than the preserved pre-migration files.
export function storedFiles(root) {
  root = path.resolve(root);
  let vault;
  async function location(target, writable = false) {
    const relative = path.relative(root, path.resolve(target)).split(path.sep).join("/");
    if (!relative || relative.startsWith("../") || path.isAbsolute(relative) || relative.startsWith(".cdk/")) return null;
    try { await nativeFs.access(path.join(root, ".cdk", "cdk.sqlite")); } catch { return null; }
    const db = new DatabaseSync(path.join(root, ".cdk", "cdk.sqlite"), { readOnly: !writable });
    const match = /^cdk\/([^/]+)\/(.+)$/.exec(relative);
    const owner = match?.[1] || db.prepare("SELECT id FROM cdks WHERE role='admin' ORDER BY created_at LIMIT 1").get().id;
    const name = match?.[2] || relative;
    const migrated = db.prepare("SELECT 1 FROM meta WHERE key=?").get(`workspace-documents-v1:${owner}`);
    if (!migrated) { db.close(); return null; }
    vault ||= createCdkVault(root);
    return { db, owner, name, scope: `workspace-document:${owner}:${name}`, vault: await vault };
  }
  return new Proxy(runtimeFs, {
    get(target, method) {
      if (!["readFile", "writeFile", "access"].includes(method)) return target[method];
      return async (file, ...args) => {
        if (workspaceStorageFor(file)) return target[method](file, ...args);
        const info = await location(file, method === "writeFile");
        if (!info) return target[method](file, ...args);
        const { db, owner, name, scope, vault } = info;
        try {
          if (method === "writeFile") {
            const content = Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(args[0], typeof args[1] === "string" ? args[1] : args[1]?.encoding || "utf8");
            db.prepare("INSERT INTO workspace_documents VALUES(?,?,?,?) ON CONFLICT(cdk_id,name) DO UPDATE SET payload=excluded.payload,mtime=excluded.mtime").run(owner, name, vault.seal(content.toString("base64"), scope), Date.now()); return;
          }
          const row = db.prepare("SELECT payload FROM workspace_documents WHERE cdk_id=? AND name=?").get(owner, name);
          if (!row) throw Object.assign(new Error("Stored fixture is absent"), { code: "ENOENT" });
          if (method === "access") return;
          const content = Buffer.from(vault.open(row.payload, scope), "base64");
          const encoding = typeof args[0] === "string" ? args[0] : args[0]?.encoding;
          return encoding ? content.toString(encoding) : content;
        } finally { db.close(); }
      };
    },
  });
}
