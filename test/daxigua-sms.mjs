import assert from "node:assert/strict";
import { createDaXiGuaSmsClient, DaXiGuaSmsError } from "../src/daxigua-sms.mjs";
import { createSmsProvider } from "../src/sms-providers.mjs";

const requests = [];
let createAttempts = 0;
let orderReads = 0;
const fetchImpl = async (url, options) => {
  const request = new URL(url);
  requests.push({ request, options });
  assert.equal(request.origin, "https://tibosb.site");
  assert.equal(options.headers.authorization, "Bearer test-daxigua-key");
  assert.equal(options.redirect, "error");
  if (request.pathname === "/api/v1/services") return success({ services: [
    { id: 2, name: "Chat GPT", country: "kh", project: "chatgpt", uses: 1 },
    { id: 3, name: "Chat GPT US", country: "us", project: "chatgpt", uses: 2 },
    { id: "bad", name: "Broken", country: "", project: "chatgpt", uses: 0 },
  ] });
  if (request.pathname === "/api/v1/orders" && options.method === "POST") {
    createAttempts++;
    assert.equal(options.headers["content-type"], "application/json");
    assert.match(options.headers["idempotency-key"], /^tosub2-[0-9a-f-]{36}$/);
    assert.deepEqual(JSON.parse(options.body), { country: "kh", project: "chatgpt" });
    if (createAttempts === 1) throw new Error("fixture network interruption");
    return success(order("creating"), 202);
  }
  if (request.pathname === "/api/v1/orders/123" && options.method === "GET") {
    orderReads++;
    if (orderReads === 1) return success(order("creating"));
    if (orderReads === 2) return success(order("assigned", { phone_number: "85512345678" }));
    return success(order("received", { phone_number: "+85512345678", sms_content: "Your ChatGPT verification code is 654321" }));
  }
  if (request.pathname === "/api/v1/orders/123/cancel" && options.method === "POST") return success(order("cancelled", { phone_number: "+85512345678" }));
  throw new Error(`Unexpected request ${options.method} ${request}`);
};

const client = createDaXiGuaSmsClient({ apiKey: "test-daxigua-key", fetchImpl, sleep: async () => {} });
assert.deepEqual(await client.getServiceOptions(), [
  { serviceId: "2", country: "kh", project: "chatgpt", uses: 1, title: "Chat GPT", label: "Chat GPT / kh", price: 1, count: 1, currency: "次" },
  { serviceId: "3", country: "us", project: "chatgpt", uses: 2, title: "Chat GPT US", label: "Chat GPT US / us", price: 2, count: 1, currency: "次" },
]);
const acquired = await client.getNumber("kh", "chatgpt");
assert.deepEqual({ requestId: acquired.requestId, number: acquired.number }, { requestId: "123", number: "+85512345678" });
assert.equal(acquired.createdAt, "2026-10-30T00:00:00.000Z");
const createRequests = requests.filter(({ request }) => request.pathname === "/api/v1/orders");
assert.equal(createRequests.length, 2);
assert.equal(createRequests[0].options.headers["idempotency-key"], createRequests[1].options.headers["idempotency-key"], "network retry must reuse one idempotency key");
assert.deepEqual(await client.getSms("123"), { status: "received", code: "654321" });
assert.deepEqual(await client.inspect("123"), { state: "received", hasSms: true });
assert.deepEqual(await client.cancelStrict("123"), { requestId: "123", cancelled: true, receipt: "cancelled", refundStatus: "confirmed", refundEvidence: "daxigua:123:cancelled" });

const providerFetch = async (url, options) => {
  const request = new URL(url);
  if (request.pathname === "/api/v1/services") return success({ services: [{ id: 2, name: "Chat GPT", country: "kh", project: "chatgpt", uses: 1 }] });
  if (request.pathname === "/api/v1/orders" && options.method === "POST") return success(order("assigned", { phone_number: "+85512345678" }), 202);
  if (request.pathname === "/api/v1/orders/123") return success(order("received", { phone_number: "+85512345678", sms_content: "Code 654321" }));
  if (request.pathname.endsWith("/cancel")) return success(order("cancelled", { phone_number: "+85512345678" }));
  throw new Error(`Unexpected provider request ${options.method} ${request}`);
};
const provider = createSmsProvider("daxigua", {
  apiKey: "test-daxigua-key", serviceId: "2", country: "kh", project: "chatgpt", uses: "1", countryLabel: "Chat GPT / kh / 1 次",
}, { fetchImpl: providerFetch, sleep: async () => {} });
assert.equal(provider.name, "大西瓜接码");
assert.equal(provider.serviceLabel, "Chat GPT / kh / 1 次");
assert.deepEqual((await provider.listNumberOptions()).map(({ serviceId }) => serviceId), ["2"]);
assert.deepEqual(await provider.getNumber(), { requestId: "123", number: "+85512345678", createdAt: "2026-10-30T00:00:00.000Z", createdAtSource: "provider" });
assert.deepEqual(await provider.getSms("123"), { status: "received", code: "654321" });
assert.throws(() => createSmsProvider("daxigua", { apiKey: "short" }), /API Key/);
assert.throws(() => createSmsProvider("daxigua", { apiKey: "test-daxigua-key", country: "kh space", project: "chatgpt" }), /重新查询/);
assert.throws(() => createSmsProvider("daxigua", { apiKey: "test-daxigua-key" }).getNumber(), /先查询并选择/);

let clock = 0;
let assigned = false;
let pendingCreates = 0;
const pendingClient = createDaXiGuaSmsClient({
  apiKey: "test-daxigua-key", assignmentTimeoutMs: 20, pollIntervalMs: 10, now: () => clock,
  sleep: async (milliseconds) => { clock += milliseconds; },
  fetchImpl: async (url) => {
    if (new URL(url).pathname === "/api/v1/orders") { pendingCreates++; return success(order("creating"), 202); }
    return success(order(assigned ? "assigned" : "creating", { phone_number: assigned ? "+85512345678" : "" }));
  },
});
await assert.rejects(() => pendingClient.getNumber("kh", "chatgpt"), (error) => (
  error instanceof DaXiGuaSmsError && error.code === "ORDER_PENDING" && error.order?.requestId === "123" && /勿重复/.test(error.message)
));
assigned = true;
assert.equal((await pendingClient.getNumber("kh", "chatgpt")).requestId, "123");
assert.equal(pendingCreates, 1, "assignment timeout followed by a retry queries the original order without another purchase");

for (const [payload, status, code, terminal, message] of [
  [{ success: false, error: { code: "unauthorized", message: "invalid" } }, 401, "UNAUTHORIZED", true, /API Key/],
  [{ success: false, error: { code: "insufficient_uses", message: "none" } }, 409, "INSUFFICIENT_USES", true, /次数不足/],
  [{ success: false, error: { code: "rate_limited", message: "slow" } }, 429, "RATE_LIMITED", false, /频繁/],
]) {
  const failed = createDaXiGuaSmsClient({ apiKey: "test-daxigua-key", sleep: async () => {}, fetchImpl: async () => json(payload, status, { "retry-after": "2" }) });
  await assert.rejects(() => failed.getServiceOptions(), (error) => error.code === code && error.terminal === terminal && message.test(error.message) && (status !== 429 || error.retryAfterMs === 2000));
}

const noCode = createDaXiGuaSmsClient({ apiKey: "test-daxigua-key", fetchImpl: async () => success(order("received", { phone_number: "+85512345678", sms_content: "Order 123456789" })) });
await assert.rejects(() => noCode.getSms("123"), /独立的 6 位/);
const review = createDaXiGuaSmsClient({ apiKey: "test-daxigua-key", fetchImpl: async () => success(order("review", { failure_reason: "fixture review" })) });
await assert.rejects(() => review.getSms("123"), (error) => error.code === "ORDER_REVIEW" && error.terminal && /fixture review/.test(error.message));
await assert.rejects(() => review.getNumber("kh", "chatgpt"), (error) => error.manualReview && /次数仍冻结/.test(error.message));
const reflected = createDaXiGuaSmsClient({ apiKey: "secret-daxigua-key", fetchImpl: async () => { throw new Error("Bearer secret-daxigua-key"); } });
await assert.rejects(() => reflected.getServiceOptions(), (error) => !error.message.includes("secret-daxigua-key") && error.message.includes("[redacted]"));
assert.equal(createDaXiGuaSmsClient(), null);
assert.throws(() => createDaXiGuaSmsClient({ apiKey: "test-daxigua-key", apiBase: "file:///tmp/api" }), /HTTP 或 HTTPS/);

for (const format of ["json", "html"]) {
  let time = 0; const posts = [];
  const rateLimited = createDaXiGuaSmsClient({
    apiKey: "test-daxigua-key", now: () => time, sleep: async (milliseconds) => { time += milliseconds; },
    fetchImpl: async (_url, options) => {
      posts.push({ time, key: options.headers["idempotency-key"] });
      if (posts.length === 1) return format === "json"
        ? json({ success: false, error: { code: "rate_limited" } }, 429, { "retry-after": "12" })
        : new Response("rate limited", { status: 429, headers: { "retry-after": "12" } });
      return success(order("assigned", { phone_number: "+85512345678" }), 202);
    },
  });
  await rateLimited.getNumber("kh", "chatgpt");
  assert.deepEqual(posts.map(({ time }) => time), [0, 12000], "Retry-After must not be shortened to five seconds, including non-JSON rate limit responses");
  assert.equal(posts[0].key, posts[1].key);
}

let readTime = 0; const readTimes = [];
const readLimited = createDaXiGuaSmsClient({
  apiKey: "test-daxigua-key", now: () => readTime, sleep: async (milliseconds) => { readTime += milliseconds; },
  fetchImpl: async () => {
    readTimes.push(readTime);
    return readTimes.length === 1 ? json({ success: false, error: { code: "rate_limited" } }, 429, { "retry-after": "8" }) : success(order("assigned"));
  },
});
await assert.rejects(() => readLimited.getSms("123"), (error) => error.retryAfterMs === 8000);
await readLimited.getSms("123");
assert.deepEqual(readTimes, [0, 8000], "the next SMS poll must also honor provider backoff");

let recoverTime = 0; let creates = 0; let reads = 0;
const recovering = createDaXiGuaSmsClient({
  apiKey: "test-daxigua-key", now: () => recoverTime, sleep: async (milliseconds) => { recoverTime += milliseconds; },
  fetchImpl: async (url) => {
    if (new URL(url).pathname === "/api/v1/orders") { creates++; return success(order("creating"), 202); }
    reads++;
    return reads === 1 ? new Response("upstream busy", { status: 503 }) : success(order("assigned", { phone_number: "+85512345678" }));
  },
});
await recovering.getNumber("kh", "chatgpt");
assert.equal(creates, 1); assert.equal(reads, 2, "a temporary query failure resumes polling instead of creating another order");

const ambiguousKeys = [];
const ambiguous = createDaXiGuaSmsClient({ apiKey: "test-daxigua-key", sleep: async () => {}, fetchImpl: async (_url, options) => {
  ambiguousKeys.push(options.headers["idempotency-key"]);
  return ambiguousKeys.length < 4 ? success({ id: 123 }) : success(order("assigned", { phone_number: "+85512345678" }));
} });
for (let attempt = 0; attempt < 3; attempt++) await assert.rejects(() => ambiguous.getNumber("kh", "chatgpt"), /订单格式/);
await ambiguous.getNumber("kh", "chatgpt");
assert.equal(new Set(ambiguousKeys).size, 1, "malformed successful purchase responses cannot justify a fresh idempotency key");

let releaseCreate; let concurrentCreates = 0;
const concurrent = createDaXiGuaSmsClient({ apiKey: "test-daxigua-key", fetchImpl: async () => {
  concurrentCreates++;
  await new Promise((resolve) => { releaseCreate = resolve; });
  return success(order("assigned", { phone_number: "+85512345678" }), 202);
} });
const firstConcurrent = concurrent.getNumber("kh", "chatgpt");
const secondConcurrent = concurrent.getNumber("kh", "chatgpt");
await assert.rejects(() => concurrent.getNumber("us", "chatgpt"), (error) => error.code === "ORDER_PENDING");
releaseCreate();
assert.deepEqual(await firstConcurrent, await secondConcurrent);
assert.equal(concurrentCreates, 1, "overlapping requests share one acquisition instead of purchasing twice");

for (const status of ["creating", "assigned"]) {
  const stopped = createDaXiGuaSmsClient({ apiKey: "test-daxigua-key", fetchImpl: async () => success(order(status, { terminal: true, phone_number: "+85512345678" })) });
  await assert.rejects(() => stopped.getSms("123"), (error) => error.code === "ORDER_TERMINAL" && error.manualReview);
  await assert.rejects(() => stopped.getNumber("kh", "chatgpt"), (error) => error.code === "ORDER_TERMINAL" && error.manualReview);
  assert.deepEqual(await stopped.inspect("123"), { state: "unknown", hasSms: false, manualReview: true, code: "ORDER_TERMINAL" });
}

for (const status of ["cancelled", "failed", "assigned", "review"]) {
  const cancelCalls = [];
  const deferredCancellation = createDaXiGuaSmsClient({ apiKey: "test-daxigua-key", fetchImpl: async (_url, options) => {
    cancelCalls.push(options.method);
    return options.method === "POST"
      ? json({ success: false, error: { code: "cancel_not_confirmed" } }, 409)
      : success(order(status));
  } });
  if (["cancelled", "failed"].includes(status)) {
    const receipt = await deferredCancellation.cancelStrict("123");
    assert.equal(receipt.refundStatus, "confirmed");
    assert.equal(receipt.refundEvidence, `daxigua:123:${status}`);
  } else await assert.rejects(() => deferredCancellation.cancelStrict("123"), (error) => error.code === (status === "review" ? "ORDER_REVIEW" : "CANCEL_NOT_CONFIRMED"));
  assert.deepEqual(cancelCalls, ["POST", "GET"], "cancel_not_confirmed requires querying the same order before reporting a refund");
}
for (const method of ["getSms", "cancelStrict"]) {
  const mismatched = createDaXiGuaSmsClient({ apiKey: "test-daxigua-key", fetchImpl: async () => success(order("cancelled", { id: 999 })) });
  await assert.rejects(() => mismatched[method]("123"), (error) => error.code === "ORDER_MISMATCH");
}
const reflectedReason = createDaXiGuaSmsClient({ apiKey: "secret-daxigua-key", fetchImpl: async () => success(order("review", { failure_reason: "Bearer secret-daxigua-key" })) });
await assert.rejects(() => reflectedReason.getSms("123"), (error) => error.manualReview && !error.message.includes("secret-daxigua-key"));
const receivedWithoutText = createDaXiGuaSmsClient({ apiKey: "test-daxigua-key", fetchImpl: async () => success(order("received", { sms_content: "" })) });
assert.deepEqual(await receivedWithoutText.inspect("123"), { state: "received", hasSms: true }, "a terminal received order is never cancellable inventory, even if its SMS text is missing");
for (const body of ["not-json", "null", '{"success":true,"data":null}']) {
  const malformed = createDaXiGuaSmsClient({ apiKey: "test-daxigua-key", fetchImpl: async () => new Response(body) });
  await assert.rejects(() => malformed.getServiceOptions(), (error) => error.status === 502, "invalid successful responses must not be reported as HTTP 200 errors to the console");
}

console.log("DaXiGua SMS tests passed (services, idempotency, async recovery, Retry-After, terminal/review handling, verified cancellation and redaction; synthetic fixtures only)");

function order(status, patch = {}) {
  return {
    id: 123, country: "kh", project: "chatgpt", status, status_display: status,
    phone_number: "", sms_content: "", failure_reason: "", uses: 1, terminal: ["received", "failed", "cancelled", "review"].includes(status),
    created_at: "2026-10-30T00:00:00+00:00", ...patch,
  };
}

function success(data, status = 200) {
  return json({ success: true, data }, status);
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}
