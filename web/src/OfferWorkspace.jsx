import React, { useCallback, useEffect, useRef, useState } from "react";
import { Ban, Check, ChevronLeft, ChevronRight, CircleAlert, Copy, Download, FileText, History, LoaderCircle, Plus, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { Drawer, useDialogFocus } from "./WorkspaceUi.jsx";
import { cdkFetch, readWorkspaceValue } from "./cdk-api.mjs";
import "./offers.css";

export const OFFER_LABELS = { trial_1m: "Plus 免费试用 1 个月", half_1m: "Plus 半价 1 个月", half_2m: "Plus 半价 2 个月", half_3m: "Plus 半价 3 个月", subscribed: "已订阅", none: "无优惠", other: "其他优惠／待识别", banned: "账号已停用" };
const STATES = { queued: "排队中", running: "检测中", waiting_input: "待输入", completed: "已完成", failed: "失败", cancelled: "已停止", interrupted: "已中断", paused: "余额不足，已暂停", stopped: "已停止" };
const RETRYABLE = new Set(["failed", "cancelled", "interrupted", "queued"]);
const time = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const requestKey = () => crypto.randomUUID().replace(/-/g, "");
const initialFilters = { search: "", status: "all", kinds: [], startDate: "", endDate: "" };
function serverFilters(filters) {
  const end = filters.endDate ? new Date(`${filters.endDate}T00:00:00`) : null;
  if (end) end.setDate(end.getDate() + 1);
  return { search: filters.search, status: filters.status, kinds: filters.kinds,
    checkedAfter: filters.startDate ? new Date(`${filters.startDate}T00:00:00`).toISOString() : "", checkedBefore: end ? end.toISOString() : "" };
}

export default function OfferWorkspace({ token, balance }) {
  const [batches, setBatches] = useState([]); const [batchId, setBatchId] = useState("");
  const [tab, setTab] = useState("accounts"); const [filters, setFilters] = useState(initialFilters);
  const [data, setData] = useState({ items: [], selection: [], total: 0, page: 1, pages: 1 }); const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(() => new Set()); const [importOpen, setImportOpen] = useState(false);
  const [retryRequest, setRetryRequest] = useState(null);
  const [exportPreview, setExportPreview] = useState(null); const [exportFormat, setExportFormat] = useState("accounts");
  const [detailId, setDetailId] = useState(null); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [blocked, setBlocked] = useState(balance < 1); const [loaded, setLoaded] = useState(false); const [busy, setBusy] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0); const pending = useRef(false);
  const request = useCallback(async (route, options = {}) => {
    const response = await cdkFetch(`/api/offers/${route}`, { ...options, headers: { "content-type": "application/json", "x-console-token": token, ...options.headers } });
    const value = await response.json();
    if (!response.ok) { if (value.code === "OFFER_BALANCE_REQUIRED" || response.status === 401) setBlocked(true); throw new Error(value.error || "请求未完成"); }
    setBlocked(false); return value;
  }, [token]);
  const post = (route, body = {}) => request(route, { method: "POST", body: JSON.stringify(body) });
  const refresh = () => setRefreshVersion((value) => value + 1);
  const chooseBatch = (id) => { setBatchId(id); setData({ items: [], selection: [], total: 0, page: 1, pages: 1 }); setFilters(initialFilters); setPage(1); setSelected(new Set()); setDetailId(null); setRetryRequest(null); };
  useEffect(() => {
    let stopped = false; let timer; const controller = new AbortController();
    const poll = async () => {
      try {
        const value = await request("batches", { signal: controller.signal });
        if (stopped) return;
        setBatches(value.batches); setLoaded(true); setError("");
        if (!batchId && value.batches.length) { setBatchId(value.batches[0].id); return; }
        if (batchId) {
          const result = await request(`${batchId}/query`, { method: "POST", body: JSON.stringify({ ...serverFilters(filters), page }), signal: controller.signal });
          if (!stopped) setData(result);
        }
      } catch (failure) { if (!stopped) { setError(failure.message); setLoaded(true); } }
      finally { if (!stopped) timer = window.setTimeout(poll, 1800); }
    };
    void poll(); return () => { stopped = true; controller.abort(); window.clearTimeout(timer); };
  }, [request, batchId, filters, page, refreshVersion]);
  useEffect(() => { if (blocked) { setExportPreview(null); setImportOpen(false); setDetailId(null); setRetryRequest(null); } }, [blocked]);
  const perform = async (key, operation) => {
    if (pending.current) return; pending.current = true; setBusy(key); setError(""); setNotice("");
    try { await operation(); refresh(); } catch (failure) { setError(failure.message); }
    finally { pending.current = false; setBusy(""); }
  };
  const current = data.batch?.id === batchId ? data.batch : batches.find((row) => row.id === batchId);
  const detail = data.items.find((row) => row.id === detailId);
  const pageSelected = data.items.length > 0 && data.items.every((row) => selected.has(row.id));
  const updateFilters = (patch) => { setFilters((value) => ({ ...value, ...patch })); setPage(1); setSelected(new Set()); setDetailId(null); };
  const toggle = (id) => setSelected((values) => { const next = new Set(values); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const showExport = (onlySelected) => perform("export", async () => {
    const value = await post(`${batchId}/export`, { format: exportFormat, ...(onlySelected ? { ids: [...selected] } : { filters: serverFilters(filters) }) });
    setExportPreview(value);
  });
  const resume = () => setRetryRequest({ batchId, ids: selected.size ? [...selected] : null });
  const recheck = () => perform("recheck", async () => {
    const value = await post(`${batchId}/recheck`, { requestKey: requestKey(), ...(selected.size ? { ids: [...selected] } : { filters: serverFilters(filters) }) }); chooseBatch(value.id);
  });
  if (blocked) return <section className="workspace offer-workspace"><header className="offer-heading"><div><h2>优惠检测</h2><p>导入账号，按批次查看优惠并筛选导出。</p></div></header><div className="offer-access" role="status"><CircleAlert size={27} /><h3>需要可用余额至少为 1 的有效 CDK</h3><p>本功能不扣次数。补充余额或切换 CDK 后即可使用。</p><button type="button" className="secondary-button" onClick={refresh}><RefreshCw size={15} />重新检查资格</button></div></section>;
  return <section className="workspace offer-workspace" aria-labelledby="offer-title">
    <header className="offer-heading"><div><h2 id="offer-title">优惠检测</h2><p>导入、检测、筛选，每一批结果单独保留。<span>检测不扣次数</span></p></div><button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => setImportOpen(true)}><Plus size={16} />导入并检测</button></header>
    <nav className="offer-tabs" aria-label="优惠检测视图">{[["accounts", "检测账号"], ["history", "批次记录"]].map(([key, label]) => <button key={key} type="button" aria-pressed={tab === key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{key === "history" && <History size={15} />}{label}</button>)}</nav>
    {error && <div className="global-error" role="alert"><CircleAlert size={16} /><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="关闭检测错误"><X size={15} /></button></div>}
    {notice && <p className="offer-notice" role="status">{notice}</p>}
    {tab === "history" ? <div className="table-frame"><table className="offer-table offer-history"><thead><tr><th>检测批次</th><th>状态</th><th>已处理 / 总数</th><th>有优惠</th><th>失败 / 待输入</th><th>操作</th></tr></thead><tbody>{batches.map((row) => <tr key={row.id}><td data-label="批次"><strong>{row.name}</strong><small>{time(row.createdAt)}</small></td><td data-label="状态">{STATES[row.status]}</td><td data-label="进度">{row.processed} / {row.total}</td><td data-label="有优惠">{row.offers}</td><td data-label="失败 / 待输入">{row.counts.failed || 0} / {row.counts.waiting_input || 0}</td><td><button className="text-action" type="button" onClick={() => { chooseBatch(row.id); setTab("accounts"); }}>查看批次</button></td></tr>)}</tbody></table>{!batches.length && <OfferEmpty loaded={loaded} onImport={() => setImportOpen(true)} />}</div>
      : <><div className="offer-batchbar"><label>当前批次<select aria-label="选择检测批次" value={batchId} onChange={(event) => chooseBatch(event.target.value)}>{!batches.length && <option value="">暂无批次</option>}{batches.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label><div><button type="button" className="text-action" onClick={refresh}><RefreshCw size={14} />刷新</button>{current && ["running", "paused"].includes(current.status) && <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void perform("stop", () => post(`${batchId}/stop`))}><Ban size={14} />停止批次</button>}{current && current.status !== "running" && <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void resume()}><RefreshCw size={14} />继续 / 重试失败</button>}</div></div>
        {current && <><div className="offer-progress" aria-label="批次统计"><div className="offer-progress-main"><span>{STATES[current.status]}</span><strong>{current.processed}<small> / {current.total}</small></strong><span>已处理（含失败）</span></div><div className="offer-progress-track"><div className="offer-progress-counts"><span>有优惠 <b>{current.offers}</b></span><span>无优惠 <b>{current.categories.none || 0}</b></span><span>已订阅 <b>{current.categories.subscribed || 0}</b></span><span>失败 <b>{current.counts.failed || 0}</b></span><span>排队 / 检测中 <b>{current.counts.queued || 0} / {current.counts.running || 0}</b></span><span>待输入 <b>{current.counts.waiting_input || 0}</b></span><span>取消 / 中断 <b>{(current.counts.cancelled || 0) + (current.counts.interrupted || 0)}</b></span></div><progress value={current.processed} max={current.total || 1} aria-label="批次已处理进度" /><p>优惠命中率 {current.hitRate === null ? "—" : `${(current.hitRate * 100).toFixed(1)}%`}<span>按有优惠与明确无优惠账号计算</span></p></div></div>
          <div className="offer-categories" aria-label="优惠分类快捷筛选">{Object.entries(OFFER_LABELS).map(([kind, label]) => <button key={kind} type="button" aria-pressed={filters.kinds.includes(kind)} onClick={() => updateFilters({ kinds: filters.kinds.includes(kind) ? filters.kinds.filter((value) => value !== kind) : [...filters.kinds, kind] })}>{label}<span>{current.categories[kind] || 0}</span></button>)}</div></>}
        <div className="offer-filters"><label className="offer-search"><Search size={16} /><input aria-label="搜索检测邮箱" placeholder="搜索邮箱" value={filters.search} onChange={(event) => updateFilters({ search: event.target.value })} /></label><select aria-label="筛选检测执行状态" value={filters.status} onChange={(event) => updateFilters({ status: event.target.value })}><option value="all">全部执行状态</option>{["queued", "running", "waiting_input", "completed", "failed", "cancelled", "interrupted"].map((key) => <option key={key} value={key}>{STATES[key]}</option>)}</select><label>检测时间<input type="date" aria-label="检测开始日期" value={filters.startDate} onChange={(event) => updateFilters({ startDate: event.target.value })} /></label><span>至</span><input type="date" aria-label="检测结束日期" value={filters.endDate} min={filters.startDate} onChange={(event) => updateFilters({ endDate: event.target.value })} /><button type="button" className="text-action" onClick={() => updateFilters(initialFilters)}>清除筛选</button></div>
        <div className="offer-selection"><div><strong>已选 {selected.size} 个</strong><button type="button" className="text-action" disabled={!data.total} onClick={() => setSelected(new Set(data.selection))}>全选筛选结果（{data.total}）</button><button type="button" className="text-action" disabled={!selected.size} onClick={() => setSelected(new Set())}>清除选择</button></div><div><label className="offer-export-format">导出内容<select aria-label="优惠导出内容" value={exportFormat} onChange={(event) => setExportFormat(event.target.value)}><option value="accounts">原始账号资料</option><option value="report">检测报告</option><option value="csv">CSV 数据</option><option value="json">JSON 数据</option></select></label><button type="button" className="secondary-button" disabled={!selected.size || Boolean(busy)} onClick={() => void showExport(true)}><FileText size={14} />导出所选</button><button type="button" className="secondary-button" disabled={!data.total || Boolean(busy)} onClick={() => void showExport(false)}>导出筛选结果</button></div></div>
        <div className="table-frame"><table className="offer-table"><thead><tr><th className="select-heading"><input type="checkbox" checked={pageSelected} disabled={!data.items.length} aria-label="选择当前页检测账号" onChange={() => setSelected((values) => { const next = new Set(values); data.items.forEach((row) => pageSelected ? next.delete(row.id) : next.add(row.id)); return next; })} /></th><th>账号</th><th>优惠结果</th><th>执行状态</th><th>检测时间</th><th>操作</th></tr></thead><tbody>{data.items.map((row) => <tr key={row.id} className={selected.has(row.id) ? "selected-row" : ""}><td className="select-cell"><input type="checkbox" aria-label={`选择检测账号 ${row.email}`} checked={selected.has(row.id)} onChange={() => toggle(row.id)} /></td><td data-label="账号"><strong className="offer-email">{row.email}</strong><small>{row.hasSession ? "已导入登录信息" : row.hasPassword ? "已导入密码" : row.hasMailbox ? "已配置邮件取件" : "执行时匹配已有资料"}</small></td><td data-label="优惠结果"><span className={`offer-result offer-result-${row.result?.kind || "unknown"}`}>{row.result?.label || "尚未获得结论"}</span>{row.result?.planType && row.result.kind === "subscribed" && <small>{row.result.planType}</small>}{row.status !== "completed" && row.result && <small>上次结果，本次未确认</small>}</td><td data-label="执行状态"><span className={`offer-state offer-state-${row.status}`}>{row.status === "running" && <LoaderCircle size={13} className="spin" />}{STATES[row.status]}</span>{row.message && <small>{row.message}</small>}{row.errorStageLabel && <small>失败阶段：{row.errorStageLabel}</small>}{row.status === "waiting_input" && <OfferInput key={row.promptId} row={row} disabled={Boolean(busy)} onSubmit={(value) => perform("input", () => post(`${batchId}/input`, { id: row.id, promptId: row.promptId, value }))} />}</td><td data-label="检测时间">{time(row.result?.checkedAt)}</td><td data-label="操作"><button className="text-action" type="button" onClick={() => setDetailId(row.id)}>查看详情</button></td></tr>)}</tbody></table>{!data.items.length && <OfferEmpty loaded={loaded} hasBatch={Boolean(current)} onImport={() => setImportOpen(true)} />}</div>
        <div className="offer-pagination"><span>匹配 {data.total} 条 · 每页 20 条</span><div><button type="button" className="icon-button" aria-label="优惠上一页" disabled={data.page <= 1} onClick={() => setPage(data.page - 1)}><ChevronLeft size={16} /></button><span>{data.page} / {data.pages}</span><button type="button" className="icon-button" aria-label="优惠下一页" disabled={data.page >= data.pages} onClick={() => setPage(data.page + 1)}><ChevronRight size={16} /></button></div></div>
        {current && current.status !== "running" && <p className="offer-recheck"><button type="button" className="text-action" disabled={Boolean(busy) || !data.total} onClick={() => void recheck()}>重新检测{selected.size ? `所选 ${selected.size} 个账号` : "筛选结果"}</button><span>创建新批次，保留这次结果</span></p>}
      </>}
    {importOpen && <OfferImportDialog request={request} onClose={() => setImportOpen(false)} onStarted={(value) => { setImportOpen(false); chooseBatch(value.id); setTab("accounts"); refresh(); }} />}
    {retryRequest && <OfferRetryDialog onClose={() => setRetryRequest(null)} selectedCount={retryRequest.ids?.length} onRetry={async (network) => { await post(`${retryRequest.batchId}/retry`, { ...(retryRequest.ids ? { ids: retryRequest.ids } : {}), ...network }); setNotice("已将失败、中断或未完成账号重新排队，已完成结果保留。"); setRetryRequest(null); refresh(); }} />}
    {exportPreview && <OfferExportDialog data={exportPreview} onClose={() => setExportPreview(null)} verifyAccess={() => request("access")} />}
    {detail && <Drawer title="优惠检测详情" onClose={() => setDetailId(null)} wide><p className="detail-email">{detail.email}</p><section className="detail-section"><h3>检测结论</h3><p>{detail.result?.label || "尚未获得结论"}</p>{detail.result?.campaignId && <p className="offer-campaign">活动 ID：{detail.result.campaignId}</p>}<p>{detail.message}</p>{detail.errorStageLabel && <p>失败阶段：{detail.errorStageLabel}</p>}<small>检测于 {time(detail.result?.checkedAt)}。结果为该次查询返回的优惠资格。</small></section>{detail.status === "waiting_input" && <OfferInput key={detail.promptId} row={detail} disabled={Boolean(busy)} onSubmit={(value) => perform("input", () => post(`${batchId}/input`, { id: detail.id, promptId: detail.promptId, value }))} />}{RETRYABLE.has(detail.status) && current?.status !== "running" && <OfferCredentials key={detail.id} onSave={({ credentials, proxyUrl }) => perform("retry", async () => { await post(`${batchId}/retry`, { ids: [detail.id], credentials, proxyUrl }); setDetailId(null); })} busy={Boolean(busy)} />}<section className="detail-section"><h3>执行记录</h3><ol className="offer-events">{detail.history.map((event, index) => <li key={index}><time>{time(event.at)}</time><span>{STATES[event.status]}{event.code ? ` · ${event.code}` : ""}</span></li>)}</ol></section></Drawer>}
  </section>;
}

function OfferEmpty({ loaded, hasBatch, onImport }) {
  return <div className="empty-state offer-empty"><Sparkles size={27} /><h3>{!loaded ? "正在读取检测记录" : hasBatch ? "没有匹配账号" : "导入第一批账号"}</h3><p>{hasBatch ? "调整优惠类型、执行状态或检测时间。" : "支持文本、TXT 和 JSON。检测完成后可以筛选、复制或下载结果。"}</p>{!hasBatch && <button type="button" className="secondary-button" onClick={onImport}>导入并检测</button>}</div>;
}
export function OfferInput({ row, disabled, onSubmit }) {
  const [value, setValue] = useState(""); const password = row.promptKind === "password";
  return <form className="offer-input" onSubmit={(event) => { event.preventDefault(); if (password ? value.length > 0 : /^\d{6}$/.test(value)) void onSubmit(value); }}><label>{password ? "输入登录密码" : row.promptKind === "totp" ? "输入当前 MFA 验证码" : "输入邮箱验证码"}<input type={password ? "password" : "text"} inputMode={password ? undefined : "numeric"} maxLength={password ? 256 : 6} autoComplete="off" aria-label={`为 ${row.email} 输入${password ? "密码" : "验证码"}`} value={value} onChange={(event) => setValue(password ? event.target.value : event.target.value.replace(/\D/g, ""))} disabled={disabled} /></label><button className="secondary-button" disabled={disabled || (password ? !value : !/^\d{6}$/.test(value))}>继续</button>{row.promptKind === "email" && <button type="button" className="text-action" disabled={disabled} onClick={() => void onSubmit("r")}>重新发送</button>}</form>;
}
function OfferCredentials({ onSave, busy }) {
  const [password, setPassword] = useState(""); const [totpSecret, setTotp] = useState(""); const [mailApiUrl, setMail] = useState("");
  const [proxyUrl, setProxy] = useState(() => readWorkspaceValue("chatgpt-onboarding.account-proxy-v1") || "");
  return <form className="offer-credentials" onSubmit={(event) => { event.preventDefault(); void onSave({ credentials: { ...(password ? { password } : {}), ...(totpSecret ? { totpSecret } : {}), ...(mailApiUrl ? { mailApiUrl } : {}) }, proxyUrl: proxyUrl.trim() }); }}><h3>补充资料并重试</h3><label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" disabled={busy} /></label><label>MFA 密钥<input type="password" value={totpSecret} onChange={(event) => setTotp(event.target.value)} autoComplete="off" disabled={busy} /></label><label>取件 URL<input type="url" value={mailApiUrl} onChange={(event) => setMail(event.target.value)} autoComplete="off" disabled={busy} /></label><label>本次重试代理<input aria-label="本次重试代理" type="password" value={proxyUrl} onChange={(event) => setProxy(event.target.value)} autoComplete="off" spellCheck="false" placeholder="留空使用本地网络" disabled={busy} /></label><p className="cdk-helper">默认填入当前工作区代理；可修改，留空则本次直连。只更新此账号任务使用的代理，不修改工作区配置。</p><button className="secondary-button" disabled={busy}>重试这个账号</button></form>;
}

export function OfferRetryDialog({ selectedCount, onClose, onRetry }) {
  const [mode, setMode] = useState("keep");
  const [proxyUrl, setProxy] = useState(() => readWorkspaceValue("chatgpt-onboarding.account-proxy-v1") || "");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  return <Drawer title="继续 / 重试失败" onClose={() => { if (!busy) onClose(); }}>
    <form className="offer-credentials" onSubmit={async (event) => { event.preventDefault(); if (busy) return; setBusy(true); setError(""); try { await onRetry(mode === "keep" ? {} : { proxyUrl: mode === "direct" ? "" : proxyUrl.trim() }); } catch (failure) { setError(failure.message); } finally { setBusy(false); } }}>
      <p className="cdk-helper">{selectedCount ? `处理选中的 ${selectedCount} 个账号中的` : "处理当前批次的"}失败、中断或未完成任务；已完成结果保留。</p>
      <label>本次网络方式<select aria-label="重试代理方式" value={mode} onChange={(event) => setMode(event.target.value)} disabled={busy}><option value="keep">保留原批次代理</option><option value="workspace">使用当前工作区代理</option><option value="direct">直连本地网络</option></select></label>
      {mode === "workspace" && <label>本次重试代理<input aria-label="批量重试代理" type="password" value={proxyUrl} onChange={(event) => setProxy(event.target.value)} autoComplete="off" spellCheck="false" placeholder="留空使用本地网络" disabled={busy} /></label>}
      <p className="cdk-helper">{mode === "keep" ? "沿用这些任务已保存的代理，不读取当前工作区代理。" : mode === "direct" || !proxyUrl.trim() ? "所选任务改为直连本地网络，不使用代理。" : "将上方代理保存到所选任务，不修改工作区配置。"}</p>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="dialog-footer"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy && <LoaderCircle size={15} className="spin" />}确认继续 / 重试失败</button></div>
    </form>
  </Drawer>;
}

export function OfferImportDialog({ request, onClose, onStarted }) {
  const [raw, setRaw] = useState(""); const [name, setName] = useState(""); const [concurrency, setConcurrency] = useState(3); const [maxRetries, setRetries] = useState(1);
  const [proxyUrl, setProxy] = useState(() => readWorkspaceValue("chatgpt-onboarding.account-proxy-v1") || "");
  const [preview, setPreview] = useState(null); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const ref = useRef(null); const pending = useRef(false); const key = useRef(requestKey());
  useDialogFocus(true, () => { if (!pending.current) onClose(); }, ref);
  const perform = async (callback) => { if (pending.current) return; pending.current = true; setBusy(true); setError(""); try { await callback(); } catch (failure) { setError(failure.message); } finally { pending.current = false; setBusy(false); } };
  const settingsValid = Number.isInteger(Number(concurrency)) && Number(concurrency) >= 1 && Number(concurrency) <= 20 && Number.isInteger(Number(maxRetries)) && Number(maxRetries) >= 0 && Number(maxRetries) <= 3;
  return <div className="modal-backdrop"><section className="batch-dialog offer-import-dialog" ref={ref} role="dialog" aria-modal="true" aria-labelledby="offer-import-title"><header className="dialog-header"><div><h2 id="offer-import-title">导入并检测优惠</h2><p>每批最多 500 个账号，检测不扣次数。</p></div><button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="关闭优惠导入"><X size={18} /></button></header>
    <div className="offer-import-fields"><label>批次名称<input value={name} maxLength={80} placeholder="可选，例如：10 月 24 日导入" onChange={(event) => setName(event.target.value)} disabled={busy} /></label><label className="offer-file">读取 TXT / JSON<input type="file" accept=".txt,.json,text/plain,application/json" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void perform(async () => { if (file.size > 900000) throw new Error("文件不能超过 900 KB"); setRaw(await file.text()); setPreview(null); key.current = requestKey(); }); }} /></label></div>
    <label className="offer-import-text">账号资料<textarea aria-label="优惠检测账号资料" value={raw} disabled={busy} placeholder={'邮箱----密码----MFA密钥\n邮箱----密码----取件URL\n也可粘贴已有会话或授权 JSON'} autoComplete="off" spellCheck="false" onChange={(event) => { setRaw(event.target.value); setPreview(null); key.current = requestKey(); }} autoFocus /></label>
    <div className="offer-import-options"><label>并发数<input type="number" min="1" max="20" value={concurrency} onChange={(event) => setConcurrency(event.target.value)} disabled={busy} /></label><label>失败额外重试<input type="number" min="0" max="3" value={maxRetries} onChange={(event) => setRetries(event.target.value)} disabled={busy} /></label><label>本批次代理<input value={proxyUrl} onChange={(event) => setProxy(event.target.value)} type="password" placeholder="留空使用本地网络" disabled={busy} autoComplete="off" /></label></div>
    {preview && <div className="offer-import-preview" role="status"><strong>识别到 {preview.count} 个账号</strong><span>已忽略同批重复 {preview.duplicateCount} 条</span><ul>{preview.accounts.slice(0, 6).map((row) => <li key={row.email}>{row.email}<small>{row.hasSession ? "已有登录信息" : row.hasPassword ? "已有密码" : row.hasMailbox ? "邮件取件" : "匹配已有资料"}</small></li>)}</ul>{preview.count > 6 && <small>另有 {preview.count - 6} 个账号</small>}</div>}
    {error && <p className="dialog-error" role="alert">{error}</p>}<footer className="dialog-footer"><button type="button" className="cancel-button" onClick={onClose} disabled={busy}>取消</button><button type="button" className="secondary-button" disabled={!raw.trim() || busy} onClick={() => void perform(async () => setPreview(await request("preview", { method: "POST", body: JSON.stringify({ text: raw }) })))}><Search size={15} />预览账号</button><button type="button" className="primary-button" disabled={!preview || busy || !settingsValid} onClick={() => void perform(async () => onStarted(await request("start", { method: "POST", body: JSON.stringify({ text: raw, digest: preview.digest, name, concurrency: Number(concurrency), maxRetries: Number(maxRetries), proxyUrl, requestKey: key.current }) })))}>{busy ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}开始检测{preview ? `（${preview.count}）` : ""}</button></footer>
  </section></div>;
}

export function OfferExportDialog({ data, onClose, verifyAccess }) {
  const ref = useRef(null); const contentRef = useRef(null); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  useDialogFocus(true, onClose, ref);
  const operate = async (callback) => { if (busy) return; setBusy(true); setNotice(""); try { await verifyAccess(); await callback(); } catch (failure) { setNotice(failure.message); } finally { setBusy(false); } };
  return <div className="modal-backdrop offer-export-backdrop"><section ref={ref} className="batch-dialog offer-export-dialog" role="dialog" aria-modal="true" aria-labelledby="offer-export-title"><header className="dialog-header"><div><h2 id="offer-export-title">导出预览</h2><p>{data.count} 个账号，内容已按当前选择生成。</p></div><button type="button" className="icon-button" aria-label="关闭优惠导出" onClick={onClose}><X size={18} /></button></header><textarea ref={contentRef} aria-label="优惠导出预览内容" readOnly value={data.content} spellCheck="false" /><p className="offer-copy-notice" role="status">{notice || "可直接复制，也可以下载 TXT 文件。"}</p><footer className="dialog-footer"><button type="button" className="cancel-button" onClick={onClose}>关闭</button><button type="button" className="secondary-button" disabled={busy} onClick={() => { contentRef.current?.focus(); contentRef.current?.select(); }}>全选内容</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void operate(async () => { await navigator.clipboard.writeText(data.content); setNotice("已复制到剪贴板"); })}><Copy size={15} />复制内容</button><button type="button" className="primary-button" disabled={busy} onClick={() => void operate(() => { const url = URL.createObjectURL(new Blob([data.content], { type: "text/plain;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = data.filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice("已下载 TXT"); })}><Download size={15} />下载 TXT</button></footer></section></div>;
}
