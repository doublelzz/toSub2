import crypto from "node:crypto";
import { MAX_ANNOUNCEMENT_BYTES } from "./announcement-html.mjs";
import { cdkError } from "./cdk-security.mjs";

const settingName = "site-announcement";
const maxTitleLength = 100;
const emptyAnnouncement = () => ({ enabled: false, id: null, title: "", content: "", format: "html", publishedAt: null, updatedAt: null });
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;

export function createAnnouncementStore({ store, sanitize, document }) {
  function hasContent(html) {
    const container = document.createElement("div");
    container.innerHTML = html;
    return Boolean(container.textContent.replace(/[\s\u00a0\u200b-\u200d\ufeff]/g, "") || container.querySelector("img[src]"));
  }

  function read() {
    const saved = store.setting(store.adminId, settingName);
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return emptyAnnouncement();
    const source = typeof saved.content === "string" && Buffer.byteLength(saved.content, "utf8") <= MAX_ANNOUNCEMENT_BYTES ? saved.content : "";
    return {
      enabled: saved.enabled === true,
      id: typeof saved.id === "string" && saved.id.length <= 100 ? saved.id : null,
      title: typeof saved.title === "string" ? saved.title.slice(0, maxTitleLength).trim() : "",
      content: sanitize(source).trim(),
      format: "html",
      publishedAt: timestamp(saved.publishedAt),
      updatedAt: timestamp(saved.updatedAt),
    };
  }

  function publicAnnouncement() {
    const announcement = read();
    return announcement.enabled && announcement.id && announcement.publishedAt && announcement.title && hasContent(announcement.content) ? announcement : null;
  }

  function save(input, actor) {
    if (typeof input.title !== "string" || input.title.trim().length > maxTitleLength) throw cdkError(422, `公告标题最多 ${maxTitleLength} 个字符`);
    if (typeof input.content !== "string") throw cdkError(422, "公告内容必须为 HTML 文本");
    if (Buffer.byteLength(input.content, "utf8") > MAX_ANNOUNCEMENT_BYTES) throw cdkError(413, "公告内容不能超过 100 KB");
    if (typeof input.enabled !== "boolean" || input.publish !== undefined && typeof input.publish !== "boolean") throw cdkError(422, "公告发布状态格式不正确");
    if (!Object.hasOwn(input, "expectedUpdatedAt") || input.expectedUpdatedAt !== null && typeof input.expectedUpdatedAt !== "string") throw cdkError(422, "请重新加载公告后保存");
    if (input.format !== undefined && input.format !== "html") throw cdkError(422, "公告仅支持 HTML 格式");

    const previous = read();
    if (input.expectedUpdatedAt !== previous.updatedAt) throw cdkError(409, "公告已被修改，请重新加载后再保存", "ANNOUNCEMENT_CONFLICT");
    const title = input.title.trim();
    const content = sanitize(input.content).trim();
    if (Buffer.byteLength(content, "utf8") > MAX_ANNOUNCEMENT_BYTES) throw cdkError(413, "处理后的公告内容不能超过 100 KB");
    if ((input.enabled || input.publish) && (!title || !hasContent(content))) throw cdkError(422, "启用或发布公告前，请填写标题和有效内容");

    const updatedAt = new Date(Math.max(Date.now(), previous.updatedAt ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
    const publish = input.publish === true || input.enabled && !previous.id;
    const announcement = {
      enabled: input.enabled,
      id: publish ? crypto.randomUUID() : previous.id,
      title,
      content,
      format: "html",
      publishedAt: publish ? updatedAt : previous.publishedAt,
      updatedAt,
    };
    store.saveSetting(store.adminId, settingName, announcement);
    store.audit(actor, publish ? "announcement-publish" : "announcement-update", settingName, { id: announcement.id, enabled: announcement.enabled });
    return announcement;
  }

  return { read, save, publicAnnouncement };
}
