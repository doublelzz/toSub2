import assert from "node:assert/strict";
import { createHeroSmsClient } from "../src/hero-sms.mjs";
import { createSmsBowerClient } from "../src/smsbower.mjs";
import { createSmsProvider } from "../src/sms-providers.mjs";
import { parseNumberOrder } from "../src/sms-orders.mjs";
import { SHORT_ACTIVATION_POLICIES, inspectActivationStatus, orderTimestamp } from "../src/sms-order-lifecycle.mjs";

const start = Date.UTC(2026, 9, 25, 12);
let checks = 0;
const check = (value, expected, message) => { assert.deepEqual(value, expected, message); checks++; };
for (const [providerId, createClient, lifetime] of [["herosms", createHeroSmsClient, 1200], ["smsbower", createSmsBowerClient, 1500]]) {
  let tick = start;
  const actions = [];
  let status = "STATUS_WAIT_CODE";
  let acknowledgement = "ACCESS_CANCEL";
  const client = createClient({ apiKey: "synthetic-lifecycle-key", now: () => tick, fetchImpl: async input => {
    const url = new URL(input); const action = url.searchParams.get("action"); actions.push(action);
    if (action === "getNumber") { tick += 8000; return new Response("ACCESS_NUMBER:fixture-activation:12025550123"); }
    if (action === "getStatus") return new Response(status);
    if (action === "setStatus") return new Response(acknowledgement);
    throw new Error("unexpected local fixture action");
  } });
  const order = await client.getNumber("dr", "1", "0.1", "1");
  check(order.createdAt, new Date(start).toISOString(), "policy clock starts before the purchase request");
  check(order.expiresAt, new Date(start + lifetime * 1000).toISOString(), "response latency never extends estimated activation lifetime");
  check(order.expiresAtSource, "provider_policy", "estimated lifetime never masquerades as provider-returned expiry");
  check(order.cancelAllowedAt, new Date(start + 8000 + 120000).toISOString(), "minimum cancellation wait starts conservatively after receipt");
  check(order.cancelBeforeAt, order.expiresAt, "policy cancellation window ends by estimated activation expiry");
  check(client.activationPolicy.kind, "short_activation", "short-number policy cannot be reused as rental lifetime");
  check(client.activationPolicy.lifetimeSeconds, lifetime);
  check(actions, ["getNumber"], "prefetch never marks a number ready");
  for (const [raw, expected] of [
    ["STATUS_WAIT_CODE", { state: "waiting", hasSms: false }],
    ["STATUS_OK:654321", { state: "received", hasSms: true }],
    ["STATUS_WAIT_RETRY:654321", { state: "received", hasSms: true }],
    ["STATUS_WAIT_RESEND", { state: "received", hasSms: true }],
    ["STATUS_CANCEL", { state: "cancelled", hasSms: false }],
    ["NO_ACTIVATION", { state: "unknown", hasSms: false }],
    ["unexpected", { state: "unknown", hasSms: false }],
  ]) {
    status = raw;
    const result = await client.inspect(order.requestId);
    check(result, expected);
    assert.ok(!JSON.stringify(result).includes("654321"), "buffer inspection must not expose or retain OTP");
    assert.equal(Object.hasOwn(result, "code"), false);
  }
  check(await client.cancelStrict(order.requestId), { requestId: order.requestId, cancelled: true, receipt: "ACCESS_CANCEL", refundStatus: "unconfirmed" });
  check(await client.release(order.requestId), true, "legacy release remains boolean");
  for (const wrongAck of ["ACCESS_READY", "ACCESS_RETRY_GET", "ACCESS_ACTIVATION", "EARLY_CANCEL_DENIED"]) {
    acknowledgement = wrongAck;
    await assert.rejects(client.cancelStrict(order.requestId), /更新号码状态失败/); checks++;
    await assert.rejects(client.release(order.requestId), /更新号码状态失败/); checks++;
  }
  acknowledgement = "ACCESS_CANCEL";
  await assert.rejects(client.complete(order.requestId), /更新号码状态失败/); checks++;
  if (providerId === "smsbower") { await assert.rejects(client.markReady(order.requestId), /更新号码状态失败/); checks++; }
  else check(client.markReady, undefined);
}

const explicit = parseNumberOrder(JSON.stringify({ activationId: "api-order", phoneNumber: "12025550123", activationTime: "2026-10-25T11:59:00Z",
  expiresAt: "2026-10-25T12:19:00Z", cancelAllowedAt: 1792930000, cancelBeforeAt: "2026-10-25T12:18:00Z" }));
check(explicit.createdAt, "2026-10-25T11:59:00.000Z");
check(explicit.expiresAt, "2026-10-25T12:19:00.000Z");
check(explicit.expiresAtSource, "provider");
check(explicit.cancelAllowedAtSource, "provider");
for (const [providerId, createClient] of [["herosms", createHeroSmsClient], ["smsbower", createSmsBowerClient]]) {
  const client = createClient({ apiKey: "synthetic-lifecycle-key", now: () => start, fetchImpl: async () => Response.json({
    activationId: "api-order", phoneNumber: "12025550123", activationTime: "2026-10-25T11:59:00Z", expiresAt: explicit.expiresAt,
    cancelAllowedAt: explicit.cancelAllowedAt, cancelBeforeAt: explicit.cancelBeforeAt,
  }) });
  const order = await client.getNumber("dr", "1", "0.1", "1");
  check(order.expiresAt, explicit.expiresAt, "explicit provider expiry must survive normalization");
  check(order.expiresAtSource, "provider");
  check(order.cancelAllowedAt, explicit.cancelAllowedAt);
  const provider = createSmsProvider(providerId, { apiKey: "synthetic-lifecycle-key", country: "1", maxPrice: "0.1", providerIds: "1" }, {
    fetchImpl: async input => new Response(new URL(input).searchParams.get("action") === "getStatus" ? "STATUS_OK:654321" : "ACCESS_CANCEL"),
  });
  check(await provider.inspect("api-order"), { state: "received", hasSms: true });
  check((await provider.cancelReceipt("api-order")).refundStatus, "unconfirmed");
  check(provider.activationPolicy, SHORT_ACTIVATION_POLICIES[providerId]);
}
const creationOnly = parseNumberOrder(JSON.stringify({ activationId: "creation-only", phoneNumber: "12025550123", activationTime: "2026-10-25T12:00:00Z" }));
check(creationOnly.createdAtSource, "provider");
check(Object.hasOwn(creationOnly, "expiresAt"), false, "activationTime is creation, never exact expiry");
check(parseNumberOrder("ACCESS_NUMBER:legacy:12025550123"), { requestId: "legacy", number: "+12025550123" }, "raw legacy parser stays compatible");
check(inspectActivationStatus("STATUS_OK:unparseable SMS"), { state: "received", hasSms: true }, "any delivered SMS contaminates idle inventory, regardless of whether it contains six digits");
for (const value of ["2026-10-25T12:00:00", "2026-10-25 12:00:00", "2026-10-25", "10/25/2026 12:00", "Sun, 25 Oct 2026 12:00:00", "1792929600000000"]) {
  check(orderTimestamp(value), null, "a provider timestamp without explicit time zone or unsupported units must never use the host timezone");
}
for (const value of ["2026-10-25T12:00:00Z", "2026-10-25T20:00:00+08:00", start, String(start), start / 1000, String(start / 1000)]) {
  check(orderTimestamp(value), new Date(start).toISOString(), "explicit offset or Unix timestamp normalizes unambiguously");
}
const naiveClient = createHeroSmsClient({ apiKey: "synthetic-lifecycle-key", now: () => start, fetchImpl: async () => Response.json({
  activationId: "naive-expiry", phoneNumber: "12025550123", activationTime: "2026-10-25T12:00:00", expiresAt: "2026-10-25T12:20:00",
}) });
const naiveOrder = await naiveClient.getNumber("dr", "1", "0.1");
check(naiveOrder.expiresAt, new Date(start + 1200000).toISOString());
check(naiveOrder.expiresAtSource, "provider_policy", "naive provider expiry falls back to an explicitly estimated policy deadline");
check(naiveOrder.createdAtSource, "request_started", "naive activationTime is not treated as exact provider creation time");
console.log(`[ok] SMS activation lifecycle: ${checks} assertions; local fixtures only; exact/policy provenance, strict cancellation and OTP-free inspection.`);
