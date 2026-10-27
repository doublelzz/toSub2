import assert from "node:assert/strict";
import { hydrateWorkspaceSettings, refreshWorkspaceSmsPermissions, clearWorkspaceSettings, readWorkspaceValue, writeWorkspaceValue, flushWorkspaceSettings } from "../web/src/cdk-api.mjs";

const savedWindow = globalThis.window; const savedFetch = globalThis.fetch;
const smsKey = "chatgpt-onboarding.sms-provider-settings-v1"; const proxyKey = "chatgpt-onboarding.account-proxy-v1";
const posts = [];
globalThis.window = { localStorage: { getItem: () => null }, dispatchEvent() {} };
globalThis.fetch = async (url, options) => { assert.equal(url, "/api/settings/workspace"); posts.push(JSON.parse(options.body)); return Response.json({ ok: true }); };
const bootstrap = (allowed, settings = {}) => ({ token: "fixture-token", account: { id: "tenant", role: "user" }, workspace: { id: "tenant", balance: 10, allowedSmsProviders: allowed }, settings });
try {
  const originalSms = { selectedProviderId: "smsbower", configs: { custom: { entries: "fixture" }, smsbower: { apiKey: "fixture-hidden-key" } } };
  hydrateWorkspaceSettings(bootstrap(["custom", "smsbower"], { [smsKey]: JSON.stringify(originalSms), [proxyKey]: "original-fixture" }));
  writeWorkspaceValue(proxyKey, "unsaved-fixture");
  refreshWorkspaceSmsPermissions(bootstrap(["custom"], { [smsKey]: JSON.stringify({ selectedProviderId: "custom", configs: { custom: { entries: "server" } } }), [proxyKey]: "original-fixture" }));
  assert.equal(readWorkspaceValue(proxyKey), "unsaved-fixture", "permission refresh preserves unrelated unsaved configuration");
  assert.equal(JSON.parse(readWorkspaceValue(smsKey)).selectedProviderId, "custom");
  assert.equal(JSON.parse(readWorkspaceValue(smsKey)).configs.smsbower, undefined, "revoked credentials leave the current browser workspace cache");
  writeWorkspaceValue(smsKey, JSON.stringify(originalSms));
  await flushWorkspaceSettings();
  assert.equal(posts.length, 1);
  const submitted = JSON.parse(posts[0].settings[smsKey]);
  assert.equal(submitted.selectedProviderId, "custom"); assert.equal(submitted.configs.smsbower, undefined);
  assert.equal(posts[0].settings[proxyKey], "unsaved-fixture");
  refreshWorkspaceSmsPermissions(bootstrap(["custom", "smsbower"], { [smsKey]: JSON.stringify(originalSms) }));
  assert.equal(JSON.parse(readWorkspaceValue(smsKey)).configs.smsbower.apiKey, "fixture-hidden-key", "regranting restores only the now-authorized server configuration");
  assert.equal(readWorkspaceValue(proxyKey), "unsaved-fixture");
  console.log("[ok] CDK SMS client settings: revoked provider filtering, unsaved configuration preservation, sanitized saves and regrant restoration; synthetic fixtures only.");
} finally { clearWorkspaceSettings(); globalThis.window = savedWindow; globalThis.fetch = savedFetch; }
