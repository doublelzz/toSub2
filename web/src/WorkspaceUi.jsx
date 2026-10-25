import React, { useEffect, useId, useRef, useState } from "react";
import { CalendarDays, ChevronDown, Moon, MoreHorizontal, Search, Sun, X } from "lucide-react";
import { dayKey, dateBounds } from "./task-filters.mjs";

export function useCalendarDay() {
  const [day, setDay] = useState(dayKey);
  useEffect(() => {
    const timer = window.setInterval(() => setDay(dayKey()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return day;
}

export function ThemeControl() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.themePreference || "system");
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.themePreference = theme;
      document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    try { localStorage.setItem("tosub2.theme", theme); } catch {}
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return <label className="theme-control">{theme === "dark" ? <Moon size={15} aria-hidden="true" /> : <Sun size={15} aria-hidden="true" />}<select aria-label="外观主题" value={theme} onChange={(event) => setTheme(event.target.value)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>;
}

export function TaskOverview({ today, total, items, onToday, onTotal, label = "任务统计", todayLabel = "今日任务", totalLabel = "总任务", note }) {
  return <section className="task-overview" aria-label={label}>
    <div className="overview-totals"><button type="button" onClick={onToday} className="overview-metric" title="按创建时间筛选今天"><span>{todayLabel}</span><strong>{today ?? "—"}</strong></button><button type="button" onClick={onTotal} className="overview-metric" title="恢复全部日期"><span>{totalLabel}</span><strong>{total ?? "—"}</strong></button></div>
    <div className="overview-states">{items.map((item) => <button key={item.key} type="button" onClick={item.onClick} aria-label={`筛选${item.label}`}><span><i className={`status-dot ${item.tone || ""}`} />{item.label}</span><strong>{item.count || 0}</strong></button>)}</div>
    {note && <p className="overview-note">{note}</p>}
  </section>;
}

export function TaskFilters({ value, onChange, statuses, dateFields, extra, day }) {
  const id = useId();
  const bounds = dateBounds(value);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const update = (patch) => onChange({ ...value, ...patch });
  return <section className="task-filters" aria-label="任务筛选">
    <div className="filter-fields"><label className="search-field"><Search size={16} aria-hidden="true" /><input type="search" aria-label="搜索邮箱" placeholder="搜索邮箱" value={value.search} onChange={(event) => update({ search: event.target.value })} /></label><select aria-label="任务状态" value={value.status} onChange={(event) => update({ status: event.target.value })}>{Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><label className="date-field-select"><CalendarDays size={15} aria-hidden="true" /><select aria-label="筛选日期字段" value={value.dateField} onChange={(event) => update({ dateField: event.target.value })}>{Object.entries(dateFields).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>{extra}</div>
    <div className="date-presets">{[["all", "全部日期"], ["today", "今天"], ["yesterday", "昨天"], ["week", "近 7 天"], ["month", "近 30 天"], ["custom", "自定义"]].map(([key, label]) => <button key={key} type="button" aria-pressed={value.preset === key} onClick={() => update({ preset: key, ...(key === "custom" ? { startDate: value.startDate || day || dayKey(), endDate: value.endDate || day || dayKey() } : {}) })}>{label}</button>)}<span className="filter-timezone">{zone}</span></div>
    {value.preset === "custom" && <div className="custom-date-range"><label htmlFor={`${id}-start`}>开始日期<input id={`${id}-start`} type="date" value={value.startDate} onChange={(event) => update({ startDate: event.target.value })} aria-invalid={Boolean(bounds.error)} /></label><span>至</span><label htmlFor={`${id}-end`}>结束日期<input id={`${id}-end`} type="date" value={value.endDate} onChange={(event) => update({ endDate: event.target.value })} aria-invalid={Boolean(bounds.error)} /></label></div>}
    {bounds.error && <p className="filter-error" role="alert">{bounds.error}</p>}
  </section>;
}

export function Drawer({ title, onClose, children, wide = false }) {
  const ref = useRef(null);
  const id = useId();
  useDialogFocus(true, onClose, ref);
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section ref={ref} className={`workspace-drawer ${wide ? "drawer-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={id}><header className="drawer-heading"><h2 id={id}>{title}</h2><button type="button" className="icon-button" aria-label="关闭面板" onClick={onClose}><X size={19} /></button></header>{children}</section></div>;
}

const dialogFocusDocuments = new WeakMap();

export function useDialogFocus(active, onClose, rootRef, returnFocus) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!active) return undefined;
    const panel = rootRef?.current || document.querySelector('.modal-backdrop [role="dialog"]');
    if (!panel) return undefined;
    const ownerDocument = panel.ownerDocument;
    let state = dialogFocusDocuments.get(ownerDocument);
    if (!state) {
      state = { entries: [], overflow: ownerDocument.body.style.overflow };
      dialogFocusDocuments.set(ownerDocument, state);
    }
    const entry = { panel, previous: returnFocus || ownerDocument.activeElement };
    state.entries.push(entry);
    ownerDocument.body.style.overflow = "hidden";
    const canFocus = (element) => element?.isConnected && typeof element.focus === "function" && !element.matches(":disabled") && element.getClientRects().length;
    const controls = (target) => [...target.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]')].filter((element) => canFocus(element) && element.tabIndex >= 0);
    if (!panel.contains(ownerDocument.activeElement)) controls(panel)[0]?.focus();
    const onKey = (event) => {
      if (state.entries.at(-1) !== entry) return;
      if (event.key === "Escape") { event.stopPropagation(); closeRef.current(); }
      if (event.key === "Tab") {
        const focusable = controls(panel);
        const first = focusable[0]; const last = focusable[focusable.length - 1];
        if (event.shiftKey && (ownerDocument.activeElement === first || !panel.contains(ownerDocument.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (ownerDocument.activeElement === last || !panel.contains(ownerDocument.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    ownerDocument.addEventListener("keydown", onKey);
    return () => {
      const wasTop = state.entries.at(-1) === entry;
      const index = state.entries.indexOf(entry);
      if (index >= 0) state.entries.splice(index, 1);
      for (const remaining of state.entries) if (entry.panel.contains(remaining.previous)) remaining.previous = entry.previous;
      ownerDocument.removeEventListener("keydown", onKey);
      if (!state.entries.length) {
        ownerDocument.body.style.overflow = state.overflow;
        dialogFocusDocuments.delete(ownerDocument);
      }
      if (!wasTop) return;
      const next = state.entries.at(-1);
      if (next) {
        if (next.panel.contains(entry.previous) && canFocus(entry.previous)) entry.previous.focus();
        else controls(next.panel)[0]?.focus();
      } else if (canFocus(entry.previous)) entry.previous.focus();
    };
  }, [active, rootRef, returnFocus]);
}

export function MoreActions({ label = "更多操作", children }) {
  const ref = useRef(null);
  useEffect(() => {
    const close = (event) => { if (!ref.current?.contains(event.target)) ref.current?.removeAttribute("open"); };
    const escape = (event) => { if (event.key === "Escape" && ref.current?.open) { ref.current.removeAttribute("open"); ref.current.querySelector("summary")?.focus(); } };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, []);
  return <details ref={ref} className="more-actions"><summary aria-label={label}><MoreHorizontal size={17} /><span>{label}</span><ChevronDown size={13} /></summary><div className="actions-menu" onClick={(event) => { if (event.target.closest("button") && !event.target.closest("button").disabled) ref.current?.removeAttribute("open"); }}>{children}</div></details>;
}
