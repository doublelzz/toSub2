import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createOfferWorkspace } from "../src/offer-workspace.mjs";
import { offerError } from "../src/offer-checker.mjs";
import { createProxyPool } from "../src/proxy-pool.mjs";

process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-offer-proxy-retry-"));
const vault = await createCdkVault(root); const calls = []; let workspace;
const proxy = "http://fixture-user:fixture-secret@proxy.example.invalid:8080/";
const changedProxy = "http://fixture-user:fixture-new-secret@updated.example.invalid:8081/";
const parseText = (text) => text.split("\n").map((line) => { const [email, password] = line.split("----"); return { email, password }; });
const normalizeProxy = (value) => { if (!value) return ""; const url = new URL(value); if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) throw Error("invalid proxy"); return url.toString(); };
const runAccount = (payload) => { calls.push(structuredClone(payload)); return { done: Promise.reject(offerError("proxy_connection", false, "login")) }; };
const create = (overrides = {}) => createOfferWorkspace({ root, vault, parseText, normalizeProxy, runAccount, canUse: () => true,
  resolveSource: async () => ({ credentials: { proxyUrl: "http://unexpected-source.example.invalid:9999" } }), ...overrides });
let clockOffset = 0;
async function finish(id) { for (let i = 0; i < 100; i++) { clockOffset += 2000; workspace.tick(20); if (workspace.query(id).batch.status === "completed") return; await new Promise((resolve) => setTimeout(resolve, 5)); } throw Error("fixture did not settle"); }
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
  await workspace.shutdown();
  const poolAddresses = [proxy, changedProxy, "socks5h://fixture:third-secret@third.example.invalid:1080"];
  let poolState = {};
  const pool = createProxyPool({ readPool: () => poolAddresses, readState: () => poolState, writeState: (value) => { poolState = value; } });
  const poolCalls = []; let autoAttempts = 0;
  const poolOptions = { proxyPool: pool, now: () => Date.now() + clockOffset, resolveSource: async (email) => {
    if (email === "loop-0@example.invalid") await new Promise((resolve) => setTimeout(resolve, 30));
    return null;
  }, runAccount: (payload) => {
    poolCalls.push(structuredClone(payload));
    const done = payload.email === "auto@example.invalid" && ++autoAttempts > 1
      ? Promise.resolve({ kind: "none", checkedAt: new Date().toISOString() }) : Promise.reject(offerError("proxy_connection", false, "login"));
    return { done };
  } };
  workspace = await create(poolOptions);
  const poolText = Array.from({ length: 5 }, (_, index) => `loop-${index}@example.invalid----fixture-pass`).join("\n");
  const poolRequest = { text: poolText, digest: workspace.preview({ text: poolText }).digest, requestKey: crypto.randomUUID(), useProxyPool: true, concurrency: 5, maxRetries: 0 };
  const poolBatch = await workspace.start(poolRequest);
  assert.deepEqual(poolState, {}, "creating or previewing a batch does not consume an exit");
  assert.equal((await workspace.start(poolRequest)).id, poolBatch.id, "idempotent start returns the same batch without allocation");
  await finish(poolBatch.id);
  for (let index = 0; index < 5; index++) assert.equal(poolCalls.find((row) => row.email === `loop-${index}@example.invalid`).proxyUrl,
    new URL(poolAddresses[index % 3]).toString(), "allocation follows input order even when credential reads finish out of order");
  const poolIds = workspace.query(poolBatch.id).items.map((row) => row.id);
  const beforeKeep = structuredClone(poolState);
  await workspace.retry(poolBatch.id, { ids: [poolIds[0]] }); await finish(poolBatch.id);
  assert.equal(poolCalls.at(-1).proxyUrl, proxy, "omission keeps the concrete exit assigned to that account");
  assert.deepEqual(poolState, beforeKeep, "keeping an assigned exit does not advance the pool");
  await workspace.retry(poolBatch.id, { ids: [poolIds[1]], useProxyPool: true }); await finish(poolBatch.id);
  assert.equal(poolCalls.at(-1).proxyUrl, new URL(poolAddresses[2]).toString());
  await workspace.retry(poolBatch.id, { ids: [poolIds[1]], proxyUrl: "" }); await finish(poolBatch.id);
  assert.equal(poolCalls.at(-1).proxyUrl, "");
  await assert.rejects(workspace.retry(poolBatch.id, { ids: [poolIds[1]], proxyPool: ["not-a-proxy"] }), /第 1 行/);
  assert.doesNotMatch(JSON.stringify(workspace.query(poolBatch.id)), /fixture-secret|third-secret|proxySelection|proxyUrl/);
  const autoText = "auto@example.invalid----fixture-pass";
  const autoBatch = await workspace.start({ text: autoText, digest: workspace.preview({ text: autoText }).digest,
    requestKey: crypto.randomUUID(), useProxyPool: true, maxRetries: 1 });
  await finish(autoBatch.id);
  assert.equal(workspace.query(autoBatch.id).items[0].status, "completed");
  assert.deepEqual(poolCalls.filter((row) => row.email === "auto@example.invalid").map((row) => row.proxyUrl), [proxy, changedProxy],
    "a fixed proxy connection failure switches to the next pool exit within the existing retry limit");
  await workspace.shutdown(); workspace = await create(poolOptions);
  await workspace.retry(poolBatch.id, { ids: [poolIds[1]] }); await finish(poolBatch.id);
  assert.equal(poolCalls.at(-1).proxyUrl, "", "a direct override stays direct after pool restart");
  console.log("offer proxy retry passed (explicit proxy replacement, per-account scope, omission preserves batch proxy, direct override, validation, persistence and redaction; no network)");
} finally { await workspace?.shutdown(); await fs.rm(root, { recursive: true, force: true }); }
