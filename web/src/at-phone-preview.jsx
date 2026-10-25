import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowDownToLine, Check, ChevronLeft, ChevronRight, CircleAlert, Clock3, Copy, FileKey2, KeyRound, LockKeyhole, LogIn, MailCheck, PhoneIncoming, Plus, RotateCcw, Search, Settings2, ShieldCheck, Sparkles, X } from "lucide-react";
import { Drawer, ThemeControl, useCalendarDay } from "./WorkspaceUi.jsx";
import { dateBounds, dayKey, matchesDate } from "./task-filters.mjs";
import "./styles.css";
import "./workspace.css";
import "./at-phone-preview.css";

// Isolated UI fixtures. This entry never calls account, token, CDK or SMS APIs.
const FEE = 10;
const BALANCE = 180;
const PAGE_SIZE = 8;
const statuses = { all: "全部", running: "进行中", success: "成功", failed: "失败", unknown: "待核实", skipped: "无需接码", canceled: "已取消" };
const initialFilters = { search: "", status: "all", dateField: "createdAt", preset: "today", startDate: "", endDate: "" };
const atTime = (days, hour, minute) => { const value = new Date(); value.setDate(value.getDate() + days); value.setHours(hour, minute, 0, 0); return value.toISOString(); };
const time = (value) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const rows = [
  ["nora", "success", "手机验证码已通过", 14, 36, "*******8842"],
  ["jules", "success", "手机验证码已通过", 14, 31, "*******7059"],
  ["mila", "running", "等待短信，剩余 02:48", 14, 28, "*******4417"],
  ["leon", "running", "排队中，等待接码池名额", 14, 27],
  ["emil", "failed", "AT 已过期，请更新后重试", 14, 24],
  ["iris", "failed", "暂时没有可用号码", 14, 22],
  ["sara", "unknown", "验证响应中断，扣次待核实", 14, 19, "*******1832"],
  ["owen", "skipped", "账号已有手机号，本次未接码", 14, 16],
  ["lea", "success", "手机验证码已通过", 14, 11, "*******2906"],
  [null, "failed", "AT 无法识别账号身份", 14, 8],
  ["finn", "running", "正在校验 AT 与账号身份", 14, 5],
  ["hugo", "canceled", "已在取号前取消", 13, 59],
].map(([name, status, message, hour, minute, phone], index) => ({ id: `at-demo-${index}`, email: name ? `${name}@example.invalid` : null, reference: `导入行 #${String(index + 1).padStart(2, "0")}`, status, message, phone, identityVerified: ![4, 9, 10].includes(index), createdAt: atTime(0, hour, minute), verifiedAt: status === "success" ? atTime(0, hour, minute + 2) : null, charged: status === "success" ? FEE : 0, reserved: ["at-demo-2", "at-demo-6"].includes(`at-demo-${index}`) ? FEE : 0 }));
const history = ["ren", "alex", "kai", "ivy"].map((name, index) => ({ id: `at-history-${index}`, email: `${name}@example.invalid`, reference: `昨日导入 #${index + 1}`, status: index === 3 ? "failed" : "success", identityVerified: true, message: index === 3 ? "短信等待超时" : "手机验证码已通过", phone: index === 3 ? null : "*******3208", createdAt: atTime(-1, 21, index * 7), verifiedAt: index === 0 ? atTime(0, 9, 15) : index === 3 ? null : atTime(-1, 21, index * 7 + 2), charged: index === 3 ? 0 : FEE, reserved: 0 }));
const initialRows = [...rows, ...history];
const successEmails = (items) => [...new Set(items.filter((row) => row.status === "success" && row.verifiedAt && row.email).map((row) => row.email.toLowerCase()))];

function State({ row }) {
  return <span className={`at-status at-status-${row.status}`}>{row.status === "success" ? <Check size={13} /> : row.status === "failed" || row.status === "unknown" ? <CircleAlert size={13} /> : row.status === "running" ? <Clock3 size={13} /> : <i />}{statuses[row.status]}</span>;
}

function PoolRule({ compact = false }) {
  return <div className={`at-pool-rule${compact ? " at-pool-rule-compact" : ""}`}><div className="at-pool-label"><LockKeyhole size={16} /><strong>固定使用接码池</strong><span>自动分配号码</span></div>{!compact && <span className="at-pool-ready"><i />有号码</span>}<p>每个账号验证成功 <strong>{FEE}<small> 次</small></strong></p></div>;
}

function ImportDrawer({ onClose, onImport, balance }) {
  const [text, setText] = useState("");
  const lines = text.split(/\r?\n/).map((line) => line.trim().replace(/^Bearer\s+/i, "")).filter(Boolean);
  const valid = lines.filter((line) => !/\s/.test(line));
  const count = new Set(valid).size;
  const duplicates = valid.length - count;
  const malformed = lines.length - valid.length;
  return <Drawer title="粘贴 AT 并开始接码" onClose={onClose}>
    <form className="at-import-form" onSubmit={(event) => { event.preventDefault(); if (count && !malformed) { onImport(count); setText(""); } }}>
      <p className="at-drawer-description">每行一个 Access Token，执行前自动识别邮箱并校验。只完成手机验证。</p>
      <label className="at-token-label" htmlFor="at-token-input">Access Token <span>每行一个</span></label>
      <textarea id="at-token-input" value={text} onChange={(event) => setText(event.target.value)} placeholder={"粘贴 access_token 值\n每行一个，不需要邮箱或密码"} autoComplete="off" spellCheck={false} />
      <div className="at-import-counts" aria-live="polite"><span>待导入 <strong>{count}</strong> 条</span><span>同批重复 {duplicates} 条</span><button type="button" className="text-action" onClick={() => setText("demo-at-first\ndemo-at-second\ndemo-at-first")}>填入演示 AT</button></div>
      {malformed > 0 && <p className="at-import-error" role="alert">{malformed} 行包含空格或其他内容，请只保留完整 AT。</p>}
      <p className="at-inline-help">这里只预览数量与重复项。AT 是否可用、邮箱属于哪个账号，将在取号前确认。</p>
      <PoolRule compact />
      <dl className="at-import-billing"><div><dt>AT 导入</dt><dd>不扣次数</dd></div><div><dt>本批最多成功扣次<small>{count} 个账号 × {FEE} 次</small></dt><dd><strong>{count * FEE}</strong> 次</dd></div><div><dt>当前可用</dt><dd>{balance} 次</dd></div></dl>
      {count * FEE > balance && <p className="at-inline-help">当前余额最多支持 {Math.floor(balance / FEE)} 个账号接码，余额不足的任务将停止取号。</p>}
      <p className="at-inline-help">逐个取号前预留 {FEE} 次，手机验证码通过后扣除；明确失败释放预留。结果不明时等待核实。</p>
      <div className="at-drawer-footer"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={!count || Boolean(malformed)}><PhoneIncoming size={15} />确认并开始接码{count ? `（${count}）` : ""}</button></div>
    </form>
  </Drawer>;
}

function ExportDrawer({ filtered, all, filterLabel, onClose, onNotice }) {
  const [scope, setScope] = useState("filtered");
  const [copied, setCopied] = useState(false);
  const current = successEmails(filtered); const everything = successEmails(all);
  const emails = scope === "filtered" ? current : everything;
  const content = emails.join("\n");
  function download() {
    const url = URL.createObjectURL(new Blob([content + "\n"], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `at-phone-success-${dayKey()}-${emails.length}.txt`; anchor.click(); URL.revokeObjectURL(url);
    onNotice(`已导出 ${emails.length} 个演示成功邮箱。`);
  }
  return <Drawer title="导出成功邮箱" onClose={onClose}>
    <p className="at-drawer-description">只导出本次手机验证码通过的邮箱，自动去重。待核实与无需接码的记录不包含在内。</p>
    <fieldset className="at-export-scope"><legend>导出范围</legend><label><input type="radio" name="export-scope" checked={scope === "filtered"} onChange={() => { setScope("filtered"); setCopied(false); }} /><span>当前筛选结果<small>{filterLabel}，包含全部分页</small></span><strong>{current.length}</strong></label><label><input type="radio" name="export-scope" checked={scope === "all"} onChange={() => { setScope("all"); setCopied(false); }} /><span>全部成功记录<small>忽略当前日期、搜索与状态筛选</small></span><strong>{everything.length}</strong></label></fieldset>
    <div className="at-export-heading"><h3>邮箱预览</h3><span>{emails.length} 个邮箱</span></div>
    <pre className="at-export-preview">{content || "当前范围没有成功邮箱，可更换导出范围。"}</pre>
    <p className="at-inline-help">TXT 文本，每行一个邮箱。文件不包含 AT 或手机号。</p>
    <div className="at-drawer-footer"><button type="button" className="secondary-button" disabled={!emails.length} onClick={async () => { try { await navigator.clipboard.writeText(content); setCopied(true); } catch { onNotice("当前浏览器无法复制，请下载 TXT。"); } }}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "已复制" : "复制邮箱"}</button><button type="button" className="primary-button" disabled={!emails.length} onClick={download}><ArrowDownToLine size={15} />下载 TXT（{emails.length}）</button></div>
  </Drawer>;
}

function DetailDrawer({ row, onClose, onRetry, onCancel }) {
  const [updating, setUpdating] = useState(false); const [replacement, setReplacement] = useState("");
  return <Drawer title={updating ? "更新 AT 后重试" : "接码任务详情"} onClose={onClose}>
    <div className="at-detail-identity"><FileKey2 size={21} /><div><strong>{row.email || "邮箱尚未识别"}</strong><small>{row.reference}</small></div><State row={row} /></div>
    <p className="at-detail-message">{row.message}</p>
    <dl className="at-detail-meta"><div><dt>导入时间</dt><dd>{time(row.createdAt)}</dd></div><div><dt>接码成功时间</dt><dd>{time(row.verifiedAt)}</dd></div><div><dt>接码方式</dt><dd>接码池（固定）</dd></div>{row.phone && <div><dt>分配号码</dt><dd>{row.phone}</dd></div>}<div><dt>已扣次数</dt><dd>{row.charged} 次</dd></div><div><dt>处理中预留</dt><dd>{row.reserved} 次</dd></div></dl>
    {row.status === "success" && <p className="at-result-note at-result-success"><Check size={16} />本次手机验证通过，已扣 {row.charged} 次，可导出邮箱。</p>}
    {row.status === "unknown" && <p className="at-result-note"><CircleAlert size={16} />本次结果尚未确认，保留 {row.reserved} 次预留，等待管理员核实。</p>}
    {row.status === "skipped" && <p className="at-result-note"><ShieldCheck size={16} />账号已有手机号，未购买新号码、不扣次数，也不计入本次接码成功。</p>}
    <h3 className="at-detail-subtitle">执行进度</h3><ol className="at-detail-stages">{[["校验 AT 与识别账号", row.identityVerified === true], ["从接码池分配号码", Boolean(row.phone)], ["目标服务确认手机验证码", row.status === "success"]].map(([title, done], index) => <li key={title} className={done ? "done" : ""}>{done ? <Check size={13} /> : <span>{index + 1}</span>}<div>{title}<small>{done ? "已完成" : row.status === "unknown" && index === 2 ? "等待核实" : "尚未完成"}</small></div></li>)}</ol>
    {row.status === "failed" && (updating ? <form className="at-replace-form" onSubmit={(event) => { event.preventDefault(); onRetry(row.id); setReplacement(""); }}><label htmlFor="at-replacement">新的 AT</label><textarea id="at-replacement" value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="粘贴新的完整 AT" spellCheck={false} autoComplete="off" /><p className="at-inline-help">重新校验身份，验证成功后才扣 {FEE} 次。</p><button className="primary-button" disabled={!replacement.trim() || /\n/.test(replacement.trim())}>确认更新并重试</button></form> : <button className="secondary-button" onClick={() => setUpdating(true)}><RotateCcw size={15} />更新 AT 后重试</button>)}
    {row.status === "running" && <button className="secondary-button" onClick={() => onCancel(row.id)}><X size={15} />停止此任务</button>}
  </Drawer>;
}

export default function AtPhonePreview() {
  const day = useCalendarDay(); const [records, setRecords] = useState(initialRows); const [filters, setFilters] = useState(initialFilters); const [page, setPage] = useState(1); const [drawer, setDrawer] = useState(null); const [notice, setNotice] = useState("");
  const updateFilters = (patch) => { setFilters((value) => ({ ...value, ...patch })); setPage(1); };
  const bounds = dateBounds(filters);
  const dated = useMemo(() => records.filter((row) => matchesDate(row, filters) && `${row.email || ""} ${row.reference}`.toLowerCase().includes(filters.search.trim().toLowerCase())), [records, filters, day]);
  const filtered = dated.filter((row) => filters.status === "all" || row.status === filters.status);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const visible = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const todayCreated = records.filter((row) => matchesDate(row, { preset: "today", dateField: "createdAt" })).length;
  const todaySuccess = records.filter((row) => row.status === "success" && matchesDate(row, { preset: "today", dateField: "verifiedAt" }));
  const reserved = records.reduce((sum, row) => sum + row.reserved, 0); const balance = BALANCE + 20 - reserved;
  const selected = records.find((row) => row.id === drawer?.id);
  const dateLabels = { all: "全部日期", today: "今天", yesterday: "昨天", week: "近 7 天", custom: `${filters.startDate} 至 ${filters.endDate}` };
  const filterLabel = `${dateLabels[filters.preset]} / ${filters.dateField === "createdAt" ? "导入时间" : "接码成功时间"} / ${statuses[filters.status]}${filters.search ? ` / 搜索 ${filters.search}` : ""}`;
  function importDemo(count) {
    const added = Array.from({ length: count }, (_, index) => ({ id: `at-added-${Date.now()}-${index}`, email: null, reference: `新导入行 #${index + 1}`, status: "running", identityVerified: false, message: "排队中，等待校验 AT", createdAt: new Date().toISOString(), verifiedAt: null, charged: 0, reserved: 0 }));
    setRecords((previous) => [...added, ...previous]); setDrawer(null); setFilters(initialFilters); setPage(1); setNotice(`演示：已创建 ${count} 条接码任务。AT 导入不扣次，执行前先核验身份。`);
  }
  function retryDemo(id) { setRecords((previous) => previous.map((row) => row.id === id ? { ...row, status: "running", identityVerified: false, message: "排队中，将重新核验 AT", reserved: 0 } : row)); setDrawer(null); setNotice("演示：任务已重新排队，尚未预留或扣次。"); }
  function cancelDemo(id) { setRecords((previous) => previous.map((row) => row.id === id ? { ...row, status: "canceled", message: "已停止，未验证成功的预留已释放", reserved: 0 } : row)); setDrawer(null); setNotice("演示：已停止此任务，未扣接码次数。"); }
  return <>
    <div className="at-design-banner"><span>页面设计预览 · 全部为演示记录，不连接 AT 或接码服务。</span><button onClick={() => { setRecords(initialRows); setFilters(initialFilters); setPage(1); setDrawer(null); setNotice(""); }}>重置演示</button></div>
    <div className="app-shell at-preview-shell"><aside className="app-sidebar"><div className="brand-block"><div className="brand-mark"><ShieldCheck size={19} /></div><h1>账号工作台</h1></div><nav className="workspace-tabs" aria-label="工作区预览">{[[LogIn, "账号授权"], [PhoneIncoming, "AT 模式接码"], [ShieldCheck, "MFA 修改"], [MailCheck, "邮箱换绑"], [Sparkles, "优惠检测"], [KeyRound, "我的 CDK"]].map(([Icon, label]) => <button key={label} className={label === "AT 模式接码" ? "active" : ""} aria-current={label === "AT 模式接码" ? "page" : undefined} onClick={() => label !== "AT 模式接码" && setNotice("本设计页展示 AT 模式接码，其他菜单沿用现有工作台。")}><Icon size={17} />{label}</button>)}<button className="sidebar-settings" onClick={() => setNotice("AT 模式固定使用接码池，无需单独配置服务商。")}><Settings2 size={17} />配置</button></nav><div className="sidebar-footer">当前工作区<p>普通 CDK · 设计预览</p></div></aside>
      <main className="workspace-content"><header className="topbar"><div className="workspace-path"><span>工作区</span><ChevronRight size={14} /><strong>AT 模式接码</strong></div><div className="topbar-actions"><span className="at-balance">可用 <strong>{balance}</strong> 次<span>预留 {reserved} 次</span></span><ThemeControl /></div></header>
        <section className="workspace at-workspace" aria-labelledby="at-page-title"><div className="at-page-heading"><div><h2 id="at-page-title">AT 模式接码</h2><p>粘贴 AT，完成账号手机验证，导出成功邮箱。</p></div><div className="at-heading-actions"><button className="secondary-button" onClick={() => setDrawer({ type: "export" })}><ArrowDownToLine size={15} />导出成功邮箱</button><button className="primary-button" onClick={() => setDrawer({ type: "import" })}><Plus size={16} />粘贴 AT</button></div></div>
          <PoolRule />
          <div className="at-overview"><div className="at-overview-totals"><button onClick={() => updateFilters({ preset: "today", dateField: "createdAt", status: "all" })}><span>今日导入</span><strong>{todayCreated}</strong></button><button onClick={() => updateFilters({ preset: "all", dateField: "createdAt", status: "all" })}><span>全部记录</span><strong>{records.length}</strong></button></div><div className="at-overview-results"><div><span>今日验证通过</span><strong>{todaySuccess.length}</strong></div><div><span>今日扣次</span><strong>{todaySuccess.reduce((sum, row) => sum + row.charged, 0)}<small> 次</small></strong></div><p>按验证码通过时间统计</p></div></div>
          {notice && <div className="at-notice" role="status"><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice("")}><X size={14} /></button></div>}
          <section className="task-filters at-task-filters" aria-label="AT 接码任务筛选"><div className="filter-fields"><label className="search-field"><Search size={16} /><input type="search" aria-label="搜索邮箱或导入行" placeholder="搜索邮箱或导入行" value={filters.search} onChange={(event) => updateFilters({ search: event.target.value })} /></label><label className="at-date-field">日期依据<select aria-label="日期依据" value={filters.dateField} onChange={(event) => updateFilters({ dateField: event.target.value })}><option value="createdAt">导入时间</option><option value="verifiedAt">接码成功时间</option></select></label></div><div className="date-presets">{[["all", "全部日期"], ["today", "今天"], ["yesterday", "昨天"], ["week", "近 7 天"], ["custom", "自定义"]].map(([key, label]) => <button key={key} aria-pressed={filters.preset === key} onClick={() => updateFilters({ preset: key, ...(key === "custom" ? { startDate: filters.startDate || day, endDate: filters.endDate || day } : {}) })}>{label}</button>)}<span className="filter-timezone">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div>{filters.preset === "custom" && <div className="custom-date-range"><label>开始日期<input type="date" aria-label="开始日期" value={filters.startDate} onChange={(event) => updateFilters({ startDate: event.target.value })} /></label><span>至</span><label>结束日期<input type="date" aria-label="结束日期" value={filters.endDate} onChange={(event) => updateFilters({ endDate: event.target.value })} /></label></div>}{bounds.error && <p className="at-import-error" role="alert">{bounds.error}</p>}</section>
          <div className="at-status-tabs" aria-label="接码状态筛选">{Object.entries(statuses).map(([key, label]) => <button key={key} aria-pressed={filters.status === key} onClick={() => updateFilters({ status: key })}>{label}<span>{key === "all" ? dated.length : dated.filter((row) => row.status === key).length}</span></button>)}</div>
          <div className="at-list-caption"><span>{dateLabels[filters.preset]}{filters.dateField === "createdAt" ? "导入" : "验证通过"}的任务，共 {filtered.length} 条</span><span>成功后扣次，失败不扣次</span></div>
          <div className="table-frame at-table-frame"><table className="at-table"><thead><tr><th>账号</th><th>执行结果</th><th>扣次状态</th><th>导入 / 成功时间</th><th>操作</th></tr></thead><tbody>{visible.map((row) => <tr key={row.id}><td data-label="账号"><strong className={!row.email ? "at-email-pending" : ""}>{row.email || "待识别邮箱"}</strong><small>{row.reference}</small></td><td data-label="执行结果"><State row={row} /><small>{row.message}</small></td><td data-label="扣次状态"><strong>{row.charged ? `${row.charged} 次` : row.reserved ? `预留 ${row.reserved} 次` : "0 次"}</strong><small>{row.charged ? "验证成功已扣除" : row.reserved ? "尚未扣除" : row.status === "failed" || row.status === "canceled" || row.status === "skipped" ? "本次未扣次" : "尚未预留"}</small></td><td data-label="导入 / 成功时间"><span>{time(row.createdAt)}</span><small>{row.verifiedAt ? `通过 ${time(row.verifiedAt)}` : "尚未验证通过"}</small></td><td data-label="操作"><button className="text-action" aria-label={`查看 ${row.email || row.reference}`} onClick={() => setDrawer({ type: "detail", id: row.id })}>查看</button></td></tr>)}</tbody></table>{!visible.length && <div className="at-empty"><Search size={23} /><h3>没有符合筛选条件的任务</h3><p>更换日期或状态，或粘贴 AT 创建接码任务。</p><button className="text-action" onClick={() => { setFilters({ ...initialFilters, preset: "all" }); setPage(1); }}>清除筛选</button></div>}</div>
          <div className="at-pagination"><span>当前筛选 {filtered.length} 条，每页 {PAGE_SIZE} 条</span><div><button className="secondary-button" aria-label="上一页" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft size={14} /></button><span>{page} / {pageCount}</span><button className="secondary-button" aria-label="下一页" disabled={page >= pageCount} onClick={() => setPage(page + 1)}><ChevronRight size={14} /></button></div></div>
          <p className="at-page-footnote"><ShieldCheck size={14} />“成功”仅指本次手机验证码通过；账号原本已有手机号记为“无需接码”，不扣次数。</p>
        </section>
      </main></div>
    {drawer?.type === "import" && <ImportDrawer balance={balance} onClose={() => setDrawer(null)} onImport={importDemo} />}
    {drawer?.type === "export" && <ExportDrawer filtered={filtered} all={records} filterLabel={filterLabel} onClose={() => setDrawer(null)} onNotice={setNotice} />}
    {drawer?.type === "detail" && selected && <DetailDrawer key={selected.id} row={selected} onClose={() => setDrawer(null)} onRetry={retryDemo} onCancel={cancelDemo} />}
  </>;
}

createRoot(document.getElementById("root")).render(<AtPhonePreview />);
