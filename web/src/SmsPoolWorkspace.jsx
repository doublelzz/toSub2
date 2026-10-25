import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, CircleAlert, Clock3, Globe2, KeyRound, LoaderCircle, Pause, PhoneIncoming, Play, Plus, RefreshCw, Search, Settings2, ShieldCheck, X } from "lucide-react";
import { useDialogFocus } from "./WorkspaceUi.jsx";
import { cdkFetch } from "./cdk-api.mjs";
import "./sms-pool.css";

const platforms = { smsbower: "SMSBower", herosms: "Hero SMS" };
const states = { available: "可用", cooling: "冷却中", disabled: "已停用", credential_error: "凭据异常", probing: "恢复尝试中" };
const settlementNames = { queued: "等待池名额", reserved: "已预留", running: "接码中", requesting: "正在取号", allocated: "已取号", submitted: "验证中", verified: "已扣次", committed: "已扣次", released: "已释放", reconciliation_required: "待核实", uncertain: "待核实", unknown: "待核实" };
const poolErrors = { no_stock: "当前国家和价格暂时无号", auth_invalid: "服务商密钥无效，请更新凭据", balance_insufficient: "服务商余额不足，请充值后恢复", rate_limited: "服务商限流，稍后重试", config_invalid: "报价配置无效，请重新查询", order_unknown: "取号结果待核实" };
const ruleDefaults = { enabled: false, fee: 2, noStockThreshold: 3, cooldownMinutes: 10, maxAttempts: 10, maxConcurrent: 5 };
const bufferDefaults = { enabled: false, target: 3, lowWater: 1, perEntry: 1, refillConcurrency: 1, minRemainingSeconds: 480, idleMinutes: 10, maxOutstanding: 10, maxPerMinute: 6 };
const bufferFields = [
  ["target", "目标库存", "个", 1, 20], ["lowWater", "补货水位", "个", 0, 19],
  ["perEntry", "每条报价最多", "个", 1, 20], ["refillConcurrency", "补货并发", "个", 1, 5],
  ["minRemainingSeconds", "分配时至少剩余", "秒", 60, 1800], ["idleMinutes", "无需求回收", "分钟", 1, 120],
  ["maxOutstanding", "未结束订单上限", "个", 1, 100], ["maxPerMinute", "每分钟购号上限", "个", 1, 60],
];
const bufferStates = { ready: "待分配", purchasing: "正在购号", checking: "正在检查", assigned: "已分配", consumed: "已使用", cancel_pending: "等待取消", purchase_unknown: "购号待核实", closed: "订单已结束", quarantined: "已隔离" };
const bufferErrors = { interrupted_purchase: "购号时服务中断，结果待核实", interrupted_inventory_check: "检查号码时服务中断", inventory_status_unconfirmed: "无法确认号码可分配", inventory_configuration_disabled: "关联配置已停用", cancellation_window_expired: "取消窗口已结束", FREE_CANCELLATION_EXPIRED: "服务商取消期限已过", OTP_RECEIVED: "号码已有短信，需核查取消结果", NEW_OTP_RECEIVED: "号码出现新短信，需核查取消结果", CANCEL_UNSUPPORTED: "服务商暂不支持确认取消", cancel_unconfirmed: "取消结果尚未确认", inventory_retired: "号码不再满足分配条件，正在回收", price_above_limit: "返回价格超过配置上限", administrator_drain: "管理员已请求回收", inventory_assignment_stopped: "分配已停止，正在回收", sms_received_before_assignment: "分配前已收到短信，正在回收", insufficient_remaining_lifetime: "剩余有效期不足" };
const refundNames = { confirmed: "退款已确认", refunded: "退款已确认", unconfirmed: "退款待核实", unknown: "退款待核实", pending: "退款待核实", not_applicable: "不适用", none: "退款待核实" };
const inventoryPhone = (value) => typeof value === "string" && value ? value.replace(/.(?=.{4})/g, "*") : "号码未确认";
const inventoryState = (row) => row.state === "closed" && row.cancelState === "confirmed" ? "取消已确认" : bufferStates[row.state] || "状态未知";
const normalizeRules = (rules = {}) => ({ ...rules, buffer: { ...bufferDefaults, ...rules.buffer } });
const time = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const optionLabel = (row) => [row.countryLabel, row.title, row.name].find((value) => typeof value === "string" && value.trim()) || `国家 ${row.country}`;
const validInteger = (value, min, max) => String(value ?? "").trim() !== "" && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
const ruleRanges = { fee: [1, 1000000], noStockThreshold: [1, 100], cooldownMinutes: [1, 1440], maxAttempts: [1, 20], maxConcurrent: [1, 20] };
const validBufferRules = (rules) => rules && typeof rules.enabled === "boolean" && bufferFields.every(([key, , , min, max]) => validInteger(rules[key], min, max)) && Number(rules.lowWater) < Number(rules.target) && Number(rules.perEntry) <= Number(rules.target) && Number(rules.target) <= Number(rules.maxOutstanding) && Number(rules.refillConcurrency) <= Number(rules.maxOutstanding);
const quoteRoute = (row, credentialId = row.credentialId) => JSON.stringify([credentialId, row.service || "dr", String(row.country), Number(row.maxPrice ?? row.price), String(row.providerIds || "")]);

export async function smsPoolRequest(token, path = "", method = "GET", body) {
  const response = await cdkFetch(`/api/admin/sms-pool${path}`, { method, headers: { "content-type": "application/json", "x-console-token": token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "接码池请求失败，请重试");
  return data;
}

function State({ value = "available" }) {
  return <span className={`sp-state sp-state-${value}`}><i aria-hidden="true" />{states[value] || value}</span>;
}

const costAmount = (value) => /^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(String(value ?? "")) ? String(value) : null;
const costTotalAmount = (value) => /^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(String(value ?? "")) ? String(value) : null;
const costCurrency = (value) => /^[A-Z]{3}$/.test(String(value || "")) ? String(value) : null;
const quotedMoney = (value, currency) => value && typeof value === "object" ? { amount: costAmount(value.amount), currency: costCurrency(value.currency) } : { amount: costAmount(value), currency: costCurrency(currency) };

function SmsOrderCost({ order = {} }) {
  const actual = order.cost?.source === "order" ? { amount: costAmount(order.cost.amount), currency: costCurrency(order.cost.currency) } : null;
  const quote = quotedMoney(order.quote, order.currency);
  const maximum = quotedMoney(order.maxPrice, order.currency);
  return <div className="sp-order-cost">{actual?.amount !== null && actual?.amount !== undefined && actual.currency ? <><strong>{actual.amount} {actual.currency}</strong><small>平台确认购号金额</small></> : <><strong>金额待确认</strong>{actual?.amount !== null && actual?.amount !== undefined && <small>平台金额 {actual.amount}，币种未确认</small>}{quote.amount !== null && <small>报价 {quote.amount} {quote.currency || "币种未知"}</small>}{maximum.amount !== null && <small>最高价 {maximum.amount} {maximum.currency || "币种未知"}</small>}</>}</div>;
}

function PoolCostSummary({ summary, stale, loading }) {
  const knownCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : "—";
  const amount = (value, currency) => costTotalAmount(value) !== null && costCurrency(currency) ? `${value} ${currency}` : "金额未知";
  return <section className="sp-cost-summary" aria-label="管理员服务商成本"><div className="sp-cost-heading"><h3>服务商成本</h3><p>按币种记录已确认购号金额。取消与退款分别核实，以下金额不代表最终净成本。</p></div>{!summary || stale ? <p className="sp-cost-unknown">{loading ? "正在读取成本记录" : stale ? "成本状态未知，请重新读取。" : "成本数据尚未记录。"}</p> : <><div className="sp-cost-currencies">{(Array.isArray(summary.byCurrency) ? summary.byCurrency : []).map((row) => <div className="sp-cost-currency" key={row.currency}><strong>{costCurrency(row.currency) || "币种未知"}</strong><span>已确认购号金额 <b>{amount(row.confirmedPurchaseAmount, row.currency)}</b><small>{knownCount(row.confirmedOrderCount)} 个订单</small></span><span>退款待核实 <b>{amount(row.refundUnconfirmedAmount, row.currency)}</b><small>{knownCount(row.refundUnconfirmedCount)} 个订单</small></span></div>)}</div><p className="sp-cost-counts"><span>已记录订单 {knownCount(summary.orderCount)}</span><span>金额未知订单 {knownCount(summary.unknownCostCount)}</span><span>币种未知订单 {knownCount(summary.unknownCurrencyCount)}</span></p></>}</section>;
}

function OperationCosts({ operation }) {
  const orders = Array.isArray(operation.costOrders) ? operation.costOrders : null;
  const attempts = Number.isSafeInteger(operation.attempts) && operation.attempts >= 0 ? operation.attempts : null;
  return <div className="sp-operation-costs"><SmsOrderCost order={operation} /><small>{attempts === null ? "取号次数未记录" : `取号尝试 ${attempts} 次`}{orders ? `，号码订单 ${orders.length} 个` : ""}</small>{orders?.length > 0 && <details className="sp-cost-orders"><summary>查看每个号码费用</summary><ol>{orders.map((order, index) => <li key={`${order.providerId || "provider"}:${order.orderId || index}`}><div><strong>{order.providerName || platforms[order.providerId] || "服务商未确认"}</strong><span>{inventoryPhone(order.phone)}</span>{order.countryLabel && <small>{order.countryLabel}</small>}{order.createdAt && <small>{time(order.createdAt)}</small>}</div><SmsOrderCost order={order} />{(order.refundExpected === true || order.refundStatus === "confirmed") && <small>{order.refundStatus === "confirmed" ? "退款已确认" : "退款待核实"}</small>}</li>)}</ol></details>}</div>;
}

export default function SmsPoolWorkspace({ token, api }) {
  const request = useCallback((path = "", method = "GET", body) => api ? api(path, method, body) : smsPoolRequest(token, path, method, body), [api, token]);
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [tab, setTab] = useState("entries");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [stale, setStale] = useState(false);
  const [operationPage, setOperationPage] = useState(1);
  const [operationHistory, setOperationHistory] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const mounted = useRef(true);
  const draftEdited = useRef(false);
  const refreshVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try { const value = await request(); if (mounted.current && version === refreshVersion.current) { setData(value); setDraft((previous) => draftEdited.current ? previous : normalizeRules(value.rules)); setStale(false); setError(""); return true; } }
    catch (failure) { if (mounted.current && version === refreshVersion.current) { setStale(true); setError(failure.message); } }
    return false;
  }, [request]);
  useEffect(() => { mounted.current = true; draftEdited.current = false; setData(null); setDraft(null); void refresh(); return () => { mounted.current = false; refreshVersion.current++; }; }, [refresh]);
  useEffect(() => {
    if (tab !== "buffer") return undefined;
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [tab, refresh]);
  useEffect(() => {
    if (tab !== "operations" || !data) return undefined;
    let active = true; setHistoryLoading(true); setHistoryError("");
    void request(`/operations?page=${operationPage}&pageSize=20`).then((value) => {
      if (!active) return;
      if (Array.isArray(value.items)) setOperationHistory(value);
      else { const rows = data.operations || []; setOperationHistory({ items: rows.slice((operationPage - 1) * 20, operationPage * 20), page: operationPage, pages: Math.max(1, Math.ceil(rows.length / 20)), total: rows.length }); }
    }).catch((failure) => { if (active) { setHistoryError(failure.message); setOperationHistory(null); } }).finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [tab, operationPage, request, data, historyAttempt]);
  const updateDraft = (patch) => { draftEdited.current = true; setDraft((previous) => ({ ...previous, ...patch })); };
  const updateBufferDraft = (patch) => { draftEdited.current = true; setDraft((previous) => ({ ...previous, buffer: { ...previous.buffer, ...patch } })); };
  async function perform(key, action, message) {
    if (busy) return;
    setBusy(key); setError(""); setNotice("");
    try { await action(); const refreshed = await refresh(); if (message && refreshed) setNotice(message); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(""); }
  }
  const rules = data?.rules || ruleDefaults;
  const entries = data?.entries || [];
  const credentials = data?.credentials || [];
  const operations = data?.operations || [];
  const buffer = stale ? null : data?.buffer;
  const bufferCount = (key) => Number.isSafeInteger(buffer?.counts?.[key]) ? buffer.counts[key] : "—";
  const operationRows = operationHistory?.items || [];
  const pending = operations.filter((row) => ["reconciliation_required", "uncertain", "unknown"].includes(row.status || row.state));
  const matching = entries.filter((row) => (filter === "all" || row.state === filter) && `${row.countryLabel} ${row.country} ${platforms[row.providerId]} ${row.credentialName || ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim()));
  const canSave = draft && typeof draft.enabled === "boolean" && Object.entries(ruleRanges).every(([key, [min, max]]) => validInteger(draft[key], min, max)) && validBufferRules(draft.buffer);
  return <section className="workspace sp-workspace" aria-labelledby="sp-title">
    <header className="sp-heading"><div><h2 id="sp-title">接码池</h2><p>把国家和报价加入池，接码时自动选择可用号码。</p></div><div className="sp-heading-actions"><button className="secondary-button" onClick={() => void perform("refresh", async () => {})} disabled={Boolean(busy)}><RefreshCw size={15} />刷新</button><button className="primary-button" onClick={() => setDialog({ kind: "entry" })} disabled={!data || !credentials.some((row) => row.enabled)}><Plus size={16} />添加国家报价</button></div></header>
    <div className="sp-pool-status"><span className={`sp-state ${stale ? "sp-state-credential_error" : rules.enabled ? "sp-state-available" : "sp-state-disabled"}`}><i />{!data || stale ? error ? "读取失败" : "正在读取接码池" : rules.enabled ? "接码池已开放" : "接码池已关闭"}</span><span>{data && !stale ? `${entries.filter((row) => row.state === "available").length} 个可用条目` : "可用条目未知"}</span><span>{data && !stale ? `${entries.filter((row) => row.state === "cooling").length} 个冷却中` : "正在读取规则"}</span><span className="sp-pool-fee">验证成功扣 <strong>{data && !stale ? rules.fee : "—"}</strong> 次</span></div>
    <PoolCostSummary summary={data?.costSummary} stale={stale} loading={!data && !error} />
    {error && <div className="sp-feedback sp-error" role="alert"><CircleAlert size={16} /><span>{error}</span><button className="text-action" onClick={() => void refresh()}>重新读取</button></div>}
    {notice && <div className="sp-feedback sp-success" role="status"><Check size={16} />{notice}</div>}
    {!data && !error && <div className="sp-empty" role="status"><LoaderCircle className="spin" size={22} /><p>正在读取接码池</p></div>}
    {data && <div className="sp-layout"><div className="sp-main">
      <nav className="sp-tabs" aria-label="接码池内容">{[["entries", "国家报价", entries.length], ["credentials", "服务商凭据", credentials.length], ["buffer", "号码缓冲", Number.isSafeInteger(buffer?.counts?.ready) ? buffer.counts.ready : undefined], ["operations", "接码记录", operationHistory?.total]].map(([value, label, count]) => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}{count !== undefined && <span>{count}</span>}</button>)}</nav>
      {tab === "entries" && <>
        <div className="sp-list-tools"><label className="sp-search"><Search size={16} /><input aria-label="搜索池内国家或服务商" placeholder="搜索国家、服务商" value={search} onChange={(event) => setSearch(event.target.value)} /></label><select aria-label="筛选接码池条目状态" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部状态</option>{Object.entries(states).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></div>
        <div className="table-frame sp-table-frame"><table className="sp-entry-table"><thead><tr><th>国家 / 服务商</th><th className="sp-price-column">价格上限</th><th>状态</th><th className="sp-priority-column">优先级</th><th>操作</th></tr></thead><tbody>{matching.map((row) => <tr key={row.id}>
          <td data-label="国家 / 服务商"><div className="sp-country"><span className="sp-country-icon"><Globe2 size={18} /></span><div><strong>{row.countryLabel || `国家 ${row.country}`}</strong><small>{platforms[row.providerId] || row.providerId} / {row.credentialName || credentials.find((item) => item.id === row.credentialId)?.name || "服务商凭据"}</small></div></div></td>
          <td data-label="价格上限" className="sp-price"><strong>{row.maxPrice}</strong><small>{row.currency || "平台币种"}</small></td>
          <td data-label="状态"><State value={row.state} /><small>{row.state === "cooling" ? `${time(Math.max(Number(row.cooldownUntil) || 0, Number(row.credentialCooldownUntil) || 0))} 后尝试恢复` : poolErrors[row.lastError] || row.lastError || (row.noStockCount ? `连续无号 ${row.noStockCount} 次` : "取号成功后自动收码")}</small></td>
          <td data-label="优先级" className="sp-priority"><span>{row.priority}</span></td>
          <td data-label="操作"><div className="sp-row-actions"><button className="text-action" aria-label={`编辑 ${row.countryLabel || row.country}`} onClick={() => setDialog({ kind: "edit", row })}>编辑</button><button className="text-action" disabled={Boolean(busy)} onClick={() => void perform(row.id, () => request(`/entries/${row.id}`, "PATCH", { enabled: row.state === "disabled" || row.enabled === false, ...(row.state === "cooling" ? { resetCooldown: true, enabled: true } : {}) }), row.state === "cooling" ? "已取消冷却，下次真实任务将尝试取号" : row.state === "disabled" ? "条目已启用" : "条目已停用")}>{row.state === "disabled" ? <Play size={13} /> : row.state === "cooling" ? <RefreshCw size={13} /> : <Pause size={13} />}{row.state === "disabled" ? "启用" : row.state === "cooling" ? "恢复" : "停用"}</button></div></td>
        </tr>)}</tbody></table>{!matching.length && <div className="sp-empty"><Globe2 size={25} /><h3>{entries.length ? "没有匹配的国家报价" : "添加第一条国家报价"}</h3><p>{entries.length ? "调整搜索或状态筛选。" : "先保存服务商凭据，再查询国家和价格加入池。"}</p><button className="secondary-button" onClick={() => setDialog({ kind: credentials.length ? "entry" : "credential" })}><Plus size={15} />{credentials.length ? "添加国家报价" : "添加服务商凭据"}</button></div>}</div>
        <p className="sp-footnote">优先级数值越小越先取号，同级轮流使用。报价和库存会变化，取号不超过价格上限。</p>
      </>}
      {tab === "credentials" && <><div className="sp-list-caption"><p>密钥仅用于后台取号，普通 CDK 无法查看。</p><button className="secondary-button" onClick={() => setDialog({ kind: "credential" })}><Plus size={15} />添加凭据</button></div><div className="sp-credentials">{credentials.map((row) => <div className="sp-credential-row" key={row.id}><span className="sp-country-icon"><KeyRound size={18} /></span><div><strong>{row.name}</strong><small>{platforms[row.providerId]} / {row.hasApiKey ? "密钥已保存" : "未配置密钥"}</small>{row.blockedReason && <small className="sp-credential-error">{poolErrors[row.blockedReason] || "凭据异常，请编辑后恢复"}</small>}</div><State value={!row.enabled ? "disabled" : row.blockedReason ? "credential_error" : row.cooldownUntil > Date.now() ? "cooling" : "available"} /><div className="sp-credential-actions"><button className="text-action" disabled={Boolean(busy)} onClick={() => setDialog({ kind: "credential", row })}>{row.blockedReason === "auth_invalid" ? "更新密钥" : "编辑"}</button>{row.enabled && row.blockedReason === "balance_insufficient" && <button className="text-action" disabled={Boolean(busy)} onClick={() => void perform(row.id, () => request("/credentials", "POST", { id: row.id, providerId: row.providerId, name: row.name, enabled: true, resetCooldown: true }), "凭据已恢复，下次真实任务将重新取号")}>充值后恢复</button>}</div></div>)}{!credentials.length && <div className="sp-empty"><KeyRound size={25} /><h3>还没有服务商凭据</h3><p>添加 SMSBower 或 Hero SMS 后即可查询报价。</p><button className="primary-button" onClick={() => setDialog({ kind: "credential" })}>添加服务商凭据</button></div>}</div></>}
      {tab === "operations" && <><div className="sp-list-caption"><p>接码服务费与新增账号导入费分别记录。</p>{pending.length > 0 && <span className="sp-pending-count"><Clock3 size={14} />{pending.length} 条待核实</span>}</div><div className="table-frame"><table className="sp-operation-table"><thead><tr><th>账号 / CDK</th><th>结算状态</th><th>CDK 扣次</th><th>服务商费用</th><th>时间 / 操作</th></tr></thead><tbody>{operationRows.map((row) => <tr key={`${row.cdkId || row.ownerCdkId || "admin"}:${row.id || row.operationId}`}><td data-label="账号"><strong>{row.email || row.accountEmail}</strong><small>{row.cdkLabel || row.ownerCdkId || "管理员工作区"}</small></td><td data-label="结算状态"><span className={`sp-settlement sp-settlement-${row.status || row.state}`}>{settlementNames[row.status || row.state] || row.status || row.state}</span><small>{poolErrors[row.reason || row.lastError] || row.reason || row.lastError}</small></td><td data-label="CDK 扣次" className="sp-price">{row.fee ?? row.feeSnapshot ?? "—"} 次</td><td data-label="服务商费用"><OperationCosts operation={row} /></td><td data-label="时间"><small>{time(row.createdAt)}</small>{["reconciliation_required", "uncertain", "unknown"].includes(row.status || row.state) && <button className="text-action" onClick={() => setDialog({ kind: "reconcile", row })} disabled={Boolean(busy) || historyLoading}>核实处理</button>}</td></tr>)}</tbody></table>{!operationRows.length && !historyLoading && !historyError && <div className="sp-empty"><Clock3 size={25} /><h3>还没有池接码记录</h3><p>用户选择接码池后，本页记录预留、扣次和释放结果。</p></div>}{historyLoading && <p className="sp-history-status" role="status">正在读取接码记录</p>}{historyError && <div className="sp-feedback sp-error" role="alert"><span>{historyError}</span><button className="text-action" onClick={() => setHistoryAttempt((value) => value + 1)}>重新读取记录</button></div>}</div>{operationHistory && <nav className="sp-history-pagination" aria-label="接码记录分页"><span>共 {operationHistory.total} 条记录</span><div><button className="secondary-button" disabled={historyLoading || operationPage <= 1} onClick={() => setOperationPage((value) => value - 1)}>上一页</button><span>{operationHistory.page} / {operationHistory.pages}</span><button className="secondary-button" disabled={historyLoading || operationPage >= operationHistory.pages} onClick={() => setOperationPage((value) => value + 1)}>下一页</button></div></nav>}</>}
      {tab === "buffer" && <section className="sp-buffer" aria-labelledby="sp-buffer-title">
        <div className="sp-buffer-heading"><div><h3 id="sp-buffer-title">号码缓冲</h3><p>{!buffer ? "库存状态未知，请刷新读取。" : !buffer.rules?.enabled ? "缓冲已关闭，接码时按需取号。" : buffer.refilling ? "正在补货，已有号码仍可分配。" : "提前保留少量号码，供接码任务分配。"}</p></div><span className={`sp-state ${buffer?.rules?.enabled ? "sp-state-available" : "sp-state-disabled"}`}><i />{!buffer ? "状态未知" : buffer.rules?.enabled ? "缓冲已启用" : "缓冲已关闭"}</span></div>
        <div className="sp-buffer-counts" aria-label="缓冲库存统计">{[["ready", "待分配"], ["purchasing", "购号中"], ["checking", "检查中"], ["assigned", "已分配"], ["cancel_pending", "等待取消"], ["purchase_unknown", "购号待核实"], ["quarantined", "已隔离"], ["closed", "已结束"]].map(([key, label]) => <div key={key}><span>{label}</span><strong>{bufferCount(key)}</strong></div>)}</div>
        <div className="sp-buffer-actions"><button type="button" className="primary-button" disabled={Boolean(busy) || !buffer?.rules?.enabled || !rules.enabled} onClick={() => void perform("warmup", () => request("/buffer/warmup", "POST", {}), "已请求补货，后台按缓冲规则购号")}><Plus size={15} />立即补货</button><button type="button" className="secondary-button" disabled={Boolean(busy) || !buffer} onClick={() => void perform("drain", () => request("/buffer/drain", "POST", {}), "已请求回收未分配号码，请查看取消结果")}><Pause size={15} />回收未分配号码</button><span>{buffer?.activeDemandAt ? `最近接码需求 ${time(buffer.activeDemandAt)}` : "最近接码需求未知"}</span></div>
        <p className="sp-footnote">预购号码可能产生服务商费用。取消已确认与退款已确认分别记录，回收不会取消已分配号码。</p>
        <div className="table-frame sp-buffer-table-frame"><table className="sp-buffer-table"><thead><tr><th>号码 / 来源</th><th>库存状态</th><th>号码费用</th><th>有效期</th><th>回收 / 退款</th></tr></thead><tbody>{(buffer?.items || []).map((row) => <tr key={row.id}><td data-label="号码 / 来源"><strong>{inventoryPhone(row.phone)}</strong><small>{platforms[row.providerId] || "来源未确认"} / {entries.find((entry) => entry.id === row.entryId)?.countryLabel || "池内报价"}</small>{row.createdAt && <small>购号 {time(row.createdAt)}</small>}</td><td data-label="库存状态"><span className={`sp-buffer-state sp-buffer-state-${row.state}`}>{inventoryState(row)}</span>{row.lastError && <small>{poolErrors[row.lastError] || bufferErrors[row.lastError] || row.lastError}</small>}</td><td data-label="号码费用"><SmsOrderCost order={row} /></td><td data-label="有效期"><span>{row.expiresAt ? time(row.expiresAt) : "有效期未确认"}</span><small>{row.expiresSource === "provider" ? "服务商返回有效期" : row.expiresSource === "provider_policy" ? "按服务商期限规则" : row.expiresSource ? "按保守期限处理" : "不推定有效期"}</small></td><td data-label="回收 / 退款"><span>{row.cancelState === "confirmed" ? "取消已确认" : row.cancelState === "denied" ? "暂不允许取消" : row.state === "cancel_pending" ? "取消处理中" : row.state === "assigned" ? "随接码任务处理" : row.state === "closed" ? "订单已结束" : "尚未回收"}</span>{["cancel_pending", "closed", "quarantined"].includes(row.state) || row.cancelState ? <small>{refundNames[row.refundStatus] || "退款待核实"}</small> : null}{(row.nextCancelAt || row.nextActionAt) && <small>下次处理 {time(row.nextCancelAt || row.nextActionAt)}</small>}{!row.nextCancelAt && !row.nextActionAt && (row.cancelAfter || row.cancelAllowedAt) && <small>最早取消 {time(row.cancelAfter || row.cancelAllowedAt)}</small>}{row.canReconcile && <button type="button" className="text-action" disabled={Boolean(busy)} onClick={() => setDialog({ kind: "inventory", row })}>核实库存</button>}</td></tr>)}</tbody></table>{buffer && !buffer.items?.length && <div className="sp-empty"><PhoneIncoming size={25} /><h3>还没有缓冲号码</h3><p>{buffer.rules?.enabled ? "可手动补货，或等待接码需求触发补货。" : "在池规则中启用缓冲后，可按设定上限补货。"}</p></div>}{!buffer && <p className="sp-history-status" role="status">尚未读取到库存，请刷新接码池。</p>}</div>
      </section>}
    </div><aside className="sp-rules"><div className="sp-rules-heading"><Settings2 size={17} /><h3>池规则</h3><span>对所有 CDK 生效</span></div>
      <form onSubmit={(event) => { event.preventDefault(); if (!canSave || busy) return; void perform("rules", async () => { await request("/rules", "PUT", { ...draft, fee: Number(draft.fee), noStockThreshold: Number(draft.noStockThreshold), cooldownMinutes: Number(draft.cooldownMinutes), maxAttempts: Number(draft.maxAttempts), maxConcurrent: Number(draft.maxConcurrent), buffer: { enabled: draft.buffer.enabled, ...Object.fromEntries(bufferFields.map(([key]) => [key, Number(draft.buffer[key])])) } }); draftEdited.current = false; }, "池规则已保存，已开始的接码按原费率结算"); }}>
        <label className="sp-toggle-row"><span><strong>向普通 CDK 开放</strong><small>关闭后停止分配新号码</small></span><input type="checkbox" role="switch" disabled={Boolean(busy)} checked={Boolean(draft?.enabled)} onChange={(event) => updateDraft({ enabled: event.target.checked })} aria-label="向普通 CDK 开放接码池" /></label>
        <div className="sp-rule-group"><label className="sp-number-field"><span>验证成功扣次</span><div><input aria-label="验证成功扣次" type="number" min="1" max="1000000" required disabled={Boolean(busy)} value={draft?.fee ?? ""} onChange={(event) => updateDraft({ fee: event.target.value })} /><span>次 / 账号</span></div></label><p>手机验证码通过后扣除。取号失败、无号和未通过验证不扣次。</p></div>
        <div className="sp-rule-group"><h4>连续无号自动暂停</h4><div className="sp-paired-fields"><label className="sp-number-field"><span>连续无号</span><div><input aria-label="连续无号暂停阈值" type="number" min="1" max="100" required disabled={Boolean(busy)} value={draft?.noStockThreshold ?? ""} onChange={(event) => updateDraft({ noStockThreshold: event.target.value })} /><span>次</span></div></label><label className="sp-number-field"><span>首次冷却</span><div><input aria-label="首次冷却分钟" type="number" min="1" max="1440" required disabled={Boolean(busy)} value={draft?.cooldownMinutes ?? ""} onChange={(event) => updateDraft({ cooldownMinutes: event.target.value })} /><span>分钟</span></div></label></div><p>仅明确无号计数。冷却后由一个真实任务尝试恢复，成功取号即清零。</p></div>
        <div className="sp-rule-group"><div className="sp-paired-fields"><label className="sp-number-field"><span>单次取号上限</span><div><input aria-label="单次取号尝试上限" type="number" min="1" max="20" required disabled={Boolean(busy)} value={draft?.maxAttempts ?? ""} onChange={(event) => updateDraft({ maxAttempts: event.target.value })} /><span>次</span></div></label><label className="sp-number-field"><span>池并发上限</span><div><input aria-label="池并发上限" type="number" min="1" max="20" required disabled={Boolean(busy)} value={draft?.maxConcurrent ?? ""} onChange={(event) => updateDraft({ maxConcurrent: event.target.value })} /><span>个</span></div></label></div></div>
        <details className="sp-buffer-rule-settings"><summary>号码缓冲<span>{draft?.buffer?.enabled ? "启用" : "关闭"}</span></summary><label className="sp-toggle-row"><span><strong>提前准备号码</strong><small>默认关闭，启用后按上限补货与回收</small></span><input type="checkbox" role="switch" aria-label="启用号码缓冲" disabled={Boolean(busy)} checked={Boolean(draft?.buffer?.enabled)} onChange={(event) => updateBufferDraft({ enabled: event.target.checked })} /></label><div className="sp-buffer-rule-fields">{bufferFields.map(([key, label, unit, min, max]) => <label className="sp-number-field" key={key}><span>{label}</span><div><input type="number" required min={min} max={max} disabled={Boolean(busy)} aria-label={`缓冲${label}`} value={draft?.buffer?.[key] ?? ""} onChange={(event) => updateBufferDraft({ [key]: event.target.value })} /><span>{unit}</span></div></label>)}</div><p className="sp-footnote">补货水位低于目标库存；每条报价上限不高于目标，目标和补货并发不高于未结束订单上限。未知订单也占用上限。</p>{draft?.buffer && !validBufferRules(draft.buffer) && <p className="sp-error sp-footnote" role="alert">请填写范围内的整数，并核对库存、水位和并发上限。</p>}</details>
        <button className="primary-button sp-save-rules" disabled={!canSave || Boolean(busy)}>{busy === "rules" ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}保存池规则</button>
      </form><div className="sp-charge-note"><ShieldCheck size={17} /><p>开始接码先预留次数，成功后正式扣除。结果不明确时保留预留，等待核实。</p></div>
    </aside></div>}
    {dialog?.kind === "inventory" && <InventoryReconcileDialog row={dialog.row} onClose={() => setDialog(null)} onSave={async (body) => { await request(`/inventory/${dialog.row.id}/reconcile`, "POST", body); setDialog(null); await refresh(); setNotice("库存核实结果已记录，CDK接码费用按原操作保留"); }} />}
    {dialog?.kind === "credential" && <CredentialDialog row={dialog.row} onClose={() => setDialog(null)} onSave={(body) => request("/credentials", "POST", body)} onSaved={async () => { setDialog(null); await refresh(); setNotice("服务商凭据已保存"); }} />}
    {dialog?.kind === "entry" && <EntryDialog credentials={credentials} existingEntries={entries} request={request} onClose={() => setDialog(null)} onSaved={async () => { setDialog(null); await refresh(); setNotice("国家报价已加入池"); }} />}
    {dialog?.kind === "edit" && <EditEntryDialog row={dialog.row} onClose={() => setDialog(null)} onSave={async (body) => { await request(`/entries/${dialog.row.id}`, "PATCH", body); setDialog(null); await refresh(); setNotice("条目已更新，已分配的订单继续按原配置处理"); }} />}
    {dialog?.kind === "reconcile" && <ReconcileDialog row={dialog.row} onClose={() => setDialog(null)} onSave={async (body) => { await request(`/operations/${dialog.row.id || dialog.row.operationId}/reconcile`, "POST", { ...body, cdkId: dialog.row.cdkId }); setDialog(null); await refresh(); setNotice("核实结果已记录"); }} />}
  </section>;
}

function DialogForm({ title, children, onClose, onSubmit, busy, error, action = "保存", canSubmit = true, confirmation = false }) {
  const ref = useRef(null); useDialogFocus(true, () => { if (!busy) onClose(); }, ref);
  return <div className={`modal-backdrop sp-dialog-backdrop${confirmation ? " sp-confirmation-backdrop" : ""}`} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><form className="sp-dialog" ref={ref} role="dialog" aria-modal="true" aria-label={title} onSubmit={onSubmit}><header><div><h2>{title}</h2></div><button type="button" className="icon-button" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}><X size={18} /></button></header>{children}{error && <p className="sp-error sp-form-error" role="alert">{error}</p>}<footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy || !canSubmit}>{busy && <LoaderCircle size={15} className="spin" />}{action}</button></footer></form></div>;
}

function CredentialDialog({ row, onClose, onSave, onSaved }) {
  const [form, setForm] = useState({ id: row?.id, name: row?.name || "", providerId: row?.providerId || "smsbower", apiKey: "", enabled: row?.enabled ?? true });
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  return <DialogForm title={row ? "编辑服务商凭据" : "添加服务商凭据"} onClose={onClose} busy={busy} error={error} onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(""); try { const body = { ...form }; if (!body.apiKey && row) delete body.apiKey; await onSave(body); await onSaved(); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }} action="保存凭据"><div className="sp-form-body"><label className="sp-field">配置名称<input value={form.name} maxLength={80} required placeholder="例如：SMSBower 主账户" onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label className="sp-field">接码平台<select value={form.providerId} disabled={Boolean(row)} onChange={(event) => setForm({ ...form, providerId: event.target.value })}>{Object.entries(platforms).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label className="sp-field">API Key<input type="password" value={form.apiKey} required={!row} autoComplete="new-password" placeholder={row ? "已保存，留空保留原密钥" : "输入服务商 API Key"} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} /></label><label className="sp-check"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />启用此凭据</label><p className="sp-footnote">密钥加密保存在服务端，普通 CDK 无法读取。</p></div></DialogForm>;
}

function EntryDialog({ credentials, existingEntries = [], request, onClose, onSaved }) {
  const [credentialId, setCredentialId] = useState(credentials.find((row) => row.enabled)?.id || "");
  const [options, setOptions] = useState([]); const [selected, setSelected] = useState(new Set());
  const [query, setQuery] = useState(""); const [priority, setPriority] = useState("10"); const [gradeFilter, setGradeFilter] = useState("all");
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false); const [loaded, setLoaded] = useState(false); const [error, setError] = useState("");
  const ref = useRef(null); useDialogFocus(true, () => { if (!busy) onClose(); }, ref);
  const credential = credentials.find((row) => row.id === credentialId);
  const existing = new Set(existingEntries.map((row) => quoteRoute(row)));
  const shown = options.filter((row) => `${optionLabel(row)} ${row.country}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (credential?.providerId !== "smsbower" || gradeFilter === "all" || (row.grade === "gold" ? "gold" : "unknown") === gradeFilter));
  async function load() { setLoading(true); setError(""); setOptions([]); setSelected(new Set()); setLoaded(false); try { const value = await request(`/credentials/${credentialId}/options`, "POST", {}); const rows = Array.isArray(value.options || value) ? value.options || value : []; setOptions([...new Map(rows.map((row) => [quoteRoute(row, credentialId), row])).values()]); setLoaded(true); } catch (failure) { setError(failure.message); } finally { setLoading(false); } }
  return <div className="modal-backdrop sp-dialog-backdrop"><form ref={ref} className="sp-dialog sp-quote-dialog" role="dialog" aria-modal="true" aria-label="添加国家报价" onSubmit={async (event) => { event.preventDefault(); if (!selected.size || busy || loading || !validInteger(priority, 0, 10000)) return; setBusy(true); setError(""); try { await request("/entries", "POST", { entries: [...selected].map((index) => { const row = options[index]; return { credentialId, country: String(row.country), countryLabel: optionLabel(row), maxPrice: String(row.price), quotedPrice: String(row.price), currency: row.currency || "", providerIds: row.providerIds || "", ...(credential?.providerId === "smsbower" ? { grade: row.grade === "gold" ? "gold" : "unknown", gradeFilter: row.grade === "gold" ? "gold" : "unknown" } : {}), priority: Number(priority), enabled: true }; }) }); await onSaved(); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }}>
    <header><div><h2>添加国家报价</h2><p>可同时选择多个国家和价格档位。</p></div><button type="button" className="icon-button" aria-label="关闭添加国家报价" disabled={busy} onClick={onClose}><X size={18} /></button></header>
    <div className="sp-form-body"><div className="sp-quote-source"><label className="sp-field">服务商凭据<select aria-label="选择服务商凭据" value={credentialId} disabled={loading || busy} onChange={(event) => { setCredentialId(event.target.value); setOptions([]); setSelected(new Set()); setQuery(""); setGradeFilter("all"); setLoaded(false); }}>{credentials.filter((row) => row.enabled).map((row) => <option key={row.id} value={row.id}>{row.name} / {platforms[row.providerId]}</option>)}</select></label><button type="button" className="secondary-button" disabled={!credentialId || loading || busy} onClick={() => void load()}>{loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}查询国家报价</button></div>
    {options.length > 0 && <div className="sp-quote-filters"><label className="sp-search"><Search size={16} /><input aria-label="搜索可添加国家" placeholder="搜索国家 / ID" value={query} onChange={(event) => setQuery(event.target.value)} /></label>{credential?.providerId === "smsbower" && <label className="sp-quote-grade"><span>供应商档位</span><select aria-label="筛选可添加报价档位" value={gradeFilter} onChange={(event) => setGradeFilter(event.target.value)}><option value="all">全部档位</option><option value="gold">Gold</option><option value="unknown">其他（未标级）</option></select></label>}</div>}
    <div className="sp-quote-options">{shown.map((row) => { const index = options.indexOf(row); const added = existing.has(quoteRoute(row, credentialId)); return <label className={`sp-quote-option ${selected.has(index) ? "selected" : ""} ${added ? "sp-quote-added" : ""}`} key={quoteRoute(row, credentialId)}><input type="checkbox" checked={selected.has(index)} disabled={busy || added || selected.size >= 100 && !selected.has(index)} onChange={() => setSelected((previous) => { const next = new Set(previous); next.has(index) ? next.delete(index) : next.add(index); return next; })} /><span><strong>{optionLabel(row)}</strong><small>{added ? "已在池中 / " : ""}{credential?.providerId === "smsbower" ? `${row.grade === "gold" ? "Gold" : "未标级"} / ` : ""}库存 {row.count ?? "未知"}</small></span><span className="sp-price"><strong>{row.price}</strong><small>{row.currency || "平台币种"}</small></span></label>; })}{!options.length && <div className="sp-empty"><Globe2 size={25} /><p>{loading ? "正在查询国家、报价和库存" : loaded ? "当前暂无可用报价，请稍后重新查询。" : "选择凭据后查询国家报价。查询不会购买号码。"}</p></div>}{options.length > 0 && !shown.length && <p className="sp-footnote">没有匹配的国家或档位，请调整筛选。</p>}</div>
    <label className="sp-number-field sp-priority-input"><span>所选条目优先级</span><div><input aria-label="新增条目优先级" type="number" min="0" max="10000" required value={priority} onChange={(event) => setPriority(event.target.value)} /><span>越小越优先</span></div></label>{error && <p className="sp-error" role="alert">{error}</p>}</div>
    <footer><span>已选 {selected.size} 条报价，最多 100 条</span><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={!selected.size || loading || busy || !validInteger(priority, 0, 10000)}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}加入接码池</button></footer>
  </form></div>;
}

function EditEntryDialog({ row, onClose, onSave }) {
  const [priority, setPriority] = useState(String(row.priority)); const [enabled, setEnabled] = useState(row.enabled !== false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  return <DialogForm title="编辑国家报价" onClose={onClose} busy={busy} error={error} onSubmit={async (event) => { event.preventDefault(); if (!validInteger(priority, 0, 10000)) return; setBusy(true); try { await onSave({ priority: Number(priority), enabled }); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }}><div className="sp-form-body"><div className="sp-edit-country"><Globe2 size={23} /><div><strong>{row.countryLabel}</strong><small>{platforms[row.providerId]} / 价格上限 {row.maxPrice} {row.currency}</small></div></div><label className="sp-field">优先级<input type="number" min="0" max="10000" required value={priority} onChange={(event) => setPriority(event.target.value)} /></label><label className="sp-check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用此条目</label><p className="sp-footnote">调整报价请重新查询后添加。已有订单按取号时的配置完成。</p></div></DialogForm>;
}

function InventoryReconcileDialog({ row, onClose, onSave }) {
  const [confirmed, setConfirmed] = useState(false); const [note, setNote] = useState(""); const [refundEvidence, setRefundEvidence] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const canSubmit = confirmed && note.trim().length >= 3 && note.trim().length <= 500 && (!refundEvidence.trim() || refundEvidence.trim().length >= 3);
  return <DialogForm title="核实缓冲订单" onClose={onClose} busy={busy} error={error} canSubmit={canSubmit} action="确认结束订单" onSubmit={async (event) => { event.preventDefault(); if (!canSubmit || busy) return; setBusy(true); setError(""); try { await onSave({ action: "close", note: note.trim(), ...(refundEvidence.trim() ? { refundEvidence: refundEvidence.trim() } : {}) }); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }}><div className="sp-form-body"><p className="sp-inventory-phone">{inventoryPhone(row.phone)}</p><p className="sp-footnote">核对服务商订单后，可结束该库存记录。CDK 接码费用按原操作保留。</p><label className="sp-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />已核实服务商没有该号码的活跃订单</label><label className="sp-field">核实依据<textarea aria-label="库存核实依据" required minLength={3} maxLength={500} rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="填写服务商订单状态和核查依据，不填写验证码或密钥" /></label><label className="sp-field">退款凭证（可选）<textarea aria-label="库存退款凭证" minLength={3} maxLength={500} rows={2} value={refundEvidence} onChange={(event) => setRefundEvidence(event.target.value)} placeholder="有可核对的退款记录时填写，留空保持退款待核实" /></label><p className="sp-footnote">取消已确认仍需单独核实退款结果。</p></div></DialogForm>;
}

function ReconcileDialog({ row, onClose, onSave }) {
  const [action, setAction] = useState("release"); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  return <DialogForm title="核实接码结果" onClose={onClose} busy={busy} error={error} action="记录核实结果" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await onSave({ action, note }); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }}><div className="sp-form-body"><p>{row.email || row.accountEmail}</p><p className="sp-footnote">预留 {row.fee ?? row.feeSnapshot} 次。请核对目标服务的验证结果，服务商收到短信不等于验证通过。</p><label className="sp-field">核实结论<select value={action} onChange={(event) => setAction(event.target.value)}><option value="release">确认未成功，释放预留</option><option value="verified">确认验证成功，扣除次数</option></select></label><label className="sp-field">处理说明<textarea required minLength={3} maxLength={200} rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="填写核查依据，不填写验证码或密钥" /></label></div></DialogForm>;
}

export function SmsPoolChoice({ token, summary: providedSummary, onManage }) {
  const [summary, setSummary] = useState(providedSummary || null); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const requestVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    if (providedSummary) { setSummary(providedSummary); setError(""); setLoading(false); return; }
    setLoading(true); setSummary(null); setError("");
    try { const response = await cdkFetch("/api/sms-pool", { headers: { "x-console-token": token } }); const data = await response.json(); if (!response.ok) throw new Error(data.error || "读取接码池失败"); if (version === requestVersion.current) setSummary(data); }
    catch (failure) { if (version === requestVersion.current) { setSummary(null); setError(failure.message); } }
    finally { if (version === requestVersion.current) setLoading(false); }
  }, [token, providedSummary]);
  useEffect(() => { void refresh(); return () => { requestVersion.current++; }; }, [refresh]);
  useEffect(() => {
    if (providedSummary) return undefined;
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh, providedSummary]);
  const statusNames = { ready: "有号码", fetching: "正在补货", available_on_demand: "可即时取号", unavailable: "暂无号码" };
  const status = summary?.enabled === false ? "暂未开放" : statusNames[summary?.status] || (summary ? "状态未知" : error ? "读取失败" : "正在读取");
  const note = { ready: "接码任务优先使用已准备的号码。", fetching: "正在准备号码，请稍后刷新状态。", available_on_demand: "开始接码后自动获取号码。", unavailable: "当前没有可分配号码，请稍后重试。" }[summary?.status];
  return <div className="sp-choice"><div className="sp-choice-heading"><span className="sp-choice-icon"><PhoneIncoming size={23} /></span><div><h3>接码池</h3><p>自动分配可用号码</p></div><span className={`sp-state ${summary?.enabled && ["ready", "available_on_demand"].includes(summary?.status) ? "sp-state-available" : summary?.status === "fetching" ? "sp-state-probing" : "sp-state-disabled"}`}><i />{status}</span></div><div className="sp-choice-fee"><span>每次验证成功</span><strong>{Number.isSafeInteger(summary?.fee) && summary.fee >= 0 ? summary.fee : "—"}<small> 次</small></strong><p>开始时预留，验证码通过后扣除；明确失败释放预留。</p></div><div className="sp-choice-steps"><span><span>取号与收码</span><small>自动分配可用号码</small></span><ChevronRight size={15} /><span><span>手机验证</span><small>目标服务确认通过</small></span><ChevronRight size={15} /><span><span>完成扣次</span><small>同次重试仅扣一次</small></span></div>{error && <p role="alert" className="sp-error">{error}</p>}<div className="sp-choice-footer"><span>{!summary ? error ? "号码状态未知，请重新读取。" : "正在读取号码状态。" : summary.enabled === false ? "管理员尚未开放接码池。" : note || "号码状态未知，请刷新后重试。"}</span><button type="button" className="text-action" disabled={loading} onClick={() => void refresh()}><RefreshCw size={13} className={loading ? "spin" : ""} />刷新状态</button>{onManage && <button type="button" className="text-action" onClick={onManage}>管理接码池</button>}</div></div>;
}

export function SmsPoolChargeDialog({ quote, onClose }) {
  const fee = quote.admin ? 0 : quote.fee;
  return <DialogForm title="确认使用接码池" confirmation onClose={() => onClose(null)} onSubmit={(event) => { event.preventDefault(); onClose({ id: "pool", config: { quotedFee: quote.fee } }); }} action="确认开始接码"><div className="sp-form-body"><div className="sp-choice-fee"><span>每个账号验证成功扣除</span><strong>{fee}<small> 次</small></strong><p>本次最多 {quote.count} 个账号，最多扣 {quote.count * fee} 次。每个账号实际取号前预留，余额不足时停止取号。</p></div><p className="sp-footnote">只有手机验证码通过才正式扣次。后续授权文件生成失败不退本次接码费用。取号失败或验证未通过将释放预留，结果不明确时等待核实。</p>{quote.admin && <p className="sp-footnote">当前为管理员自己的工作区，本次接码不扣 CDK 次数。</p>}</div></DialogForm>;
}
