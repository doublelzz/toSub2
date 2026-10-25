// Policies apply only to the existing short-activation getNumber adapters.
// They are estimates, never provider-confirmed timestamps or rental policies.
// Hero: https://hero-sms.com/rules (short activation 20 min; cancel after 2 min).
// SMSBower: https://smsbower.app/ (25 min),
// https://smsbower.app/api/?page=client (setStatus cancellation after 2 min).
export const SHORT_ACTIVATION_POLICIES = Object.freeze({
  herosms: Object.freeze({ kind: "short_activation", lifetimeSeconds: 20 * 60, minCancelAgeSeconds: 120,
    source: "https://hero-sms.com/rules" }),
  smsbower: Object.freeze({ kind: "short_activation", lifetimeSeconds: 25 * 60, minCancelAgeSeconds: 120,
    source: "https://smsbower.app/api/?page=client", lifetimeSource: "https://smsbower.app/" }),
});

export function orderTimestamp(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  let timestamp;
  if (typeof value === "number" || typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)) {
    const number = Number(value);
    timestamp = number < 100_000_000_000 ? number * 1000 : number;
  } else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    timestamp = Date.parse(value);
  }
  if (!Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1) || timestamp > Date.UTC(2200, 0, 1)) return null;
  return new Date(timestamp).toISOString();
}

export function providerOrderLifecycle(data) {
  const firstTime = values => values.map(orderTimestamp).find(Boolean);
  const result = {};
  const fields = {
    // activationTime is the creation time in getNumberV2; it is not expiry.
    createdAt: [data.createdAt, data.created_at, data.activationTime],
    expiresAt: [data.expiresAt, data.expires_at, data.expirationTime, data.expiration_time],
    cancelAllowedAt: [data.cancelAllowedAt, data.cancel_allowed_at],
    cancelBeforeAt: [data.cancelBeforeAt, data.cancel_before_at],
  };
  for (const [field, values] of Object.entries(fields)) {
    const timestamp = firstTime(values);
    if (timestamp) { result[field] = timestamp; result[`${field}Source`] = "provider"; }
  }
  return result;
}

export function withShortActivationLifecycle(order, providerId, requestedAt, receivedAt) {
  const policy = SHORT_ACTIVATION_POLICIES[providerId];
  if (!policy) return { ...order };
  const next = { ...order };
  if (!next.createdAt) { next.createdAt = new Date(requestedAt).toISOString(); next.createdAtSource = "request_started"; }
  if (!next.expiresAt) {
    // Start from before the purchase request, rather than extending the window
    // by response latency. Even a returned creation timestamp is not expiry.
    next.expiresAt = new Date(requestedAt + policy.lifetimeSeconds * 1000).toISOString();
    next.expiresAtSource = "provider_policy";
  }
  if (!next.cancelAllowedAt) {
    // Waiting from receipt is conservative: the activation exists by then.
    next.cancelAllowedAt = new Date(receivedAt + policy.minCancelAgeSeconds * 1000).toISOString();
    next.cancelAllowedAtSource = "provider_policy";
  }
  if (!next.cancelBeforeAt) { next.cancelBeforeAt = next.expiresAt; next.cancelBeforeAtSource = next.expiresAtSource; }
  return next;
}

export function inspectActivationStatus(text) {
  if (text === "STATUS_WAIT_CODE") return { state: "waiting", hasSms: false };
  // Retry/resend states may refer to a previously delivered SMS. They are not
  // safe unassigned buffer inventory, even though getSms may wait for a new code.
  if (text.startsWith("STATUS_OK:") || text.startsWith("STATUS_WAIT_RETRY") || text === "STATUS_WAIT_RESEND") return { state: "received", hasSms: true };
  if (text === "STATUS_CANCEL") return { state: "cancelled", hasSms: false };
  return { state: "unknown", hasSms: false };
}

export function cancellationReceipt(requestId) {
  // ACCESS_CANCEL confirms cancellation acknowledgement only. It contains no
  // balance transaction evidence, so a refund remains unconfirmed.
  return { requestId: String(requestId), cancelled: true, receipt: "ACCESS_CANCEL", refundStatus: "unconfirmed" };
}
