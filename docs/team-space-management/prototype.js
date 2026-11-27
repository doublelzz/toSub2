/* Design-only interaction model. No API calls and no credential persistence. */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const iconPaths = {
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  key: '<circle cx="8" cy="15" r="5"/><path d="m11.5 11.5 8-8L22 6l-3 3-2-2-2 2 2 2-2 2"/>',
  settings: '<path d="M12 8v8M8 12h8"/><circle cx="12" cy="12" r="9"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
  refresh: '<path d="M3 11a9 9 0 0 1 15-6l3 3M21 3v5h-5M21 13A9 9 0 0 1 6 19l-3-3M3 21v-5h5"/>',
  alert: '<path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  moon: '<path d="M21 12.8A9 9 0 0 1 11.2 3 9 9 0 1 0 21 12.8Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  crown: '<path d="m2 6 5 5 5-8 5 8 5-5-3 13H5L2 6Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  trash: '<path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.info}</svg>`;
const fillIcons = (root = document) => $$('[data-icon]', root).forEach((element) => { element.innerHTML = icon(element.dataset.icon); });
const badge = (label, tone = 'good') => `<span class="badge ${tone}"><span class="dot"></span>${escapeHtml(label)}</span>`;
const initialTeams = [
  { id: 'studio', name: '设计协作组', short: '设', email: 'owner@studio.example', role: '所有者', standard: [4, 5], premium: [0, 0], pending: 0, date: '2026-12-27', dateKind: 'renew', status: 'ready', plan: 'Business · 月付' },
  { id: 'ops', name: '产品运营团队', short: '产', email: 'admin@product.example', role: '管理员', standard: [8, 10], premium: [1, 2], pending: 3, date: '2026-12-06', dateKind: 'renew', status: 'ready', plan: 'Business · 月付' },
  { id: 'research', name: '研究工作室', short: '研', email: 'owner@research.example', role: '所有者', standard: [5, 5], premium: [0, 0], pending: 0, date: '2026-12-02', dateKind: 'renew', status: 'ready', plan: 'Business · 月付' },
  { id: 'pilot', name: '试用项目组', short: '试', email: 'owner@pilot.example', role: '所有者', standard: [2, 5], premium: [0, 0], pending: 0, date: '2026-12-01', dateKind: 'expiry', status: 'ready', plan: 'Business · 试用' },
  { id: 'audit', name: '数据分析组', short: '数', email: 'viewer@analytics.example', role: '分析查看者', standard: [3, 5], premium: [0, 0], pending: 0, date: null, dateKind: 'unknown', status: 'readonly', plan: 'Business' },
  { id: 'expired', name: '待识别团队', short: '—', email: 'account@content.example', role: '身份待确认', standard: null, premium: null, pending: null, date: null, dateKind: 'unknown', status: 'expired', plan: '需要更新授权' }
];
const makeMembers = (team) => {
  const count = (team.standard?.[0] || 0) + (team.premium?.[0] || 0);
  const names = ['林沐', '陈予安', '周可', '许言', '赵恬', '吴越', '陆星', '李明', '郑泽'];
  return Array.from({ length: count }, (_, index) => ({ id: `${team.id}-member-${index}`, name: names[index] || `成员 ${index + 1}`, email: index === 0 ? team.email : `member${index}@${team.id}.example`, role: index === 0 ? team.role : '成员', seat: index >= (team.standard?.[0] || 0) ? 'premium' : 'standard', joined: '2026-11-27', self: index === 0 }));
};
let teams = structuredClone(initialTeams);
let members = Object.fromEntries(teams.map((team) => [team.id, makeMembers(team)]));
let invitations = { ops: [{ email: 'new1@ops.example', seat: 'standard', created: '2026-11-27 19:42' }, { email: 'new2@ops.example', seat: 'standard', created: '2026-11-27 19:42' }, { email: 'new3@ops.example', seat: 'premium', created: '2026-11-27 19:42' }] };
let logs = {};
let selectedId = null;
let activeTab = 'members';
let toastTimer;
let removeId;
const filters = () => ({ query: $('#search').value.trim().toLowerCase(), status: $('#status-filter').value, seat: $('#seat-filter').value, date: $('#date-filter').value });
const canManage = (team) => team.status === 'ready';
const statusLabel = (team) => ({ ready: '可管理', readonly: '仅查看', expired: '需重新登录', pending: '待识别' })[team.status];
const actionLabel = (team) => ({ ready: '管理', readonly: '查看', expired: '更新授权', pending: '识别团队' })[team.status];
const totalUsed = (team) => (team.standard?.[0] || 0) + (team.premium?.[0] || 0);
const totalPaid = (team) => (team.standard?.[1] || 0) + (team.premium?.[1] || 0);
function notify(message) { const element = $('#toast'); element.textContent = message; element.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { element.hidden = true; }, 4200); }
function renderNavigation() {
  $('#navigation').innerHTML = [['login', '账号授权'], ['users', 'Team 空间'], ['shield', 'MFA 修改'], ['mail', '邮箱换绑'], ['sparkle', '优惠检测'], ['key', '我的 CDK'], ['settings', '配置']].map(([symbol, label], index) => `<button type="button" ${index === 1 ? 'class="active" data-current aria-current="page"' : index === 6 ? 'class="separator"' : ''}>${icon(symbol)}${label}${index === 1 ? '<span class="nav-new">NEW</span>' : ''}</button>`).join('');
  $$('#navigation button:not([data-current])').forEach((button) => { button.onclick = () => notify('本原型展示 Team 空间，其他菜单延续现有项目。'); });
}
function seatCell(value) {
  if (!value) return '<span class="muted">—</span>';
  const [used, paid] = value;
  return `<div class="seat-value">${used}<span> / ${paid}</span></div><div class="seat-bar ${paid && used >= paid ? 'full' : ''}"><span style="width:${paid ? Math.min(100, used / paid * 100) : 0}%"></span></div><span class="seat-note">${paid ? `可用 ${Math.max(0, paid - used)}` : '未购买'}</span>`;
}
function renderOverview() {
  const valid = teams.filter((team) => Boolean(team.standard));
  const accountCount = new Set(teams.map((team) => team.email)).size;
  const expiredCount = teams.filter((team) => team.status === 'expired').length;
  const pendingCount = teams.filter((team) => team.status === 'pending').length;
  const used = valid.reduce((sum, team) => sum + totalUsed(team), 0);
  const paid = valid.reduce((sum, team) => sum + totalPaid(team), 0);
  const pending = valid.reduce((sum, team) => sum + team.pending, 0);
  const expiring = valid.filter((team) => team.dateKind === 'expiry').length;
  $('#overview').innerHTML = `<div class="metric"><span class="metric-label">团队空间</span><strong class="metric-value">${valid.length}</strong><p>已导入 ${accountCount} 个账号 · ${expiredCount} 个需重登${pendingCount ? ` · ${pendingCount} 个待识别` : ''}</p></div><div class="metric"><span class="metric-label">已使用席位</span><strong class="metric-value">${used}<em>/ ${paid}</em></strong><p>标准与高级合计 · ${paid - used} 个可用</p></div><div class="metric"><span class="metric-label">待接受邀请</span><strong class="metric-value">${pending}</strong><p>尚未加入团队，单独统计</p></div><div class="metric metric-amber"><span class="metric-label">7 天内到期</span><strong class="metric-value">${expiring}</strong><p>试用或确定终止 · 不含自动续费</p></div>`;
  $('#expired-count').textContent = `${expiredCount} 个账号需要重新登录`;
}
function renderTable() {
  const f = filters();
  const filtered = teams.filter((team) => (!f.query || `${team.name} ${team.email}`.toLowerCase().includes(f.query)) && (f.status === 'all' || team.status === f.status) && (f.seat === 'all' || team.standard && (f.seat === 'available' ? totalPaid(team) > totalUsed(team) : totalPaid(team) === totalUsed(team))) && (f.date === 'all' || team.dateKind === 'expiry'));
  $('#team-rows').innerHTML = filtered.map((team) => `<tr><td><div class="team-cell"><span class="team-avatar ${team.status === 'expired' ? 'soft' : ''}">${team.short}</span><div><span class="team-name">${escapeHtml(team.name)}</span><span class="team-meta">${team.plan}</span></div></div></td><td><span class="account-email">${escapeHtml(team.email)}</span><span class="role">${icon(team.role === '所有者' ? 'crown' : 'shield')}${team.role}</span></td><td>${seatCell(team.standard)}</td><td>${seatCell(team.premium)}</td><td>${team.pending === null ? '<span class="muted">—</span>' : `<span class="pending-count ${team.pending ? 'has-pending' : 'muted'}">${team.pending}</span>`}</td><td><span class="date-main">${team.date || '—'}</span><span class="date-label ${team.dateKind === 'expiry' ? 'warn' : ''}">${team.dateKind === 'renew' ? '下次续费 · 自动续费' : team.dateKind === 'expiry' ? '试用到期 · 4 天后' : team.status === 'readonly' ? '暂无账单权限' : '等待识别订阅'}</span></td><td>${badge(statusLabel(team), team.status === 'expired' ? 'warn' : team.status === 'readonly' ? 'neutral' : 'good')}</td><td class="align-right"><button class="table-action" data-manage="${team.id}">${actionLabel(team)}${icon('chevron')}</button></td></tr>`).join('');
  $('#empty').hidden = filtered.length > 0;
  $('.teams-table').hidden = filtered.length === 0;
  $('#list-count').textContent = `${filtered.length} 条`;
  $('#table-summary').textContent = `共 ${filtered.length} 条记录 · 账号列表包含尚未识别的团队`;
  $$('[data-manage]').forEach((button) => { button.onclick = () => { const team = teams.find((item) => item.id === button.dataset.manage); if (!team.standard) { openImport(); notify('正式版将在此更新该账号的登录资料并重新识别团队。'); } else openManage(team.id); }; });
  renderOverview();
}
function log(team, title, detail) { (logs[team.id] ||= []).unshift({ title, detail, time: '2026-11-27 20:16' }); }
function panel(title, pair) {
  return `<div class="seat-panel"><div class="seat-panel-head"><span>${title}</span>${icon('users')}</div><div class="seat-total">${pair[1]}<small>个席位</small></div><div class="seat-split"><span>已使用<strong>${pair[0]}</strong></span><span>当前可用<strong class="free">${Math.max(0, pair[1] - pair[0])}</strong></span></div></div>`;
}
function openManage(id) { selectedId = id; activeTab = 'members'; renderManage(); $('#manage-dialog').showModal(); }
function renderManage() {
  const team = teams.find((item) => item.id === selectedId);
  const dialog = $('#manage-dialog');
  dialog.innerHTML = `<header class="drawer-header"><div><span class="drawer-kicker">Team 空间 / 团队管理</span><h2 id="manage-title">${escapeHtml(team.name)}</h2><p>${team.plan}</p></div><button class="icon-button" data-close="manage-dialog" aria-label="关闭团队管理">${icon('x')}</button></header><div class="drawer-main"><div class="drawer-account">管理账号<strong>${escapeHtml(team.email)}</strong><span>${team.role}</span>${badge(canManage(team) ? '授权可用' : '仅查看', canManage(team) ? 'good' : 'neutral')}</div><div class="seat-panels">${panel('标准席位', team.standard)}${panel('高级席位', team.premium)}</div><div class="subscription-line">${icon('calendar')}<span>${team.dateKind === 'renew' ? '下次续费' : team.dateKind === 'expiry' ? '试用到期' : '订阅节点'}：${team.date || '暂无账单权限'}</span><span>${team.dateKind === 'renew' ? '自动续费已开启' : team.dateKind === 'expiry' ? '剩余 4 天' : '订阅信息暂不可见'}</span></div><div class="drawer-tabs" role="tablist" aria-label="团队管理视图">${[['members', '现有成员', members[team.id]?.length || 0], ['invites', '待接受邀请', team.pending], ['logs', '操作记录', (logs[team.id] || [0]).length]].map(([id, label, count]) => `<button id="tab-${id}" role="tab" tabindex="${activeTab === id ? '0' : '-1'}" aria-controls="drawer-tab-panel" aria-selected="${activeTab === id}" data-tab="${id}">${label}<small>${count}</small></button>`).join('')}</div><div id="drawer-tab-panel" role="tabpanel" aria-labelledby="tab-${activeTab}" tabindex="0"></div></div><footer class="drawer-footer"><span>最近同步：2026-11-27 20:15 · Asia/Shanghai</span><button class="secondary" id="sync-team">${icon('refresh')}同步团队</button></footer>`;
  $$('[data-tab]', dialog).forEach((button) => { button.onclick = () => { activeTab = button.dataset.tab; renderManage(); $(`[data-tab="${activeTab}"]`, dialog).focus(); }; button.onkeydown = (event) => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const ids = ['members', 'invites', 'logs']; activeTab = ids[(ids.indexOf(activeTab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3]; renderManage(); $(`[data-tab="${activeTab}"]`, dialog).focus(); } }; });
  bindClose(dialog);
  $('#sync-team').onclick = () => simulateSync($('#sync-team'), '团队信息已同步（演示）。');
  renderManageContent();
}
function renderManageContent() {
  const team = teams.find((item) => item.id === selectedId);
  const panel = $('#drawer-tab-panel');
  if (activeTab === 'members') {
    panel.innerHTML = `${!canManage(team) ? '<div class="drawer-notice">当前账号为分析查看者。本原型展示只读状态；正式版将根据服务端返回的能力显示可操作项。</div>' : ''}<div class="member-toolbar"><label class="search">${icon('search')}<input id="member-search" aria-label="搜索成员邮箱或姓名" placeholder="搜索成员邮箱、姓名" type="search"></label><button class="primary" id="invite-open" ${canManage(team) ? '' : 'disabled'}>${icon('plus')}邀请成员</button></div><table class="member-table"><thead><tr><th>成员</th><th>角色</th><th>席位</th><th>加入日期</th><th class="align-right">操作</th></tr></thead><tbody id="member-rows"></tbody></table><p class="page-note">${icon('info')}所有者及当前管理账号受保护。其他成员按实际管理权限开放移除。</p>`;
    $('#invite-open').onclick = openInvite;
    $('#member-search').oninput = renderMemberRows;
    renderMemberRows();
  } else if (activeTab === 'invites') {
    const list = invitations[team.id] || [];
    panel.innerHTML = `<div class="drawer-notice">待接受邀请尚未成为成员，不计入已使用席位。接受邀请时可能增加席位需求。</div>${list.length ? `<table class="member-table"><thead><tr><th>被邀请邮箱</th><th>角色</th><th>席位</th><th>邀请时间</th><th>状态</th></tr></thead><tbody>${list.map((item) => `<tr><td class="account-email">${escapeHtml(item.email)}</td><td>成员</td><td>${item.seat === 'premium' ? '高级' : '标准'}</td><td>${item.created}</td><td>${badge('待接受', 'neutral')}</td></tr>`).join('')}</tbody></table><p class="page-note">${icon('info')}撤销与重发邀请的完整操作链待补充验证，首版仅展示列表。</p>` : `<div class="empty">${icon('mail')}<h3>暂无待接受邀请</h3><p>发送邀请后，可在这里查看尚未加入的成员。</p><button class="primary" id="invite-from-empty" ${canManage(team) ? '' : 'disabled'}>${icon('plus')}邀请成员</button></div>`}`;
    if ($('#invite-from-empty')) $('#invite-from-empty').onclick = openInvite;
  } else {
    const list = logs[team.id] || [{ title: '团队信息同步完成', detail: '成员、席位与订阅信息已更新。', time: '2026-11-27 20:15' }];
    panel.innerHTML = `<p class="import-caption">记录本工作台发起的操作；未接入官方历史操作日志。</p>${list.map((item) => `<div class="log-row">${icon('clock')}<div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p><small>${item.time} · 演示工作区</small></div></div>`).join('')}`;
  }
}
function renderMemberRows() {
  const team = teams.find((item) => item.id === selectedId);
  const query = $('#member-search').value.trim().toLowerCase();
  const list = members[team.id].filter((member) => `${member.name} ${member.email}`.toLowerCase().includes(query));
  $('#member-rows').innerHTML = list.map((member) => `<tr><td><div class="member-identity"><span class="member-avatar">${escapeHtml(member.name.slice(0, 1))}</span><div><span class="member-name">${escapeHtml(member.name)}${member.self ? '<span class="self-label">（当前账号）</span>' : ''}</span><small>${escapeHtml(member.email)}</small></div></div></td><td>${member.role}</td><td>${member.seat === 'premium' ? '高级' : '标准'}</td><td>${member.joined}</td><td class="align-right">${member.self || member.role === '所有者' ? '<span class="muted">受保护</span>' : `<button class="danger-text" data-remove="${member.id}" ${canManage(team) ? '' : 'disabled'}>移除</button>`}</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty">没有匹配的成员</div></td></tr>';
  $$('[data-remove]').forEach((button) => { button.onclick = () => openRemove(button.dataset.remove); });
}
function parseEmails(raw) { return [...new Set(raw.split(/[\s,;，；]+/).map((email) => email.trim().toLowerCase()).filter(Boolean))]; }
const emailValid = (email) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
function openInvite() {
  const team = teams.find((item) => item.id === selectedId);
  if (!canManage(team)) return;
  const dialog = $('#invite-dialog');
  dialog.innerHTML = `<header class="modal-header"><div><h2 id="invite-title">邀请成员</h2><p>加入 ${escapeHtml(team.name)} · ${escapeHtml(team.email)}</p></div><button class="icon-button" data-close="invite-dialog" aria-label="关闭邀请">${icon('x')}</button></header><form id="invite-form"><div class="modal-body"><label class="field" for="invite-emails">成员邮箱<textarea id="invite-emails" spellcheck="false" placeholder="colleague@example.com&#10;支持多行，或用逗号分隔" aria-describedby="invite-help invite-error" required></textarea><small id="invite-help">自动去重，逐个显示邀请结果。邀请发送后，成员需自行接受。</small><span id="invite-error" class="inline-error" role="alert" hidden></span></label><div class="field-grid"><label class="field">邀请角色<select disabled aria-label="邀请角色"><option>成员</option></select></label><label class="field">席位类型<select id="invite-seat" ${team.role === '所有者' ? '' : 'disabled'}><option value="standard">标准</option><option value="premium" disabled>高级（首版待验证）</option></select></label></div><div class="capacity-note" id="capacity-note"></div><div class="result-list" id="invite-results" aria-live="polite"></div></div><footer class="modal-footer"><span class="footer-hint" id="invite-count">尚未输入邮箱</span><button type="button" class="secondary" data-close="invite-dialog">取消</button><button type="submit" class="primary" id="invite-submit" disabled>${icon('mail')}发送邀请</button></footer></form>`;
  bindClose(dialog);
  $('#invite-emails').oninput = updateInviteCapacity;
  $('#invite-seat').onchange = updateInviteCapacity;
  $('#invite-form').onsubmit = (event) => { event.preventDefault(); sendInvites(); };
  updateInviteCapacity();
  dialog.showModal();
  $('#invite-emails').focus();
}
function updateInviteCapacity() {
  const team = teams.find((item) => item.id === selectedId);
  const emails = parseEmails($('#invite-emails').value);
  const invalid = emails.filter((email) => !emailValid(email));
  const type = $('#invite-seat').value;
  const pair = team[type];
  const pending = (invitations[team.id] || []).filter((item) => item.seat === type).length;
  const existing = new Set(members[team.id].map((member) => member.email));
  const alreadyInvited = new Set((invitations[team.id] || []).map((item) => item.email));
  const actionable = emails.filter((email) => emailValid(email) && !existing.has(email) && !alreadyInvited.has(email));
  const available = pair[1] - pair[0];
  const over = actionable.length + pending > available;
  $('#invite-error').hidden = invalid.length === 0;
  $('#invite-error').textContent = invalid.length ? `邮箱格式有误：${invalid.join('、')}` : '';
  $('#invite-emails').setAttribute('aria-invalid', String(invalid.length > 0));
  $('#invite-count').textContent = `已识别 ${emails.length} 个邮箱${emails.length !== actionable.length ? ` · ${emails.length - actionable.length} 个已存在或待修正` : ''}`;
  $('#capacity-note').classList.toggle('warn', over);
  $('#capacity-note').innerHTML = `${icon(over ? 'alert' : 'info')}<span>当前可用 <strong>${available}</strong> 席 · 已有待接受 <strong>${pending}</strong> 人 · 本次新增 <strong>${actionable.length}</strong> 人<br>${over ? '全部接受后将超过当前可用席位，请减少邀请人数或前往官方管理席位。' : '本次仅发送成员邀请，按当前席位与待接受人数校验，不自动购买席位。'}</span>`;
  $('#invite-submit').disabled = !emails.length || invalid.length > 0 || over;
}
function sendInvites() {
  const team = teams.find((item) => item.id === selectedId);
  const list = parseEmails($('#invite-emails').value);
  const seat = $('#invite-seat').value;
  const button = $('#invite-submit');
  if (button.disabled) return;
  button.disabled = true; button.textContent = '正在发送…';
  setTimeout(() => {
    const results = list.map((email) => {
      if (members[team.id].some((member) => member.email === email)) return { email, message: '已是成员，已跳过', ok: true };
      if ((invitations[team.id] || []).some((item) => item.email === email)) return { email, message: '邀请已存在，已跳过', ok: true };
      if (email.startsWith('fail')) return { email, message: '模拟发送失败，可重试', ok: false };
      (invitations[team.id] ||= []).push({ email, seat, created: '2026-11-27 20:16' });
      team.pending += 1;
      return { email, message: '邀请已发送，待接受', ok: true };
    });
    $('#invite-results').innerHTML = results.map((item) => `<div class="result-line"><span>${escapeHtml(item.email)}</span><span class="${item.ok ? 'ok' : 'bad'}">${item.message}</span></div>`).join('');
    log(team, '邀请成员', `模拟处理 ${results.length} 个邮箱；已使用席位保持 ${totalUsed(team)}。`);
    renderTable(); renderManage();
    button.textContent = results.some((item) => !item.ok) ? '重试失败项' : '发送完成';
    const failed = results.filter((item) => !item.ok);
    if (failed.length) { $('#invite-emails').value = failed.map((item) => item.email).join('\n'); updateInviteCapacity(); }
    notify('已更新演示邀请记录；未调用真实接口。');
  }, 550);
}
function openRemove(id) {
  const team = teams.find((item) => item.id === selectedId);
  const member = members[team.id].find((item) => item.id === id);
  if (!member || member.self || member.role === '所有者' || !canManage(team)) return;
  removeId = id;
  const dialog = $('#remove-dialog');
  dialog.innerHTML = `<header class="modal-header"><div><h2 id="remove-title">移除团队成员</h2><p>${escapeHtml(team.name)}</p></div><button class="icon-button" data-close="remove-dialog" aria-label="关闭移除确认">${icon('x')}</button></header><div class="modal-body"><p class="modal-copy">确认移除以下成员？完成后，对方将失去此团队的访问权限。</p><div class="remove-target"><span class="member-avatar">${escapeHtml(member.name.slice(0, 1))}</span><div><strong>${escapeHtml(member.name)}</strong><small>${escapeHtml(member.email)}</small></div></div><p class="modal-copy">购买席位数量保持不变。成员与可用席位将在操作后重新同步。</p></div><footer class="modal-footer"><button class="secondary" data-close="remove-dialog" autofocus>取消</button><button class="danger-button" id="remove-confirm">${icon('trash')}确认移除</button></footer>`;
  bindClose(dialog);
  $('#remove-confirm').onclick = () => {
    const current = members[team.id].find((item) => item.id === removeId);
    if (!current || current.self || current.role === '所有者') return;
    members[team.id] = members[team.id].filter((item) => item.id !== removeId);
    team[current.seat][0] -= 1;
    log(team, '移除成员', `已从演示团队移除 ${current.email}，购买席位数量保持不变。`);
    dialog.close(); renderTable(); renderManage(); notify('成员已从演示列表移除，席位信息已更新。');
  };
  dialog.showModal();
}
const importCandidates = [
  { email: 'owner@studio.example', note: '已关联设计协作组', existing: true },
  { email: 'owner@newspace.example', note: '授权可用 · 可识别团队', existing: false },
  { email: 'owner@second.example', note: '授权可用 · 可识别多个团队', existing: false },
  { email: 'account@content.example', note: '授权已过期 · 需要重新登录', existing: true }
];
let importTab = 'select';
let importConfirmed = false;
function openImport() { importTab = 'select'; importConfirmed = false; renderImport(); $('#import-dialog').showModal(); }
function renderImport() {
  const dialog = $('#import-dialog');
  dialog.innerHTML = `<header class="modal-header"><div><h2 id="import-title">导入团队管理账号</h2><p>复用账号授权的导入方式，登录后识别可访问的团队空间。</p></div><button class="icon-button" data-close="import-dialog" aria-label="关闭导入">${icon('x')}</button></header><div class="modal-body"><div class="segmented" role="tablist" aria-label="导入来源"><button role="tab" aria-selected="${importTab === 'select'}" data-import-tab="select">从账号授权选择</button><button role="tab" aria-selected="${importTab === 'paste'}" data-import-tab="paste">粘贴账号资料</button></div><div id="import-content">${importTab === 'select' ? `<p class="import-caption">仅显示当前 CDK 工作区的账号；优先复用已有有效登录状态。</p>${importCandidates.map((item) => `<label class="import-account"><input type="checkbox" name="import-account" value="${item.email}" ${item.existing ? 'disabled' : ''}><span>${item.email}<small>${item.note}</small></span><em>${item.existing ? '已有记录' : '可选择'}</em></label>`).join('')}` : '<label class="field">账号资料<textarea id="import-text" spellcheck="false" placeholder="邮箱----密码----MFA 密钥（可选）&#10;其他取件 URL / POST 取件格式沿用账号授权"></textarea><small>按现有账号授权解析器预览格式；已有账号会提示关联或更新资料。</small></label><p class="import-caption">网络设置沿用当前工作区配置，单账号可覆盖；登录验证按账号逐条处理。</p>'}</div><div id="import-preview" class="import-preview" hidden></div><div class="steps"><span><i>1</i>校验账号</span>${icon('chevron')}<span><i>2</i>登录 / 复用会话</span>${icon('chevron')}<span><i>3</i>识别团队</span></div></div><footer class="modal-footer"><button class="secondary" data-close="import-dialog">取消</button><button class="primary" id="import-submit">预览导入</button></footer>`;
  bindClose(dialog);
  $$('[data-import-tab]', dialog).forEach((button) => { button.onclick = () => { importTab = button.dataset.importTab; importConfirmed = false; renderImport(); }; });
  $('#import-submit').onclick = () => {
    const selected = importTab === 'select' ? $$('input[name="import-account"]:checked').map((item) => item.value) : [...new Set(($('#import-text').value || '').split(/\r?\n/).map((line) => line.split('----')[0].trim().toLowerCase()).filter(Boolean))];
    if (!selected.length) { notify('请先选择账号，或粘贴演示账号资料。'); return; }
    if (selected.some((email) => !emailValid(email))) { $('#import-preview').hidden = false; $('#import-preview').textContent = '存在邮箱格式错误，请修改后重新预览。'; importConfirmed = false; return; }
    const added = selected.filter((email) => !teams.some((team) => team.email === email));
    if (!importConfirmed) {
      $('#import-preview').hidden = false;
      $('#import-preview').innerHTML = `<strong>校验完成：${added.length} 个新账号，${selected.length - added.length} 个已有账号</strong><p>正式版将在下一步登录并识别团队；一个账号的多个团队可按空间分别管理。</p>`;
      importConfirmed = true; $('#import-submit').textContent = '确认导入并识别'; return;
    }
    for (const email of added) teams.push({ id: `import-${teams.length}`, name: '等待识别团队', short: '待', email, role: '身份待确认', standard: null, premium: null, pending: null, date: null, dateKind: 'unknown', status: 'pending', plan: '演示导入记录' });
    dialog.close(); clearFilters(); notify(`已添加 ${added.length} 条演示账号记录。正式版将在此执行登录与团队识别。`);
  };
  $$('input,textarea', dialog).forEach((input) => { const resetPreview = () => { importConfirmed = false; $('#import-submit').textContent = '预览导入'; $('#import-preview').hidden = true; }; input.addEventListener('input', resetPreview); input.addEventListener('change', resetPreview); });
}
function bindClose(root) { $$('[data-close]', root).forEach((button) => { button.onclick = () => { $(`#${button.dataset.close}`).close(); }; }); }
function simulateSync(button, message) { const previous = button.innerHTML; button.disabled = true; button.textContent = '正在同步…'; setTimeout(() => { button.innerHTML = previous; button.disabled = false; $('#sync-time').textContent = '2026-11-27 20:16'; notify(message); }, 650); }
function clearFilters() { $('#search').value = ''; $('#status-filter').value = 'all'; $('#seat-filter').value = 'all'; $('#date-filter').value = 'all'; renderTable(); }
$('#search').oninput = renderTable;
['status-filter', 'seat-filter', 'date-filter'].forEach((id) => { $(`#${id}`).onchange = renderTable; });
$('#filter-expired').onclick = () => { clearFilters(); $('#status-filter').value = 'expired'; renderTable(); };
$('#clear-filters').onclick = clearFilters;
$('#import-open').onclick = openImport;
$('#sync-all').onclick = () => simulateSync($('#sync-all'), '团队列表已同步（演示），异常账号仍需单独更新授权。');
$('#theme-toggle').onclick = () => { const dark = document.documentElement.dataset.theme !== 'dark'; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; $('#theme-toggle').innerHTML = icon(dark ? 'sun' : 'moon'); $('#theme-toggle').setAttribute('aria-label', dark ? '切换为浅色主题' : '切换为深色主题'); };
$('#reset-demo').onclick = () => { $$('dialog[open]').reverse().forEach((dialog) => dialog.close()); teams = structuredClone(initialTeams); members = Object.fromEntries(teams.map((team) => [team.id, makeMembers(team)])); invitations = { ops: [{ email: 'new1@ops.example', seat: 'standard', created: '2026-11-27 19:42' }, { email: 'new2@ops.example', seat: 'standard', created: '2026-11-27 19:42' }, { email: 'new3@ops.example', seat: 'premium', created: '2026-11-27 19:42' }] }; logs = {}; clearFilters(); notify('演示数据已重置。'); };
fillIcons(); renderNavigation(); renderTable();
const initialView = new URLSearchParams(location.search).get('view');
if (['manage', 'invite', 'remove'].includes(initialView)) { openManage('studio'); if (initialView === 'invite') openInvite(); if (initialView === 'remove') openRemove('studio-member-1'); }
if (initialView === 'import') openImport();
