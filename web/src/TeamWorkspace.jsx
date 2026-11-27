import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Check, ChevronLeft, ChevronRight, CircleAlert, Clock3, LoaderCircle, Mail, Plus, RefreshCw, Search, ShieldCheck, Trash2, Users, X } from "lucide-react";
import { cdkFetch, prepareProxyNetworkOptions, readWorkspaceProxyPoolText } from "./cdk-api.mjs";
import { ProxyNetworkOptions } from "./ProxyPoolInput.jsx";
import { Drawer, useDialogFocus } from "./WorkspaceUi.jsx";
import "./teams.css";

const STATES = { queued: "排队中", running: "识别中", waiting_input: "待验证", ready: "可管理", no_team: "未发现团队", auth_expired: "需重新登录", failed: "同步失败", interrupted: "已中断" };
const initialFilters = { search: "", status: "all", seats: "all", expiring: false };
const requestKey = () => crypto.randomUUID();
const time = (value, dateOnly = false) => value ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", ...(dateOnly ? {} : { hour: "2-digit", minute: "2-digit", hour12: false }) }).format(new Date(value)) : "—";
const seatName = (type) => ({ default: "标准", prolite: "高级" })[type] || type || "未知";
const emailsOf = (raw) => [...new Set(raw.split(/[\s,;，；]+/).map((email) => email.trim().toLowerCase()).filter(Boolean))];
const isAbort = (error) => error?.name === "AbortError";

function useTeamApi(token) {
  const controller = useMemo(() => new AbortController(), [token]);
  useEffect(() => () => controller.abort(), [controller]);
  return useCallback(async (route, body) => {
    const response = await cdkFetch(`/api/teams/${route}`, { method: body === undefined ? "GET" : "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "x-console-token": token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (controller.signal.aborted) throw new DOMException("Workspace changed", "AbortError");
    if (!response.ok) throw new Error(data.error || "团队请求失败，请重试");
    return data;
  }, [token, controller]);
}

function Status({ row }) {
  const label = row.status === "ready" && !row.capabilities?.canInvite && !row.capabilities?.canRemove ? "仅查看" : STATES[row.status] || "待识别";
  const tone = row.status === "ready" ? label === "仅查看" ? "neutral" : "success" : ["failed", "auth_expired"].includes(row.status) ? "warning" : "neutral";
  return <span className={`team-status team-status-${tone}`}><i aria-hidden="true" />{label}</span>;
}
function SeatValue({ pool }) {
  if (!pool) return <span className="team-muted">—</span>;
  const ratio = typeof pool.used === "number" && pool.purchased > 0 ? Math.min(100, pool.used / pool.purchased * 100) : 0;
  return <div className="team-seat-value"><strong>{pool.used ?? "—"}<span> / {pool.purchased ?? "—"}</span></strong><div className={`team-seat-track ${ratio >= 100 ? "full" : ""}`}><span style={{ width: `${ratio}%` }} /></div><small>{pool.purchased === 0 ? "未购买" : `可用 ${pool.available ?? "未知"}`}</small></div>;
}
function Pager({ page, pages, total, onPage }) {
  return <div className="team-pagination"><span>共 {total} 条</span><div><button type="button" className="icon-button" aria-label="上一页" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={16} /></button><span>{page} / {pages}</span><button type="button" className="icon-button" aria-label="下一页" disabled={page >= pages} onClick={() => onPage(page + 1)}><ChevronRight size={16} /></button></div></div>;
}
function TeamDialog({ title, description, onClose, children, className = "", busy = false }) {
  const ref = useRef(null), id = React.useId();
  useDialogFocus(true, () => { if (!busy) onClose(); }, ref);
  return <div className="modal-backdrop team-modal-backdrop" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}><section ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} className={`team-dialog ${className}`}><header className="team-dialog-heading"><div><h2 id={id}>{title}</h2>{description && <p>{description}</p>}</div><button type="button" className="icon-button" aria-label={`关闭${title}`} disabled={busy} onClick={onClose}><X size={19} /></button></header>{children}</section></div>;
}

export default function TeamWorkspace({ token }) {
  const api = useTeamApi(token);
  const [filters, setFilters] = useState(initialFilters), [page, setPage] = useState(1);
  const [data, setData] = useState({ rows: [], tasks: [], total: 0, pages: 1, page: 1, overview: {} });
  const [loaded, setLoaded] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [importing, setImporting] = useState(false), [updating, setUpdating] = useState(null);
  const [selected, setSelected] = useState(null), [prompt, setPrompt] = useState(null), [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const ticket = ++sequence.current;
    try { const value = await api("query", { ...filters, page }); if (ticket !== sequence.current) return; setData(value); setLoaded(true); setError(""); setRevision((value) => value + 1); }
    catch (failure) { if (!isAbort(failure) && ticket === sequence.current) setError(failure.message); }
  }, [api, filters, page]);
  useEffect(() => { void refresh(); return () => { sequence.current += 1; }; }, [refresh]);
  useEffect(() => { if (!data.overview.active) return undefined; const timer = setInterval(() => { void refresh(); }, 1800); return () => clearInterval(timer); }, [data.overview.active, refresh]);
  const changeFilters = (patch) => { setFilters((value) => ({ ...value, ...patch })); setPage(1); };
  const run = async (route, body, message) => {
    if (busy) return; setBusy(true); setError("");
    try { await api(route, body); if (message) setNotice(message); await refresh(); }
    catch (failure) { if (!isAbort(failure)) setError(failure.message); }
    finally { setBusy(false); }
  };
  const changed = async (message) => { if (message) setNotice(message); await refresh(); };
  const stats = data.overview;
  return <section className="workspace team-workspace" aria-labelledby="team-page-title">
    <header className="section-heading"><div><h2 id="team-page-title">Team 空间</h2><p>集中查看团队席位，快速邀请和管理成员。</p></div><button type="button" className="primary-button" onClick={() => setImporting(true)}><Plus size={17} />导入账号</button></header>
    {error && <div className="global-error" role="alert"><CircleAlert size={16} /><span>{error}</span><button type="button" className="icon-button" aria-label="关闭团队错误" onClick={() => setError("")}><X size={16} /></button></div>}
    {notice && <p className="team-notice" role="status"><Check size={15} />{notice}<button type="button" className="icon-button" aria-label="关闭操作提示" onClick={() => setNotice("")}><X size={14} /></button></p>}
    <div className="team-overview" aria-label="团队概览"><div><span>团队空间</span><strong>{stats.teams ?? "—"}</strong><small>已导入 {stats.accounts ?? 0} 个管理账号</small></div><div><span>已使用席位</span><strong>{stats.seatsKnown ? stats.used : "—"}<em> / {stats.seatsKnown ? stats.purchased : "—"}</em></strong><small>{stats.seatsKnown || 0} / {stats.teams || 0} 个团队的已知数据</small></div><div><span>待接受邀请</span><strong>{stats.pendingKnown ? stats.pending : "—"}</strong><small>独立统计 · {stats.pendingKnown || 0} 个团队已读取</small></div><div><span>7 天内到期</span><strong className="team-amber">{stats.expiring ?? "—"}</strong><small>仅试用或确定终止，不含自动续费</small></div></div>
    {stats.expired > 0 && <div className="team-attention"><CircleAlert size={16} /><span>{stats.expired} 个账号需要重新登录，已知团队数据仍保留。</span><button type="button" className="text-action" onClick={() => changeFilters({ status: "auth_expired" })}>查看账号</button></div>}
    {data.tasks.some((row) => row.status === "waiting_input") && <div className="team-input-tasks"><h3>待完成登录验证</h3>{data.tasks.filter((row) => row.status === "waiting_input").map((row) => <div key={row.id}><Mail size={15} /><span>{row.email}</span><button type="button" className="secondary-button" onClick={() => setPrompt(row)}>输入{row.prompt?.kind === "password" ? "密码" : row.prompt?.kind === "totp" ? "MFA 验证码" : "邮箱验证码"}</button><button type="button" className="text-action" onClick={() => void run(`accounts/${row.id}/cancel`, {}, "已停止该账号的登录任务")}>停止</button></div>)}</div>}
    <div className="team-list-heading"><h3>团队与管理账号 <small>{data.total} 条</small></h3><span>当前 CDK 工作区 · Asia/Shanghai</span></div>
    <div className="team-filters"><label className="team-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label="搜索团队或管理邮箱" placeholder="搜索团队名称、管理邮箱" value={filters.search} onChange={(event) => changeFilters({ search: event.target.value })} /></label><select aria-label="团队状态" value={filters.status} onChange={(event) => changeFilters({ status: event.target.value })}><option value="all">全部状态</option><option value="ready">已连接</option><option value="readonly">仅查看</option><option value="auth_expired">需重新登录</option><option value="failed">同步失败</option><option value="no_team">未发现团队</option><option value="interrupted">已中断</option></select><select aria-label="团队席位" value={filters.seats} onChange={(event) => changeFilters({ seats: event.target.value })}><option value="all">全部标准席位</option><option value="available">有可用席位</option><option value="full">席位已满</option></select><label className="team-check-filter"><input type="checkbox" checked={filters.expiring} onChange={(event) => changeFilters({ expiring: event.target.checked })} />7 天内到期</label><button type="button" className="secondary-button" disabled={busy || !stats.accounts || Boolean(stats.active)} onClick={() => void run("sync", {}, "已排队同步全部管理账号")}><RefreshCw size={15} />同步全部</button><button type="button" className="icon-button" aria-label="刷新团队列表" onClick={() => void refresh()}><RefreshCw size={16} /></button></div>
    <div className="table-frame team-table-frame"><table className="team-table"><thead><tr><th>团队空间</th><th>管理账号</th><th>标准席位</th><th>高级席位</th><th>待接受邀请</th><th>到期 / 续费时间</th><th>状态</th><th>操作</th></tr></thead><tbody>{data.rows.map((row) => <tr key={`${row.kind}:${row.id}`}><td><div className="team-identity"><span className="team-avatar">{row.kind === "team" ? row.name.slice(0, 1) : <Users size={17} />}</span><div><strong>{row.name}</strong><small>{row.kind === "team" ? `${row.planType || "Business"}${row.subscription?.billingPeriod ? ` · ${{ month: "月付", monthly: "月付", year: "年付", annual: "年付" }[row.subscription.billingPeriod] || row.subscription.billingPeriod}` : ""}` : row.message || "导入后识别可访问的团队"}</small></div></div></td><td><span className="team-email">{row.email}</span><small className="team-account-role"><ShieldCheck size={12} />{row.capabilities?.roleLabel || "身份待确认"}{row.accounts?.length > 1 && ` · 另有 ${row.accounts.length - 1} 个账号`}</small></td><td><SeatValue pool={row.subscription?.pools.default} /></td><td><SeatValue pool={row.subscription?.pools.prolite} /></td><td><span className={`team-invite-count ${row.pendingInvites ? "has-pending" : ""}`}>{row.pendingInvites ?? "—"}</span></td><td><span className="team-date">{time(row.subscription?.event?.at, true)}</span><small className={row.subscription?.event?.kind === "trial" || row.subscription?.event?.kind === "expiry" ? "team-amber" : ""}>{row.subscription?.event?.label || "等待识别订阅"}{row.subscription?.willRenew === true && " · 自动续费"}</small>{row.subscriptionStale && <small className="team-amber">历史快照</small>}</td><td><Status row={row} />{row.stale && row.checkedAt && <small className="team-amber">部分数据待同步</small>}</td><td><div className="team-row-actions">{row.kind === "team" && <button type="button" className="text-action" onClick={() => setSelected({ id: row.id, accountId: row.accountId })}>{row.status === "ready" ? "管理" : "查看快照"}<ChevronRight size={14} /></button>}{!["running", "queued", "waiting_input"].includes(row.status) && <><button type="button" className="text-action" disabled={busy || row.busy} onClick={() => void run("sync", { ids: [row.accountId] }, "已排队重新识别团队")}>重新识别</button><button type="button" className="text-action" onClick={() => setUpdating({ id: row.accountId, email: row.email })}>更新登录</button></>}{["queued", "running"].includes(row.status) && <button type="button" className="text-action" onClick={() => void run(`accounts/${row.accountId}/cancel`, {}, "任务已停止")}>停止</button>}</div></td></tr>)}</tbody></table>{!data.rows.length && <div className="team-empty"><Users size={30} /><h3>{!loaded ? "正在读取团队" : filters.search || filters.status !== "all" || filters.seats !== "all" || filters.expiring ? "没有匹配的团队" : "导入管理账号，开始管理团队"}</h3><p>{!loaded ? "请稍候" : "可从已有账号授权中选择，或使用相同格式导入账号资料。"}</p>{loaded && <button type="button" className="secondary-button" onClick={() => filters.search || filters.status !== "all" || filters.seats !== "all" || filters.expiring ? (setFilters(initialFilters), setPage(1)) : setImporting(true)}>{filters.search || filters.status !== "all" || filters.seats !== "all" || filters.expiring ? "清除筛选" : "导入账号"}</button>}</div>}</div>
    <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} />
    <p className="team-footnote"><CircleAlert size={14} />待接受邀请单独统计；移除成员后重新同步使用量，购买席位数量保持不变。</p>
    {selected && <TeamManage api={api} selected={selected} revision={revision} onClose={() => setSelected(null)} onChanged={changed} onUpdate={setUpdating} />}
    {importing && <TeamImport api={api} onClose={() => setImporting(false)} onChanged={changed} />}
    {updating && <TeamImport api={api} account={updating} onClose={() => setUpdating(null)} onChanged={changed} />}
    {prompt && <TeamPrompt api={api} account={prompt} onClose={() => setPrompt(null)} onChanged={changed} />}
  </section>;
}

function TeamManage({ api, selected, revision, onClose, onChanged, onUpdate }) {
  const [accountId, setAccountId] = useState(selected.accountId), [tab, setTab] = useState("members"), [search, setSearch] = useState(""), [page, setPage] = useState(1);
  const [data, setData] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [invite, setInvite] = useState(false), [removing, setRemoving] = useState(null), [roleChange, setRoleChange] = useState(null);
  useEffect(() => { let current = true; void api(`${selected.id}/query`, { accountId, tab, search, page }).then((value) => { if (current) { setData(value); setError(""); } }).catch((failure) => { if (current && !isAbort(failure)) setError(failure.message); }); return () => { current = false; }; }, [api, selected.id, accountId, tab, search, page, revision]);
  const team = data?.team;
  const switchAccount = async (value) => { if (busy) return; setBusy(true); try { await api(`${selected.id}/select-account`, { accountId: value }); setData(null); setAccountId(value); setPage(1); setSearch(""); await onChanged(); } catch (failure) { if (!isAbort(failure)) setError(failure.message); } finally { setBusy(false); } };
  const sync = async () => { if (busy) return; setBusy(true); try { await api("sync", { ids: [accountId] }); await onChanged("已排队同步当前团队账号"); } catch (failure) { if (!isAbort(failure)) setError(failure.message); } finally { setBusy(false); } };
  return <div className="team-drawer-shell"><Drawer wide title={team?.name || "团队管理"} onClose={onClose}>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    {!team ? <div className="team-empty"><LoaderCircle className="spin" size={24} /><p>正在读取团队信息</p></div> : <>
      <div className="team-manage-account"><label>管理账号<select aria-label="选择团队管理账号" value={accountId} onChange={(event) => void switchAccount(event.target.value)} disabled={busy || team.busy}>{team.accounts.map((row) => <option key={row.id} value={row.id}>{row.email} · {row.roleLabel}</option>)}</select></label><Status row={team} /></div>
      {team.status !== "ready" && <div className="team-attention"><CircleAlert size={16} /><span>{team.message || "当前展示历史快照，请重新识别或更新登录。"}</span><button type="button" className="text-action" onClick={() => onUpdate({ id: accountId, email: team.email })}>更新登录</button></div>}
      {Object.keys(team.errors).length > 0 && <div className="team-section-errors" role="status">{Object.entries(team.errors).map(([key, value]) => <p key={key}>{{ members: "成员", invites: "待接受邀请", subscription: "订阅与席位", settings: "团队设置", policy: "邀请策略", refresh: "操作后同步" }[key] || key}：{value.message}</p>)}</div>}
      <div className="team-seat-panels">{[["default", "标准席位"], ["prolite", "高级席位"]].map(([key, label]) => { const pool = team.subscription?.pools[key]; return <section key={key}><h3>{label}<Users size={15} /></h3><strong>{pool?.purchased ?? "—"}<small> 个席位</small></strong><div><span>已使用<b>{pool?.used ?? "—"}</b></span><span>当前可用<b className="team-blue">{pool?.available ?? "—"}</b></span></div></section>; })}</div>
      <div className="team-subscription-line"><CalendarDays size={15} /><span>{team.subscription?.event?.label || "订阅时间未知"}：{time(team.subscription?.event?.at)}</span><span>{team.subscription?.willRenew === true ? "自动续费已开启" : team.subscription?.willRenew === false ? "未开启自动续费" : "续费状态未知"}</span></div>
      <div className="team-detail-tabs" aria-label="团队管理视图">{[["members", "现有成员", team.membersTotal], ["invites", "待接受邀请", team.pendingInvites], ["logs", "操作记录", team.logs.length]].map(([key, label, count]) => <button type="button" key={key} aria-pressed={tab === key} onClick={() => { setTab(key); setPage(1); setSearch(""); }}>{label}<small>{count ?? "—"}</small></button>)}</div>
      {tab === "logs" ? <div className="team-logs"><p className="team-muted">仅记录本工作台发起的操作。</p>{team.logs.length ? team.logs.map((row) => <div key={row.id}><Clock3 size={15} /><div><strong>{{ sync: "同步团队", invite: "邀请成员", remove: "移除成员", role: "修改成员角色" }[row.action] || row.action}</strong><p>{row.message}</p><small>{time(row.at)} · {row.status === "success" ? "已完成" : row.status === "partial" ? "部分完成" : row.status === "unknown" ? "待核对" : "未完成"}</small></div></div>) : <p className="team-empty">暂无操作记录</p>}</div> : <>
        <div className="team-member-toolbar"><label className="team-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label="搜索团队成员" placeholder={tab === "members" ? "搜索成员邮箱、姓名" : "搜索被邀请邮箱"} value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} /></label><button type="button" className="primary-button" disabled={!team.capabilities.canInvite || team.status !== "ready" || team.busy || busy} title={team.capabilities.inviteReason || "邀请成员"} onClick={() => setInvite(true)}><Plus size={15} />邀请成员</button></div>
        <table className="team-member-table"><thead><tr><th>{tab === "members" ? "成员" : "被邀请邮箱"}</th><th>角色</th><th>席位</th><th>{tab === "members" ? "加入日期" : "邀请时间"}</th><th>{tab === "members" ? "操作" : "状态"}</th></tr></thead><tbody>{data.items.map((row) => <tr key={row.id || row.email}><td><div className="team-member-name">{tab === "members" && <span className="team-member-avatar">{(row.name || row.email).slice(0, 1).toUpperCase()}</span>}<div><strong>{tab === "members" ? row.name || "未设置姓名" : row.email}{row.id === team.capabilities.currentMemberId && <small>（当前账号）</small>}</strong>{tab === "members" && <small>{row.email}</small>}</div></div></td><td>{tab === "members" && row.roleChoices?.length > 0 ? <select className="team-role-select" aria-label={`修改 ${row.email} 的角色`} value={row.role} disabled={team.busy || busy || team.status !== "ready"} onChange={(event) => setRoleChange({ member: row, role: event.target.value })}><option value={row.role}>{row.roleLabel}</option>{row.roleChoices.map((role) => <option key={role} value={role}>{role === "account-owner" ? "设为所有者" : "改为普通成员"}</option>)}</select> : row.roleLabel || ({ "standard-user": "成员", "account-owner": "所有者", "account-admin": "管理员" })[row.role] || "未识别角色"}</td><td>{seatName(row.seatType)}</td><td className="team-date">{time(tab === "members" ? row.joinedAt : row.createdAt, true)}</td><td>{tab === "invites" ? <span className="team-muted">待接受</span> : row.canRemove ? <button type="button" className="text-action team-danger" disabled={team.status !== "ready" || team.busy || busy} onClick={() => setRemoving(row)}>移除</button> : <span className="team-muted">{row.scimManaged ? "目录管理" : row.id === team.capabilities.currentMemberId || row.role === "account-owner" ? "受保护" : "无操作权限"}</span>}</td></tr>)}</tbody></table>
        {!data.items.length && <div className="team-empty"><Mail size={26} /><h3>{search ? "没有匹配的记录" : tab === "members" ? "暂无可用成员数据" : "暂无待接受邀请"}</h3></div>}
        <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} />
        <p className="team-footnote">{tab === "members" ? "当前账号不能直接移除；可先由所有者降级目标账号，再切换另一所有者移除。团队至少保留一位所有者。" : "待接受邀请不计入现有成员。首版暂不提供撤销与重发操作。"}</p>
      </>}
      <footer className="team-drawer-footer"><span>最近查询：{time(team.checkedAt)} · Asia/Shanghai</span><button type="button" className="secondary-button" disabled={busy || team.busy || ["queued", "running", "waiting_input"].includes(team.status)} onClick={() => void sync()}><RefreshCw size={15} />同步团队</button></footer>
      {invite && <TeamInvite api={api} team={team} onClose={() => setInvite(false)} onChanged={onChanged} />}
      {roleChange && <TeamRoleChange api={api} team={team} member={roleChange.member} role={roleChange.role} onClose={() => setRoleChange(null)} onChanged={onChanged} />}
      {removing && <TeamRemove api={api} team={team} member={removing} onClose={() => setRemoving(null)} onChanged={onChanged} />}
    </>}
  </Drawer></div>;
}

function TeamInvite({ api, team, onClose, onChanged }) {
  const [raw, setRaw] = useState(""), [preview, setPreview] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [checking, setChecking] = useState(false), [results, setResults] = useState(null);
  const key = useRef(requestKey());
  useEffect(() => { let current = true; const emails = emailsOf(raw); setPreview(null); if (!emails.length) { setError(""); setChecking(false); return undefined; } setChecking(true); const timer = setTimeout(() => { void api(`${team.id}/invite-preview`, { accountId: team.accountId, emails }).then((value) => { if (current) { setPreview(value); setError(""); } }).catch((failure) => { if (current && !isAbort(failure)) setError(failure.message); }).finally(() => { if (current) setChecking(false); }); }, 300); return () => { current = false; clearTimeout(timer); }; }, [raw, api, team.id, team.accountId, team.checkedAt]);
  const send = async (event) => { event.preventDefault(); if (busy || !preview?.canInvite || results) return; setBusy(true); setError(""); try { const result = await api(`${team.id}/invite`, { accountId: team.accountId, emails: emailsOf(raw), requestKey: key.current }); setResults(result.results); await onChanged(Object.keys(result.refreshErrors || {}).length ? "邀请请求已返回，部分数据需重新同步" : "已更新邀请结果，成员接受后才会加入团队"); } catch (failure) { if (!isAbort(failure)) setError(failure.message); } finally { setBusy(false); } };
  const failed = (results || []).filter((row) => row.status === "failed");
  return <TeamDialog title="邀请成员" description={`加入 ${team.name} · ${team.email}`} onClose={onClose} busy={busy}><form onSubmit={send}><div className="team-dialog-body"><label className="team-field">成员邮箱<textarea aria-label="邀请成员邮箱" value={raw} onChange={(event) => { setRaw(event.target.value); setResults(null); key.current = requestKey(); }} placeholder={"colleague@example.com\n支持多行或逗号分隔，最多 50 个邮箱"} disabled={busy} spellCheck={false} autoFocus /><small>自动去重；已是成员与已有邀请会跳过。</small></label><div className="team-form-grid"><label className="team-field">邀请角色<input value="成员" readOnly /></label><label className="team-field">席位类型<input value="标准" readOnly /><small>高级邀请暂未开放</small></label></div><div className={`team-capacity ${preview && !preview.capacityOk ? "warning" : ""}`}><CircleAlert size={16} /><div>{checking ? "正在核对成员、待接受邀请与席位…" : preview ? <>当前可用 <strong>{preview.available ?? "未知"}</strong> 席 · 已有待接受 <strong>{preview.pendingSeats}</strong> 人 · 本次新增 <strong>{preview.added}</strong> 人<p>{preview.reason || "仅发送成员邀请，首版不自动购买席位。"}</p></> : "输入邮箱后核对邀请人数和当前席位。"}</div></div>{error && <p className="dialog-error" role="alert">{error}</p>}{results && <div className="team-invite-results" aria-live="polite">{results.map((row) => <div key={row.email}><span>{row.email}</span><strong className={["failed", "unknown"].includes(row.status) ? "team-amber" : "team-success"}>{row.message}</strong></div>)}{failed.length > 0 && <button type="button" className="secondary-button" onClick={() => { setRaw(failed.map((row) => row.email).join("\n")); setResults(null); key.current = requestKey(); }}>仅重试失败的 {failed.length} 个邮箱</button>}</div>}</div><footer className="team-dialog-footer"><small>已识别 {emailsOf(raw).length} 个邮箱</small><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{results ? "完成" : "取消"}</button><button type="submit" className="primary-button" disabled={busy || checking || !preview?.canInvite || Boolean(results)}>{busy ? <LoaderCircle className="spin" size={15} /> : <Mail size={15} />}{busy ? "正在发送" : "发送邀请"}</button></footer></form></TeamDialog>;
}
function TeamRoleChange({ api, team, member, role, onClose, onChanged }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const key = useRef(requestKey());
  const label = role === "account-owner" ? "所有者" : "普通成员";
  const change = async () => {
    if (busy) return; setBusy(true); setError("");
    try {
      const result = await api(`${team.id}/role`, { accountId: team.accountId, memberId: member.id, memberEmail: member.email, previousRole: member.role, role, requestKey: key.current });
      await onChanged(result.verifying ? "角色修改已返回，请同步确认结果" : `已将 ${member.email} 设为${label}${result.selfChanged ? "；后续移除请切换另一位所有者账号管理" : ""}`);
      onClose();
    } catch (failure) { if (!isAbort(failure)) setError(failure.message); }
    finally { setBusy(false); }
  };
  return <TeamDialog title="修改成员角色" description={`${team.name} · 管理账号 ${team.email}`} onClose={onClose} busy={busy}><div className="team-dialog-body"><p>将以下账号从{member.roleLabel}修改为{label}？</p><div className="team-remove-target"><ShieldCheck size={22} /><div><strong>{member.name || "团队成员"}</strong><span>{member.email}</span></div></div><p className="team-muted">{role === "account-owner" ? "对方需已接受邀请并成为现有成员。修改后拥有团队所有者管理权限。" : "系统会重新检查仍有其他所有者。若修改的是当前管理账号，之后请切换另一位所有者继续管理或移除该账号。"}</p>{error && <p className="dialog-error" role="alert">{error}</p>}</div><footer className="team-dialog-footer"><button type="button" className="secondary-button" disabled={busy} onClick={onClose} autoFocus>取消</button><button type="button" className="primary-button" disabled={busy} onClick={() => void change()}>{busy && <LoaderCircle className="spin" size={15} />}确认修改为{label}</button></footer></TeamDialog>;
}

function TeamRemove({ api, team, member, onClose, onChanged }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(""); const key = useRef(requestKey());
  const remove = async () => { if (busy) return; setBusy(true); try { const result = await api(`${team.id}/remove`, { accountId: team.accountId, memberId: member.id, memberEmail: member.email, requestKey: key.current }); await onChanged(result.verifying || Object.keys(result.refreshErrors || {}).length ? "移除请求已返回，成员与席位仍需同步核对" : `已从 ${team.name} 移除 ${member.email}`); onClose(); } catch (failure) { if (!isAbort(failure)) setError(failure.message); } finally { setBusy(false); } };
  return <TeamDialog title="移除团队成员" description={team.name} onClose={onClose} busy={busy} className="team-remove-dialog"><div className="team-dialog-body"><p>确认移除以下成员？完成后，对方将失去此团队的访问权限。</p><div className="team-remove-target"><Users size={22} /><div><strong>{member.name || "团队成员"}</strong><span>{member.email}</span></div></div><p className="team-muted">购买席位数量保持不变，操作后重新同步成员与可用席位。</p>{error && <p className="dialog-error" role="alert">{error}</p>}</div><footer className="team-dialog-footer"><button type="button" className="secondary-button" onClick={onClose} disabled={busy} autoFocus>取消</button><button type="button" className="team-delete-button" disabled={busy} onClick={() => void remove()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}确认移除</button></footer></TeamDialog>;
}

function TeamImport({ api, account, onClose, onChanged }) {
  const [tab, setTab] = useState(account ? "paste" : "sources"), [sources, setSources] = useState([]), [selected, setSelected] = useState(new Set());
  const [raw, setRaw] = useState(account ? JSON.stringify({ email: account.email, credentials: { password: "", totpSecret: "", mailApiUrl: "" } }, null, 2) : "");
  const [updateExisting, setUpdateExisting] = useState(Boolean(account)), [mode, setMode] = useState("keep"), [proxy, setProxy] = useState(readWorkspaceProxyPoolText);
  const networkTouched = useRef(false);
  const [preview, setPreview] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true); const request = useRef(null), key = useRef(requestKey());
  useEffect(() => { let current = true; void api("sources").then((value) => { if (current) setSources(value.accounts); }).catch((failure) => { if (current && !isAbort(failure)) setError(failure.message); }).finally(() => { if (current) setLoading(false); }); return () => { current = false; }; }, [api]);
  const invalidate = () => { setPreview(null); request.current = null; key.current = requestKey(); };
  const submit = async (event) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try {
      if (!preview) {
        const body = { ...(tab === "sources" ? { sourceIds: [...selected] } : { text: raw }), updateExisting, forceLogin: Boolean(account), ...await prepareProxyNetworkOptions(mode, proxy) };
        const value = await api("import/preview", body); request.current = { ...body, digest: value.digest }; setPreview(value);
      } else { await api("import", { ...request.current, requestKey: key.current }); await onChanged(account ? "已更新账号资料并排队登录" : "账号已导入，正在排队登录与识别团队"); onClose(); }
    } catch (failure) { if (!isAbort(failure)) setError(failure.message); }
    finally { setBusy(false); }
  };
  return <TeamDialog title={account ? "更新团队账号登录" : "导入团队管理账号"} description={account ? account.email : "复用账号授权的格式与登录能力，识别可访问的团队空间。"} onClose={onClose} busy={busy} className="team-import-dialog"><form onSubmit={submit}><div className="team-dialog-body">{!account && <div className="team-import-tabs">{[["sources", "从账号授权选择"], ["paste", "粘贴账号资料"]].map(([key, label]) => <button type="button" key={key} aria-pressed={tab === key} disabled={busy} onClick={() => { setTab(key); if (!networkTouched.current) setMode(key === "sources" ? "keep" : "workspace"); invalidate(); }}>{label}</button>)}</div>}
      {tab === "sources" ? <div className="team-source-list">{loading ? <p>正在读取当前 CDK 的授权账号…</p> : sources.length ? sources.map((row) => <label key={row.id}><input type="checkbox" disabled={busy || row.busy} checked={selected.has(row.id)} onChange={(event) => { const next = new Set(selected); if (event.target.checked) next.add(row.id); else next.delete(row.id); setSelected(next); invalidate(); }} /><span>{row.email}<small>{row.busy ? "正在执行其他任务" : row.linked ? "已关联，选中后复用并重新识别" : row.hasPassword ? "已有密码资料，优先复用有效会话" : "优先复用会话，必要时完成登录验证"}</small></span></label>) : <p className="team-muted">当前工作区暂无授权账号，可切换为粘贴导入。</p>}</div>
        : <label className="team-field">账号资料<textarea aria-label="团队账号资料" value={raw} disabled={busy} onChange={(event) => { setRaw(event.target.value); invalidate(); }} spellCheck={false} placeholder={"邮箱----密码----MFA 密钥（可选）\n取件 URL / POST 取件格式与账号授权相同，也支持账号 JSON"} /><small>{account ? "填写需要更新的资料；留空字段保留原资料。确认后会重新登录。" : "仅用于团队登录与管理，不启动 Codex 授权或手机号绑定。"}</small></label>}
      <label className="team-update-existing"><input type="checkbox" checked={updateExisting} disabled={busy || Boolean(account)} onChange={(event) => { setUpdateExisting(event.target.checked); invalidate(); }} />明确更新已有账号资料（否则复用已有资料）</label>
      <ProxyNetworkOptions mode={mode} onModeChange={(value) => { networkTouched.current = true; setMode(value); invalidate(); }} value={proxy} onChange={(value) => { setProxy(value); invalidate(); }} allowKeep disabled={busy} ariaLabel="团队账号网络方式" />
      {preview && <div className="team-import-preview"><strong>预览完成：{preview.added} 个新账号，{preview.count - preview.added} 个已有账号</strong><p>同一 CDK 首次入库的账号每个扣 1 次；已有账号更新或关联不重复扣。需要验证码时可逐个处理。</p><p className="team-billing-preview">当前可用 {preview.billing ? preview.billing.balance ?? "不限" : "以费用确认为准"} · 本次扣 {preview.billing?.charge ?? "待确认"} 次 · 导入后 {preview.billing ? preview.billing.after ?? "不限" : "待确认"}</p>{preview.billing?.canImport === false && <p role="alert">可用次数不足，请先充值或减少新账号。</p>}<ul>{preview.accounts.map((row) => <li key={row.email}><span>{row.email}</span><small>{row.action}</small></li>)}</ul></div>}{error && <p className="dialog-error" role="alert">{error}</p>}
    </div><footer className="team-dialog-footer"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy || preview?.billing?.canImport === false || (tab === "sources" ? !selected.size : !raw.trim())}>{busy && <LoaderCircle className="spin" size={15} />}{preview ? account ? "更新并重新登录" : "确认导入并识别" : "预览导入"}</button></footer></form></TeamDialog>;
}
function TeamPrompt({ api, account, onClose, onChanged }) {
  const [value, setValue] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const submit = async (event, resend = false) => { event?.preventDefault(); if (busy) return; setBusy(true); try { await api(`accounts/${account.id}/input`, { promptId: account.prompt.id, value: resend ? "r" : value }); await onChanged(resend ? "已请求重发验证码" : "已提交登录验证，正在继续识别团队"); onClose(); } catch (failure) { if (!isAbort(failure)) setError(failure.message); } finally { setBusy(false); } };
  const label = account.prompt?.kind === "password" ? "登录密码" : account.prompt?.kind === "totp" ? "MFA 验证码" : "邮箱验证码";
  return <TeamDialog title={`输入${label}`} description={account.email} onClose={onClose} busy={busy}><form onSubmit={submit}><div className="team-dialog-body"><label className="team-field">{label}<input type={account.prompt?.kind === "password" ? "password" : "text"} inputMode={account.prompt?.kind === "password" ? "text" : "numeric"} value={value} onChange={(event) => setValue(event.target.value)} autoComplete={account.prompt?.kind === "password" ? "current-password" : "one-time-code"} autoFocus required /></label>{error && <p className="dialog-error" role="alert">{error}</p>}</div><footer className="team-dialog-footer">{account.prompt?.kind === "email" && <button type="button" className="text-action" disabled={busy} onClick={(event) => void submit(event, true)}>重发邮箱验证码</button>}<button type="button" className="secondary-button" disabled={busy} onClick={onClose}>稍后处理</button><button type="submit" className="primary-button" disabled={busy || !value}>{busy ? "正在提交" : "提交并继续"}</button></footer></form></TeamDialog>;
}
