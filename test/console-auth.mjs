import crypto from "node:crypto";

process.env.TOSUB2_ADMIN_CDK = "isolated-console-regression-administrator";
process.env.TOSUB2_ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("base64");
const originalFetch = globalThis.fetch;
const sessions = new Map();

globalThis.fetch = async function consoleFixtureFetch(input, options = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  const session = sessions.get(url.origin);
  const headers = new Headers(options.headers || {});
  if (session && (headers.has("x-console-token") || url.pathname === "/api/bootstrap")) {
    if (!headers.has("cookie")) headers.set("cookie", session.cookie);
  }
  if (options.method === "POST" && ["/api/jobs", "/api/jobs/batch", "/api/mfa/import"].includes(url.pathname) && !headers.has("idempotency-key")) headers.set("idempotency-key", crypto.randomUUID());
  const response = await originalFetch(input, { ...options, headers });
  if (url.pathname === "/api/bootstrap" && response.ok) {
    const data = await response.clone().json();
    if (data.authenticated === false) {
      const login = await originalFetch(`${url.origin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cdk: process.env.TOSUB2_ADMIN_CDK }) });
      if (!login.ok) return login;
      const authenticated = await login.clone().json();
      sessions.set(url.origin, { cookie: login.headers.get("set-cookie").split(";")[0], token: authenticated.token });
      return login;
    }
  }
  return response;
};
