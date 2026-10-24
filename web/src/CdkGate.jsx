import React, { useEffect, useRef, useState } from "react";
import { KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { ThemeControl, useDialogFocus } from "./WorkspaceUi.jsx";
import { clearWorkspaceSettings, flushWorkspaceSettings, hydrateWorkspaceSettings, setImportConfirmation } from "./cdk-api.mjs";
import "./cdk.css";

export default function CdkGate({ children }) {
  const [bootstrap, setBootstrap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cdk, setCdk] = useState("");
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(null);
  const [settingsError, setSettingsError] = useState("");
  const [quote, setQuote] = useState(null);
  const quoteResolver = useRef(null);
  const quotePanel = useRef(null);
  const current = useRef(null);

  async function reload() {
    try {
      const response = await fetch("/api/bootstrap"); const data = await response.json();
      if (!response.ok) { if (data.code === "IP_BLOCKED") setBlocked(data); throw new Error(data.error || "连接失败"); }
      if (data.authenticated) {
        if (!current.current || current.current.workspace.id !== data.workspace.id || current.current.token !== data.token) hydrateWorkspaceSettings(data);
        current.current = data; setBootstrap(data); setBlocked(null);
      } else { current.current = null; setBootstrap(null); clearWorkspaceSettings(); }
    } catch (failure) { setError(failure.message); } finally { setLoading(false); }
  }

  useEffect(() => {
    void reload();
    const refresh = () => void reload();
    const onBlocked = (event) => { setBlocked(event.detail); setBootstrap(null); current.current = null; clearWorkspaceSettings(); };
    const onSettingsError = (event) => setSettingsError(event.detail);
    window.addEventListener("cdk-session-refresh", refresh); window.addEventListener("cdk-balance-changed", refresh);
    window.addEventListener("cdk-access-blocked", onBlocked); window.addEventListener("cdk-settings-error", onSettingsError);
    setImportConfirmation((next) => new Promise((resolve) => { quoteResolver.current?.(false); quoteResolver.current = resolve; setQuote(next); }));
    return () => { window.removeEventListener("cdk-session-refresh", refresh); window.removeEventListener("cdk-balance-changed", refresh); window.removeEventListener("cdk-access-blocked", onBlocked); window.removeEventListener("cdk-settings-error", onSettingsError); setImportConfirmation(null); quoteResolver.current?.(false); };
  }, []);

  const finishQuote = (accepted) => { quoteResolver.current?.(accepted); quoteResolver.current = null; setQuote(null); };
  useDialogFocus(Boolean(quote), () => finishQuote(false), quotePanel);

  async function login(event) {
    event.preventDefault(); setLoading(true); setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cdk: cdk.trim() }) });
      const data = await response.json();
      if (!response.ok) { if (data.code === "IP_BLOCKED") setBlocked(data); throw new Error(data.error || "CDK 验证失败"); }
      hydrateWorkspaceSettings(data); current.current = data; setBootstrap(data); setCdk("");
    } catch (failure) { setError(failure.message); } finally { setLoading(false); }
  }

  async function logout() {
    try { await flushWorkspaceSettings(); } catch (failure) { setSettingsError(failure.message); throw failure; }
    await fetch("/api/auth/logout", { method: "POST", headers: { "x-console-token": current.current.token } });
    current.current = null; clearWorkspaceSettings(); setBootstrap(null); setSettingsError(""); setError("");
  }

  async function switchWorkspace(id) {
    try { await flushWorkspaceSettings(); } catch (failure) { setSettingsError(failure.message); throw failure; }
    const response = await fetch("/api/auth/workspace", { method: "POST", headers: { "content-type": "application/json", "x-console-token": current.current.token }, body: JSON.stringify({ cdkId: id }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || "切换失败");
    hydrateWorkspaceSettings(data); current.current = data; setBootstrap(data); setSettingsError("");
  }

  if (!bootstrap) return <main className="cdk-entry"><div className="cdk-entry-theme"><ThemeControl /></div><div className="cdk-entry-layout"><section><div className="cdk-entry-brand"><ShieldCheck size={28} /><strong>账号工作台</strong></div><h1>{blocked ? "当前访问暂时受限" : <>用 CDK 进入<br />你的账号工作台</>}</h1><p>{blocked ? "当前来源已被封禁，请在到期后重新访问，或联系管理员核查。" : "导入、授权和管理自己的账号。次数只在新增账号成功入库时消耗。"}</p><dl className="cdk-entry-rules"><div><dt>新增一个账号</dt><dd>消耗 1 次</dd></div><div><dt>已有账号后续操作</dt><dd>不重复扣次</dd></div><div><dt>任务、凭据与结果</dt><dd>按 CDK 独立保存</dd></div></dl></section><form className="cdk-entry-form" onSubmit={login}><h2>{blocked ? "访问已封禁" : "验证 CDK"}</h2><p>{blocked ? (blocked.expiresAt ? `封禁到期：${new Date(blocked.expiresAt).toLocaleString()}` : "此来源已被永久封禁，请联系管理员解除。") : "使用管理员分发的 CDK 登录。"}</p>{!blocked && <label>CDK<input type="password" value={cdk} onChange={(event) => setCdk(event.target.value)} placeholder="输入完整 CDK" autoComplete="off" required disabled={loading} aria-invalid={Boolean(error)} /></label>}{error && <p className="cdk-error" role="alert">{error}</p>}<button className="primary-button" disabled={loading} type={blocked ? "button" : "submit"} onClick={blocked ? reload : undefined}>{loading ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}{blocked ? "重新检查访问状态" : loading ? "正在验证" : "验证并进入"}</button><p className="cdk-entry-foot">{blocked ? "管理员可通过本机管理命令解除封禁。" : "CDK 无效或已失效时，请联系分发管理员。退出登录不会停止已有任务。"}</p></form></div></main>;
  return <>{settingsError && <div className="cdk-save-error" role="alert">{settingsError}<button type="button" onClick={() => void flushWorkspaceSettings().then(() => setSettingsError("")).catch((failure) => setSettingsError(failure.message))}>重新保存配置</button></div>}{children({ ...bootstrap, reload, logout, switchWorkspace })}{quote && <div className="modal-backdrop cdk-import-backdrop"><section ref={quotePanel} className="cdk-confirm" role="dialog" aria-modal="true" aria-labelledby="import-quote-title"><h2 id="import-quote-title">确认导入账号</h2><p>去重后 {quote.count} 个账号，其中新增 {quote.added} 个，已有 {quote.updated} 个。</p><div className="cdk-equation"><div><span>当前可用</span><strong>{quote.balance ?? "不限"}</strong></div><div><span>本次扣次</span><strong>{quote.charge}</strong></div><div><span>导入后可用</span><strong>{quote.after ?? "不限"}</strong></div></div><p className="cdk-helper">已有账号更新和内部流转不重复扣次。新增账号入库后，任务失败或取消不自动退次。</p><footer><button className="secondary-button" type="button" onClick={() => finishQuote(false)}>取消</button><button className="primary-button" type="button" onClick={() => finishQuote(true)}>确认导入{quote.charge ? `，消耗 ${quote.charge} 次` : "，不扣次数"}</button></footer></section></div>}</>;
}
