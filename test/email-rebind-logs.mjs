import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createRebindLogStore, describeRebindError, formatRebindDiagnostic, traceRebindTransport } from "../src/email-rebind-logs.mjs";
import { emailRebindStep } from "../src/email-rebind-protocol.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-rebind-logs-"));
process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
try {
  const vault = await createCdkVault(root); const directory = path.join(root, "email-rebind");
  const transportLogs = []; const transportFailure = new Error("original initialization failure");
  const transport = { async send(request) { if (request.operation === "configure") throw transportFailure; return { status: 403, headers: [["x-request-id", "blocked-request-id"]], body: Buffer.from("original rejected response").toString("base64") }; } };
  traceRebindTransport(transport, (message) => transportLogs.push(message));
  assert.equal((await transport.send({ operation: "request", method: "POST", url: "https://fixture.example/begin" })).status, 403);
  await assert.rejects(transport.send({ operation: "configure" }), (failure) => failure === transportFailure);
  assert.match(transportLogs.join("\n"), /HTTP 403/); assert.match(transportLogs.join("\n"), /original rejected response/); assert.match(transportLogs.join("\n"), /blocked-request-id/); assert.match(transportLogs.join("\n"), /original initialization failure/);
  const item = { id: crypto.randomUUID(), events: [{ at: "2026-10-26T00:00:00.000Z", status: "failed", message: "历史失败" }] };
  let store = createRebindLogStore({ directory, vault });
  const historical = await store.read(item);
  assert.match(historical.logs, /历史状态记录/);
  item.events.push({ at: new Date().toISOString(), status: "queued", message: "重试" });
  await store.append(item, "[state:queued] 重试");
  const largeBody = JSON.stringify({ error: { code: "target_email_rejected", message: "保留原始响应@example.com-".repeat(15000) } });
  const diagnostic = formatRebindDiagnostic({ phase: "response", method: "POST", url: "https://fixture.example/change_email/begin", status: 400,
    headers: { "x-request-id": "raw-request-id", "set-cookie": "fixture-cookie=unmodified-value" }, body: largeBody });
  const cause = Object.assign(new Error("synthetic underlying connection error"), { code: "ECONNRESET" });
  await store.append(item, diagnostic);
  await store.append(item, describeRebindError(new Error("transport failed", { cause })));
  await Promise.all(Array.from({ length: 40 }, (_, index) => store.append(item, `attempt-marker-${index}`)));
  await store.flush();
  let assembled = ""; let offset = 0; let chunks = 0;
  do {
    const result = await store.read(item, { offset, limit: 15000 });
    assembled += result.logs; offset = result.nextOffset; chunks++;
    if (!result.hasMore) break;
  } while (chunks < 100);
  assert.ok(chunks > 10, "large responses are read incrementally without losing text");
  assert.ok(assembled.startsWith(historical.logs), "historical prefix is stable when detailed logs begin");
  assert.ok(assembled.includes(largeBody), "the complete response is retained without replacement or truncation");
  assert.match(assembled, /HTTP 400/); assert.match(assembled, /raw-request-id/); assert.match(assembled, /fixture-cookie=unmodified-value/);
  assert.match(assembled, /ECONNRESET/); assert.match(assembled, /attempt-marker-0\b/); assert.match(assembled, /attempt-marker-39\b/);
  assert.equal((await store.read(item, { offset })).logs, "", "polling the same cursor cannot duplicate logs");
  assert.equal((await store.read(item, { offset: assembled.length + 10 })).reset, true);
  await assert.rejects(store.read(item, { offset: -1 }), { status: 400 });
  store = createRebindLogStore({ directory, vault });
  assert.equal((await store.read(item, { limit: 256000 })).logs, assembled.slice(0, 256000), "logs survive reopening the store");
  const stored = await fs.readFile(path.join(directory, "logs", `${item.id}.log.enc`), "utf8");
  assert.doesNotMatch(stored, /raw-request-id|unmodified-value|保留原始响应|attempt-marker/);
  const session = { type: "chatgpt-session", version: 1, email: "fixture@example.com", accessToken: "synthetic-private-token", accountId: "fixture-account", expiresAt: "2099-01-01T00:00:00Z" };
  await assert.rejects(emailRebindStep({ operation: "begin", email: session.email, newEmail: "new@example.com", session }, async () => ({ status: 429, body: { error: { code: "rate_limit_exceeded", message: "original error detail" } } })),
    (failure) => failure.rebindCode === "REQUEST_FAILED" && failure.diagnostic.httpStatus === 429 && failure.diagnostic.upstreamCode === "rate_limit_exceeded" && failure.diagnostic.operation === "begin");
  console.log("email rebind logs passed (complete original responses, request IDs, causes, append history, encrypted persistence and cursor paging)");
} finally { await fs.rm(root, { recursive: true, force: true }); }
