import React, { useEffect, useRef, useState } from "react";
import { KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { ThemeControl } from "./WorkspaceUi.jsx";
import ImportChargeDialog from "./ImportChargeDialog.jsx";
import { clearWorkspaceSettings, flushWorkspaceSettings, hydrateWorkspaceSettings, refreshWorkspaceSmsPermissions, setImportConfirmation } from "./cdk-api.mjs";
import "./cdk.css";

export default function CdkGate({ children }) {
  const [bootstrap, setBootstrap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [cdk, setCdk] = useState("");
  const [challenge, setChallenge] = useState(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [clock, setClock] = useState(Date.now());
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(null);
  const [settingsError, setSettingsError] = useState("");
  const [quote, setQuote] = useState(null);
  const quoteResolver = useRef(null);
  const current = useRef(null);
  const reloadPromise = useRef(null);

  useEffect(() => {
    try { window.localStorage.removeItem("tosub2.remembered-cdk-v1"); } catch {}
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function reload() {
    if (reloadPromise.current) return reloadPromise.current;
    const operation = (async () => { try {
      const response = await fetch("/api/bootstrap"); const data = await response.json();
      if (!response.ok) { if (data.code === "IP_BLOCKED") setBlocked(data); throw new Error(data.error || "连接失败"); }
      if (data.authenticated) {
        if (!current.current || current.current.workspace.id !== data.workspace.id || current.current.token !== data.token) hydrateWorkspaceSettings(data);
        else if (JSON.stringify(current.current.workspace.allowedSmsProviders || current.current.features?.allowedSmsProviders) !== JSON.stringify(data.workspace.allowedSmsProviders || data.features?.allowedSmsProviders)) refreshWorkspaceSmsPermissions(data);
        current.current = data; setBootstrap(data); setChallenge(null); setBlocked(null);
      } else { current.current = null; setBootstrap(null); setChallenge(data.authState ? data : null); clearWorkspaceSettings(); }
    } catch (failure) { setError(failure.message); } finally { setLoading(false); } })();
    reloadPromise.current = operation;
    try { return await operation; } finally { if (reloadPromise.current === operation) reloadPromise.current = null; }
  }

  useEffect(() => {
    void reload();
    const refresh = () => void reload();
    const refreshVisible = () => { if (document.visibilityState !== "hidden") void reload(); };
    const permissionsTimer = window.setInterval(refreshVisible, 15_000);
    const onBlocked = (event) => { setBlocked(event.detail); setBootstrap(null); current.current = null; clearWorkspaceSettings(); };
    const onSettingsError = (event) => setSettingsError(event.detail);
    window.addEventListener("cdk-session-refresh", refresh); window.addEventListener("cdk-balance-changed", refresh);
    window.addEventListener("cdk-sms-permissions-changed", refresh); window.addEventListener("focus", refreshVisible); document.addEventListener("visibilitychange", refreshVisible);
    window.addEventListener("cdk-access-blocked", onBlocked); window.addEventListener("cdk-settings-error", onSettingsError);
    setImportConfirmation((next) => new Promise((resolve) => { quoteResolver.current?.(false); quoteResolver.current = resolve; setQuote(next); }));
    return () => { window.clearInterval(permissionsTimer); window.removeEventListener("cdk-session-refresh", refresh); window.removeEventListener("cdk-balance-changed", refresh); window.removeEventListener("cdk-sms-permissions-changed", refresh); window.removeEventListener("focus", refreshVisible); document.removeEventListener("visibilitychange", refreshVisible); window.removeEventListener("cdk-access-blocked", onBlocked); window.removeEventListener("cdk-settings-error", onSettingsError); setImportConfirmation(null); quoteResolver.current?.(false); };
  }, []);

  const finishQuote = (accepted) => { quoteResolver.current?.(accepted); quoteResolver.current = null; setQuote(null); };

  async function login(event) {
    event.preventDefault(); setLoading(true); setError(""); setNotice("");
    const submittedCdk = cdk.trim();
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cdk: submittedCdk }) });
      const data = await response.json();
      if (!response.ok) { if (data.code === "IP_BLOCKED") setBlocked(data); throw new Error(data.error || "CDK 验证失败"); }
      setCdk(""); setEmail(""); setCode("");
      if (data.authenticated) { hydrateWorkspaceSettings(data); current.current = data; setBootstrap(data); setChallenge(null); }
      else { clearWorkspaceSettings(); current.current = null; setBootstrap(null); setChallenge(data); }
    } catch (failure) { setError(failure.message); } finally { setLoading(false); }
  }

  async function emailAction(action) {
    setLoading(true); setError(""); setNotice("");
    try {
      const response = await fetch(`/api/auth/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-console-token": challenge.token }, body: JSON.stringify(action === "email/send" ? { email } : action === "email/verify" ? { code } : {}) });
      const data = await response.json();
      setClock(Date.now());
      if (!response.ok) {
        if (data.code === "IP_BLOCKED") setBlocked(data);
        if (["AUTH_CHALLENGE_EXPIRED", "OTP_ATTEMPTS_EXHAUSTED"].includes(data.code)) { setChallenge(null); setCode(""); }
        throw new Error(data.error || "验证失败，请重试");
      }
      setCode("");
      if (data.authenticated) { hydrateWorkspaceSettings(data); current.current = data; setBootstrap(data); setChallenge(null); }
      else { setChallenge(data.authState ? data : null); if (action === "email/send") setNotice(`验证码已发送至 ${data.email}，5 分钟内有效。`); }
    } catch (failure) {
      setError(failure.message);
      if (action === "email/send") {
        try { const response = await fetch("/api/bootstrap"); const data = await response.json(); if (response.ok && data.authState) setChallenge(data); } catch {}
      }
    }
    finally { setLoading(false); }
  }

  async function logout() {
    try { await flushWorkspaceSettings(); } catch (failure) { setSettingsError(failure.message); throw failure; }
    await fetch("/api/auth/logout", { method: "POST", headers: { "x-console-token": current.current.token } });
    current.current = null; clearWorkspaceSettings(); setBootstrap(null); setChallenge(null); setCdk(""); setSettingsError(""); setError(""); setNotice("");
  }

  async function switchWorkspace(id) {
    try { await flushWorkspaceSettings(); } catch (failure) { setSettingsError(failure.message); throw failure; }
    const response = await fetch("/api/auth/workspace", { method: "POST", headers: { "content-type": "application/json", "x-console-token": current.current.token }, body: JSON.stringify({ cdkId: id }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || "切换失败");
    hydrateWorkspaceSettings(data); current.current = data; setBootstrap(data); setSettingsError("");
  }

  if (!bootstrap) return <><main className="cdk-entry"><div className="cdk-entry-theme"><ThemeControl /></div><div className="cdk-entry-layout"><section><div className="cdk-entry-brand"><ShieldCheck size={28} /><strong>账号工作台</strong></div><h1>{blocked ? "当前访问暂时受限" : <>用 CDK 进入<br />你的账号工作台</>}</h1><p>{blocked ? "当前来源已被封禁，请在到期后重新访问，或联系管理员核查。" : "导入、授权和管理自己的账号。新增账号入库计次，管理员接码池在手机验证成功后另行计次。"}</p><dl className="cdk-entry-rules"><div><dt>新增一个账号</dt><dd>消耗 1 次</dd></div><div><dt>已有账号更新与流转</dt><dd>不重复扣导入次数</dd></div><div><dt>使用管理员接码池</dt><dd>按池规则成功扣次</dd></div><div><dt>任务、凭据与结果</dt><dd>按 CDK 独立保存</dd></div></dl></section>
    <form className="cdk-entry-form" onSubmit={(event) => { if (!challenge) { void login(event); return; } event.preventDefault(); void emailAction(challenge.codeSent ? "email/verify" : "email/send"); }}>
      <h2>{blocked ? "访问已封禁" : challenge ? challenge.authState === "bind_email" ? "绑定邮箱" : "验证登录设备" : "验证 CDK"}</h2>
      <p>{blocked ? (blocked.expiresAt ? `封禁到期：${new Date(blocked.expiresAt).toLocaleString()}` : "此来源已被永久封禁，请联系管理员解除。") : challenge ? challenge.authState === "bind_email" ? "验证邮箱后，此 CDK 将成为你的独立账号，不能再作为来源融合。" : `当前浏览器需要验证已绑定邮箱 ${challenge.email}。` : "使用管理员分发的 CDK 登录；首次使用需要绑定邮箱。"}</p>
      {!blocked && !challenge && <>
        <label>CDK<input type="password" value={cdk} onChange={(event) => setCdk(event.target.value)} placeholder="输入完整 CDK" autoComplete="off" required disabled={loading} aria-invalid={Boolean(error)} /></label>
      </>}
      {!blocked && challenge && <>
        {challenge.authState === "bind_email" && <label>绑定邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={challenge.email || "输入你可以收信的邮箱"} autoComplete="email" required={!challenge.codeSent} disabled={loading || challenge.codeSent} maxLength={254} /></label>}
        {challenge.codeSent && <label>邮箱验证码<input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="输入 6 位验证码" required disabled={loading} autoFocus /></label>}
        <p className="cdk-helper">验证成功后，此浏览器将被信任 30 天。换浏览器或清除站点凭证后需要重新验证邮箱。</p>
        {challenge.codeSent && clock >= challenge.codeExpiresAt && <p className="cdk-error" role="status">验证码已过期，请重新发送。</p>}
      </>}
      {notice && <p className="cdk-notice" role="status">{notice}</p>}
      {error && <p className="cdk-error" role="alert">{error}</p>}
      <button className="primary-button" disabled={loading || !blocked && challenge && !challenge.codeSent && clock < challenge.retryAt} type={blocked ? "button" : "submit"} onClick={blocked ? reload : undefined}>{loading ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}{blocked ? "重新检查访问状态" : loading ? "正在处理" : challenge ? challenge.codeSent ? challenge.authState === "bind_email" ? "验证并绑定邮箱" : "验证并进入" : clock < challenge.retryAt ? `${Math.ceil((challenge.retryAt - clock) / 1000)} 秒后可发送` : "发送邮箱验证码" : "验证 CDK"}</button>
      {!blocked && challenge && <div className="cdk-email-actions">{challenge.codeSent && <button type="button" className="secondary-button" disabled={loading || clock < challenge.retryAt} onClick={() => void emailAction("email/send")}>{clock < challenge.retryAt ? `${Math.ceil((challenge.retryAt - clock) / 1000)} 秒后可重发` : "重新发送验证码"}</button>}<button type="button" className="secondary-button" disabled={loading} onClick={() => void emailAction("cancel")}>返回 CDK 登录</button></div>}
      <p className="cdk-entry-foot">{blocked ? "管理员可通过本机管理命令解除封禁。" : challenge ? "验证码 5 分钟内有效。需要融合的未绑定次数卡，可直接在原账号内使用，无需先绑定。" : "浏览器不再明文保存 CDK。退出登录不会停止已有任务。"}</p>
    </form>
  </div></main><CommunityContact /></>;
  return <>{settingsError && <div className="cdk-save-error" role="alert">{settingsError}<button type="button" onClick={() => void flushWorkspaceSettings().then(() => setSettingsError("")).catch((failure) => setSettingsError(failure.message))}>重新保存配置</button></div>}{children({ ...bootstrap, reload, logout, switchWorkspace })}{quote && <ImportChargeDialog quote={quote} onClose={finishQuote} />}<CommunityContact /></>;
}

function CommunityContact() {
  return <div className="community-contact" aria-label="交流群">交流群:1107653008</div>;
}
