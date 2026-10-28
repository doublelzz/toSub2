import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { poolCostOrder, summarizePoolCosts } from "../src/sms-pool-costs.mjs";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createCdkStore } from "../src/cdk-store.mjs";
import { createSmsPool } from "../src/sms-pool.mjs";

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const actual = (amount, currency) => ({ amount, currency, source: "order" });
const descriptor = (cost) => poolCostOrder({ order: { requestId: "fixture", cost }, providerId: "smsbower", config: { quotedPrice: "9", maxPrice: "10", currency: "USD" } });
const decimals = summarizePoolCosts([descriptor(actual("0.1", "USD")), descriptor(actual("0.2", "USD")), descriptor(actual("0", "USD")),
  descriptor(actual("999999999999.99999999", "RUB")), descriptor(actual("0.00000001", "RUB")), descriptor(), descriptor(actual("1", null)), descriptor({ amount: "4", currency: "USD", source: "quote" })]);
check(decimals.byCurrency.find((row) => row.currency === "USD").confirmedPurchaseAmount === "0.3", "provider decimals summed exactly with zero retained");
check(decimals.byCurrency.find((row) => row.currency === "RUB").confirmedPurchaseAmount === "1000000000000", "large eight-place provider decimals do not overflow or round");
check(decimals.byCurrency.length === 2 && decimals.unknownCostCount === 2 && decimals.unknownCurrencyCount === 1, "currencies stay separate and missing actual/unknown currency are explicit");
check(descriptor().cost === null && descriptor().quote.amount === "9" && descriptor().maxPrice.amount === "10", "quote and price ceiling never become actual order cost");

const successOrder = (id, { cost, quote, currency = "USD", providerId = "smsbower" } = {}) => poolCostOrder({ providerId,
  order: { requestId: id, number: "+12025550123", cost }, config: { quotedPrice: quote, maxPrice: "99", currency } },
{ state: "verified", verifiedAt: "2026-10-28T02:00:00.000Z" });
const estimates = summarizePoolCosts([
  successOrder("actual", { cost: actual("0.1", "USD"), quote: "9" }),
  successOrder("estimate-a", { quote: "0.1" }), successOrder("estimate-b", { quote: "0.2" }),
  successOrder("unknown-currency-a", { quote: "0", currency: null }),
  successOrder("unknown-currency-b", { quote: "0.074", currency: null, providerId: "herosms" }),
  successOrder("actual-missing-currency", { cost: actual("2", null), quote: "9" }),
  successOrder("ceiling-only"),
]);
const estimatedUsd = estimates.byCurrency.find((row) => row.currency === "USD");
check(estimatedUsd.verifiedPurchaseAmount === "0.1" && estimatedUsd.estimatedVerifiedAmount === "0.3" && estimatedUsd.estimatedVerifiedOrderCount === 2,
  "known actual success cost and exact quote estimates stay separate without estimating orders with actual cost");
check(estimates.estimatedVerifiedCount === 4 && estimates.unknownVerifiedEstimateCurrencyCount === 2 && estimates.missingVerifiedEstimateCount === 1,
  "estimated success counts distinguish missing quote amounts from unknown estimate currencies");
check(estimates.estimatesByProviderCurrency.filter((row) => row.currency === null).length === 2
  && estimates.estimatesByProviderCurrency.find((row) => row.providerId === "smsbower" && row.currency === null).estimatedVerifiedAmount === "0"
  && estimates.estimatesByProviderCurrency.find((row) => row.providerId === "herosms" && row.currency === null).estimatedVerifiedAmount === "0.074",
"unknown-currency quote estimates retain zero and stay separate for each provider");
check(estimates.unknownVerifiedCurrencyCount === 1 && estimates.byCurrency.every((row) => row.estimatedVerifiedAmount !== "9"),
  "an actual amount lacking currency never falls back to its quote or price ceiling");
const categorySource = poolCostOrder({ categoryId: "us", categoryName: "美区购买快照", categoryFeeVersion: 2, providerId: "smsbower",
  order: { requestId: "category-snapshot", number: "+12025550123" }, config: { categoryId: "other", categoryName: "其他配置", categoryFeeVersion: 9 } });
check(categorySource.categoryId === "us" && categorySource.categoryName === "美区购买快照" && categorySource.categoryFeeVersion === 2,
  "purchase source category snapshot takes precedence over provider config");
check(poolCostOrder({ order: {}, config: { categoryId: "vip", categoryName: "专线", categoryFeeVersion: 3 } }).categoryFeeVersion === 3
  && descriptor().categoryId === "legacy" && descriptor().categoryName === "原接码池", "config snapshots are retained while uncategorized historical costs remain legacy");

process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64"); process.env.TOSUB2_ADMIN_CDK = "synthetic-pool-cost-admin-only";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-pool-costs-"));
const vault = await createCdkVault(root); let store = await createCdkStore(root, vault); let pool; let clock = Date.now(); let serial = 0;
const amounts = [actual("0.1", "USD"), actual("0.2", "USD"), actual("0", "USD"), undefined, actual("2", null), actual("1.25", "EUR")];
const provider = () => ({
  activationPolicy: { lifetimeSeconds: 1500, minCancelAgeSeconds: 120, source: "https://provider.example.invalid/policy" },
  getNumber: async () => { const cost = amounts[serial]; serial++; return { requestId: `cost-order-${serial}`, number: `+1202555${String(serial).padStart(4, "0")}`, cost,
    expiresAt: clock + 1500000, expiresAtSource: "provider_policy", cancelAllowedAt: clock + 120000 }; },
  inspect: async () => ({ state: "waiting", hasSms: false }), cancelStrict: async () => ({ cancelled: true, receipt: "ACCESS_CANCEL", refundStatus: "unconfirmed" }),
});
const create = () => createSmsPool({ store, createProvider: provider, now: () => clock });
try {
  pool = create(); const admin = store.adminId; const [owner] = store.generate({ count: 1, quota: 20, note: "Synthetic costs" }, admin); store.inventory(owner.id, ["cost@example.invalid"]);
  pool.saveRules({ enabled: true, fee: 2 }, admin); pool.saveCredential({ providerId: "herosms", name: "Synthetic costs", apiKey: "private-cost-provider-key" }, admin);
  pool.saveEntry({ credentialId: pool.adminSnapshot().credentials[0].id, country: "1", countryLabel: "Private country", maxPrice: "10", quotedPrice: "9", currency: "USD" }, admin);
  const user = pool.forOwner(owner.id); const input = () => ({ operationId: crypto.randomUUID(), jobId: crypto.randomUUID(), runId: crypto.randomUUID(), email: "cost@example.invalid" });
  const rotated = input(); user.begin(rotated); const allocations = [];
  for (let index = 0; index < 3; index++) { const allocation = await user.getNumber(rotated); allocations.push(allocation); if (index < 2) user.abandon({ ...rotated, allocationId: allocation.allocationId }); }
  const last = allocations.at(-1); user.noteSubmitted({ ...rotated, allocationId: last.allocationId });
  user.verified({ ...rotated, ...last, evidence: { version: 1, type: "phone_verification", state: "verified", ...rotated, allocationId: last.allocationId,
    providerId: last.providerId, orderId: last.order.requestId, eventId: crypto.randomUUID(), verifiedAt: new Date().toISOString() } });
  const row = pool.operationsPage().items.find((item) => item.operationId === rotated.operationId);
  check(row.costOrders.length === 3 && row.costOrders[0].cost.amount === "0.1" && row.costOrders[1].cost.amount === "0.2" && row.cost.amount === "0", "all rotated numbers retain distinct actual costs and latest zero cost is displayed");
  check(row.costOrders.every((order) => order.phone.startsWith("*") && order.quote.amount === "9" && order.maxPrice.amount === "10"), "administrator order cost rows have masked numbers plus separate quote and ceiling");
  let summary = pool.adminSnapshot().costSummary; const usd = summary.byCurrency.find((group) => group.currency === "USD");
  check(usd.confirmedPurchaseAmount === "0.3" && usd.confirmedOrderCount === 3 && usd.refundUnconfirmedAmount === "0.3" && usd.refundUnconfirmedCount === 2, "cost summary covers every purchased order and reports unconfirmed abandoned-order refunds without subtracting them");
  const unknown = input(); user.begin(unknown); await user.getNumber(unknown); user.release(unknown);
  const missingCurrency = input(); user.begin(missingCurrency); await user.getNumber(missingCurrency); user.release(missingCurrency);
  summary = pool.adminSnapshot().costSummary;
  check(summary.unknownCostCount === 1 && summary.unknownCurrencyCount === 1 && summary.orderCount === 5, "legacy no-cost responses and actual amount without currency stay explicitly unknown");
  const beforeAcquire = pool.adminSnapshot().costSummary.orderCount; const direct = input(); user.begin(direct); const allocation = await user.getNumber(direct);
  check(allocation.order.cost.amount === "1.25" && !allocation.inventoryId, "on-demand order retains its provider cost without using prefetched inventory");
  const repeated = await user.getNumber(direct);
  store.recordSmsCostOrder(allocation, { state: "assigned", createdAt: clock + 1000 });
  check(repeated.allocationId === allocation.allocationId && pool.adminSnapshot().costSummary.orderCount === beforeAcquire + 1,
    "repeated acquisition and lifecycle recording retain one provider order in costs and acquisition counts");
  user.abandon({ ...direct, allocationId: allocation.allocationId }); user.release(direct); clock += 121000; await pool.tick();
  summary = pool.adminSnapshot().costSummary;
  check(summary.byCurrency.find((group) => group.currency === "EUR").refundUnconfirmedAmount === "1.25", "strict cancellation still leaves monetary refund unconfirmed");
  const publicSummary = JSON.stringify(pool.publicSummary());
  check(!/cost|quote|maxPrice|country|provider|currency|USD|EUR/.test(publicSummary), "ordinary CDK pool summary never exposes administrator costs or countries");
  const serialized = JSON.stringify(pool.adminSnapshot());
  check(!serialized.includes("private-cost-provider-key") && !serialized.includes(last.order.number), "admin cost expansion still redacts provider keys and full phone numbers");
  await pool.close(); store.close(); store = await createCdkStore(root, vault); pool = create();
  check(pool.operationsPage().items.find((item) => item.operationId === rotated.operationId).costOrders.length === 3 && pool.adminSnapshot().costSummary.orderCount === 6, "all rotated order costs and deduplicated totals survive restart");

  // Model an old persisted operation with only its final allocation available.
  await pool.close(); store.close(); const db = new DatabaseSync(path.join(root, ".cdk", "cdk.sqlite"));
  const oldRow = db.prepare("SELECT * FROM sms_pool_operations WHERE cdk_id=? AND id=?").get(owner.id, rotated.operationId);
  const oldPayload = vault.open(oldRow.payload, `sms-pool:${owner.id}:${rotated.operationId}`); delete oldPayload.orderHistory;
  db.prepare("UPDATE sms_pool_operations SET payload=? WHERE cdk_id=? AND id=?").run(vault.seal(oldPayload, `sms-pool:${owner.id}:${rotated.operationId}`), owner.id, rotated.operationId);
  db.prepare("DELETE FROM meta WHERE key='sms-cost-orders-migrated'").run(); db.prepare("DELETE FROM sms_pool_cost_orders").run(); db.close();
  store = await createCdkStore(root, vault); pool = create();
  const restoredLegacy = pool.operationsPage().items.find((item) => item.operationId === rotated.operationId);
  check(restoredLegacy.costOrders.length === 3 && restoredLegacy.costOrders.filter((order) => order.cost === null).length === 2, "historically missing rotated order costs remain unknown rather than copied from final order or quote");
  check(restoredLegacy.cost?.amount === "0" && restoredLegacy.cost.source === "order", "unknown legacy history cannot override the final real allocation cost in operation row");
  check(pool.adminSnapshot().costSummary.unknownCostCount >= 3, "cost migration reports historical missing evidence explicitly");
  const unresolved = input(); pool.forOwner(owner.id).begin(unresolved);
  const attemptId = crypto.randomUUID();
  store.updateSmsOperation(owner.id, unresolved.operationId, (value) => ({ ...value, state: "unknown", attempts: [{ id: attemptId, state: "order_unknown", startedAt: clock }] }));
  const beforeResolution = pool.adminSnapshot().costSummary;
  store.updateSmsOperation(owner.id, unresolved.operationId, (value) => ({ ...value, allocation: { allocationId: attemptId, providerId: "herosms", credentialId: "synthetic", config: { apiKey: "private-cost-provider-key" },
    order: { requestId: "resolved-late-order", number: "+12025550999", cost: actual("0.4", "USD") } } }));
  const afterResolution = pool.adminSnapshot().costSummary;
  check(afterResolution.orderCount === beforeResolution.orderCount && afterResolution.unknownCostCount === beforeResolution.unknownCostCount - 1,
    "late exact order evidence replaces its unknown attempt without counting both unknown and actual purchase");
  console.log(`[ok] SMS pool costs: ${checks} assertions; exact actual/estimated currency totals, rotation history, order deduplication, zero/unknown costs, refund distinction, persistence and public privacy; local stubs only.`);
} finally { await pool?.close(); store.close(); await fs.rm(root, { recursive: true, force: true }); }
