import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Ban, Check, CheckCheck, ChevronLeft, ChevronRight, CircleAlert, Clock3, Copy, FileText, Inbox, LoaderCircle, Mail, RefreshCw, Search, Send, X } from "lucide-react";
import { Drawer, useDialogFocus } from "./WorkspaceUi.jsx";
import { cdkFetch } from "./cdk-api.mjs";
import "./email-rebind.css";

const PAGE_SIZE = 20;
const LABELS = { queued: "排队中", checking: "检查登录信息", beginning: "正在发码", waiting_auto: "自动收码中", waiting_manual: "待手动验证码", verifying: "正在确认换绑", uncertain: "结果待核实", success: "换绑成功", failed: "失败", cancelled: "已停止", interrupted: "已中断" };
const WAITING = new Set(["waiting_manual", "waiting_auto"]);
const STOPPABLE = new Set(["queued", "checking", "beginning", "waiting_auto", "waiting_manual", "verifying"]);
const time = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
const countLines = (value) => value.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim()).length;

export default function EmailRebindWorkspace({ token, onOpenAuthorization }) {
  const [data, setData] = useState({ sources: [], items: [] });
  const [tab, setTab] = useState("sources");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [sourceIds, setSourceIds] = useState(() => new Set());
  const [recordIds, setRecordIds] = useState(() => new Set());
  const [mapping, setMapping] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [detailTab, setDetailTab] = useState("details");
  const [concurrency, setConcurrency] = useState(1);
  const [timeout, setTimeoutSeconds] = useState(180);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(() => new Set());
  const [loaded, setLoaded] = useState(false);
  const pending = useRef(new Set());
  const request = useCallback(async (route, options = {}) => {
    const response = await cdkFetch(`/api/rebind/${route}`, { ...options,
      headers: { "content-type": "application/json", "x-console-token": token, ...options.headers } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
    return body;
  }, [token]);
  const refresh = useCallback(async () => {
    const value = await request("state"); setData(value); setLoaded(true);
    if (value.error) setError(value.error);
    const valid = new Set(value.sources.map((row) => row.id));
    setSourceIds((current) => new Set([...current].filter((id) => valid.has(id))));
  }, [request]);
  useEffect(() => {
    if (!token) return undefined;
    let stopped = false; let timer; const controller = new AbortController();
    const poll = async () => {
      try { const value = await request("state", { signal: controller.signal }); if (!stopped) { setData(value); setLoaded(true); if (value.error) setError(value.error); } }
      catch (failure) { if (!stopped) setError(failure.message); }
      finally { if (!stopped) timer = window.setTimeout(poll, 1500); }
    };
    void poll(); return () => { stopped = true; controller.abort(); window.clearTimeout(timer); };
  }, [token, request]);
  const perform = async (key, operation) => {
    if (pending.current.has(key)) return;
    pending.current.add(key); setBusy(new Set(pending.current)); setError(""); setNotice("");
    try { await operation(); }
    catch (failure) { setError(failure.message); }
    finally { pending.current.delete(key); setBusy(new Set(pending.current)); }
  };
  const post = (route, body) => request(route, { method: "POST", body: JSON.stringify(body) });
  const filtered = useMemo(() => (tab === "sources" ? data.sources : data.items).filter((row) => {
    const haystack = tab === "sources" ? row.email : `${row.oldEmail} ${row.newEmail}`;
    return haystack.toLowerCase().includes(search.trim().toLowerCase()) && (tab === "sources" || status === "all" || row.status === status);
  }), [data, tab, search, status]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const rows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selection = tab === "sources" ? sourceIds : recordIds;
  const setSelection = tab === "sources" ? setSourceIds : setRecordIds;
  const selectable = (row) => tab !== "sources" || (!row.busy && !row.rebound);
  const pageIds = rows.filter(selectable).map((row) => row.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selection.has(id));
  const selectedSources = [...sourceIds].map((id) => data.sources.find((row) => row.id === id)).filter(Boolean);
  const selectedRecords = data.items.filter((row) => recordIds.has(row.id));
  const syncable = selectedRecords.filter((row) => row.status === "success" && !row.syncedJobId);
  const stoppable = selectedRecords.filter((row) => STOPPABLE.has(row.status));
  const detail = data.items.find((row) => row.id === detailId);
  const waiting = data.items.filter((row) => row.status === "waiting_manual").length;
  const recentBatch = data.items.filter((row) => row.batchId === data.items[0]?.batchId);
  const processed = recentBatch.filter((row) => ["success", "failed", "cancelled"].includes(row.status)).length;
  const switchTab = (value) => { setTab(value); setPage(1); setSearch(""); setStatus("all"); };
  const toggle = (id) => setSelection((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const itemAction = (row, route, body = {}) => perform(row.id, async () => { await post(`${row.id}/${route}`, body); await refresh(); });
  const sync = (items) => perform("sync", async () => {
    setDetailId(null);
    const value = await post("sync", { ids: items.map((row) => row.id) });
    setNotice(`已同步 ${value.created} 个新账号。请在授权页使用新邮箱恢复登录；本次未发起接码。`);
    setRecordIds(new Set()); await refresh();
  });

  return <section className="workspace rebind-workspace" aria-labelledby="rebind-title">
    <header className="rebind-heading"><div><h2 id="rebind-title">邮箱换绑</h2><p>先核对每一组邮箱，再开始换绑。原授权与 MFA 资料独立保留。</p></div>
      <button type="button" className="secondary-button" onClick={() => void perform("refresh", refresh)} disabled={busy.has("refresh")}><RefreshCw size={15} />刷新</button></header>
    <nav className="rebind-tabs" aria-label="换绑视图">{[["sources", "可换绑账号", data.sources.length], ["records", "换绑记录", data.items.length]].map(([key, label, count]) =>
      <button type="button" key={key} aria-pressed={tab === key} className={tab === key ? "active" : ""} onClick={() => switchTab(key)}>{label}<span>{count}</span></button>)}</nav>
    {error && <div className="global-error" role="alert"><CircleAlert size={17} /><span>{error}</span><button type="button" aria-label="关闭错误" onClick={() => setError("")}><X size={16} /></button></div>}
    {notice && <div className="global-success" role="status"><Check size={17} /><span>{notice}</span>{onOpenAuthorization && <button type="button" className="text-action" onClick={onOpenAuthorization}>查看账号授权</button>}<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={16} /></button></div>}
    <div className="rebind-filterbar"><label className="rebind-search"><Search size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder={tab === "sources" ? "搜索原账号邮箱" : "搜索原邮箱或新邮箱"} aria-label="搜索换绑账号" /></label>
      {tab === "records" && <label>进度<select aria-label="筛选换绑进度" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="all">全部进度</option>{Object.entries(LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>}
      {tab === "records" && waiting > 0 && <button type="button" className="text-action" onClick={() => { setStatus("waiting_manual"); setPage(1); }}><Inbox size={15} />待手动输码 {waiting}</button>}
    </div>
    <div className="rebind-actionbar"><div><strong>已选 {selection.size} 个{tab === "sources" ? "账号" : "记录"}</strong><button type="button" className="selection-text-button" onClick={() => setSelection(new Set())} disabled={!selection.size}>清除选择</button></div>
      {tab === "sources" ? <button type="button" className="primary-button" disabled={!selectedSources.length || selectedSources.some((row) => row.busy || row.rebound)} onClick={() => setMapping([...selectedSources])}><Mail size={16} />配置换绑（{selectedSources.length}）</button>
        : <div className="rebind-record-actions"><button type="button" className="secondary-button" disabled={!syncable.length || busy.has("sync")} onClick={() => void sync(syncable)}><Send size={15} />同步到账号授权（{syncable.length}）</button>
          <button type="button" className="secondary-button" disabled={!stoppable.length || busy.has("stop")} onClick={() => void perform("stop", async () => { const result = await post("stop", { ids: stoppable.map((row) => row.id) }); setNotice(result.finishing ? "已请求停止；正在提交的请求会先确认结果。" : "所选任务已停止。"); await refresh(); })}><Ban size={15} />停止所选</button></div>}
    </div>
    {tab === "records" && recentBatch.length > 0 && <p className="rebind-batch-progress" role="status">最近批次已处理 <strong>{processed} / {recentBatch.length}</strong><span>成功 {recentBatch.filter((row) => row.status === "success").length}</span><span>失败 {recentBatch.filter((row) => row.status === "failed").length}</span><span>待验证码 {recentBatch.filter((row) => WAITING.has(row.status)).length}</span><span>待核实 {recentBatch.filter((row) => row.status === "uncertain").length}</span></p>}
    <div className="table-frame rebind-table-frame"><table className={`rebind-table ${tab === "records" ? "rebind-results" : ""}`}><thead><tr>
      <th className="select-heading"><input type="checkbox" checked={allSelected} disabled={!pageIds.length} aria-label="选择当前页全部换绑账号" onChange={() => setSelection((current) => { const next = new Set(current); pageIds.forEach((id) => allSelected ? next.delete(id) : next.add(id)); return next; })} /></th>
      {tab === "sources" ? <><th>原账号</th><th>来源</th><th>账号资料</th><th>当前状态</th><th>操作</th></> : <><th>邮箱对应关系</th><th>收码与进度</th><th>同步状态</th><th>更新时间</th><th>操作</th></>}
    </tr></thead><tbody>{!rows.length && <tr><td colSpan="6"><div className="empty-state"><Mail size={26} /><h3>{!loaded ? "正在读取账号" : tab === "sources" ? "没有可显示的账号" : "暂无换绑记录"}</h3><p>{tab === "sources" ? "先在账号授权或 MFA 页面添加账号，再选择需要换绑的账号。" : "配置并确认邮箱对应关系后，执行结果会显示在这里。"}</p></div></td></tr>}
      {rows.map((row) => <tr key={row.id} className={selection.has(row.id) ? "selected-row" : ""}><td className="select-cell"><input type="checkbox" checked={selection.has(row.id)} disabled={!selectable(row)} onChange={() => toggle(row.id)} aria-label={`选择 ${row.email || row.oldEmail}`} /></td>
        {tab === "sources" ? <><td data-label="原账号"><strong className="rebind-email">{row.email}</strong></td><td data-label="来源">{row.sources.map((source) => source === "mfa" ? "MFA" : "账号授权").join(" / ")}</td>
          <td data-label="账号资料"><span>{row.hasPassword ? "已有密码" : "未提供密码"}</span><small className="rebind-secondary">{row.hasTotpKey ? "已有 MFA 密钥" : "未记录 MFA 密钥"}</small></td>
          <td data-label="状态">{row.rebound ? "已完成换绑" : row.busy ? "其他任务处理中" : "执行时核验登录状态"}</td><td data-label="操作"><button type="button" className="text-action" disabled={row.busy || row.rebound} onClick={() => setMapping([row])}>换绑邮箱</button></td></>
          : <><td data-label="邮箱对应关系"><EmailPair oldEmail={row.oldEmail} newEmail={row.newEmail} /></td><td data-label="收码与进度"><RebindStatus item={row} /><small className="rebind-secondary">{row.mode === "auto" ? "自动收码" : "手动验证码"}</small><p className="rebind-row-message">{row.message}</p>{WAITING.has(row.status) && <CodeForm item={row} busy={busy.has(row.id)} onSubmit={(code) => itemAction(row, "code", { code, version: row.challengeVersion })} />}</td>
            <td data-label="同步状态">{row.syncedJobId ? "已在账号授权中" : row.status === "success" ? "未同步；新邮箱登录待恢复" : "等待换绑确认"}</td><td data-label="更新时间" className="rebind-time">{time(row.updatedAt)}</td><td data-label="操作"><div className="rebind-row-actions"><button type="button" className="text-action" onClick={() => { setDetailTab("details"); setDetailId(row.id); }}>查看详情</button><button type="button" className="text-action" aria-label={`查看 ${row.oldEmail} 的换绑执行日志`} onClick={() => { setDetailTab("logs"); setDetailId(row.id); }}><FileText size={14} />执行日志</button></div></td></>}
      </tr>)}
    </tbody></table></div>
    <div className="rebind-pagination"><span>匹配 {filtered.length} 条 · 每页 {PAGE_SIZE} 条</span><div><button type="button" className="icon-button" aria-label="换绑上一页" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={17} /></button><span>{currentPage} / {totalPages}</span><button type="button" className="icon-button" aria-label="换绑下一页" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}><ChevronRight size={17} /></button></div></div>
    {mapping && <MappingDialog sources={mapping} request={request} concurrency={concurrency} timeout={timeout} onClose={() => setMapping(null)} onStart={async (value) => { await post("start", value); setConcurrency(value.concurrency); setTimeoutSeconds(value.timeout); setMapping(null); setSourceIds(new Set()); switchTab("records"); await refresh(); }} />}
    {detail && <Drawer title="邮箱换绑详情" onClose={() => setDetailId(null)} wide><EmailPair oldEmail={detail.oldEmail} newEmail={detail.newEmail} />
      <nav className="rebind-detail-tabs" aria-label="换绑详情视图"><button type="button" aria-pressed={detailTab === "details"} onClick={() => setDetailTab("details")}>详情</button><button type="button" aria-pressed={detailTab === "logs"} onClick={() => setDetailTab("logs")}><FileText size={14} />执行日志</button></nav>
      {detailTab === "logs" ? <RebindLogs key={detail.id} id={detail.id} request={request} /> : <><section className="detail-section"><h3>换绑结果</h3><RebindStatus item={detail} /><p className="prompt-line">{detail.message}</p></section>
      {WAITING.has(detail.status) && <section className="detail-section"><h3>输入验证码</h3><p>仅用于 {detail.oldEmail} 换绑至 {detail.newEmail}。</p><CodeForm item={detail} busy={busy.has(detail.id)} onSubmit={(code) => itemAction(detail, "code", { code, version: detail.challengeVersion })} />
        <div className="rebind-detail-actions">{detail.status === "waiting_auto" && <button type="button" className="secondary-button" disabled={busy.has(detail.id)} onClick={() => void itemAction(detail, "manual")}>改为手动收码</button>}
          <ResendButton item={detail} busy={busy.has(detail.id)} onClick={() => void itemAction(detail, "resend")} /></div></section>}
      <section className="detail-section"><h3>后续操作</h3><div className="rebind-detail-actions">
        {detail.canRetry && <button type="button" className="secondary-button" disabled={busy.has(detail.id)} onClick={() => void itemAction(detail, "retry")}>按原映射重试</button>}
        {detail.status === "uncertain" && <button type="button" className="secondary-button" disabled={busy.has(detail.id)} onClick={() => void itemAction(detail, "reconcile")}>核对新邮箱登录状态</button>}
        {detail.status === "success" && !detail.syncedJobId && <button type="button" className="primary-button" disabled={busy.has("sync")} onClick={() => void sync([detail])}><Send size={15} />同步到账号授权</button>}
        {detail.syncedJobId && onOpenAuthorization && <button type="button" className="secondary-button" onClick={onOpenAuthorization}>查看账号授权</button>}
      </div><p className="rebind-secondary">同步按新邮箱首次导入计次，不覆盖原账号。旧登录信息不能作为新邮箱授权。</p></section>
      <section className="detail-section"><h3>执行历史</h3><ol className="rebind-events">{detail.events.map((event, index) => <li key={index}><time>{time(event.at)}</time><strong>{LABELS[event.status]}</strong><span>{event.message}</span></li>)}</ol></section></>}
    </Drawer>}
  </section>;
}

export function RebindLogs({ id, request }) {
  const [logs, setLogs] = useState(""); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const [following, setFollowing] = useState(true); const [revision, setRevision] = useState(0); const [notice, setNotice] = useState("");
  const panel = useRef(null);
  useEffect(() => {
    let stopped = false; let timer; let offset = 0; const controller = new AbortController();
    setLogs(""); setLoading(true); setError(""); setNotice("");
    const poll = async () => {
      let more = false;
      try {
        const value = await request(`${id}/logs?offset=${offset}&limit=128000`, { signal: controller.signal });
        if (stopped) return;
        if (!Number.isSafeInteger(value.nextOffset) || value.nextOffset < 0 || value.hasMore && value.nextOffset <= offset && !value.reset) throw new Error("日志读取进度异常，请刷新重试");
        setLogs((current) => value.reset || value.offset === 0 ? value.logs : current + value.logs);
        offset = value.nextOffset; more = value.hasMore; setError("");
      } catch (failure) { if (!stopped) setError(failure.message); }
      finally { if (!stopped) { setLoading(more); timer = window.setTimeout(poll, more ? 0 : 1200); } }
    };
    void poll(); return () => { stopped = true; controller.abort(); window.clearTimeout(timer); };
  }, [id, request, revision]);
  useEffect(() => { if (following && panel.current) panel.current.scrollTop = panel.current.scrollHeight; }, [logs, following]);
  return <section className="rebind-log-view" aria-label="邮箱换绑执行日志"><div className="rebind-log-toolbar"><label><input type="checkbox" checked={following} onChange={(event) => setFollowing(event.target.checked)} />自动滚动</label><div><button type="button" className="text-action" onClick={() => setRevision((value) => value + 1)}><RefreshCw size={14} />刷新日志</button><button type="button" className="text-action" disabled={!logs || loading} onClick={async () => { try { await navigator.clipboard.writeText(logs); setNotice("已复制执行日志"); } catch { setNotice("复制失败，可在日志中选择文本后复制"); } }}><Copy size={14} />复制日志</button></div></div><div className="log-panel rebind-log-panel"><div className="log-title"><FileText size={15} />协议日志</div><pre ref={panel} tabIndex={0} aria-label="换绑协议日志内容" onScroll={(event) => { const element = event.currentTarget; setFollowing(element.scrollHeight - element.scrollTop - element.clientHeight < 36); }}>{logs || (loading ? "正在读取日志..." : "暂无执行日志")}</pre></div><p className={error ? "rebind-log-message error" : "rebind-log-message"} role="status">{error ? `日志读取失败：${error}` : notice || "实时更新，重试记录会继续追加；历史日志保留在当前账号下。"}</p></section>;
}

export function EmailPair({ oldEmail, newEmail }) {
  return <div className="rebind-email-pair"><span><small>原邮箱</small><strong>{oldEmail}</strong></span><ArrowRight size={17} aria-hidden="true" /><span><small>新邮箱</small><strong>{newEmail}</strong></span></div>;
}
function RebindStatus({ item }) {
  return <strong className={`rebind-status rebind-status-${item.status}`}>{["checking", "beginning", "verifying", "waiting_auto"].includes(item.status) ? <LoaderCircle size={14} className="spin" /> : item.status === "success" ? <CheckCheck size={14} /> : ["uncertain", "failed"].includes(item.status) ? <CircleAlert size={14} /> : <Clock3 size={14} />}{LABELS[item.status]}</strong>;
}
export function CodeForm({ item, busy, onSubmit }) {
  const [code, setCode] = useState("");
  useEffect(() => setCode(""), [item.id, item.challengeVersion]);
  return <form className="rebind-code-form" onSubmit={(event) => { event.preventDefault(); if (/^\d{6}$/.test(code) && !busy) void onSubmit(code); }}>
    <input type="text" inputMode="numeric" autoComplete="one-time-code" aria-label={`为 ${item.newEmail} 输入验证码`} maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="6 位验证码" disabled={busy} />
    <button type="submit" className="secondary-button" disabled={!/^\d{6}$/.test(code) || busy}>{busy ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}提交验证码</button>
  </form>;
}
function ResendButton({ item, busy, onClick }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const left = Math.max(0, Math.ceil(((item.nextSendAt || 0) - now) / 1000));
  return <button type="button" className="secondary-button" disabled={busy || left > 0} onClick={onClick}>重新发送{left ? `（${left}s）` : ""}</button>;
}

export function MappingDialog({ sources, request, concurrency, timeout, onClose, onStart }) {
  const [raw, setRaw] = useState(""); const [preview, setPreview] = useState(null); const [error, setError] = useState("");
  const [busy, setBusy] = useState(false); const [workers, setWorkers] = useState(concurrency); const [seconds, setSeconds] = useState(timeout);
  const ref = useRef(null); const pending = useRef(false);
  useDialogFocus(true, () => { if (!pending.current) onClose(); }, ref);
  const count = countLines(raw);
  const validSettings = Number.isInteger(Number(workers)) && Number(workers) >= 1 && Number(workers) <= 30 && Number.isInteger(Number(seconds)) && Number(seconds) >= 30 && Number(seconds) <= 600;
  const run = async (callback) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await callback(); } catch (failure) { setError(failure.message); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="modal-backdrop rebind-mapping-backdrop"><section ref={ref} className="rebind-mapping-dialog" role="dialog" aria-modal="true" aria-labelledby="rebind-mapping-title">
    <header><div><h2 id="rebind-mapping-title">为每个账号指定新邮箱</h2><p>原账号顺序已固定。每行新邮箱与同序号原账号一一对应。</p></div><button type="button" className="icon-button" aria-label="关闭换绑配置" disabled={busy} onClick={onClose}><X size={18} /></button></header>
    <div className="rebind-mapping-count" role="status"><strong>已选 {sources.length} 个账号</strong><span className={count !== sources.length ? "rebind-count-error" : ""}>已输入 {count} 条</span>{preview && <span>自动 {preview.rows.filter((row) => row.mode === "auto").length} 条，手动 {preview.rows.filter((row) => row.mode === "manual").length} 条</span>}</div>
    <div className="rebind-mapping-body"><label className="rebind-target-input"><span>新邮箱，每行一条</span><textarea value={raw} onChange={(event) => { setRaw(event.target.value); setPreview(null); setError(""); }} disabled={busy} placeholder={'new-a@example.com----https://mail.example.com/inbox/xxx\nnew-b@example.com'} autoComplete="off" spellCheck="false" autoFocus /><small>带取件 URL 自动收码；纯邮箱显示手动验证码输入框。</small></label>
      <div className="rebind-map-review"><strong>对应关系核对</strong><ol>{sources.map((source, index) => <li key={source.id}><span className="rebind-map-number">{index + 1}</span><div><small>原账号</small><strong>{source.email}</strong><ArrowRight size={14} aria-hidden="true" /><span className={preview ? "rebind-map-target" : "rebind-secondary"}>{preview?.rows[index]?.newEmail || "核对后显示新邮箱"}</span>{preview && <small>{preview.rows[index].mode === "auto" ? "自动收码，取件地址已配置" : "手动输入验证码"}</small>}</div></li>)}</ol></div></div>
    <div className="rebind-mapping-options"><label>同时执行<input aria-label="换绑并发数" type="number" min="1" max="30" value={workers} onChange={(event) => setWorkers(event.target.value)} disabled={busy} /></label><label>等待验证码（秒）<input aria-label="验证码等待秒数" type="number" min="30" max="600" value={seconds} onChange={(event) => setSeconds(event.target.value)} disabled={busy} /></label><p>换绑成功仅记录在本页；不会改写原授权和 MFA 资料。</p></div>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <footer><button type="button" className="cancel-button" disabled={busy} onClick={onClose}>取消</button><div><button type="button" className="secondary-button" disabled={busy || count !== sources.length} onClick={() => void run(async () => setPreview(await request("preview", { method: "POST", body: JSON.stringify({ ids: sources.map((source) => source.id), text: raw }) })))}>核对映射</button>
      <button type="button" className="primary-button" disabled={busy || !preview || count !== sources.length || !validSettings} onClick={() => void run(() => onStart({ ids: sources.map((source) => source.id), text: raw, digest: preview.digest, concurrency: Number(workers), timeout: Number(seconds) }))}>{busy ? <LoaderCircle size={15} className="spin" /> : <Mail size={15} />}确认并开始换绑（{sources.length}）</button></div></footer>
  </section></div>;
}
