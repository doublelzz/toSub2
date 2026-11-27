import React, { useEffect, useState } from "react";
import { cdkFetch } from "./cdk-api.mjs";

function deviceName(agent) {
  const browser = /Edg\//.test(agent) ? "Edge" : /Firefox\//.test(agent) ? "Firefox" : /Chrome\//.test(agent) ? "Chrome" : /Safari\//.test(agent) ? "Safari" : "浏览器";
  const system = /Android/.test(agent) ? "Android" : /iPhone|iPad/.test(agent) ? "iOS" : /Windows/.test(agent) ? "Windows" : /Macintosh/.test(agent) ? "macOS" : /Linux/.test(agent) ? "Linux" : "未知系统";
  return `${system} · ${browser}`;
}

export default function CdkAccountSecurity({ auth }) {
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function reload() {
    const response = await cdkFetch("/api/auth/devices"); const data = await response.json();
    if (!response.ok) throw new Error(data.error || "设备列表加载失败");
    setDevices(data.items);
  }
  useEffect(() => { let active = true; void reload().catch((failure) => { if (active) setError(failure.message); }); return () => { active = false; }; }, [auth.account.id, auth.token]);
  async function revoke(device) {
    setBusy(true); setError("");
    try {
      const response = await cdkFetch(`/api/auth/devices/${device.id}`, { method: "DELETE", headers: { "x-console-token": auth.token } }); const data = await response.json();
      if (!response.ok) throw new Error(data.error || "移除失败，请重试");
      if (device.current) await auth.reload(); else await reload();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <section className="cdk-account-security" aria-label="账号安全"><h3>账号与可信设备</h3>
    <dl className="cdk-detail"><div><dt>绑定邮箱</dt><dd>{auth.account.email || "未绑定"}</dd></div><div><dt>绑定时间</dt><dd>{auth.account.emailBoundAt ? new Date(auth.account.emailBoundAt).toLocaleString() : "—"}</dd></div></dl>
    <p className="cdk-helper">设备信任有效期为 30 天。移除后，该设备的登录会话失效，下次登录需要重新验证邮箱。</p>
    {error && <p className="cdk-error" role="alert">{error}<button className="cdk-link" onClick={() => void reload().then(() => setError("")).catch((failure) => setError(failure.message))}>重新加载</button></p>}
    {devices === null ? <p role="status">正在加载设备</p> : devices.length ? <ul className="cdk-device-list">{devices.map((device) => <li key={device.id}><div><strong>{deviceName(device.description)}{device.current ? "（当前设备）" : ""}</strong><small>最近使用：{new Date(device.lastSeen).toLocaleString()}<br />信任到期：{new Date(device.expiresAt).toLocaleString()}</small></div><button className="secondary-button" disabled={busy} onClick={() => void revoke(device)}>{device.current ? "移除并退出" : "移除设备"}</button></li>)}</ul> : <p className="cdk-helper">暂无有效的可信设备。</p>}
  </section>;
}
