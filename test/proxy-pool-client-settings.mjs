import assert from "node:assert/strict";
import { clearWorkspaceSettings, flushWorkspaceSettings, hydrateWorkspaceSettings, prepareProxyNetworkOptions, prepareWorkspaceProxyPool, readWorkspaceProxyPoolText, readWorkspaceValue, setWorkspaceProxyPoolDraft, writeWorkspaceValue } from "../web/src/cdk-api.mjs";
import { LEGACY_PROXY_STORAGE_KEY, PROXY_POOL_STORAGE_KEY, parseProxyPoolText, proxyNetworkPayload, proxyPoolText } from "../web/src/proxy-pool.mjs";

const first = "http://fixture-user:fixture-secret@first.example.invalid:8080";
const second = "socks5h://fixture-user:fixture-secret@second.example.invalid:1080";
const posts = []; const local = new Map();
const originalWindow = globalThis.window; const originalFetch = globalThis.fetch;
globalThis.window = { localStorage: { getItem: (key) => local.get(key) ?? null, removeItem: (key) => local.delete(key) }, dispatchEvent() {} };
globalThis.fetch = async (url, options) => { posts.push({ url, body: JSON.parse(options.body) }); return Response.json({ ok: true }); };
const bootstrap = (id, settings = {}) => ({ token: `token-${id}`, account: { id, role: "admin" }, workspace: { id, balance: 10 }, settings });

try {
  assert.deepEqual(parseProxyPoolText(` ${first} \r\n\r\n${second}\n${first}`), { proxies: [first, second, first], errors: [] });
  const malformed = parseProxyPoolText(`${first}\n\ninvalid\nftp://example.invalid:21`);
  assert.equal(malformed.errors.length, 2); assert.match(malformed.errors[0], /第 3 行/); assert.match(malformed.errors[1], /第 4 行/);
  assert.doesNotMatch(malformed.errors.join(""), /fixture-secret/, "validation messages never expose credentials");
  assert.equal(parseProxyPoolText(Array(500).fill(first).join("\n")).errors.length, 0);
  assert.match(parseProxyPoolText(Array(501).fill(first).join("\n")).errors[0], /最多填写 500/);
  assert.equal(parseProxyPoolText("http://fixture\t.example.invalid:8080").errors.length, 1);
  assert.equal(parseProxyPoolText(`http://example.invalid/${"x".repeat(8192)}`).errors.length, 1);
  assert.equal(proxyPoolText(JSON.stringify([first, second])), `${first}\n${second}`);
  assert.deepEqual(proxyNetworkPayload("keep", ""), {});
  assert.deepEqual(proxyNetworkPayload("direct", first), { proxyUrl: "" });
  assert.deepEqual(proxyNetworkPayload("custom", `\n${first}\n${first}`), { proxyPool: [first, first] });
  assert.deepEqual(proxyNetworkPayload("custom", ""), { proxyPool: [] });

  hydrateWorkspaceSettings(bootstrap("owner-a", { [LEGACY_PROXY_STORAGE_KEY]: first }));
  assert.equal(readWorkspaceProxyPoolText(), first, "legacy single proxy becomes a one-item pool");
  assert.deepEqual(JSON.parse(readWorkspaceValue(PROXY_POOL_STORAGE_KEY)), [first]);
  assert.deepEqual(await prepareWorkspaceProxyPool(`${first}\n${second}\n${first}`), { useProxyPool: true });
  assert.deepEqual(JSON.parse(posts.at(-1).body.settings[PROXY_POOL_STORAGE_KEY]), [first, second, first], "latest edits are flushed before the caller can launch a task");
  const beforeInvalid = posts.length;
  await assert.rejects(prepareWorkspaceProxyPool(`${first}\ninvalid`), /第 2 行/);
  assert.equal(posts.length, beforeInvalid, "invalid drafts never overwrite saved settings");

  hydrateWorkspaceSettings(bootstrap("owner-b", { [PROXY_POOL_STORAGE_KEY]: JSON.stringify([second]) }));
  assert.equal(readWorkspaceProxyPoolText(), second, "switching CDKs loads only the new workspace pool");
  assert.deepEqual(await prepareProxyNetworkOptions("workspace", "unused"), { useProxyPool: true });
  assert.deepEqual(await prepareProxyNetworkOptions("custom", first), { proxyPool: [first] });
  globalThis.fetch = async () => Response.json({ error: "fixture-save-failed" }, { status: 500 });
  await assert.rejects(prepareWorkspaceProxyPool(first), /fixture-save-failed/, "failed settings saves stop task submission");

  const delayedWrites = []; const savedSettings = new Map(); let activeWrites = 0; let maximumWrites = 0;
  globalThis.fetch = (url, options) => new Promise((resolve) => {
    const body = JSON.parse(options.body); activeWrites++; maximumWrites = Math.max(maximumWrites, activeWrites);
    delayedWrites.push({ body, complete() { savedSettings.set(body.workspaceId, body.settings); activeWrites--; resolve(Response.json({ ok: true })); } });
  });
  hydrateWorkspaceSettings(bootstrap("ordered-save", { [PROXY_POOL_STORAGE_KEY]: "[]" }));
  writeWorkspaceValue(PROXY_POOL_STORAGE_KEY, JSON.stringify([first]));
  const backgroundSave = flushWorkspaceSettings();
  assert.equal(delayedWrites.length, 1);
  let taskPrepared = false;
  const taskPreparation = prepareWorkspaceProxyPool(second).then((payload) => { taskPrepared = true; return payload; });
  assert.equal(delayedWrites.length, 1, "clicking while an autosave is in flight waits instead of starting a competing PUT");
  const latestPool = `${second}\n${first}`;
  setWorkspaceProxyPoolDraft(latestPool); writeWorkspaceValue(PROXY_POOL_STORAGE_KEY, JSON.stringify([second, first]));
  delayedWrites[0].complete(); await new Promise(setImmediate);
  assert.equal(delayedWrites.length, 2);
  assert.equal(taskPrepared, false, "task preparation remains pending until the latest configuration has been saved");
  assert.deepEqual(JSON.parse(delayedWrites[1].body.settings[PROXY_POOL_STORAGE_KEY]), [second, first], "the queued save uses edits made while awaiting the older PUT");
  delayedWrites[1].complete();
  await backgroundSave; assert.deepEqual(await taskPreparation, { useProxyPool: true });
  assert.equal(taskPrepared, true); assert.equal(maximumWrites, 1, "saves for one workspace never overlap");
  assert.deepEqual(JSON.parse(savedSettings.get("ordered-save")[PROXY_POOL_STORAGE_KEY]), [second, first], "the final server value contains the newest pool");

  hydrateWorkspaceSettings(bootstrap("switch-source", { [PROXY_POOL_STORAGE_KEY]: "[]" }));
  writeWorkspaceValue(PROXY_POOL_STORAGE_KEY, JSON.stringify([first]));
  const oldBackground = flushWorkspaceSettings();
  const oldTask = prepareWorkspaceProxyPool(second);
  const oldBackgroundRejected = assert.rejects(oldBackground, /工作区已变化/);
  const oldTaskRejected = assert.rejects(oldTask, /工作区已变化/);
  const oldWrite = delayedWrites.at(-1); const writesBeforeSwitch = delayedWrites.length;
  hydrateWorkspaceSettings(bootstrap("switch-target", { [PROXY_POOL_STORAGE_KEY]: JSON.stringify([first, second]) }));
  oldWrite.complete(); await Promise.all([oldBackgroundRejected, oldTaskRejected]);
  assert.equal(delayedWrites.length, writesBeforeSwitch, "a stale action cannot queue another save after the CDK changes");
  assert.equal(readWorkspaceProxyPoolText(), `${first}\n${second}`);
  assert.deepEqual(JSON.parse(readWorkspaceValue(PROXY_POOL_STORAGE_KEY)), [first, second], "finishing the old save does not mutate the new workspace");
  assert.equal(savedSettings.has("switch-target"), false, "the previous workspace action never writes the newly selected CDK");

  hydrateWorkspaceSettings(bootstrap("refreshed-owner", { [PROXY_POOL_STORAGE_KEY]: "[]" }));
  writeWorkspaceValue(PROXY_POOL_STORAGE_KEY, JSON.stringify([first]));
  const staleSessionSave = flushWorkspaceSettings(); const staleSessionRejected = assert.rejects(staleSessionSave, /工作区已变化/);
  const staleSessionWrite = delayedWrites.at(-1); const beforeSessionRefresh = delayedWrites.length;
  hydrateWorkspaceSettings({ ...bootstrap("refreshed-owner", { [PROXY_POOL_STORAGE_KEY]: JSON.stringify([second]) }), token: "new-session-token" });
  const newSessionTask = prepareWorkspaceProxyPool(`${second}\n${first}`);
  assert.equal(delayedWrites.length, beforeSessionRefresh, "refreshing the same CDK also waits for its existing save");
  staleSessionWrite.complete(); await staleSessionRejected; await new Promise(setImmediate);
  assert.equal(delayedWrites.length, beforeSessionRefresh + 1);
  delayedWrites.at(-1).complete(); await newSessionTask;
  assert.deepEqual(JSON.parse(savedSettings.get("refreshed-owner")[PROXY_POOL_STORAGE_KEY]), [second, first]);

  clearWorkspaceSettings(); local.set(LEGACY_PROXY_STORAGE_KEY, first); globalThis.fetch = originalFetch;
  hydrateWorkspaceSettings(bootstrap("legacy-admin"));
  assert.equal(readWorkspaceProxyPoolText(), first, "local legacy configuration is migrated too");
  globalThis.fetch = async () => Response.json({ ok: true }); await flushWorkspaceSettings();
  assert.equal(local.has(LEGACY_PROXY_STORAGE_KEY), false, "legacy browser secrets are removed after successful encrypted persistence");
  console.log("proxy pool client settings passed (ordered entries, legacy migration, line errors, serialized saves, latest edits before tasks, CDK switches, session refresh and failed-save handling)");
} finally { clearWorkspaceSettings(); globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; }
