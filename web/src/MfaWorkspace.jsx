import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ban, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, CircleAlert, Copy, Download, FileText, History, ListPlus, LoaderCircle, LogOut, RefreshCw, Search, ShieldCheck, Send, X } from "lucide-react";
import { Drawer, MoreActions, TaskFilters, TaskOverview, useCalendarDay, useDialogFocus } from "./WorkspaceUi.jsx";
import { DEFAULT_FILTERS, matchesDate } from "./task-filters.mjs";
import { cdkFetch } from "./cdk-api.mjs";

const PAGE_SIZE = 20;
const ACTIVE_STATUSES = new Set(["queued", "running"]);
const RETRY_STATUSES = new Set(["failed", "interrupted"]);
const STATUS_LABELS = {
  ready: "待修改", queued: "排队中", running: "修改中", success: "已成功", failed: "失败", interrupted: "已中断",
};
const STAGE_LABELS = {
  ready: "等待开始", queued: "等待处理", rotating: "正在修改 MFA", saving: "保存并同步新密钥",
  completed: "新 MFA 已确认生效", failed: "修改未完成，可重试恢复", interrupted: "任务已中断，可重试恢复", cancel_requested: "完成当前操作后停止",
  pending: "检查账号授权", authenticated: "账号身份已确认", disable_requested: "确认旧 MFA 关闭状态",
  disabled: "旧 MFA 已关闭，等待设置新密钥", enroll_requested: "申请新 MFA 密钥",
  enrolled: "新密钥已保存，等待激活", activating: "激活并确认新 MFA", confirmed: "新 MFA 已确认生效",
  logout_queued: "等待登出", logging_out: "正在登出所有设备", logged_out: "所有设备已登出",
  logout_failed: "登出未完成，可重试登出", logout_interrupted: "登出已中断，可重试登出",
};
const LOGOUT_LABELS = { idle: "尚未登出", queued: "等待登出", running: "正在登出", success: "已登出", failed: "登出失败", interrupted: "登出中断" };

export default function MfaWorkspace({ token, defaultProxyUrl, focusAccountId, onReconnect, onOpenAuthorization }) {
  const [accounts, setAccounts] = useState([]);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(null);
  const [exportPreview, setExportPreview] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedAccountId, setExpandedAccountId] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyError, setHistoryError] = useState("");
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const calendarDay = useCalendarDay();
  const [page, setPage] = useState(1);
  const [concurrency, setConcurrency] = useState(3);
  const [proxyUrl, setProxyUrl] = useState(defaultProxyUrl || "");
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [notice, setNotice] = useState("");
  const [syncResult, setSyncResult] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [reading, setReading] = useState(false);
  const concurrencyLoaded = useRef(false);
  const focusedAccount = useRef(null);
  useDialogFocus(importOpen, () => { if (!action) setImportOpen(false); });

  const request = useCallback(async (path, options = {}) => {
    const response = await cdkFetch(`/api/mfa/${path}`, {
      ...options,
      headers: { "content-type": "application/json", "x-console-token": token, ...options.headers },
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `请求失败（${response.status}）`);
    }
    return response;
  }, [token]);

  const applyAccounts = useCallback((data) => {
    const next = Array.isArray(data.accounts) ? data.accounts : [];
    setAccounts(next);
    setRunning(Boolean(data.running));
    setLoaded(true);
    if (!concurrencyLoaded.current && Number.isInteger(data.concurrency)) {
      setConcurrency(Math.min(30, Math.max(1, data.concurrency)));
      concurrencyLoaded.current = true;
    }
    setPollError(data.error || "");
    const validIds = new Set(next.map((account) => account.id));
    setSelectedIds((current) => {
      const valid = [...current].filter((id) => validIds.has(id));
      return valid.length === current.size ? current : new Set(valid);
    });
  }, []);

  const refresh = useCallback(async () => applyAccounts(await (await request("accounts")).json()), [request, applyAccounts]);
  const retryRead = async () => {
    setReading(true);
    setError("");
    onReconnect?.();
    try { await refresh(); }
    catch (requestError) { setPollError(requestError.message); }
    finally { setReading(false); }
  };

  useEffect(() => {
    if (!token) return undefined;
    let stopped = false;
    let timer;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const data = await (await request("accounts", { signal: controller.signal })).json();
        if (!stopped) applyAccounts(data);
      } catch (requestError) {
        if (!stopped) setPollError(requestError.message);
      } finally {
        if (!stopped) timer = window.setTimeout(poll, 1_500);
      }
    };
    void poll();
    return () => { stopped = true; controller.abort(); window.clearTimeout(timer); };
  }, [token, request, applyAccounts]);

  useEffect(() => {
    if (!token || !historyOpen) return undefined;
    let stopped = false;
    let timer;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const data = await (await request("history", { signal: controller.signal })).json();
        if (!stopped) { setHistory(data.items || []); setHistoryError(""); }
      } catch (requestError) {
        if (!stopped) setHistoryError(requestError.message);
      } finally {
        if (!stopped) timer = window.setTimeout(poll, 3_000);
      }
    };
    void poll();
    return () => { stopped = true; controller.abort(); window.clearTimeout(timer); };
  }, [token, request, historyOpen]);

  const filtered = useMemo(() => accounts.filter((account) => (
    (filters.status === "all" || account.status === filters.status)
    && account.email.toLowerCase().includes(filters.search.trim().toLowerCase())
    && matchesDate(account, filters)
  )), [accounts, filters, calendarDay]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageAccounts = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selected = accounts.filter((account) => selectedIds.has(account.id));
  const startable = selected.filter((account) => !ACTIVE_STATUSES.has(account.status));
  const cancelable = selected.filter((account) => ACTIVE_STATUSES.has(account.status) || ACTIVE_STATUSES.has(account.logoutStatus));
  const retryable = (selectedIds.size ? selected : filtered).filter((account) => RETRY_STATUSES.has(account.status));
  const exportable = (selectedIds.size ? selected : accounts).filter((account) => account.status === "success");
  const logoutable = (selectedIds.size ? selected : filtered).filter((account) => account.status === "success");
  const allPageSelected = pageAccounts.length > 0 && pageAccounts.every((account) => selectedIds.has(account.id));
  const counts = accounts.reduce((result, account) => ({ ...result, [account.status]: (result[account.status] || 0) + 1 }), {});
  const validConcurrency = Number.isInteger(Number(concurrency)) && Number(concurrency) >= 1 && Number(concurrency) <= 30;
  const todayCount = accounts.filter((account) => matchesDate(account, { ...DEFAULT_FILTERS, preset: "today" })).length;
  const unknownCreatedCount = accounts.filter((account) => !account.createdAt).length;
  const detailAccount = accounts.find((account) => account.id === expandedAccountId);

  useEffect(() => {
    if (!focusAccountId || focusedAccount.current === focusAccountId || !accounts.some((account) => account.id === focusAccountId)) return;
    focusedAccount.current = focusAccountId;
    setSelectedIds(new Set([focusAccountId]));
    setExpandedAccountId(focusAccountId);
    setNotice("已从账号授权页发起 MFA 修改，使用已有授权；成功后自动同步账号资料。");
  }, [focusAccountId, accounts]);

  function updateFilters(next) {
    setFilters(next);
    setPage(1);
    setSelectedIds(new Set());
    setExpandedAccountId(null);
  }

  function toggleSelection(id) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectPage() {
    setSelectedIds((current) => {
      const next = new Set(current);
      pageAccounts.forEach((account) => allPageSelected ? next.delete(account.id) : next.add(account.id));
      return next;
    });
  }

  async function perform(name, callback) {
    if (action || !token) return;
    setAction(name);
    setError("");
    setNotice("");
    try { await callback(); } catch (requestError) { setError(requestError.message); }
    finally { setAction(""); }
  }

  function previewImport(event) {
    event.preventDefault();
    void perform("preview", async () => {
      const data = await (await request("preview", { method: "POST", body: JSON.stringify({ text }) })).json();
      setPreview(data);
    });
  }

  function importAccounts() {
    if (!preview) return;
    void perform("import", async () => {
      const data = await (await request("import", { method: "POST", body: JSON.stringify({ text }) })).json();
      setText("");
      setPreview(null);
      setImportOpen(false);
      setFilters(DEFAULT_FILTERS);
      setPage(1);
      setSelectedIds(new Set());
      setNotice(`已导入 ${data.imported} 个账号，选择账号后即可开始修改。`);
      await refresh();
    });
  }

  function startAccounts(targets, retry = false) {
    if (!targets.length || !validConcurrency) return;
    if (!window.confirm(`${retry ? "重新处理" : "修改"}这 ${targets.length} 个账号的 MFA？成功后请导出新的 MFA 密钥。`)) return;
    void perform(retry ? "retry" : "start", async () => {
      const data = await (await request("start", {
        method: "POST", body: JSON.stringify({ ids: targets.map((account) => account.id), concurrency: Number(concurrency), proxyUrl: proxyUrl.trim() }),
      })).json();
      setNotice(`已安排 ${data.started} 个账号，处理结果会自动更新。`);
      await refresh();
    });
  }

  function cancelAccounts() {
    void perform("cancel", async () => {
      const data = await (await request("cancel", { method: "POST", body: JSON.stringify({ ids: cancelable.map((account) => account.id) }) })).json();
      setNotice(`已取消 ${data.canceled || 0} 个排队任务${data.finishing ? `，另有 ${data.finishing} 个正在处理的账号会完成当前操作` : ""}。`);
      await refresh();
    });
  }

  function syncAuthorization(targets) {
    if (!targets.length) return;
    void perform("sync-authorization", async () => {
      setSyncResult(null);
      const data = await (await request("sync-authorization", {
        method: "POST", body: JSON.stringify({ ids: targets.map((account) => account.id) }),
      })).json();
      setSyncResult(data);
      setSelectedIds(new Set(data.results.filter((row) => !row.success).map((row) => row.id)));
      await refresh();
    });
  }

  function logoutDevices() {
    if (!logoutable.length || !validConcurrency) return;
    if (!window.confirm(`使用已有授权，为${selectedIds.size ? "所选" : "当前筛选中"} ${logoutable.length} 个 MFA 修改成功的账号登出所有设备？包括本次会话。授权过期时会提示，不会重新登录。`)) return;
    void perform("logout-all", async () => {
      const data = await (await request("logout-all", {
        method: "POST", body: JSON.stringify({ ids: logoutable.map((account) => account.id), concurrency: Number(concurrency), proxyUrl: proxyUrl.trim() }),
      })).json();
      setNotice(`已安排 ${data.started} 个账号使用已有授权登出；授权过期时提示，不会重新登录，结果显示在“设备登出”列。`);
      await refresh();
    });
  }

  function exportAccounts(format) {
    const returnFocus = document.activeElement;
    void perform(`export-${format}`, async () => {
      const response = await request("export", {
        method: "POST", body: JSON.stringify({ ...(selectedIds.size ? { ids: [...selectedIds] } : {}), format }),
      });
      const blob = await response.blob();
      const content = (await blob.text()).replace(/^\uFEFF/, "");
      const disposition = response.headers.get("content-disposition") || "";
      const rawName = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition)?.[1]
        || /filename\s*=\s*"?([^";]+)/i.exec(disposition)?.[1];
      let filename = `mfa-success-${exportable.length}-${Date.now()}.${format}`;
      if (rawName) {
        try { filename = decodeURIComponent(rawName.trim().replace(/^"|"$/g, "")).replace(/[\\/]/g, "_"); } catch {}
      }
      setExportPreview({ blob, content, filename, format, returnFocus, scope: selectedIds.size ? "所选账号中的成功结果" : "全部成功结果" });
    });
  }

  return (
    <section className="workspace mfa-workspace" aria-labelledby="mfa-title">
      <div className="section-heading">
        <div><h2 id="mfa-title">MFA 修改</h2><p>批量更换 MFA 密钥，成功后导出账号和新密钥。</p></div>
        <div className="mfa-heading-actions">
          <button type="button" className="secondary-button" onClick={() => setHistoryOpen((current) => !current)}><History size={17} />{historyOpen ? "收起历史" : "操作历史"}</button>
          <button type="button" className="primary-button" disabled={!token || Boolean(action)} onClick={() => { setImportOpen(true); setError(""); }}><ListPlus size={17} />导入账号</button>
        </div>
      </div>

      <TaskOverview label="MFA 任务统计" today={loaded ? todayCount : null} total={loaded ? accounts.length : null}
        onToday={() => updateFilters({ ...filters, dateField: "createdAt", preset: "today" })}
        onTotal={() => updateFilters({ ...filters, preset: "all" })}
        note={unknownCreatedCount ? `${unknownCreatedCount} 个历史账号的创建时间未知，不计入今日任务。` : ""}
        items={[
          { key: "ready", label: "待处理", count: counts.ready, tone: "waiting" },
          { key: "queued", label: "排队中", count: counts.queued, tone: "queued" },
          { key: "running", label: "修改中", count: counts.running, tone: "running" },
          { key: "success", label: "已成功", count: counts.success, tone: "complete" },
          { key: "failed", label: "失败", count: counts.failed, tone: "failed" },
        ].map((item) => ({ ...item, onClick: () => updateFilters({ ...filters, status: item.key }) }))} />
      <TaskFilters value={filters} onChange={updateFilters} statuses={{ all: "所有状态", ...STATUS_LABELS }} dateFields={{ createdAt: "创建时间", updatedAt: "最近更新时间", changedAt: "修改成功时间" }} day={calendarDay}
        extra={<button type="button" className="selection-text-button" onClick={() => updateFilters(DEFAULT_FILTERS)}>清除筛选</button>} />

      {(error || pollError) && <div className="global-error" role="alert"><CircleAlert size={17} /><span>{error || pollError}</span><button type="button" className="error-retry" disabled={reading} onClick={retryRead}>{reading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}重新读取</button><button type="button" title="关闭错误提示" onClick={() => { setError(""); setPollError(""); }}><X size={16} /></button></div>}
      {notice && <div className="global-success" role="status"><Check size={17} /><span>{notice}</span><button type="button" title="关闭提示" onClick={() => setNotice("")}><X size={16} /></button></div>}
      {syncResult && <section className="export-report" aria-label="同步到账号授权结果">
        <div className="export-report-heading"><strong>同步到账号授权</strong><button type="button" className="icon-button" aria-label="关闭同步结果" onClick={() => setSyncResult(null)}><X size={16} /></button></div>
        <p role="status">成功 {syncResult.synced} 条，失败 {syncResult.failed} 条。同步成功的账号进入未接码列表，并自动检测额度。</p>
        {syncResult.results.some((row) => !row.success) && <ul>{syncResult.results.filter((row) => !row.success).map((row) => <li key={row.id}>{row.email}：{row.message}</li>)}</ul>}
        {syncResult.synced > 0 && onOpenAuthorization && <button type="button" className="secondary-button" onClick={onOpenAuthorization}>查看账号授权 · 未接码</button>}
      </section>}

      <div className="mfa-controls">
        <label className="mfa-control"><span>并发数</span><input type="number" min="1" max="30" step="1" value={concurrency} onChange={(event) => { concurrencyLoaded.current = true; setConcurrency(event.target.value); }} /></label>
        <label className="mfa-control mfa-proxy-control"><span>代理地址</span><input type="text" value={proxyUrl} onChange={(event) => setProxyUrl(event.target.value)} autoComplete="off" spellCheck="false" placeholder="留空使用默认网络" /></label>
      </div>
      {!validConcurrency && <div className="global-error" role="alert">并发数需为 1 到 30 的整数。</div>}

      {selectedIds.size > 0 && <div className="selection-toolbar mfa-selection-toolbar">
        <div className="selection-summary">
          <span>匹配 {filtered.length} 条 · 跨页已选 {selectedIds.size} 条</span>
          <button type="button" className="selection-text-button" disabled={!filtered.length} onClick={() => setSelectedIds((current) => new Set([...current, ...filtered.map((account) => account.id)]))}>全选筛选结果</button>
          <button type="button" className="selection-text-button" disabled={!selectedIds.size} onClick={() => setSelectedIds(new Set())}>清除选择</button>
        </div>
        <div className="bulk-actions">
          <button type="button" className="secondary-button bulk-button" disabled={!token || !selected.length || Boolean(action)} onClick={() => syncAuthorization(selected)} title="复用已有登录会话，进入未接码并检测额度；失效时提示，不自动登录或接码">{action === "sync-authorization" ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}同步到账号授权（{selected.length}）</button>
          <button type="button" className="primary-button bulk-button" disabled={!token || running || !startable.length || !validConcurrency || Boolean(action)} onClick={() => startAccounts(startable)} title={running ? "当前批次结束后可开始下一批" : "修改所选账号的 MFA"}>{action === "start" ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}批量修改 {startable.length || ""}</button>
          <button type="button" className="secondary-button bulk-button" disabled={running || !retryable.length || !validConcurrency || Boolean(action)} onClick={() => startAccounts(retryable, true)} title={running ? "当前批次结束后可重试" : selectedIds.size ? "重试所选账号中的失败和中断任务" : "重试筛选结果中的失败和中断任务"}>{action === "retry" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}重试失败 / 中断 {retryable.length || ""}</button>
          <button type="button" className="secondary-button bulk-button" disabled={!token || running || !logoutable.length || !validConcurrency || Boolean(action)} onClick={logoutDevices} title={selectedIds.size ? "登出所选成功账号的所有设备" : "登出当前筛选中成功账号的所有设备"}>{action === "logout-all" ? <LoaderCircle className="spin" size={15} /> : <LogOut size={15} />}登出所有设备 {logoutable.length || ""}</button>
          <button type="button" className="secondary-button bulk-button" disabled={!cancelable.length || Boolean(action)} onClick={cancelAccounts}><Ban size={15} />停止所选</button>
        </div>
      </div>}

      <div className="mfa-export-toolbar">
        <span>{selectedIds.size ? "所选账号中" : "全部账号中"}可导出 {exportable.length} 条成功结果 · TXT：邮箱----密码----新 MFA 密钥</span>
        <div><button type="button" className="secondary-button" disabled={running || !exportable.length || Boolean(action)} onClick={() => exportAccounts("txt")}>{action === "export-txt" ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}导出 TXT</button><button type="button" className="secondary-button" disabled={running || !exportable.length || Boolean(action)} onClick={() => exportAccounts("json")}>{action === "export-json" ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}导出 JSON</button></div>
      </div>

      <div className="list-heading mfa-list-heading"><strong>任务列表</strong><span aria-live="polite">匹配 {filtered.length} 条 · 最近导入在前</span><div><button type="button" className="selection-text-button" disabled={!filtered.length} onClick={() => setSelectedIds(new Set(filtered.map((account) => account.id)))}>全选筛选结果</button><MoreActions label="更多操作">
          <button type="button" className="secondary-button bulk-button" disabled={running || !retryable.length || !validConcurrency || Boolean(action)} onClick={() => startAccounts(retryable, true)} title={running ? "当前批次结束后可重试" : selectedIds.size ? "重试所选账号中的失败和中断任务" : "重试筛选结果中的失败和中断任务"}>{action === "retry" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}重试失败 / 中断 {retryable.length || ""}</button>
          <button type="button" className="secondary-button bulk-button" disabled={!token || running || !logoutable.length || !validConcurrency || Boolean(action)} onClick={logoutDevices} title={selectedIds.size ? "登出所选成功账号的所有设备" : "登出当前筛选中成功账号的所有设备"}>{action === "logout-all" ? <LoaderCircle className="spin" size={15} /> : <LogOut size={15} />}登出所有设备 {logoutable.length || ""}</button>
      </MoreActions></div></div>
      <div className="table-frame"><table className="mfa-table"><thead><tr>
        <th className="select-heading"><input type="checkbox" checked={allPageSelected} disabled={!pageAccounts.length} onChange={selectPage} aria-label="选择当前页全部 MFA 账号" /></th><th>账号</th><th>状态</th><th>当前进度</th><th>设备登出</th><th>时间</th><th>详情</th>
      </tr></thead><tbody>
        {!pageAccounts.length && <tr><td colSpan="7"><div className="empty-state"><div><ShieldCheck size={24} /></div><h3>{!loaded ? "正在读取 MFA 账号" : accounts.length ? "没有匹配账号" : "暂无 MFA 账号"}</h3><p>{accounts.length ? "调整邮箱或状态筛选。" : "导入账号后，选择需要修改 MFA 的账号。"}</p></div></td></tr>}
        {pageAccounts.map((account) => <React.Fragment key={account.id}><tr className={selectedIds.has(account.id) ? "selected-row" : ""}>
          <td className="select-cell"><input type="checkbox" checked={selectedIds.has(account.id)} onChange={() => toggleSelection(account.id)} aria-label={`选择 MFA 账号 ${account.email}`} /></td>
          <td><strong className="mfa-email">{account.email}</strong><span className="mfa-credentials">{account.hasPassword ? "已导入密码" : "未提供密码"} · {account.hasTotpKey ? "已有 MFA 密钥" : "新建 MFA"}</span><div className="mfa-mobile-status"><MfaStatus status={account.status} /></div><span className="mfa-mobile-time">更新 {formatTime(account.updatedAt)}</span></td>
          <td className="mfa-status-column"><MfaStatus status={account.status} /></td>
          <td className="mfa-stage"><span>{STAGE_LABELS[account.stage] || account.stage || "等待开始"}</span>{account.error && <div className="row-error">{account.error}</div>}</td>
          <td className="mfa-stage mfa-device-column"><span className={`mfa-status mfa-status-${account.logoutStatus || "idle"}`}>{ACTIVE_STATUSES.has(account.logoutStatus) && <LoaderCircle size={12} className="spin" />}{account.logoutStatus === "success" && <Check size={12} />}{LOGOUT_LABELS[account.logoutStatus || "idle"]}</span>{account.logoutError && <div className="row-error">{account.logoutError}</div>}{account.logoutAt && <div className="mfa-date">{formatTime(account.logoutAt)}</div>}</td>
          <td className="mfa-date mfa-time-column"><div>更新 {formatTime(account.updatedAt)}</div><div className="insight-note">成功 {formatTime(account.changedAt)}</div></td>
          <td><button type="button" className="icon-button" aria-label={`${expandedAccountId === account.id ? "收起" : "查看"} ${account.email} 的详情日志`} aria-expanded={expandedAccountId === account.id} aria-controls={`mfa-logs-${account.id}`} title={expandedAccountId === account.id ? "收起详情日志" : "查看详情日志"} onClick={() => setExpandedAccountId((current) => current === account.id ? null : account.id)}><FileText size={17} />{expandedAccountId === account.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</button></td>
        </tr></React.Fragment>)}
      </tbody></table></div>
      <div className="mfa-pagination"><span>共 {filtered.length} 条，每页 {PAGE_SIZE} 条</span><div><button type="button" className="icon-button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} title="MFA 上一页"><ChevronLeft size={17} /></button><span>{currentPage} / {totalPages}</span><button type="button" className="icon-button" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)} title="MFA 下一页"><ChevronRight size={17} /></button></div></div>

      {detailAccount && <Drawer title="MFA 任务详情" onClose={() => setExpandedAccountId(null)} wide>
        <p className="detail-email">{detailAccount.email}</p>
        <section className="detail-section"><h3>账号授权</h3><p className="prompt-line">复用已有登录会话，同步到未接码列表并自动检测额度。</p><button type="button" className="secondary-button" disabled={!token || Boolean(action) || ACTIVE_STATUSES.has(detailAccount.status) || ACTIVE_STATUSES.has(detailAccount.logoutStatus)} onClick={() => syncAuthorization([detailAccount])}><Send size={16} />同步到账号授权</button></section>
        <section className="detail-section"><h3>修改进度</h3><MfaStatus status={detailAccount.status} /><p className="prompt-line">{STAGE_LABELS[detailAccount.stage] || detailAccount.stage}</p>{detailAccount.error && <p className="row-error">{detailAccount.error}</p>}</section>
        <section className="detail-section"><h3>设备登出</h3><MfaStatus status={detailAccount.logoutStatus || "idle"} logout />{detailAccount.logoutError && <p className="row-error">{detailAccount.logoutError}</p>}{detailAccount.logoutAt && <p className="prompt-line">{formatTime(detailAccount.logoutAt)}</p>}</section>
        <section className="detail-section"><h3>时间</h3><dl className="detail-dates"><div><dt>创建时间</dt><dd>{detailAccount.createdAt ? formatTime(detailAccount.createdAt) : "未知"}</dd></div><div><dt>最近更新</dt><dd>{formatTime(detailAccount.updatedAt)}</dd></div><div><dt>修改成功</dt><dd>{formatTime(detailAccount.changedAt)}</dd></div></dl></section>
        <section className="detail-section"><h3>详情日志</h3><MfaLogs key={detailAccount.id} accountId={detailAccount.id} request={request} /></section>
      </Drawer>}
      {historyOpen && <Drawer title="操作历史" onClose={() => setHistoryOpen(false)} wide><section className="mfa-history" aria-labelledby="mfa-history-title">
        <p id="mfa-history-title" className="drawer-description">最近 {Math.min(history.length, 50)} 条记录</p>
        {historyError && <div className="global-error" role="alert">{historyError}</div>}
        <div className="table-frame"><table>
          <thead><tr><th>账号</th><th>操作</th><th>结果</th><th>进度 / 错误</th><th>开始时间</th><th>结束时间</th></tr></thead>
          <tbody>
            {history.slice(0, 50).map((item) => <tr key={item.id}>
              <td data-label="账号">{item.email}</td><td data-label="操作">{item.operation === "logout_all" ? "登出所有设备" : "修改 MFA"}</td><td data-label="结果"><MfaStatus status={item.status} logout={item.operation === "logout_all"} /></td>
              <td data-label="进度" className="mfa-stage">{STAGE_LABELS[item.stage] || item.stage || "—"}{item.error && <div className="row-error">{item.error}</div>}</td>
              <td data-label="开始" className="mfa-date">{formatTime(item.startedAt)}</td><td data-label="结束" className="mfa-date">{formatTime(item.finishedAt)}</td>
            </tr>)}
            {!history.length && <tr><td colSpan="6" className="mfa-history-empty">暂无操作记录</td></tr>}
          </tbody>
        </table></div>
      </section></Drawer>}

      {exportPreview && <MfaExportDialog data={exportPreview} onClose={() => setExportPreview(null)} />}

      {importOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !action) setImportOpen(false); }}><form className="batch-dialog mfa-import-dialog" onSubmit={previewImport} role="dialog" aria-modal="true" aria-labelledby="mfa-import-title">
        <div className="dialog-header"><div><h2 id="mfa-import-title">导入 MFA 账号</h2><span>每行一个账号，预览确认后导入</span></div><button type="button" className="icon-button" title="关闭导入" disabled={Boolean(action)} onClick={() => setImportOpen(false)}><X size={18} /></button></div>
        <label className="batch-label" htmlFor="mfa-import-text">邮箱----密码----当前 MFA 密钥；未启用 MFA 可省略密钥</label>
        <textarea id="mfa-import-text" value={text} onChange={(event) => { setText(event.target.value); setPreview(null); }} placeholder="name@example.com----账号密码----当前MFA密钥\nnew@example.com----账号密码" spellCheck="false" autoComplete="off" disabled={Boolean(action)} autoFocus />
        {preview && <div className="mfa-import-preview" role="status"><strong>识别到 {preview.count} 个账号</strong><ul>{(preview.accounts || []).slice(0, 8).map((account, index) => <li key={`${account.email}-${index}`}>{account.email}</li>)}</ul>{preview.count > 8 && <span>另有 {preview.count - 8} 个账号</span>}</div>}
        {error && <div className="dialog-error" role="alert"><CircleAlert size={15} />{error}</div>}
        <div className="dialog-footer"><button type="button" className="cancel-button" disabled={Boolean(action)} onClick={() => setImportOpen(false)}>取消</button><button type="submit" className="secondary-button" disabled={!text.trim() || Boolean(action)}>{action === "preview" ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}预览账号</button><button type="button" className="primary-button" disabled={!preview?.count || Boolean(action)} onClick={importAccounts}>{action === "import" ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}确认导入 {preview?.count || ""}</button></div>
      </form></div>}
    </section>
  );
}

function MfaExportDialog({ data, onClose }) {
  const dialogRef = useRef(null);
  const contentRef = useRef(null);
  const [copyState, setCopyState] = useState("");
  useDialogFocus(true, onClose, dialogRef, data.returnFocus);

  async function copyContent() {
    setCopyState("copying");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(data.content);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
      contentRef.current?.focus();
      contentRef.current?.select();
    }
  }

  function downloadContent() {
    const url = URL.createObjectURL(data.blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = data.filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  return <div className="modal-backdrop mfa-export-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="mfa-export-dialog" role="dialog" aria-modal="true" aria-labelledby="mfa-export-title" aria-describedby="mfa-export-description">
      <header className="drawer-heading"><h2 id="mfa-export-title">导出 MFA 结果</h2><button type="button" className="icon-button" aria-label="关闭导出预览" onClick={onClose}><X size={19} /></button></header>
      <p id="mfa-export-description" className="mfa-export-description">{data.scope} · {data.format.toUpperCase()}<br />{data.format === "txt" ? "每行格式：邮箱----密码----新 MFA 密钥" : "JSON 格式，保留完整导出字段"}</p>
      <label className="mfa-export-label" htmlFor="mfa-export-content">导出内容</label>
      <textarea ref={contentRef} id="mfa-export-content" value={data.content} readOnly spellCheck="false" autoComplete="off" />
      <div className={`mfa-export-feedback${copyState === "failed" ? " is-error" : ""}`} role={copyState === "failed" ? "alert" : "status"}>
        {copyState === "copied" ? "已复制全部内容。" : copyState === "failed" ? "无法访问剪贴板，内容已选中，请手动复制。" : "可直接复制全部内容，也可选中部分内容复制。"}
      </div>
      <footer className="mfa-export-actions">
        <button type="button" className="secondary-button" onClick={downloadContent}><Download size={16} />下载 {data.format.toUpperCase()}</button>
        <button type="button" className="primary-button" disabled={copyState === "copying"} onClick={copyContent}>{copyState === "copying" ? <LoaderCircle size={16} className="spin" /> : copyState === "copied" ? <Check size={16} /> : <Copy size={16} />}{copyState === "copying" ? "正在复制" : copyState === "copied" ? "已复制" : "复制全部"}</button>
      </footer>
    </section>
  </div>;
}

function MfaLogs({ accountId, request }) {
  const [logs, setLogs] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const preRef = useRef(null);
  const followTail = useRef(true);

  useEffect(() => {
    let stopped = false;
    let timer;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const data = await (await request(`accounts/${accountId}/logs`, { signal: controller.signal })).json();
        if (!stopped) { setLogs(data.logs || ""); setError(data.error || ""); setLoaded(true); }
      } catch (requestError) {
        if (!stopped) setError(`日志读取失败：${requestError.message}`);
      } finally {
        if (!stopped) timer = window.setTimeout(poll, 1_200);
      }
    };
    void poll();
    return () => { stopped = true; controller.abort(); window.clearTimeout(timer); };
  }, [accountId, request]);

  useEffect(() => {
    if (followTail.current && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [logs]);

  return <div id={`mfa-logs-${accountId}`} className="log-panel">
    <div className="log-title"><FileText size={15} />2FA 详情日志 · 自动更新</div>
    {error && <div className="mfa-log-error" role="alert">{error}</div>}
    <pre ref={preRef} onScroll={(event) => { const element = event.currentTarget; followTail.current = element.scrollHeight - element.scrollTop - element.clientHeight < 30; }}>{logs || (loaded ? "暂无详情日志。后续修改、恢复或登出操作会自动记录。" : "正在读取日志...")}</pre>
  </div>;
}

function MfaStatus({ status, logout = false }) {
  return <span className={`mfa-status mfa-status-${status}`}>{ACTIVE_STATUSES.has(status) && <LoaderCircle size={12} className={status === "running" ? "spin" : ""} />}{status === "success" && <Check size={12} />}{RETRY_STATUSES.has(status) && <CircleAlert size={12} />}{(logout ? LOGOUT_LABELS[status] : STATUS_LABELS[status]) || status}</span>;
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
