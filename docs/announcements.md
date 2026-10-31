# 首页公告与使用教程

公告是全站共用的一份 HTML 内容。管理员在管理视角的侧栏进入「公告管理」；普通 CDK 只阅读已启用的公告，不能进入管理接口。启用后，登录工作台的用户可从顶部「公告 / 教程」随时查看。

## 编写、预览与发布

填写公告标题和 HTML 正文，也可点击「插入排版模板」追加演示排版。标题最多 100 个字符；正文最多 **100,000 UTF-8 bytes**，界面按 100 KB 显示，中文和表情通常占多个字节。启用或发布前，标题不能为空，正文须包含可见文字或有效图片。

右侧「内容预览」实时呈现经过处理的正文；「弹窗预览」使用与用户端相同的排版与弹窗，关闭预览不会记录已读。正文超限时暂停预览，缩减后恢复。

| 操作 | 保存后的行为 |
| --- | --- |
| 首次保存，未勾选「启用公告」 | 只保存草稿，不创建发布版本，也不显示用户入口。 |
| 首次勾选「启用公告」后保存 | 自动创建首个版本并启用。 |
| 已有版本时「保存修改」 | 更新内容及启停状态，保留版本 ID 和发布时间；已关闭本版的浏览器不会再次自动提醒。 |
| 「发布新版本」 | 创建新版本并刷新发布时间，**强制启用公告**；即使未勾选「启用公告」也会启用，新版本可再次提醒。 |
| 取消勾选「启用公告」后保存 | 停用展示，保留内容和版本；用户端下次读取到停用状态后隐藏入口及弹窗。 |
| 再次勾选后保存 | 重新展示原版本，原有已读记录继续有效；需要重新提醒时使用「发布新版本」。 |

修改标题、正文或启用状态后，切换工作区、切换管理/用户视角或退出时会提示未保存内容；刷新或关闭页面使用浏览器离开提示。保存期间阻止工作区切换。若另一管理员已更新公告，保存会报冲突；「重新读取（替换未保存内容）」会以服务端最新内容替换当前编辑内容。

## HTML 排版范围

支持标题、段落、列表、引用、强调、表情、表格、`pre/code`、`details/summary`、图片、链接等内容标签。正文、实时预览和弹窗使用同一 HTML 处理规则。脚本、表单、iframe、事件属性及任意自定义 class 不会保留。

优先使用以下语义 class，它们跟随现有浅色、深色主题：

| class | 效果 |
| --- | --- |
| `notice-info`、`notice-accent` | 主题强调色文字 |
| `notice-success` | 成功色文字 |
| `notice-warning` | 提醒色文字 |
| `notice-danger` | 错误色文字 |
| `notice-muted` | 辅助色文字 |
| `notice-note`、`notice-callout` | 带浅色背景及边框的提示段落 |

有限内联 `style` 支持 `color`、`background-color`、`font-size`、`font-family`、`font-weight`、`font-style`、`text-align`、`text-decoration` 和 `line-height`。字号允许 10–48 px、0.75–3 em/rem、75%–300% 或 `small` 至 `xx-large`；行高为 1.2–2.5 倍。颜色可用常见 CSS 颜色值，或 `var(--ink)`、`var(--muted)`、`var(--green)`、`var(--green-soft)`、`var(--blue)`、`var(--amber)`、`var(--success)`、`var(--danger)`。自定颜色不会自动适配主题，发布前应分别预览浅深色。

链接接受完整的 `https://`、`http://` 或 `mailto:` 地址，自动在新标签页打开并添加 `noopener noreferrer`。图片只接受完整的 HTTP(S) 地址，延迟加载、不发送 referrer，并限制在正文宽度内；不接受相对路径或 data URL。表格可横向滚动。每个 `pre` 代码块自动增加「复制示例」按钮，复制失败时选中内容并提示手动复制，无需在 HTML 中编写按钮。

下面内容可直接粘贴到「HTML 正文」，所有文字和地址均为演示，请在发布前替换：

```html
<h2>📖 演示请替换：公告标题</h2>
<p>演示请替换：在这里填写公告摘要和适用范围。</p>
<p class="notice-callout"><strong>💡 演示请替换：</strong>填写需要优先阅读的提示。</p>

<h3>演示请替换：操作说明</h3>
<ol>
  <li>演示请替换：填写第一步。</li>
  <li>演示请替换：填写第二步。</li>
</ol>
<p><span class="notice-success">✅ 演示请替换：完成状态</span> ·
  <span class="notice-warning">演示请替换：注意事项</span></p>
<p style="font-weight: 600; text-align: left">演示请替换：加粗重点。</p>

<table>
  <thead><tr><th>演示请替换：项目</th><th>演示请替换：说明</th></tr></thead>
  <tbody><tr><td>演示请替换：示例项</td><td>演示请替换：对应内容</td></tr></tbody>
</table>

<h3>演示请替换：可复制文本</h3>
<pre><code>演示请替换：这里放需要复制的示例文本。
演示请替换：HTML 符号使用 &lt;示例&gt; 等实体。</code></pre>

<details>
  <summary>演示请替换：展开补充说明</summary>
  <p class="notice-muted">演示请替换：在这里填写补充内容。</p>
</details>
<p><a href="https://example.com/">演示请替换：参考链接和地址</a></p>
<!-- 如需图片，替换为可访问的真实图片地址后再使用：
<img src="https://example.com/demo.png" alt="演示请替换：图片说明">
-->
```

## 提醒时机与已读记录

用户关闭公告（关闭按钮、Escape 或「我知道了，本版不再提示」）后，该版本记为已读，仍可从顶部入口手动打开。新版本随登录、刷新，以及窗口重新获得焦点或页面返回可见时的既有 `/api/bootstrap` 读取进入页面；没有独立的公告定时轮询。自动弹出会等待当前已有的模态弹窗关闭，不打断导入确认等操作。

已读版本保存在当前浏览器、当前站点来源（协议、域名及端口）的 `localStorage` 键 `tosub2.announcement.dismissed-versions.v1`，最多保留最近 50 个版本。它不按 CDK 隔离，不同步到其他浏览器或设备；退出登录、切换 CDK 和服务重启不会主动清除。浏览器存储不可用时，仅当前页面会话内记住关闭状态。

需要在同一浏览器重新演示时，可删除这个键，再刷新页面；这只清理该浏览器该站点的公告已读状态。清理整个站点数据还会影响该站点其他浏览器偏好。单独删键后，当前页面内存仍可能记住已关闭版本，因此应刷新；管理员重新保存或停用再启用不会清除用户已读记录。

## 本地验证范围

验证命令为 `npm run check:announcement`，依次运行 `test/announcement-html.mjs`、`test/announcement-console.mjs` 和 `test/announcement-ui.mjs`，覆盖 HTML 过滤、权限与持久化、版本发布、已读、弹窗协调、预览及复制等行为。接口测试使用临时目录和本机测试服务，界面测试使用 JSDOM 与合成数据；这些检查不代表真实账号、远程部署或线上服务验证。排版模板及本文示例均为演示内容。

本次实现另完成 `npm run build`、`npm run check:ui` 和隔离本机浏览器排版核对，覆盖桌面、手机、实际面板宽度与浅深主题。浏览器服务使用随机本地端口、临时数据目录及合成数据，没有触发真实账号或真实远程服务。

实现依据：`web/src/Announcement.jsx`、`web/src/announcement.css`、`web/src/AnnouncementEntry.jsx`、`web/src/announcement-read-state.mjs`、`src/announcement-store.mjs`、`src/announcement-html.mjs`。公告继承现有石墨蓝主题变量、字体、按钮和弹窗行为，属于普通功能扩展，没有新增设计系统。
