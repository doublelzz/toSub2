import assert from "node:assert/strict";
import { parseNumberOrder, phoneVerificationStatus, publicSmsSummary, recordSmsOrder } from "../src/sms-orders.mjs";

assert.deepEqual(parseNumberOrder("ACCESS_NUMBER:legacy-1:60123456789"), { requestId: "legacy-1", number: "+60123456789" });
assert.deepEqual(parseNumberOrder(JSON.stringify({ activationId: "v2-1", phoneNumber: "+60123456789", activationCost: "0.42", activationCurrency: "USD" })), {
  requestId: "v2-1", number: "+60123456789", cost: { amount: "0.42", currency: "USD", source: "order" },
});
const job = { status: "phone", phoneBindingRequested: true, phoneBindingStartedAt: "2026-10-17T00:00:00Z", smsProviderId: "smsbower", smsProviderName: "SMSBower", smsProviderConfig: { country: "1001", quotedPrice: "0.42", maxPrice: "0.5" }, smsOrders: [] };
const order = recordSmsOrder(job, { requestId: "v2-1", number: "+60123456789", cost: { amount: "0.42", currency: "USD", source: "order" } });
order.verifiedAt = "2026-10-17T00:01:00Z";
order.status = "completed";
assert.equal(phoneVerificationStatus({ ...job, phoneVerifiedAt: order.verifiedAt }), "verified");
const summary = publicSmsSummary({ ...job, phoneVerifiedAt: order.verifiedAt });
assert.equal(summary.latest.amount, "0.42");
assert.equal(summary.latest.currency, "USD");
assert.deepEqual(summary.totals, [{ currency: "USD", amount: "0.42" }]);
assert.equal(summary.orders[0].phone, "********6789");
console.log("SMS order history: legacy/v2 number parsing, verified status, quote fallback and currency totals passed");
