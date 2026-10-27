import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, CircleAlert, Clock3, Copy, Globe2, KeyRound, LoaderCircle, Pause, PhoneIncoming, Play, Plus, RefreshCw, Search, Settings2, ShieldCheck, X } from "lucide-react";
import { useDialogFocus } from "./WorkspaceUi.jsx";
import { cdkFetch } from "./cdk-api.mjs";
import "./sms-pool.css";

const platforms = { smsbower: "SMSBower", herosms: "Hero SMS" };
const states = { available: "可用", cooling: "冷却中", disabled: "已停用", credential_error: "凭据异常", probing: "恢复尝试中" };
const settlementNames = { queued: "等待池名额", reserved: "已预留", running: "接码中", requesting: "正在取号", allocated: "已取号", submitted: "验证中", verified: "已扣次", committed: "已扣次", released: "已释放", reconciliation_required: "待核实", uncertain: "待核实", unknown: "待核实" };
const poolErrors = { no_stock: "当前国家和价格暂时无号", auth_invalid: "服务商密钥无效，请更新凭据", balance_insufficient: "服务商余额不足，请充值后恢复", rate_limited: "服务商限流，稍后重试", config_invalid: "报价配置无效，请重新查询", order_unknown: "取号结果待核实", duplicate_phone: "服务商重复返回已有号码，已暂停补号", duplicate_order: "服务商重复返回已有订单，需核实" };
const ruleDefaults = { enabled: false, fee: 2, noStockThreshold: 3, cooldownMinutes: 10, maxAttempts: 10, maxConcurrent: 5 };
const bufferDefaults = { enabled: false, forceRefill: false, target: 3, lowWater: 1, perEntry: 1, refillConcurrency: 1, minRemainingSeconds: 480, idleMinutes: 10, maxOutstanding: 10, maxPerMinute: 6 };
const bufferStates = { ready: "待分配", purchasing: "正在购号", checking: "正在检查", assigned: "接码中", consumed: "已使用", cancel_pending: "回收中", purchase_unknown: "购号待核实", closed: "已结束", quarantined: "需处理" };
const refillStates = { idle: "尚未开始补号", filling: "正在补满库存", waiting: "等待下一轮重试", full: "已补满", paused: "补号已暂停", blocked: "补号需要处理" };
const refillReasons = { no_stock: "本轮报价暂时无号，稍后继续尝试", no_available_entries: "暂无可取号的国家报价", no_entries: "请先添加并启用国家报价", no_sources: "请先添加并启用国家报价", no_usable_entries: "请检查国家报价和服务商凭据", rate_limited: "服务商限流，等待恢复", capacity: "异常订单待处理，暂缓继续购号", risk_limit: "待核实订单达到保护上限，请先处理", inventory_risk_limit: "待核实订单达到保护上限，请先处理", foreground_busy: "正在优先处理接码任务", disabled: "接码池未开放，暂未补号", pool_disabled: "接码池未开放，暂未补号", buffer_disabled: "号码缓冲已停用", buffer_unsupported: "此来源暂不支持预取号码，可继续按需取号", credential_error: "服务商凭据需要处理，请在设置中检查", inventory_checking: "正在核对已取到的号码，稍后继续补号", provider_busy: "服务商正在处理其他取号请求，稍后继续", retry_pending: "本轮尚未补满，5 秒后继续尝试", refill_failed: "本轮补号未完成，请查看补号详情", insufficient_remaining_lifetime: "返回号码的有效期不足，正在回收", price_above_limit: "返回价格超过所选上限，正在回收", inventory_retired_on_arrival: "补号已停止，返回号码正在回收", inventory_unavailable: "返回号码暂不可用，正在处理" };
const bufferErrors = { interrupted_purchase: "购号时服务中断，结果待核实", interrupted_inventory_check: "检查号码时服务中断", inventory_status_unconfirmed: "无法确认号码可分配", inventory_configuration_disabled: "关联配置已停用", cancellation_window_expired: "取消窗口已结束", FREE_CANCELLATION_EXPIRED: "服务商取消期限已过", OTP_RECEIVED: "号码已有短信，需核查取消结果", NEW_OTP_RECEIVED: "号码出现新短信，需核查取消结果", CANCEL_UNSUPPORTED: "服务商暂不支持确认取消", cancel_unconfirmed: "取消结果尚未确认", inventory_retired: "号码不再满足分配条件，正在回收", price_above_limit: "返回价格超过配置上限", administrator_drain: "管理员已请求回收", inventory_assignment_stopped: "分配已停止，正在回收", sms_received_before_assignment: "分配前已收到短信，正在回收", insufficient_remaining_lifetime: "剩余有效期不足" };
const refundNames = { confirmed: "退款已确认", refunded: "退款已确认", unconfirmed: "退款待核实", unknown: "退款待核实", pending: "退款待核实", not_applicable: "不适用", none: "退款待核实" };
const inventoryPhone = (value) => typeof value === "string" && value ? value : "号码未确认";
const maskedOperationPhone = (value) => typeof value === "string" && value ? value.replace(/.(?=.{4})/g, "*") : "号码未确认";
const inventoryState = (row) => row.state === "closed" && row.cancelState === "confirmed" ? "取消已确认" : bufferStates[row.state] || "状态未知";
const normalizeRules = (rules = {}) => ({ ...rules, buffer: { ...bufferDefaults, ...rules.buffer } });
const time = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const optionLabel = (row) => [row.countryLabel, row.title, row.name].find((value) => typeof value === "string" && value.trim()) || `国家 ${row.country}`;
const validInteger = (value, min, max) => String(value ?? "").trim() !== "" && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
const ruleRanges = { fee: [1, 1000000], noStockThreshold: [1, 100], cooldownMinutes: [1, 1440], maxAttempts: [1, 20], maxConcurrent: [1, 20] };
const validBufferRules = (rules) => rules && validInteger(rules.target, 1, 20) && typeof rules.forceRefill === "boolean";
const remainingTime = (value) => { const end = typeof value === "number" ? value : Date.parse(value); if (!Number.isFinite(end)) return "有效期未确认"; const seconds = Math.max(0, Math.ceil((end - Date.now()) / 1000)); return seconds ? `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒` : "已到期"; };
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

function PoolCostSummary({ summary, stale, loading, title = "全部历史服务商成本", description = "按币种记录全部历史已确认购号金额，不受下方筛选影响。取消与退款分别核实，以下金额不代表最终净成本。" }) {
  const knownCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : "—";
  const amount = (value, currency) => costTotalAmount(value) !== null && costCurrency(currency) ? `${value} ${currency}` : "金额未知";
  return <section className={`sp-cost-summary${summary?.byCurrency?.some((row) => row.verifiedPurchaseAmount !== undefined) ? " sp-cost-summary-with-success" : ""}`} aria-label="管理员服务商成本"><div className="sp-cost-heading"><h3>{title}</h3><p>{description}</p></div>{!summary || stale ? <p className="sp-cost-unknown">{loading ? "正在读取成本记录" : stale ? "成本状态未知，请重新读取。" : "成本数据尚未记录。"}</p> : <><div className="sp-cost-currencies">{(Array.isArray(summary.byCurrency) ? summary.byCurrency : []).map((row) => <div className="sp-cost-currency" key={row.currency}><strong>{costCurrency(row.currency) || "币种未知"}</strong><span>已确认购号金额 <b>{amount(row.confirmedPurchaseAmount, row.currency)}</b><small>{knownCount(row.confirmedOrderCount)} 个订单</small></span>{row.verifiedPurchaseAmount !== undefined && <span>验证通过号码金额 <b>{amount(row.verifiedPurchaseAmount, row.currency)}</b><small>{knownCount(row.verifiedOrderCount)} 个已知金额订单</small></span>}<span>退款待核实 <b>{amount(row.refundUnconfirmedAmount, row.currency)}</b><small>{knownCount(row.refundUnconfirmedCount)} 个订单</small></span></div>)}</div><p className="sp-cost-counts"><span>已记录订单 {knownCount(summary.orderCount)}</span><span>金额未知订单 {knownCount(summary.unknownCostCount)}</span><span>币种未知订单 {knownCount(summary.unknownCurrencyCount)}</span>{summary.verifiedCount !== undefined && <><span>成功取号 {knownCount(summary.obtainedCount)}</span><span>验证通过 {knownCount(summary.verifiedCount)}</span><span>通过号码金额未知 {knownCount(summary.unknownVerifiedCostCount)}</span><span>通过号码币种未知 {knownCount(summary.unknownVerifiedCurrencyCount)}</span></>}</p></>}</section>;
}

function OperationCosts({ operation }) {
  const orders = Array.isArray(operation.costOrders) ? operation.costOrders : null;
  const attempts = Number.isSafeInteger(operation.attempts) && operation.attempts >= 0 ? operation.attempts : null;
  return <div className="sp-operation-costs"><SmsOrderCost order={operation} /><small>{attempts === null ? "取号次数未记录" : `取号尝试 ${attempts} 次`}{orders ? `，号码订单 ${orders.length} 个` : ""}</small>{orders?.length > 0 && <details className="sp-cost-orders"><summary>查看每个号码费用</summary><ol>{orders.map((order, index) => <li key={`${order.providerId || "provider"}:${order.orderId || index}`}><div><strong>{order.providerName || platforms[order.providerId] || "服务商未确认"}</strong><span>{maskedOperationPhone(order.phone)}</span>{order.countryLabel && <small>{order.countryLabel}</small>}{order.createdAt && <small>{time(order.createdAt)}</small>}</div><SmsOrderCost order={order} />{(order.refundExpected === true || order.refundStatus === "confirmed") && <small>{order.refundStatus === "confirmed" ? "退款已确认" : "退款待核实"}</small>}</li>)}</ol></details>}</div>;
}

const reportDefaults = { providerId: "", credentialId: "", country: "", currency: "", costStatus: "all", result: "all", state: "all", search: "", startDate: "", endDate: "" };
const countText = (value) => Number.isSafeInteger(value) && value >= 0 ? value : "—";
const countryKey = (row) => row.countryKey || (row.providerId && row.country != null ? `${row.providerId}:${row.country}` : "");
const dateInput = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
function reportQuery(filters) {
  const query = {};
  for (const key of ["providerId", "credentialId", "country", "currency", "costStatus", "result", "state", "search"]) if (filters[key] && filters[key] !== "all") query[key] = filters[key];
  if (filters.startDate) query.start = new Date(`${filters.startDate}T00:00:00`).toISOString();
  if (filters.endDate) { const end = new Date(`${filters.endDate}T00:00:00`); end.setDate(end.getDate() + 1); query.end = end.toISOString(); }
  return query;
}
const invalidReportDates = (filters) => Boolean(filters.startDate && filters.endDate && filters.startDate > filters.endDate);
function StatsMoney({ stats, field = "confirmedPurchaseAmount" }) {
  if (!stats) return <span className="sp-stats-unknown">统计未记录</span>;
  const currencies = (stats.byCurrency || []).filter((row) => costTotalAmount(row[field]) !== null && costCurrency(row.currency));
  return <span className="sp-stats-money">{currencies.length ? currencies.map((row) => <span key={row.currency}>{row[field]} {row.currency}</span>) : <span>无已确认金额</span>}</span>;
}
function EntryStats({ stats }) {
  return <div className="sp-entry-stats" aria-label="累计取号与费用"><div><span>累计购号金额</span><StatsMoney stats={stats} /></div>{stats && <><small>取号 <b>{countText(stats.obtainedCount)}</b> 个 · 验证通过 <b>{countText(stats.verifiedCount)}</b> 个</small>{Number(stats.unknownCostCount) > 0 && <small>金额未知 {stats.unknownCostCount} 个订单</small>}{Number(stats.unknownCurrencyCount) > 0 && <small>币种未知 {stats.unknownCurrencyCount} 个订单</small>}</>}</div>;
}
function ReportFilters({ filters, onChange, options, prefix, operation = false }) {
  const providers = options.providers || []; const credentials = (options.credentials || []).filter((row) => !filters.providerId || row.providerId === filters.providerId);
  const countries = (options.countries || []).filter((row) => !filters.providerId || row.providerId === filters.providerId);
  const update = (patch) => onChange({ ...filters, ...patch });
  const quickDate = (days) => { if (!days) { update({ startDate: "", endDate: "" }); return; } const end = new Date(); const start = new Date(end); start.setDate(start.getDate() - days + 1); update({ startDate: dateInput(start), endDate: dateInput(end) }); };
  return <div className="sp-report-filters" aria-label={`${prefix}筛选`}>
    <div className="sp-filter-grid">
      {operation && <label>账号 / CDK / 号码<input aria-label={`${prefix}搜索`} type="search" value={filters.search} placeholder="搜索邮箱、CDK、任务或号码尾号" onChange={(event) => update({ search: event.target.value })} /></label>}
      <label>服务商<select aria-label={`${prefix}服务商`} value={filters.providerId} onChange={(event) => update({ providerId: event.target.value, credentialId: "", country: "" })}><option value="">全部服务商</option>{providers.map((row) => <option key={row.providerId} value={row.providerId}>{row.name || platforms[row.providerId] || row.providerId}</option>)}</select></label>
      <label>国家<select aria-label={`${prefix}国家`} value={filters.country} onChange={(event) => update({ country: event.target.value })}><option value="">全部国家</option>{countries.map((row) => <option key={countryKey(row)} value={countryKey(row)}>{row.countryLabel || `国家 ${row.country}`} / {platforms[row.providerId] || row.providerId}</option>)}</select></label>
      <label>凭据<select aria-label={`${prefix}凭据`} value={filters.credentialId} onChange={(event) => update({ credentialId: event.target.value })}><option value="">全部凭据</option>{credentials.map((row) => <option key={row.credentialId || row.id} value={row.credentialId || row.id}>{row.name || "服务商凭据"}</option>)}</select></label>
      {operation && <label>结算状态<select aria-label={`${prefix}状态`} value={filters.state} onChange={(event) => update({ state: event.target.value })}><option value="all">全部状态</option>{["reserved", "requesting", "allocated", "submitted", "verified", "released", "unknown"].map((key) => <option key={key} value={key}>{settlementNames[key]}</option>)}</select></label>}
      <label>结果口径<select aria-label={`${prefix}结果`} value={filters.result} onChange={(event) => update({ result: event.target.value })}><option value="all">全部订单</option><option value="obtained">成功取到号码</option><option value="verified">手机验证通过</option><option value="unverified">尚未验证通过</option></select></label>
      <label>金额状态<select aria-label={`${prefix}金额状态`} value={filters.costStatus} onChange={(event) => update({ costStatus: event.target.value })}><option value="all">全部金额状态</option><option value="known">已确认金额和币种</option><option value="unknown">金额或币种未知</option></select></label>
      <label>币种<select aria-label={`${prefix}币种`} value={filters.currency} onChange={(event) => update({ currency: event.target.value })}><option value="">全部币种</option>{(options.currencies || []).map((currency) => <option key={currency} value={currency}>{currency}</option>)}</select></label>
    </div>
    <div className="sp-report-date"><span>{operation ? "操作创建时间" : "购号时间"}</span><label><span className="sr-only">开始日期</span><input type="date" aria-label={`${prefix}开始日期`} value={filters.startDate} onChange={(event) => update({ startDate: event.target.value })} /></label><span>至</span><label><span className="sr-only">结束日期</span><input type="date" aria-label={`${prefix}结束日期`} value={filters.endDate} onChange={(event) => update({ endDate: event.target.value })} /></label><button type="button" className="text-action" onClick={() => quickDate(1)}>今天</button><button type="button" className="text-action" onClick={() => quickDate(7)}>近 7 天</button><button type="button" className="text-action" onClick={() => onChange({ ...reportDefaults })}>清除筛选</button></div>
    {invalidReportDates(filters) && <p className="sp-error" role="alert">开始日期不能晚于结束日期。</p>}
  </div>;
}
function AnalyticsTable({ rows, grouping }) {
  return <div className="table-frame"><table className="sp-analytics-table"><thead><tr><th>{grouping === "provider" ? "服务商" : grouping === "entry" ? "国家报价" : "国家 / 服务商"}</th><th>购号总金额</th><th>验证通过号码金额</th><th>成功取号 / 验证通过</th></tr></thead><tbody>{rows.map((row, index) => { const stats = row.summary || row; const mixedEntry = grouping === "entry" && row.mixedRoutes; const key = grouping === "entry" ? row.entryId : grouping === "provider" ? row.providerId : row.countryKey; return <tr key={`${grouping}:${key || index}`}><td data-label="来源"><strong>{mixedEntry ? "历史多路由" : grouping === "provider" ? row.providerName || row.name || platforms[row.providerId] || row.providerId || "服务商未记录" : row.countryLabel || (row.country ? `国家 ${row.country}` : "国家未记录")}</strong>{grouping !== "provider" && <small>{mixedEntry ? `${countText(row.routeCount)} 条历史路由` : `${row.providerName || platforms[row.providerId] || row.providerId || "服务商未记录"}${row.credentialName ? ` / ${row.credentialName}` : ""}`}</small>}</td><td data-label="购号总金额"><StatsMoney stats={stats} />{Number(stats.unknownCostCount) > 0 && <small>金额未知 {stats.unknownCostCount} 个</small>}{Number(stats.unknownCurrencyCount) > 0 && <small>币种未知 {stats.unknownCurrencyCount} 个</small>}</td><td data-label="验证通过号码金额"><StatsMoney stats={stats} field="verifiedPurchaseAmount" />{Number(stats.unknownVerifiedCostCount) > 0 && <small>通过号码金额未知 {stats.unknownVerifiedCostCount} 个</small>}{Number(stats.unknownVerifiedCurrencyCount) > 0 && <small>通过号码币种未知 {stats.unknownVerifiedCurrencyCount} 个</small>}</td><td data-label="成功取号 / 验证通过"><strong>{countText(stats.obtainedCount)} / {countText(stats.verifiedCount)}</strong><small>个号码</small></td></tr>; })}</tbody></table>{!rows.length && <div className="sp-empty"><Clock3 size={23} /><h3>当前范围没有购号记录</h3><p>调整国家、服务商或日期筛选。</p></div>}</div>;
}

export default function SmsPoolWorkspace({ token, api }) {
  const request = useCallback((path = "", method = "GET", body) => api ? api(path, method, body) : smsPoolRequest(token, path, method, body), [api, token]);
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [tab, setTab] = useState("buffer");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [entryFilters, setEntryFilters] = useState({ providerId: "", credentialId: "", country: "", obtained: "all", minPrice: "", maxPrice: "" });
  const [bufferFilters, setBufferFilters] = useState({ scope: "current", state: "", providerId: "", country: "", search: "", costStatus: "all", refundStatus: "" });
  const [inventoryPage, setInventoryPage] = useState(1);
  const [inventory, setInventory] = useState(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState("");
  const [inventoryAttempt, setInventoryAttempt] = useState(0);
  const [operationFilters, setOperationFilters] = useState(reportDefaults);
  const [analyticsFilters, setAnalyticsFilters] = useState(reportDefaults);
  const [reportOptions, setReportOptions] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState("");
  const [analyticsAttempt, setAnalyticsAttempt] = useState(0);
  const [grouping, setGrouping] = useState("country");
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
  const settingsEdited = useRef(false);
  const refreshVersion = useRef(0);
  const lastInventoryQuery = useRef("");
  const operationDatesInvalid = invalidReportDates(operationFilters);
  const analyticsDatesInvalid = invalidReportDates(analyticsFilters);
  const operationQuery = operationDatesInvalid ? "" : new URLSearchParams(reportQuery(operationFilters)).toString();
  const analyticsQuery = analyticsDatesInvalid ? "" : new URLSearchParams(reportQuery(analyticsFilters)).toString();
  const inventoryQuery = new URLSearchParams({ ...bufferFilters, page: String(inventoryPage), pageSize: "20" }).toString();
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try { const value = await request(); if (mounted.current && version === refreshVersion.current) { setData(value); if (value.analyticsFilterOptions) setReportOptions(value.analyticsFilterOptions); setDraft((previous) => draftEdited.current ? previous : normalizeRules(value.rules)); setStale(false); setError(""); return true; } }
    catch (failure) { if (mounted.current && version === refreshVersion.current) { setStale(true); setError(failure.message); } }
    return false;
  }, [request]);
  useEffect(() => { mounted.current = true; draftEdited.current = false; settingsEdited.current = false; setData(null); setDraft(null); setReportOptions(null); void refresh(); return () => { mounted.current = false; refreshVersion.current++; }; }, [refresh]);
  useEffect(() => {
    if (tab !== "buffer") return undefined;
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [tab, refresh]);
  useEffect(() => {
    if (tab !== "buffer" || !data) return undefined;
    let active = true; setInventoryLoading(true); setInventoryError("");
    if (lastInventoryQuery.current !== inventoryQuery) { setInventory(null); lastInventoryQuery.current = inventoryQuery; }
    void request(`/inventory?${inventoryQuery}`).then((value) => {
      if (!active) return;
      if (Array.isArray(value.items)) setInventory(value);
      else {
        const rows = (data.buffer?.items || []).filter((row) => Boolean(row.phone) && (bufferFilters.scope === "all" || (bufferFilters.scope === "history" ? ["closed", "consumed"].includes(row.state) : !["closed", "consumed"].includes(row.state)))
          && (!bufferFilters.state || row.state === bufferFilters.state) && (!bufferFilters.providerId || row.providerId === bufferFilters.providerId) && (!bufferFilters.country || `${row.providerId}:${row.country}` === bufferFilters.country)
          && (!bufferFilters.search || `${row.phone || ""} ${row.countryLabel || ""}`.toLocaleLowerCase().includes(bufferFilters.search.toLocaleLowerCase()))
          && (!bufferFilters.refundStatus || row.refundStatus === bufferFilters.refundStatus) && (bufferFilters.costStatus === "all" || (row.cost?.source === "order" && costAmount(row.cost.amount) !== null && costCurrency(row.cost.currency) ? "known" : "unknown") === bufferFilters.costStatus));
        setInventory({ items: rows.slice((inventoryPage - 1) * 20, inventoryPage * 20), total: rows.length, page: inventoryPage, pages: Math.max(1, Math.ceil(rows.length / 20)) });
      }
    }).catch((failure) => { if (active) setInventoryError(failure.message); }).finally(() => { if (active) setInventoryLoading(false); });
    return () => { active = false; };
  }, [tab, inventoryQuery, request, data, inventoryAttempt]);
  useEffect(() => {
    if (tab !== "operations" || !data) return undefined;
    if (invalidReportDates(operationFilters)) { setOperationHistory(null); setHistoryLoading(false); setHistoryError(""); return undefined; }
    let active = true; setHistoryLoading(true); setHistoryError("");
    setOperationHistory(null);
    void request(`/operations?page=${operationPage}&pageSize=20${operationQuery ? `&${operationQuery}` : ""}`).then((value) => {
      if (!active) return;
      if (Array.isArray(value.items)) { setOperationHistory(value); if (value.filterOptions) setReportOptions(value.filterOptions); }
      else { const rows = data.operations || []; setOperationHistory({ items: rows.slice((operationPage - 1) * 20, operationPage * 20), page: operationPage, pages: Math.max(1, Math.ceil(rows.length / 20)), total: rows.length }); }
    }).catch((failure) => { if (active) { setHistoryError(failure.message); setOperationHistory(null); } }).finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [tab, operationPage, operationQuery, operationDatesInvalid, request, data, historyAttempt]);
  useEffect(() => {
    if (tab !== "analytics" || !data) return undefined;
    setAnalytics(null); setAnalyticsError("");
    if (invalidReportDates(analyticsFilters)) { setAnalyticsLoading(false); return undefined; }
    let active = true; setAnalyticsLoading(true);
    void request(`/analytics${analyticsQuery ? `?${analyticsQuery}` : ""}`).then((value) => {
      if (!active) return;
      if (!value?.summary || !Array.isArray(value.byEntry) || !Array.isArray(value.byProvider) || !Array.isArray(value.byCountry)) throw new Error("成本统计尚未记录，请刷新后重试。");
      setAnalytics(value); if (value.filterOptions) setReportOptions(value.filterOptions);
    }).catch((failure) => { if (active) setAnalyticsError(failure.message); }).finally(() => { if (active) setAnalyticsLoading(false); });
    return () => { active = false; };
  }, [tab, analyticsQuery, analyticsDatesInvalid, request, data, analyticsAttempt]);
  const updateDraft = (patch) => { draftEdited.current = true; settingsEdited.current = true; setDraft((previous) => ({ ...previous, ...patch })); };
  const updateBufferDraft = (patch) => { draftEdited.current = true; setDraft((previous) => ({ ...previous, buffer: { ...previous.buffer, ...patch } })); };
  async function perform(key, action, message) {
    if (busy) return;
    setBusy(key); setError(""); setNotice("");
    try { await action(); const refreshed = await refresh(); if (message && refreshed) setNotice(message); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(""); }
  }
  async function saveRules(bufferOnly = false) {
    const bufferRules = { enabled: true, forceRefill: Boolean(draft.buffer.forceRefill), target: Number(draft.buffer.target) };
    const submitted = { ...draft, fee: Number(draft.fee), noStockThreshold: Number(draft.noStockThreshold), cooldownMinutes: Number(draft.cooldownMinutes),
      maxAttempts: Number(draft.maxAttempts), maxConcurrent: Number(draft.maxConcurrent),
      buffer: bufferRules };
    const saved = await request("/rules", "PUT", bufferOnly ? { buffer: bufferRules } : submitted);
    const confirmedForceRefill = saved?.rules?.buffer?.forceRefill;
    if (bufferRules.forceRefill && confirmedForceRefill !== true) throw new Error("后台尚未加载自动补满更新，请重启服务后重试。当前设置已保留，尚未确认保存成功。");
    if (!bufferRules.forceRefill && confirmedForceRefill !== undefined && confirmedForceRefill !== false) throw new Error("后台未确认关闭自动补满，请刷新后重试。当前设置已保留。");
    if (Number(saved?.rules?.buffer?.target) !== bufferRules.target) throw new Error("后台未确认缓冲目标数量，请重试。当前设置已保留。");
    if (bufferOnly) {
      setDraft((previous) => ({ ...previous, buffer: normalizeRules(saved.rules).buffer }));
      draftEdited.current = settingsEdited.current;
    } else { draftEdited.current = false; settingsEdited.current = false; }
  }
  const updateInventoryFilters = (patch) => { setInventoryPage(1); setBufferFilters((value) => ({ ...value, ...patch })); };
  async function copyPhone(row) {
    if (!/^\+[1-9]\d{6,14}$/.test(row.phone || "")) return;
    try { await navigator.clipboard.writeText(row.phone); setNotice("号码已复制"); }
    catch { setError("复制失败，请直接选中号码复制。"); }
  }
  const rules = data?.rules || ruleDefaults;
  const entries = data?.entries || [];
  const credentials = data?.credentials || [];
  const operations = data?.operations || [];
  const buffer = stale ? null : data?.buffer;
  const emptyBufferMessage = buffer?.rules?.forceRefill ? "自动补满已开启，后台会从已启用的国家报价持续补号。" : "添加国家报价后，点击立即补满，或开启自动补满。";
  const bufferCount = (key) => Number.isSafeInteger(buffer?.counts?.[key]) ? buffer.counts[key] : "—";
  const operationRows = operationHistory?.items || [];
  const pending = operations.filter((row) => ["reconciliation_required", "uncertain", "unknown"].includes(row.status || row.state));
  const matching = entries.filter((row) => (filter === "all" || row.state === filter) && (!entryFilters.providerId || row.providerId === entryFilters.providerId) && (!entryFilters.credentialId || row.credentialId === entryFilters.credentialId) && (!entryFilters.country || countryKey(row) === entryFilters.country) && (entryFilters.obtained === "all" || row.stats && (entryFilters.obtained === "yes" ? row.stats.obtainedCount > 0 : row.stats.obtainedCount === 0)) && (!entryFilters.minPrice || Number(row.maxPrice) >= Number(entryFilters.minPrice)) && (!entryFilters.maxPrice || Number(row.maxPrice) <= Number(entryFilters.maxPrice)) && `${row.countryLabel} ${row.country} ${platforms[row.providerId]} ${row.credentialName || ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim()));
  const providerOptions = [...new Set([...credentials.map((row) => row.providerId), ...entries.map((row) => row.providerId)].filter(Boolean))].map((providerId) => ({ providerId, name: platforms[providerId] || providerId }));
  const fallbackOptions = { providers: providerOptions, credentials: credentials.map((row) => ({ ...row, credentialId: row.id })), countries: [...new Map(entries.filter((row) => countryKey(row)).map((row) => [countryKey(row), { countryKey: countryKey(row), country: row.country, countryLabel: row.countryLabel, providerId: row.providerId }])).values()], currencies: [...new Set(entries.map((row) => row.currency).filter(Boolean))] };
  const filterOptions = reportOptions || data?.analyticsFilterOptions || data?.analytics?.filterOptions || fallbackOptions;
  const matchingBuffer = inventory?.items || [];
  const progress = stale ? null : buffer?.progress;
  const progressReady = progress?.ready ?? buffer?.counts?.ready;
  const progressPurchasing = progress ? Number(progress.purchasing || 0) + Number(progress.checking || 0) : Number.isSafeInteger(buffer?.counts?.purchasing) ? buffer.counts.purchasing + (buffer.counts.checking || 0) : null;
  const progressTarget = progress?.target ?? buffer?.rules?.target ?? rules.buffer?.target;
  const progressMissing = progress?.remaining ?? (Number.isSafeInteger(progressReady) && Number.isSafeInteger(progressTarget) && progressPurchasing !== null ? Math.max(0, progressTarget - progressReady - progressPurchasing) : null);
  const progressFailures = Array.isArray(progress?.failures) ? progress.failures : [];
  const pendingInventory = (buffer?.items || []).filter((row) => row.canReconcile && !row.phone);
  const canSaveBuffer = validBufferRules(draft?.buffer);
  const groupedRows = analytics ? grouping === "provider" ? analytics.byProvider : grouping === "entry" ? analytics.byEntry : analytics.byCountry : [];
  const canSave = draft && typeof draft.enabled === "boolean" && Object.entries(ruleRanges).every(([key, [min, max]]) => validInteger(draft[key], min, max)) && validBufferRules(draft.buffer);
  return <section className="workspace sp-workspace" aria-labelledby="sp-title">
    <header className="sp-heading"><div><h2 id="sp-title">接码池</h2><p>加入国家报价，按目标数量补满，直接查看号码和取号结果。</p></div><div className="sp-heading-actions"><button className="secondary-button" onClick={() => void perform("refresh", async () => {})} disabled={Boolean(busy)}><RefreshCw size={15} />刷新</button><button className="primary-button" onClick={() => setDialog({ kind: "entry" })} disabled={!data || !credentials.some((row) => row.enabled)}><Plus size={16} />添加国家报价</button></div></header>
    <div className="sp-pool-status"><span className={`sp-state ${stale ? "sp-state-credential_error" : rules.enabled ? "sp-state-available" : "sp-state-disabled"}`}><i />{!data || stale ? error ? "读取失败" : "正在读取接码池" : rules.enabled ? "接码池已开放" : "接码池已关闭"}</span><span>{data && !stale ? `${entries.filter((row) => row.state === "available").length} 个可用条目` : "可用条目未知"}</span><span>{data && !stale ? `${entries.filter((row) => row.state === "cooling").length} 个冷却中` : "正在读取规则"}</span><span className="sp-pool-fee">验证成功扣 <strong>{data && !stale ? rules.fee : "—"}</strong> 次</span></div>
    {tab !== "buffer" && <PoolCostSummary summary={data?.costSummary} stale={stale} loading={!data && !error} />}
    {error && <div className="sp-feedback sp-error" role="alert"><CircleAlert size={16} /><span>{error}</span><button className="text-action" onClick={() => void refresh()}>重新读取</button></div>}
    {notice && <div className="sp-feedback sp-success" role="status"><Check size={16} />{notice}</div>}
    {!data && !error && <div className="sp-empty" role="status"><LoaderCircle className="spin" size={22} /><p>正在读取接码池</p></div>}
    {data && <div className={`sp-layout${tab === "credentials" ? "" : " sp-layout-wide"}`}><div className="sp-main">
      <nav className="sp-tabs" aria-label="接码池内容">{[["buffer", "号码库存", Number.isSafeInteger(buffer?.counts?.ready) ? buffer.counts.ready : undefined], ["entries", "国家报价", entries.length], ["operations", "接码记录", operationHistory?.total], ["analytics", "成本统计"], ["credentials", "设置"]].map(([value, label, count]) => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}{count !== undefined && <span>{count}</span>}</button>)}</nav>
      {tab === "entries" && <>
        <div className="sp-list-tools"><label className="sp-search"><Search size={16} /><input aria-label="搜索池内国家或服务商" placeholder="搜索国家、服务商" value={search} onChange={(event) => setSearch(event.target.value)} /></label><select aria-label="筛选接码池条目状态" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部状态</option>{Object.entries(states).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></div>
        <div className="sp-entry-filter-grid" aria-label="国家报价筛选">
          <label>服务商<select aria-label="报价服务商" value={entryFilters.providerId} onChange={(event) => setEntryFilters((previous) => ({ ...previous, providerId: event.target.value, country: "", credentialId: "" }))}><option value="">全部服务商</option>{providerOptions.map((row) => <option key={row.providerId} value={row.providerId}>{row.name}</option>)}</select></label>
          <label>国家<select aria-label="报价国家" value={entryFilters.country} onChange={(event) => setEntryFilters((previous) => ({ ...previous, country: event.target.value }))}><option value="">全部国家</option>{fallbackOptions.countries.filter((row) => !entryFilters.providerId || row.providerId === entryFilters.providerId).map((row) => <option key={row.countryKey} value={row.countryKey}>{row.countryLabel || `国家 ${row.country}`} / {platforms[row.providerId] || row.providerId}</option>)}</select></label>
          <label>凭据<select aria-label="报价凭据" value={entryFilters.credentialId} onChange={(event) => setEntryFilters((previous) => ({ ...previous, credentialId: event.target.value }))}><option value="">全部凭据</option>{credentials.filter((row) => !entryFilters.providerId || row.providerId === entryFilters.providerId).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
          <label>取号记录<select aria-label="报价取号记录" value={entryFilters.obtained} onChange={(event) => setEntryFilters((previous) => ({ ...previous, obtained: event.target.value }))}><option value="all">全部取号记录</option><option value="yes">已成功取号</option><option value="no">尚未成功取号</option></select></label>
          <label>价格上限从<input type="number" min="0" step="any" aria-label="报价最低价格上限" value={entryFilters.minPrice} onChange={(event) => setEntryFilters((previous) => ({ ...previous, minPrice: event.target.value }))} placeholder="不限" /></label>
          <label>价格上限至<input type="number" min="0" step="any" aria-label="报价最高价格上限" value={entryFilters.maxPrice} onChange={(event) => setEntryFilters((previous) => ({ ...previous, maxPrice: event.target.value }))} placeholder="不限" /></label>
          <button type="button" className="text-action" onClick={() => { setEntryFilters({ providerId: "", credentialId: "", country: "", obtained: "all", minPrice: "", maxPrice: "" }); setSearch(""); setFilter("all"); }}>清除报价筛选</button>
        </div>
        <div className="sp-filter-caption"><span>显示 {matching.length} / {entries.length} 条报价</span><span>以下金额与取号数为每条当前报价的累计记录</span></div>
        <div className="table-frame sp-table-frame"><table className="sp-entry-table"><thead><tr><th>国家 / 服务商</th><th className="sp-price-column">价格上限</th><th>状态</th><th className="sp-priority-column">优先级</th><th>操作</th></tr></thead><tbody>{matching.map((row) => <tr key={row.id}>
          <td data-label="国家 / 服务商"><div className="sp-country"><span className="sp-country-icon"><Globe2 size={18} /></span><div><strong>{row.countryLabel || `国家 ${row.country}`}</strong><small>{platforms[row.providerId] || row.providerId} / {row.credentialName || credentials.find((item) => item.id === row.credentialId)?.name || "服务商凭据"}</small></div></div><EntryStats stats={stale ? null : row.stats} /></td>
          <td data-label="价格上限" className="sp-price"><strong>{row.maxPrice}</strong><small>{row.currency || "平台币种"}</small></td>
          <td data-label="状态"><State value={row.state} /><small>{row.state === "cooling" ? `${time(Math.max(Number(row.cooldownUntil) || 0, Number(row.credentialCooldownUntil) || 0))} 后尝试恢复` : poolErrors[row.lastError] || row.lastError || (row.noStockCount ? `连续无号 ${row.noStockCount} 次` : "取号成功后自动收码")}</small></td>
          <td data-label="优先级" className="sp-priority"><span>{row.priority}</span></td>
          <td data-label="操作"><div className="sp-row-actions"><button className="text-action" aria-label={`编辑 ${row.countryLabel || row.country}`} onClick={() => setDialog({ kind: "edit", row })}>编辑</button><button className="text-action" disabled={Boolean(busy)} onClick={() => void perform(row.id, () => request(`/entries/${row.id}`, "PATCH", { enabled: row.state === "disabled" || row.enabled === false, ...(row.state === "cooling" ? { resetCooldown: true, enabled: true } : {}) }), row.state === "cooling" ? "已取消冷却，下次真实任务将尝试取号" : row.state === "disabled" ? "条目已启用" : "条目已停用")}>{row.state === "disabled" ? <Play size={13} /> : row.state === "cooling" ? <RefreshCw size={13} /> : <Pause size={13} />}{row.state === "disabled" ? "启用" : row.state === "cooling" ? "恢复" : "停用"}</button></div></td>
        </tr>)}</tbody></table>{!matching.length && <div className="sp-empty"><Globe2 size={25} /><h3>{entries.length ? "没有匹配的国家报价" : "添加第一条国家报价"}</h3><p>{entries.length ? "调整搜索、国家、服务商或价格筛选。" : "先保存服务商凭据，再查询国家和价格加入池。"}</p><button className="secondary-button" onClick={() => setDialog({ kind: credentials.length ? "entry" : "credential" })}><Plus size={15} />{credentials.length ? "添加国家报价" : "添加服务商凭据"}</button></div>}</div>
        <p className="sp-footnote">已启用报价都会参与补号，轮流尝试直到补满；同一报价可连续提供多个号码。优先级仅用于即时取号，购号不超过所选价格上限。</p>
      </>}
      {tab === "credentials" && <><div className="sp-list-caption"><p>密钥仅用于后台取号，普通 CDK 无法查看。</p><button className="secondary-button" onClick={() => setDialog({ kind: "credential" })}><Plus size={15} />添加凭据</button></div><div className="sp-credentials">{credentials.map((row) => <div className="sp-credential-row" key={row.id}><span className="sp-country-icon"><KeyRound size={18} /></span><div><strong>{row.name}</strong><small>{platforms[row.providerId]} / {row.hasApiKey ? "密钥已保存" : "未配置密钥"}</small>{row.blockedReason && <small className="sp-credential-error">{poolErrors[row.blockedReason] || "凭据异常，请编辑后恢复"}</small>}</div><EntryStats stats={stale ? null : row.stats} /><State value={!row.enabled ? "disabled" : row.blockedReason ? "credential_error" : row.cooldownUntil > Date.now() ? "cooling" : "available"} /><div className="sp-credential-actions"><button className="text-action" disabled={Boolean(busy)} onClick={() => setDialog({ kind: "credential", row })}>{row.blockedReason === "auth_invalid" ? "更新密钥" : "编辑"}</button>{row.enabled && row.blockedReason === "balance_insufficient" && <button className="text-action" disabled={Boolean(busy)} onClick={() => void perform(row.id, () => request("/credentials", "POST", { id: row.id, providerId: row.providerId, name: row.name, enabled: true, resetCooldown: true }), "凭据已恢复，下次真实任务将重新取号")}>充值后恢复</button>}</div></div>)}{!credentials.length && <div className="sp-empty"><KeyRound size={25} /><h3>还没有服务商凭据</h3><p>添加 SMSBower 或 Hero SMS 后即可查询报价。</p><button className="primary-button" onClick={() => setDialog({ kind: "credential" })}>添加服务商凭据</button></div>}</div></>}
      {tab === "operations" && <><ReportFilters prefix="接码记录" filters={operationFilters} onChange={(value) => { setOperationFilters(value); setOperationPage(1); }} options={filterOptions} operation /><div className="sp-list-caption"><p>接码服务费与新增账号导入费分别记录。</p>{pending.length > 0 && <span className="sp-pending-count"><Clock3 size={14} />{pending.length} 条待核实</span>}</div><div className="table-frame"><table className="sp-operation-table"><thead><tr><th>账号 / CDK</th><th>结算状态</th><th>CDK 扣次</th><th>服务商费用</th><th>时间 / 操作</th></tr></thead><tbody>{operationRows.map((row) => <tr key={`${row.cdkId || row.ownerCdkId || "admin"}:${row.id || row.operationId}`}><td data-label="账号"><strong>{row.email || row.accountEmail}</strong><small>{row.cdkLabel || row.ownerCdkId || "管理员工作区"}</small></td><td data-label="结算状态"><span className={`sp-settlement sp-settlement-${row.status || row.state}`}>{settlementNames[row.status || row.state] || row.status || row.state}</span><small>{poolErrors[row.reason || row.lastError] || row.reason || row.lastError}</small></td><td data-label="CDK 扣次" className="sp-price">{row.fee ?? row.feeSnapshot ?? "—"} 次</td><td data-label="服务商费用"><OperationCosts operation={row} /></td><td data-label="时间"><small>{time(row.createdAt)}</small>{["reconciliation_required", "uncertain", "unknown"].includes(row.status || row.state) && <button className="text-action" onClick={() => setDialog({ kind: "reconcile", row })} disabled={Boolean(busy) || historyLoading}>核实处理</button>}</td></tr>)}</tbody></table>{!operationRows.length && !historyLoading && !historyError && <div className="sp-empty"><Clock3 size={25} /><h3>还没有池接码记录</h3><p>用户选择接码池后，本页记录预留、扣次和释放结果。</p></div>}{historyLoading && <p className="sp-history-status" role="status">正在读取接码记录</p>}{historyError && <div className="sp-feedback sp-error" role="alert"><span>{historyError}</span><button className="text-action" onClick={() => setHistoryAttempt((value) => value + 1)}>重新读取记录</button></div>}</div>{operationHistory && <nav className="sp-history-pagination" aria-label="接码记录分页"><span>共 {operationHistory.total} 条记录</span><div><button className="secondary-button" disabled={historyLoading || operationPage <= 1} onClick={() => setOperationPage((value) => value - 1)}>上一页</button><span>{operationHistory.page} / {operationHistory.pages}</span><button className="secondary-button" disabled={historyLoading || operationPage >= operationHistory.pages} onClick={() => setOperationPage((value) => value + 1)}>下一页</button></div></nav>}</>}
      {tab === "analytics" && <section className="sp-analytics" aria-labelledby="sp-analytics-title">
        <div className="sp-analytics-heading"><div><h3 id="sp-analytics-title">接码成本统计</h3><p>按购号时间筛选，成功指目标服务确认手机验证码通过。缓冲分配与任务中的同一订单只统计一次。</p></div><button className="text-action" onClick={() => setAnalyticsAttempt((value) => value + 1)} disabled={analyticsLoading}><RefreshCw size={14} />刷新统计</button></div>
        <ReportFilters prefix="成本统计" filters={analyticsFilters} onChange={setAnalyticsFilters} options={filterOptions} />
        {analyticsLoading && <p className="sp-history-status" role="status">正在读取全量成本统计</p>}
        {analyticsError && <div className="sp-feedback sp-error" role="alert"><span>{analyticsError}</span><button className="text-action" onClick={() => setAnalyticsAttempt((value) => value + 1)}>重新读取统计</button></div>}
        {analytics && !analyticsLoading && <><div className="sp-analytics-counts" aria-label="筛选范围取号统计"><div><span>成功取到号码</span><strong>{countText(analytics.summary.obtainedCount)}<small> 个</small></strong></div><div><span>手机验证通过</span><strong>{countText(analytics.summary.verifiedCount)}<small> 个</small></strong></div><div><span>成功号码金额未知</span><strong>{countText(analytics.summary.unknownVerifiedCostCount)}<small> 个</small></strong></div></div><PoolCostSummary summary={analytics.summary} title="筛选范围服务商成本" description="仅统计当前筛选范围内的购号记录。取消与退款分别核实，以下金额不代表最终净成本。" /><p className="sp-footnote">验证通过号码金额只累计最终通过的号码订单；其他换号、回收和未验证订单保留在购号总金额。金额未知不按 0 计算，不同币种不合并。</p><div className="sp-analytics-groups" aria-label="成本统计分组">{[["country", "按国家"], ["provider", "按服务商"], ["entry", "按报价条目"]].map(([key, label]) => <button key={key} type="button" aria-pressed={grouping === key} onClick={() => setGrouping(key)}>{label}</button>)}</div><AnalyticsTable rows={groupedRows} grouping={grouping} /></>}
        {!analytics && !analyticsLoading && !analyticsError && !invalidReportDates(analyticsFilters) && <p className="sp-history-status">成本统计尚未记录。</p>}
      </section>}
      {tab === "buffer" && <section className="sp-buffer" aria-labelledby="sp-buffer-title">
        <div className="sp-buffer-heading"><div><h3 id="sp-buffer-title" className="sr-only">号码库存</h3><p>已启用报价轮流取号，补满即停。</p></div><span className={`sp-state ${progress?.state === "blocked" ? "sp-state-credential_error" : progress?.state === "full" ? "sp-state-available" : ""}`}><i />{!buffer ? "状态未知" : progress ? refillStates[progress.state] || "补号状态待确认" : buffer.refilling ? "正在补号" : "补号状态待确认"}</span></div>
        <form className="sp-buffer-controls" onSubmit={(event) => { event.preventDefault(); if (canSaveBuffer && !busy) void perform("bufferRules", () => saveRules(true), "补号设置已保存"); }}>
          <label className="sp-toggle-row"><span><strong>自动补满</strong><small>号码被使用后自动补足；暂时无号时每 5 秒重试</small></span><input type="checkbox" role="switch" aria-label="自动补满号码" disabled={Boolean(busy)} checked={Boolean(draft?.buffer?.forceRefill)} onChange={(event) => updateBufferDraft({ enabled: true, forceRefill: event.target.checked })} /></label>
          <label className="sp-number-field"><span>缓冲目标</span><div><input type="number" min="1" max="20" required aria-label="缓冲目标数量" disabled={Boolean(busy)} value={draft?.buffer?.target ?? ""} onChange={(event) => updateBufferDraft({ enabled: true, target: event.target.value })} /><span>个号码</span></div></label>
          <button className="secondary-button" disabled={!canSaveBuffer || Boolean(busy)}>{busy === "bufferRules" && <LoaderCircle size={15} className="spin" />}保存补号设置</button>
          {draft?.buffer && !canSaveBuffer && <p className="sp-error" role="alert">缓冲目标请填写 1 至 20 的整数。</p>}
        </form>
        <div className="sp-buffer-overview"><div className="sp-buffer-counts" aria-label="缓冲库存统计"><div><span>可用</span><strong>{Number.isSafeInteger(progressReady) ? progressReady : "—"} / {Number.isSafeInteger(progressTarget) ? progressTarget : "—"}</strong></div><div><span>取号中</span><strong>{progressPurchasing ?? "—"}</strong></div><div><span>待补</span><strong>{progressMissing ?? "—"}</strong></div><div><span>接码中</span><strong>{bufferCount("assigned")}</strong></div></div>
        <div className="sp-buffer-actions"><button type="button" className="primary-button" disabled={Boolean(busy) || !data || stale || !rules.enabled || !canSaveBuffer} onClick={() => void perform("warmup", async () => { await saveRules(true); await request("/buffer/warmup", "POST", {}); }, "补满任务已启动，可在此查看进度")}><Plus size={15} />立即补满</button><button type="button" className="secondary-button" disabled={Boolean(busy) || !buffer} onClick={() => void perform("pause", () => request("/buffer/pause", "POST", {}), "补号已暂停，已有号码继续保留")}><Pause size={15} />暂停补号</button><button type="button" className="text-action" disabled={Boolean(busy) || !buffer} onClick={() => void perform("drain", () => request("/buffer/drain", "POST", {}), "已暂停自动补满并请求回收未分配号码，请查看取消结果")}>回收未分配号码</button></div></div>
        {progress?.reason && <div className="sp-refill-summary" role="status"><span>{refillReasons[progress.reason] || poolErrors[progress.reason] || "正在等待服务商恢复，请查看补号详情。"}</span>{progress.nextRetryAt && <small>下次尝试 {time(progress.nextRetryAt)}</small>}</div>}
        {progressFailures.length > 0 && <details className="sp-refill-details"><summary>查看补号详情 · {progressFailures.length} 条来源记录</summary><ul>{progressFailures.map((failure, index) => <li key={`${failure.entryId || index}:${failure.kind}`}><span>{failure.countryLabel || "国家未记录"} / {platforms[failure.providerId] || "服务商未记录"}</span><span>{poolErrors[failure.kind] || refillReasons[failure.kind] || "取号未完成，请检查来源配置"}{Number.isSafeInteger(failure.count) && ` · ${failure.count} 次`}</span>{failure.lastAt && <small>最近尝试 {time(failure.lastAt)}</small>}</li>)}</ul></details>}
        {pendingInventory.length > 0 && <details className="sp-refill-details sp-pending-inventory"><summary>待处理订单 {pendingInventory.length}</summary><ul>{pendingInventory.map((row) => <li key={row.id}><span>{row.countryLabel || "国家未记录"} / {platforms[row.providerId] || "服务商未记录"}</span><span>{poolErrors[row.lastError] || bufferErrors[row.lastError] || "购号结果待核实，未确认号码"}</span><button type="button" className="text-action" disabled={Boolean(busy)} onClick={() => setDialog({ kind: "inventory", row })}>核实订单</button></li>)}</ul></details>}
        <div className="sp-inventory-toolbar">
        <div className="sp-inventory-scopes" aria-label="库存范围">{[["current", "当前号码"], ["history", "历史号码"], ["all", "全部号码"]].map(([value, label]) => <button key={value} type="button" aria-pressed={bufferFilters.scope === value} onClick={() => updateInventoryFilters({ scope: value, state: "" })}>{label}</button>)}</div>
        <div className="sp-inventory-tools"><label className="sp-search"><Search size={16} /><input aria-label="搜索库存号码或国家" placeholder="搜索号码、国家" value={bufferFilters.search} onChange={(event) => updateInventoryFilters({ search: event.target.value })} /></label><label>状态<select aria-label="缓冲库存状态" value={bufferFilters.state} onChange={(event) => updateInventoryFilters({ state: event.target.value })}><option value="">全部状态</option>{Object.entries(bufferStates).filter(([key]) => !["purchasing"].includes(key)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
        </div>
        <details className="sp-inventory-more"><summary>更多筛选</summary><div className="sp-entry-filter-grid sp-buffer-filters" aria-label="号码库存筛选">
          <label>服务商<select aria-label="缓冲服务商" value={bufferFilters.providerId} onChange={(event) => updateInventoryFilters({ providerId: event.target.value })}><option value="">全部服务商</option>{providerOptions.map((row) => <option key={row.providerId} value={row.providerId}>{row.name}</option>)}</select></label>
          <label>国家<select aria-label="缓冲国家" value={bufferFilters.country} onChange={(event) => updateInventoryFilters({ country: event.target.value })}><option value="">全部国家</option>{(filterOptions.countries || []).map((row) => <option key={row.countryKey} value={row.countryKey}>{row.countryLabel || row.country} / {platforms[row.providerId]}</option>)}</select></label>
          <label>金额状态<select aria-label="缓冲金额状态" value={bufferFilters.costStatus} onChange={(event) => updateInventoryFilters({ costStatus: event.target.value })}><option value="all">全部金额状态</option><option value="known">已确认金额和币种</option><option value="unknown">金额或币种未知</option></select></label>
          <label>退款状态<select aria-label="缓冲退款状态" value={bufferFilters.refundStatus} onChange={(event) => updateInventoryFilters({ refundStatus: event.target.value })}><option value="">全部退款状态</option><option value="confirmed">退款已确认</option><option value="unconfirmed">退款待核实</option></select></label>
        </div><button type="button" className="text-action" onClick={() => updateInventoryFilters({ state: "", providerId: "", country: "", search: "", costStatus: "all", refundStatus: "" })}>清除库存筛选</button></details>
        {inventoryError && <div className="sp-feedback sp-error" role="alert"><span>{inventoryError}</span><button className="text-action" onClick={() => setInventoryAttempt((value) => value + 1)}>重新读取库存</button></div>}
        <p className="sp-filter-caption">共 {inventory?.total ?? "—"} 个号码{inventoryLoading ? "，正在读取" : ""}；已分配号码单独显示，不占可用缓冲目标。</p>
        <div className="table-frame sp-buffer-table-frame"><table className="sp-buffer-table"><thead><tr><th>号码</th><th>国家 / 服务商</th><th>价格</th><th>状态</th><th>剩余有效期</th><th>操作</th></tr></thead><tbody>{matchingBuffer.map((row) => <tr key={row.id}>
          <td data-label="号码"><div className="sp-inventory-number"><strong>{inventoryPhone(row.phone)}</strong>{/^\+[1-9]\d{6,14}$/.test(row.phone || "") && <button type="button" className="icon-button" aria-label={`复制号码 ${row.phone}`} onClick={() => void copyPhone(row)}><Copy size={14} /></button>}</div>{row.createdAt && <small>购号 {time(row.createdAt)}</small>}</td>
          <td data-label="国家 / 服务商"><strong>{row.countryLabel || (row.country ? `国家 ${row.country}` : "国家未记录")}</strong><small>{platforms[row.providerId] || "来源未确认"}</small></td>
          <td data-label="号码费用"><SmsOrderCost order={row} /></td>
          <td data-label="库存状态"><span className={`sp-buffer-state sp-buffer-state-${row.state}`}>{inventoryState(row)}</span>{row.lastError && <small>{poolErrors[row.lastError] || bufferErrors[row.lastError] || "此号码需要处理，请查看详情"}</small>}</td>
          <td data-label="有效期"><span>{row.expiresAt ? remainingTime(row.expiresAt) : "有效期未确认"}</span><small>{row.expiresAt ? time(row.expiresAt) : ""}</small><small>{row.expiresSource === "provider" ? "服务商返回有效期" : row.expiresSource === "provider_policy" ? "按服务商期限规则" : row.expiresSource ? "按保守期限处理" : "不推定有效期"}</small></td>
          <td data-label="操作"><details className="sp-inventory-order-detail"><summary>订单详情</summary><span>{row.cancelState === "confirmed" ? "取消已确认" : row.cancelState === "denied" ? "暂不允许取消" : row.state === "cancel_pending" ? "取消处理中" : row.state === "assigned" ? "随接码任务处理" : row.state === "closed" ? "订单已结束" : "尚未回收"}</span>{["cancel_pending", "closed", "quarantined"].includes(row.state) || row.cancelState ? <small>{refundNames[row.refundStatus] || "退款待核实"}</small> : null}{(row.nextCancelAt || row.nextActionAt) && <small>下次处理 {time(row.nextCancelAt || row.nextActionAt)}</small>}{!row.nextCancelAt && !row.nextActionAt && (row.cancelAfter || row.cancelAllowedAt) && <small>最早取消 {time(row.cancelAfter || row.cancelAllowedAt)}</small>}</details>{row.canReconcile && <button type="button" className="text-action" disabled={Boolean(busy)} onClick={() => setDialog({ kind: "inventory", row })}>核实库存</button>}</td>
        </tr>)}</tbody></table>{!inventoryLoading && !inventoryError && !matchingBuffer.length && <div className="sp-empty"><PhoneIncoming size={25} /><h3>{bufferFilters.scope === "history" ? "还没有历史号码" : "当前没有符合条件的号码"}</h3><p>{emptyBufferMessage}</p></div>}{inventoryLoading && <p className="sp-history-status" role="status">正在读取号码库存</p>}{!buffer && <p className="sp-history-status" role="status">尚未读取到库存，请刷新接码池。</p>}</div>
        {inventory && <nav className="sp-history-pagination" aria-label="号码库存分页"><span>共 {inventory.total} 个号码</span><div><button className="secondary-button" disabled={inventoryLoading || inventoryPage <= 1} onClick={() => setInventoryPage((value) => value - 1)}>上一页</button><span>{inventory.page} / {inventory.pages}</span><button className="secondary-button" disabled={inventoryLoading || inventoryPage >= inventory.pages} onClick={() => setInventoryPage((value) => value + 1)}>下一页</button></div></nav>}
        <p className="sp-footnote">预购号码可能产生服务商费用。取消与退款分别确认，回收仅处理未分配号码。</p>
      </section>}
    </div>{tab === "credentials" && <aside className="sp-rules"><div className="sp-rules-heading"><Settings2 size={17} /><h3>池规则</h3><span>对所有 CDK 生效</span></div>
      <form onSubmit={(event) => { event.preventDefault(); if (!canSave || busy) return; void perform("rules", () => saveRules(), "池规则已保存，已开始的接码按原费率结算"); }}>
        <label className="sp-toggle-row"><span><strong>向普通 CDK 开放</strong><small>关闭后停止分配新号码</small></span><input type="checkbox" role="switch" disabled={Boolean(busy)} checked={Boolean(draft?.enabled)} onChange={(event) => updateDraft({ enabled: event.target.checked })} aria-label="向普通 CDK 开放接码池" /></label>
        <div className="sp-rule-group"><label className="sp-number-field"><span>验证成功扣次</span><div><input aria-label="验证成功扣次" type="number" min="1" max="1000000" required disabled={Boolean(busy)} value={draft?.fee ?? ""} onChange={(event) => updateDraft({ fee: event.target.value })} /><span>次 / 账号</span></div></label><p>手机验证码通过后扣除。取号失败、无号和未通过验证不扣次。</p></div>
        <div className="sp-rule-group"><h4>即时取号保护</h4><div className="sp-paired-fields"><label className="sp-number-field"><span>连续无号</span><div><input aria-label="连续无号暂停阈值" type="number" min="1" max="100" required disabled={Boolean(busy)} value={draft?.noStockThreshold ?? ""} onChange={(event) => updateDraft({ noStockThreshold: event.target.value })} /><span>次</span></div></label><label className="sp-number-field"><span>首次冷却</span><div><input aria-label="首次冷却分钟" type="number" min="1" max="1440" required disabled={Boolean(busy)} value={draft?.cooldownMinutes ?? ""} onChange={(event) => updateDraft({ cooldownMinutes: event.target.value })} /><span>分钟</span></div></label></div><p>仅用于接码任务的即时取号。缓冲补号暂时无号时，每 5 秒重试，不使用此冷却时长。</p></div>
        <div className="sp-rule-group"><div className="sp-paired-fields"><label className="sp-number-field"><span>单次取号上限</span><div><input aria-label="单次取号尝试上限" type="number" min="1" max="20" required disabled={Boolean(busy)} value={draft?.maxAttempts ?? ""} onChange={(event) => updateDraft({ maxAttempts: event.target.value })} /><span>次</span></div></label><label className="sp-number-field"><span>池并发上限</span><div><input aria-label="池并发上限" type="number" min="1" max="20" required disabled={Boolean(busy)} value={draft?.maxConcurrent ?? ""} onChange={(event) => updateDraft({ maxConcurrent: event.target.value })} /><span>个</span></div></label></div></div>
        <button className="primary-button sp-save-rules" disabled={!canSave || Boolean(busy)}>{busy === "rules" ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}保存池规则</button>
      </form><div className="sp-charge-note"><ShieldCheck size={17} /><p>开始接码先预留次数，成功后正式扣除。结果不明确时保留预留，等待核实。</p></div>
    </aside>}</div>}
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
