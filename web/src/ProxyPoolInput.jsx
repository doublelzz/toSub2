import React, { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { parseProxyPoolText } from "./proxy-pool.mjs";

export function ProxyPoolInput({ value, onChange, disabled = false, label = "代理池", ariaLabel = "代理池地址", description = "每行一个代理，按填写顺序循环取用；空行会忽略，重复行会保留。" }) {
  const [visible, setVisible] = useState(false); const id = useId();
  const { proxies, errors } = parseProxyPoolText(value);
  return <div className="proxy-pool-field">
    <div className="proxy-pool-heading"><label htmlFor={visible ? id : undefined}>{label}</label><button type="button" className="text-action proxy-pool-toggle" disabled={disabled} onClick={() => setVisible((current) => !current)} aria-expanded={visible} aria-controls={visible ? id : undefined}>{visible ? <EyeOff size={14} /> : <Eye size={14} />}{visible ? "隐藏代理" : "查看 / 编辑"}</button></div>
    {visible ? <textarea id={id} aria-label={ariaLabel} aria-describedby={`${id}-help`} aria-invalid={errors.length > 0} value={value} onChange={(event) => onChange(event.target.value)} rows={4} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck="false" placeholder={"http://用户名:密码@主机:端口\nsocks5h://用户名:密码@主机:端口"} disabled={disabled} /> : <button type="button" className="proxy-pool-masked" aria-label={`编辑${label}`} disabled={disabled} onClick={() => setVisible(true)}>{proxies.length ? `已填写 ${proxies.length} 个代理 · 内容已隐藏` : "尚未填写代理 · 点击添加"}</button>}
    <p id={`${id}-help`} className="proxy-pool-help">{description}</p>
    {errors.length > 0 ? <div className="proxy-pool-errors" role="alert">{errors.map((error) => <p key={error}>{error}</p>)}</div> : <p className="proxy-pool-status" role="status">{proxies.length ? `${proxies.length} 个代理 · 顺序循环` : "代理池为空，使用本地网络"}</p>}
  </div>;
}

export function ProxyNetworkOptions({ mode, onModeChange, value, onChange, disabled = false, allowKeep = false, label = "网络方式", ariaLabel = "代理方式" }) {
  return <div className="proxy-network-options">
    <label className="proxy-network-mode"><span>{label}</span><select aria-label={ariaLabel} value={mode} onChange={(event) => onModeChange(event.target.value)} disabled={disabled}><option value="workspace">使用工作区代理池</option><option value="custom">自定义代理池</option><option value="direct">直连本地网络</option>{allowKeep && <option value="keep">保留原代理</option>}</select></label>
    {mode === "custom" ? <ProxyPoolInput value={value} onChange={onChange} disabled={disabled} label="本次代理池" ariaLabel="本次代理池地址" /> : <p className="proxy-pool-help">{mode === "keep" ? "沿用各任务已保存的代理。" : mode === "direct" ? "本次任务使用本地网络。" : "每个账号从当前工作区代理池按顺序取用，池为空时使用本地网络。"}</p>}
  </div>;
}
