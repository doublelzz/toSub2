import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, CircleAlert, Clock3, Copy, Globe2, KeyRound, LoaderCircle, Pause, PhoneIncoming, Play, Plus, RefreshCw, Search, Settings2, ShieldCheck, X } from "lucide-react";
import { useDialogFocus } from "./WorkspaceUi.jsx";
import { cdkFetch } from "./cdk-api.mjs";
import "./sms-pool.css";

const platforms = { smsbower: "SMSBower", herosms: "Hero SMS" };
const states = { available: "可用", cooling: "冷却中", disabled: "已停用", credential_error: "凭据异常", probing: "恢复尝试中" };
const settlementNames = { queued: "等待池名额", reserved: "已预留", running: "接码中", requesting: "正在取号", allocated: "已取号", submitted: "验证中", verified: "已扣次", committed: "已扣次", released: "已释放", reconciliation_required: "待核实", uncertain: "待核实", unknown: "待核实" };
const poolErrors = { no_stock: "当前国家和价格暂时无号", auth_invalid: "服务商密钥无效，请更新凭据", balance_insufficient: "服务商余额不足，请充值后恢复", rate_limited: "服务商限流，稍后重试", config_invalid: "报价配置无效，请重新查询", order_unknown: "取号结果待核实", duplicate_phone: "服务商重复返回已有号码，本次取号已停止", duplicate_order: "服务商重复返回已有订单，需核实" };
const ruleDefaults = { enabled: false, noStockThreshold: 3, cooldownMinutes: 10, maxAttempts: 10, requestConcurrency: 3 };
const bufferStates = { ready: "待分配", purchasing: "正在购号", checking: "正在检查", assigned: "接码中", consumed: "已使用", cancel_pending: "回收中", purchase_unknown: "购号待核实", closed: "已结束", quarantined: "需处理" };
const bufferErrors = { legacy_inventory_retired: "已切换为按需取号，旧号码停止分配并回收", interrupted_purchase: "购号时服务中断，结果待核实", interrupted_inventory_check: "检查号码时服务中断", inventory_status_unconfirmed: "无法确认号码可分配", inventory_configuration_disabled: "关联配置已停用", cancellation_window_expired: "取消窗口已结束", FREE_CANCELLATION_EXPIRED: "服务商取消期限已过", OTP_RECEIVED: "号码已有短信，需核查取消结果", NEW_OTP_RECEIVED: "号码出现新短信，需核查取消结果", CANCEL_UNSUPPORTED: "服务商暂不支持确认取消", cancel_unconfirmed: "取消结果尚未确认", inventory_retired: "号码不再满足分配条件，正在回收", price_above_limit: "返回价格超过配置上限", administrator_drain: "管理员已请求回收", inventory_assignment_stopped: "分配已停止，正在回收", sms_received_before_assignment: "分配前已收到短信，正在回收", insufficient_remaining_lifetime: "剩余有效期不足" };
const refundNames = { confirmed: "退款已确认", refunded: "退款已确认", unconfirmed: "退款待核实", unknown: "退款待核实", pending: "退款待核实", not_applicable: "不适用", none: "退款待核实" };
const inventoryPhone = (value) => typeof value === "string" && value ? value : "号码未确认";
const maskedOperationPhone = (value) => typeof value === "string" && value ? value.replace(/.(?=.{4})/g, "*") : "号码未确认";
const inventoryState = (row) => row.state === "closed" && row.cancelState === "confirmed" ? "取消已确认" : bufferStates[row.state] || "状态未知";
const normalizeRules = (rules = {}) => ({ ...ruleDefaults, ...rules, requestConcurrency: rules.requestConcurrency ?? 3 });
const time = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "—";
const optionLabel = (row) => [row.countryLabel, row.title, row.name].find((value) => typeof value === "string" && value.trim()) || `国家 ${row.country}`;
const validInteger = (value, min, max) => String(value ?? "").trim() !== "" && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max;
const ruleRanges = { noStockThreshold: [1, 100], cooldownMinutes: [1, 1440], maxAttempts: [1, 20], requestConcurrency: [1, 20] };
const remainingTime = (value) => { const end = typeof value === "number" ? value : Date.parse(value); if (!Number.isFinite(end)) return "有效期未确认"; const seconds = Math.max(0, Math.ceil((end - Date.now()) / 1000)); return seconds ? `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒` : "已到期"; };
const quoteRoute = (row, credentialId = row.credentialId, categoryId = row.categoryId) => JSON.stringify([categoryId, credentialId, row.service || "dr", String(row.country), Number(row.maxPrice ?? row.price), String(row.providerIds || "")]);

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
  return <section className={`sp-cost-summary${summary?.byCurrency?.some((row) => row.verifiedPurchaseAmount !== undefined) ? " sp-cost-summary-with-success" : ""}`} aria-label="管理员服务商成本"><div className="sp-cost-heading"><h3>{title}</h3><p>{description}</p></div>{!summary || stale ? <p className="sp-cost-unknown">{loading ? "正在读取成本记录" : stale ? "成本状态未知，请重新读取。" : "成本数据尚未记录。"}</p> : <><div className="sp-cost-currencies">{(Array.isArray(summary.byCurrency) ? summary.byCurrency : []).map((row) => <div className="sp-cost-currency" key={row.currency}><strong>{costCurrency(row.currency) || "币种未知"}</strong><span>已确认购号金额 <b>{(row.confirmedOrderCount === 0 ? "无已确认订单" : amount(row.confirmedPurchaseAmount, row.currency))}</b><small>{knownCount(row.confirmedOrderCount)} 个订单</small></span>{row.verifiedPurchaseAmount !== undefined && <span>成功实际金额 <b>{(row.verifiedOrderCount === 0 ? "无已确认成功费用" : amount(row.verifiedPurchaseAmount, row.currency))}</b><small>{knownCount(row.verifiedOrderCount)} 个已知金额订单</small></span>}<span>退款待核实 <b>{amount(row.refundUnconfirmedAmount, row.currency)}</b><small>{knownCount(row.refundUnconfirmedCount)} 个订单</small></span></div>)}</div><div className="sp-cost-estimates"><span>成功估算金额</span><EstimatedMoney stats={summary} /></div><p className="sp-cost-counts"><span>已记录订单 {knownCount(summary.orderCount)}</span><span>金额未知订单 {knownCount(summary.unknownCostCount)}</span><span>币种未知订单 {knownCount(summary.unknownCurrencyCount)}</span>{summary.verifiedCount !== undefined && <><span>成功取号 {knownCount(summary.obtainedCount)}</span><span>验证通过 {knownCount(summary.verifiedCount)}</span><span>通过号码金额未知 {knownCount(summary.unknownVerifiedCostCount)}</span><span>通过号码币种未知 {knownCount(summary.unknownVerifiedCurrencyCount)}</span></>}</p></>}</section>;
}

const orderOutcome = (order) => order.verified === true ? "验证成功" : order.verified === false ? ({ abandoned: "已换号 · 未成功", released: "已释放 · 未成功", cancel_pending: "取消处理中 · 未成功", closed: "订单已结束 · 未成功", uncertain: "待核实", unknown: "待核实" }[order.state] || "未验证成功") : "验证结果未记录";
function OperationCosts({ operation }) {
  const orders = Array.isArray(operation.costOrders) ? operation.costOrders : null;
  const attempts = Number.isSafeInteger(operation.attempts) && operation.attempts >= 0 ? operation.attempts : null;
  return <div className="sp-operation-costs"><SmsOrderCost order={operation} /><small>{attempts === null ? "取号次数未记录" : `取号尝试 ${attempts} 次`}{orders ? `，号码订单 ${orders.length} 个` : ""}</small>{orders?.length > 0 && <details className="sp-cost-orders"><summary>查看每个号码费用</summary><ol>{orders.map((order, index) => <li key={JSON.stringify([order.providerId || "provider", order.credentialId || "credential", order.orderId ?? index])}><div><strong>{order.providerName || platforms[order.providerId] || "服务商未确认"}</strong><span>{maskedOperationPhone(order.phone)}</span><span className={order.verified === true ? "sp-order-verified" : "sp-order-outcome"}>{orderOutcome(order)}</span>{order.verifiedAt && <small>验证 {time(order.verifiedAt)} · 北京时间</small>}{order.countryLabel && <small>{order.countryLabel}</small>}{order.createdAt && <small>{time(order.createdAt)}</small>}</div><SmsOrderCost order={order} />{(order.refundExpected === true || order.refundStatus === "confirmed") && <small>{order.refundStatus === "confirmed" ? "退款已确认" : "退款待核实"}</small>}</li>)}</ol></details>}</div>;
}

const reportDefaults = { categoryId: "", providerId: "", credentialId: "", country: "", currency: "", costStatus: "all", result: "all", state: "all", search: "", startDate: "", endDate: "" };
const countText = (value) => Number.isSafeInteger(value) && value >= 0 ? value : "—";
const countryKey = (row) => row.countryKey || (row.providerId && row.country != null ? `${row.providerId}:${row.country}` : "");
const dateInput = (date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
const defaultDailyDates = () => { const end = dateInput(new Date()); const start = new Date(`${end}T00:00:00+08:00`); start.setUTCDate(start.getUTCDate() - 29); return { ...reportDefaults, startDate: dateInput(start), endDate: end }; };
function reportQuery(filters) {
  const query = {};
  for (const key of ["categoryId", "providerId", "credentialId", "country", "currency", "costStatus", "result", "state", "search"]) if (filters[key] && filters[key] !== "all") query[key] = filters[key];
  if (filters.startDate) query.start = new Date(`${filters.startDate}T00:00:00+08:00`).toISOString();
  if (filters.endDate) { const end = new Date(`${filters.endDate}T00:00:00+08:00`); end.setUTCDate(end.getUTCDate() + 1); query.end = end.toISOString(); }
  return query;
}
const invalidReportDates = (filters) => Boolean(filters.startDate && filters.endDate && filters.startDate > filters.endDate);
function StatsMoney({ stats, field = "confirmedPurchaseAmount" }) {
  if (!stats) return <span className="sp-stats-unknown">统计未记录</span>;
  const currencies = (stats.byCurrency || []).filter((row) => costTotalAmount(row[field]) !== null && costCurrency(row.currency) && (field !== "confirmedPurchaseAmount" || row.confirmedOrderCount !== 0));
  return <span className="sp-stats-money">{currencies.length ? currencies.map((row) => <span key={row.currency}>{row[field]} {row.currency}</span>) : <span>无已确认金额</span>}</span>;
}
function SuccessMoney({ stats }) {
  if (!stats || !Number.isSafeInteger(stats.verifiedCount)) return <span className="sp-stats-unknown">统计未记录</span>;
  const rows = (stats.byCurrency || []).filter((row) => costCurrency(row.currency) && costTotalAmount(row.verifiedPurchaseAmount) !== null && (Number(row.verifiedOrderCount) > 0 || Number(row.verifiedPurchaseAmount) > 0));
  return <span className="sp-stats-money">{rows.map((row) => <span key={row.currency}>{row.verifiedPurchaseAmount} {row.currency}</span>)}{!rows.length && <span>{stats.verifiedCount === 0 ? "无成功订单" : "实际金额未知"}</span>}{Number(stats.unknownVerifiedCostCount) > 0 && <small>实际金额未知 {stats.unknownVerifiedCostCount} 个</small>}{Number(stats.unknownVerifiedCurrencyCount) > 0 && <small>实际币种未知 {stats.unknownVerifiedCurrencyCount} 个</small>}</span>;
}
function EstimatedMoney({ stats }) {
  if (!stats || !Number.isSafeInteger(stats.estimatedVerifiedCount)) return <span className="sp-stats-unknown">估算未记录</span>;
  const rows = (stats.byCurrency || []).filter((row) => costCurrency(row.currency) && costTotalAmount(row.estimatedVerifiedAmount) !== null && Number(row.estimatedVerifiedOrderCount) > 0);
  const unknownCurrency = (stats.estimatesByProviderCurrency || []).filter((row) => !costCurrency(row.currency) && costTotalAmount(row.estimatedVerifiedAmount) !== null && Number(row.estimatedVerifiedOrderCount) > 0);
  return <span className="sp-stats-money sp-estimated-money">{rows.map((row) => <span key={row.currency}>{row.estimatedVerifiedAmount} {row.currency}<small>报价估算 · {row.estimatedVerifiedOrderCount} 个</small></span>)}{unknownCurrency.map((row) => <span key={row.providerId || row.providerName}>{row.estimatedVerifiedAmount}<small>{row.providerName || platforms[row.providerId] || "服务商未记录"} · 平台币种未知 · {row.estimatedVerifiedOrderCount} 个</small></span>)}{!rows.length && !unknownCurrency.length && <span>{stats.estimatedVerifiedCount === 0 && !stats.missingVerifiedEstimateCount ? "无需估算" : "报价未记录"}</span>}{Number(stats.missingVerifiedEstimateCount) > 0 && <small>另有 {stats.missingVerifiedEstimateCount} 个缺少报价</small>}</span>;
}
function TodaySummary({ summary, loading }) {
  return <div className="sp-today" aria-label="今日取号概览"><div className="sp-today-count"><span>今日取号</span><strong>{countText(summary?.obtainedCount)}</strong></div><div className="sp-today-count"><span>今日成功</span><strong>{countText(summary?.verifiedCount)}</strong></div><div><span>成功实际金额</span><SuccessMoney stats={summary} /></div><div><span>成功估算金额</span><EstimatedMoney stats={summary} /></div><small className="sp-today-date">{loading ? "正在读取今日统计" : `${summary?.date || "今日"} · 北京时间 · 全部分类`}</small></div>;
}
function DailyTable({ rows }) {
  return <div className="table-frame sp-daily-frame"><table className="sp-daily-table"><thead><tr><th>日期 · 北京时间</th><th>取号数</th><th>成功数</th><th>成功实际金额</th><th>成功估算金额</th></tr></thead><tbody>{rows.map((row) => <tr key={row.date}><td data-label="日期"><strong>{row.date}</strong></td><td data-label="取号数">{countText(row.obtainedCount)}</td><td data-label="成功数">{countText(row.verifiedCount)}</td><td data-label="成功实际金额"><SuccessMoney stats={row} /></td><td data-label="成功估算金额"><EstimatedMoney stats={row} /></td></tr>)}</tbody></table>{!rows.length && <div className="sp-empty"><Clock3 size={23} /><h3>当前范围没有日期记录</h3><p>调整日期范围后重新读取。</p></div>}</div>;
}
function EntryStats({ stats }) {
  return <div className="sp-entry-stats" aria-label="累计取号与费用"><div><span>累计购号金额</span><StatsMoney stats={stats} /></div>{stats && <><small>取号 <b>{countText(stats.obtainedCount)}</b> 个 · 验证通过 <b>{countText(stats.verifiedCount)}</b> 个</small>{Number(stats.unknownCostCount) > 0 && <small>金额未知 {stats.unknownCostCount} 个订单</small>}{Number(stats.unknownCurrencyCount) > 0 && <small>币种未知 {stats.unknownCurrencyCount} 个订单</small>}</>}</div>;
}
function ReportFilters({ filters, onChange, options, prefix, operation = false }) {
  const providers = options.providers || []; const credentials = (options.credentials || []).filter((row) => !filters.providerId || row.providerId === filters.providerId);
  const countries = (options.countries || []).filter((row) => !filters.providerId || row.providerId === filters.providerId);
  const update = (patch) => onChange({ ...filters, ...patch });
  const quickDate = (days) => { const end = dateInput(new Date()); const start = new Date(`${end}T00:00:00+08:00`); start.setUTCDate(start.getUTCDate() - days + 1); update({ startDate: dateInput(start), endDate: end }); };
  return <div className="sp-report-filters" aria-label={`${prefix}筛选`}>
    <div className="sp-filter-grid">
      {operation && <label>账号 / CDK / 号码<input aria-label={`${prefix}搜索`} type="search" value={filters.search} placeholder="搜索邮箱、CDK、任务或号码尾号" onChange={(event) => update({ search: event.target.value })} /></label>}
      <label>分类<select aria-label={`${prefix}分类`} value={filters.categoryId || ""} onChange={(event) => update({ categoryId: event.target.value })}><option value="">全部分类</option>{(options.categories || []).map((row) => <option key={row.id || row.categoryId} value={row.id || row.categoryId}>{row.name || row.categoryName}{row.archivedAt ? "（已归档）" : ""}</option>)}</select></label>
      <label>服务商<select aria-label={`${prefix}服务商`} value={filters.providerId} onChange={(event) => update({ providerId: event.target.value, credentialId: "", country: "" })}><option value="">全部服务商</option>{providers.map((row) => <option key={row.providerId} value={row.providerId}>{row.name || platforms[row.providerId] || row.providerId}</option>)}</select></label>
      <label>国家<select aria-label={`${prefix}国家`} value={filters.country} onChange={(event) => update({ country: event.target.value })}><option value="">全部国家</option>{countries.map((row) => <option key={countryKey(row)} value={countryKey(row)}>{row.countryLabel || `国家 ${row.country}`} / {platforms[row.providerId] || row.providerId}</option>)}</select></label>
      <label>凭据<select aria-label={`${prefix}凭据`} value={filters.credentialId} onChange={(event) => update({ credentialId: event.target.value })}><option value="">全部凭据</option>{credentials.map((row) => <option key={row.credentialId || row.id} value={row.credentialId || row.id}>{row.name || "服务商凭据"}</option>)}</select></label>
      {operation && <label>结算状态<select aria-label={`${prefix}状态`} value={filters.state} onChange={(event) => update({ state: event.target.value })}><option value="all">全部状态</option>{["reserved", "requesting", "allocated", "submitted", "verified", "released", "unknown"].map((key) => <option key={key} value={key}>{settlementNames[key]}</option>)}</select></label>}
      <label>结果口径<select aria-label={`${prefix}结果`} value={filters.result} onChange={(event) => update({ result: event.target.value })}><option value="all">全部订单</option><option value="obtained">成功取到号码</option><option value="verified">手机验证通过</option><option value="unverified">尚未验证通过</option></select></label>
      <label>金额状态<select aria-label={`${prefix}金额状态`} value={filters.costStatus} onChange={(event) => update({ costStatus: event.target.value })}><option value="all">全部金额状态</option><option value="known">已确认金额和币种</option><option value="unknown">金额或币种未知</option></select></label>
      <label>币种<select aria-label={`${prefix}币种`} value={filters.currency} onChange={(event) => update({ currency: event.target.value })}><option value="">全部币种</option>{(options.currencies || []).map((currency) => <option key={currency} value={currency}>{currency}</option>)}</select></label>
    </div>
    <div className="sp-report-date"><span>{operation ? "操作创建日 · 北京时间" : "统计日期 · 北京时间"}</span><label><span className="sr-only">开始日期</span><input type="date" aria-label={`${prefix}开始日期`} value={filters.startDate} onChange={(event) => update({ startDate: event.target.value })} /></label><span>至</span><label><span className="sr-only">结束日期</span><input type="date" aria-label={`${prefix}结束日期`} value={filters.endDate} onChange={(event) => update({ endDate: event.target.value })} /></label><button type="button" className="text-action" onClick={() => quickDate(1)}>今天</button><button type="button" className="text-action" onClick={() => quickDate(7)}>近 7 天</button><button type="button" className="text-action" onClick={() => quickDate(30)}>近 30 天</button><button type="button" className="text-action" onClick={() => onChange(operation ? { ...reportDefaults } : defaultDailyDates())}>清除筛选</button></div>
    {invalidReportDates(filters) && <p className="sp-error" role="alert">开始日期不能晚于结束日期。</p>}
  </div>;
}
function AnalyticsTable({ rows, grouping }) {
  return <div className="table-frame"><table className="sp-analytics-table"><thead><tr><th>{grouping === "category" ? "分类" : grouping === "provider" ? "服务商" : grouping === "entry" ? "国家报价" : "国家 / 服务商"}</th><th>购号总金额</th><th>成功实际金额 / 估算</th><th>成功取号 / 验证通过</th></tr></thead><tbody>{rows.map((row, index) => { const stats = row.summary || row; const mixedEntry = grouping === "entry" && row.mixedRoutes; const key = grouping === "category" ? row.categoryId : grouping === "entry" ? row.entryId : grouping === "provider" ? row.providerId : row.countryKey; return <tr key={`${grouping}:${key || index}`}><td data-label="来源"><strong>{mixedEntry ? "历史多路由" : grouping === "category" ? row.categoryName || "原接码池" : grouping === "provider" ? row.providerName || row.name || platforms[row.providerId] || row.providerId || "服务商未记录" : row.countryLabel || (row.country ? `国家 ${row.country}` : "国家未记录")}</strong>{!["provider", "category"].includes(grouping) && <small>{mixedEntry ? `${countText(row.routeCount)} 条历史路由` : `${row.providerName || platforms[row.providerId] || row.providerId || "服务商未记录"}${row.credentialName ? ` / ${row.credentialName}` : ""}`}</small>}</td><td data-label="购号总金额"><StatsMoney stats={stats} />{Number(stats.unknownCostCount) > 0 && <small>金额未知 {stats.unknownCostCount} 个</small>}{Number(stats.unknownCurrencyCount) > 0 && <small>币种未知 {stats.unknownCurrencyCount} 个</small>}</td><td data-label="成功金额"><SuccessMoney stats={stats} /><span className="sp-inline-estimate">报价估算</span><EstimatedMoney stats={stats} /></td><td data-label="成功取号 / 验证通过"><strong>{countText(stats.obtainedCount)} / {countText(stats.verifiedCount)}</strong><small>个号码</small></td></tr>; })}</tbody></table>{!rows.length && <div className="sp-empty"><Clock3 size={23} /><h3>当前范围没有购号记录</h3><p>调整国家、服务商或日期筛选。</p></div>}</div>;
}

export default function SmsPoolWorkspace({ token, api }) {
  const request = useCallback((path = "", method = "GET", body) => api ? api(path, method, body) : smsPoolRequest(token, path, method, body), [api, token]);
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [tab, setTab] = useState("entries");
  const [categoryId, setCategoryId] = useState("");
  const [manageCategories, setManageCategories] = useState(false);
  const categoryInitialized = useRef(false);
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
  const [analyticsFilters, setAnalyticsFilters] = useState(defaultDailyDates);
  const [legacyOpen, setLegacyOpen] = useState(false);
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
  const refreshVersion = useRef(0);
  const lastInventoryQuery = useRef("");
  const operationDatesInvalid = invalidReportDates(operationFilters);
  const analyticsDatesInvalid = invalidReportDates(analyticsFilters);
  const operationQuery = operationDatesInvalid ? "" : new URLSearchParams(reportQuery(operationFilters)).toString();
  const analyticsQuery = analyticsDatesInvalid ? "" : new URLSearchParams(reportQuery(analyticsFilters)).toString();
  const inventoryQuery = new URLSearchParams({ ...bufferFilters, page: String(inventoryPage), pageSize: "20" }).toString();
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try { const value = await request(); if (mounted.current && version === refreshVersion.current) { setData(value); if (!categoryInitialized.current) { setCategoryId((value.categories || []).find((row) => row.id === "other" && !row.archivedAt)?.id || (value.categories || []).find((row) => !row.archivedAt)?.id || ""); categoryInitialized.current = true; } if (value.analyticsFilterOptions) setReportOptions(value.analyticsFilterOptions); setDraft((previous) => draftEdited.current ? previous : normalizeRules(value.rules)); setStale(false); setError(""); return true; } }
    catch (failure) { if (mounted.current && version === refreshVersion.current) { setStale(true); setError(failure.message); } }
    return false;
  }, [request]);
  useEffect(() => { mounted.current = true; draftEdited.current = false; setData(null); setDraft(null); setReportOptions(null); void refresh(); return () => { mounted.current = false; refreshVersion.current++; }; }, [refresh]);
  useEffect(() => {
    if (tab !== "credentials" || !legacyOpen || !data) return undefined;
    let active = true; setInventoryLoading(true); setInventoryError("");
    if (lastInventoryQuery.current !== inventoryQuery) { setInventory(null); lastInventoryQuery.current = inventoryQuery; }
    void request(`/inventory?${inventoryQuery}`).then((value) => {
      if (!active) return;
      if (Array.isArray(value.items)) setInventory(value);
      else {
        const rows = (data.legacyInventory?.items || []).filter((row) => Boolean(row.phone) && (bufferFilters.scope === "all" || (bufferFilters.scope === "history" ? ["closed", "consumed"].includes(row.state) : !["closed", "consumed"].includes(row.state)))
          && (!bufferFilters.state || row.state === bufferFilters.state) && (!bufferFilters.providerId || row.providerId === bufferFilters.providerId) && (!bufferFilters.country || `${row.providerId}:${row.country}` === bufferFilters.country)
          && (!bufferFilters.search || `${row.phone || ""} ${row.countryLabel || ""}`.toLocaleLowerCase().includes(bufferFilters.search.toLocaleLowerCase()))
          && (!bufferFilters.refundStatus || row.refundStatus === bufferFilters.refundStatus) && (bufferFilters.costStatus === "all" || (row.cost?.source === "order" && costAmount(row.cost.amount) !== null && costCurrency(row.cost.currency) ? "known" : "unknown") === bufferFilters.costStatus));
        setInventory({ items: rows.slice((inventoryPage - 1) * 20, inventoryPage * 20), total: rows.length, page: inventoryPage, pages: Math.max(1, Math.ceil(rows.length / 20)) });
      }
    }).catch((failure) => { if (active) setInventoryError(failure.message); }).finally(() => { if (active) setInventoryLoading(false); });
    return () => { active = false; };
  }, [tab, legacyOpen, inventoryQuery, request, data, inventoryAttempt]);
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
      if (!value?.summary || !Array.isArray(value.byDay)) throw new Error("每日统计尚未记录，请刷新后重试。");
      setAnalytics(value); if (value.filterOptions) setReportOptions(value.filterOptions);
    }).catch((failure) => { if (active) setAnalyticsError(failure.message); }).finally(() => { if (active) setAnalyticsLoading(false); });
    return () => { active = false; };
  }, [tab, analyticsQuery, analyticsDatesInvalid, request, data, analyticsAttempt]);
  const updateDraft = (patch) => { draftEdited.current = true; setDraft((previous) => ({ ...previous, ...patch })); };
  async function perform(key, action, message) {
    if (busy) return;
    setBusy(key); setError(""); setNotice("");
    try { await action(); const refreshed = await refresh(); if (message && refreshed) setNotice(message); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(""); }
  }
  async function saveRules() {
    const submitted = { enabled: Boolean(draft.enabled), noStockThreshold: Number(draft.noStockThreshold), cooldownMinutes: Number(draft.cooldownMinutes), maxAttempts: Number(draft.maxAttempts), requestConcurrency: Number(draft.requestConcurrency) };
    const saved = await request("/rules", "PUT", submitted);
    if (Number(saved?.rules?.requestConcurrency) !== submitted.requestConcurrency) throw new Error("后台未确认取号请求并发，请刷新后重试。当前设置已保留。");
    draftEdited.current = false;
  }
  const updateInventoryFilters = (patch) => { setInventoryPage(1); setBufferFilters((value) => ({ ...value, ...patch })); };
  async function copyPhone(row) {
    if (!/^\+[1-9]\d{6,14}$/.test(row.phone || "")) return;
    try { await navigator.clipboard.writeText(row.phone); setNotice("号码已复制"); }
    catch { setError("复制失败，请直接选中号码复制。"); }
  }
  const rules = data?.rules || ruleDefaults;
  const allEntries = data?.entries || [];
  const categories = data?.categories || [];
  const currentCategory = categories.find((row) => row.id === categoryId);
  const activeCategories = categories.filter((row) => !row.archivedAt);
  const entries = allEntries.filter((row) => row.categoryId === categoryId);
  const credentials = data?.credentials || [];
  const operations = data?.operations || [];
  const buffer = stale ? null : data?.legacyInventory;
  const operationRows = operationHistory?.items || [];
  const pending = operations.filter((row) => ["reconciliation_required", "uncertain", "unknown"].includes(row.status || row.state));
  const matching = entries.filter((row) => (filter === "all" || row.state === filter) && (!entryFilters.providerId || row.providerId === entryFilters.providerId) && (!entryFilters.credentialId || row.credentialId === entryFilters.credentialId) && (!entryFilters.country || countryKey(row) === entryFilters.country) && (entryFilters.obtained === "all" || row.stats && (entryFilters.obtained === "yes" ? row.stats.obtainedCount > 0 : row.stats.obtainedCount === 0)) && (!entryFilters.minPrice || Number(row.maxPrice) >= Number(entryFilters.minPrice)) && (!entryFilters.maxPrice || Number(row.maxPrice) <= Number(entryFilters.maxPrice)) && `${row.countryLabel} ${row.country} ${platforms[row.providerId]} ${row.credentialName || ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim()));
  const providerOptions = [...new Set([...credentials.map((row) => row.providerId), ...entries.map((row) => row.providerId)].filter(Boolean))].map((providerId) => ({ providerId, name: platforms[providerId] || providerId }));
  const fallbackOptions = { categories, providers: providerOptions, credentials: credentials.map((row) => ({ ...row, credentialId: row.id })), countries: [...new Map(entries.filter((row) => countryKey(row)).map((row) => [countryKey(row), { countryKey: countryKey(row), country: row.country, countryLabel: row.countryLabel, providerId: row.providerId }])).values()], currencies: [...new Set(entries.map((row) => row.currency).filter(Boolean))] };
  const filterOptions = reportOptions || data?.analyticsFilterOptions || data?.analytics?.filterOptions || fallbackOptions;
  const matchingBuffer = inventory?.items || [];
  const pendingInventory = (buffer?.items || []).filter((row) => row.canReconcile && !row.phone);
  const groupedRows = analytics ? grouping === "category" ? (analytics.byCategory || []) : grouping === "provider" ? (analytics.byProvider || []) : grouping === "entry" ? (analytics.byEntry || []) : (analytics.byCountry || []) : [];
  const canSave = draft && typeof draft.enabled === "boolean" && Object.entries(ruleRanges).every(([key, [min, max]]) => validInteger(draft[key], min, max));
  return <section className="workspace sp-workspace" aria-labelledby="sp-title">
    <header className="sp-heading"><div><h2 id="sp-title">接码池</h2><p>配置国家报价，接码任务开始后按需取号。</p></div><div className="sp-heading-actions"><button className="secondary-button" onClick={() => void perform("refresh", async () => {})} disabled={Boolean(busy)}><RefreshCw size={15} />刷新</button><button className="primary-button" onClick={() => setDialog({ kind: "entry" })} disabled={!data || !currentCategory || currentCategory.archivedAt || !credentials.some((row) => row.enabled)}><Plus size={16} />添加国家报价</button></div></header>
    <div className="sp-pool-status"><span className={`sp-state ${stale ? "sp-state-credential_error" : rules.enabled ? "sp-state-available" : "sp-state-disabled"}`}><i />{!data || stale ? error ? "读取失败" : "正在读取接码池" : rules.enabled ? "接码池已开放" : "接码池已关闭"}</span><span>{data && !stale ? `${entries.filter((row) => row.state === "available").length} 个可用条目` : "可用条目未知"}</span><span>{data && !stale ? `${entries.filter((row) => row.state === "cooling").length} 个冷却中` : "正在读取规则"}</span><span className="sp-pool-fee">{currentCategory?.name || "当前分类"} · 验证成功扣 <strong>{data && !stale && currentCategory ? currentCategory.fee : "—"}</strong> 次</span></div>
    {data && <><div className="sp-category-toolbar"><label>国家报价分类<select aria-label="当前接码池分类" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="" disabled>选择分类</option>{currentCategory?.archivedAt && <option value={currentCategory.id}>{currentCategory.name}（已归档）</option>}{activeCategories.map((row) => <option key={row.id} value={row.id}>{row.name}{!row.enabled ? "（已停用）" : ""} · 成功扣 {row.fee} 次</option>)}</select></label><button className="text-action" type="button" aria-expanded={manageCategories} onClick={() => setManageCategories((value) => !value)}><Settings2 size={14} />管理分类</button></div>{currentCategory && (!currentCategory.enabled || currentCategory.archivedAt) && <p className="sp-category-notice">此分类{currentCategory.archivedAt ? "已归档" : "已停用"}，普通用户无法开始新的接码任务。</p>}{manageCategories && <section className="sp-category-manager" aria-label="管理接码池分类"><div className="sp-category-manager-heading"><p>每个分类独立设置成功扣次和国家报价。</p><button className="secondary-button" type="button" onClick={() => setDialog({ kind: "category" })}><Plus size={14} />新增分类</button></div>{activeCategories.map((row) => <div className="sp-category-row" key={row.id}><div><strong>{row.name}</strong><small>验证成功扣 {row.fee} 次 · {row.enabled ? "已启用" : "已停用"}</small></div><div className="sp-row-actions"><button className="text-action" onClick={() => setDialog({ kind: "category", row })}>编辑 {row.name}</button><button className="text-action" disabled={Boolean(busy)} onClick={() => void perform(`category:${row.id}`, () => request(`/categories/${encodeURIComponent(row.id)}`, "PATCH", { enabled: !row.enabled }), "分类状态已更新")}>{row.enabled ? "停用" : "启用"}</button><button className="text-action" disabled={Boolean(busy)} onClick={() => setDialog({ kind: "archive-category", row })}>归档</button></div></div>)}</section>}</>}
    <TodaySummary summary={stale ? null : data?.today} loading={!data && !error} />
    {error && <div className="sp-feedback sp-error" role="alert"><CircleAlert size={16} /><span>{error}</span><button className="text-action" onClick={() => void refresh()}>重新读取</button></div>}
    {notice && <div className="sp-feedback sp-success" role="status"><Check size={16} />{notice}</div>}
    {!data && !error && <div className="sp-empty" role="status"><LoaderCircle className="spin" size={22} /><p>正在读取接码池</p></div>}
    {data && <div className={`sp-layout${tab === "credentials" ? "" : " sp-layout-wide"}`}><div className="sp-main">
      <nav className="sp-tabs" aria-label="接码池内容">{[["entries", "国家报价", entries.length], ["operations", "取号记录", operationHistory?.total], ["analytics", "每日统计"], ["credentials", "设置"]].map(([value, label, count]) => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}{count !== undefined && <span>{count}</span>}</button>)}</nav>
      {tab === "entries" && <>
        <div className="sp-list-tools"><label className="sp-search"><Search size={16} /><input aria-label="搜索池内国家或服务商" placeholder="搜索国家、服务商" value={search} onChange={(event) => setSearch(event.target.value)} /></label><select aria-label="筛选接码池条目状态" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部状态</option>{Object.entries(states).map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></div>
        <details className="sp-entry-filter-more"><summary>更多报价筛选</summary><div className="sp-entry-filter-grid" aria-label="国家报价筛选">
          <label>服务商<select aria-label="报价服务商" value={entryFilters.providerId} onChange={(event) => setEntryFilters((previous) => ({ ...previous, providerId: event.target.value, country: "", credentialId: "" }))}><option value="">全部服务商</option>{providerOptions.map((row) => <option key={row.providerId} value={row.providerId}>{row.name}</option>)}</select></label>
          <label>国家<select aria-label="报价国家" value={entryFilters.country} onChange={(event) => setEntryFilters((previous) => ({ ...previous, country: event.target.value }))}><option value="">全部国家</option>{fallbackOptions.countries.filter((row) => !entryFilters.providerId || row.providerId === entryFilters.providerId).map((row) => <option key={row.countryKey} value={row.countryKey}>{row.countryLabel || `国家 ${row.country}`} / {platforms[row.providerId] || row.providerId}</option>)}</select></label>
          <label>凭据<select aria-label="报价凭据" value={entryFilters.credentialId} onChange={(event) => setEntryFilters((previous) => ({ ...previous, credentialId: event.target.value }))}><option value="">全部凭据</option>{credentials.filter((row) => !entryFilters.providerId || row.providerId === entryFilters.providerId).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
          <label>取号记录<select aria-label="报价取号记录" value={entryFilters.obtained} onChange={(event) => setEntryFilters((previous) => ({ ...previous, obtained: event.target.value }))}><option value="all">全部取号记录</option><option value="yes">已成功取号</option><option value="no">尚未成功取号</option></select></label>
          <label>价格上限从<input type="number" min="0" step="any" aria-label="报价最低价格上限" value={entryFilters.minPrice} onChange={(event) => setEntryFilters((previous) => ({ ...previous, minPrice: event.target.value }))} placeholder="不限" /></label>
          <label>价格上限至<input type="number" min="0" step="any" aria-label="报价最高价格上限" value={entryFilters.maxPrice} onChange={(event) => setEntryFilters((previous) => ({ ...previous, maxPrice: event.target.value }))} placeholder="不限" /></label>
          <button type="button" className="text-action" onClick={() => { setEntryFilters({ providerId: "", credentialId: "", country: "", obtained: "all", minPrice: "", maxPrice: "" }); setSearch(""); setFilter("all"); }}>清除报价筛选</button>
        </div></details>
        <div className="sp-filter-caption"><span>显示 {matching.length} / {entries.length} 条报价</span><span>以下金额与取号数为每条当前报价的累计记录</span></div>
        <div className="table-frame sp-table-frame"><table className="sp-entry-table"><thead><tr><th>国家 / 服务商</th><th className="sp-price-column">价格上限</th><th>状态</th><th className="sp-priority-column">优先级</th><th>操作</th></tr></thead><tbody>{matching.map((row) => <tr key={row.id}>
          <td data-label="国家 / 服务商"><div className="sp-country"><span className="sp-country-icon"><Globe2 size={18} /></span><div><strong>{row.countryLabel || `国家 ${row.country}`}</strong><small>{platforms[row.providerId] || row.providerId} / {row.credentialName || credentials.find((item) => item.id === row.credentialId)?.name || "服务商凭据"}</small></div></div><EntryStats stats={stale ? null : row.stats} /></td>
          <td data-label="价格上限" className="sp-price"><strong>{row.maxPrice}</strong><small>{row.currency || "平台币种"}</small></td>
          <td data-label="状态"><State value={row.state} /><small>{row.state === "cooling" ? `${time(Math.max(Number(row.cooldownUntil) || 0, Number(row.credentialCooldownUntil) || 0))} 后尝试恢复` : poolErrors[row.lastError] || row.lastError || (row.noStockCount ? `连续无号 ${row.noStockCount} 次` : "取号成功后自动收码")}</small></td>
          <td data-label="优先级" className="sp-priority"><span>{row.priority}</span></td>
          <td data-label="操作"><div className="sp-row-actions"><button className="text-action" aria-label={`编辑 ${row.countryLabel || row.country}`} onClick={() => setDialog({ kind: "edit", row })}>编辑</button><button className="text-action" aria-label={`复制 ${row.countryLabel || row.country} 到其他分类`} onClick={() => setDialog({ kind: "copy-entry", row })}>复制到分类</button><button className="text-action" disabled={Boolean(busy)} onClick={() => void perform(row.id, () => request(`/entries/${row.id}`, "PATCH", { enabled: row.state === "disabled" || row.enabled === false, ...(row.state === "cooling" ? { resetCooldown: true, enabled: true } : {}) }), row.state === "cooling" ? "已取消冷却，下次真实任务将尝试取号" : row.state === "disabled" ? "条目已启用" : "条目已停用")}>{row.state === "disabled" ? <Play size={13} /> : row.state === "cooling" ? <RefreshCw size={13} /> : <Pause size={13} />}{row.state === "disabled" ? "启用" : row.state === "cooling" ? "恢复" : "停用"}</button></div></td>
        </tr>)}</tbody></table>{!matching.length && <div className="sp-empty"><Globe2 size={25} /><h3>{entries.length ? "没有匹配的国家报价" : "添加第一条国家报价"}</h3><p>{entries.length ? "调整搜索、国家、服务商或价格筛选。" : "先保存服务商凭据，再查询国家和价格加入池。"}</p><button className="secondary-button" disabled={Boolean(credentials.length && (!currentCategory || currentCategory.archivedAt))} onClick={() => setDialog({ kind: credentials.length ? "entry" : "credential" })}><Plus size={15} />{credentials.length ? "添加国家报价" : "添加服务商凭据"}</button></div>}</div>
        <p className="sp-footnote">接码任务按优先级尝试已启用的报价，购号不超过所选价格上限。没有任务时不取号。</p>
      </>}
      {tab === "credentials" && <><div className="sp-list-caption"><p>密钥仅用于后台取号，普通 CDK 无法查看。</p><button className="secondary-button" onClick={() => setDialog({ kind: "credential" })}><Plus size={15} />添加凭据</button></div><div className="sp-credentials">{credentials.map((row) => <div className="sp-credential-row" key={row.id}><span className="sp-country-icon"><KeyRound size={18} /></span><div><strong>{row.name}</strong><small>{platforms[row.providerId]} / {row.hasApiKey ? "密钥已保存" : "未配置密钥"}</small>{row.blockedReason && <small className="sp-credential-error">{poolErrors[row.blockedReason] || "凭据异常，请编辑后恢复"}</small>}</div><EntryStats stats={stale ? null : row.stats} /><State value={!row.enabled ? "disabled" : row.blockedReason ? "credential_error" : row.cooldownUntil > Date.now() ? "cooling" : "available"} /><div className="sp-credential-actions"><button className="text-action" disabled={Boolean(busy)} onClick={() => setDialog({ kind: "credential", row })}>{row.blockedReason === "auth_invalid" ? "更新密钥" : "编辑"}</button>{row.enabled && row.blockedReason === "balance_insufficient" && <button className="text-action" disabled={Boolean(busy)} onClick={() => void perform(row.id, () => request("/credentials", "POST", { id: row.id, providerId: row.providerId, name: row.name, enabled: true, resetCooldown: true }), "凭据已恢复，下次真实任务将重新取号")}>充值后恢复</button>}</div></div>)}{!credentials.length && <div className="sp-empty"><KeyRound size={25} /><h3>还没有服务商凭据</h3><p>添加 SMSBower 或 Hero SMS 后即可查询报价。</p><button className="primary-button" onClick={() => setDialog({ kind: "credential" })}>添加服务商凭据</button></div>}</div></>}
      {tab === "operations" && <><ReportFilters prefix="取号记录" filters={operationFilters} onChange={(value) => { setOperationFilters(value); setOperationPage(1); }} options={filterOptions} operation /><div className="sp-list-caption"><p>接码服务费与新增账号导入费分别记录。</p>{pending.length > 0 && <span className="sp-pending-count"><Clock3 size={14} />{pending.length} 条待核实</span>}</div><div className="table-frame"><table className="sp-operation-table"><thead><tr><th>账号 / CDK</th><th>结算状态</th><th>CDK 扣次</th><th>服务商费用</th><th>时间 / 操作</th></tr></thead><tbody>{operationRows.map((row) => <tr key={`${row.cdkId || row.ownerCdkId || "admin"}:${row.id || row.operationId}`}><td data-label="账号"><strong>{row.email || row.accountEmail}</strong><small>{row.cdkLabel || row.ownerCdkId || "管理员工作区"}</small><small>分类 · {row.categoryName || "原接码池"}</small></td><td data-label="结算状态"><span className={`sp-settlement sp-settlement-${row.status || row.state}`}>{settlementNames[row.status || row.state] || row.status || row.state}</span><small>{poolErrors[row.reason || row.lastError] || row.reason || row.lastError}</small></td><td data-label="CDK 扣次" className="sp-price">{row.fee ?? row.feeSnapshot ?? "—"} 次</td><td data-label="服务商费用"><OperationCosts operation={row} /></td><td data-label="时间"><small>{time(row.createdAt)}</small>{["reconciliation_required", "uncertain", "unknown"].includes(row.status || row.state) && <button className="text-action" onClick={() => setDialog({ kind: "reconcile", row })} disabled={Boolean(busy) || historyLoading}>核实处理</button>}</td></tr>)}</tbody></table>{!operationRows.length && !historyLoading && !historyError && <div className="sp-empty"><Clock3 size={25} /><h3>还没有池取号记录</h3><p>用户选择接码池后，本页记录预留、扣次和释放结果。</p></div>}{historyLoading && <p className="sp-history-status" role="status">正在读取取号记录</p>}{historyError && <div className="sp-feedback sp-error" role="alert"><span>{historyError}</span><button className="text-action" onClick={() => setHistoryAttempt((value) => value + 1)}>重新读取记录</button></div>}</div>{operationHistory && <nav className="sp-history-pagination" aria-label="取号记录分页"><span>共 {operationHistory.total} 条记录</span><div><button className="secondary-button" disabled={historyLoading || operationPage <= 1} onClick={() => setOperationPage((value) => value - 1)}>上一页</button><span>{operationHistory.page} / {operationHistory.pages}</span><button className="secondary-button" disabled={historyLoading || operationPage >= operationHistory.pages} onClick={() => setOperationPage((value) => value + 1)}>下一页</button></div></nav>}</>}
      {tab === "analytics" && <section className="sp-analytics" aria-labelledby="sp-analytics-title">
        <div className="sp-analytics-heading"><div><h3 id="sp-analytics-title">每日取号与成功金额</h3><p>北京时间。取号计入购号日，验证成功与成功金额计入验证日；默认显示最近 30 天。</p></div><button className="text-action" onClick={() => setAnalyticsAttempt((value) => value + 1)} disabled={analyticsLoading}><RefreshCw size={14} />刷新统计</button></div>
        <ReportFilters prefix="每日统计" filters={analyticsFilters} onChange={setAnalyticsFilters} options={filterOptions} />
        {analyticsLoading && <p className="sp-history-status" role="status">正在读取每日统计</p>}
        {analyticsError && <div className="sp-feedback sp-error" role="alert"><span>{analyticsError}</span><button className="text-action" onClick={() => setAnalyticsAttempt((value) => value + 1)}>重新读取统计</button></div>}
        {analytics && !analyticsLoading && <><DailyTable rows={analytics.byDay} /><p className="sp-footnote">实际金额来自服务商确认的订单费用；估算仅用于实际费用缺失的成功订单，按购号报价计算。金额未知不按 0 计算，不同币种分别显示。</p>{Number(analytics.summary.missingVerifiedAtCount) > 0 && <p className="sp-footnote">另有 {analytics.summary.missingVerifiedAtCount} 个成功订单缺少验证时间，无法计入日报。</p>}<details className="sp-cost-breakdown"><summary>查看范围总计与来源明细</summary><PoolCostSummary summary={analytics.dailySummary || analytics.summary} title="筛选范围服务商成本" description="取号按购号日、成功按验证日统计。取消与退款分别核实，以下金额不代表最终净成本。" /><div className="sp-analytics-groups" aria-label="成本统计分组">{[["category", "按分类"], ["country", "按国家"], ["provider", "按服务商"], ["entry", "按报价条目"]].map(([key, label]) => <button key={key} type="button" aria-pressed={grouping === key} onClick={() => setGrouping(key)}>{label}</button>)}</div><AnalyticsTable rows={groupedRows} grouping={grouping} /></details></>}
        {!analytics && !analyticsLoading && !analyticsError && !invalidReportDates(analyticsFilters) && <p className="sp-history-status">每日统计尚未记录。</p>}
      </section>}
      {tab === "credentials" && <details className="sp-legacy-orders" open={legacyOpen} onToggle={(event) => setLegacyOpen(event.currentTarget.open)}><summary>旧订单处理与历史</summary><section className="sp-buffer" aria-label="旧订单处理与历史"><p className="sp-footnote">查看既有订单、核实费用与退款。新接码任务直接按需取号。</p><div className="sp-legacy-actions"><button type="button" className="text-action" disabled={Boolean(busy) || !buffer} onClick={() => void perform("drain", () => request("/buffer/drain", "POST", {}), "已请求回收未分配旧号码，请查看取消结果")}>回收未分配旧号码</button></div>
        {pendingInventory.length > 0 && <details className="sp-refill-details sp-pending-inventory"><summary>待处理订单 {pendingInventory.length}</summary><ul>{pendingInventory.map((row) => <li key={row.id}><span>{row.countryLabel || "国家未记录"} / {platforms[row.providerId] || "服务商未记录"}</span><span>{poolErrors[row.lastError] || bufferErrors[row.lastError] || "购号结果待核实，未确认号码"}</span><button type="button" className="text-action" disabled={Boolean(busy)} onClick={() => setDialog({ kind: "inventory", row })}>核实订单</button></li>)}</ul></details>}
        <div className="sp-inventory-toolbar">
        <div className="sp-inventory-scopes" aria-label="库存范围">{[["current", "当前号码"], ["history", "历史号码"], ["all", "全部号码"]].map(([value, label]) => <button key={value} type="button" aria-pressed={bufferFilters.scope === value} onClick={() => updateInventoryFilters({ scope: value, state: "" })}>{label}</button>)}</div>
        <div className="sp-inventory-tools"><label className="sp-search"><Search size={16} /><input aria-label="搜索库存号码或国家" placeholder="搜索号码、国家" value={bufferFilters.search} onChange={(event) => updateInventoryFilters({ search: event.target.value })} /></label><label>状态<select aria-label="旧订单状态" value={bufferFilters.state} onChange={(event) => updateInventoryFilters({ state: event.target.value })}><option value="">全部状态</option>{Object.entries(bufferStates).filter(([key]) => !["purchasing"].includes(key)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
        </div>
        <details className="sp-inventory-more"><summary>更多筛选</summary><div className="sp-entry-filter-grid sp-buffer-filters" aria-label="号码库存筛选">
          <label>服务商<select aria-label="旧订单服务商" value={bufferFilters.providerId} onChange={(event) => updateInventoryFilters({ providerId: event.target.value })}><option value="">全部服务商</option>{providerOptions.map((row) => <option key={row.providerId} value={row.providerId}>{row.name}</option>)}</select></label>
          <label>国家<select aria-label="旧订单国家" value={bufferFilters.country} onChange={(event) => updateInventoryFilters({ country: event.target.value })}><option value="">全部国家</option>{(filterOptions.countries || []).map((row) => <option key={row.countryKey} value={row.countryKey}>{row.countryLabel || row.country} / {platforms[row.providerId]}</option>)}</select></label>
          <label>金额状态<select aria-label="旧订单金额状态" value={bufferFilters.costStatus} onChange={(event) => updateInventoryFilters({ costStatus: event.target.value })}><option value="all">全部金额状态</option><option value="known">已确认金额和币种</option><option value="unknown">金额或币种未知</option></select></label>
          <label>退款状态<select aria-label="旧订单退款状态" value={bufferFilters.refundStatus} onChange={(event) => updateInventoryFilters({ refundStatus: event.target.value })}><option value="">全部退款状态</option><option value="confirmed">退款已确认</option><option value="unconfirmed">退款待核实</option></select></label>
        </div><button type="button" className="text-action" onClick={() => updateInventoryFilters({ state: "", providerId: "", country: "", search: "", costStatus: "all", refundStatus: "" })}>清除库存筛选</button></details>
        {inventoryError && <div className="sp-feedback sp-error" role="alert"><span>{inventoryError}</span><button className="text-action" onClick={() => setInventoryAttempt((value) => value + 1)}>重新读取库存</button></div>}
        <p className="sp-filter-caption">共 {inventory?.total ?? "—"} 个旧号码{inventoryLoading ? "，正在读取" : ""}。</p>
        <div className="table-frame sp-buffer-table-frame"><table className="sp-buffer-table"><thead><tr><th>号码</th><th>国家 / 服务商</th><th>价格</th><th>状态</th><th>订单有效期</th><th>操作</th></tr></thead><tbody>{matchingBuffer.map((row) => <tr key={row.id}>
          <td data-label="号码"><div className="sp-inventory-number"><strong>{inventoryPhone(row.phone)}</strong>{/^\+[1-9]\d{6,14}$/.test(row.phone || "") && <button type="button" className="icon-button" aria-label={`复制号码 ${row.phone}`} onClick={() => void copyPhone(row)}><Copy size={14} /></button>}</div>{row.createdAt && <small>购号 {time(row.createdAt)}</small>}</td>
          <td data-label="国家 / 服务商"><strong>{row.countryLabel || (row.country ? `国家 ${row.country}` : "国家未记录")}</strong><small>{platforms[row.providerId] || "来源未确认"}</small></td>
          <td data-label="号码费用"><SmsOrderCost order={row} /></td>
          <td data-label="库存状态"><span className={`sp-buffer-state sp-buffer-state-${row.state}`}>{inventoryState(row)}</span>{row.lastError && <small>{poolErrors[row.lastError] || bufferErrors[row.lastError] || "此号码需要处理，请查看详情"}</small>}</td>
          <td data-label="有效期"><span>{["closed", "consumed"].includes(row.state) || row.cancelState === "confirmed" ? "订单已结束" : row.expiresAt ? remainingTime(row.expiresAt) : "有效期未确认"}</span><small>{row.expiresAt ? `${["closed", "consumed"].includes(row.state) || row.cancelState === "confirmed" ? "原有效期 " : ""}${time(row.expiresAt)}` : ""}</small><small>{row.expiresSource === "provider" ? "服务商返回有效期" : row.expiresSource === "provider_policy" ? "按服务商期限规则" : row.expiresSource ? "按保守期限处理" : "不推定有效期"}</small></td>
          <td data-label="操作"><details className="sp-inventory-order-detail"><summary>订单详情</summary>{row.retirementReason && <small>处理原因：{bufferErrors[row.retirementReason] || poolErrors[row.retirementReason] || "已停止分配并请求回收"}</small>}<span>{row.cancelState === "confirmed" ? "取消已确认" : row.cancelState === "denied" ? "暂不允许取消" : row.state === "cancel_pending" ? "取消处理中" : row.state === "assigned" ? "随接码任务处理" : row.state === "closed" ? "订单已结束" : "尚未回收"}</span>{["cancel_pending", "closed", "quarantined"].includes(row.state) || row.cancelState ? <small>{refundNames[row.refundStatus] || "退款待核实"}</small> : null}{(row.nextCancelAt || row.nextActionAt) && <small>下次处理 {time(row.nextCancelAt || row.nextActionAt)}</small>}{!row.nextCancelAt && !row.nextActionAt && (row.cancelAfter || row.cancelAllowedAt) && <small>最早取消 {time(row.cancelAfter || row.cancelAllowedAt)}</small>}</details>{row.canReconcile && <button type="button" className="text-action" disabled={Boolean(busy)} onClick={() => setDialog({ kind: "inventory", row })}>核实旧订单</button>}</td>
        </tr>)}</tbody></table>{!inventoryLoading && !inventoryError && !matchingBuffer.length && <div className="sp-empty"><PhoneIncoming size={25} /><h3>{bufferFilters.scope === "history" ? "还没有历史号码" : "当前没有符合条件的号码"}</h3><p>新的接码任务会从国家报价中按需取号。</p></div>}{inventoryLoading && <p className="sp-history-status" role="status">正在读取号码库存</p>}{!buffer && <p className="sp-history-status" role="status">尚未读取到库存，请刷新接码池。</p>}</div>
        {inventory && <nav className="sp-history-pagination" aria-label="号码库存分页"><span>共 {inventory.total} 个号码</span><div><button className="secondary-button" disabled={inventoryLoading || inventoryPage <= 1} onClick={() => setInventoryPage((value) => value - 1)}>上一页</button><span>{inventory.page} / {inventory.pages}</span><button className="secondary-button" disabled={inventoryLoading || inventoryPage >= inventory.pages} onClick={() => setInventoryPage((value) => value + 1)}>下一页</button></div></nav>}
      </section></details>}
    </div>{tab === "credentials" && <aside className="sp-rules"><div className="sp-rules-heading"><Settings2 size={17} /><h3>池规则</h3><span>对所有 CDK 生效</span></div>
      <form onSubmit={(event) => { event.preventDefault(); if (!canSave || busy) return; void perform("rules", () => saveRules(), "池规则已保存，已开始的接码按原费率结算"); }}>
        <label className="sp-toggle-row"><span><strong>向普通 CDK 开放</strong><small>关闭后停止分配新号码</small></span><input type="checkbox" role="switch" disabled={Boolean(busy)} checked={Boolean(draft?.enabled)} onChange={(event) => updateDraft({ enabled: event.target.checked })} aria-label="向普通 CDK 开放接码池" /></label>

        <div className="sp-rule-group"><h4>即时取号保护</h4><div className="sp-paired-fields"><label className="sp-number-field"><span>连续无号</span><div><input aria-label="连续无号暂停阈值" type="number" min="1" max="100" required disabled={Boolean(busy)} value={draft?.noStockThreshold ?? ""} onChange={(event) => updateDraft({ noStockThreshold: event.target.value })} /><span>次</span></div></label><label className="sp-number-field"><span>首次冷却</span><div><input aria-label="首次冷却分钟" type="number" min="1" max="1440" required disabled={Boolean(busy)} value={draft?.cooldownMinutes ?? ""} onChange={(event) => updateDraft({ cooldownMinutes: event.target.value })} /><span>分钟</span></div></label></div><p>连续无号达到阈值后暂时跳过该报价，到期由接码任务尝试恢复。</p></div>
        <div className="sp-rule-group"><div className="sp-paired-fields"><label className="sp-number-field"><span>单次取号上限</span><div><input aria-label="单次取号尝试上限" type="number" min="1" max="20" required disabled={Boolean(busy)} value={draft?.maxAttempts ?? ""} onChange={(event) => updateDraft({ maxAttempts: event.target.value })} /><span>次</span></div></label><label className="sp-number-field"><span>取号请求并发</span><div><input aria-label="取号请求并发" type="number" min="1" max="20" required disabled={Boolean(busy)} value={draft?.requestConcurrency ?? ""} onChange={(event) => updateDraft({ requestConcurrency: event.target.value })} /><span>个请求</span></div></label></div><p>仅取号请求占用名额；等待短信与手机验证期间不占用。</p></div>
        <button className="primary-button sp-save-rules" disabled={!canSave || Boolean(busy)}>{busy === "rules" ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}保存池规则</button>
      </form><div className="sp-charge-note"><ShieldCheck size={17} /><p>开始接码先预留次数，成功后正式扣除。结果不明确时保留预留，等待核实。</p></div>
    </aside>}</div>}
    {dialog?.kind === "category" && <CategoryDialog row={dialog.row} onClose={() => setDialog(null)} onSave={async (body) => { const saved = await request(dialog.row ? `/categories/${encodeURIComponent(dialog.row.id)}` : "/categories", dialog.row ? "PATCH" : "POST", body); setDialog(null); await refresh(); if (!dialog.row && saved?.savedCategory?.id) setCategoryId(saved.savedCategory.id); setNotice("分类已保存，已开始的任务按原分类与费率结算"); }} />}
    {dialog?.kind === "archive-category" && <DialogForm title={`归档 ${dialog.row.name}`} confirmation onClose={() => setDialog(null)} action="确认归档" busy={Boolean(busy)} onSubmit={(event) => { event.preventDefault(); void perform("archive-category", async () => { await request(`/categories/${encodeURIComponent(dialog.row.id)}`, "PATCH", { archived: true }); setDialog(null); }, "分类已归档，历史记录与已开始的任务继续保留"); }}><div className="sp-form-body"><p className="sp-footnote">归档后不能用于新任务。此分类的国家报价与历史费用继续保留。</p></div></DialogForm>}
    {dialog?.kind === "copy-entry" && <CopyEntryDialog row={dialog.row} categories={activeCategories} onClose={() => setDialog(null)} onSave={async (targetCategoryId) => { const row = dialog.row; const entry = Object.fromEntries(["credentialId", "country", "countryLabel", "maxPrice", "quotedPrice", "currency", "providerIds", "service", "priority", "grade", "gradeFilter"].filter((key) => row[key] !== undefined).map((key) => [key, row[key]])); await request("/entries", "POST", { entries: [{ ...entry, categoryId: targetCategoryId }] }); setDialog(null); await refresh(); setNotice("国家报价已复制到目标分类"); }} />}
    {dialog?.kind === "inventory" && <InventoryReconcileDialog row={dialog.row} onClose={() => setDialog(null)} onSave={async (body) => { await request(`/inventory/${dialog.row.id}/reconcile`, "POST", body); setDialog(null); await refresh(); setNotice("旧订单核实结果已记录，CDK接码费用按原操作保留"); }} />}
    {dialog?.kind === "credential" && <CredentialDialog row={dialog.row} onClose={() => setDialog(null)} onSave={(body) => request("/credentials", "POST", body)} onSaved={async () => { setDialog(null); await refresh(); setNotice("服务商凭据已保存"); }} />}
    {dialog?.kind === "entry" && <EntryDialog categoryId={categoryId} categoryName={currentCategory?.name} credentials={credentials} existingEntries={allEntries} request={request} onClose={() => setDialog(null)} onSaved={async () => { setDialog(null); await refresh(); setNotice("国家报价已加入池"); }} />}
    {dialog?.kind === "edit" && <EditEntryDialog row={dialog.row} categories={activeCategories} onClose={() => setDialog(null)} onSave={async (body) => { await request(`/entries/${dialog.row.id}`, "PATCH", body); setDialog(null); await refresh(); setNotice("条目已更新，已分配的订单继续按原配置处理"); }} />}
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

function EntryDialog({ categoryId, categoryName, credentials, existingEntries = [], request, onClose, onSaved }) {
  const [credentialId, setCredentialId] = useState(credentials.find((row) => row.enabled)?.id || "");
  const [options, setOptions] = useState([]); const [selected, setSelected] = useState(new Set());
  const [query, setQuery] = useState(""); const [priority, setPriority] = useState("10"); const [gradeFilter, setGradeFilter] = useState("all");
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false); const [loaded, setLoaded] = useState(false); const [error, setError] = useState("");
  const ref = useRef(null); useDialogFocus(true, () => { if (!busy) onClose(); }, ref);
  const credential = credentials.find((row) => row.id === credentialId);
  const existing = new Set(existingEntries.filter((row) => row.categoryId === categoryId).map((row) => quoteRoute(row)));
  const shown = options.filter((row) => `${optionLabel(row)} ${row.country}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (credential?.providerId !== "smsbower" || gradeFilter === "all" || (row.grade === "gold" ? "gold" : "unknown") === gradeFilter));
  async function load() { setLoading(true); setError(""); setOptions([]); setSelected(new Set()); setLoaded(false); try { const value = await request(`/credentials/${credentialId}/options`, "POST", {}); const rows = Array.isArray(value.options || value) ? value.options || value : []; setOptions([...new Map(rows.map((row) => [quoteRoute(row, credentialId, categoryId), row])).values()]); setLoaded(true); } catch (failure) { setError(failure.message); } finally { setLoading(false); } }
  return <div className="modal-backdrop sp-dialog-backdrop"><form ref={ref} className="sp-dialog sp-quote-dialog" role="dialog" aria-modal="true" aria-label="添加国家报价" onSubmit={async (event) => { event.preventDefault(); if (!categoryId || !selected.size || busy || loading || !validInteger(priority, 0, 10000)) return; setBusy(true); setError(""); try { await request("/entries", "POST", { entries: [...selected].map((index) => { const row = options[index]; return { categoryId, credentialId, country: String(row.country), countryLabel: optionLabel(row), maxPrice: String(row.price), quotedPrice: String(row.price), currency: row.currency || "", providerIds: row.providerIds || "", ...(credential?.providerId === "smsbower" ? { grade: row.grade === "gold" ? "gold" : "unknown", gradeFilter: row.grade === "gold" ? "gold" : "unknown" } : {}), priority: Number(priority), enabled: true }; }) }); await onSaved(); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }}>
    <header><div><h2>添加国家报价</h2><p>加入 {categoryName || "当前分类"}，可同时选择多个国家和价格档位。</p></div><button type="button" className="icon-button" aria-label="关闭添加国家报价" disabled={busy} onClick={onClose}><X size={18} /></button></header>
    <div className="sp-form-body"><div className="sp-quote-source"><label className="sp-field">服务商凭据<select aria-label="选择服务商凭据" value={credentialId} disabled={loading || busy} onChange={(event) => { setCredentialId(event.target.value); setOptions([]); setSelected(new Set()); setQuery(""); setGradeFilter("all"); setLoaded(false); }}>{credentials.filter((row) => row.enabled).map((row) => <option key={row.id} value={row.id}>{row.name} / {platforms[row.providerId]}</option>)}</select></label><button type="button" className="secondary-button" disabled={!credentialId || loading || busy} onClick={() => void load()}>{loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}查询国家报价</button></div>
    {options.length > 0 && <div className="sp-quote-filters"><label className="sp-search"><Search size={16} /><input aria-label="搜索可添加国家" placeholder="搜索国家 / ID" value={query} onChange={(event) => setQuery(event.target.value)} /></label>{credential?.providerId === "smsbower" && <label className="sp-quote-grade"><span>供应商档位</span><select aria-label="筛选可添加报价档位" value={gradeFilter} onChange={(event) => setGradeFilter(event.target.value)}><option value="all">全部档位</option><option value="gold">Gold</option><option value="unknown">其他（未标级）</option></select></label>}</div>}
    <div className="sp-quote-options">{shown.map((row) => { const index = options.indexOf(row); const added = existing.has(quoteRoute(row, credentialId, categoryId)); return <label className={`sp-quote-option ${selected.has(index) ? "selected" : ""} ${added ? "sp-quote-added" : ""}`} key={quoteRoute(row, credentialId, categoryId)}><input type="checkbox" checked={selected.has(index)} disabled={busy || added || selected.size >= 100 && !selected.has(index)} onChange={() => setSelected((previous) => { const next = new Set(previous); next.has(index) ? next.delete(index) : next.add(index); return next; })} /><span><strong>{optionLabel(row)}</strong><small>{added ? "已在池中 / " : ""}{credential?.providerId === "smsbower" ? `${row.grade === "gold" ? "Gold" : "未标级"} / ` : ""}库存 {row.count ?? "未知"}</small></span><span className="sp-price"><strong>{row.price}</strong><small>{row.currency || "平台币种"}</small></span></label>; })}{!options.length && <div className="sp-empty"><Globe2 size={25} /><p>{loading ? "正在查询国家、报价和库存" : loaded ? "当前暂无可用报价，请稍后重新查询。" : "选择凭据后查询国家报价。查询不会购买号码。"}</p></div>}{options.length > 0 && !shown.length && <p className="sp-footnote">没有匹配的国家或档位，请调整筛选。</p>}</div>
    <label className="sp-number-field sp-priority-input"><span>所选条目优先级</span><div><input aria-label="新增条目优先级" type="number" min="0" max="10000" required value={priority} onChange={(event) => setPriority(event.target.value)} /><span>越小越优先</span></div></label>{error && <p className="sp-error" role="alert">{error}</p>}</div>
    <footer><span>已选 {selected.size} 条报价，最多 100 条</span><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={!categoryId || !selected.size || loading || busy || !validInteger(priority, 0, 10000)}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}加入接码池</button></footer>
  </form></div>;
}

function EditEntryDialog({ row, categories = [], onClose, onSave }) {
  const [priority, setPriority] = useState(String(row.priority)); const [entryCategoryId, setEntryCategoryId] = useState(row.categoryId || ""); const [enabled, setEnabled] = useState(row.enabled !== false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  return <DialogForm title="编辑国家报价" onClose={onClose} busy={busy} error={error} canSubmit={Boolean(categories.some((category) => category.id === entryCategoryId) && validInteger(priority, 0, 10000))} onSubmit={async (event) => { event.preventDefault(); if (!categories.some((category) => category.id === entryCategoryId) || !validInteger(priority, 0, 10000)) return; setBusy(true); try { await onSave({ categoryId: entryCategoryId, priority: Number(priority), enabled }); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }}><div className="sp-form-body"><div className="sp-edit-country"><Globe2 size={23} /><div><strong>{row.countryLabel}</strong><small>{platforms[row.providerId]} / 价格上限 {row.maxPrice} {row.currency}</small></div></div><label className="sp-field">所属分类<select aria-label="报价所属分类" value={entryCategoryId} onChange={(event) => setEntryCategoryId(event.target.value)} required><option value="" disabled>选择分类</option>{entryCategoryId && !categories.some((category) => category.id === entryCategoryId) && <option value={entryCategoryId} disabled>原分类已归档，请选择新分类</option>}{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label className="sp-field">优先级<input type="number" min="0" max="10000" required value={priority} onChange={(event) => setPriority(event.target.value)} /></label><label className="sp-check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用此条目</label><p className="sp-footnote">调整报价请重新查询后添加。已有订单按取号时的配置完成。</p></div></DialogForm>;
}

function CategoryDialog({ row, onClose, onSave }) {
  const [name, setName] = useState(row?.name || ""); const [fee, setFee] = useState(String(row?.fee ?? 2)); const [enabled, setEnabled] = useState(row?.enabled !== false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const valid = Boolean(name.trim() && name.trim().length <= 40 && validInteger(fee, 1, 1000000));
  return <DialogForm title={row ? "编辑接码池分类" : "新增接码池分类"} onClose={onClose} busy={busy} error={error} canSubmit={valid} action="保存分类" onSubmit={async (event) => { event.preventDefault(); if (!valid || busy) return; setBusy(true); try { await onSave({ name: name.trim(), fee: Number(fee), enabled }); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }}><div className="sp-form-body"><label className="sp-field">分类名称<input aria-label="分类名称" required maxLength={40} value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：美区" /></label><label className="sp-field">验证成功扣次<input aria-label="分类验证成功扣次" type="number" min="1" max="1000000" required value={fee} onChange={(event) => setFee(event.target.value)} /></label><label className="sp-check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />向用户开放此分类</label><p className="sp-footnote">改价适用于之后开始的任务。已经开始的接码按原费率结算。</p></div></DialogForm>;
}
function CopyEntryDialog({ row, categories, onClose, onSave }) {
  const [target, setTarget] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  return <DialogForm title="复制国家报价到分类" onClose={onClose} busy={busy} error={error} canSubmit={Boolean(target)} action="确认复制" onSubmit={async (event) => { event.preventDefault(); if (!target || busy) return; setBusy(true); try { await onSave(target); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }}><div className="sp-form-body"><p className="sp-footnote">{row.countryLabel || row.country} · 价格上限 {row.maxPrice} {row.currency || "平台币种"}</p><label className="sp-field">目标分类<select aria-label="复制报价目标分类" required value={target} onChange={(event) => setTarget(event.target.value)}><option value="">选择目标分类</option>{categories.filter((category) => category.id !== row.categoryId).map((category) => <option key={category.id} value={category.id}>{category.name}{!category.enabled ? "（已停用）" : ""}</option>)}</select></label><p className="sp-footnote">原报价继续保留。同一路由可以分别加入多个分类。</p></div></DialogForm>;
}

function InventoryReconcileDialog({ row, onClose, onSave }) {
  const [confirmed, setConfirmed] = useState(false); const [note, setNote] = useState(""); const [refundEvidence, setRefundEvidence] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const canSubmit = confirmed && note.trim().length >= 3 && note.trim().length <= 500 && (!refundEvidence.trim() || refundEvidence.trim().length >= 3);
  return <DialogForm title="核实旧订单" onClose={onClose} busy={busy} error={error} canSubmit={canSubmit} action="确认结束订单" onSubmit={async (event) => { event.preventDefault(); if (!canSubmit || busy) return; setBusy(true); setError(""); try { await onSave({ action: "close", note: note.trim(), ...(refundEvidence.trim() ? { refundEvidence: refundEvidence.trim() } : {}) }); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }}><div className="sp-form-body"><p className="sp-inventory-phone">{inventoryPhone(row.phone)}</p><p className="sp-footnote">核对服务商订单后，可结束该旧订单记录。CDK 接码费用按原操作保留。</p><label className="sp-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />已核实服务商没有该号码的活跃订单</label><label className="sp-field">核实依据<textarea aria-label="旧订单核实依据" required minLength={3} maxLength={500} rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="填写服务商订单状态和核查依据，不填写验证码或密钥" /></label><label className="sp-field">退款凭证（可选）<textarea aria-label="旧订单退款凭证" minLength={3} maxLength={500} rows={2} value={refundEvidence} onChange={(event) => setRefundEvidence(event.target.value)} placeholder="有可核对的退款记录时填写，留空保持退款待核实" /></label><p className="sp-footnote">取消已确认仍需单独核实退款结果。</p></div></DialogForm>;
}

function ReconcileDialog({ row, onClose, onSave }) {
  const [action, setAction] = useState("release"); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  return <DialogForm title="核实接码结果" onClose={onClose} busy={busy} error={error} action="记录核实结果" onSubmit={async (event) => { event.preventDefault(); setBusy(true); try { await onSave({ action, note }); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }}><div className="sp-form-body"><p>{row.email || row.accountEmail}</p><p className="sp-footnote">预留 {row.fee ?? row.feeSnapshot} 次。请核对目标服务的验证结果，服务商收到短信不等于验证通过。</p><label className="sp-field">核实结论<select value={action} onChange={(event) => setAction(event.target.value)}><option value="release">确认未成功，释放预留</option><option value="verified">确认验证成功，扣除次数</option></select></label><label className="sp-field">处理说明<textarea required minLength={3} maxLength={200} rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="填写核查依据，不填写验证码或密钥" /></label></div></DialogForm>;
}

export function SmsPoolChoice({ token, summary: providedSummary, value = "", onChange, onSummary, onManage }) {
  const [summary, setSummary] = useState(providedSummary || null); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const requestVersion = useRef(0); const onSummaryRef = useRef(onSummary); onSummaryRef.current = onSummary;
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true); setError("");
    try { let data = providedSummary; if (!data) { const response = await cdkFetch("/api/sms-pool", { headers: { "x-console-token": token } }); data = await response.json(); if (!response.ok) throw new Error(data.error || "读取接码池失败"); } if (version === requestVersion.current) { setSummary(data); onSummaryRef.current?.(data); } }
    catch (failure) { if (version === requestVersion.current) { setSummary(null); setError(failure.message); } }
    finally { if (version === requestVersion.current) setLoading(false); }
  }, [token, providedSummary]);
  useEffect(() => { void refresh(); return () => { requestVersion.current++; }; }, [refresh]);
  useEffect(() => { if (providedSummary) return undefined; const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 5000); return () => window.clearInterval(timer); }, [refresh, providedSummary]);
  const categories = Array.isArray(summary?.categories) ? summary.categories : [];
  const category = categories.find((row) => row.id === value);
  const invalid = Boolean(value && summary && (!category || !category.enabled));
  const available = Boolean(summary?.enabled && category?.enabled && category.available);
  const status = !summary ? error ? "读取失败" : "正在读取" : !summary.enabled ? "暂未开放" : invalid ? "请重新选择" : !value ? "选择分类" : available ? "可按需取号" : "暂不可用";
  return <div className="sp-choice"><div className="sp-choice-heading"><span className="sp-choice-icon"><PhoneIncoming size={23} /></span><div><h3>接码池</h3><p>接码任务开始后按需取号</p></div><span className={`sp-state ${available ? "sp-state-available" : "sp-state-disabled"}`}><i />{status}</span></div><label className="sp-field sp-choice-category">接码池分类<select aria-label="选择接码池分类" value={value} onChange={(event) => onChange?.(event.target.value)} disabled={loading || !summary}><option value="">请选择分类</option>{value && !category && <option value={value} disabled>原分类已失效，请重新选择</option>}{categories.map((row) => <option key={row.id} value={row.id} disabled={!row.enabled}>{row.name} · 成功扣 {row.fee} 次{!row.enabled ? "（已停用）" : ""}</option>)}</select></label>{invalid && <p className="sp-error" role="alert">所选分类已停用或归档，请重新选择。已有任务继续使用开始时的分类。</p>}<div className="sp-choice-fee"><span>{category ? `${category.name} · 每次验证成功` : "每次验证成功"}</span><strong>{category && Number.isSafeInteger(category.fee) && category.fee >= 1 ? category.fee : "—"}<small> 次</small></strong><p>开始时预留，验证码通过后扣除；明确失败释放预留。</p></div><div className="sp-choice-steps"><span><span>取号与收码</span><small>开始接码后自动取号</small></span><ChevronRight size={15} /><span><span>手机验证</span><small>目标服务确认通过</small></span><ChevronRight size={15} /><span><span>完成扣次</span><small>同次重试仅扣一次</small></span></div>{error && <p role="alert" className="sp-error">{error}</p>}<div className="sp-choice-footer"><span>{!summary ? error ? "接码池状态未知，请重新读取。" : "正在读取接码池状态。" : !summary.enabled ? "管理员尚未开放接码池。" : !value ? "选择分类后保存配置。" : available ? "开始接码后自动获取号码。" : "当前分类暂不可取号，请重新选择或稍后重试。"}</span><button type="button" className="text-action" disabled={loading} onClick={() => void refresh()}><RefreshCw size={13} className={loading ? "spin" : ""} />刷新状态</button>{onManage && <button type="button" className="text-action" onClick={onManage}>管理接码池</button>}</div></div>;
}

export function SmsPoolChargeDialog({ quote, onClose }) {
  const fee = quote.admin ? 0 : quote.fee;
  return <DialogForm title="确认使用接码池" confirmation onClose={() => onClose(null)} onSubmit={(event) => { event.preventDefault(); onClose({ id: "pool", config: { categoryId: quote.categoryId, quotedFee: quote.fee, feeVersion: quote.feeVersion } }); }} action="确认开始接码"><div className="sp-form-body"><p className="sp-confirm-category">接码池 · {quote.categoryName || "所选分类"}</p><div className="sp-choice-fee"><span>每个账号验证成功扣除</span><strong>{fee}<small> 次</small></strong><p>本次最多 {quote.count} 个账号，最多扣 {quote.count * fee} 次。每个账号实际取号前预留，余额不足时停止取号。</p></div><p className="sp-footnote">只有手机验证码通过才正式扣次。后续授权文件生成失败不退本次接码费用。取号失败或验证未通过将释放预留，结果不明确时等待核实。</p>{quote.fixed && <p className="sp-footnote">此任务沿用开始时的分类与费率，当前配置不会改变它。</p>}{quote.admin && <p className="sp-footnote">当前为管理员自己的工作区，本次接码不扣 CDK 次数。</p>}</div></DialogForm>;
}
