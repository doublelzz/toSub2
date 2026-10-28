import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createCdkStore } from "../src/cdk-store.mjs";
import { createSmsPool } from "../src/sms-pool.mjs";

process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
process.env.TOSUB2_ADMIN_CDK = "synthetic-sms-pool-administrator-only";
const roots = []; let checks = 0;
const ok = (condition, message) => { assert.ok(condition, message); checks++; };
async function fixture(provider) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-sms-pool-")); roots.push(root);
  const vault = await createCdkVault(root); const store = await createCdkStore(root, vault); let tick = Date.now(); let numberCount = 0;
  const adminId = store.adminId; const [first, second] = store.generate({ count: 2, quota: 30, note: "synthetic" }, adminId);
  store.inventory(first.id, ["same@example.invalid"]); store.inventory(second.id, ["same@example.invalid"]); store.inventory(adminId, ["same@example.invalid"]);
  const pool = createSmsPool({ store, createProvider: provider || (() => ({ getNumber: async () => ({ requestId: crypto.randomUUID(), number: `+1202555${String(++numberCount).padStart(4, "0")}` }) })), now: () => tick, retryDelayMs: 0 });
  pool.saveRules({ enabled: true, fee: 3, requestConcurrency: 4 }, adminId);
  pool.saveCredential({ name: "Synthetic Hero", providerId: "herosms", apiKey: "synthetic-key-123" }, adminId);
  const credentialId = pool.adminSnapshot().credentials[0].id;
  pool.saveEntry({ credentialId, country: "1", countryLabel: "Synthetic country", maxPrice: "0.25", priority: 1 }, adminId);
  const user = pool.forOwner(first.id);
  const begin = (operationId = crypto.randomUUID(), jobId = crypto.randomUUID()) => { const input = { operationId, jobId, runId: crypto.randomUUID(), email: "same@example.invalid" }; user.begin(input); return input; };
  return { root, vault, store, pool, user, first, second, adminId, credentialId, begin, advance: (ms) => { tick += ms; } };
}
const evidence = (input, allocation) => ({ version: 1, type: "phone_verification", state: "verified", operationId: input.operationId, allocationId: allocation.allocationId,
  jobId: input.jobId, runId: input.runId, orderId: allocation.order.requestId, providerId: allocation.providerId, eventId: crypto.randomUUID(), verifiedAt: new Date().toISOString() });

try {
  const value = await fixture();
  try {
    assert.throws(() => value.user.begin({ operationId: crypto.randomUUID(), jobId: crypto.randomUUID(), runId: crypto.randomUUID(), email: "same@example.invalid", expectedFee: 999 }), (error) => error.code === "SMS_POOL_FEE_CHANGED");
    ok(value.store.get(value.first.id).reserved === 0, "changed fee rejects before reservation or purchase");
    const input = value.begin();
    ok(value.store.get(value.first.id).balance === 27 && value.store.get(value.first.id).reserved === 3, "start only reserves fee");
    value.user.begin(input); ok(value.store.get(value.first.id).reserved === 3, "begin is idempotent");
    assert.throws(() => value.user.begin({ ...input, email: "wrong@example.invalid" }), /任务不同/);
    assert.throws(() => value.user.begin({ ...input, operationId: crypto.randomUUID() }), /已有待完成/);
    assert.throws(() => value.pool.forOwner(value.second.id).recover(input.operationId), /不存在/);
    const allocation = await value.user.getNumber({ operationId: input.operationId });
    value.pool.saveRules({ fee: 8 }, value.adminId);
    ok(value.user.begin({ ...input, expectedFee: 8 }).fee === 3, "existing operation retry keeps original quoted fee");
    value.pool.saveCredential({ id: value.credentialId, apiKey: "rotated-synthetic-key" }, value.adminId);
    value.pool.patchEntry(allocation.entryId, { maxPrice: "0.5", enabled: false }, value.adminId);
    const recovered = value.user.recover(input.operationId);
    ok(recovered.allocation.config.apiKey === "synthetic-key-123" && recovered.allocation.config.maxPrice === "0.25", "active allocation keeps original encrypted configuration");
    value.user.noteSubmitted({ operationId: input.operationId, allocationId: allocation.allocationId, orderId: allocation.order.requestId });
    assert.throws(() => value.user.verified({ ...input, ...allocation, evidence: { type: "phone_verified" } }), /不完整/);
    const receipt = evidence(input, allocation);
    value.user.verified({ ...input, ...allocation, evidence: receipt });
    value.user.verified({ ...input, ...allocation, evidence: receipt });
    value.user.release({ operationId: input.operationId, reason: "duplicate cancel" });
    const cdk = value.store.get(value.first.id);
    ok(cdk.balance === 27 && cdk.reserved === 0 && cdk.consumed === 3 && cdk.smsPoolConsumed === 3 && cdk.importConsumed === 0 && cdk.everConsumed, "only confirmed phone verification commits the frozen fee once");
    ok(value.store.ledger(value.first.id).filter((row) => row.kind === "sms-pool").length === 1, "one fee ledger record");
    assert.throws(() => value.store.mergePreview(value.second.id, value.first.secret), /曾消耗/);
    const raw = await fs.readFile(path.join(value.root, ".cdk", "cdk.sqlite"));
    ok(!raw.includes(Buffer.from("synthetic-key-123")), "configuration and allocation secrets are not plain text in database");
    const snapshot = JSON.stringify(value.pool.adminSnapshot());
    ok(!snapshot.includes("synthetic-key-123") && !snapshot.includes("rotated-synthetic-key") && !snapshot.includes("12025550123"), "admin snapshot redacts API keys and full phones");
  } finally { value.store.close(); }

  let noStockCalls = 0;
  const noStock = await fixture(() => ({ getNumber: async () => { noStockCalls++; throw Object.assign(new Error("fixture no stock"), { code: "NO_NUMBERS" }); } }));
  try {
    noStock.pool.saveRules({ maxAttempts: 1 }, noStock.adminId);
    for (let index = 0; index < 3; index++) { const input = noStock.begin(); await assert.rejects(noStock.user.getNumber(input), (error) => error.code === "SMS_POOL_LIMIT"); }
    ok(noStockCalls === 3 && noStock.pool.adminSnapshot().entries[0].state === "cooling", "consecutive NO_NUMBERS trips only entry breaker");
    noStock.pool.patchEntry(noStock.pool.adminSnapshot().entries[0].id, { priority: 9 }, noStock.adminId);
    ok(noStock.pool.adminSnapshot().entries[0].noStockCount === 3 && noStock.pool.adminSnapshot().entries[0].state === "cooling", "priority edit does not clear no-stock breaker");
    noStock.pool.patchEntry(noStock.pool.adminSnapshot().entries[0].id, { grade: "gold", gradeFilter: "gold" }, noStock.adminId);
    ok(noStock.pool.adminSnapshot().entries[0].grade === "gold" && noStock.pool.adminSnapshot().entries[0].gradeFilter === "gold"
      && noStock.pool.adminSnapshot().entries[0].noStockCount === 3 && noStock.pool.adminSnapshot().entries[0].state === "cooling", "quote grade metadata persists without resetting route health");
    ok(noStock.store.get(noStock.first.id).balance === 30 && noStock.store.get(noStock.first.id).reserved === 0 && !noStock.store.get(noStock.first.id).everConsumed, "no stock never consumes quota or lifetime eligibility");
    noStock.advance(16 * 60000); ok(noStock.pool.publicSummary().available, "cooling entry becomes eligible for a real task probe");
  } finally { noStock.store.close(); }

  let resolveProbe; let probeCalls = 0;
  const probe = await fixture(() => ({ getNumber: async () => { probeCalls++; return probeCalls === 1 ? await new Promise((resolve) => { resolveProbe = resolve; }) : { requestId: "after-probe", number: "+12025550124" }; } }));
  try {
    probe.store.mutateSmsPoolConfig((state) => { state.entries[0].cooldownUntil = 1; state.entries[0].noStockCount = 3; return state; });
    const first = probe.begin(); const one = probe.user.getNumber(first); const duplicate = probe.user.getNumber(first);
    ok(probe.pool.publicSummary().available, "single healthy probing entry does not make public pool appear disabled");
    const second = probe.begin(); const waiting = probe.user.getNumber(second);
    await new Promise((resolve) => setTimeout(resolve, 40));
    ok(probeCalls === 1, "only one half-open probe across concurrent jobs");
    resolveProbe({ requestId: "probe-order", number: "+12025550123" });
    const [allocation, same] = await Promise.all([one, duplicate]);
    await waiting;
    ok(allocation.allocationId === same.allocationId && probe.pool.adminSnapshot().entries[0].noStockCount === 0, "duplicate acquisition shares allocation and success resets breaker");
    probe.user.release({ operationId: first.operationId, reason: "not submitted" });
    probe.user.release({ operationId: second.operationId, reason: "not submitted" });
  } finally { probe.store.close(); }

  const auth = await fixture(() => ({ getNumber: async () => { throw Object.assign(new Error("fixture bad key"), { code: "BAD_KEY" }); } }));
  try {
    auth.pool.saveCredential({ name: "Duplicate credential", providerId: "herosms", apiKey: "synthetic-key-123" }, auth.adminId);
    const duplicate = auth.pool.adminSnapshot().credentials.at(-1).id;
    auth.pool.saveEntry({ credentialId: duplicate, country: "2", maxPrice: "0.25" }, auth.adminId);
    const input = auth.begin(); await assert.rejects(auth.user.getNumber(input));
    ok(auth.pool.adminSnapshot().credentials.every((row) => row.blockedReason === "auth_invalid"), "invalid key blocks every duplicate credential with same key");
    ok(auth.pool.adminSnapshot().entries.every((row) => row.noStockCount === 0), "credential failure does not increment no-stock count");
  } finally { auth.store.close(); }

  for (const code of ["WRONG_MAX_PRICE", "UNPROCESSABLE_ENTITY"]) {
    const invalid = await fixture(() => ({ getNumber: async () => { throw Object.assign(new Error("fixture rejected parameters"), { code }); } }));
    try {
      const input = invalid.begin(); await assert.rejects(invalid.user.getNumber(input), (error) => error.code === "SMS_POOL_NO_NUMBERS");
      ok(invalid.pool.adminSnapshot().entries[0].state === "disabled" && invalid.pool.adminSnapshot().entries[0].lastError === "config_invalid", `${code} disables only invalid entry`);
      ok(invalid.store.get(invalid.first.id).reserved === 0 && invalid.store.get(invalid.first.id).consumed === 0, `${code} releases reservation without consumption`);
    } finally { invalid.store.close(); }
  }

  let unknownCalls = 0;
  const unknown = await fixture(() => ({ getNumber: async () => { unknownCalls++; throw new Error("fixture timeout"); } }));
  try {
    const input = unknown.begin(); await assert.rejects(unknown.user.getNumber(input), (error) => error.code === "SMS_POOL_UNKNOWN" && error.uncertain);
    unknown.user.release({ operationId: input.operationId, reason: "cancel" });
    ok(unknown.store.get(unknown.first.id).reserved === 3 && unknown.user.recover(input.operationId).state === "unknown", "ambiguous purchase preserves reservation");
    unknown.store.close(); unknown.store = await createCdkStore(unknown.root, unknown.vault);
    const restored = createSmsPool({ store: unknown.store, createProvider: () => { throw new Error("must not retry"); } });
    await assert.rejects(restored.forOwner(unknown.first.id).getNumber(input), (error) => error.code === "SMS_POOL_UNKNOWN");
    ok(unknownCalls === 1, "restart does not retry unknown purchase");
    assert.throws(() => restored.reconcile(input.operationId, { action: "release", note: "" }, unknown.adminId), /依据/);
    restored.reconcile(input.operationId, { cdkId: unknown.first.id, action: "release", note: "Provider console confirmed no activation" }, unknown.adminId);
    ok(unknown.store.get(unknown.first.id).reserved === 0 && unknown.store.get(unknown.first.id).balance === 30, "audited reconciliation can release confirmed failure");
  } finally { unknown.store.close(); }

  let finishOverpriced;
  const overpriced = await fixture(() => ({ getNumber: () => new Promise((resolve) => { finishOverpriced = resolve; }) }));
  try {
    const input = overpriced.begin(); const purchase = overpriced.user.getNumber(input);
    const operationStartedAt = overpriced.store.smsOperation(overpriced.first.id, input.operationId).createdAt;
    overpriced.advance(24 * 60 * 60000);
    finishOverpriced({ requestId: "overpriced-next-day", number: "+12025550888", cost: { amount: "0.5", currency: "USD", source: "order" } });
    await assert.rejects(purchase, (error) => error.code === "SMS_POOL_UNKNOWN");
    const allocation = overpriced.user.recover(input.operationId).allocation;
    ok(allocation.createdAt >= operationStartedAt + 24 * 60 * 60000 - 1000, "a known order returned with an error records its acquisition date rather than the reservation date");
    ok(overpriced.store.smsOperationCostOrders(overpriced.store.smsOperation(overpriced.first.id, input.operationId))[0].createdAt === allocation.createdAt, "abnormal purchased order cost history keeps the actual acquisition day");
  } finally { overpriced.store.close(); }

  const limit = await fixture();
  try {
    limit.pool.saveRules({ maxAttempts: 1, requestConcurrency: 1 }, limit.adminId);
    const first = limit.begin(); const additional = limit.begin();
    ok(limit.user.recover(additional.operationId).state === "reserved", "another operation is accepted while an earlier operation remains unsettled");
    limit.user.release(additional);
    const allocation = await limit.user.getNumber(first);
    limit.user.noteSubmitted({ operationId: first.operationId, allocationId: allocation.allocationId });
    assert.throws(() => limit.user.abandon({ operationId: first.operationId, allocationId: allocation.allocationId }), (error) => error.uncertain);
    limit.user.abandon({ operationId: first.operationId, allocationId: allocation.allocationId, confirmedFailure: true });
    await assert.rejects(limit.user.getNumber(first), (error) => error.code === "SMS_POOL_LIMIT");
    ok(limit.store.get(limit.first.id).reserved === 0, "attempt cap releases only confirmed failures");
    const second = limit.begin(); const allocated = await limit.user.getNumber(second);
    limit.user.noteSubmitted({ operationId: second.operationId, allocationId: allocated.allocationId });
    limit.store.update(limit.first.id, { status: "disabled" }, limit.adminId);
    limit.user.verified({ ...second, ...allocated, evidence: evidence(second, allocated) });
    ok(limit.store.get(limit.first.id).consumed === 3, "already-authorized successful verification settles after CDK disabled");
    assert.throws(() => limit.begin(), /禁用/);
  } finally { limit.store.close(); }

  const rejectedRecovery = await fixture();
  try {
    const input = rejectedRecovery.begin(); const allocation = await rejectedRecovery.user.getNumber(input);
    rejectedRecovery.user.noteSubmitted({ operationId: input.operationId, allocationId: allocation.allocationId });
    rejectedRecovery.user.release({ operationId: input.operationId, uncertain: true });
    rejectedRecovery.user.abandon({ operationId: input.operationId, allocationId: allocation.allocationId, confirmedFailure: true });
    rejectedRecovery.user.release({ operationId: input.operationId, reason: "durable matching rejected proof" });
    ok(rejectedRecovery.store.get(rejectedRecovery.first.id).reserved === 0 && rejectedRecovery.store.get(rejectedRecovery.first.id).consumed === 0, "matching explicit rejection can resolve unknown allocated verification without charge");
  } finally { rejectedRecovery.store.close(); }

  let rejectOld;
  const rotated = await fixture(() => ({ getNumber: () => new Promise((resolve, reject) => { rejectOld = reject; }) }));
  try {
    const input = rotated.begin(); const pending = rotated.user.getNumber(input);
    rotated.pool.saveCredential({ id: rotated.credentialId, apiKey: "new-synthetic-key" }, rotated.adminId);
    rejectOld(Object.assign(new Error("old key invalid"), { code: "BAD_KEY" })); await assert.rejects(pending);
    ok(!rotated.pool.adminSnapshot().credentials[0].blockedReason, "late error from old key cannot disable newly rotated credential");
  } finally { rotated.store.close(); }

  const fallback = await fixture((id, providerConfig) => ({ getNumber: async () => {
    if (providerConfig.country === "1") throw Object.assign(new Error("fixture no stock"), { code: "NO_NUMBERS" });
    return { requestId: "fallback-order", number: "+12025550123" };
  } }));
  try {
    fallback.pool.saveEntries({ entries: [{ credentialId: fallback.credentialId, country: "2", maxPrice: "0.3", priority: 2 }] }, fallback.adminId);
    const input = fallback.begin(); const allocation = await fallback.user.getNumber(input);
    ok(allocation.config.country === "2" && fallback.user.recover(input.operationId).attempts === 2 && fallback.store.get(fallback.first.id).reserved === 3, "falls through no-stock candidate while holding one fee");
    fallback.user.release({ operationId: input.operationId, reason: "synthetic cancel" });
    fallback.pool.saveRules({ fee: 31 }, fallback.adminId);
    assert.throws(() => fallback.begin(), (error) => error.code === "INSUFFICIENT_QUOTA");
    ok(fallback.store.get(fallback.first.id).reserved === 0, "quota shortage never starts provider purchase");
  } finally { fallback.store.close(); }

  const selectedCountries = [];
  const roundRobin = await fixture((id, config) => ({ getNumber: async () => { selectedCountries.push(config.country); return { requestId: crypto.randomUUID(), number: `+1202555${String(selectedCountries.length).padStart(4, "0")}` }; } }));
  try {
    roundRobin.pool.saveEntry({ credentialId: roundRobin.credentialId, country: "2", maxPrice: "0.25", priority: 1 }, roundRobin.adminId);
    for (let index = 0; index < 4; index++) { const input = roundRobin.begin(); await roundRobin.user.getNumber(input); roundRobin.user.release({ operationId: input.operationId }); }
    ok(selectedCountries.length === 4 && selectedCountries[0] !== selectedCountries[1] && selectedCountries[0] === selectedCountries[2] && selectedCountries[1] === selectedCountries[3], "equal-priority entries round robin even with fixed clock");
  } finally { roundRobin.store.close(); }

  let finishFirst; let serialCalls = 0;
  const serialized = await fixture(() => ({ getNumber: async () => { serialCalls++; if (serialCalls === 1) await new Promise((resolve) => { finishFirst = resolve; }); return { requestId: crypto.randomUUID(), number: `+1202555${String(serialCalls).padStart(4, "0")}` }; } }));
  try {
    const one = serialized.begin(); const two = serialized.begin();
    const firstPurchase = serialized.user.getNumber(one); const secondPurchase = serialized.user.getNumber(two);
    await new Promise((resolve) => setTimeout(resolve, 40)); ok(serialCalls === 1, "normal entry holds one purchase lease across concurrent sessions");
    finishFirst(); await Promise.all([firstPurchase, secondPurchase]); ok(serialCalls === 2, "waiting concurrent session purchases after lease release");
    serialized.user.release({ operationId: one.operationId }); serialized.user.release({ operationId: two.operationId });
    ok(!JSON.stringify(serialized.pool.adminSnapshot().entries).includes("inFlight"), "internal purchase lease never enters administrator snapshot");
  } finally { serialized.store.close(); }

  let finishShutdownPurchase;
  const shutdown = await fixture(() => ({ getNumber: () => new Promise((resolve) => { finishShutdownPurchase = resolve; }) }));
  try {
    const input = shutdown.begin(); const purchase = shutdown.user.getNumber(input).catch((error) => error); let closed = false;
    const closing = shutdown.pool.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 30)); ok(!closed, "central shutdown waits for in-flight purchase before store can close");
    finishShutdownPurchase({ requestId: "shutdown-order", number: "+12025550123" });
    const outcome = await purchase; await closing;
    ok(outcome.code === "SMS_POOL_CLOSED" && shutdown.store.inventoryItems().some((row) => row.order?.requestId === "shutdown-order"), "in-flight purchase finishing after shutdown is durably queued for cancellation");
    shutdown.user.release({ operationId: input.operationId, reason: "shutdown before submission" });
    ok(shutdown.store.get(shutdown.first.id).reserved === 0, "known unsubmitted order remains releasable during shutdown");
    await assert.rejects(shutdown.user.getNumber(input), (error) => error.code === "SMS_POOL_DISABLED");
  } finally { shutdown.store.close(); }

  const constructorFailure = await fixture(() => { throw new Error("local invalid provider configuration"); });
  try {
    const input = constructorFailure.begin(); await assert.rejects(constructorFailure.user.getNumber(input), (error) => error.code === "SMS_POOL_NO_NUMBERS");
    ok(constructorFailure.pool.adminSnapshot().entries[0].lastError === "config_invalid" && constructorFailure.store.get(constructorFailure.first.id).reserved === 0, "local provider construction failure never freezes an unissued purchase");
  } finally { constructorFailure.store.close(); }

  let releaseBlockingPurchase; let cancellationCalls = 0;
  const waitingCancel = await fixture(() => ({ getNumber: async () => { cancellationCalls++; if (cancellationCalls === 1) await new Promise((resolve) => { releaseBlockingPurchase = resolve; }); return { requestId: crypto.randomUUID(), number: "+12025550123" }; } }));
  try {
    const first = waitingCancel.begin(); const active = waitingCancel.user.getNumber(first);
    const second = waitingCancel.begin(); const secondOutcome = waitingCancel.user.getNumber(second).catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 30));
    waitingCancel.user.release({ operationId: second.operationId, reason: "canceled while waiting for credential lease" });
    releaseBlockingPurchase(); await active;
    const rejected = await secondOutcome;
    ok(rejected.code === "SMS_POOL_CLOSED" && cancellationCalls === 1, "cancellation during credential wait cannot purchase after quota was released");
    waitingCancel.user.release({ operationId: first.operationId });
  } finally { waitingCancel.store.close(); }

  let limitedCalls = 0;
  const throttled = await fixture(() => ({ getNumber: async () => { limitedCalls++; throw Object.assign(new Error("fixture rate limited"), { code: "RATE_LIMIT" }); } }));
  try {
    throttled.pool.saveCredential({ name: "Same account", providerId: "herosms", apiKey: "synthetic-key-123" }, throttled.adminId);
    const duplicate = throttled.pool.adminSnapshot().credentials.at(-1).id;
    throttled.pool.saveEntry({ credentialId: duplicate, country: "2", maxPrice: "0.25" }, throttled.adminId);
    const input = throttled.begin(); await assert.rejects(throttled.user.getNumber(input));
    ok(limitedCalls === 1 && throttled.pool.adminSnapshot().credentials.every((row) => row.cooldownUntil > Date.now()), "rate limit backs off every duplicate credential sharing the key");
    ok(throttled.pool.adminSnapshot().entries.every((row) => row.state === "cooling" && row.noStockCount === 0), "credential backoff is visible and does not count as stock failure");
    throttled.pool.saveCredential({ id: throttled.credentialId, name: "Renamed only" }, throttled.adminId);
    ok(throttled.pool.adminSnapshot().credentials[0].cooldownUntil > Date.now(), "renaming a credential cannot silently clear rate-limit backoff");
  } finally { throttled.store.close(); }

  const actors = await fixture();
  try {
    const input = { operationId: crypto.randomUUID(), jobId: crypto.randomUUID(), runId: crypto.randomUUID(), email: "same@example.invalid", actorId: actors.second.id };
    assert.throws(() => actors.user.begin(input), (error) => error.status === 403);
    const trusted = { ...input, actorId: actors.adminId }; actors.user.begin(trusted);
    const allocation = await actors.user.getNumber(trusted); actors.user.verified({ ...trusted, ...allocation, evidence: evidence(trusted, allocation) });
    ok(actors.store.ledger(actors.first.id).find((row) => row.kind === "sms-pool").actorId === actors.adminId, "administrator acting in tenant workspace is the actual ledger actor while tenant pays");
    const body = { email: "new@example.invalid" }; const record = actors.store.prepareImport(actors.first.id, "single", [body.email], body, "admin-import", actors.adminId);
    ok(record.actor_id === actors.adminId && JSON.stringify(actors.store.importPayload(record)) === JSON.stringify(body), "durable import actor is stored separately from request body and digest");
    actors.store.close(); actors.store = await createCdkStore(actors.root, actors.vault);
    ok(actors.store.pendingImports()[0].actor_id === actors.adminId, "actual import initiator survives a real store reopen for recovery");
    actors.store.abortImport(actors.store.pendingImports()[0]);
  } finally { actors.store.close(); }

  const history = await fixture();
  try {
    for (let index = 0; index < 505; index++) {
      const input = { operationId: `history-${index}`, jobId: `history-job-${index}`, runId: `history-run-${index}`, email: "same@example.invalid", actorId: history.adminId, fee: 0, maxConcurrent: 5 };
      history.store.prepareSmsOperation(history.adminId, input); history.store.settleSmsOperation(history.adminId, input.operationId, { reason: "synthetic history" });
    }
    const firstPage = history.pool.operationsPage({ page: 1, pageSize: 100, cdkId: history.adminId });
    const sixthPage = history.pool.operationsPage({ page: 6, pageSize: 100, cdkId: history.adminId, state: "released" });
    ok(firstPage.total === 505 && firstPage.pages === 6 && firstPage.items.length === 100 && sixthPage.items.length === 5, "all operations remain accessible beyond 500 historical records");
    ok(firstPage.items[0].operationId === "history-504" && sixthPage.items.at(-1).operationId === "history-0", "history pagination has stable newest-first order and reaches the oldest operation");
    assert.throws(() => history.pool.operationsPage({ pageSize: 500 }), (error) => error.status === 422);
    assert.throws(() => history.pool.operationsPage({ state: "invalid" }), (error) => error.status === 422);
  } finally { history.store.close(); }

  console.log(`[ok] SMS pool: ${checks} scenario assertions plus rejection/identity checks passed; local stubs only.`);
} finally {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
}
