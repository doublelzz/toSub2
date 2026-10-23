const app = document.querySelector("#app");
const panel = document.querySelector("#panel");
const sceneControl = document.querySelector("#scene");
const toastElement = document.querySelector("#toast");
const iconPaths = {
  layers: '<path d="m3 8 9-5 9 5-9 5-9-5Zm0 5 9 5 9-5M3 18l9 5 9-5"/>',
  tasks: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 9 1.5 1.5L12 8m2 2h3M8 15h9"/>',
  shield: '<path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
  key: '<circle cx="8" cy="9" r="5"/><path d="m12 13 8 8m-3-3 3-3m-6 0 3-3"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5M12 17.5h5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  exit: '<path d="M10 4H5v16h5m5-12 5 4-5 4M9 12h11"/>',
  alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M15 8V4H4v11h4"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
};
const pageNames = { tasks: "账号授权", mfa: "MFA 修改", mine: "我的 CDK", sub2api: "Sub2API", cdks: "CDK 管理", security: "安全日志", blacklist: "IP 黑名单" };
let state;
let toastTimer;
let returnFocus;
let generatedCodes = [];

function icon(name, size = 17) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.tasks}</svg>`;
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function createFixtures() {
  const cdks = [
    { id: "admin", label: "TS2-ADMIN-••••-0M8A", code: "DEMO-ADMIN", note: "系统管理员", role: "admin", issued: 0, used: 0, balance: 0, status: "active", last: "14:32" },
    { id: "team", label: "TS2-••••-7K2P", code: "DEMO-USER", note: "设计团队", role: "user", issued: 100, used: 52, balance: 48, status: "active", last: "14:28" },
    { id: "ops", label: "TS2-••••-3N6R", code: "DEMO-OPS", note: "运营团队", role: "user", issued: 200, used: 18, balance: 182, status: "active", last: "14:15" },
    { id: "fresh", label: "TS2-••••-9V4H", code: "DEMO-NEW-100", note: "待分发 / 100 次", role: "user", issued: 100, used: 0, balance: 100, status: "active", last: "尚未登录" },
    { id: "spent", label: "TS2-••••-4C8F", code: "DEMO-USED-200", note: "使用后追加过次数", role: "user", issued: 201, used: 1, balance: 200, status: "active", last: "昨天 18:20" },
    { id: "disabled", label: "TS2-••••-6J3D", code: "DEMO-DISABLED", note: "暂停使用", role: "user", issued: 60, used: 0, balance: 60, status: "disabled", last: "10月21日" },
    { id: "merged", label: "TS2-••••-2B5L", code: "DEMO-MERGED", note: "已完成历史融合", role: "user", issued: 100, used: 0, balance: 0, status: "merged", last: "10月20日" },
    { id: "zero", label: "TS2-••••-8W1Q", code: "DEMO-ZERO", note: "次数已用尽", role: "user", issued: 100, used: 100, balance: 0, status: "active", last: "12:43" },
  ];
  const taskStates = ["已完成", "待输入", "已完成", "排队中", "待接码", "已完成", "失败", "已完成"];
  const tasks = taskStates.map((status, index) => ({ id: `team-task-${index + 1}`, owner: "team", email: `design-${String(index + 1).padStart(2, "0")}@example.com`, status, mfa: index < 3, created: `14:${String(20 - index * 2).padStart(2, "0")}`, credentialLabel: "设计团队的独立示例凭据" }));
  tasks.push({ id: "ops-same-email", owner: "ops", email: "design-01@example.com", status: "已完成", mfa: true, created: "13:40", credentialLabel: "运营团队的另一套示例凭据" });
  tasks.push({ id: "zero-existing", owner: "zero", email: "existing@example.com", status: "失败", mfa: true, created: "12:43", credentialLabel: "次数耗尽账号的示例凭据" });
  const ledger = cdks.filter((cdk) => cdk.role === "user").flatMap((cdk) => [
    { owner: cdk.id, type: "初始发放", delta: cdk.issued, balance: cdk.issued, note: "管理员发放导入次数", at: "10月20日 09:00" },
    ...(cdk.used ? [{ owner: cdk.id, type: "导入账号", delta: -cdk.used, balance: cdk.balance, note: `历史新增 ${cdk.used} 个账号`, at: "10月23日 14:20" }] : []),
    ...(cdk.status === "merged" ? [{ owner: cdk.id, type: "融合转出", delta: -100, balance: 0, note: "转出至另一 CDK", at: "10月20日 10:00" }] : []),
  ]);
  return {
    role: "admin", owner: "admin", page: "cdks", query: "", filter: "all", ownerFilter: "all", theme: "system", cdks, tasks, ledger, mergeCode: "", mergeCandidate: null, mergeVerifiedCode: null, mergeError: "", loginError: "", failures: 0,
    logs: [
      { id: "event-1", ip: "198.51.100.24", at: "14:26:08", count: 12, reason: "10 分钟内多次验证失败", result: "自动封禁 30 分钟", read: false, blocked: true },
      { id: "event-2", ip: "203.0.113.18", at: "14:19:42", count: 5, reason: "CDK 验证失败达到告警阈值", result: "等待处理", read: false, blocked: false },
      { id: "event-3", ip: "2001:db8::42", at: "13:52:17", count: 10, reason: "融合来源验证失败", result: "已解除临时封禁", read: true, blocked: false },
    ],
    bans: [
      { id: "ban-1", ip: "198.51.100.24", source: "自动封禁", reason: "10 分钟内验证失败达到 10 次", expiry: "今天 14:56", actor: "系统规则", active: true },
      { id: "ban-2", ip: "203.0.113.90", source: "手动拉黑", reason: "持续异常访问", expiry: "永久", actor: "系统管理员", active: true },
    ],
    configs: {}, sequence: 0,
  };
}

function currentCdk() { return state.cdks.find((cdk) => cdk.id === state.owner); }
function findCdk(id) { return state.cdks.find((cdk) => cdk.id === id); }
function isAdmin() { return state.role === "admin"; }
function nowLabel() { state.sequence += 1; return `10月23日 14:${String(33 + Math.floor(state.sequence / 60)).padStart(2, "0")}:${String(state.sequence % 60).padStart(2, "0")}`; }
function recordLedger(owner, type, delta, note) { state.ledger.push({ owner, type, delta, note, balance: findCdk(owner).balance, at: nowLabel() }); }
function empty(title, description) { return `<div class="empty"><strong>${escapeText(title)}</strong><p>${escapeText(description)}</p></div>`; }
function statusText(status) { return ({ active: "正常", disabled: "已禁用", merged: "已融合" })[status]; }
function statusView(status) { return `<span class="state ${status === "active" ? "good" : status === "disabled" ? "bad" : "muted"}">${statusText(status)}</span>`; }
function metric(label, value, suffix = "") { return `<div class="metric"><span>${label}</span><strong>${value}${suffix}</strong></div>`; }
function brand() { return `<div class="brand"><span class="brand-mark">${icon("layers", 20)}</span><span>toSub2</span></div>`; }
function heading(title, description, actions = "") { return `<header class="page-heading"><div><h1 id="page-title">${title}</h1><p>${description}</p></div><div class="button-row">${actions}</div></header>`; }
function equation(before, delta, after, labels = ["当前可用", "本次变化", "操作后可用"]) { return `<div class="equation"><div><span>${labels[0]}</span><strong>${before}</strong></div><b aria-hidden="true">${delta < 0 ? "−" : "+"}</b><div><span>${labels[1]}</span><strong>${Math.abs(delta)}</strong></div><b aria-hidden="true">=</b><div class="result"><span>${labels[2]}</span><strong>${after}</strong></div></div>`; }

function setScene(value) {
  clearTimeout(toastTimer); toastElement.hidden = true;
  if (panel.open) panel.close();
  state.query = ""; state.filter = "all"; state.ownerFilter = "all"; state.mergeCode = ""; state.mergeCandidate = null; state.mergeVerifiedCode = null; state.mergeError = "";
  if (["login", "login-error", "blocked"].includes(value)) {
    state.role = null; state.page = value; state.loginError = value === "login-error" ? "CDK 无效或不可用，请核对后重试。" : "";
  } else {
    const [role, page] = value.split("/");
    state.role = role === "admin" ? "admin" : "user"; state.owner = role === "admin" ? "admin" : role === "zero" ? "zero" : state.cdks.find((cdk) => cdk.code === "DEMO-USER").id;
    state.page = pageNames[page] ? page : state.role === "admin" ? "cdks" : "tasks";
    if (!isAdmin() && ["cdks", "security", "blacklist"].includes(state.page)) state.page = "tasks";
    if (currentCdk().status !== "active") { state.role = null; state.page = "login-error"; state.loginError = "CDK 无效或不可用，请核对后重试。"; }
  }
  render();
}

function navigate(page) {
  clearTimeout(toastTimer); toastElement.hidden = true;
  state.page = page; state.query = ""; state.filter = "all"; state.ownerFilter = "all"; render();
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : state.theme;
}

function render() {
  applyTheme();
  const scene = state.role ? `${state.owner === "zero" ? "zero" : state.role}/${state.page}` : state.page;
  sceneControl.value = [...sceneControl.options].some((option) => option.value === scene) ? scene : `${state.role}/tasks`;
  document.title = `${pageNames[state.page] || "CDK 登录"}设计预览 — toSub2`;
  if (!state.role) { app.innerHTML = state.page === "blocked" ? blockedPage() : loginPage(); return; }
  const cdk = currentCdk();
  const navEntries = [["tasks", "tasks"], ["mfa", "shield"], ["mine", "key"], ["sub2api", "server"]];
  const management = isAdmin() ? `<div class="nav-divider"></div>${navButton("cdks", "key")}${navButton("security", "shield", ["security", "blacklist"].includes(state.page))}` : "";
  const content = ({ cdks: cdkPage, tasks: taskPage, mfa: taskPage, mine: myPage, sub2api: sub2apiPage, security: securityPage, blacklist: securityPage })[state.page]();
  app.innerHTML = `<div class="shell"><aside class="sidebar">${brand()}<nav class="nav" aria-label="工作区">${navEntries.map(([page, glyph]) => navButton(page, glyph)).join("")}${management}</nav><div class="sidebar-foot"><strong>${isAdmin() ? "管理员工作区" : "独立账号工作区"}</strong><p>${isAdmin() ? "管理 CDK、次数与访问安全" : "只显示当前 CDK 的账号"}</p></div></aside><div class="content"><header class="topbar"><div class="breadcrumb"><span>工作区</span>${icon("chevron", 12)}<strong>${pageNames[state.page]}</strong></div><div class="top-actions"><button class="identity-button" data-action="mine" aria-label="查看当前 CDK"><span>${escapeText(cdk.label)}</span><strong>${isAdmin() ? "管理员" : `剩余 ${cdk.balance} 次`}</strong></button><select class="theme-select" id="theme" aria-label="外观主题">${[["system", "跟随系统"], ["light", "浅色"], ["dark", "深色"]].map(([value, label]) => `<option value="${value}" ${state.theme === value ? "selected" : ""}>${label}</option>`).join("")}</select><button class="icon-button" data-action="logout" aria-label="退出登录">${icon("exit")}</button></div></header><main class="main" id="main" tabindex="-1">${content}</main></div></div>`;
  const tabs = app.querySelector('[role="tablist"]');
  if (tabs) {
    const results = app.querySelector(".list-frame"); results.id = "security-results"; results.setAttribute("role", "tabpanel"); results.setAttribute("aria-label", pageNames[state.page]);
    tabs.querySelectorAll('[role="tab"]').forEach((tab) => { tab.setAttribute("aria-controls", "security-results"); tab.tabIndex = tab.getAttribute("aria-selected") === "true" ? 0 : -1; });
  }
}

function navButton(page, glyph, selected = state.page === page) { return `<button type="button" data-action="nav" data-page="${page}" ${selected ? 'aria-current="page"' : ""}>${icon(glyph)}${page === "security" ? "安全中心" : pageNames[page]}</button>`; }

function filters(placeholder, options, extra = "") {
  return `<form class="filters" data-form="filter"><label class="search">${icon("search", 16)}<input name="query" type="search" aria-label="搜索" placeholder="${placeholder}" value="${escapeText(state.query)}"></label><select name="filter" aria-label="状态筛选">${options.map(([value, label]) => `<option value="${value}" ${state.filter === value ? "selected" : ""}>${label}</option>`).join("")}</select>${extra}<button class="secondary" type="submit">筛选</button></form>`;
}

function cdkPage() {
  const ordinary = state.cdks.filter((cdk) => cdk.role !== "admin");
  const rows = state.cdks.filter((cdk) => `${cdk.label} ${cdk.note}`.toLowerCase().includes(state.query.toLowerCase()) && (state.filter === "all" || state.filter === "fresh" ? state.filter !== "fresh" || (cdk.used === 0 && cdk.role !== "admin" && cdk.status === "active") : cdk.status === state.filter));
  const pending = state.logs.filter((log) => !log.read).length;
  return `${heading("CDK 管理", "分发导入次数，查看每张 CDK 的实际使用情况。", `<button class="secondary" data-action="all-ledger">使用流水</button><button class="primary" data-action="generate">${icon("plus", 16)}生成 CDK</button>`)}<div class="metrics">${metric("普通 CDK", ordinary.length)}${metric("可用 CDK", ordinary.filter((cdk) => cdk.status === "active").length)}${metric("累计导入消耗", ordinary.reduce((total, cdk) => total + cdk.used, 0))}${metric("可用余额合计", ordinary.filter((cdk) => cdk.status === "active").reduce((total, cdk) => total + cdk.balance, 0))}<p class="metric-note">按 CDK 分别计次<br>内部操作和账号流转不重复扣次</p></div>${pending ? `<div class="notice warning">${icon("alert", 17)}<p>有 ${pending} 条异常访问待处理。查看来源 IP、验证失败次数和封禁状态。</p><button class="text-button" data-action="nav" data-page="security">查看安全日志</button></div>` : ""}${filters("搜索 CDK 标识或备注", [["all", "全部状态"], ["active", "正常"], ["fresh", "从未消耗"], ["disabled", "已禁用"], ["merged", "已融合"]])}<section class="list-frame" aria-label="CDK 列表"><div class="list-title"><strong>全部 CDK <span>${rows.length}</span></strong><span>完整 CDK 仅在生成时显示一次</span></div>${rows.length ? `<table class="cdk-table"><thead><tr><th>CDK</th><th class="mobile-hide">备注</th><th class="num mobile-hide">已用次数</th><th class="num">可用次数</th><th class="mobile-hide">状态</th><th class="secondary-col mobile-hide">最近登录</th><th>操作</th></tr></thead><tbody>${rows.map((cdk) => `<tr><td><div class="cell-stack"><strong class="code">${escapeText(cdk.label)}</strong><small>${cdk.role === "admin" ? "管理员" : escapeText(cdk.note)}${cdk.status !== "active" ? ` / ${statusText(cdk.status)}` : ""}</small></div></td><td class="mobile-hide">${escapeText(cdk.note)}</td><td class="num mobile-hide">${cdk.role === "admin" ? "—" : cdk.used}</td><td class="num">${cdk.role === "admin" ? "不限" : cdk.balance}</td><td class="mobile-hide">${statusView(cdk.status)}</td><td class="secondary-col mobile-hide muted">${cdk.last}</td><td><div class="row-actions"><button class="text-button" data-action="cdk-detail" data-id="${cdk.id}">详情</button>${cdk.role === "user" && cdk.status !== "merged" ? `<button class="text-button" data-action="topup" data-id="${cdk.id}">追加</button>` : ""}</div></td></tr>`).join("")}</tbody></table>` : empty("没有匹配的 CDK", "调整标识、备注或状态筛选后重试。 ")}<footer class="list-footer"><span>共 ${rows.length} 张 CDK</span><span>用量记录与任务结果分开统计</span></footer></section>`;
}

function taskPage() {
  const mfa = state.page === "mfa";
  const scoped = state.tasks.filter((task) => (isAdmin() ? state.ownerFilter === "all" || task.owner === state.ownerFilter : task.owner === state.owner) && (!mfa || task.mfa));
  const rows = scoped.filter((task) => task.email.includes(state.query.toLowerCase()) && (state.filter === "all" || task.status === state.filter));
  const ownerSelect = isAdmin() ? `<select name="owner" aria-label="所属 CDK"><option value="all">全部 CDK</option>${state.cdks.filter((cdk) => cdk.role === "user").map((cdk) => `<option value="${cdk.id}" ${state.ownerFilter === cdk.id ? "selected" : ""}>${escapeText(cdk.note)}</option>`).join("")}</select>` : "";
  const cdk = currentCdk();
  return `${heading(mfa ? "MFA 修改" : "账号授权", isAdmin() ? "按所属 CDK 分别查看账号；同邮箱的不同归属独立保存。" : "查看和操作当前 CDK 的账号，已有账号流转不消耗次数。", `<button class="secondary" data-action="stop-own">停止${isAdmin() ? "全部" : "我的"}任务</button><button class="primary" data-action="import">${icon("plus", 16)}导入账号</button>`)}${!isAdmin() && cdk.balance === 0 ? `<div class="notice warning">${icon("alert")}<p>导入次数已用尽。已有账号仍可操作和更新；新增账号前请追加或融合次数。</p><button class="text-button" data-action="mine">查看我的 CDK</button></div>` : ""}<div class="metrics">${metric("当前保存账号", scoped.length)}${metric("已完成", scoped.filter((task) => task.status === "已完成").length)}${metric("需要处理", scoped.filter((task) => ["失败", "待输入", "待接码"].includes(task.status)).length)}${!isAdmin() ? metric("可用导入次数", cdk.balance) : ""}</div>${filters("搜索邮箱", [["all", "全部状态"], ["已完成", "已完成"], ["待输入", "待输入"], ["待接码", "待接码"], ["失败", "失败"], ["排队中", "排队中"]], ownerSelect)}<section class="list-frame"><div class="list-title"><strong>${mfa ? "MFA 账号" : "账号列表"} <span>${rows.length}</span></strong><span>${isAdmin() ? "显示所属 CDK" : "仅当前 CDK"}</span></div>${rows.length ? `<table class="task-table"><thead><tr><th>账号</th><th>状态</th><th class="mobile-hide">${isAdmin() ? "所属 CDK" : "接码与额度"}</th><th class="secondary-col mobile-hide">创建时间</th><th>操作</th></tr></thead><tbody>${rows.map((task) => `<tr><td><div class="cell-stack"><strong>${escapeText(task.email)}</strong><small>${isAdmin() ? escapeText(findCdk(task.owner).note) : task.mfa ? "已关联 MFA 工作区" : "邮箱登录"}</small></div></td><td><span class="state ${task.status === "已完成" ? "good" : task.status === "失败" ? "bad" : task.status === "排队中" ? "muted" : "warn"}">${task.status}</span></td><td class="mobile-hide">${isAdmin() ? escapeText(findCdk(task.owner).label) : task.status === "已完成" ? "额度已检测" : "等待处理"}</td><td class="secondary-col mobile-hide muted">今天 ${task.created}</td><td><button class="text-button" data-action="task-detail" data-id="${task.id}">详情</button></td></tr>`).join("")}</tbody></table>` : empty("没有匹配的账号", "调整筛选，或导入当前 CDK 的账号。 ")}<footer class="list-footer"><span>匹配 ${rows.length} 个账号</span><span>首次新增计次，后续操作不重复扣次</span></footer></section>`;
}

function ledgerTable(owner = null) {
  const rows = [...state.ledger].filter((entry) => !owner || entry.owner === owner).reverse();
  return rows.length ? `<div class="list-frame"><table><thead><tr><th>事项</th><th class="num">变化</th><th class="num">余额</th><th class="mobile-hide">时间</th></tr></thead><tbody>${rows.slice(0, 15).map((entry) => `<tr><td><div class="cell-stack"><strong>${entry.type}</strong><small>${escapeText(owner ? entry.note : findCdk(entry.owner).note)}</small></div></td><td class="num ${entry.delta > 0 ? "good-text" : ""}">${entry.delta > 0 ? "+" : ""}${entry.delta}</td><td class="num">${entry.balance}</td><td class="mobile-hide muted">${entry.at}</td></tr>`).join("")}</tbody></table></div>` : empty("还没有次数流水", "发生发放、导入或融合后显示在这里。 ");
}

function myPage() {
  const cdk = currentCdk();
  if (isAdmin()) return `${heading("我的 CDK", "管理员身份拥有全量管理权限，导入不限制次数。", `<button class="primary" data-action="nav" data-page="cdks">管理普通 CDK</button>`)}<div class="notice">${icon("key")}<p>${escapeText(cdk.label)}，管理员 CDK 不参与次数融合。</p></div>${ledgerTable("admin")}`;
  const source = findCdk(state.mergeCandidate);
  return `${heading("我的 CDK", "查看导入次数和使用记录，融合另一张从未消耗次数的 CDK。 ")}<div class="profile-layout"><div><section class="account-summary"><div><span class="muted">可用导入次数</span><div class="balance-value"><strong>${cdk.balance}</strong><span>次</span></div><p class="helper code">${escapeText(cdk.label)}</p></div><dl><div><dt>累计导入消耗</dt><dd>${cdk.used} 次</dd></div><div><dt>当前保存账号</dt><dd>${state.tasks.filter((task) => task.owner === cdk.id).length} 个</dd></div><div><dt>状态</dt><dd>${statusView(cdk.status)}</dd></div></dl></section><section class="plain-section"><h2>次数流水</h2><p>新增账号成功入库时计次，已有账号的操作不重复扣次。</p>${ledgerTable(cdk.id)}</section></div><section class="merge-section"><h2>融合另一张 CDK</h2><p>转入对方全部剩余次数。来源 CDK 必须从未消耗过次数，融合后将永久失效。</p><form data-form="merge-check"><label class="field">另一张 CDK<input name="sourceCode" type="password" placeholder="输入准备融合的 CDK" autocomplete="off" value="${escapeText(state.mergeCode)}" required></label><div class="button-row"><button type="submit" class="secondary">验证融合资格</button></div></form>${state.mergeError ? `<div class="inline-result error" role="alert">${escapeText(state.mergeError)}</div>` : ""}${source ? `<div class="inline-result"><span class="state good">可以融合</span><p class="helper code">${escapeText(source.label)}</p></div>${equation(cdk.balance, source.balance, cdk.balance + source.balance, ["当前可用", "将转入", "融合后可用"])}<button class="primary" data-action="merge-confirm">融合 ${source.balance} 次</button>` : ""}<p class="helper setting-note">登录和保存配置不影响融合资格。曾发生过导入扣次的 CDK，追加次数后仍不可作为来源。</p></section></div>`;
}

function sub2apiPage() {
  const config = state.configs[state.owner] || { baseUrl: "", key: "", group: "", monitor: false };
  return `${heading("Sub2API", "保存当前 CDK 自己的服务配置，上传与自动修复分别控制。 ")}<div class="setting-layout"><form class="settings-form" data-form="sub2api"><section class="plain-section"><h2>连接与上传</h2><p class="helper">这些配置只用于当前 CDK 下的账号。</p><label class="field">服务地址<input type="url" name="baseUrl" placeholder="https://sub2api.example.invalid" value="${escapeText(config.baseUrl)}" required></label><label class="field">API Key<input type="password" name="apiKey" placeholder="填写当前服务的 API Key" value="${escapeText(config.key)}" autocomplete="off" required></label><label class="field">目标分组<input name="group" placeholder="填写分组 ID" value="${escapeText(config.group)}"><small>上传时只使用当前 CDK 配置的目标分组。</small></label></section><section class="plain-section"><h2>自动修复异常账号</h2><label class="switch-row"><span>启用自动修复<p>定时检查已关联的远端账号，使用当前 CDK 的本地资料重新授权并回写。</p></span><input type="checkbox" class="switch" role="switch" name="monitor" aria-label="启用自动修复" ${config.monitor ? "checked" : ""}></label><div class="form-grid" id="monitor-options" ${config.monitor ? "" : "hidden"}><label class="field">检查间隔（分钟）<input name="interval" type="number" min="5" value="${config.interval || 5}"></label><label class="field">失败冷却（分钟）<input name="cooldown" type="number" min="5" value="${config.cooldown || 5}"></label></div><p class="helper setting-note">只处理当前 CDK 已上传或明确绑定的远端账号。已有账号自动修复不消耗次数。</p></section><div class="button-row"><button class="primary" type="submit">保存配置</button><button class="secondary" data-action="test-connection" type="button">测试连接</button><span class="helper">${config.baseUrl ? "已保存当前 CDK 的配置" : "尚未配置"}</span></div></form><aside><h3>上传与自动修复有什么区别？</h3><p>上传由你主动发起，将选中的授权结果发送到目标服务。</p><p class="setting-note">自动修复在后台检查异常账号。只有保存的登录资料齐全、无需人工输入时，才尝试恢复并更新远端授权。</p><p class="setting-note">默认关闭。其他 CDK 的地址、API Key 和任务不会用于当前工作区。</p></aside></div>`;
}

function securityPage() {
  const blacklist = state.page === "blacklist";
  const rows = blacklist ? state.bans.filter((ban) => ban.active && ban.ip.includes(state.query) && (state.filter === "all" || ban.source === state.filter)) : state.logs.filter((log) => log.ip.includes(state.query) && (state.filter === "all" || state.filter === "unread" ? state.filter !== "unread" || !log.read : log.blocked));
  return `${heading("安全中心", "查看异常 CDK 验证，管理访问本系统的客户端 IP。", `<button class="primary" data-action="ban-new">${icon("plus", 16)}拉黑 IP</button>`)}<div class="tabs" role="tablist" aria-label="安全中心"><button role="tab" aria-selected="${!blacklist}" data-action="nav" data-page="security">安全日志${state.logs.some((log) => !log.read) ? ` (${state.logs.filter((log) => !log.read).length})` : ""}</button><button role="tab" aria-selected="${blacklist}" data-action="nav" data-page="blacklist">IP 黑名单 (${state.bans.filter((ban) => ban.active).length})</button></div><div class="notice">${icon("shield", 17)}<p>同 IP 10 分钟失败 5 次告警，10 次自动封禁 30 分钟；24 小时内触发 3 次则封禁 24 小时。</p><button class="text-button" data-action="security-rules">查看规则</button></div>${filters("搜索来源 IP", blacklist ? [["all", "全部来源"], ["自动封禁", "自动封禁"], ["手动拉黑", "手动拉黑"]] : [["all", "全部事件"], ["unread", "待处理"], ["blocked", "已封禁"]])}<section class="list-frame"><div class="list-title"><strong>${blacklist ? "生效中的 IP 黑名单" : "CDK 验证事件"}</strong><span>${blacklist ? "临时封禁和永久封禁" : "同来源事件聚合显示"}</span></div>${rows.length ? `<table class="security-table"><thead><tr><th class="mobile-hide">${blacklist ? "来源" : "时间"}</th><th>客户端 IP</th><th>${blacklist ? "原因" : "事件"}</th><th class="mobile-hide">${blacklist ? "到期时间" : "失败次数"}</th><th class="mobile-hide">${blacklist ? "操作人" : "处理结果"}</th><th>操作</th></tr></thead><tbody>${rows.map((row) => blacklist ? `<tr><td class="mobile-hide">${row.source}</td><td><div class="cell-stack"><strong class="code">${escapeText(row.ip)}</strong><small>${row.expiry === "永久" ? "永久封禁" : `${row.expiry} 到期`}</small></div></td><td>${escapeText(row.reason)}</td><td class="mobile-hide">${row.expiry}</td><td class="mobile-hide muted">${row.actor}</td><td><button class="text-button" data-action="unban" data-id="${row.id}">解除</button></td></tr>` : `<tr><td class="mobile-hide muted">今天 ${row.at}</td><td><div class="cell-stack"><strong class="code">${row.ip}</strong><small>${row.read ? "已处理" : "待处理"}</small></div></td><td><div class="cell-stack"><strong>${row.reason}</strong><small>${row.count} 次验证失败</small></div></td><td class="num mobile-hide">${row.count}</td><td class="mobile-hide"><span class="${row.blocked ? "bad-text" : "muted"}">${row.result}</span></td><td><div class="row-actions"><button class="text-button" data-action="event-detail" data-id="${row.id}">详情</button>${!row.blocked ? `<button class="text-button danger" data-action="ban-event" data-id="${row.id}">拉黑</button>` : ""}</div></td></tr>`).join("")}</tbody></table>` : empty(blacklist ? "没有生效中的黑名单" : "没有匹配的验证事件", "调整筛选条件，或等待新的记录。 ")}<footer class="list-footer"><span>${rows.length} 条记录</span><span>日志不记录完整 CDK 和账号凭据</span></footer></section>`;
}

function loginPage() {
  return `<main class="login-wrap" id="main"><div class="login-layout"><section class="login-intro">${brand()}<h1>用 CDK 进入<br>你的账号工作台</h1><p>导入、授权和管理自己的账号。次数只在新增账号成功入库时消耗。</p><div class="access-rules"><div><span>新增一个账号</span><small>消耗 1 次</small></div><div><span>已有账号的后续操作</span><small>不重复扣次</small></div><div><span>任务、凭据与结果</span><small>按 CDK 独立保存</small></div></div></section><form class="login-form" data-form="login"><h2>验证 CDK</h2><p>使用管理员分发的 CDK 登录。</p><label class="field">CDK<input name="cdk" type="password" placeholder="输入完整 CDK" autocomplete="off" required aria-invalid="${Boolean(state.loginError)}" aria-describedby="login-feedback"></label><div id="login-feedback" ${state.loginError ? 'class="inline-result error" role="alert"' : "hidden"}>${escapeText(state.loginError)}</div><button class="primary" type="submit">验证并进入${icon("chevron", 15)}</button><div class="login-foot">CDK 无效或已失效时，请联系分发管理员。<br>退出登录不会停止已经开始的账号任务。</div></form></div></main>`;
}

function blockedPage() {
  return `<main class="login-wrap" id="main"><section class="blocked-layout">${brand()}<div class="notice error">${icon("lock")}<p>当前 IP 暂时无法访问</p></div><h1>验证失败次数过多</h1><p>当前来源已被临时封禁。请在封禁结束后重新访问，或联系管理员核查。</p><div class="blocked-detail"><div><span class="muted">客户端 IP</span><span class="code">198.51.100.77</span></div><div><span class="muted">封禁时长</span><span>30 分钟</span></div><div><span class="muted">可恢复时间</span><span>2026年10月23日 15:03</span></div></div><p class="helper">管理员可以在安全中心查看相关验证事件并解除封禁。</p><button class="secondary" data-action="blocked-recheck">检查访问状态</button></section></main>`;
}

function toast(message) {
  clearTimeout(toastTimer); toastElement.textContent = message; toastElement.hidden = false;
  toastTimer = setTimeout(() => { toastElement.hidden = true; }, 4800);
}

function openPanel(title, body, modal = false) {
  returnFocus = panel.open ? returnFocus : document.activeElement;
  panel.className = modal ? "modal" : "drawer";
  panel.innerHTML = `<header class="panel-header"><h2 id="panel-title">${title}</h2><button type="button" class="icon-button" data-action="close-panel" aria-label="关闭">${icon("close", 19)}</button></header><div class="panel-body">${body}</div>`;
  if (!panel.open) panel.showModal();
  requestAnimationFrame(() => panel.querySelector("input:not([type=hidden]), textarea, button")?.focus());
}

function cdkDetail(id) {
  const cdk = findCdk(id);
  openPanel("CDK 详情", `<p class="helper code">${escapeText(cdk.label)}</p><dl class="detail-list"><div><dt>备注</dt><dd>${escapeText(cdk.note)}</dd></div><div><dt>状态</dt><dd>${statusView(cdk.status)}</dd></div><div><dt>累计导入消耗</dt><dd>${cdk.role === "admin" ? "不限次数" : `${cdk.used} 次`}</dd></div><div><dt>当前可用次数</dt><dd>${cdk.role === "admin" ? "不限次数" : `${cdk.balance} 次`}</dd></div><div><dt>当前保存账号</dt><dd>${state.tasks.filter((task) => task.owner === id).length} 个</dd></div><div><dt>可作为融合来源</dt><dd>${cdk.role === "user" && cdk.used === 0 && cdk.status === "active" && cdk.balance > 0 ? "可以，从未消耗次数" : "不符合条件"}</dd></div></dl><h3>次数流水</h3>${ledgerTable(id)}<div class="panel-footer">${cdk.role === "user" && cdk.status !== "merged" ? `<button class="secondary" data-action="toggle-cdk" data-id="${id}">${cdk.status === "active" ? "禁用 CDK" : "启用 CDK"}</button><button class="primary" data-action="topup" data-id="${id}">追加次数</button>` : `<button class="secondary" data-action="close-panel">关闭</button>`}</div>`);
}

function openTopup(id) {
  const cdk = findCdk(id);
  if (cdk.role !== "user" || cdk.status === "merged") return;
  openPanel("追加导入次数", `<p class="helper">${escapeText(cdk.label)} / ${escapeText(cdk.note)}</p><form data-form="topup" data-id="${id}"><label class="field">追加次数<input name="amount" type="number" min="1" max="1000000" step="1" value="100" required></label><label class="field">追加备注<input name="note" placeholder="填写本次追加的用途" maxlength="100" required></label><div id="topup-equation">${equation(cdk.balance, 100, cdk.balance + 100)}</div><div class="panel-footer"><button class="secondary" type="button" data-action="close-panel">取消</button><button class="primary" type="submit">确认追加</button></div></form>`, true);
}

function openImport() {
  const cdk = currentCdk();
  const sample = state.owner === "zero" ? "existing@example.com\nnew-account@example.com" : "design-09@example.com\ndesign-01@example.com\ndesign-09@example.com";
  openPanel("导入账号", `<p class="helper">每行一个账号，支持现有账号资料格式。先核对新增和更新数量，再确认导入。</p><form data-form="import"><label class="field">账号内容<textarea name="accounts" spellcheck="false" required>${sample}</textarea></label><div id="import-preview"></div><div class="panel-footer"><span class="helper">${cdk.role === "admin" ? "管理员导入不限次数" : "仅新增账号计次"}</span><button class="secondary" type="button" data-action="close-panel">取消</button><button class="primary" id="confirm-import" type="submit">确认导入</button></div></form>`);
  updateImportPreview();
}

function analyzeImport(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const parsed = lines.map((line) => line.split(/----|\t|\|/)[0].trim().toLowerCase());
  const invalid = parsed.filter((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)).length;
  const unique = [...new Set(parsed)];
  const existing = unique.filter((email) => state.tasks.some((task) => task.owner === state.owner && task.email === email));
  return { lines: lines.length, emails: unique, existing, added: unique.length - existing.length, invalid, duplicates: lines.length - unique.length };
}

function updateImportPreview() {
  const form = panel.querySelector('[data-form="import"]'); if (!form) return;
  const report = analyzeImport(form.elements.accounts.value);
  const cdk = currentCdk(); const debit = isAdmin() ? 0 : report.added;
  panel.querySelector("#import-preview").innerHTML = `<div class="inline-result">${report.lines} 行，去重后 ${report.emails.length} 个账号；新增 <strong>${report.added}</strong> 个，更新 <strong>${report.existing.length}</strong> 个${report.duplicates ? `，重复 ${report.duplicates} 行` : ""}。</div>${isAdmin() ? "" : equation(cdk.balance, -debit, cdk.balance - debit, ["当前可用", "预计扣次", "导入后可用"])}${report.invalid ? `<div class="inline-result error" role="alert">${report.invalid} 行邮箱格式不正确，请修正后再导入。</div>` : debit > cdk.balance ? '<div class="inline-result error" role="alert">可用次数不足。请减少新增账号，或先追加、融合次数。</div>' : ""}`;
  panel.querySelector("#confirm-import").disabled = report.lines === 0 || report.invalid > 0 || (!isAdmin() && debit > cdk.balance);
}

function taskDetail(id) {
  const task = state.tasks.find((entry) => entry.id === id);
  if (!task || (!isAdmin() && task.owner !== state.owner)) return;
  openPanel("账号详情", `<p class="helper">${escapeText(task.email)}</p><dl class="detail-list"><div><dt>所属 CDK</dt><dd>${escapeText(findCdk(task.owner).note)}</dd></div><div><dt>状态</dt><dd>${task.status}</dd></div><div><dt>账号资料</dt><dd>${task.credentialLabel}</dd></div><div><dt>MFA 工作区</dt><dd>${task.mfa ? "已关联" : "尚未关联"}</dd></div></dl><p class="helper setting-note">继续操作此账号不消耗导入次数。</p><div class="panel-footer"><button class="secondary" data-action="retry-task" data-id="${id}">重新授权</button><button class="primary" data-action="move-mfa" data-id="${id}">转到 MFA 修改</button></div>`);
}

function mergeEligibility(code) {
  const source = state.cdks.find((cdk) => cdk.code === code);
  if (!source || source.status !== "active") return { error: "CDK 无效或不可用，请核对后重试。" };
  if (source.id === state.owner) return { error: "不能将当前 CDK 融合到自己。" };
  if (source.role === "admin") return { error: "管理员 CDK 不参与次数融合。" };
  if (source.used > 0) return { error: "此 CDK 曾消耗过次数，无法融合。追加次数不会恢复融合资格。" };
  if (source.balance <= 0) return { error: "来源 CDK 没有可融合的剩余次数。" };
  return { source };
}

function openBan(ip = "") {
  openPanel("拉黑客户端 IP", `<p class="helper">封禁该 IP 对本系统的访问，包含登录和已登录请求。账号任务使用的出站代理不受此设置影响。</p><form data-form="ban"><label class="field">客户端 IP<input name="ip" value="${escapeText(ip)}" placeholder="例如 203.0.113.18" required></label><label class="field">封禁时长<select name="duration"><option value="30">30 分钟</option><option value="1440">24 小时</option><option value="permanent">永久</option></select></label><label class="field">处理原因<input name="reason" placeholder="填写拉黑原因" maxlength="120" required></label><div id="ban-error" class="inline-result error" role="alert" hidden></div><div class="panel-footer"><button class="secondary" type="button" data-action="close-panel">取消</button><button class="danger-button" type="submit">确认拉黑</button></div></form>`, true);
}

function normalizeIp(value) {
  const input = value.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(input) && input.split(".").every((part) => Number(part) <= 255)) return input.split(".").map(Number).join(".");
  try { if (input.includes(":")) return new URL(`http://[${input}]/`).hostname.slice(1, -1).toLowerCase(); } catch {}
  return null;
}

function recordFailure(entryPoint) {
  state.failures += 1;
  let event = state.logs.find((log) => log.ip === "198.51.100.77");
  if (!event) { event = { id: "event-live", ip: "198.51.100.77", at: "14:33:00", count: 0, reason: `${entryPoint}验证失败`, result: "未达到告警阈值", read: true, blocked: false }; state.logs.unshift(event); }
  event.count = state.failures;
  if (state.failures >= 5) { event.read = false; event.result = "等待处理"; }
  if (state.failures >= 10) {
    event.blocked = true; event.result = "自动封禁 30 分钟";
    if (!state.bans.some((ban) => ban.ip === event.ip && ban.active)) state.bans.push({ id: "ban-live", ip: event.ip, source: "自动封禁", reason: "10 分钟内验证失败达到 10 次", expiry: "今天 15:03", actor: "系统规则", active: true });
    state.role = null; state.page = "blocked";
  }
}

document.addEventListener("click", async (event) => {
  const control = event.target.closest("[data-action]"); if (!control || control.disabled) return;
  const action = control.dataset.action; const id = control.dataset.id;
  if (action === "nav") navigate(control.dataset.page);
  if (action === "mine") navigate("mine");
  if (action === "logout") { state.role = null; state.page = "login"; state.loginError = ""; state.mergeCode = ""; state.mergeCandidate = null; state.mergeVerifiedCode = null; render(); }
  if (action === "close-panel") panel.close();
  if (action === "cdk-detail") cdkDetail(id);
  if (action === "topup") openTopup(id);
  if (action === "all-ledger") openPanel("全部使用流水", `<p class="helper">按每次发放、导入扣次及融合记录查看，不以任务成功数代替消耗次数。</p>${ledgerTable()}`);
  if (action === "generate") openPanel("生成 CDK", `<p class="helper">新生成的完整 CDK 只展示一次，请在关闭结果前复制或下载。</p><form data-form="generate"><div class="form-grid"><label class="field">生成数量<input name="count" type="number" min="1" max="50" value="2" required></label><label class="field">每张初始次数<input name="quota" type="number" min="1" max="1000000" value="100" required></label></div><label class="field">批次备注<input name="note" placeholder="例如：10月新用户" maxlength="80" required></label><div class="panel-footer"><button class="secondary" type="button" data-action="close-panel">取消</button><button class="primary" type="submit">生成并显示 CDK</button></div></form>`);
  if (action === "toggle-cdk") {
    const cdk = findCdk(id); const disable = cdk.status === "active";
    openPanel(disable ? "禁用这张 CDK？" : "重新启用 CDK？", `<p>${disable ? "已有登录会话将失效，禁止新操作。正在执行的任务将在安全节点暂停，已扣次数保留。" : "启用后可以重新登录，并继续操作原有账号。"}</p><div class="panel-footer"><button class="secondary" data-action="close-panel">取消</button><button class="${disable ? "danger-button" : "primary"}" data-action="confirm-toggle" data-id="${id}">${disable ? "确认禁用" : "确认启用"}</button></div>`, true);
  }
  if (action === "confirm-toggle") { const cdk = findCdk(id); cdk.status = cdk.status === "active" ? "disabled" : "active"; panel.close(); render(); toast(`CDK ${statusText(cdk.status)}`); }
  if (action === "copy-generated") {
    try { await navigator.clipboard.writeText(generatedCodes.join("\n")); toast("已复制本次生成的示例 CDK"); } catch { const range = document.createRange(); range.selectNodeContents(panel.querySelector("#generated-results")); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); toast("请复制已选中的 CDK 内容"); }
  }
  if (action === "download-generated") {
    const url = URL.createObjectURL(new Blob([generatedCodes.join("\r\n")], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "cdk-design-demo.txt"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (action === "import") openImport();
  if (action === "task-detail") taskDetail(id);
  if (action === "retry-task") { const task = state.tasks.find((item) => item.id === id); task.status = "排队中"; panel.close(); render(); toast("已加入重新授权队列，未扣次数"); }
  if (action === "move-mfa") { const task = state.tasks.find((item) => item.id === id); task.mfa = true; panel.close(); navigate("mfa"); toast("已关联到 MFA 工作区，未扣次数"); }
  if (action === "stop-own") { state.tasks.filter((task) => (isAdmin() || task.owner === state.owner) && task.status === "排队中").forEach((task) => { task.status = "已取消"; }); render(); toast(isAdmin() ? "已停止示例队列中的任务" : "已停止当前 CDK 的排队任务，其他 CDK 未受影响"); }
  if (action === "merge-confirm") {
    const displayedCode = document.querySelector('[name="sourceCode"]').value.trim();
    const eligibility = mergeEligibility(displayedCode);
    if (!state.mergeCandidate || state.mergeVerifiedCode !== displayedCode || state.mergeCode !== displayedCode || eligibility.source?.id !== state.mergeCandidate) {
      state.mergeCode = displayedCode; state.mergeError = "来源 CDK 已变化，请重新验证融合资格。"; state.mergeCandidate = null; state.mergeVerifiedCode = null; render(); return;
    }
    if (eligibility.error) { state.mergeError = eligibility.error; state.mergeCandidate = null; state.mergeVerifiedCode = null; render(); return; }
    const source = eligibility.source;
    openPanel("确认融合次数", `<p>将 ${escapeText(source.label)} 的全部剩余次数转入当前 CDK。</p>${equation(currentCdk().balance, source.balance, currentCdk().balance + source.balance, ["当前可用", "将转入", "融合后可用"])}<form data-form="merge" data-source="${source.id}" data-target="${state.owner}"><label class="check-label"><input name="acknowledge" type="checkbox" required><span>我已知晓：来源 CDK 将永久失效，融合完成后不能撤回。</span></label><div class="panel-footer"><button class="secondary" type="button" data-action="close-panel">取消</button><button class="primary" type="submit">确认融合 ${source.balance} 次</button></div></form>`, true);
  }
  if (action === "test-connection") { const form = control.closest("form"); if (!form.reportValidity()) return; toast("示例连接成功；原型未发起外部请求"); }
  if (action === "ban-new") openBan();
  if (action === "ban-event") openBan(state.logs.find((log) => log.id === id).ip);
  if (action === "event-detail") {
    const log = state.logs.find((item) => item.id === id);
    openPanel("验证事件详情", `<dl class="detail-list"><div><dt>客户端 IP</dt><dd class="code">${log.ip}</dd></div><div><dt>失败次数</dt><dd>${log.count} 次</dd></div><div><dt>触发事件</dt><dd>${log.reason}</dd></div><div><dt>当前结果</dt><dd>${log.result}</dd></div></dl><p class="helper setting-note">保留不可逆的尝试指纹，不记录完整 CDK、Cookie 和账号凭据。</p><div class="panel-footer"><button class="secondary" data-action="read-event" data-id="${id}">标记已处理</button>${!log.blocked ? `<button class="danger-button" data-action="ban-event" data-id="${id}">拉黑该 IP</button>` : ""}</div>`);
  }
  if (action === "read-event") { state.logs.find((log) => log.id === id).read = true; panel.close(); render(); toast("事件已标记为已处理"); }
  if (action === "unban") { const ban = state.bans.find((item) => item.id === id); openPanel("解除 IP 封禁？", `<p>解除 ${escapeText(ban.ip)} 的封禁后，该来源可以重新访问。已有处理记录仍会保留。</p><div class="panel-footer"><button class="secondary" data-action="close-panel">取消</button><button class="primary" data-action="confirm-unban" data-id="${id}">确认解除</button></div>`, true); }
  if (action === "confirm-unban") { const ban = state.bans.find((item) => item.id === id); ban.active = false; state.logs.filter((log) => log.ip === ban.ip).forEach((log) => { log.blocked = false; log.read = true; log.result = "管理员已解除封禁"; }); panel.close(); render(); toast("已解除封禁，处理记录已保留"); }
  if (action === "security-rules") openPanel("访问保护规则", `<dl class="detail-list"><div><dt>告警</dt><dd>同 IP 10 分钟失败 5 次</dd></div><div><dt>自动封禁</dt><dd>10 分钟失败 10 次，封禁 30 分钟</dd></div><div><dt>重复触发</dt><dd>24 小时触发 3 次，封禁 24 小时</dd></div><div><dt>覆盖入口</dt><dd>登录与融合来源验证</dd></div><div><dt>客户端 IP</dt><dd>只接受指定可信代理转发</dd></div></dl><p class="helper setting-note">生产设置由管理员调整，并保留变更审计。安全日志保留 30 天，封禁记录保留至解除或到期后归档。</p>`);
  if (action === "blocked-recheck") toast("当前示例 IP 仍处于临时封禁状态");
});

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-form]"); if (!form) return;
  event.preventDefault(); const values = new FormData(form); const type = form.dataset.form;
  if (type === "filter") { state.query = String(values.get("query") || "").trim(); state.filter = values.get("filter"); state.ownerFilter = values.get("owner") || "all"; render(); }
  if (type === "login") {
    const button = form.querySelector('[type="submit"]'); button.disabled = true; button.textContent = "正在验证…";
    await new Promise((resolve) => setTimeout(resolve, 220));
    const cdk = state.cdks.find((item) => item.code === String(values.get("cdk")).trim() && item.status === "active");
    if (!cdk) { recordFailure("登录"); if (state.page !== "blocked") { state.page = "login-error"; state.loginError = "CDK 无效或不可用，请核对后重试。"; } render(); }
    else { state.owner = cdk.id; state.role = cdk.role; state.page = cdk.role === "admin" ? "cdks" : "tasks"; state.loginError = ""; render(); toast("已进入当前 CDK 的工作区"); }
  }
  if (type === "topup") {
    const cdk = findCdk(form.dataset.id); const amount = Number(values.get("amount")); if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 1000000) return;
    cdk.balance += amount; cdk.issued += amount; recordLedger(cdk.id, "管理员追加", amount, String(values.get("note"))); panel.close(); render(); toast(`已追加 ${amount} 次，当前可用 ${cdk.balance} 次`);
  }
  if (type === "generate") {
    const count = Number(values.get("count")); const quota = Number(values.get("quota")); if (!Number.isInteger(count) || count < 1 || count > 50 || !Number.isSafeInteger(quota) || quota < 1 || quota > 1000000) return;
    generatedCodes = [];
    for (let index = 0; index < count; index += 1) {
      const random = new Uint8Array(24); crypto.getRandomValues(random); const code = `DEMO-${Array.from(random, (value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
      const id = `generated-${state.cdks.length}`; generatedCodes.push(code); state.cdks.push({ id, label: `TS2-••••-${code.slice(-4)}`, code, note: String(values.get("note")), role: "user", balance: quota, issued: quota, used: 0, status: "active", last: "尚未登录" }); recordLedger(id, "初始发放", quota, "管理员批量生成");
    }
    render(); openPanel("CDK 已生成", `<div class="notice warning">${icon("key")}<p>请复制或下载本次结果。关闭后无法在列表中再次查看完整 CDK。</p></div><div id="generated-results">${generatedCodes.map((code) => `<div class="generated-code"><code>${code}</code><span>初始 ${quota} 次 / ${escapeText(values.get("note"))}</span></div>`).join("")}</div><div class="panel-footer"><button class="secondary" data-action="download-generated">${icon("download", 15)}下载本次结果</button><button class="primary" data-action="copy-generated">${icon("copy", 15)}复制全部</button></div>`);
  }
  if (type === "import") {
    const report = analyzeImport(String(values.get("accounts"))); const cdk = currentCdk(); const debit = isAdmin() ? 0 : report.added;
    if (report.invalid || !report.lines || (!isAdmin() && debit > cdk.balance)) { updateImportPreview(); return; }
    report.emails.forEach((email) => { const task = state.tasks.find((item) => item.owner === state.owner && item.email === email); if (task) { if (state.page === "mfa") task.mfa = true; } else { state.tasks.push({ id: `imported-${state.tasks.length}`, owner: state.owner, email, status: "排队中", mfa: state.page === "mfa", created: "14:33", credentialLabel: "当前 CDK 的独立示例凭据" }); } });
    if (debit) { cdk.balance -= debit; cdk.used += debit; recordLedger(cdk.id, "导入账号", -debit, `新增 ${report.added} 个，更新 ${report.existing.length} 个`); }
    panel.close(); render(); toast(`新增 ${report.added} 个，更新 ${report.existing.length} 个，消耗 ${debit} 次`);
  }
  if (type === "merge-check") {
    state.mergeCode = String(values.get("sourceCode")).trim(); const result = mergeEligibility(state.mergeCode); state.mergeCandidate = result.source?.id || null; state.mergeVerifiedCode = result.source ? state.mergeCode : null; state.mergeError = result.error || "";
    if (result.error?.startsWith("CDK 无效")) recordFailure("融合来源"); render();
  }
  if (type === "merge") {
    const displayedCode = document.querySelector('[name="sourceCode"]').value.trim();
    const result = mergeEligibility(displayedCode);
    const sameSource = state.mergeVerifiedCode === displayedCode && state.mergeCode === displayedCode && result.source?.id === state.mergeCandidate && result.source?.id === form.dataset.source && state.owner === form.dataset.target;
    if (!sameSource || result.error || !values.get("acknowledge")) { panel.close(); state.mergeCode = displayedCode; state.mergeError = result.error || "来源 CDK 已变化，请重新验证融合资格。"; state.mergeCandidate = null; state.mergeVerifiedCode = null; render(); return; }
    const target = currentCdk(); const source = result.source; const amount = source.balance; target.balance += amount; source.balance = 0; source.status = "merged";
    recordLedger(target.id, "融合转入", amount, `来自 ${source.label}`); recordLedger(source.id, "融合转出", -amount, `转入 ${target.label}，来源已作废`);
    state.mergeCode = ""; state.mergeCandidate = null; state.mergeVerifiedCode = null; state.mergeError = ""; panel.close(); render(); toast(`已转入 ${amount} 次，来源 CDK 已永久失效`);
  }
  if (type === "sub2api") { state.configs[state.owner] = { baseUrl: String(values.get("baseUrl")), key: String(values.get("apiKey")), group: String(values.get("group")), monitor: values.get("monitor") === "on", interval: Number(values.get("interval")), cooldown: Number(values.get("cooldown")) }; render(); toast("已保存当前 CDK 的 Sub2API 配置"); }
  if (type === "ban") {
    const ip = normalizeIp(String(values.get("ip"))); const error = panel.querySelector("#ban-error");
    if (!ip || state.bans.some((ban) => ban.active && normalizeIp(ban.ip) === ip)) { error.hidden = false; error.textContent = !ip ? "请输入有效的 IPv4 或 IPv6 地址。" : "该 IP 已在生效中的黑名单内。"; return; }
    const duration = values.get("duration"); state.bans.unshift({ id: `manual-${state.bans.length}`, ip, source: "手动拉黑", reason: String(values.get("reason")), expiry: duration === "permanent" ? "永久" : duration === "30" ? "今天 15:03" : "明天 14:33", actor: "系统管理员", active: true });
    state.logs.filter((log) => log.ip === ip).forEach((log) => { log.blocked = true; log.read = true; log.result = "管理员已拉黑"; }); panel.close(); navigate("blacklist"); toast(`已拉黑 ${ip}，处理记录已保存`);
  }
});

document.addEventListener("input", (event) => {
  const form = event.target.closest("[data-form]");
  if (form?.dataset.form === "import") updateImportPreview();
  if (form?.dataset.form === "topup" && event.target.name === "amount") { const cdk = findCdk(form.dataset.id); const amount = Number(event.target.value) || 0; panel.querySelector("#topup-equation").innerHTML = equation(cdk.balance, amount, cdk.balance + amount); }
  if (form?.dataset.form === "merge-check") {
    state.mergeCode = event.target.value.trim(); state.mergeCandidate = null; state.mergeVerifiedCode = null; state.mergeError = "";
    form.parentElement.querySelectorAll('.inline-result, .equation, [data-action="merge-confirm"]').forEach((result) => result.remove());
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "theme") { state.theme = event.target.value; applyTheme(); }
  if (event.target.name === "monitor") document.querySelector("#monitor-options").hidden = !event.target.checked;
});

document.addEventListener("keydown", (event) => {
  const tab = event.target.closest('.tabs [role="tab"]');
  if (!tab || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
  const target = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
  navigate(target.dataset.page); requestAnimationFrame(() => app.querySelector('.tabs [aria-selected="true"]')?.focus());
});

panel.addEventListener("close", () => { generatedCodes = []; panel.innerHTML = ""; if (returnFocus?.isConnected) returnFocus.focus(); else document.querySelector('.nav [aria-current="page"], #scene')?.focus(); });
panel.addEventListener("click", (event) => { if (event.target === panel) { const bounds = panel.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) panel.close(); } });
sceneControl.addEventListener("change", () => { location.hash = sceneControl.value; setScene(sceneControl.value); });
document.querySelector("#reset-preview").addEventListener("click", () => { const selected = sceneControl.value || "admin/cdks"; state = createFixtures(); setScene(selected); toast("示例数据已重置"); });
window.addEventListener("hashchange", () => setScene(location.hash.slice(1) || "admin/cdks"));
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
state = createFixtures();
setScene(location.hash.slice(1) || "admin/cdks");
