import http from "node:http";

export const TEAM_A = "11111111-1111-4111-8111-111111111111";
export const TEAM_B = "22222222-2222-4222-8222-222222222222";
export const fixtureToken = (email, extra = {}) => `e30.${Buffer.from(JSON.stringify({ email, exp: Math.floor(Date.now() / 1000) + 3600,
  "https://api.openai.com/auth": { chatgpt_account_id: "personal-fixture" }, ...extra })).toString("base64url")}.fixture-private-access-token`;
export function fixtureSession(email, base, extra = {}) { return { type: "chatgpt-session", version: 1, email, accessToken: fixtureToken(email), deviceId: "fixture-stable-device", chatgptBase: base, ...extra }; }
const member = (email, role, index) => ({ id: `user-${index}`, account_user_id: `membership-${index}`, email, name: `成员 ${index}`, role,
  seat_type: "default", created_time: "2026-11-27T02:00:00Z", is_scim_managed: false });
export async function createTeamFixture() {
  const state = { requests: [], partial: false, clamp: 100, failModule: "", failDiscovery: false, mode: "prepurchase", nextInvite: "", nextRemove: "", nextRole: "", defaultSeat: "default", mailAt: null,
    spaces: new Map([
      [TEAM_A, { name: "协作团队", purchased: 10, premium: 0, invites: [], members: [member("owner@example.com", "account-owner", "owner"), member("other-owner@example.com", "account-owner", "other-owner"), member("admin@example.com", "account-admin", "admin"), member("member@example.com", "standard-user", "member"), member("viewer@example.com", "analytics-viewer", "viewer")] }],
      [TEAM_B, { name: "研究团队", purchased: 40, premium: 0, invites: [], members: [member("owner@example.com", "account-owner", "owner-b"), ...Array.from({ length: 25 }, (_, i) => member(`research-${i}@example.com`, "standard-user", `research-${i}`))] }],
    ]) };
  const server = http.createServer((req, res) => { void handle(req, res).catch(() => { res.writeHead(500); res.end('{}'); }); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function handle(req, res) {
    const url = new URL(req.url, base), chunks = []; for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString();
    const body = rawBody ? req.headers["content-type"]?.includes("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(rawBody)) : JSON.parse(rawBody) : null;
    let email = ""; try { email = JSON.parse(Buffer.from(req.headers.authorization?.split(".")[1] || "", "base64url")).email || ""; } catch {}
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), email, workspace: req.headers["chatgpt-account-id"], device: req.headers["oai-device-id"], body });
    const send = (data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    const cookieEmail = /fixture_email=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    const loginEmail = cookieEmail ? Buffer.from(cookieEmail, "base64url").toString() : "";
    if (url.pathname === "/mail/team-auto") return send({ data: { code: state.mailAt ? "001234" : "999999", message_id: state.mailAt ? "fresh" : "old", received_at: new Date(state.mailAt || Date.now() - 3600000).toISOString() } });
    if (url.pathname === "/") { res.setHeader("set-cookie", ["__Host-next-auth.csrf-token=fixture; Path=/", "oai-did=fixture-stable-device; Path=/"]); return send({}); }
    if (url.pathname === "/api/auth/providers") return send({});
    if (url.pathname === "/api/auth/csrf") return send({ csrfToken: "fixture" });
    if (url.pathname === "/api/auth/signin/openai") {
      const target = url.searchParams.get("login_hint");
      res.setHeader("set-cookie", `fixture_email=${Buffer.from(target).toString("base64url")}; Path=/`);
      return send({ url: `${base}/${["manual@example.com", "auto@example.com"].includes(target) ? "email-verification" : "log-in/password"}` });
    }
    if (["/log-in/password", "/email-verification"].includes(url.pathname)) { if (url.pathname === "/email-verification" && loginEmail === "auto@example.com") state.mailAt = Date.now(); return send({}); }
    if (url.pathname === "/api/accounts/password/verify") return body.password === "fixture-private-password" ? send({ continue_url: `${base}/login-callback` }) : send({ error: { code: "incorrect_password" } }, 400);
    if (url.pathname === "/api/accounts/email-otp/validate") return body.code === "001234" ? send({ continue_url: `${base}/login-callback` }) : send({ error: { code: "wrong_email_otp_code" } }, 400);
    if (url.pathname === "/api/accounts/email-otp/resend") return send({});
    if (url.pathname === "/login-callback") { res.setHeader("set-cookie", "__Secure-next-auth.session-token=fixture; Path=/"); return send({}); }
    if (url.pathname === "/api/auth/session") return send({ user: { email: loginEmail }, accessToken: fixtureToken(loginEmail), expires: "2099-01-01T00:00:00Z" });
    if (!email || email.startsWith("expired")) return send({}, 401);
    if (url.pathname === "/backend-api/accounts/check/v4-2023-04-27") {
      if (state.failDiscovery) return send({}, 401);
      const accounts = { default: { account: { account_id: "personal-fixture", structure: "personal", plan_type: "free" } } };
      for (const [id, space] of state.spaces) {
        const current = space.members.find((row) => row.email === email); if (!current) continue;
        accounts[id] = { account: { account_id: id, name: space.name, structure: "workspace", plan_type: "team", account_user_role: current.role, account_user_id: current.account_user_id }, can_access_with_session: true };
      }
      return send({ accounts });
    }
    const id = url.pathname === "/backend-api/subscriptions" ? url.searchParams.get("account_id") : /^\/backend-api\/accounts\/([^/]+)/.exec(url.pathname)?.[1] || req.headers["chatgpt-account-id"];
    const space = state.spaces.get(id);
    if (!space || !space.members.some((row) => row.email === email) || req.headers["chatgpt-account-id"] !== id) return send({}, 403);
    if (state.failModule && url.pathname.endsWith(state.failModule)) return send({}, 503);
    if (url.pathname === "/backend-api/subscriptions") return send({ account_id: id, plan_type: "team", is_active: true, seats_in_use: space.members.length, seats_entitled: space.purchased,
      seat_capacity: [{ type: "default", paid: space.purchased, held: 0, available: Math.max(0, space.purchased - space.members.length) }, { type: "prolite", paid: space.premium, held: 0, available: space.premium }], assigned: { default: space.members.length, prolite: 0 },
      entitlement: { expires_at: "2026-12-27T00:00:00Z", renews_at: "2026-12-27T00:00:00Z", discount: { discount_expires_at: "2026-12-01T00:00:00Z" } }, will_renew: true, billing_period: "month" });
    if (url.pathname.endsWith("/settings")) return send({ default_seat_type: state.defaultSeat });
    if (url.pathname === "/backend-api/pageConfigs/billing") return send({ invite_prepurchase: { workspace_id: id, invite_purchase_mode: state.mode } });
    if (req.method === "GET" && (/\/users$/.test(url.pathname) || /\/invites$/.test(url.pathname))) {
      const items = url.pathname.endsWith("/users") ? space.members : space.invites;
      const offset = Number(url.searchParams.get("offset") || 0), limit = Math.min(state.clamp, Number(url.searchParams.get("limit") || 100));
      return send({ items: items.slice(offset, offset + limit), total: items.length, limit, offset, has_more: offset + limit < items.length });
    }
    if (req.method === "POST" && url.pathname.endsWith("/invites")) {
      const response = { account_invites: [], errored_emails: [], already_member_emails: [] };
      for (const address of body.email_addresses || []) {
        if (space.members.some((row) => row.email === address)) response.already_member_emails.push(address);
        else if (address.startsWith("fail")) response.errored_emails.push({ email_address: address, error: "upstream-private-diagnostic-must-not-leak" });
        else {
          const row = { id: `invite-${space.invites.length}`, email_address: address, role: "standard-user", seat_type: "default", status: 0, created_time: new Date().toISOString() };
          space.invites.push(row); response.account_invites.push(row);
        }
      }
      if (state.nextInvite === "disconnect") { state.nextInvite = ""; req.socket.destroy(); return; }
      return send(response);
    }
    if (req.method === "PATCH" && /\/users\/[^/]+$/.test(url.pathname)) {
      const actor = space.members.find((row) => row.email === email), target = space.members.find((row) => row.id === url.pathname.split("/").at(-1));
      if (actor?.role !== "account-owner" || !target || !["account-owner", "standard-user"].includes(body.role)) return send({}, 403);
      if (target.role === "account-owner" && body.role !== "account-owner" && space.members.filter((row) => row.role === "account-owner").length <= 1) return send({}, 409);
      target.role = body.role;
      if (state.nextRole === "disconnect") { state.nextRole = ""; req.socket.destroy(); return; }
      return send({ success: true });
    }
    if (req.method === "DELETE" && /\/users\/[^/]+$/.test(url.pathname)) {
      const targetId = url.pathname.split("/").at(-1); space.members = space.members.filter((row) => row.id !== targetId);
      if (state.nextRemove === "disconnect") { state.nextRemove = ""; req.socket.destroy(); return; }
      return send({ success: true, billing_notice: null, policy_notice: null });
    }
    send({ unexpected: true }, 404);
  }
  return { base, state, server, close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
