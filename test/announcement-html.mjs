import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createAnnouncementSanitizer } from "../src/announcement-html.mjs";

const dom = new JSDOM("");
const sanitize = createAnnouncementSanitizer(dom.window);
try {
  const html = sanitize(`<h2>📖 Tutorial</h2><p class="notice-warning modal-backdrop" style="color:#916015;font-size:18px;font-weight:600;position:fixed;inset:0;z-index:99999">Important 😂</p>
    <table><tr><th>Format</th><td>email----password</td></tr></table>
    <details open><summary>More</summary><pre><code>&lt;script&gt;example&lt;/script&gt;</code></pre></details>`);
  const body = dom.window.document.createElement("div"); body.innerHTML = html;
  assert.equal(body.querySelector("h2").textContent, "📖 Tutorial");
  assert.equal(body.querySelector("p").className, "notice-warning");
  assert.equal(body.querySelector("p").style.color, "rgb(145, 96, 21)");
  assert.equal(body.querySelector("p").style.fontSize, "18px");
  assert.equal(body.querySelector("p").style.position, "");
  assert.equal(body.querySelector("p").style.zIndex, "");
  assert.equal(body.querySelector("details").open, true);
  assert.equal(body.querySelector("pre code").textContent, "<script>example</script>");
  assert.equal(body.querySelector("td").textContent, "email----password");
  assert.equal(sanitize(html), html, "repeated server and preview sanitization is stable");

  const hostile = sanitize(`<script>alert(1)</script><style>body{display:none}</style><form action="https://example.invalid"><input name="token"></form>
    <iframe srcdoc="<script>alert(1)</script>"></iframe><svg onload="alert(1)"><a href="javascript:alert(1)">svg</a></svg>
    <p id="root" name="constructor" onclick="alert(1)" class="primary-button" style="background-image:url(https://example.invalid/track);font-size:999px;line-height:900">text</p>
    <a href="javascript:alert(1)">bad</a><img src="data:image/svg+xml;base64,AAAA" onerror="alert(1)">
    <a href="https://example.invalid/guide" target="_self">good</a><img src="https://example.invalid/tutorial.png">`);
  body.innerHTML = hostile;
  assert.equal(body.querySelector("script,style,form,input,iframe,svg,math"), null);
  assert.equal(body.querySelector("[onclick],[onerror],[id],[name]"), null);
  assert.equal(body.querySelector("p").getAttribute("class"), null);
  assert.equal(body.querySelector("p").getAttribute("style"), null);
  assert.equal(body.querySelector("a").hasAttribute("href"), false);
  assert.equal(body.querySelector("img").hasAttribute("src"), false);
  assert.equal(body.querySelector("a[href]").getAttribute("rel"), "noopener noreferrer");
  assert.equal(body.querySelector("a[href]").getAttribute("target"), "_blank");
  assert.equal(body.querySelector("img[src]").getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(sanitize(hostile), hostile);
  console.log("[ok] announcement HTML: tutorial markup, styles, idempotence and unsafe content filtering");
} finally { dom.window.close(); }
