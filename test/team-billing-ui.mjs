import assert from "node:assert/strict";
import { cdkFetch, setImportConfirmation } from "../web/src/cdk-api.mjs";

const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
let accepted = true, forbidden = false;
let quote = { count: 2, added: 1, updated: 1, charge: 1, balance: 2, after: 1, canImport: true };
const calls = [], confirmations = [], events = [];
globalThis.window = { dispatchEvent: (event) => events.push(event.type) };
globalThis.fetch = async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body), key: new Headers(options.headers).get("idempotency-key") });
  if (url === "/api/imports/preview") return forbidden ? Response.json({ code: "TEAM_FEATURE_FORBIDDEN", error: "Team 未开放" }, { status: 403 }) : Response.json(quote);
  if (url === "/api/teams/import") return Response.json({ accounts: [] });
  throw new Error("Unexpected billing UI request");
};
setImportConfirmation(async (value) => { confirmations.push(value); return accepted; });
const body = { text: "new@example.com----password\nold@example.com----password", digest: "preview-digest", requestKey: "team-billing-ui-key-0001" };
const submit = () => cdkFetch("/api/teams/import", { method: "POST", headers: { "content-type": "application/json", "x-console-token": "fixture-token" }, body: JSON.stringify(body) });
try {
  accepted = false; await assert.rejects(submit(), /已取消导入/);
  assert.equal(calls.length, 1); assert.equal(calls[0].body.mode, "team"); assert.equal(confirmations[0].charge, 1);
  calls.length = 0; confirmations.length = 0; accepted = true;
  await submit(); assert.equal(confirmations.length, 1); assert.deepEqual(calls.map((row) => row.url), ["/api/imports/preview", "/api/teams/import"]);
  assert.equal(calls[1].key, body.requestKey, "billing and Team import replay must share one request key");
  assert.deepEqual(calls[1].body, body); assert.ok(events.includes("cdk-balance-changed"));
  calls.length = 0; confirmations.length = 0; quote = { ...quote, canImport: false, balance: 0, after: -1 };
  await assert.rejects(submit(), /可用次数不足/); assert.equal(calls.length, 1); assert.equal(confirmations.length, 0);
  forbidden = true; await assert.rejects(submit(), /Team 未开放/); assert.ok(events.includes("cdk-session-refresh"));
  console.log("Team billing UI passed: explicit quota confirmation, cancellation, insufficient balance, shared replay key and revoked grant refresh");
} finally { setImportConfirmation(null); globalThis.fetch = originalFetch; if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow; }
