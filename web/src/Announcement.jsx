import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Code2, Eye, LoaderCircle, Megaphone, RefreshCw, Save, Send, X } from "lucide-react";
import { useDialogFocus } from "./WorkspaceUi.jsx";
import { cdkFetch } from "./cdk-api.mjs";
import { createAnnouncementSanitizer, MAX_ANNOUNCEMENT_BYTES } from "../../src/announcement-html.mjs";
import "./announcement.css";

const sanitizers = new WeakMap();
const emptyAnnouncement = { enabled: false, id: null, title: "", content: "", publishedAt: null, updatedAt: null };
const template = `<h2>📖 使用说明</h2>
<p>这是一份排版模板，请将演示文字替换为你的公告或教程。</p>
<p class="notice-callout"><strong>💡 提示：</strong>这里填写需要特别说明的内容。</p>
<h3>开始之前</h3>
<ol>
  <li>在这里填写第一步。</li>
  <li>在这里填写第二步。</li>
</ol>
<h3>格式示例</h3>
<pre><code>在这里粘贴格式示例</code></pre>
<p><span class="notice-success">✅ 完成提示</span> · <span class="notice-warning">需要注意的内容</span></p>
<details><summary>展开详细说明</summary><p>在这里填写补充说明或常见问题。</p></details>`;

function sanitizeHtml(content) {
  let sanitize = sanitizers.get(window);
  if (!sanitize) { sanitize = createAnnouncementSanitizer(window); sanitizers.set(window, sanitize); }
  return sanitize(content || "");
}

function displayDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function contentVisible(html) {
  const fragment = document.createElement("template");
  fragment.innerHTML = html;
  return Boolean(fragment.content.textContent.replace(/[\s\u00a0\u200b-\u200d\ufeff]/g, "") || fragment.content.querySelector("img[src]"));
}

export function AnnouncementContent({ content, className = "" }) {
  const ref = useRef(null);
  const [copyNotice, setCopyNotice] = useState("");
  const html = useMemo(() => sanitizeHtml(content), [content]);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = html;
    setCopyNotice("");
    for (const pre of ref.current?.querySelectorAll("pre") || []) {
      if (pre.parentElement?.classList.contains("announcement-code-block")) continue;
      const wrapper = document.createElement("div");
      wrapper.className = "announcement-code-block";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "announcement-code-copy";
      button.dataset.announcementCopy = "true";
      button.textContent = "复制示例";
      button.setAttribute("aria-label", "复制此代码示例");
      pre.tabIndex = 0;
      pre.replaceWith(wrapper);
      wrapper.append(pre, button);
    }
  }, [html]);

  async function copyCode(event) {
    const button = event.target.closest?.("[data-announcement-copy]");
    if (!button || !ref.current?.contains(button)) return;
    const pre = button.parentElement.querySelector("pre");
    if (!pre) return;
    try {
      await navigator.clipboard.writeText(pre.textContent);
      setCopyNotice("示例已复制到剪贴板");
    } catch {
      const range = document.createRange();
      range.selectNodeContents(pre);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      setCopyNotice("已选中示例，请手动复制");
    }
  }

  return <div className={`announcement-reader ${className}`}>
    <article ref={ref} className="announcement-content" onClick={copyCode} />
    <p className="announcement-copy-status" role="status" aria-live="polite">{copyNotice}</p>
  </div>;
}

export function AnnouncementDialog({ announcement, onClose, preview = false }) {
  const ref = useRef(null);
  const titleId = useId();
  useDialogFocus(true, onClose, ref);
  const published = displayDate(announcement.publishedAt);
  return <div className="modal-backdrop announcement-backdrop">
    <section ref={ref} className="announcement-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="announcement-dialog-heading">
        <div><h2 id={titleId}>{announcement.title || "公告 / 使用教程"}</h2><p>{preview ? "效果预览 · 不会记录为已读" : published ? `发布于 ${published}` : "公告 / 使用教程"}</p></div>
        <button type="button" className="icon-button" aria-label={preview ? "关闭公告预览" : "关闭公告，本版不再提示"} onClick={onClose}><X size={20} /></button>
      </header>
      <div className="announcement-dialog-body"><AnnouncementContent content={announcement.content} /></div>
      <footer className="announcement-dialog-footer">
        <p>{preview ? "与用户端使用相同的内容排版" : "关闭后，仍可从顶部「公告 / 教程」查看。"}</p>
        <button type="button" className="primary-button" onClick={onClose}>{preview ? "关闭预览" : "我知道了，本版不再提示"}</button>
      </footer>
    </section>
  </div>;
}

export function AnnouncementManager({ token, onChanged, onStateChange }) {
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(emptyAnnouncement);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const controller = useRef(null);
  const instance = useRef(0);
  const sourceId = useId();
  const titleId = useId();
  const byteLength = useMemo(() => new TextEncoder().encode(draft.content).byteLength, [draft.content]);
  const overLimit = byteLength > MAX_ANNOUNCEMENT_BYTES;
  const previewHtml = useMemo(() => overLimit ? "" : sanitizeHtml(draft.content), [draft.content, overLimit]);
  const hasContent = useMemo(() => contentVisible(previewHtml), [previewHtml]);
  const dirty = Boolean(saved && (draft.title !== saved.title || draft.content !== saved.content || draft.enabled !== saved.enabled));
  const valid = Boolean(draft.title.trim() && hasContent && !overLimit);

  const load = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const generation = ++instance.current;
    setLoading(true); setError(""); setNotice(""); setConflict(false);
    try {
      const response = await cdkFetch("/api/admin/announcement", { signal: current.signal, headers: { "x-console-token": token } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "公告读取失败，请重试");
      if (current.signal.aborted || generation !== instance.current) return;
      const value = { ...emptyAnnouncement, ...data.announcement };
      setSaved(value); setDraft(value);
    } catch (failure) {
      if (!current.signal.aborted && generation === instance.current) setError(failure.message);
    } finally {
      if (!current.signal.aborted && generation === instance.current) setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); return () => { instance.current += 1; controller.current?.abort(); }; }, [load]);
  useEffect(() => { onStateChange?.({ dirty, busy: Boolean(busy) }); }, [dirty, busy, onStateChange]);
  useEffect(() => () => { onStateChange?.({ dirty: false, busy: false }); }, [onStateChange]);
  useEffect(() => {
    if (!dirty) return undefined;
    const keepChanges = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", keepChanges);
    return () => window.removeEventListener("beforeunload", keepChanges);
  }, [dirty]);

  function update(patch) {
    setDraft((value) => ({ ...value, ...patch })); setNotice("");
  }

  async function save(publish) {
    if (busy || loading || !saved) return;
    setBusy(publish ? "publish" : "save"); setError(""); setNotice(""); setConflict(false);
    const generation = instance.current;
    try {
      const response = await cdkFetch("/api/admin/announcement", {
        method: "PUT", headers: { "content-type": "application/json", "x-console-token": token },
        body: JSON.stringify({ title: draft.title, content: draft.content, enabled: publish ? true : draft.enabled, publish, expectedUpdatedAt: saved.updatedAt || null }),
      });
      const data = await response.json();
      if (!response.ok) { setConflict(response.status === 409); throw new Error(data.error || "公告保存失败，请重试"); }
      if (generation !== instance.current) return;
      const value = { ...emptyAnnouncement, ...data.announcement };
      setSaved(value); setDraft(value);
      setNotice(publish ? "新版本已发布，用户下次进入或返回页面时会收到提醒。" : value.enabled ? "修改已保存，已关闭本版的浏览器不会再次提醒。" : "修改已保存，公告已停用。");
      try { await onChanged?.(value); } catch { setNotice("公告已保存，刷新页面后可查看最新展示状态。"); }
    } catch (failure) {
      if (generation === instance.current) setError(failure.message);
    } finally {
      if (generation === instance.current) setBusy("");
    }
  }

  return <section className="workspace announcement-manager" aria-labelledby="announcement-manager-title">
    <header className="section-heading announcement-manager-heading"><div><h2 id="announcement-manager-title">公告管理</h2><p>写下更新与使用教程，让用户在需要时读到。</p></div><button type="button" className="secondary-button" disabled={loading || Boolean(busy) || !valid} onClick={() => setPreviewOpen(true)}><Eye size={16} />弹窗预览</button></header>

    {loading ? <p className="announcement-loading" role="status"><LoaderCircle size={17} className="spin" />正在读取公告</p> : <>
      {error && <div className="announcement-feedback announcement-feedback-error" role="alert"><p>{error}</p>{(!saved || conflict) && <button type="button" className="text-action" disabled={Boolean(busy)} onClick={() => void load()}><RefreshCw size={14} />{saved ? "重新读取（替换未保存内容）" : "重新读取"}</button>}</div>}
      {notice && <p className="announcement-feedback announcement-feedback-success" role="status"><Check size={16} />{notice}</p>}
      {saved && <>
        <div className="announcement-publishing-state"><div><Megaphone size={17} /><strong>{saved.enabled ? "公告展示中" : "公告已停用"}</strong><span>{saved.publishedAt ? `最近发布 ${displayDate(saved.publishedAt)}` : "尚未发布公告"}</span></div><span className={dirty ? "announcement-unsaved" : ""}>{dirty ? "有未保存的修改" : "内容已保存"}</span></div>
        <div className="announcement-settings"><label className="announcement-title-field" htmlFor={titleId}>公告标题<input id={titleId} value={draft.title} maxLength={100} placeholder="例如：使用说明与最新公告" disabled={Boolean(busy)} onChange={(event) => update({ title: event.target.value })} /></label><label className="announcement-enabled"><input type="checkbox" checked={draft.enabled} disabled={Boolean(busy)} onChange={(event) => update({ enabled: event.target.checked })} /><span>启用公告<small>保存后在用户端展示入口</small></span></label></div>
        <div className="announcement-editor-grid">
          <section className="announcement-source" aria-labelledby={`${sourceId}-label`}><header className="announcement-pane-heading"><h3 id={`${sourceId}-label`}><Code2 size={16} /><label htmlFor={sourceId}>HTML 正文</label></h3><button type="button" className="text-action" disabled={Boolean(busy)} onClick={() => update({ content: `${draft.content.trimEnd()}${draft.content.trim() ? "\n\n" : ""}${template}` })}>插入排版模板</button></header><textarea id={sourceId} value={draft.content} disabled={Boolean(busy)} onChange={(event) => update({ content: event.target.value })} placeholder="在这里粘贴 HTML 公告或使用教程……" spellCheck="false" autoComplete="off" aria-describedby={`${sourceId}-hint ${sourceId}-size`} aria-invalid={overLimit} /><div className="announcement-source-meta"><p id={`${sourceId}-hint`}>支持标题、颜色、表情、表格、代码与折叠说明。</p><span id={`${sourceId}-size`} className={overLimit ? "announcement-size-error" : ""}>{(byteLength / 1000).toFixed(1)} / {MAX_ANNOUNCEMENT_BYTES / 1000} KB</span></div></section>
          <section className="announcement-preview-pane" aria-label="公告内容实时预览"><header className="announcement-pane-heading"><h3><Eye size={16} />内容预览</h3><span>与用户端相同排版</span></header><div className="announcement-preview-document"><h2>{draft.title.trim() || "公告标题"}</h2>{overLimit ? <p className="announcement-preview-placeholder">正文超过 100 KB，缩减后恢复预览。</p> : hasContent ? <AnnouncementContent content={previewHtml} /> : <div className="announcement-preview-placeholder"><p>公告会在这里呈现。</p><span>粘贴 HTML，或插入排版模板开始编写。</span></div>}</div></section>
        </div>
        <details className="announcement-writing-help"><summary>颜色、排版与发布说明</summary><p>正文可使用 <code>notice-accent</code>、<code>notice-success</code>、<code>notice-warning</code>、<code>notice-danger</code>、<code>notice-muted</code> 设置文字颜色，<code>notice-callout</code> 显示提示段落。这些样式会跟随浅色与深色主题。</p><p>也支持有限的内联文字样式，例如 <code>{'<span style="color: #916015; font-weight: 600">重点</span>'}</code>。代码块会自动提供复制按钮。排版模板含演示文字，发布前请替换。</p><p>「保存修改」保留当前版本；「发布新版本」会启用公告，并再次提醒用户。关闭记录只保存在当前浏览器。</p></details>
        <footer className="announcement-manager-footer"><p>{dirty ? "离开本页前请保存修改。" : "修改错别字时保存即可，需要重新提醒时再发布。"}</p><div><button type="button" className="secondary-button" disabled={Boolean(busy) || !dirty || overLimit || (draft.enabled && !valid)} onClick={() => void save(false)}>{busy === "save" ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}保存修改</button><button type="button" className="primary-button" disabled={Boolean(busy) || !valid} onClick={() => void save(true)}>{busy === "publish" ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}发布新版本</button></div></footer>
      </>}
    </>}
    {previewOpen && <AnnouncementDialog announcement={{ ...draft, content: previewHtml }} preview onClose={() => setPreviewOpen(false)} />}
  </section>;
}
