import assert from "node:assert/strict";
import { cdkFetch, hydrateWorkspaceSettings, clearWorkspaceSettings, setImportConfirmation } from "../web/src/cdk-api.mjs";

const previousWindow = globalThis.window; const previousFetch = globalThis.fetch;
const events = []; const replies = [];
globalThis.window = { dispatchEvent: (event) => { events.push(event.type); return true; }, localStorage: { getItem: () => null } };
globalThis.fetch = async (url) => {
  const next = replies.shift(); assert.ok(next, `Missing fixture response for ${url}`);
  if (next.url) assert.equal(url, next.url);
  return Response.json(next.body || {}, { status: next.status || 200, headers: next.headers || {} });
};
const bootstrap = (id, balance, reserved = 0) => ({ token: `fixture-${id}`, account: { id, role: "user" }, workspace: { id, balance, reserved }, settings: {} });
const quota = (owner, balance, reserved) => ({ "x-cdk-id": owner, "x-cdk-balance": String(balance), "x-cdk-reserved": String(reserved) });
const count = () => events.filter((type) => type === "cdk-balance-changed").length;
try {
  hydrateWorkspaceSettings(bootstrap("tenant-a", 10));
  replies.push({ headers: quota("tenant-a", 8, 2) }); await cdkFetch("/api/jobs");
  assert.equal(count(), 1, "new reservation notifies exactly once");
  replies.push({ headers: quota("tenant-a", 8, 2) }); await cdkFetch("/api/jobs");
  assert.equal(count(), 1, "same quota poll does not notify again");
  replies.push({ headers: quota("tenant-a", 8, 0) }); await cdkFetch("/api/jobs");
  assert.equal(count(), 2, "successful settlement reserved change notifies even when available balance unchanged");
  replies.push({ headers: quota("tenant-a", 10, 0) }); await cdkFetch("/api/jobs");
  assert.equal(count(), 3, "failed-operation release notifies balance restoration");
  replies.push({ headers: quota("tenant-b", 1, 5) }); await cdkFetch("/api/jobs");
  assert.equal(count(), 3, "cross-workspace response cannot change current quota state");
  replies.push({ headers: quota("tenant-a", 10, 0) }); await cdkFetch("/api/jobs");
  assert.equal(count(), 3, "ignored foreign response cannot contaminate local last quota");
  replies.push({ headers: { "x-cdk-balance": "3", "x-cdk-reserved": "0" } }); await cdkFetch("/api/jobs");
  assert.equal(count(), 3, "ownerless response ignored");
  replies.push({ headers: { "x-cdk-id": "tenant-a", "x-cdk-balance": "3" } }); await cdkFetch("/api/jobs");
  assert.equal(count(), 3, "partial quota response ignored");

  let answerOld; globalThis.fetch = () => new Promise((resolve) => { answerOld = resolve; });
  const oldRequest = cdkFetch("/api/jobs"); hydrateWorkspaceSettings(bootstrap("tenant-b", 7));
  answerOld(Response.json({}, { headers: quota("tenant-a", 2, 0) })); await oldRequest;
  assert.equal(count(), 3, "late response after workspace switch ignored");
  globalThis.fetch = async () => Response.json({}, { headers: quota("tenant-b", 5, 2) });
  await cdkFetch("/api/jobs"); assert.equal(count(), 4, "new current workspace quota notifies");
  hydrateWorkspaceSettings(bootstrap("tenant-b", 5, 2)); await cdkFetch("/api/jobs");
  assert.equal(count(), 4, "bootstrap refresh retains last quota without a notification loop");
  clearWorkspaceSettings(); await cdkFetch("/api/jobs"); assert.equal(count(), 4, "logged-out workspace ignores quota replies");

  hydrateWorkspaceSettings(bootstrap("tenant-a", 10)); setImportConfirmation(async () => true);
  globalThis.fetch = async (url) => url === "/api/imports/preview" ? Response.json({ canImport: true, added: 1, charge: 1, balance: 10 })
    : Response.json({}, { headers: quota("tenant-a", 9, 0) });
  const beforeImport = count(); await cdkFetch("/api/jobs", { method: "POST", body: JSON.stringify({ email: "fixture@example.invalid" }) });
  assert.equal(count(), beforeImport + 1, "import with matching changed quota header notifies once");
  console.log("[ok] CDK quota events: owner-bound changes, reservation/settlement/release, duplicate polls, workspace races, logout, and imports passed; fake browser/fetch only.");
} finally { clearWorkspaceSettings(); setImportConfirmation(null); globalThis.window = previousWindow; globalThis.fetch = previousFetch; }
