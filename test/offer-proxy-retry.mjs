import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createOfferWorkspace } from "../src/offer-workspace.mjs";
import { offerError } from "../src/offer-checker.mjs";

process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-offer-proxy-retry-"));
const vault = await createCdkVault(root); const calls = []; let workspace;
const proxy = "http://fixture-user:fixture-secret@proxy.example.invalid:8080/";
const changedProxy = "http://fixture-user:fixture-new-secret@updated.example.invalid:8081/";
const parseText = (text) => text.split("\n").map((line) => { const [email, password] = line.split("----"); return { email, password }; });
const normalizeProxy = (value) => { if (!value) return ""; const url = new URL(value); if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) throw Error("invalid proxy"); return url.toString(); };
const runAccount = (payload) => { calls.push(structuredClone(payload)); return { done: Promise.reject(offerError("proxy_connection", false, "login")) }; };
const create = () => createOfferWorkspace({ root, vault, parseText, normalizeProxy, runAccount, canUse: () => true,
  resolveSource: async () => ({ credentials: { proxyUrl: "http://unexpected-source.example.invalid:9999" } }) });
async function finish(id) { workspace.tick(20); for (let i = 0; i < 100; i++) { if (workspace.query(id).batch.status === "completed") return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw Error("fixture did not settle"); }
try {
  workspace = await create();
  const text = "one@example.invalid----fixture-pass\ntwo@example.invalid----fixture-pass";
  const preview = workspace.preview({ text });
  const batch = await workspace.start({ text, digest: preview.digest, requestKey: crypto.randomUUID(), proxyUrl: proxy, concurrency: 2, maxRetries: 0 });
  await finish(batch.id); assert.ok(calls.every((row) => row.proxyUrl === proxy));
  const ids = workspace.query(batch.id).items.map((row) => row.id);
  await workspace.retry(batch.id, { ids: [ids[0]], proxyUrl: changedProxy }); await finish(batch.id);
  assert.equal(calls.at(-1).proxyUrl, changedProxy, "explicit retry updates only the selected encrypted task proxy");
  await workspace.retry(batch.id, { ids: [ids[1]] }); await finish(batch.id);
  assert.equal(calls.at(-1).proxyUrl, proxy, "omitting proxy retains that account's batch proxy");
  await workspace.retry(batch.id, { ids: [ids[0]], proxyUrl: "", credentials: { password: "new-fixture-pass" } }); await finish(batch.id);
  assert.equal(calls.at(-1).proxyUrl, "", "explicit direct mode never falls back to the account's stored proxy");
  assert.equal(calls.at(-1).credentials.password, "new-fixture-pass");
  await assert.rejects(workspace.retry(batch.id, { ids: [ids[0]], proxyUrl: "not a URL" }));
  assert.equal(workspace.query(batch.id).batch.status, "completed");
  assert.ok(workspace.query(batch.id).items.every((row) => row.status === "failed"), "invalid retry config leaves task state untouched");
  assert.doesNotMatch(JSON.stringify(workspace.query(batch.id)), /fixture-secret|updated\.example|unexpected-source|new-fixture-pass/);
  await workspace.shutdown(); workspace = await create();
  await workspace.retry(batch.id, { ids: [ids[0]] }); await finish(batch.id);
  assert.equal(calls.at(-1).proxyUrl, "", "direct override persists across restart");
  assert.equal(calls.at(-1).credentials.password, "new-fixture-pass");
  console.log("offer proxy retry passed (explicit proxy replacement, per-account scope, omission preserves batch proxy, direct override, validation, persistence and redaction; no network)");
} finally { await workspace?.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
