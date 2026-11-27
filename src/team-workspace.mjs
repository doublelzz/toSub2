import crypto from "node:crypto";
import fs from "./workspace-storage.mjs";
import path from "node:path";
import { parseOfferImport } from "./offer-workspace.mjs";
import { fetchMailboxOtpCandidates, filterMailboxOtpCandidatesByRequestTime } from "./mail-otp.mjs";
import { createTeamClient, teamIdentity, teamEmail, teamError, publicTeamError, teamCanRemove, teamRoleChoices, teamRoleLabel } from "./team-client.mjs";

const text = (value) => typeof value === "string" ? value.trim() : "";
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const validEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const LIVE = new Set(["queued", "running", "waiting_input"]);
export function parseTeamEmails(value) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,;，；]+/) : [];
  if (values.some((entry) => typeof entry !== "string")) throw fail("邀请邮箱格式不正确");
  const emails = [...new Set(values.map(teamEmail).filter(Boolean))];
  if (!emails.length || emails.length > 50 || emails.some((email) => !validEmail(email) || email.length > 254)) throw fail("请输入 1 至 50 个有效邮箱");
  return emails;
}

export async function createTeamWorkspace({ root, vault, parseText, listSources = () => [], resolveSource = async () => null,
  proxyPool, runLogin, requestSchedule = () => {}, isAccountBusy = () => false, canUse = () => true, canImport = canUse,
  clientFactory = createTeamClient, pollMailbox = fetchMailboxOtpCandidates, mailRequest = () => ({}), now = Date.now }) {
  if (!vault?.seal || !vault?.open) throw new Error("Team workspace requires a credential vault");
  const directory = path.join(root, "team-space");
  const filename = path.join(directory, "state.json");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let state;
  try { state = JSON.parse(await fs.readFile(filename, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; state = { version: 1, accounts: [], teams: [], requests: [], imports: [] }; }
  state.deletedTeams ??= [];
  if (state.version !== 1 || !["accounts", "teams", "requests", "imports", "deletedTeams"].every((key) => Array.isArray(state[key]))) throw new Error("Team workspace data is invalid");
  const active = new Map(), network = new Map(), teamLocks = new Set();
  let closing = false, writes = Promise.resolve();
  const stamp = () => new Date(now()).toISOString();
  const access = () => { if (closing || !canUse()) throw fail("工作区已暂停，请稍后再操作", 409); };
  const importAccess = () => { if (closing || !canImport()) throw fail("当前 CDK 的团队导入不可用", 403); };
  const accountOf = (id) => { const account = state.accounts.find((row) => row.id === id); if (!account) throw fail("团队管理账号不存在", 404); return account; };
  const teamOf = (id) => { const team = state.teams.find((row) => row.id === id); if (!team) throw fail("团队记录不存在", 404); return team; };
  const secret = (account) => vault.open(account.secret, `account:${account.id}`);
  const putSecret = (account, value) => { account.secret = vault.seal(value, `account:${account.id}`); };
  const deleteBlocked = (accounts, teamId) => teamLocks.has(teamId) || accounts.some((account) => LIVE.has(account.status) || isBusy(account.email));
  function save() {
    if (!state.accounts.length && !state.teams.length && !state.requests.length && !state.imports.length && !state.deletedTeams.length) return writes;
    const raw = `${JSON.stringify(state)}\n`;
    const next = writes.catch(() => {}).then(async () => {
      const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, raw, { mode: 0o600 }); await fs.rename(temporary, filename); }
      finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
    });
    writes = next; return next;
  }
  for (const account of state.accounts) if (LIVE.has(account.status)) { account.status = "interrupted"; account.message = "任务因服务重启中断，可重新识别或登录"; account.prompt = null; }
  for (const request of state.requests) if (request.status === "running") { request.status = "unknown"; request.message = "服务中断，需先同步核对结果"; }
  if (state.accounts.length || state.requests.length) await save();
  const isBusy = (email) => [...active.values(), ...network.values()].some((run) => run.email === teamEmail(email));
  function publicAccount(account) {
    return { id: account.id, email: account.email, status: account.status, message: account.message || "", errorCode: account.errorCode || "",
      prompt: account.prompt || null, updatedAt: account.updatedAt, source: account.source || "import", hasCredentials: account.hasCredentials,
      busy: isBusy(account.email), canDelete: !deleteBlocked([account]), teamCount: state.teams.filter((row) => row.accountIds.includes(account.id)).length };
  }
  function publicTeam(team, requestedAccountId) {
    const accountId = requestedAccountId || team.selectedAccountId;
    const account = accountOf(accountId);
    if (!team.accountIds.includes(accountId)) throw fail("该账号没有关联当前团队", 403);
    const snapshot = team.snapshots[accountId];
    const stale = account.status !== "ready" || !snapshot || Object.keys(snapshot.errors || {}).length > 0;
    const candidates = team.accountIds.map((id) => { const row = accountOf(id); return { id, email: row.email, status: row.status, roleLabel: team.snapshots[id]?.capabilities?.roleLabel || "身份待确认" }; });
    const data = snapshot?.subscription || team.lastSubscription || null;
    return { id: team.id, workspaceId: team.workspaceId, name: team.name, planType: team.planType,
      accountId, email: account.email, accounts: candidates, status: account.status, message: account.message || "", stale,
      capabilities: snapshot?.capabilities || { canInvite: false, canRemove: false, roleLabel: "身份待确认" },
      subscription: data, subscriptionStale: !snapshot?.subscription || Boolean(snapshot?.errors?.subscription),
      membersTotal: snapshot?.members?.total ?? null, pendingInvites: snapshot?.invites?.total ?? null,
      checkedAt: snapshot?.checkedAt || null, errors: snapshot?.errors || {}, logs: (team.logs || []).slice(0, 100), busy: teamLocks.has(team.id) || isBusy(account.email),
      canDelete: !deleteBlocked(team.accountIds.map(accountOf), team.id) };
  }
  function overview() {
    const teams = state.teams.map((row) => publicTeam(row));
    let used = 0, purchased = 0, pending = 0, seatsKnown = 0, pendingKnown = 0, expiring = 0;
    for (const team of teams) {
      const pools = team.subscription?.pools;
      if (pools && [pools.default?.used, pools.default?.purchased, pools.prolite?.used, pools.prolite?.purchased].every((value) => typeof value === "number")) {
        used += pools.default.used + pools.prolite.used; purchased += pools.default.purchased + pools.prolite.purchased; seatsKnown += 1;
      }
      if (typeof team.pendingInvites === "number") { pending += team.pendingInvites; pendingKnown += 1; }
      const event = team.subscription?.event;
      if (["expiry", "trial"].includes(event?.kind) && Date.parse(event.at) >= now() && Date.parse(event.at) <= now() + 7 * 86400_000) expiring += 1;
    }
    return { accounts: state.accounts.filter((row) => !row.hidden).length, teams: teams.length, used, purchased, seatsKnown, pending, pendingKnown, expiring,
      expired: state.accounts.filter((row) => !row.hidden && row.status === "auth_expired").length,
      active: state.accounts.filter((row) => !row.hidden && LIVE.has(row.status)).length };
  }
  function query(body = {}) {
    access();
    const search = text(body.search).toLowerCase();
    const linked = new Set(state.teams.flatMap((row) => row.accountIds));
    let rows = [...state.teams.map((row) => ({ kind: "team", ...publicTeam(row) })),
      ...state.accounts.filter((row) => !row.hidden && !linked.has(row.id)).map((row) => ({ kind: "account", ...publicAccount(row), name: "待识别团队", accountId: row.id }))];
    rows = rows.filter((row) => (!search || `${row.name} ${row.email} ${(row.accounts || []).map((item) => item.email).join(" ")}`.toLowerCase().includes(search))
      && (!body.status || body.status === "all" || (body.status === "readonly" ? row.status === "ready" && !row.capabilities?.canInvite && !row.capabilities?.canRemove : row.status === body.status))
      && (!body.seats || body.seats === "all" || (typeof row.subscription?.pools?.default?.available === "number" && (body.seats === "available" ? row.subscription.pools.default.available > 0 : row.subscription.pools.default.available === 0)))
      && (!body.expiring || ["expiry", "trial"].includes(row.subscription?.event?.kind) && Date.parse(row.subscription.event.at) >= now() && Date.parse(row.subscription.event.at) <= now() + 7 * 86400_000));
    const pages = Math.max(1, Math.ceil(rows.length / 20));
    const page = Math.min(pages, Math.max(1, Number.isSafeInteger(body.page) ? body.page : 1));
    return { rows: rows.slice((page - 1) * 20, page * 20), total: rows.length, page, pages, overview: overview(),
      tasks: state.accounts.filter((row) => !row.hidden && (LIVE.has(row.status) || row.status === "interrupted")).map(publicAccount) };
  }
  function sources({ forImport = false } = {}) {
    if (forImport) importAccess(); else access();
    return { accounts: listSources().filter((row) => row.sources?.includes("authorization")).map((row) => ({ ...row,
      busy: row.busy || isBusy(row.email) || state.accounts.some((account) => account.email === row.email && LIVE.has(account.status)),
      linked: state.accounts.some((account) => account.email === row.email && !account.hidden) })) };
  }
  function parseImport(body) {
    if (body.sourceIds !== undefined) {
      if (!Array.isArray(body.sourceIds) || !body.sourceIds.length || body.sourceIds.length > 100 || new Set(body.sourceIds).size !== body.sourceIds.length) throw fail("请选择 1 至 100 个账号");
      const available = sources({ forImport: true }).accounts;
      return { entries: body.sourceIds.map((id) => { const source = available.find((row) => row.id === id); if (!source || source.busy) throw fail("所选授权账号不存在或正在执行其他任务", 409); return { email: source.email, credentials: {}, session: null, sourceRef: source.id }; }), duplicateCount: 0 };
    }
    return parseOfferImport(body.text, parseText);
  }
  function preview(body) {
    importAccess();
    const parsed = parseImport(body);
    const selection = proxyPool?.normalizeSelection(body) || null;
    if (parsed.entries.length > 100) throw fail("每次最多导入 100 个团队管理账号");
    const accounts = parsed.entries.map((entry) => {
      if (entry.session) teamIdentity(entry.session, entry.email);
      const existing = state.accounts.find((row) => row.email === entry.email);
      if (isAccountBusy(entry.email) || isBusy(entry.email) || existing && LIVE.has(existing.status)) throw fail(`账号 ${entry.email} 正在执行任务，请稍后重试`, 409);
      return { email: entry.email, existing: Boolean(existing), restoring: Boolean(existing?.hidden), action: existing ? existing.hidden ? "恢复管理并识别" : body.updateExisting === true ? "更新资料并识别" : "复用并识别" : "新账号",
        hasPassword: Boolean(entry.credentials.password), hasTotp: Boolean(entry.credentials.totpSecret), hasMailbox: Boolean(entry.credentials.mailApiUrl), hasSession: Boolean(entry.session), source: entry.sourceRef ? "authorization" : "import" };
    });
    return { count: accounts.length, added: accounts.filter((row) => !row.existing).length, duplicateCount: parsed.duplicateCount,
      accounts, digest: hash({ entries: parsed.entries, updateExisting: body.updateExisting === true, forceLogin: body.forceLogin === true, selection }) };
  }
  function requestKey(body) { const key = text(body.requestKey); if (!/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw fail("缺少有效请求标识，请重新操作"); return key; }
  const importDigest = (body) => hash({ text: body.text, sourceIds: body.sourceIds, digest: body.digest, updateExisting: body.updateExisting === true, forceLogin: body.forceLogin === true, network: proxyPool?.normalizeSelection(body) || null });
  function planImport(body) {
    importAccess(); const previous = state.imports.find((row) => row.key === body.requestKey);
    if (previous) { if (previous.digest !== importDigest(body)) throw fail("该请求标识已用于其他导入", 409); return previous.accountIds.map((id) => accountOf(id).email); }
    return preview(body).accounts.map((row) => row.email);
  }
  async function importAccounts(body, actorId) {
    importAccess(); const key = requestKey(body);
    const bodyDigest = importDigest(body);
    const previous = state.imports.find((row) => row.key === key);
    if (previous) { if (previous.digest !== bodyDigest) throw fail("该请求标识已用于其他导入", 409); return { accounts: previous.accountIds.map((id) => publicAccount(accountOf(id))), reused: true }; }
    const view = preview(body);
    if (body.digest !== view.digest) throw fail("导入内容或账号状态已变化，请重新预览", 409);
    if (state.accounts.filter((row) => !row.hidden).length + view.accounts.filter((row) => !row.existing || row.restoring).length > 500) throw fail("团队管理账号已达 500 个上限");
    const entries = parseImport(body).entries, ids = [];
    const selection = proxyPool?.normalizeSelection(body) || null;
    const before = structuredClone(state);
    try {
    for (const entry of entries) {
      let account = state.accounts.find((row) => row.email === entry.email);
      const existing = Boolean(account);
      if (!account) { account = { id: crypto.randomUUID(), email: entry.email, source: entry.sourceRef ? "authorization" : "import", status: "queued", createdAt: stamp() }; state.accounts.push(account); putSecret(account, { credentials: {}, session: null }); }
      const payload = secret(account);
      if (!existing || body.updateExisting === true) {
        for (const field of ["password", "totpSecret", "mailApiUrl", "mailRequestBody"]) if (entry.credentials[field]) payload.credentials[field] = entry.credentials[field];
        if (entry.session) { teamIdentity(entry.session, account.email); payload.session = entry.session; }
      }
      if (entry.sourceRef) payload.sourceRef = entry.sourceRef;
      if (selection) { payload.proxyUrl = proxyPool.resolve(selection) || ""; payload.networkSet = true; }
      putSecret(account, payload);
      Object.assign(account, { status: "queued", hidden: false, restoreDeletedTeamIds: body.forceLogin === true ? [] : state.deletedTeams.map((row) => row.id), taskKind: body.forceLogin === true ? "login" : "connect", actorId, message: "等待登录与识别团队", errorCode: "", prompt: null, updatedAt: stamp(), hasCredentials: Boolean(payload.credentials.password || payload.credentials.mailApiUrl) });
      ids.push(account.id);
    }
    state.imports.push({ key, digest: bodyDigest, accountIds: ids }); state.imports = state.imports.slice(-200);
    await save();
    } catch (error) { state = before; throw error; }
    requestSchedule(); return { accounts: ids.map((id) => publicAccount(accountOf(id))) };
  }
  function addLog(team, actorId, action, message, status = "success") {
    (team.logs ||= []).unshift({ id: crypto.randomUUID(), actorId, action, message, status, at: stamp() });
    team.logs = team.logs.slice(0, 100);
  }
  function reconcileRequests(team, fresh) {
    for (const record of state.requests.filter((row) => row.teamId === team.id && row.status === "unknown")) {
      if (record.kind === "role" && fresh.members?.items.some((row) => row.id === record.memberId && row.email === record.memberEmail && row.role === record.role)) {
        record.status = "completed"; record.result = { success: true, memberEmail: record.memberEmail, role: record.role, reconciled: true, refreshErrors: {} };
        addLog(team, record.actorId, "role", `重新同步已确认 ${record.memberEmail} 的角色为${teamRoleLabel(record.role)}`);
      } else if (record.kind === "remove" && fresh.members && !fresh.members.items.some((row) => row.id === record.memberId)) {
        record.status = "completed"; record.result = { success: true, memberEmail: record.memberEmail, reconciled: true, refreshErrors: {} };
        addLog(team, record.actorId, "remove", "重新同步已确认目标成员不在团队中");
      } else if (record.kind === "invite" && record.targetEmails?.length && fresh.members && fresh.invites) {
        const members = new Set(fresh.members.items.map((row) => row.email)), invites = new Set(fresh.invites.items.map((row) => row.email));
        if (!record.targetEmails.every((email) => members.has(email) || invites.has(email))) continue;
        record.status = "completed";
        record.result = { teamId: team.id, requestKey: record.key, reconciled: true, refreshErrors: {}, results: record.targetEmails.map((email) => ({ email,
          status: members.has(email) ? "already_member" : "invited", message: members.has(email) ? "已在成员列表确认" : "已在待接受邀请列表确认" })) };
        addLog(team, record.actorId, "invite", `重新同步已确认 ${record.targetEmails.length} 个邮箱的邀请结果`);
      }
    }
  }
  function attach(account, found) {
    if (account.restoreDeletedTeamIds?.length) {
      const restored = new Set(found.map((row) => row.id));
      state.deletedTeams = state.deletedTeams.filter((row) => !account.restoreDeletedTeamIds.includes(row.id) || !restored.has(row.workspaceId));
    }
    delete account.restoreDeletedTeamIds;
    found = found.filter((row) => !state.deletedTeams.some((deleted) => deleted.workspaceId === row.id));
    const accessible = new Set(found.map((row) => row.id));
    for (const team of state.teams) if (team.accountIds.includes(account.id) && !accessible.has(team.workspaceId)) {
      team.accountIds = team.accountIds.filter((id) => id !== account.id); delete team.snapshots[account.id];
      if (team.selectedAccountId === account.id) team.selectedAccountId = team.accountIds[0] || null;
    }
    state.teams = state.teams.filter((team) => team.accountIds.length);
    for (const row of found) {
      let team = state.teams.find((item) => item.workspaceId === row.id);
      if (!team) { team = { id: crypto.randomUUID(), workspaceId: row.id, name: row.name, planType: row.planType, accountIds: [], snapshots: {}, selectedAccountId: account.id, logs: [] }; state.teams.push(team); }
      team.name = row.name; team.planType = row.planType;
      if (!team.accountIds.includes(account.id)) team.accountIds.push(account.id);
    }
    return found;
  }
  async function withClient(account, signal, action) {
    const payload = secret(account);
    teamIdentity(payload.session, account.email);
    const client = await clientFactory({ session: payload.session, email: account.email, proxyUrl: payload.proxyUrl || "", signal });
    try { return await action(client); }
    finally { await client.close(); }
  }
  async function updateSnapshot(client, account, team, discovered) {
    const fresh = await client.snapshot(discovered);
    const old = team.snapshots[account.id];
    const merged = { ...fresh };
    // Keep last successful sections visible, with explicit per-section stale errors.
    for (const section of ["members", "invites", "subscription"]) if (!fresh[section] && old?.[section]) merged[section] = old[section];
    if (fresh.errors.members) { merged.capabilities.canRemove = false; merged.capabilities.canInvite = false; merged.capabilities.canChangeRoles = false; }
    if (fresh.errors.invites || fresh.errors.subscription || fresh.errors.policy) merged.capabilities.canInvite = false;
    team.snapshots[account.id] = merged;
    if (fresh.subscription) team.lastSubscription = fresh.subscription;
    reconcileRequests(team, fresh);
    return fresh;
  }
  async function discoverAccount(account, run) {
    return withClient(account, run.controller.signal, async (client) => {
      let found = await client.discover();
      if (run.controller.signal.aborted) throw teamError("TEAM_CANCELLED");
      const discovered = found.length;
      found = attach(account, found);
      account.hidden = discovered > 0 && found.length === 0;
      let errors = 0;
      for (const discovered of found) {
        if (run.controller.signal.aborted || !canUse()) throw teamError("TEAM_CANCELLED");
        const team = state.teams.find((row) => row.workspaceId === discovered.id);
        const fresh = await updateSnapshot(client, account, team, discovered);
        if (Object.keys(fresh.errors).length) errors += 1;
        addLog(team, account.actorId, "sync", Object.keys(fresh.errors).length ? "部分信息同步失败，已保留可用数据" : "团队、成员、邀请与席位已同步", Object.keys(fresh.errors).length ? "partial" : "success");
      }
      return { found: found.length, errors };
    });
  }
  async function getSource(account, payload) {
    const sourceRef = payload.sourceRef || listSources().find((row) => row.email === account.email)?.id;
    if (!sourceRef) return null;
    return resolveSource(sourceRef, account.email);
  }
  function validRun(account, run) { return !closing && canUse() && !run.controller.signal.aborted && active.get(account.id) === run; }
  async function autoMailbox(account, run, prompt) {
    if (prompt.kind !== "email" || !run.payload.credentials.mailApiUrl) return;
    const until = now() + 180_000;
    while (validRun(account, run) && account.prompt?.id === prompt.id && !run.answer && now() < until) {
      try {
        const candidates = filterMailboxOtpCandidatesByRequestTime(await pollMailbox(run.payload.credentials.mailApiUrl, { timeoutMs: 10_000,
          request: { ...mailRequest(), body: run.payload.credentials.mailRequestBody } }), run.mailSentAt || run.startedAt)
          .filter((candidate) => !run.baseline.has(candidate.key) && (candidate.receivedAt || run.baselineKnown));
        const codes = [...new Set(candidates.map((candidate) => candidate.code))];
        if (codes.length > 1) return;
        if (codes.length === 1 && validRun(account, run) && account.prompt?.id === prompt.id && !run.answer) {
          for (const candidate of candidates) if (candidate.code === codes[0]) run.baseline.add(candidate.key);
          run.answer = { id: prompt.id, value: codes[0] }; requestSchedule(); return;
        }
      } catch { return; }
      await new Promise((resolve) => { const finish = () => { clearTimeout(timer); run.controller.signal.removeEventListener("abort", finish); resolve(); }; const timer = setTimeout(finish, 2000); run.controller.signal.addEventListener("abort", finish, { once: true }); });
    }
  }
  function launch(account) {
    const run = { email: account.email, controller: new AbortController(), slot: true, startedAt: now(), baseline: new Set(), baselineKnown: false };
    active.set(account.id, run); account.status = "running"; account.prompt = null; account.updatedAt = stamp();
    run.done = (async () => {
      if (account.sessionInvalidated && account.taskKind === "sync") throw teamError("TEAM_AUTH_EXPIRED");
      const payload = secret(account), source = await getSource(account, payload);
      for (const key of ["password", "totpSecret", "mailApiUrl", "mailRequestBody"]) payload.credentials[key] ||= source?.credentials?.[key] || "";
      if (!payload.networkSet) { payload.proxyUrl = source?.credentials?.proxyUrl || payload.proxyUrl || ""; payload.networkSet = true; }
      if (!payload.session) payload.session = source?.session || null;
      let usable = false;
      try { teamIdentity(payload.session, account.email); usable = true; } catch {}
      if (!usable && source?.session) { try { teamIdentity(source.session, account.email); payload.session = source.session; usable = true; } catch {} }
      if (account.taskKind === "login" || account.taskKind === "connect" && !usable) {
        if (!validRun(account, run)) throw teamError("TEAM_CANCELLED");
        if (payload.credentials.mailApiUrl) {
          try { run.baseline = new Set((await pollMailbox(payload.credentials.mailApiUrl, { timeoutMs: 10_000, request: { ...mailRequest(), body: payload.credentials.mailRequestBody } })).map((row) => row.key)); run.baselineKnown = true; } catch {}
        }
        run.payload = payload;
        run.handle = runLogin({ email: account.email, credentials: payload.credentials, proxyUrl: payload.proxyUrl, allowManualLogin: true }, {
          signal: run.controller.signal,
          onMailSent: (at) => { if (Number.isFinite(at)) run.mailSentAt = at; },
          onPrompt: (prompt) => {
            if (!validRun(account, run)) return;
            account.status = "waiting_input"; account.prompt = { id: prompt.id, kind: prompt.kind }; account.message = "请完成当前账号的登录验证"; run.slot = false;
            void save().catch(() => { run.controller.abort(); }); requestSchedule(); void autoMailbox(account, run, prompt);
          },
        });
        const result = await run.handle.done;
        if (!validRun(account, run)) throw teamError("TEAM_CANCELLED");
        teamIdentity(result?.session, account.email); payload.session = result.session;
        account.sessionInvalidated = false;
      }
      if (!validRun(account, run)) throw teamError("TEAM_CANCELLED");
      putSecret(account, payload); account.hasCredentials = Boolean(payload.credentials.password || payload.credentials.mailApiUrl);
      account.status = "running"; account.message = "正在识别团队和同步成员"; account.prompt = null; await save();
      const result = await discoverAccount(account, run);
      if (!validRun(account, run)) throw teamError("TEAM_CANCELLED");
      account.status = result.found ? "ready" : "no_team";
      account.message = result.found ? result.errors ? `${result.found} 个团队已识别，${result.errors} 个团队存在同步失败项` : `已同步 ${result.found} 个团队` : "该账号尚未发现可访问的 Team 空间";
      account.errorCode = "";
    })().catch((error) => {
      const safe = publicTeamError(error);
      const auth = error.code === "TEAM_AUTH_EXPIRED" || ["authorization_invalid", "token_expired"].includes(error.offerCode);
      account.status = account.sessionInvalidated || auth ? "auth_expired" : run.controller.signal.aborted ? "interrupted" : "failed";
      account.errorCode = account.sessionInvalidated || auth ? "TEAM_AUTH_EXPIRED" : safe.code;
      account.message = account.sessionInvalidated ? "所有设备已登出，请重新登录" : run.controller.signal.aborted ? "任务已停止，可重新识别或登录" : error.offerCode ? "账号登录未完成，请检查资料或重新登录" : safe.message;
    }).finally(async () => {
      account.prompt = null; account.updatedAt = stamp(); active.delete(account.id);
      await save(); if (!closing) requestSchedule();
    });
    // Scheduler callers do not await task execution; persistence failures must not become unhandled rejections.
    void run.done.catch(() => {});
  }
  function tick(slots = 3) {
    if (closing) return 0;
    if (!canUse()) { for (const run of [...active.values(), ...network.values()]) run.controller.abort(); return 0; }
    let started = 0;
    for (const [id, run] of active) if (run.answer && !run.slot && started < slots) {
      const account = accountOf(id); const answer = run.answer; run.answer = null; run.slot = true; account.status = "running"; account.prompt = null;
      try { run.handle.reply(answer.id, answer.value); } catch { run.controller.abort(); }
      started += 1;
    }
    for (const account of state.accounts) {
      if (started >= slots || [...active.values()].filter((run) => run.slot).length >= 3) break;
      if (account.status !== "queued" || isBusy(account.email) || isAccountBusy(account.email)) continue;
      if (state.teams.some((team) => team.accountIds.includes(account.id) && teamLocks.has(team.id))) continue;
      launch(account); started += 1;
    }
    return started;
  }
  async function queue(body, actorId, kind = "sync") {
    access();
    const ids = body.ids === undefined ? state.accounts.filter((row) => !row.hidden).map((row) => row.id) : body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || new Set(ids).size !== ids.length) throw fail("请选择不重复的团队管理账号");
    const accounts = ids.map(accountOf);
    if (accounts.some((account) => account.hidden)) throw fail("该账号的管理记录已删除，请重新导入后再操作", 409);
    if (accounts.some((account) => isBusy(account.email) || isAccountBusy(account.email) || LIVE.has(account.status))) throw fail("所选账号正在执行任务", 409);
    for (const account of accounts) Object.assign(account, { status: "queued", taskKind: kind, actorId, errorCode: "", message: kind === "login" ? "等待重新登录" : "等待重新识别团队", updatedAt: stamp(), prompt: null });
    await save(); requestSchedule(); return { queued: accounts.length };
  }
  function input(id, body) {
    access(); const account = accountOf(id), run = active.get(id);
    if (!run || account.status !== "waiting_input" || account.prompt?.id !== body.promptId || run.answer) throw fail("登录验证已变化，请刷新后重试", 409);
    const value = typeof body.value === "string" ? body.value : "";
    if (account.prompt.kind === "password" ? !value || value.length > 256 || /[\r\n]/.test(value) : !/^\d{6}$/.test(value) && !(account.prompt.kind === "email" && value === "r")) throw fail("请输入有效密码或六位验证码");
    run.answer = { id: body.promptId, value }; requestSchedule(); return { accepted: true };
  }
  async function cancel(id) {
    access(); const account = accountOf(id), run = active.get(id);
    if (run) { run.controller.abort(); await run.done; }
    else if (account.status === "queued") { account.status = "interrupted"; account.message = "任务已停止"; account.prompt = null; await save(); }
    return publicAccount(account);
  }
  async function deleteRecord(body) {
    access();
    const id = text(body.id), kind = body.kind;
    if (!id || !["team", "account"].includes(kind)) throw fail("请选择要删除的团队或账号记录");
    if (kind === "team" && state.deletedTeams.some((row) => row.id === id)) return { deleted: 0 };
    const team = kind === "team" ? teamOf(id) : null;
    const accounts = team ? team.accountIds.map(accountOf) : [accountOf(id)];
    if (!team && accounts[0].hidden) return { deleted: 0 };
    if (deleteBlocked(accounts, team?.id)) throw fail("团队或账号正在执行任务，请先停止任务或等待完成后再删除记录", 409);
    if (!team && state.teams.some((row) => row.accountIds.includes(id))) throw fail("该账号仍关联团队，请删除对应的团队记录", 409);
    const before = structuredClone(state);
    try {
      if (team) {
        state.deletedTeams.push({ id: team.id, workspaceId: team.workspaceId });
        state.teams = state.teams.filter((row) => row.id !== id);
        state.requests = state.requests.filter((row) => row.teamId !== id);
      } else state.requests = state.requests.filter((row) => row.accountId !== id);
      for (const account of accounts) if (!state.teams.some((row) => row.accountIds.includes(account.id))) account.hidden = true;
      await save();
    } catch (error) { state = before; throw error; }
    return { deleted: 1 };
  }
  function detail(id, body = {}) {
    access(); const team = teamOf(id), view = publicTeam(team, body.accountId);
    const snapshot = team.snapshots[view.accountId];
    const query = text(body.search).toLowerCase();
    const all = (body.tab === "invites" ? snapshot?.invites?.items : snapshot?.members?.items) || [];
    const current = snapshot?.members?.items.find((member) => member.id === snapshot?.capabilities?.currentMemberId);
    const items = all.filter((row) => !query || `${row.email} ${row.name || ""}`.toLowerCase().includes(query)).map((row) => body.tab === "invites" ? row : { ...row,
      canRemove: !row.scimManaged && !snapshot?.errors?.members && teamCanRemove(snapshot?.capabilities?.role, row, current),
      roleChoices: !snapshot?.errors?.members ? teamRoleChoices(snapshot?.capabilities?.role, row, current, snapshot?.members?.items) : [] });
    const pages = Math.max(1, Math.ceil(items.length / 20)), page = Math.min(pages, Math.max(1, Number.isSafeInteger(body.page) ? body.page : 1));
    return { team: view, items: items.slice((page - 1) * 20, page * 20), total: items.length, page, pages };
  }
  async function selectAccount(id, accountId, actorId) {
    access(); const team = teamOf(id);
    if (teamLocks.has(id)) throw fail("团队操作正在执行，请完成后再切换账号", 409);
    publicTeam(team, accountId); team.selectedAccountId = accountId; await save();
    if (team.snapshots[accountId]?.errors?.members?.code === "TEAM_REFRESH_REQUIRED") await queue({ ids: [accountId] }, actorId || accountOf(accountId).actorId);
    return publicTeam(team);
  }
  function invitePreview(id, body) {
    access(); const team = teamOf(id), view = publicTeam(team, body.accountId);
    const snapshot = team.snapshots[view.accountId], emails = parseTeamEmails(body.emails);
    const members = new Set((snapshot?.members?.items || []).map((row) => row.email));
    const pending = new Set((snapshot?.invites?.items || []).map((row) => row.email));
    const results = emails.map((email) => ({ email, status: members.has(email) ? "already_member" : pending.has(email) ? "already_invited" : "new" }));
    const added = results.filter((row) => row.status === "new").length;
    const available = snapshot?.subscription?.pools?.default?.available ?? null;
    const pendingSeats = (snapshot?.invites?.items || []).filter((row) => row.seatType === "default").length;
    const capacityOk = added === 0 || typeof available === "number" && pendingSeats + added <= available && snapshot?.subscription?.active !== false;
    return { results, added, available, pendingSeats, capacityOk, canInvite: Boolean(snapshot?.capabilities?.canInvite && !view.stale && capacityOk),
      reason: !snapshot?.capabilities?.canInvite ? snapshot?.capabilities?.inviteReason || "请先同步团队信息" : !capacityOk ? "空闲席位不足（含待接受邀请），请减少新增邮箱数量" : view.stale ? "团队信息存在同步失败项，请先同步" : "" };
  }
  async function mutate(id, body, actorId, kind) {
    if (!["invite", "remove", "role"].includes(kind)) throw fail("团队操作不存在", 404);
    access(); const team = teamOf(id), account = accountOf(body.accountId || team.selectedAccountId);
    if (!team.accountIds.includes(account.id)) throw fail("账号与目标团队不匹配", 403);
    const key = requestKey(body), emails = kind === "invite" ? parseTeamEmails(body.emails) : null;
    if (["remove", "role"].includes(kind) && (!text(body.memberId) || !validEmail(teamEmail(body.memberEmail)))) throw fail("缺少目标成员身份，请重新打开确认框");
    if (kind === "role" && (!["account-owner", "standard-user"].includes(body.role) || !text(body.previousRole))) throw fail("请选择所有者或普通成员，并重新确认当前角色");
    const digest = hash({ id, accountId: account.id, kind, emails, memberId: body.memberId, memberEmail: teamEmail(body.memberEmail), ...(kind === "role" ? { role: body.role, previousRole: body.previousRole } : {}) });
    const previous = state.requests.find((row) => row.key === key);
    if (previous) {
      if (previous.digest !== digest) throw fail("同一请求标识不能用于其他团队操作", 409);
      if (previous.status === "completed") return previous.result;
      throw fail(previous.status === "running" ? "该操作正在执行，请稍后查看" : "该操作尚未确认成功，请先同步核对，不要重复提交", 409);
    }
    if (state.requests.some((row) => row.teamId === id && row.status === "unknown" && (kind === "invite" ? row.kind === kind && row.targetEmails?.some((email) => emails.includes(email)) : row.memberId === body.memberId))) throw fail("该成员或邮箱存在尚未确认的操作，请先同步团队核对", 409);
    if (teamLocks.has(id) || team.accountIds.some((id) => isBusy(accountOf(id).email) || LIVE.has(accountOf(id).status)) || isAccountBusy(account.email)) throw fail("团队或账号正在执行任务，请稍后重试", 409);
    if (network.size >= 3) throw fail("当前有多个团队操作，请稍后重试", 409);
    const run = { email: account.email, controller: new AbortController() };
    teamLocks.add(id); network.set(key, run);
    const record = { key, digest, status: "running", kind, teamId: id, accountId: account.id, actorId, memberId: body.memberId, memberEmail: teamEmail(body.memberEmail), role: kind === "role" ? body.role : undefined, at: stamp() };
    state.requests.push(record); state.requests = state.requests.slice(-1000);
    const task = (async () => {
      await save();
      return withClient(account, run.controller.signal, async (client) => {
        const discovered = (await client.discover()).find((row) => row.id === team.workspaceId);
        if (!discovered) throw teamError("TEAM_NOT_FOUND", 404);
        const fresh = await updateSnapshot(client, account, team, discovered);
        if (run.controller.signal.aborted || !canUse()) throw teamError("TEAM_CANCELLED");
        let result;
        if (kind === "invite") {
          if (!fresh.capabilities.canInvite || fresh.errors.members || fresh.errors.invites || fresh.errors.subscription || fresh.errors.policy) throw fail(fresh.capabilities.inviteReason || "邀请所需信息尚未完整同步", 409);
          const existing = new Set(fresh.members.items.map((row) => row.email)), pending = new Set(fresh.invites.items.map((row) => row.email));
          const actionable = emails.filter((email) => !existing.has(email) && !pending.has(email));
          const pool = fresh.subscription.pools.default;
          const pendingSeats = fresh.invites.items.filter((row) => row.seatType === "default").length;
          if (actionable.length && (pool.available === null || actionable.length + pendingSeats > pool.available || fresh.subscription.active === false)) throw fail("当前标准席位不足（含待接受邀请），请减少邮箱数量或先在官方页面处理席位", 409);
          const results = emails.filter((email) => existing.has(email) || pending.has(email)).map((email) => ({ email, status: existing.has(email) ? "already_member" : "already_invited", message: existing.has(email) ? "已是成员，已跳过" : "已有待接受邀请，已跳过" }));
          if (actionable.length) {
            record.targetEmails = actionable; record.mutationStarted = true; await save();
            if (run.controller.signal.aborted || !canUse()) throw teamError("TEAM_CANCELLED");
            const response = await client.invite(team.workspaceId, actionable, key);
            if (!["account_invites", "errored_emails", "already_member_emails"].every((field) => Array.isArray(response[field]))) throw teamError("TEAM_RESPONSE", 502, true);
            const emailsOf = (list) => new Set(list.map((row) => teamEmail(typeof row === "string" ? row : row?.email_address || row?.email)).filter(Boolean));
            const successful = emailsOf(response.account_invites), failed = emailsOf(response.errored_emails), already = emailsOf(response.already_member_emails);
            for (const email of actionable) {
              const status = failed.has(email) ? "failed" : already.has(email) ? "already_member" : successful.has(email) ? "invited" : "unknown";
              results.push({ email, status, message: ({ invited: "邀请已发送，等待接受", already_member: "已是团队成员", failed: "邀请失败，可重试", unknown: "结果未确认，请先同步邀请列表" })[status] });
            }
          }
          result = { results, teamId: id, requestKey: key };
        } else if (kind === "role") {
          if (!fresh.members || fresh.errors.members || !fresh.capabilities.canChangeRoles) throw fail("只有已确认的团队所有者可以修改角色", 403);
          const target = fresh.members.items.find((row) => row.id === body.memberId), current = fresh.members.items.find((row) => row.id === fresh.capabilities.currentMemberId);
          if (!target || target.email !== teamEmail(body.memberEmail)) throw fail("成员身份已变化，请重新确认", 409);
          if (target.role !== body.previousRole) throw fail("成员当前角色已变化，请重新同步并确认", 409);
          if (!teamRoleChoices(fresh.capabilities.role, target, current, fresh.members.items).includes(body.role)) throw fail(target.role === "account-owner" && fresh.members.items.filter((row) => row.role === "account-owner").length <= 1 ? "不能降级最后一位所有者，请先让账号2加入并设置为所有者" : "当前成员的角色不允许修改", 403);
          record.mutationStarted = true; await save();
          if (run.controller.signal.aborted || !canUse()) throw teamError("TEAM_CANCELLED");
          const response = await client.setRole(team.workspaceId, target.id, body.role);
          if (response.success !== true) throw teamError("TEAM_RESPONSE", 502, true);
          result = { success: true, memberEmail: target.email, role: body.role, selfChanged: target.id === current.id };
        } else {
          if (!fresh.members || fresh.errors.members || !fresh.capabilities.canRemove) throw fail("当前账号没有移除此成员的权限，或成员信息未同步", 403);
          const target = fresh.members.items.find((row) => row.id === body.memberId);
          if (!target) result = { success: true, alreadyRemoved: true, memberEmail: teamEmail(body.memberEmail) };
          else {
            const current = fresh.members.items.find((row) => row.id === fresh.capabilities.currentMemberId);
            if (target.email !== teamEmail(body.memberEmail)) throw fail("成员身份已变化，请重新确认", 409);
            if (target.scimManaged || !teamCanRemove(fresh.capabilities.role, target, current)) throw fail("当前账号、所有者或此角色的成员不允许移除", 403);
            record.mutationStarted = true; await save();
            if (run.controller.signal.aborted || !canUse()) throw teamError("TEAM_CANCELLED");
            const response = await client.remove(team.workspaceId, target.id);
            if (response.success !== true) throw teamError("TEAM_RESPONSE", 502, true);
            result = { success: true, memberEmail: target.email, hasBillingNotice: Boolean(response.billing_notice), hasPolicyNotice: Boolean(response.policy_notice) };
          }
        }
        const after = await updateSnapshot(client, account, team, discovered).catch((error) => {
          const failure = publicTeamError(error), snapshot = team.snapshots[account.id];
          if (snapshot) { snapshot.errors.refresh = failure; snapshot.capabilities.canInvite = false; snapshot.capabilities.canChangeRoles = false; if (error.code === "TEAM_AUTH_EXPIRED") snapshot.capabilities.canRemove = false; }
          if (error.code === "TEAM_AUTH_EXPIRED") { account.status = "auth_expired"; account.errorCode = error.code; }
          return { errors: { refresh: failure } };
        });
        result.refreshErrors = after.errors;
        if (kind === "remove" && result.success && after.members?.items.some((row) => row.id === body.memberId)) result.verifying = true;
        if (kind === "role" && !after.members?.items.some((row) => row.id === body.memberId && row.role === body.role)) result.verifying = true;
        if (["role", "remove"].includes(kind)) {
          for (const otherId of [...team.accountIds]) {
            if (otherId === account.id) continue;
            const peer = accountOf(otherId), snapshot = team.snapshots[otherId];
            if (kind === "remove" && peer.email === teamEmail(body.memberEmail) && after.members && !after.members.items.some((row) => row.email === peer.email)) {
              team.accountIds = team.accountIds.filter((id) => id !== otherId); delete team.snapshots[otherId];
              if (team.selectedAccountId === otherId) team.selectedAccountId = account.id;
              peer.message = "该账号已从此团队移除，其他团队与账号资料保留";
            } else if (snapshot) {
              const identity = after.members?.items.find((row) => row.email === peer.email);
              if (identity && after.members && !after.errors.members) {
                snapshot.members = after.members;
                snapshot.capabilities.role = identity.role; snapshot.capabilities.roleLabel = identity.roleLabel;
                snapshot.capabilities.canRemove = ["account-owner", "account-admin"].includes(identity.role);
                snapshot.capabilities.canChangeRoles = identity.role === "account-owner";
                snapshot.capabilities.currentMemberId = identity.id;
              }
              snapshot.errors.members = { code: "TEAM_REFRESH_REQUIRED", message: "团队成员或角色已变化，请使用当前管理账号重新同步" };
              snapshot.capabilities.canInvite = false; snapshot.capabilities.canRemove = false; snapshot.capabilities.canChangeRoles = false;
            }
          }
        }
        if (account.status !== "auth_expired") account.status = "ready";
        account.message = Object.keys(after.errors).length ? "操作已返回，部分数据仍需重新同步" : "团队信息已同步"; account.updatedAt = stamp();
        record.status = result.verifying || result.results?.some((row) => row.status === "unknown") ? "unknown" : "completed"; record.result = result;
        addLog(team, actorId, kind, kind === "invite" ? `处理 ${emails.length} 个邀请邮箱，成功 ${result.results.filter((row) => row.status === "invited").length} 个` : kind === "role" ? `将 ${teamEmail(body.memberEmail)} 修改为${teamRoleLabel(body.role)}${result.verifying ? "，等待确认" : ""}` : `移除成员 ${teamEmail(body.memberEmail)}${result.verifying ? "，等待列表确认" : ""}`, Object.keys(after.errors).length || result.verifying || result.results?.some((row) => ["failed", "unknown"].includes(row.status)) ? "partial" : "success");
        await save(); return result;
      });
    })().catch(async (error) => {
      record.status = record.mutationStarted && (error.uncertain || error.code === "TEAM_CANCELLED") ? "unknown" : "failed";
      if (error.code === "TEAM_AUTH_EXPIRED") { account.status = "auth_expired"; account.message = error.message; }
      addLog(team, actorId, kind, record.status === "unknown" ? "操作结果不明，请先同步核对" : error.code ? publicTeamError(error).message : "操作未执行，请检查成员权限或席位", record.status);
      await save(); throw error;
    }).finally(() => { teamLocks.delete(id); network.delete(key); requestSchedule(); });
    run.done = task; return task;
  }
  async function invalidate(email) {
    const account = state.accounts.find((row) => row.email === teamEmail(email));
    if (!account) return;
    active.get(account.id)?.controller.abort();
    for (const run of network.values()) if (run.email === account.email) run.controller.abort();
    const payload = secret(account); payload.session = null; putSecret(account, payload);
    account.sessionInvalidated = true;
    account.status = "auth_expired"; account.message = "所有设备已登出，请重新登录"; account.errorCode = "TEAM_AUTH_EXPIRED"; account.prompt = null;
    await save();
  }
  async function stopAll() {
    for (const run of [...active.values(), ...network.values()]) run.controller.abort();
    for (const account of state.accounts) if (account.status === "queued") { account.status = "interrupted"; account.message = "任务已停止"; account.prompt = null; }
    await Promise.allSettled([...active.values(), ...network.values()].map((run) => run.done)); await save();
  }
  async function shutdown() { closing = true; await stopAll(); await writes; }
  return { query, sources, preview, importAccounts, queue, input, cancel, deleteRecord, detail, selectAccount, invitePreview, mutate, tick, isBusy, invalidate, stopAll, shutdown,
    planImport, inventory: () => state.accounts.map((row) => row.email),
    hasAccount: (email) => state.accounts.some((row) => row.email === teamEmail(email)),
    activeCount: () => [...active.values()].filter((run) => run.slot).length + network.size,
    pendingCount: () => state.accounts.filter((row) => row.status === "queued").length };
}
