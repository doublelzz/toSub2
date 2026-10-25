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
  { orderId: "preview-order-1", providerId: "herosms", providerName: "Hero SMS", countryLabel: "英国", phone: "*******6630", quote: { amount: "0.40", currency: "USD" }, maxPrice: { amount: "0.42", currency: "USD" }, cost: null, refundExpected: true, refundStatus: "unconfirmed", createdAt: Date.now() - 300000 },
  { orderId: "preview-order-2", providerId: "smsbower", providerName: "SMSBower", countryLabel: "印度尼西亚", phone: "*******0118", cost: { amount: "12.50", currency: "RUB", source: "order" }, refundExpected: false, refundStatus: "unconfirmed", createdAt: Date.now() - 240000 },
];
const demoAssignedOrder = { orderId: "preview-order-3", providerId: "herosms", providerName: "Hero SMS", countryLabel: "菲律宾", phone: "*******2261", cost: { amount: "0.22", currency: "USD", source: "order" }, refundExpected: false, refundStatus: "unconfirmed", createdAt: Date.now() - 180000 };
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
    { id: "preview-stock-1", entryId: "preview-1", providerId: "smsbower", state: "ready", phone: "*******0482", cost: { amount: "0.28", currency: "USD", source: "order" }, createdAt: Date.now() - 60000, expiresAt: Date.now() + 20 * 60000, expiresSource: "provider_policy", cancelAllowedAt: Date.now() + 60000, refundStatus: "unconfirmed" },
    { id: "preview-stock-2", entryId: "preview-2", providerId: "herosms", state: "ready", phone: "*******9704", cost: { amount: "0", currency: "USD", source: "order" }, createdAt: Date.now() - 80000, expiresAt: Date.now() + 17 * 60000, expiresSource: "provider_policy", cancelAllowedAt: Date.now() + 40000, refundStatus: "unconfirmed" },
    { id: "preview-stock-3", entryId: "preview-4", state: "assigned", ...demoAssignedOrder, expiresAt: Date.now() + 16 * 60000, expiresSource: "provider" },
    { id: "preview-stock-4", entryId: "preview-1", providerId: "smsbower", state: "cancel_pending", phone: "*******4910", cost: { amount: "0.28", currency: "USD", source: "order" }, refundExpected: true, createdAt: Date.now() - 700000, expiresAt: Date.now() + 4 * 60000, expiresSource: "provider_policy", nextActionAt: Date.now() + 30000, cancelState: "unknown", refundStatus: "unconfirmed" },
    { id: "preview-stock-5", entryId: "preview-2", providerId: "herosms", state: "purchase_unknown", phone: null, createdAt: Date.now() - 90000, expiresAt: null, cancelState: "unknown", refundStatus: "unconfirmed", lastError: "interrupted_purchase", canReconcile: true },
  ] },
  costSummary: { byCurrency: [{ currency: "USD", confirmedPurchaseAmount: "0.78", confirmedOrderCount: 4, refundUnconfirmedAmount: "0.28", refundUnconfirmedCount: 1 }, { currency: "RUB", confirmedPurchaseAmount: "12.50", confirmedOrderCount: 1, refundUnconfirmedAmount: "0", refundUnconfirmedCount: 0 }], unknownCostCount: 2, unknownCurrencyCount: 0, orderCount: 7 },
  operations: [{ id: "preview-op-1", email: "sample-01@example.invalid", cdkLabel: "页面示例 CDK", status: "committed", fee: 2, attempts: 2, cost: demoOrders[1].cost, costOrders: demoOrders, createdAt: Date.now() - 300000 }, { id: "preview-op-2", email: "sample-02@example.invalid", cdkLabel: "页面示例 CDK", status: "reconciliation_required", fee: 2, attempts: 1, cost: demoAssignedOrder.cost, costOrders: [demoAssignedOrder], reason: "验证响应中断，等待核实", createdAt: Date.now() - 180000 }],
};
const quotes = [{ country: "6", title: "印度尼西亚", price: 0.28, count: 28, currency: "USD", providerIds: "1", grade: "gold" }, { country: "6", title: "印度尼西亚", price: 0.32, count: 45, currency: "USD", providerIds: "2", grade: "unknown" }, { country: "73", title: "巴西", price: 0.39, count: 16, currency: "USD", providerIds: "3", grade: "unknown" }, { country: "16", title: "英国", price: 0.42, count: 12, currency: "USD", providerIds: "4", grade: "gold" }, { country: "36", title: "加拿大", price: 0.35, count: 8, currency: "USD", providerIds: "5", grade: "unknown" }];
let snapshot = structuredClone(initial);
async function previewApi(path = "", method = "GET", body) {
  if (!path) return structuredClone(snapshot);
  if (path.endsWith("/options")) return { options: quotes };
  if (path === "/rules") { snapshot.rules = { ...body }; snapshot.buffer.rules = { ...body.buffer }; }
  else if (path === "/buffer/warmup") { snapshot.buffer.activeDemandAt = Date.now(); snapshot.buffer.refilling = true; }
  else if (path === "/buffer/drain") { snapshot.buffer.activeDemandAt = null; snapshot.buffer.refilling = false; for (const row of snapshot.buffer.items) if (row.state === "ready") { row.state = "cancel_pending"; row.cancelState = "pending"; } snapshot.buffer.counts.cancel_pending += snapshot.buffer.counts.ready; snapshot.buffer.counts.ready = 0; }
  else if (path.startsWith("/inventory/") && path.endsWith("/reconcile")) { const row = snapshot.buffer.items.find((item) => item.id === path.split("/")[2]); if (row) { row.state = "closed"; row.canReconcile = false; row.refundStatus = body.refundEvidence ? "confirmed" : "unconfirmed"; } }
  else if (path === "/credentials") { const row = { ...body, id: body.id || `preview-cred-${Date.now()}`, hasApiKey: true }; delete row.apiKey; snapshot.credentials = [...snapshot.credentials.filter((item) => item.id !== row.id), row]; }
  else if (path === "/entries") { for (const item of body.entries) { const credential = snapshot.credentials.find((row) => row.id === item.credentialId); snapshot.entries.push({ ...item, id: `preview-${Date.now()}-${snapshot.entries.length}`, providerId: credential.providerId, credentialName: credential.name, state: "available", noStockCount: 0 }); } }
  else if (path.startsWith("/entries/")) { const row = snapshot.entries.find((item) => item.id === path.split("/")[2]); Object.assign(row, body); row.state = row.enabled ? "available" : "disabled"; if (body.resetCooldown) row.noStockCount = 0; }
  else if (path.endsWith("/reconcile")) { const row = snapshot.operations.find((item) => item.id === path.split("/")[2]); row.status = body.action === "verified" ? "committed" : "released"; }
  return structuredClone(snapshot);
}
function Preview() {
  const [view, setView] = useState("admin"); const [version, setVersion] = useState(0);
  const [chargePreview, setChargePreview] = useState(false);
  const api = useCallback((...args) => previewApi(...args), []);
  const summary = { ...snapshot.rules, available: true, status: snapshot.buffer.counts.ready ? "ready" : snapshot.buffer.refilling ? "fetching" : "available_on_demand", hasNumbers: snapshot.buffer.counts.ready > 0, refilling: snapshot.buffer.refilling };
  return <><div className="sp-preview-banner"><span>页面设计预览：国家、价格和记录均为演示数据，操作不会取号或扣次。</span><button onClick={() => setView(view === "admin" ? "user" : "admin")}>{view === "admin" ? "查看普通 CDK 配置" : "查看管理员页面"}</button><button onClick={() => setChargePreview(true)}>预览导入费用确认</button><button onClick={() => { snapshot = structuredClone(initial); setVersion((value) => value + 1); }}>重置演示</button></div><div className="app-shell"><aside className="app-sidebar"><div className="brand-block"><div className="brand-mark"><ShieldCheck size={19} /></div><h1>toSub2</h1></div><nav className="workspace-tabs" aria-label="预览工作区"><button onClick={() => setView("user")}><LogIn size={17} />账号授权</button><button className={view === "admin" ? "active" : ""} onClick={() => setView("admin")}><Globe2 size={17} />接码池</button><button onClick={() => setView("user")}><KeyRound size={17} />我的 CDK</button></nav><div className="sidebar-footer"><span>页面设计预览</span><p>管理员配置，普通 CDK 使用</p></div></aside><main className="workspace-content"><header className="topbar"><div className="workspace-path"><span>工作区</span><ChevronRight size={14} /><strong>{view === "admin" ? "接码池" : "接码平台配置"}</strong></div><div className="topbar-actions"><ThemeControl /></div></header>{view === "admin" ? <SmsPoolWorkspace key={version} api={api} /> : <section className="sp-preview-choice"><div className="sp-heading"><h2>接码平台配置</h2><Settings2 size={19} /></div><div className="provider-tabs"><button>自有接码平台</button><button className="active">接码池</button></div><SmsPoolChoice summary={summary} onManage={() => setView("admin")} /></section>}</main></div>{chargePreview && <ImportChargeDialog quote={{ count: 1, added: 1, updated: 0, charge: 1, balance: 30, after: 29, smsPool: { count: 1, fee: 10, maximum: 10, admin: false } }} onClose={() => setChargePreview(false)} />}</>;
}
createRoot(document.getElementById("root")).render(<Preview />);
