import createDOMPurify from "dompurify";

export const MAX_ANNOUNCEMENT_BYTES = 100_000;

const noticeClasses = new Set([
  "notice-info", "notice-accent", "notice-success", "notice-warning", "notice-danger",
  "notice-muted", "notice-note", "notice-callout",
]);
const colorValue = /^(?:#[\da-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([\d\s.,%/+-]+\)|var\(--(?:ink|muted|green|green-soft|blue|amber|success|danger)\))$/i;
const styleRules = {
  color: (value) => colorValue.test(value),
  "background-color": (value) => colorValue.test(value),
  "font-size": (value) => {
    const size = /^(\d+(?:\.\d+)?)(px|rem|em|%)$/.exec(value);
    if (!size) return /^(?:small|medium|large|x-large|xx-large)$/.test(value);
    const number = Number(size[1]);
    return size[2] === "px" ? number >= 10 && number <= 48
      : size[2] === "%" ? number >= 75 && number <= 300 : number >= 0.75 && number <= 3;
  },
  "font-family": (value) => /^[a-z\d\u3400-\u9fff ,"'_-]{1,160}$/i.test(value),
  "font-weight": (value) => /^(?:normal|bold|[1-9]00)$/.test(value),
  "font-style": (value) => /^(?:normal|italic|oblique)$/.test(value),
  "text-align": (value) => /^(?:left|right|center|justify|start|end)$/.test(value),
  "text-decoration": (value) => /^(?:none|underline|line-through)(?: (?:underline|line-through))?$/.test(value),
  "line-height": (value) => {
    if (!/^\d+(?:\.\d+)?%?$/.test(value)) return false;
    const number = parseFloat(value) / (value.endsWith("%") ? 100 : 1);
    return number >= 1.2 && number <= 2.5;
  },
};

function safeStyle(node) {
  const values = [];
  for (const [property, accepts] of Object.entries(styleRules)) {
    const value = node.style?.getPropertyValue(property).trim();
    if (value && accepts(value)) values.push(`${property}: ${value}`);
  }
  return values.join("; ");
}

function safeUrl(window, value, protocols) {
  try { return protocols.includes(new window.URL(value).protocol); } catch { return false; }
}

// Use one policy for saved content, live previews and user-facing announcements.
export function createAnnouncementSanitizer(window) {
  const purify = createDOMPurify(window);
  purify.addHook("uponSanitizeAttribute", (node, attribute) => {
    if (attribute.attrName === "class") {
      attribute.attrValue = attribute.attrValue.split(/\s+/).filter((value) => noticeClasses.has(value)).join(" ");
      attribute.keepAttr = Boolean(attribute.attrValue);
    } else if (attribute.attrName === "style") {
      attribute.attrValue = safeStyle(node);
      attribute.keepAttr = Boolean(attribute.attrValue);
    } else if (attribute.attrName === "href") {
      attribute.keepAttr = safeUrl(window, attribute.attrValue, ["https:", "http:", "mailto:"]);
    } else if (attribute.attrName === "src") {
      attribute.keepAttr = node.nodeName === "IMG" && safeUrl(window, attribute.attrValue, ["https:", "http:"]);
    } else if (["width", "height", "colspan", "rowspan", "start"].includes(attribute.attrName)) {
      attribute.keepAttr = /^\d{1,4}$/.test(attribute.attrValue) && Number(attribute.attrValue) > 0;
    }
  });
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    if (node.nodeName === "IMG") {
      node.setAttribute("loading", "lazy");
      node.setAttribute("referrerpolicy", "no-referrer");
    }
  });
  return (html) => {
    if (!purify.isSupported) return "";
    return purify.sanitize(String(html || ""), {
      ALLOWED_TAGS: [
        "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "div", "span", "strong", "b", "em", "i",
        "u", "s", "del", "small", "mark", "sub", "sup", "a", "blockquote", "ul", "ol", "li",
        "pre", "code", "kbd", "samp", "hr", "table", "caption", "thead", "tbody", "tfoot", "tr",
        "th", "td", "colgroup", "col", "details", "summary", "img", "figure", "figcaption", "dl", "dt", "dd",
      ],
      ALLOWED_ATTR: [
        "class", "style", "href", "title", "src", "alt", "width", "height", "colspan", "rowspan",
        "scope", "open", "start", "reversed", "dir", "lang",
      ],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      RETURN_TRUSTED_TYPE: false,
    });
  };
}
