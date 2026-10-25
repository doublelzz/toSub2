import React, { useEffect, useState } from "react";
import { AlertTriangle, ArrowLeftRight, Check, Copy, Download, KeyRound, LoaderCircle, Plus, Search, ShieldCheck } from "lucide-react";
import { Drawer } from "./WorkspaceUi.jsx";
import { cdkFetch, requestId } from "./cdk-api.mjs";

const kinds = { issue: "初始发放", topup: "管理员追加", import: "导入账号", "sms-pool": "接码池成功扣次", "merge-in": "融合转入", "merge-out": "融合转出" };
const statusNames = { active: "正常", disabled: "已禁用", merged: "已融合" };
const ruleNames = { ratePerMinute: "每 IP 每分钟验证上限", warnFailures: "达到告警的失败次数", banFailures: "达到封禁的失败次数", failureWindowMinutes: "失败统计窗口（分钟）", banMinutes: "首次封禁（分钟）", escalationCount: "升级封禁所需触发次数", escalationHours: "重复触发统计及升级时长（小时）", retentionDays: "日志保留（天）" };

async function request(token, url, method = "GET", body) {
  const response = await cdkFetch(url, { method, headers: { "content-type": "application/json", "x-console-token": token }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || "请求失败"); return data;
}

function Ledger({ items = [], showOwner = false }) {
  return <div className="table-frame cdk-table-frame"><table className="cdk-ledger"><thead><tr><th>事项</th>{showOwner && <th className="cdk-hide-mobile">CDK</th>}<th className="cdk-number">变化</th><th className="cdk-number">余额</th><th className="cdk-hide-mobile">时间</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td><strong>{kinds[item.kind] || item.kind}</strong><small>{item.note}</small></td>{showOwner && <td className="cdk-hide-mobile">{item.label}</td>}<td className={`cdk-number ${item.delta > 0 ? "cdk-success" : ""}`}>{item.delta > 0 ? "+" : ""}{item.delta}</td><td className="cdk-number">{item.balance}</td><td className="cdk-hide-mobile">{new Date(item.at).toLocaleString()}</td></tr>)}{!items.length && <tr><td colSpan={showOwner ? 5 : 4} className="cdk-empty">还没有次数流水</td></tr>}</tbody></table></div>;
}

function Equation({ before, delta, after, changeLabel = "本次变化" }) {
  return <div className="cdk-equation"><div><span>当前可用</span><strong>{before}</strong></div><div><span>{changeLabel}</span><strong>{delta > 0 ? "+" : ""}{delta}</strong></div><div><span>操作后可用</span><strong>{after}</strong></div></div>;
}

function ConsumptionDetails({ cdk }) {
  return <>{Number.isSafeInteger(cdk.importConsumed) && cdk.importConsumed >= 0 && <div><dt>账号导入消耗</dt><dd>{cdk.importConsumed} 次</dd></div>}{Number.isSafeInteger(cdk.smsPoolConsumed) && cdk.smsPoolConsumed >= 0 && <div><dt>接码池消耗</dt><dd>{cdk.smsPoolConsumed} 次</dd></div>}{cdk.role !== "admin" && Number.isSafeInteger(cdk.reserved) && cdk.reserved > 0 && <div><dt>处理中预留</dt><dd>{cdk.reserved} 次</dd></div>}</>;
}

export default function CdkWorkspace({ auth, section, onNavigate }) {
  const [items, setItems] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [cdk, setCdk] = useState(auth.workspace);
  const [events, setEvents] = useState([]);
  const [bans, setBans] = useState([]);
  const [pending, setPending] = useState([]);
  const [rules, setRules] = useState(null);
  const [tab, setTab] = useState("events");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState(null);
  const [source, setSource] = useState("");
  const [mergeQuote, setMergeQuote] = useState(null);
  const [amount, setAmount] = useState(100);

  async function reload() {
    if (section === "mine") {
      const result = await request(auth.token, "/api/cdk/ledger"); setCdk(result.cdk); setLedger(result.items);
    } else if (section === "management") {
      const [keys, logs, recoveries] = await Promise.all([request(auth.token, "/api/admin/cdks"), request(auth.token, "/api/admin/security/events"), request(auth.token, "/api/admin/imports")]);
      setItems(keys.items); setEvents(logs.items); setPending(recoveries.items);
    } else {
      const [logs, blocks, currentRules] = await Promise.all([request(auth.token, "/api/admin/security/events"), request(auth.token, "/api/admin/security/ip-bans"), request(auth.token, "/api/admin/security/rules")]);
      setEvents(logs.items); setBans(blocks.items); setRules(currentRules);
    }
  }

  useEffect(() => {
    let active = true;
    setLoaded(false);
    const refresh = async () => { try { await reload(); } catch (failure) { if (active) setError(failure.message); } finally { if (active) setLoaded(true); } };
    void refresh(); const timer = setInterval(refresh, 5000);
    return () => { active = false; clearInterval(timer); setDialog(null); };
  }, [section, auth.workspace.id, auth.token]);

  async function perform(operation, message = "操作完成") {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); setNotice(message); await reload(); await auth.reload(); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }

  async function detail(target) {
    setError("");
    try { const result = await request(auth.token, `/api/admin/cdks/${target.id}/ledger`); setDialog({ kind: "detail", target: result.cdk, items: result.items }); } catch (failure) { setError(failure.message); }
  }

  async function submit(event) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    if (dialog?.kind === "generate") await perform(async () => {
      const result = await request(auth.token, "/api/admin/cdks", "POST", { count: Number(values.get("count")), quota: Number(values.get("quota")), note: values.get("note") });
      setDialog({ kind: "generated", items: result.items });
    }, "CDK 已生成，请复制本次结果");
    if (dialog?.kind === "topup") await perform(async () => {
      await request(auth.token, `/api/admin/cdks/${dialog.target.id}/topups`, "POST", { amount: Number(values.get("amount")), note: values.get("note"), requestKey: dialog.requestKey }); setDialog(null);
    }, "次数已追加");
    if (dialog?.kind === "ban") await perform(async () => {
      await request(auth.token, "/api/admin/security/ip-bans", "POST", { ip: values.get("ip"), minutes: values.get("minutes") === "permanent" ? null : Number(values.get("minutes")), reason: values.get("reason") }); setDialog(null); setTab("bans");
    }, "已拉黑来源 IP");
    if (dialog?.kind === "rename") await perform(async () => { await request(auth.token, `/api/admin/cdks/${dialog.target.id}`, "PATCH", { note: values.get("note") }); setDialog(null); }, "备注已保存");
  }

  const topup = (target) => { setAmount(100); setDialog({ kind: "topup", target, requestKey: requestId() }); };
  const unread = events.filter((item) => item.unread).length;
  const matched = items.filter((item) => `${item.label} ${item.note}`.toLowerCase().includes(query.toLowerCase()) && (filter === "all" || filter === "unused" ? filter !== "unused" || !item.everConsumed && item.role === "user" && item.status === "active" : item.status === filter));
  const ordinary = items.filter((item) => item.role === "user");
  const close = () => { if (!busy) setDialog(null); };

  if (!loaded && !error) return <section className="workspace cdk-workspace"><p className="cdk-loading" role="status"><LoaderCircle className="spin" size={17} />正在加载当前工作区</p></section>;

  return <section className="workspace cdk-workspace">
    <header className="section-heading"><div><h2>{section === "management" ? "CDK 管理" : section === "mine" ? "我的 CDK" : "安全中心"}</h2><p>{section === "management" ? "分发次数，查看每张 CDK 的实际使用情况" : section === "mine" ? "查看可用次数与使用流水，融合从未消耗过的 CDK" : "处理异常验证，管理访问本系统的客户端 IP"}</p></div>{section === "management" ? <div className="cdk-actions"><button className="secondary-button" onClick={() => void perform(async () => { const result = await request(auth.token, "/api/admin/ledger"); setDialog({ kind: "ledger", items: result.items }); }, "流水已加载")}>使用流水</button><button className="primary-button" onClick={() => setDialog({ kind: "generate" })}><Plus size={16} />生成 CDK</button></div> : section === "security" ? <button className="primary-button" onClick={() => setDialog({ kind: "ban", ip: "" })}><Plus size={16} />拉黑 IP</button> : null}</header>
    {error && <div className="cdk-error" role="alert">{error}</div>}{notice && <p className="cdk-notice" role="status">{notice}</p>}
    {section === "management" && <>
      <div className="cdk-summary"><div><span>普通 CDK</span><strong>{ordinary.length}</strong></div><div><span>可用 CDK</span><strong>{ordinary.filter((item) => item.status === "active").length}</strong></div><div><span>累计消耗</span><strong>{ordinary.reduce((total, item) => total + item.consumed, 0)}</strong></div><div><span>可用次数合计</span><strong>{ordinary.filter((item) => item.status === "active").reduce((total, item) => total + item.balance, 0)}</strong></div></div>
      {unread > 0 && <div className="cdk-warning"><AlertTriangle size={17} /><span>有 {unread} 条异常访问待处理。</span><button type="button" onClick={() => onNavigate("security")}>查看安全日志</button></div>}
      {pending.length > 0 && <div className="cdk-warning"><AlertTriangle size={17} /><span>有 {pending.length} 个导入等待恢复，相关次数已预留。</span><button onClick={() => setDialog({ kind: "recovery", items: pending })}>查看并恢复</button></div>}
      <div className="cdk-filters"><label><Search size={16} /><input aria-label="搜索 CDK" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 CDK 标识或备注" /></label><select aria-label="CDK 状态" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部状态</option><option value="active">正常</option><option value="unused">从未消耗</option><option value="disabled">已禁用</option><option value="merged">已融合</option></select></div>
      <div className="table-frame cdk-table-frame"><div className="list-heading"><strong>全部 CDK {matched.length}</strong><span>完整 CDK 仅在生成或轮换时显示一次</span></div><table className="cdk-management-table"><thead><tr><th>CDK</th><th className="cdk-hide-mobile">备注</th><th className="cdk-number cdk-hide-mobile">已用</th><th className="cdk-number">可用</th><th className="cdk-hide-mobile">状态</th><th>操作</th></tr></thead><tbody>{matched.map((item) => <tr key={item.id}><td><strong className="cdk-code">{item.label}</strong><small>{item.role === "admin" ? "管理员" : item.note}{item.status !== "active" ? ` / ${statusNames[item.status]}` : ""}</small></td><td className="cdk-hide-mobile">{item.note}</td><td className="cdk-number cdk-hide-mobile">{item.role === "admin" ? "—" : item.consumed}</td><td className="cdk-number">{item.role === "admin" ? "不限" : item.balance}</td><td className="cdk-hide-mobile"><span className={`cdk-state ${item.status}`}>{statusNames[item.status]}</span></td><td><div className="cdk-row-actions"><button onClick={() => void detail(item)}>详情</button>{item.role === "user" && item.status !== "merged" && <button className="cdk-hide-mobile" onClick={() => topup(item)}>追加</button>}</div></td></tr>)}{!matched.length && <tr><td colSpan={6} className="cdk-empty">没有匹配的 CDK，请调整筛选。</td></tr>}</tbody></table></div>
    </>}
    {section === "mine" && <div className="cdk-profile-layout"><div><div className="cdk-account-summary"><div><span>可用次数</span><strong>{cdk.role === "admin" ? "不限" : cdk.balance}</strong><small className="cdk-code">{cdk.label}</small></div><dl><div><dt>累计消耗</dt><dd>{cdk.consumed} 次</dd></div><ConsumptionDetails cdk={cdk} /><div><dt>当前保存账号</dt><dd>{cdk.accounts} 个</dd></div><div><dt>当前状态</dt><dd>{statusNames[cdk.status]}</dd></div></dl></div><h3>次数流水</h3><Ledger items={ledger} /></div><section className="cdk-merge"><h3>融合另一张 CDK</h3>{cdk.role === "admin" || auth.workspace.id !== auth.account.id ? <p>管理员 CDK 不参与次数融合。请使用自己的普通 CDK 登录后融合。</p> : <><p>转入对方全部剩余次数。来源必须从未消耗过次数，融合完成后永久失效。</p><form onSubmit={(event) => { event.preventDefault(); setMergeQuote(null); void perform(async () => setMergeQuote(await request(auth.token, "/api/cdk/merge-preview", "POST", { sourceCdk: source.trim() })), "已核对融合资格"); }}><label className="cdk-field">另一张 CDK<input type="password" value={source} onChange={(event) => { setSource(event.target.value); setMergeQuote(null); setError(""); }} required autoComplete="off" /></label><button className="secondary-button" disabled={busy}>验证融合资格</button></form>{mergeQuote && <><p className="cdk-success">可以融合：{mergeQuote.sourceLabel}</p><Equation before={mergeQuote.before} delta={mergeQuote.amount} after={mergeQuote.after} changeLabel="将转入" /><button className="primary-button" onClick={() => setDialog({ kind: "merge", quote: mergeQuote, source: source.trim(), requestKey: requestId() })}>融合 {mergeQuote.amount} 次</button></>}<p className="cdk-helper">登录和保存配置不影响资格。曾扣次的 CDK，追加次数后仍不可融合。</p></>}</section></div>}
    {section === "security" && <>
      <div className="cdk-tabs" role="tablist" aria-label="安全中心页面">{[["events", `安全日志${unread ? ` (${unread})` : ""}`], ["bans", "IP 黑名单"], ["rules", "访问保护规则"]].map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={(event) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const buttons = [...event.currentTarget.parentElement.children]; const index = buttons.indexOf(event.currentTarget); const target = event.key === "Home" ? buttons[0] : event.key === "End" ? buttons[2] : buttons[(index + (event.key === "ArrowRight" ? 1 : 2)) % 3]; target.click(); target.focus(); }}>{label}</button>)}</div>
      {tab === "events" && <div className="table-frame cdk-table-frame"><table><thead><tr><th>客户端 IP</th><th>验证事件</th><th className="cdk-hide-mobile">次数 / 结果</th><th>操作</th></tr></thead><tbody>{events.map((item) => <tr key={item.id}><td><strong className="cdk-code">{item.ip}</strong><small>{item.unread ? "待处理" : "已记录"}</small></td><td>{item.entry === "merge" ? "融合来源" : "CDK 登录"}验证失败<small className="cdk-mobile-only">{item.count} 次 / {item.result}</small><small>{new Date(item.at).toLocaleString()}</small></td><td className="cdk-hide-mobile">{item.count} 次 / {item.result}</td><td><div className="cdk-row-actions"><button onClick={() => void perform(() => request(auth.token, "/api/admin/security/events", "PATCH", { id: item.id }), "已标记处理")}>处理</button>{!item.blocked && <button onClick={() => setDialog({ kind: "ban", ip: item.ip })}>拉黑</button>}</div></td></tr>)}{!events.length && <tr><td colSpan={4} className="cdk-empty">还没有验证失败记录。</td></tr>}</tbody></table></div>}
      {tab === "bans" && <div className="table-frame cdk-table-frame"><table><thead><tr><th>客户端 IP</th><th>原因</th><th className="cdk-hide-mobile">到期时间</th><th>操作</th></tr></thead><tbody>{bans.map((item) => <tr key={item.id}><td><strong className="cdk-code">{item.ip}</strong><small>{item.source === "auto" ? "自动封禁" : "手动封禁"}{!item.active ? " / 已失效" : ""}</small></td><td>{item.reason}</td><td className="cdk-hide-mobile">{item.expiresAt ? new Date(item.expiresAt).toLocaleString() : "永久"}</td><td>{item.active && <button className="cdk-link" onClick={() => setDialog({ kind: "unban", target: item })}>解除</button>}</td></tr>)}{!bans.length && <tr><td colSpan={4} className="cdk-empty">没有封禁记录。</td></tr>}</tbody></table></div>}
      {tab === "rules" && rules && <form className="cdk-rules-form" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); void perform(async () => { const updated = await request(auth.token, "/api/admin/security/rules", "PUT", Object.fromEntries(Object.keys(ruleNames).map((key) => [key, Number(form.get(key))]))); setRules(updated); }, "访问保护规则已保存"); }}><p className="cdk-helper">登录和融合来源验证共用保护。成功验证不清空 IP 失败记录；系统同时限制全站验证频率。</p><div className="cdk-form-grid">{Object.entries(ruleNames).map(([key, label]) => <label className="cdk-field" key={key}>{label}<input name={key} defaultValue={rules[key]} type="number" min="1" max={key === "ratePerMinute" ? 10000 : 3650} required /></label>)}</div><button className="primary-button" disabled={busy}>保存保护规则</button></form>}
    </>}
    {dialog && <Drawer title={({ generate: "生成 CDK", generated: "完整 CDK 只显示本次", detail: "CDK 详情", ledger: "使用流水", topup: "追加次数", rename: "编辑备注", toggle: "确认修改 CDK 状态", rotate: "确认轮换 CDK", ban: "拉黑客户端 IP", unban: "解除 IP 封禁", merge: "确认融合次数", recovery: "待恢复的导入" })[dialog.kind]} onClose={close} wide>
      {error && <p className="cdk-error" role="alert">{error}</p>}
      {dialog.kind === "generate" && <form onSubmit={submit}><p className="cdk-helper">关闭结果后无法再次读取完整 CDK，请及时复制或下载。</p><div className="cdk-form-grid"><label className="cdk-field">生成数量<input name="count" type="number" min="1" max="100" defaultValue="1" required /></label><label className="cdk-field">每张初始次数<input name="quota" type="number" min="1" max="1000000" defaultValue="100" required /></label></div><label className="cdk-field">备注<input name="note" maxLength="160" required /></label><button className="primary-button" disabled={busy}>{busy && <LoaderCircle className="spin" size={16} />}生成并显示 CDK</button></form>}
      {dialog.kind === "generated" && <><p className="cdk-warning">请保存本次结果。关闭后，列表只显示脱敏标识。</p><textarea className="cdk-secret-results" readOnly aria-label="本次生成的 CDK" value={dialog.items.map((item) => `${item.secret}\t${item.balance}次\t${item.note}`).join("\n")} /><div className="cdk-actions"><button className="primary-button" onClick={async () => { try { await navigator.clipboard.writeText(dialog.items.map((item) => item.secret).join("\n")); setNotice("已复制完整 CDK"); } catch { setError("复制失败，请在文本框中手动复制"); } }}><Copy size={16} />复制全部</button><button className="secondary-button" onClick={() => { const url = URL.createObjectURL(new Blob([dialog.items.map((item) => `${item.secret}\t${item.balance}\t${item.note}`).join("\r\n")], { type: "text/plain;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = "cdk-issued.txt"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}><Download size={16} />下载本次结果</button></div></>}
      {dialog.kind === "detail" && <><p className="cdk-code">{dialog.target.label}</p><dl className="cdk-detail"><div><dt>备注</dt><dd>{dialog.target.note}</dd></div><div><dt>状态</dt><dd>{statusNames[dialog.target.status]}</dd></div><div><dt>可用次数</dt><dd>{dialog.target.role === "admin" ? "不限" : dialog.target.balance}</dd></div><div><dt>累计消耗</dt><dd>{dialog.target.consumed}</dd></div><ConsumptionDetails cdk={dialog.target} /><div><dt>当前账号</dt><dd>{dialog.target.accounts}</dd></div></dl><div className="cdk-actions">{dialog.target.status === "active" && <button className="primary-button" onClick={() => void perform(() => auth.switchWorkspace(dialog.target.id), "已切换工作区")}><ArrowLeftRight size={16} />进入该 CDK 工作区</button>}{dialog.target.role === "user" && dialog.target.status !== "merged" && <><button className="secondary-button" onClick={() => topup(dialog.target)}>追加次数</button><button className="secondary-button" onClick={() => setDialog({ kind: "rename", target: dialog.target })}>编辑备注</button><button className="secondary-button" onClick={() => setDialog({ kind: "toggle", target: dialog.target })}>{dialog.target.status === "active" ? "禁用" : "启用"}</button><button className="secondary-button" onClick={() => setDialog({ kind: "rotate", target: dialog.target })}>轮换 CDK</button></>}</div><h3>次数流水</h3><Ledger items={dialog.items} /></>}
      {dialog.kind === "ledger" && <Ledger items={dialog.items} showOwner />}
      {dialog.kind === "topup" && <form onSubmit={submit}><p className="cdk-code">{dialog.target.label}</p><label className="cdk-field">追加次数<input name="amount" type="number" min="1" max="1000000" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label><label className="cdk-field">追加备注<input name="note" maxLength="160" required /></label><Equation before={dialog.target.balance} delta={Number(amount) || 0} after={dialog.target.balance + (Number(amount) || 0)} /><button className="primary-button" disabled={busy}>确认追加</button></form>}
      {dialog.kind === "rename" && <form onSubmit={submit}><label className="cdk-field">备注<input name="note" defaultValue={dialog.target.note} maxLength="160" /></label><button className="primary-button" disabled={busy}>保存备注</button></form>}
      {dialog.kind === "toggle" && <><p>{dialog.target.status === "active" ? "禁用后会话立即失效，禁止新操作；已有任务在保存检查点后停止，已用次数保留。" : "启用后可使用原 CDK 重新登录，继续原有账号操作。"}</p><button className="primary-button" disabled={busy} onClick={() => void perform(async () => { await request(auth.token, `/api/admin/cdks/${dialog.target.id}`, "PATCH", { status: dialog.target.status === "active" ? "disabled" : "active" }); setDialog(null); })}>确认{dialog.target.status === "active" ? "禁用" : "启用"}</button></>}
      {dialog.kind === "rotate" && <><p>轮换后原 CDK 和登录会话失效，账号归属与次数保留。新 CDK 只展示本次。</p><button className="primary-button" disabled={busy} onClick={() => void perform(async () => { const result = await request(auth.token, `/api/admin/cdks/${dialog.target.id}/rotate`, "POST", {}); setDialog({ kind: "generated", items: [result] }); }, "CDK 已轮换")}>确认轮换</button></>}
      {dialog.kind === "ban" && <form onSubmit={submit}><p className="cdk-helper">限制此 IP 访问本系统，包含已登录请求。账号使用的出站代理不属于这里的来源 IP。</p><label className="cdk-field">客户端 IP<input name="ip" defaultValue={dialog.ip} required /></label><label className="cdk-field">封禁时长<select name="minutes"><option value="30">30 分钟</option><option value="1440">24 小时</option><option value="permanent">永久</option></select></label><label className="cdk-field">处理原因<input name="reason" maxLength="200" required /></label><button className="primary-button" disabled={busy}>确认拉黑</button></form>}
      {dialog.kind === "unban" && <><p>解除 {dialog.target.ip} 的封禁后，该来源可以重新访问。操作记录继续保留。</p><button className="primary-button" disabled={busy} onClick={() => void perform(async () => { await request(auth.token, `/api/admin/security/ip-bans/${dialog.target.id}/revoke`, "POST", {}); setDialog(null); }, "IP 已解除封禁")}>确认解除</button></>}
      {dialog.kind === "merge" && <form onSubmit={(event) => { event.preventDefault(); if (source.trim() !== dialog.source || mergeQuote?.fingerprint !== dialog.quote.fingerprint) { setError("来源已变化，请重新验证融合资格"); setDialog(null); setMergeQuote(null); return; } void perform(async () => { await request(auth.token, "/api/cdk/merge", "POST", { sourceCdk: dialog.source, fingerprint: dialog.quote.fingerprint, amount: dialog.quote.amount, requestKey: dialog.requestKey }); setDialog(null); setSource(""); setMergeQuote(null); }, "次数已融合，来源 CDK 已永久失效"); }}><p>将 {dialog.quote.sourceLabel} 的全部剩余次数转入当前 CDK。</p><Equation before={dialog.quote.before} delta={dialog.quote.amount} after={dialog.quote.after} changeLabel="将转入" /><label className="cdk-check"><input type="checkbox" required />我已知晓，来源 CDK 将永久失效，融合不可撤回。</label><button className="primary-button" disabled={busy}>确认融合 {dialog.quote.amount} 次</button></form>}
      {dialog.kind === "recovery" && <div>{dialog.items.map((item) => <div className="cdk-recovery-row" key={item.id}><strong>{item.mode} / 预留 {item.charge} 次</strong><small>{new Date(item.createdAt).toLocaleString()}</small><button className="secondary-button" disabled={busy} onClick={() => void perform(async () => { await request(auth.token, `/api/admin/imports/${item.id}/retry`, "POST", {}); setDialog(null); }, "导入恢复完成")}>恢复此导入</button></div>)}</div>}
    </Drawer>}
  </section>;
}
