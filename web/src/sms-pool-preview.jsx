import React, { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronRight, Globe2, KeyRound, LogIn, Settings2, ShieldCheck } from "lucide-react";
import "./styles.css";
import "./workspace.css";
import { ThemeControl } from "./WorkspaceUi.jsx";
import SmsPoolWorkspace, { SmsPoolChoice } from "./SmsPoolWorkspace.jsx";
import ImportChargeDialog from "./ImportChargeDialog.jsx";

// Isolated design fixtures. This entry has no connection to the CDK or SMS APIs.
const demoOrders = [
  { orderId: "preview-order-1", entryId: "preview-2", credentialId: "preview-hero", providerId: "herosms", providerName: "Hero SMS", country: "16", countryLabel: "英国", obtained: true, verified: false, phone: "*******6630", quote: { amount: "0.40", currency: "USD" }, maxPrice: { amount: "0.42", currency: "USD" }, cost: null, refundExpected: true, refundStatus: "unconfirmed", createdAt: Date.now() - 300000 },
  { orderId: "preview-order-2", entryId: "preview-1", credentialId: "preview-bower", providerId: "smsbower", providerName: "SMSBower", country: "6", countryLabel: "印度尼西亚", obtained: true, verified: true, phone: "*******0118", cost: { amount: "0.24", currency: "USD", source: "order" }, refundExpected: false, refundStatus: "unconfirmed", createdAt: Date.now() - 240000 },
];
const demoAssignedOrder = { orderId: "preview-order-3", entryId: "preview-4", credentialId: "preview-hero", country: "4", obtained: true, verified: false, providerId: "herosms", providerName: "Hero SMS", countryLabel: "菲律宾", phone: "*******2261", cost: { amount: "0.22", currency: "USD", source: "order" }, refundExpected: false, refundStatus: "unconfirmed", createdAt: Date.now() - 180000 };
const initial = {
  rules: { enabled: true, fee: 2, noStockThreshold: 3, cooldownMinutes: 10, maxAttempts: 10, maxConcurrent: 5, buffer: { enabled: true, target: 3, lowWater: 1, perEntry: 1, refillConcurrency: 1, minRemainingSeconds: 480, idleMinutes: 10, maxOutstanding: 10, maxPerMinute: 6 } },
  credentials: [{ id: "preview-bower", name: "SMSBower 主账户", providerId: "smsbower", enabled: true, hasApiKey: true }, { id: "preview-hero", name: "Hero 备用账户", providerId: "herosms", enabled: true, hasApiKey: true }],
  entries: [
    { id: "preview-1", credentialId: "preview-bower", providerId: "smsbower", credentialName: "SMSBower 主账户", country: "6", countryLabel: "印度尼西亚", maxPrice: "0.28", currency: "USD", priority: 10, enabled: true, state: "available", noStockCount: 0 },
    { id: "preview-2", credentialId: "preview-hero", providerId: "herosms", credentialName: "Hero 备用账户", country: "16", countryLabel: "英国", maxPrice: "0.42", currency: "USD", priority: 10, enabled: true, state: "available", noStockCount: 1 },
    { id: "preview-3", credentialId: "preview-bower", providerId: "smsbower", credentialName: "SMSBower 主账户", country: "36", countryLabel: "加拿大", maxPrice: "0.35", currency: "USD", priority: 20, enabled: true, state: "cooling", noStockCount: 3, cooldownUntil: Date.now() + 8 * 60000 },
    { id: "preview-4", credentialId: "preview-hero", providerId: "herosms", credentialName: "Hero 备用账户", country: "4", countryLabel: "菲律宾", maxPrice: "0.31", currency: "USD", priority: 20, enabled: true, state: "available", noStockCount: 0 },
    { id: "preview-5", credentialId: "preview-bower", providerId: "smsbower", credentialName: "SMSBower 主账户", country: "43", countryLabel: "德国", maxPrice: "0.61", currency: "USD", priority: 30, enabled: false, state: "disabled", noStockCount: 0 },
  ],
  buffer: { rules: { enabled: true }, activeDemandAt: Date.now() - 90000, refilling: false, counts: { ready: 2, purchasing: 0, checking: 0, assigned: 1, cancel_pending: 1, purchase_unknown: 1, quarantined: 0, closed: 0, consumed: 0 }, items: [
    { id: "preview-stock-1", entryId: "preview-1", providerId: "smsbower", country: "6", countryLabel: "印度尼西亚", state: "ready", phone: "+12025550101", cost: { amount: "0.28", currency: "USD", source: "order" }, createdAt: Date.now() - 60000, expiresAt: Date.now() + 20 * 60000, expiresSource: "provider_policy", cancelAllowedAt: Date.now() + 60000, refundStatus: "unconfirmed" },
    { id: "preview-stock-2", entryId: "preview-2", providerId: "herosms", country: "16", countryLabel: "英国", state: "ready", phone: "+12025550102", cost: { amount: "0", currency: "USD", source: "order" }, createdAt: Date.now() - 80000, expiresAt: Date.now() + 17 * 60000, expiresSource: "provider_policy", cancelAllowedAt: Date.now() + 40000, refundStatus: "unconfirmed" },
    { id: "preview-stock-3", entryId: "preview-4", state: "assigned", ...demoAssignedOrder, phone: "+12025550103", expiresAt: Date.now() + 16 * 60000, expiresSource: "provider" },
    { id: "preview-stock-4", entryId: "preview-1", providerId: "smsbower", country: "6", countryLabel: "印度尼西亚", state: "cancel_pending", phone: "+12025550104", cost: { amount: "0.28", currency: "USD", source: "order" }, refundExpected: true, createdAt: Date.now() - 700000, expiresAt: Date.now() + 4 * 60000, expiresSource: "provider_policy", nextActionAt: Date.now() + 30000, cancelState: "unknown", refundStatus: "unconfirmed" },
    { id: "preview-stock-5", entryId: "preview-2", providerId: "herosms", state: "purchase_unknown", phone: null, createdAt: Date.now() - 90000, expiresAt: null, cancelState: "unknown", refundStatus: "unconfirmed", lastError: "interrupted_purchase", canReconcile: true },
  ] },
  operations: [{ id: "preview-op-1", email: "sample-01@example.invalid", cdkLabel: "页面示例 CDK", status: "committed", fee: 2, attempts: 2, cost: demoOrders[1].cost, costOrders: demoOrders, createdAt: Date.now() - 300000 }, { id: "preview-op-2", email: "sample-02@example.invalid", cdkLabel: "页面示例 CDK", status: "reconciliation_required", fee: 2, attempts: 1, cost: demoAssignedOrder.cost, costOrders: [demoAssignedOrder], reason: "验证响应中断，等待核实", createdAt: Date.now() - 180000 }],
};
const quotes = [{ country: "6", title: "印度尼西亚", price: 0.28, count: 28, currency: "USD", providerIds: "1", grade: "gold" }, { country: "6", title: "印度尼西亚", price: 0.32, count: 45, currency: "USD", providerIds: "2", grade: "unknown" }, { country: "73", title: "巴西", price: 0.39, count: 16, currency: "USD", providerIds: "3", grade: "unknown" }, { country: "16", title: "英国", price: 0.42, count: 12, currency: "USD", providerIds: "4", grade: "gold" }, { country: "36", title: "加拿大", price: 0.35, count: 8, currency: "USD", providerIds: "5", grade: "unknown" }];
let snapshot = structuredClone(initial);
const demoUnits = (value) => { const [whole, fraction = ""] = String(value).split("."); return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, "0")); };
const demoAmount = (value) => { const fraction = String(value % 100000000n).padStart(8, "0").replace(/0+$/, ""); return `${value / 100000000n}${fraction ? `.${fraction}` : ""}`; };
function demoCostSummary(orders) {
  const byCurrency = new Map(); let unknownCostCount = 0; let unknownCurrencyCount = 0; let unknownVerifiedCostCount = 0; let unknownVerifiedCurrencyCount = 0;
  for (const row of orders) {
    if (!row.cost || row.cost.source !== "order") { unknownCostCount++; if (row.verified) unknownVerifiedCostCount++; continue; }
    if (!row.cost.currency) { unknownCurrencyCount++; if (row.verified) unknownVerifiedCurrencyCount++; continue; }
    const group = byCurrency.get(row.cost.currency) || { currency: row.cost.currency, total: 0n, verified: 0n, refunds: 0n, confirmedOrderCount: 0, verifiedOrderCount: 0, refundUnconfirmedCount: 0 };
    group.total += demoUnits(row.cost.amount); group.confirmedOrderCount++;
    if (row.verified) { group.verified += demoUnits(row.cost.amount); group.verifiedOrderCount++; }
    if (row.refundExpected && row.refundStatus !== "confirmed") { group.refunds += demoUnits(row.cost.amount); group.refundUnconfirmedCount++; }
    byCurrency.set(row.cost.currency, group);
  }
  return { orderCount: orders.length, obtainedCount: orders.filter((row) => row.obtained).length, verifiedCount: orders.filter((row) => row.verified).length,
    unknownCostCount, unknownCurrencyCount, unknownVerifiedCostCount, unknownVerifiedCurrencyCount,
    byCurrency: [...byCurrency.values()].map((group) => ({ currency: group.currency, confirmedPurchaseAmount: demoAmount(group.total), verifiedPurchaseAmount: demoAmount(group.verified), confirmedOrderCount: group.confirmedOrderCount, verifiedOrderCount: group.verifiedOrderCount, refundUnconfirmedAmount: demoAmount(group.refunds), refundUnconfirmedCount: group.refundUnconfirmedCount })) };
}
function demoOrdersSnapshot() {
  const records = [...snapshot.buffer.items.map((item) => ({ ...item, orderId: item.id === "preview-stock-3" ? demoAssignedOrder.orderId : item.orderId || item.id, obtained: Boolean(item.phone), verified: item.state === "consumed" })), ...snapshot.operations.flatMap((row) => row.costOrders || [])];
  const unique = new Map();
  for (const row of records) {
    const entry = snapshot.entries.find((entry) => entry.id === row.entryId);
    const merged = { ...row, entryId: row.entryId || "", providerId: row.providerId || entry?.providerId || "", credentialId: row.credentialId || entry?.credentialId || "", country: row.country || entry?.country || "", countryLabel: row.countryLabel || entry?.countryLabel || "", providerName: row.providerName || (row.providerId === "herosms" ? "Hero SMS" : "SMSBower") };
    merged.countryKey = `${merged.providerId}:${merged.country}`;
    const key = `${merged.providerId}:${merged.credentialId}:${merged.orderId}`; const previous = unique.get(key); unique.set(key, { ...previous, ...merged, verified: Boolean(previous?.verified || merged.verified) });
  }
  return [...unique.values()];
}
function demoMatches(row, query) {
  return (!query.providerId || row.providerId === query.providerId) && (!query.credentialId || row.credentialId === query.credentialId) && (!query.country || row.countryKey === query.country) && (!query.entryId || row.entryId === query.entryId)
    && (!query.currency || row.cost?.currency === query.currency) && (!query.start || new Date(row.createdAt).getTime() >= Date.parse(query.start)) && (!query.end || new Date(row.createdAt).getTime() < Date.parse(query.end))
    && (!query.result || query.result === "all" || query.result === "obtained" && row.obtained || query.result === "verified" && row.verified || query.result === "unverified" && !row.verified)
    && (!query.costStatus || query.costStatus === "all" || query.costStatus === "known" && row.cost?.currency || query.costStatus === "unknown" && !row.cost?.currency);
}
function demoAnalytics(query = {}) {
  const all = demoOrdersSnapshot(); const filtered = all.filter((row) => demoMatches(row, query));
  const groups = (key) => [...new Set(filtered.map((row) => row[key]))].map((value) => { const records = filtered.filter((row) => row[key] === value); const first = records[0]; return { [key]: value, entryId: first.entryId, providerId: first.providerId, providerName: first.providerName, country: first.country, countryKey: first.countryKey, countryLabel: first.countryLabel, ...demoCostSummary(records) }; });
  const filterOptions = { countries: [...new Map(all.filter((row) => row.country).map((row) => [row.countryKey, { countryKey: row.countryKey, key: row.countryKey, value: row.countryKey, country: row.country, providerId: row.providerId, countryLabel: row.countryLabel, label: `${row.countryLabel} / ${row.providerName}` }])).values()],
    providers: [{ providerId: "smsbower", id: "smsbower", name: "SMSBower" }, { providerId: "herosms", id: "herosms", name: "Hero SMS" }], credentials: snapshot.credentials.map((row) => ({ ...row, credentialId: row.id })), currencies: [...new Set(all.map((row) => row.cost?.currency).filter(Boolean))] };
  return { summary: demoCostSummary(filtered), byEntry: groups("entryId"), byProvider: groups("providerId"), byCountry: groups("countryKey"), filterOptions, timeBasis: "purchasedAt" };
}
function demoSnapshot() {
  const value = structuredClone(snapshot); const orders = demoOrdersSnapshot(); value.costSummary = demoCostSummary(orders);
  value.buffer.rules = { ...value.rules.buffer };
  value.buffer.counts = { ready: 0, purchasing: 0, checking: 0, assigned: 0, cancel_pending: 0, purchase_unknown: 0, quarantined: 0, closed: 0, consumed: 0 };
  for (const row of value.buffer.items) value.buffer.counts[row.state] = (value.buffer.counts[row.state] || 0) + 1;
  value.buffer.progress = { state: value.buffer.paused ? "paused" : value.buffer.counts.ready >= value.rules.buffer.target ? "full" : value.buffer.refilling ? "filling" : "idle", target: value.rules.buffer.target,
    ready: value.buffer.counts.ready, purchasing: value.buffer.counts.purchasing, checking: value.buffer.counts.checking,
    remaining: Math.max(0, value.rules.buffer.target - value.buffer.counts.ready - value.buffer.counts.purchasing), nextRetryAt: null, reason: "", attempts: 0, obtained: value.buffer.counts.ready,
    failures: [{ entryId: "preview-3", providerId: "smsbower", countryLabel: "加拿大", kind: "no_stock", count: 3, lastAt: Date.now() - 30000 }] };
  value.entries = value.entries.map((row) => ({ ...row, stats: demoCostSummary(orders.filter((item) => item.entryId === row.id)) }));
  value.credentials = value.credentials.map((row) => ({ ...row, stats: demoCostSummary(orders.filter((item) => item.credentialId === row.id)) }));
  return value;
}
async function previewApi(path = "", method = "GET", body) {
  if (!path) return demoSnapshot();
  if (path.startsWith("/inventory?")) {
    const query = Object.fromEntries(new URLSearchParams(path.split("?")[1]));
    const rows = demoSnapshot().buffer.items.filter((row) => Boolean(row.phone) && (query.scope === "all" || (query.scope === "history" ? ["closed", "consumed"].includes(row.state) : !["closed", "consumed"].includes(row.state)))
      && (!query.state || row.state === query.state) && (!query.providerId || row.providerId === query.providerId) && (!query.country || `${row.providerId}:${row.country}` === query.country)
      && (!query.search || `${row.phone || ""} ${row.countryLabel || ""}`.includes(query.search)) && (!query.refundStatus || row.refundStatus === query.refundStatus)
      && (!query.costStatus || query.costStatus === "all" || (row.cost?.source === "order" && row.cost.currency ? "known" : "unknown") === query.costStatus));
    const page = Number(query.page || 1); const pageSize = Number(query.pageSize || 20);
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, pages: Math.max(1, Math.ceil(rows.length / pageSize)) };
  }
  if (path.startsWith("/analytics")) return demoAnalytics(Object.fromEntries(new URLSearchParams(path.split("?")[1] || "")));
  if (path.startsWith("/operations?")) {
    const query = Object.fromEntries(new URLSearchParams(path.split("?")[1]));
    const records = snapshot.operations.filter((row) => (!query.state || query.state === "all" || (row.status === "committed" ? "verified" : row.status === "reconciliation_required" ? "unknown" : row.status) === query.state)
      && (!query.search || [row.email, row.cdkLabel, row.id, ...(row.costOrders || []).map((item) => item.phone)].join(" ").toLowerCase().includes(query.search.toLowerCase()))
      && (!query.start || row.createdAt >= Date.parse(query.start)) && (!query.end || row.createdAt < Date.parse(query.end))
      && (row.costOrders || []).some((item) => demoMatches({ ...item, countryKey: `${item.providerId}:${item.country || snapshot.entries.find((entry) => entry.id === item.entryId)?.country || ""}` }, { ...query, start: "", end: "" })));
    const page = Number(query.page || 1); const pageSize = Number(query.pageSize || 20);
    return { items: records.slice((page - 1) * pageSize, page * pageSize), total: records.length, page, pageSize, pages: Math.max(1, Math.ceil(records.length / pageSize)) };
  }
  if (path.endsWith("/options")) return { options: quotes };
  if (path === "/rules") { snapshot.rules = { ...snapshot.rules, ...body, buffer: { ...snapshot.rules.buffer, ...body.buffer } }; snapshot.buffer.rules = { ...snapshot.rules.buffer }; }
  else if (path === "/buffer/warmup") {
    snapshot.buffer.activeDemandAt = Date.now(); snapshot.buffer.refilling = false; snapshot.buffer.paused = false;
    const available = snapshot.buffer.items.filter((row) => row.state === "ready").length;
    for (let index = available; index < snapshot.rules.buffer.target; index++) {
      const entry = snapshot.entries.filter((row) => row.enabled && row.state === "available")[index % 3]; if (!entry) break;
      snapshot.buffer.items.unshift({ id: `preview-added-${snapshot.buffer.items.length}`, entryId: entry.id, providerId: entry.providerId, country: entry.country, countryLabel: entry.countryLabel,
        phone: `+1202555${String(110 + snapshot.buffer.items.length).padStart(4, "0")}`, state: "ready", quote: { amount: entry.maxPrice, currency: entry.currency }, createdAt: Date.now(), expiresAt: Date.now() + 20 * 60000, expiresSource: "provider_policy", refundStatus: "unconfirmed" });
    }
  }
  else if (path === "/buffer/pause") { snapshot.rules.buffer.forceRefill = false; snapshot.buffer.rules.forceRefill = false; snapshot.buffer.refilling = false; snapshot.buffer.paused = true; }
  else if (path === "/buffer/drain") { snapshot.rules.buffer.forceRefill = false; snapshot.buffer.rules.forceRefill = false; snapshot.buffer.activeDemandAt = null; snapshot.buffer.refilling = false; for (const row of snapshot.buffer.items) if (row.state === "ready") { row.state = "cancel_pending"; row.cancelState = "pending"; } snapshot.buffer.counts.cancel_pending += snapshot.buffer.counts.ready; snapshot.buffer.counts.ready = 0; }
  else if (path.startsWith("/inventory/") && path.endsWith("/reconcile")) { const row = snapshot.buffer.items.find((item) => item.id === path.split("/")[2]); if (row) { row.state = "closed"; row.canReconcile = false; row.refundStatus = body.refundEvidence ? "confirmed" : "unconfirmed"; } }
  else if (path === "/credentials") { const row = { ...body, id: body.id || `preview-cred-${Date.now()}`, hasApiKey: true }; delete row.apiKey; snapshot.credentials = [...snapshot.credentials.filter((item) => item.id !== row.id), row]; }
  else if (path === "/entries") { for (const item of body.entries) { const credential = snapshot.credentials.find((row) => row.id === item.credentialId); snapshot.entries.push({ ...item, id: `preview-${Date.now()}-${snapshot.entries.length}`, providerId: credential.providerId, credentialName: credential.name, state: "available", noStockCount: 0 }); } }
  else if (path.startsWith("/entries/")) { const row = snapshot.entries.find((item) => item.id === path.split("/")[2]); Object.assign(row, body); row.state = row.enabled ? "available" : "disabled"; if (body.resetCooldown) row.noStockCount = 0; }
  else if (path.endsWith("/reconcile")) { const row = snapshot.operations.find((item) => item.id === path.split("/")[2]); row.status = body.action === "verified" ? "committed" : "released"; }
  return demoSnapshot();
}
function Preview() {
  const [view, setView] = useState("admin"); const [version, setVersion] = useState(0);
  const [chargePreview, setChargePreview] = useState(false);
  const api = useCallback((...args) => previewApi(...args), []);
  const summary = { ...snapshot.rules, available: true, status: snapshot.buffer.counts.ready ? "ready" : snapshot.buffer.refilling ? "fetching" : "available_on_demand", hasNumbers: snapshot.buffer.counts.ready > 0, refilling: snapshot.buffer.refilling };
  return <><div className="sp-preview-banner"><span>页面设计预览：国家、价格和记录均为演示数据，操作不会取号或扣次。</span><button onClick={() => setView(view === "admin" ? "user" : "admin")}>{view === "admin" ? "查看普通 CDK 配置" : "查看管理员页面"}</button><button onClick={() => setChargePreview(true)}>预览导入费用确认</button><button onClick={() => { snapshot = structuredClone(initial); setVersion((value) => value + 1); }}>重置演示</button></div><div className="app-shell"><aside className="app-sidebar"><div className="brand-block"><div className="brand-mark"><ShieldCheck size={19} /></div><h1>toSub2</h1></div><nav className="workspace-tabs" aria-label="预览工作区"><button onClick={() => setView("user")}><LogIn size={17} />账号授权</button><button className={view === "admin" ? "active" : ""} onClick={() => setView("admin")}><Globe2 size={17} />接码池</button><button onClick={() => setView("user")}><KeyRound size={17} />我的 CDK</button></nav><div className="sidebar-footer"><span>页面设计预览</span><p>管理员配置，普通 CDK 使用</p></div></aside><main className="workspace-content"><header className="topbar"><div className="workspace-path"><span>工作区</span><ChevronRight size={14} /><strong>{view === "admin" ? "接码池" : "接码平台配置"}</strong></div><div className="topbar-actions"><ThemeControl /></div></header>{view === "admin" ? <SmsPoolWorkspace key={version} api={api} /> : <section className="sp-preview-choice"><div className="sp-heading"><h2>接码平台配置</h2><Settings2 size={19} /></div><div className="provider-tabs"><button>自有接码平台</button><button className="active">接码池</button></div><SmsPoolChoice summary={summary} onManage={() => setView("admin")} /></section>}</main></div>{chargePreview && <ImportChargeDialog quote={{ count: 1, added: 1, updated: 0, charge: 1, balance: 30, after: 29, smsPool: { count: 1, fee: 10, maximum: 10, admin: false } }} onClose={() => setChargePreview(false)} />}</>;
}
createRoot(document.getElementById("root")).render(<Preview />);
