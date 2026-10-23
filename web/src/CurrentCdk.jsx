import React, { useEffect, useId, useRef, useState } from "react";
import { Copy, Eye, EyeOff, LoaderCircle, X } from "lucide-react";
import { cdkFetch } from "./cdk-api.mjs";

export default function CurrentCdk({ auth, onOpen }) {
  const [expanded, setExpanded] = useState(false);
  const [secret, setSecret] = useState("");
  const [legacyInput, setLegacyInput] = useState("");
  const [needsVerification, setNeedsVerification] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const container = useRef(null);
  const secretInput = useRef(null);
  const request = useRef(null);
  const panelId = useId();

  function hide() {
    request.current?.abort(); setExpanded(false); setSecret(""); setLegacyInput(""); setNeedsVerification(false); setError(""); setBusy(false); setCopied(false);
  }

  useEffect(() => {
    if (!expanded) return undefined;
    const outside = (event) => { if (!container.current?.contains(event.target)) hide(); };
    const escape = (event) => { if (event.key === "Escape") { hide(); container.current?.querySelector('.cdk-reveal-toggle')?.focus(); } };
    const visibility = () => { if (document.visibilityState === "hidden") hide(); };
    const timer = window.setTimeout(hide, 60000);
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape); document.addEventListener("visibilitychange", visibility);
    return () => { window.clearTimeout(timer); document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); document.removeEventListener("visibilitychange", visibility); };
  }, [expanded]);

  useEffect(() => () => request.current?.abort(), [auth.workspace.id, auth.token]);

  async function reveal(cdk) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setExpanded(true); setBusy(true); setError(""); setCopied(false);
    try {
      const response = await cdkFetch("/api/cdk/reveal", { method: "POST", headers: { "content-type": "application/json", "x-console-token": auth.token }, body: JSON.stringify(cdk === undefined ? {} : { cdk }), signal: controller.signal });
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (result.code === "CDK_SECRET_UNAVAILABLE") { setNeedsVerification(true); return; }
      if (!response.ok) throw new Error(result.error || "查看失败，请重试");
      if (result.cdkId !== auth.workspace.id) throw new Error("工作区已变化，请重新打开当前 CDK");
      setSecret(result.secret); setNeedsVerification(false); setLegacyInput("");
    } catch (failure) { if (!controller.signal.aborted) setError(failure.message); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  async function copy() {
    try { await navigator.clipboard.writeText(secret); setCopied(true); }
    catch { secretInput.current?.focus(); secretInput.current?.select(); setError("请复制已选中的 CDK 内容"); }
  }

  return <div className="cdk-current" ref={container}>
    <div className="cdk-current-heading"><button className="cdk-session-identity" onClick={onOpen}><span>{auth.workspace.label}</span><strong>{auth.workspace.role === "admin" ? "管理员不限次数" : `剩余 ${auth.workspace.balance} 次`}</strong></button><button type="button" className="cdk-reveal-toggle icon-button" aria-label={expanded ? "隐藏当前 CDK" : "查看当前 CDK"} title={expanded ? "隐藏当前 CDK" : "查看当前 CDK"} aria-expanded={expanded} aria-controls={panelId} onClick={() => expanded ? hide() : void reveal()}>{expanded ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>
    {expanded && <section id={panelId} className="cdk-current-panel" aria-label="当前 CDK 内容"><header><strong>当前 CDK</strong><button type="button" className="icon-button" aria-label="关闭 CDK 内容" onClick={hide}><X size={16} /></button></header>
      {busy && <p className="cdk-reveal-status" role="status"><LoaderCircle className="spin" size={16} />正在读取</p>}
      {secret && <><label className="cdk-revealed-label">完整 CDK<input ref={secretInput} type="text" className="cdk-code" value={secret} readOnly autoComplete="off" spellCheck="false" /></label><div className="cdk-current-footer"><span role="status">{copied ? "已复制" : "离开页面或 1 分钟后自动隐藏"}</span><button type="button" className="secondary-button" onClick={() => void copy()}><Copy size={14} />复制</button></div></>}
      {needsVerification && <form onSubmit={(event) => { event.preventDefault(); void reveal(legacyInput.trim()); }}><p className="cdk-helper">此 CDK 来自旧版本。输入当前 CDK 验证一次，之后刷新页面也可以查看。</p><label className="cdk-field">验证当前 CDK<input type="password" value={legacyInput} onChange={(event) => setLegacyInput(event.target.value)} autoComplete="off" required disabled={busy} /></label><button className="primary-button" disabled={busy}>验证并保存</button></form>}
      {error && <p className="cdk-error" role="alert">{error}</p>}{!secret && !needsVerification && !busy && error && <button type="button" className="secondary-button" onClick={() => void reveal()}>重新读取</button>}
    </section>}
  </div>;
}
