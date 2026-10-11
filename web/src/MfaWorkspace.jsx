import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ban, Check, ChevronLeft, ChevronRight, CircleAlert, Download, History, ListPlus, LoaderCircle, LogOut, RefreshCw, Search, ShieldCheck, X } from "lucide-react";

const PAGE_SIZE = 20;
const ACTIVE_STATUSES = new Set(["queued", "running"]);
const RETRY_STATUSES = new Set(["failed", "interrupted"]);
const STATUS_LABELS = {
  ready: "待修改", queued: "排队中", running: "修改中", success: "已成功", failed: "失败", interrupted: "已中断",
};
const STAGE_LABELS = {
  ready: "等待开始", queued: "等待处理", rotating: "正在修改 MFA", saving: "保存并同步新密钥",
  completed: "新 MFA 已确认生效", failed: "修改未完成，可重试恢复", interrupted: "任务已中断，可重试恢复", cancel_requested: "完成当前操作后停止",
  pending: "登录验证", authenticated: "账号身份已确认", disable_requested: "确认旧 MFA 关闭状态",
  disabled: "旧 MFA 已关闭，等待设置新密钥", enroll_requested: "申请新 MFA 密钥",
  enrolled: "新密钥已保存，等待激活", activating: "激活并确认新 MFA", confirmed: "新 MFA 已确认生效",
  logout_queued: "等待登出", logging_out: "正在登出所有设备", logged_out: "所有设备已登出",
  logout_failed: "登出未完成，可重试登出", logout_interrupted: "登出已中断，可重试登出",
};
const LOGOUT_LABELS = { idle: "尚未登出", queued: "等待登出", running: "正在登出", success: "已登出", failed: "登出失败", interrupted: "登出中断" };

export default function MfaWorkspace({ token, defaultProxyUrl }) {
  const [accounts, setAccounts] = useState([]);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyError, setHistoryError] = useState("");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [concurrency, setConcurrency] = useState(3);
  const [proxyUrl, setProxyUrl] = useState(defaultProxyUrl || "");
  const [action, setAction] = useState("");
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [notice, setNotice] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const concurrencyLoaded = useRef(false);

  const request = useCallback(async (path, options = {}) => {
    const response = await fetch(`/api/mfa/${path}`, {
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
    (statusFilter === "all" || account.status === statusFilter)
    && account.email.toLowerCase().includes(query.trim().toLowerCase())
  )), [accounts, query, statusFilter]);
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

  function logoutDevices() {
    if (!logoutable.length || !validConcurrency) return;
    if (!window.confirm(`为${selectedIds.size ? "所选" : "当前筛选中"} ${logoutable.length} 个 MFA 修改成功的账号登出所有设备？包括本次登录会话。`)) return;
    void perform("logout-all", async () => {
      const data = await (await request("logout-all", {
        method: "POST", body: JSON.stringify({ ids: logoutable.map((account) => account.id), concurrency: Number(concurrency), proxyUrl: proxyUrl.trim() }),
      })).json();
      setNotice(`已安排 ${data.started} 个账号登出所有设备，结果会显示在“设备登出”列。`);
      await refresh();
    });
  }

  function exportAccounts(format) {
    void perform(`export-${format}`, async () => {
      const response = await request("export", {
        method: "POST", body: JSON.stringify({ ...(selectedIds.size ? { ids: [...selectedIds] } : {}), format }),
      });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      const disposition = response.headers.get("content-disposition") || "";
      const rawName = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition)?.[1]
        || /filename\s*=\s*"?([^";]+)/i.exec(disposition)?.[1];
      let filename = `mfa-success-${exportable.length}-${Date.now()}.${format}`;
      if (rawName) {
        try { filename = decodeURIComponent(rawName.trim().replace(/^"|"$/g, "")).replace(/[\\/]/g, "_"); } catch {}
      }
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setNotice(`已导出 ${selectedIds.size ? "所选账号中的" : "全部"}成功结果。`);
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

      <div className="mfa-stats" aria-label="MFA 处理统计">
        <div><span>账号总数</span><strong>{accounts.length}</strong></div>
        <div><span>待处理 / 排队</span><strong>{(counts.ready || 0) + (counts.queued || 0)}</strong></div>
        <div><span>修改中</span><strong>{counts.running || 0}</strong></div>
        <div className="mfa-stat-success"><span>修改成功</span><strong>{counts.success || 0}</strong></div>
        <div className="mfa-stat-failed"><span>失败 / 中断</span><strong>{(counts.failed || 0) + (counts.interrupted || 0)}</strong></div>
      </div>

      {(error || pollError) && <div className="global-error" role="alert"><CircleAlert size={17} /><span>{error || pollError}</span><button type="button" title="关闭错误提示" onClick={() => { setError(""); setPollError(""); }}><X size={16} /></button></div>}
      {notice && <div className="global-success" role="status"><Check size={17} /><span>{notice}</span><button type="button" title="关闭提示" onClick={() => setNotice("")}><X size={16} /></button></div>}

      <div className="mfa-controls">
        <label className="mfa-control"><span>并发数</span><input type="number" min="1" max="30" step="1" value={concurrency} onChange={(event) => { concurrencyLoaded.current = true; setConcurrency(event.target.value); }} /></label>
        <label className="mfa-control mfa-proxy-control"><span>代理地址</span><input type="text" value={proxyUrl} onChange={(event) => setProxyUrl(event.target.value)} autoComplete="off" spellCheck="false" placeholder="留空使用默认网络" /></label>
        <label className="mfa-control mfa-search-control"><span><Search size={13} />筛选邮箱</span><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="输入邮箱关键词" /></label>
        <label className="mfa-control"><span>状态</span><select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}><option value="all">全部状态</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      {!validConcurrency && <div className="global-error" role="alert">并发数需为 1 到 30 的整数。</div>}

      <div className="selection-toolbar mfa-selection-toolbar">
        <div className="selection-summary">
          <span>匹配 {filtered.length} 条 · 跨页已选 {selectedIds.size} 条</span>
          <button type="button" className="selection-text-button" disabled={!filtered.length} onClick={() => setSelectedIds((current) => new Set([...current, ...filtered.map((account) => account.id)]))}>全选筛选结果</button>
          <button type="button" className="selection-text-button" disabled={!selectedIds.size} onClick={() => setSelectedIds(new Set())}>清除选择</button>
        </div>
        <div className="bulk-actions">
          <button type="button" className="primary-button bulk-button" disabled={!token || running || !startable.length || !validConcurrency || Boolean(action)} onClick={() => startAccounts(startable)} title={running ? "当前批次结束后可开始下一批" : "修改所选账号的 MFA"}>{action === "start" ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}批量修改 {startable.length || ""}</button>
          <button type="button" className="secondary-button bulk-button" disabled={running || !retryable.length || !validConcurrency || Boolean(action)} onClick={() => startAccounts(retryable, true)} title={running ? "当前批次结束后可重试" : selectedIds.size ? "重试所选账号中的失败和中断任务" : "重试筛选结果中的失败和中断任务"}>{action === "retry" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}重试失败 / 中断 {retryable.length || ""}</button>
          <button type="button" className="secondary-button bulk-button" disabled={!token || running || !logoutable.length || !validConcurrency || Boolean(action)} onClick={logoutDevices} title={selectedIds.size ? "登出所选成功账号的所有设备" : "登出当前筛选中成功账号的所有设备"}>{action === "logout-all" ? <LoaderCircle className="spin" size={15} /> : <LogOut size={15} />}登出所有设备 {logoutable.length || ""}</button>
          <button type="button" className="secondary-button bulk-button" disabled={!cancelable.length || Boolean(action)} onClick={cancelAccounts}><Ban size={15} />停止所选</button>
        </div>
      </div>

      <div className="mfa-export-toolbar">
        <span>{selectedIds.size ? "所选账号中" : "全部账号中"}可导出 {exportable.length} 条成功结果 · TXT：邮箱----密码----新 MFA 密钥</span>
        <div><button type="button" className="secondary-button" disabled={running || !exportable.length || Boolean(action)} onClick={() => exportAccounts("txt")}>{action === "export-txt" ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}导出 TXT</button><button type="button" className="secondary-button" disabled={running || !exportable.length || Boolean(action)} onClick={() => exportAccounts("json")}>{action === "export-json" ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}导出 JSON</button></div>
      </div>

      <div className="table-frame"><table className="mfa-table"><thead><tr>
        <th className="select-heading"><input type="checkbox" checked={allPageSelected} disabled={!pageAccounts.length} onChange={selectPage} aria-label="选择当前页全部 MFA 账号" /></th><th>账号</th><th>状态</th><th>当前进度</th><th>设备登出</th><th>最近更新</th><th>修改成功时间</th>
      </tr></thead><tbody>
        {!pageAccounts.length && <tr><td colSpan="7"><div className="empty-state"><div><ShieldCheck size={24} /></div><h3>{!loaded ? "正在读取 MFA 账号" : accounts.length ? "没有匹配账号" : "暂无 MFA 账号"}</h3><p>{accounts.length ? "调整邮箱或状态筛选。" : "导入账号后，选择需要修改 MFA 的账号。"}</p></div></td></tr>}
        {pageAccounts.map((account) => <tr key={account.id} className={selectedIds.has(account.id) ? "selected-row" : ""}>
          <td className="select-cell"><input type="checkbox" checked={selectedIds.has(account.id)} onChange={() => toggleSelection(account.id)} aria-label={`选择 MFA 账号 ${account.email}`} /></td>
          <td><strong className="mfa-email">{account.email}</strong><span className="mfa-credentials">{account.hasPassword ? "已导入密码" : "未提供密码"} · {account.hasTotpKey ? "已有 MFA 密钥" : "新建 MFA"}</span></td>
          <td><MfaStatus status={account.status} /></td>
          <td className="mfa-stage"><span>{STAGE_LABELS[account.stage] || account.stage || "等待开始"}</span>{account.error && <div className="row-error">{account.error}</div>}</td>
          <td className="mfa-stage"><span className={`mfa-status mfa-status-${account.logoutStatus || "idle"}`}>{ACTIVE_STATUSES.has(account.logoutStatus) && <LoaderCircle size={12} className="spin" />}{account.logoutStatus === "success" && <Check size={12} />}{LOGOUT_LABELS[account.logoutStatus || "idle"]}</span>{account.logoutError && <div className="row-error">{account.logoutError}</div>}{account.logoutAt && <div className="mfa-date">{formatTime(account.logoutAt)}</div>}</td>
          <td className="mfa-date">{formatTime(account.updatedAt)}</td><td className="mfa-date">{formatTime(account.changedAt)}</td>
        </tr>)}
      </tbody></table></div>
      <div className="mfa-pagination"><span>共 {filtered.length} 条，每页 {PAGE_SIZE} 条</span><div><button type="button" className="icon-button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} title="MFA 上一页"><ChevronLeft size={17} /></button><span>{currentPage} / {totalPages}</span><button type="button" className="icon-button" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)} title="MFA 下一页"><ChevronRight size={17} /></button></div></div>

      {historyOpen && <section className="mfa-history" aria-labelledby="mfa-history-title">
        <div className="section-heading"><div><h2 id="mfa-history-title">操作历史</h2><p>最近 {Math.min(history.length, 50)} 条记录</p></div></div>
        {historyError && <div className="global-error" role="alert">{historyError}</div>}
        <div className="table-frame"><table>
          <thead><tr><th>账号</th><th>操作</th><th>结果</th><th>进度 / 错误</th><th>开始时间</th><th>结束时间</th></tr></thead>
          <tbody>
            {history.slice(0, 50).map((item) => <tr key={item.id}>
              <td>{item.email}</td><td>{item.operation === "logout_all" ? "登出所有设备" : "修改 MFA"}</td><td><MfaStatus status={item.status} logout={item.operation === "logout_all"} /></td>
              <td className="mfa-stage">{STAGE_LABELS[item.stage] || item.stage || "—"}{item.error && <div className="row-error">{item.error}</div>}</td>
              <td className="mfa-date">{formatTime(item.startedAt)}</td><td className="mfa-date">{formatTime(item.finishedAt)}</td>
            </tr>)}
            {!history.length && <tr><td colSpan="6" className="mfa-history-empty">暂无操作记录</td></tr>}
          </tbody>
        </table></div>
      </section>}

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

function MfaStatus({ status, logout = false }) {
  return <span className={`mfa-status mfa-status-${status}`}>{ACTIVE_STATUSES.has(status) && <LoaderCircle size={12} className={status === "running" ? "spin" : ""} />}{status === "success" && <Check size={12} />}{RETRY_STATUSES.has(status) && <CircleAlert size={12} />}{(logout ? LOGOUT_LABELS[status] : STATUS_LABELS[status]) || status}</span>;
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
