import fs from "./workspace-storage.mjs";
import path from "node:path";
import { inspect } from "node:util";

export const describeRebindError = (error) => inspect(error, { depth: null, colors: false, maxArrayLength: null, maxStringLength: null, breakLength: 120 });
export function formatRebindDiagnostic(record) {
  if (record.phase === "request") return `> ${record.method} ${record.url}\n${record.body === undefined ? "" : `Request body:\n${typeof record.body === "string" ? record.body : JSON.stringify(record.body, null, 2)}\n`}`;
  if (record.phase === "response") return `< ${record.method} ${record.url} HTTP ${record.status}\nResponse headers:\n${JSON.stringify(record.headers || {}, null, 2)}\nResponse body:\n${record.body ?? ""}\n`;
  return `[${record.phase || "error"}] ${record.method || ""} ${record.url || ""}\n${record.error || ""}\n`;
}

// Observe each transport attempt before transport-level retry/response handling.
// This also retains responses that never reach ProtocolClient (for example 403).
export function traceRebindTransport(transport, write) {
  const send = transport.send.bind(transport);
  transport.send = async (request) => {
    try {
      const response = await send(request);
      if (request.operation === "request") write(formatRebindDiagnostic({ phase: "response", method: request.method, url: request.url,
        status: response.status, headers: response.headers || [], body: response.body ? Buffer.from(response.body, "base64").toString("utf8") : "" }));
      return response;
    } catch (failure) {
      write(`[transport:${request.operation}:error]\n${describeRebindError(failure)}`);
      throw failure;
    }
  };
}

// The detailed journal is separate from the frequently polled public state.
// Each append is encrypted with this CDK's vault and this record's identity.
export function createRebindLogStore({ directory, vault, now = Date.now }) {
  const writes = new Map();
  const initialized = new Set();
  const historyText = (events) => events.length ? "[历史状态记录；当时未保存原始协议日志]\n" + events.map((event) => `[${event.at}] [state:${event.status}] ${event.message}\n`).join("") : "";
  const filename = (id) => path.join(directory, "logs", `${id}.log.enc`);
  function append(item, value) {
    const text = typeof value === "string" ? value : String(value);
    if (!text) return Promise.resolve();
    const previous = writes.get(item.id) || Promise.resolve();
    const priorEvents = (item.events || []).slice(0, text.startsWith("[state:") ? -1 : undefined).map((event) => ({ ...event }));
    const pending = previous.then(async () => {
      await fs.mkdir(path.join(directory, "logs"), { recursive: true, mode: 0o700 });
      if (!initialized.has(item.id)) {
        let exists = true; try { await fs.access(filename(item.id)); } catch (error) { if (error.code !== "ENOENT") throw error; exists = false; }
        const legacy = historyText(priorEvents);
        if (!exists && legacy) await fs.appendFile(filename(item.id), `${vault.seal({ at: null, text: legacy }, `email-rebind-log:${item.id}`)}\n`, { mode: 0o600 });
        initialized.add(item.id);
      }
      const entry = { at: new Date(now()).toISOString(), text };
      await fs.appendFile(filename(item.id), `${vault.seal(entry, `email-rebind-log:${item.id}`)}\n`, { mode: 0o600 });
    });
    writes.set(item.id, pending); pending.catch(() => {});
    return pending;
  }
  async function read(item, { offset = 0, limit = 128_000 } = {}) {
    offset = Number(offset); limit = Number(limit);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256_000) throw Object.assign(new Error("日志读取范围无效"), { status: 400 });
    await writes.get(item.id);
    let raw = "";
    try { raw = await fs.readFile(filename(item.id), "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const records = raw.split("\n").filter(Boolean).map((line) => vault.open(line, `email-rebind-log:${item.id}`));
    const content = records.length ? records.map((entry) => `${entry.at ? `[${entry.at}] ` : ""}${entry.text}${entry.text.endsWith("\n") ? "" : "\n"}`).join("") : historyText(item.events || []);
    const reset = offset > content.length;
    const start = reset ? 0 : offset;
    const nextOffset = Math.min(content.length, start + limit);
    return { logs: content.slice(start, nextOffset), offset: start, nextOffset, total: content.length, hasMore: nextOffset < content.length, reset };
  }
  return { append, read, async flush() { await Promise.all([...writes.values()]); } };
}
