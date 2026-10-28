import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { poolCostOrder, summarizePoolCosts, poolCostFilters, poolCostAnalytics, matchesCurrentEntry } from "../src/sms-pool-costs.mjs";
import { createCdkVault } from "../src/cdk-vault.mjs";
import { createCdkStore } from "../src/cdk-store.mjs";
import { createSmsPool } from "../src/sms-pool.mjs";

let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const cost = (amount, currency = "USD") => ({ amount, currency, source: "order" });
const at = Date.UTC(2026, 9, 20);
const descriptor = (id, options = {}) => poolCostOrder({ entryId: "entry-a", credentialId: "credential-a", providerId: "herosms",
  order: { requestId: id, number: "+12025550123", cost: cost("0.1") }, config: { country: "1", countryLabel: "Original country", maxPrice: "5", currency: "USD" }, ...options },
  { state: options.state || "allocated", createdAt: options.createdAt ?? at, verifiedAt: options.verifiedAt || null });
const orders = [descriptor("a", { state: "verified" }), descriptor("b", { state: "verified", order: { requestId: "b", number: "+12025550124", cost: cost("0.2") }, config: { country: "1", countryLabel: "Renamed country", maxPrice: "5", currency: "USD" } }),
  descriptor("c", { state: "verified", order: { requestId: "c", number: "+12025550125", cost: cost("0") } }),
  descriptor("d", { state: "verified", order: { requestId: "d", number: "+12025550126" } }),
  descriptor("e", { state: "verified", order: { requestId: "e", number: "+12025550127", cost: cost("2", null) } }),
  descriptor("f", { providerId: "smsbower", order: { requestId: "f", number: "+12025550128", cost: cost("1.25", "EUR") } }),
  descriptor("g", { createdAt: at + 1000, order: { requestId: "g", number: "+12025550129", cost: cost("3") } })];
const summary = summarizePoolCosts(orders);
check(summary.byCurrency.find((row) => row.currency === "USD").verifiedPurchaseAmount === "0.3", "successful amounts use exact decimals and retain zero-cost success");
check(summary.verifiedCount === 5 && summary.obtainedCount === 7 && summary.unknownVerifiedCostCount === 1 && summary.unknownVerifiedCurrencyCount === 1,
  "successful counts remain independent from unknown amount and currency");
const grouped = poolCostAnalytics(orders);
check(grouped.byCountry.length === 2 && grouped.byCountry.find((row) => row.providerId === "herosms").orderCount === 6,
  "country labels may change without splitting stable country groups; equal country codes across providers stay separate");
check(poolCostAnalytics([{ ...orders[0], providerName: "Old name" }, { ...orders[1], providerName: "New name" }]).byProvider.length === 1,
  "provider display names do not split a provider group");
check(grouped.byEntry[0].mixedRoutes && grouped.byEntry[0].routeCount === 2, "reused entry IDs explicitly identify multiple original routes");
check(poolCostAnalytics(orders, poolCostFilters({ start: new Date(at).toISOString(), end: new Date(at + 1000).toISOString() })).summary.orderCount === 6,
  "purchase-time range includes start and excludes end");
check(poolCostAnalytics(orders, poolCostFilters({ providerId: "smsbower", country: "smsbower:1", currency: "EUR", result: "obtained", costStatus: "known" })).summary.orderCount === 1,
  "provider, country, currency, result and known-cost filters compose");
check(poolCostAnalytics(orders, poolCostFilters({ costStatus: "unknown_currency" })).summary.orderCount === 1, "unknown currency is separately filterable");
const shanghaiStart = Date.parse("2026-10-27T16:00:00.000Z");
const dailyOrders = [
  descriptor("cross-midnight", { state: "verified", createdAt: shanghaiStart - 1, verifiedAt: new Date(shanghaiStart).toISOString(),
    order: { requestId: "cross-midnight", number: "+12025550130", cost: cost("0.2") } }),
  descriptor("estimated-today", { state: "verified", providerId: "smsbower", createdAt: shanghaiStart + 1000, verifiedAt: new Date(shanghaiStart + 2000).toISOString(),
    order: { requestId: "estimated-today", number: "+12025550131" }, config: { country: "1", quotedPrice: "0.074", maxPrice: "9", currency: null } }),
  descriptor("undated-success", { state: "verified", createdAt: shanghaiStart + 3000 }),
  descriptor("no-number", { createdAt: shanghaiStart + 4000, order: {} }),
  descriptor("next-day", { state: "verified", createdAt: shanghaiStart + 86400000, verifiedAt: new Date(shanghaiStart + 86400000).toISOString() }),
];
const dailyNow = shanghaiStart + 36000000;
const daily = poolCostAnalytics(dailyOrders, {}, { now: dailyNow });
check(daily.timeZone === "Asia/Shanghai" && daily.timeBasis === "events" && daily.byDay.length === 30
  && daily.byDay[0].date === "2026-10-28" && daily.byDay.at(-1).date === "2026-09-29", "default daily series uses the latest 30 Shanghai dates and includes zero days");
check(daily.today.obtainedCount === 2 && daily.today.verifiedCount === 2 && daily.today.byCurrency[0].verifiedPurchaseAmount === "0.2"
  && daily.byDay.find((row) => row.date === "2026-10-27").obtainedCount === 1 && daily.byDay.find((row) => row.date === "2026-10-27").verifiedCount === 0,
"a Shanghai-midnight success belongs to its verification day while its number belongs to the preceding purchase day");
check(daily.summary.verifiedCount === 4 && daily.summary.missingVerifiedAtCount === 1 && daily.dailySummary.verifiedCount === 2
  && daily.today.estimatesByProviderCurrency[0].estimatedVerifiedAmount === "0.074",
"legacy success without a verification timestamp remains in lifetime totals without inventing a daily success date");
const exactDay = poolCostAnalytics(dailyOrders, poolCostFilters({ start: new Date(shanghaiStart).toISOString(), end: new Date(shanghaiStart + 86400000).toISOString() }), { now: dailyNow });
check(exactDay.byDay.length === 1 && exactDay.byDay[0].date === "2026-10-28" && exactDay.summary.obtainedCount === 2 && exactDay.summary.verifiedCount === 2
  && exactDay.summary.byCurrency.find((row) => row.currency === "USD").confirmedPurchaseAmount === "0.1"
  && exactDay.summary.byCurrency.find((row) => row.currency === "USD").verifiedPurchaseAmount === "0.2",
"date filters select purchase and success events independently, include midnight start, exclude next midnight, and never count no-number attempts as acquired");
const earlierRange = poolCostAnalytics(dailyOrders, poolCostFilters({ start: "2026-10-25T16:00:00.000Z", end: "2026-10-26T16:00:00.000Z" }), { now: dailyNow });
check(earlierRange.byDay.length === 1 && earlierRange.byDay[0].date === "2026-10-26" && earlierRange.dailySummary.obtainedCount === 0
  && earlierRange.today.obtainedCount === 2 && earlierRange.today.verifiedCount === 2, "explicit empty ranges are zero-filled while today ignores date filters");
const platformToday = poolCostAnalytics(dailyOrders, poolCostFilters({ providerId: "smsbower", start: "2026-10-25T16:00:00.000Z", end: "2026-10-26T16:00:00.000Z" }), { now: dailyNow });
check(platformToday.today.obtainedCount === 1 && platformToday.today.verifiedCount === 1, "today preserves provider filters even when selected report dates exclude today");
const tenYearStart = Date.parse("2016-10-20T16:00:00.000Z");
const longestDaily = poolCostAnalytics([], { start: tenYearStart, end: tenYearStart + 3660 * 86400000 }, { now: dailyNow });
check(longestDaily.byDay.length === 3660 && longestDaily.dailySummary.orderCount === 0, "daily reports permit at most 3660 zero-filled days");
assert.throws(() => poolCostAnalytics([], { start: tenYearStart, end: tenYearStart + 3661 * 86400000 }, { now: dailyNow }),
  (error) => error.status === 422 && /3660/.test(error.message) && /日期范围/.test(error.message)); checks++;
assert.throws(() => poolCostAnalytics([], poolCostFilters({ start: "0001-01-01T00:00:00Z", end: "9999-01-01T00:00:00Z" })),
  (error) => error.status === 422); checks++;
const categorizedOrders = [
  { ...dailyOrders[0], categoryId: "us", categoryName: "美区旧称", categoryFeeVersion: 1 },
  { ...dailyOrders[1], categoryId: "other", categoryName: "其他", categoryFeeVersion: 2 },
  { ...dailyOrders[2], categoryId: "archived", categoryName: "历史专线", categoryFeeVersion: 1 },
  { ...dailyOrders[3] },
];
const categories = [{ id: "us", name: "美国专用", fee: 4, feeVersion: 3, enabled: true, archivedAt: null },
  { id: "other", name: "其他地区", fee: 2, feeVersion: 2, enabled: true, archivedAt: null },
  { id: "archived", name: "已归档专线", fee: 5, feeVersion: 2, enabled: false, archivedAt: dailyNow }];
const categoryReport = poolCostAnalytics(categorizedOrders, {}, { categories, now: dailyNow });
check(categoryReport.byCategory.find((row) => row.categoryId === "us").categoryName === "美区旧称"
  && categoryReport.filterOptions.categories.find((row) => row.id === "us").name === "美国专用"
  && categoryReport.filterOptions.categories.find((row) => row.id === "us").historicalNames.includes("美区旧称"),
"renaming a category changes selection labels while purchase category snapshots retain their original name");
check(categoryReport.byCategory.some((row) => row.categoryId === "legacy" && row.categoryName === "原接码池")
  && categoryReport.filterOptions.categories.find((row) => row.id === "archived").archivedAt === dailyNow,
"uncategorized history stays in a legacy group and archived categories remain selectable in reports");
const usDaily = poolCostAnalytics(categorizedOrders, poolCostFilters({ categoryId: "us", start: new Date(shanghaiStart).toISOString(), end: new Date(shanghaiStart + 86400000).toISOString() }), { categories, now: dailyNow });
check(usDaily.today.obtainedCount === 0 && usDaily.today.verifiedCount === 1 && usDaily.dailySummary.byCurrency[0].verifiedPurchaseAmount === "0.2"
  && usDaily.byDay[0].estimatedVerifiedCount === 0 && usDaily.byCategory.length === 1, "daily category filtering keeps cross-midnight success actuals separate from another category's estimates");
const matchingCategoryOrder = { ...orders[0], categoryId: "us", route: { service: "dr", providerIds: "", maxPrice: "5", currency: "USD" } };
const matchingCategoryEntry = { id: "entry-a", credentialId: "credential-a", categoryId: "us", country: "1", service: "dr", providerIds: "", maxPrice: "5", currency: "USD" };
check(matchesCurrentEntry(matchingCategoryOrder, matchingCategoryEntry, { providerId: "herosms" })
  && !matchesCurrentEntry(matchingCategoryOrder, { ...matchingCategoryEntry, categoryId: "other" }, { providerId: "herosms" })
  && !matchesCurrentEntry({ ...matchingCategoryOrder, categoryId: undefined }, { ...matchingCategoryEntry, categoryId: "other" }, { providerId: "herosms" }),
"moving an entry between categories cannot pull earlier or uncategorized costs into its current stats");
for (const query of [{ result: "success" }, { costStatus: "estimated" }, { start: "invalid" }, { start: new Date(at).toISOString(), end: new Date(at).toISOString() }, { providerId: "a".repeat(201) }]) {
  assert.throws(() => poolCostFilters(query), (error) => error.status === 422); checks++;
}
const scaled = Array.from({ length: 20000 }, (_, index) => ({ ...orders[index % orders.length], entryId: `entry-${index % 1000}` }));
const started = performance.now(); const scaledReport = poolCostAnalytics(scaled); const scalingMs = Math.round(performance.now() - started);
check(scaledReport.summary.orderCount === 20000 && scaledReport.byEntry.length === 1000, "full-history report covers 20,000 orders and 1,000 entries");

process.env.TOSUB2_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64"); process.env.TOSUB2_ADMIN_CDK = "synthetic-pool-analytics-admin";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-pool-analytics-"));
const vault = await createCdkVault(root); let store = await createCdkStore(root, vault); let pool; let serial = 0;
try {
  pool = createSmsPool({ store }); const admin = store.adminId;
  const [owner] = store.generate({ count: 1, quota: 10000, note: "Synthetic analytics" }, admin); store.inventory(owner.id, ["analytics@example.invalid"]);
  pool.saveRules({ enabled: true, fee: 1 }, admin);
  pool.saveCredential({ providerId: "herosms", name: "Synthetic analytics", apiKey: "private-analytics-api-key" }, admin);
  const credential = pool.adminSnapshot().credentials[0];
  pool.saveEntry({ credentialId: credential.id, country: "1", countryLabel: "Original country", maxPrice: "5", quotedPrice: "4", currency: "USD" }, admin);
  const entry = pool.adminSnapshot().entries[0];
  const config = (country = "1") => ({ apiKey: "private-analytics-api-key", country, countryLabel: country === "1" ? "Original country" : "New country", service: "dr", providerIds: "", maxPrice: "5", quotedPrice: "4", currency: "USD" });
  const begin = () => {
    const input = { operationId: crypto.randomUUID(), jobId: crypto.randomUUID(), runId: crypto.randomUUID(), email: "analytics@example.invalid", fee: 1, maxConcurrent: 5, maxAttempts: 10 };
    store.prepareSmsOperation(owner.id, input); return input;
  };
  const allocate = (input, country = "1", amount = "0.1", providerId = "herosms", requestId = null, category = { categoryId: "other", categoryName: "其他", categoryFeeVersion: 1 }) => {
    const allocationId = crypto.randomUUID(); serial++;
    const allocation = { allocationId, ...category, entryId: entry.id, credentialId: credential.id, providerId, config: { ...config(country), ...category }, abandoned: false, submitted: false,
      order: { requestId: requestId || `analytics-order-${serial}`, number: `+1202555${String(serial).padStart(4, "0")}`, ...(amount === null ? {} : { cost: cost(amount) }) } };
    const { apiKey, ...attemptConfig } = allocation.config;
    store.updateSmsOperation(owner.id, input.operationId, (value) => { value.state = "requesting"; value.attempts.push({ id: allocationId, entryId: entry.id, credentialId: credential.id,
      providerId, config: attemptConfig, startedAt: at + serial, state: "requesting" }); return value; });
    const result = store.allocateSmsOrder(owner.id, input.operationId, allocation, at + serial); assert.ok(result.allocation); return result.allocation;
  };
  const abandon = (input) => store.updateSmsOperation(owner.id, input.operationId, (value) => { value.allocation.abandoned = true; value.state = "reserved"; return value; });
  const rotated = begin(); const first = allocate(rotated, "1", "0.1", "herosms", "original-rotated-order"); abandon(rotated); const final = allocate(rotated, "1", "0.2");
  store.settleSmsOperation(owner.id, rotated.operationId, { success: true, evidence: { verifiedAt: new Date(at + 5000).toISOString() } });
  let report = pool.analytics();
  check(report.summary.orderCount === 2 && report.summary.obtainedCount === 2 && report.summary.verifiedCount === 1 && report.summary.byCurrency[0].verifiedPurchaseAmount === "0.2",
    "rotation counts every acquired order but only the final allocation as verified");
  const afterSuccess = store.get(owner.id);
  check(afterSuccess.consumed === 1 && afterSuccess.reserved === 0, "cost reporting does not add or alter CDK settlement charges");
  pool.patchEntry(entry.id, { country: "2", countryLabel: "New country" }, admin);
  check(pool.adminSnapshot().entries[0].stats.orderCount === 0 && pool.analytics().byCountry[0].country === "1", "editing entry routing does not attribute old-country spend to current country");
  const next = begin(); allocate(next, "2", "0.3"); store.settleSmsOperation(owner.id, next.operationId);
  const snapshot = pool.adminSnapshot();
  check(snapshot.entries[0].stats.orderCount === 1 && snapshot.entries[0].stats.byCurrency[0].confirmedPurchaseAmount === "0.3" && snapshot.credentials[0].stats.orderCount === 3,
    "current-route entry and credential rows expose lifetime amounts and acquisition counts");
  check(pool.analytics().byEntry[0].mixedRoutes && pool.analytics().byCountry.length === 2, "analytics preserve history across entry route edits");
  const sameNumberId = begin(); allocate(sameNumberId, "2", "0.4", "herosms", "shared-id"); abandon(sameNumberId);
  allocate(sameNumberId, "2", "0.5", "smsbower", "shared-id"); store.settleSmsOperation(owner.id, sameNumberId.operationId, { success: true });
  check(pool.operationsPage({ search: sameNumberId.operationId }).items[0].cost.amount === "0.5", "latest operation cost matches provider and credential when providers reuse order IDs");
  for (let index = 0; index < 215; index++) {
    const input = begin(); allocate(input, "2", "0"); store.settleSmsOperation(owner.id, input.operationId);
  }
  const early = pool.operationsPage({ country: "herosms:1", pageSize: 1, page: 2 });
  check(early.total === 1 && early.page === 1 && early.items[0].operationId === rotated.operationId, "country filtering occurs before pagination across more than 200 operations");
  check(pool.operationsPage({ country: "herosms:2", pageSize: 25, page: 2 }).items.length === 25, "combined advanced filters retain normal paging");
  check(pool.operationsPage({ search: first.order.requestId }).total === 1 && pool.operationsPage({ state: "verified", search: "analytics@example.invalid" }).total === 2,
    "search covers rotated order IDs and combines with operation state");
  check(pool.operationsPage({ start: new Date(Date.now() - 60000).toISOString(), end: new Date(Date.now() + 60000).toISOString() }).total === 218
    && pool.analytics({ start: new Date(at).toISOString(), end: new Date(at + 60000).toISOString() }).summary.orderCount === 220,
  "records use operation creation time while cost reports use original purchase time");
  const duplicateBefore = pool.analytics().summary.orderCount;
  store.recordSmsCostOrder(final, { state: "assigned", createdAt: at + 99000 });
  check(pool.analytics().summary.orderCount === duplicateBefore && pool.analytics().summary.verifiedCount === 2,
    "recording a known provider order again retains its single identity and sticky success evidence");
  const serialized = JSON.stringify({ snapshot: pool.adminSnapshot(), report: pool.analytics(), operations: pool.operationsPage() });
  check(!serialized.includes("private-analytics-api-key") && !serialized.includes(final.order.number), "all administrator report surfaces omit API secrets and full phone numbers");
  check(!/cost|country|provider|currency|stats/i.test(JSON.stringify(pool.publicSummary())), "ordinary CDK summary exposes no administrator costs or geography");

  await pool.close(); store.close();
  const db = new DatabaseSync(path.join(root, ".cdk", "cdk.sqlite"));
  const row = db.prepare("SELECT * FROM sms_pool_operations WHERE cdk_id=? AND id=?").get(owner.id, rotated.operationId);
  const legacy = vault.open(row.payload, `sms-pool:${owner.id}:${rotated.operationId}`); legacy.orderHistory = [legacy.allocation];
  db.prepare("UPDATE sms_pool_operations SET payload=? WHERE cdk_id=? AND id=?").run(vault.seal(legacy, `sms-pool:${owner.id}:${rotated.operationId}`), owner.id, rotated.operationId);
  for (const record of db.prepare("SELECT * FROM sms_pool_cost_orders").all()) {
    const data = vault.open(record.payload, `sms-cost:${record.identity}`);
    if (data.orderId === first.order.requestId) { db.prepare("DELETE FROM sms_pool_cost_orders WHERE identity=?").run(record.identity); continue; }
    for (const field of ["entryId", "credentialId", "country", "countryKey", "route", "obtained", "verified", "verifiedAt"]) delete data[field];
    db.prepare("UPDATE sms_pool_cost_orders SET payload=? WHERE identity=?").run(vault.seal(data, `sms-cost:${record.identity}`), record.identity);
  }
  const missingIdentity = `legacy-missing:${owner.id}:${rotated.operationId}:${first.allocationId}`;
  const missing = { orderId: first.order.requestId, cost: null, createdAt: at + 1, state: "legacy_missing" };
  db.prepare("INSERT INTO sms_pool_cost_orders VALUES(?,?,?)").run(missingIdentity, vault.seal(missing, `sms-cost:${missingIdentity}`), at + 1);
  db.prepare("DELETE FROM meta WHERE key='sms-cost-orders-analytics-v2'").run(); db.close();
  store = await createCdkStore(root, vault); pool = createSmsPool({ store }); report = pool.analytics();
  check(report.summary.orderCount === 220 && report.summary.obtainedCount === 220 && report.summary.verifiedCount === 2, "v2 migration enriches existing cost records and counts legacy allocated evidence without duplication");
  check(report.summary.unknownCostCount === 1 && report.byCountry.find((group) => group.countryKey === "herosms:1").obtainedCount === 2,
    "legacy missing-order cost stays unknown while original attempt snapshots recover country and acquired count");
  check(store.get(owner.id).consumed === afterSuccess.consumed + 1 && store.get(owner.id).reserved === 0,
    "analytics migrations never modify balances, reservations or charged success count");
  check(pool.operationsPage().filterOptions.countries.some((country) => country.countryKey === "herosms:1"), "record filter options retain historical countries absent from current routes");
  const beforeCategoryReplay = pool.analytics().summary.orderCount;
  store.recordSmsCostOrder({ ...final, categoryId: "us", categoryName: "美区", categoryFeeVersion: 99,
    config: { ...final.config, categoryId: "us", categoryName: "美区", categoryFeeVersion: 99 } }, { state: "verified", verified: true, verifiedAt: new Date(at + 999000).toISOString() });
  const replayedCost = store.smsCostOrders().find((order) => order.orderId === final.order.requestId);
  check(pool.analytics().summary.orderCount === beforeCategoryReplay && replayedCost.categoryId === "other" && replayedCost.categoryName === "其他" && replayedCost.categoryFeeVersion === 1,
    "a repeated provider order under a different category retains its original category and single cost identity");
  console.log(`[ok] SMS pool analytics: ${checks} assertions; full-history filters, exact success costs, stable groups, route attribution, legacy migration and admin privacy; 20,000 orders/1,000 entries ${scalingMs} ms; local fixtures only.`);
} finally { await pool?.close(); store.close(); await fs.rm(root, { recursive: true, force: true }); }
