import assert from "node:assert/strict";
import { createHeroSmsClient, HeroSmsError } from "../src/hero-sms.mjs";
import { createSmsProvider } from "../src/sms-providers.mjs";

const requests = [];
const statuses = ["STATUS_WAIT_CODE", "STATUS_WAIT_RETRY:111111", "STATUS_WAIT_RESEND", "STATUS_OK:OpenAI code 654321"];
const fetchImpl = async (url, options) => {
  const request = new URL(url);
  requests.push(request);
  assert.equal(options.method, "GET");
  assert.equal(options.redirect, "error");
  assert.equal(request.origin, "https://hero-sms.com");
  const isOffers = request.pathname === "/api/v1/activations/offers/sms";
  assert.equal(request.pathname, isOffers ? "/api/v1/activations/offers/sms" : "/stubs/handler_api.php");
  if (isOffers) {
    assert.equal(options.headers.authorization, "ApiKey test-hero-key");
    assert.equal(request.searchParams.has("api_key"), false);
    assert.equal(request.searchParams.get("services"), "dr");
  } else assert.equal(request.searchParams.get("api_key"), "test-hero-key");
  const action = isOffers ? "offers" : request.searchParams.get("action");
  const body = {
    getNumber: "ACCESS_NUMBER:123456789:60123456789",
    offers: JSON.stringify({ data: {
      dr: {
        0: { map: { "0.5000": "5" } },
        7: { map: { "0.1800": 8, "0.2000": 4 } },
        16: { prices: { default: 0.42 }, counts: { defaultPrice: 12 } },
        23: { map: { "0.08": 0 } },
        24: { map: { invalid: 10 } },
        25: { map: { "0.1": -1 } },
        26: { prices: { default: 0.01 }, counts: { total: 50, defaultPrice: 0 } },
      },
      go: { 22: { map: { "0.01": 50 } } },
    } }),
    getCountries: JSON.stringify({
      0: { id: 0, chn: "俄罗斯", eng: "Russia" },
      7: { id: 7, chn: "马来西亚", eng: "Malaysia" },
      16: { id: 16, chn: "英国", eng: "England" },
    }),
    getStatus: action === "getStatus" ? statuses.shift() : "",
    setStatus: { 1: "ACCESS_READY", 6: "ACCESS_ACTIVATION", 8: "ACCESS_CANCEL" }[request.searchParams.get("status")],
  }[action];
  return new Response(body || "BAD_ACTION");
};

const client = createHeroSmsClient({ apiKey: "test-hero-key", fetchImpl });
assert.deepEqual(await client.getPriceOptions("dr"), [
  { country: "7", title: "马来西亚", iso: "", prefix: "", price: 0.18, count: 8 },
  { country: "7", title: "马来西亚", iso: "", prefix: "", price: 0.2, count: 4 },
  { country: "16", title: "英国", iso: "", prefix: "", price: 0.42, count: 12 },
  { country: "0", title: "俄罗斯", iso: "", prefix: "", price: 0.5, count: 5 },
]);
const order = await client.getNumber("dr", "7", "0.18");
assert.deepEqual(order, { requestId: "123456789", number: "+60123456789" });
const numberRequest = requests.find((url) => url.searchParams.get("action") === "getNumber");
assert.equal(numberRequest.searchParams.get("service"), "dr");
assert.equal(numberRequest.searchParams.get("country"), "7");
assert.equal(numberRequest.searchParams.get("maxPrice"), "0.18");
assert.equal(numberRequest.searchParams.get("fixedPrice"), "true");
assert.equal(numberRequest.searchParams.has("providerIds"), false);
for (let index = 0; index < 3; index += 1) assert.deepEqual(await client.getSms(order.requestId), { status: "waiting" });
assert.deepEqual(await client.getSms(order.requestId), { status: "received", code: "654321" });
assert.equal(client.markReady, undefined);
assert.equal(await client.complete(order.requestId), true);
assert.equal(await client.release(order.requestId), true);
assert.deepEqual(requests.filter((url) => url.searchParams.get("action") === "setStatus").map((url) => [
  url.searchParams.get("id"), url.searchParams.get("status"),
]), [["123456789", "6"], ["123456789", "8"]]);

const provider = createSmsProvider("herosms", { apiKey: "test-hero-key", country: "7", maxPrice: "0.18", countryLabel: "马来西亚" }, { fetchImpl });
assert.equal(provider.name, "Hero SMS");
assert.equal(provider.serviceLabel, "马来西亚");
assert.deepEqual(await provider.getNumber(), order);
assert.equal((await createSmsProvider("herosms", { apiKey: "test-hero-key" }, { fetchImpl }).listNumberOptions()).length, 4);
assert.equal(provider.markReady, undefined);
assert.throws(() => createSmsProvider("herosms", { apiKey: "short" }), /API Key/);
assert.throws(() => createSmsProvider("herosms", { apiKey: "test-hero-key", country: "invalid" }), /国家 ID/);
assert.throws(() => createSmsProvider("herosms", { apiKey: "test-hero-key", maxPrice: "0" }), /国家价格/);
assert.throws(() => createSmsProvider("herosms", { apiKey: "test-hero-key", maxPrice: "1e2" }), /国家价格/);
assert.throws(() => createSmsProvider("herosms", { apiKey: "test-hero-key" }).getNumber(), /先查询并选择/);
const zeroCountry = createSmsProvider("herosms", { apiKey: "test-hero-key", country: 0, maxPrice: 0.5 }, { fetchImpl });
await zeroCountry.getNumber();
assert.equal(requests.at(-1).searchParams.get("country"), "0");

function responseClient(body, status = 200) {
  return createHeroSmsClient({ apiKey: "test-hero-key", fetchImpl: async () => new Response(body, { status }) });
}
for (const [body, message, terminal] of [
  ["BAD_KEY", /API Key 不正确/, true],
  ["NO_BALANCE", /账户余额不足/, true],
  ["NO_NUMBERS", /暂无可用号码/, false],
  ["WRONG_SERVICE", /服务代码/, true],
]) {
  await assert.rejects(() => responseClient(body).getNumber("dr", "7", "0.18"),
    (error) => error instanceof HeroSmsError && error.terminal === terminal && message.test(error.message));
}
await assert.rejects(() => responseClient("STATUS_CANCEL").getSms("1"), (error) => error.terminal && error.code === "STATUS_CANCEL");
await assert.rejects(() => responseClient("STATUS_OK:order 123456789").getSms("1"), /独立的 6 位/);
await assert.rejects(() => responseClient("ACCESS_NUMBER:1:0123456789").getNumber("dr", "7", "0.18"), /国际格式/);
await assert.rejects(() => responseClient("ACCESS_READY").complete("1"), /更新号码状态失败/);
await assert.rejects(() => responseClient("EARLY_CANCEL_DENIED").release("1"), /平台控制台/);
await assert.rejects(() => responseClient(JSON.stringify({ title: "BAD_KEY" }), 401).getPriceOptions("dr"), /API Key 不正确/);
await assert.rejects(() => responseClient(JSON.stringify({ title: "UNPROCESSABLE_ENTITY", info: { field: "api_key" } }), 422).getPriceOptions("dr"),
  (error) => error.terminal && /请求参数不正确/.test(error.message));
await assert.rejects(() => responseClient("not-json").getPriceOptions("dr"), /价格接口返回格式/);
await assert.rejects(() => responseClient("null").getPriceOptions("dr"), /格式不正确/);
assert.deepEqual(await responseClient('{"data":{}}').getPriceOptions("dr"), []);
await assert.rejects(() => responseClient("{}").getPriceOptions("dr"), /格式不正确/);
await assert.rejects(() => responseClient("[]").getPriceOptions("dr"), /格式不正确/);
await assert.rejects(() => responseClient("").getSms("1"), /空响应/);
await assert.rejects(() => responseClient("unavailable", 503).getSms("1"), (error) => !error.terminal && /HTTP 503/.test(error.message));
await assert.rejects(() => responseClient("rate limited", 429).getSms("1"), (error) => !error.terminal && /HTTP 429/.test(error.message));
assert.deepEqual(await responseClient('"STATUS_OK:654321"').getSms("1"), { status: "received", code: "654321" });
const failedClient = createHeroSmsClient({ apiKey: "test-hero-key", fetchImpl: async () => { throw new Error("https://hero-sms.com/?api_key=test-hero-key"); } });
await assert.rejects(() => failedClient.getSms("1"), (error) => !error.message.includes("test-hero-key") && error.message.includes("[redacted]"));
const longKey = "k".repeat(256);
const reflectedKeyClient = createHeroSmsClient({ apiKey: longKey, fetchImpl: async () => new Response(`ERROR:${longKey}`) });
await assert.rejects(() => reflectedKeyClient.getNumber("dr", "7", "0.18"),
  (error) => !error.message.includes("k".repeat(20)) && !error.code.includes("k".repeat(20)) && error.message.includes("[redacted]"));
await assert.rejects(() => responseClient('{"title":"ACTIVATION_NOT_ACTIVE"}', 409).getSms("1"), (error) => error.terminal && /订单已结束/.test(error.message));
const timeoutClient = createHeroSmsClient({
  apiKey: "test-hero-key", timeoutMs: 10,
  fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })),
});
await assert.rejects(() => timeoutClient.getSms("1"), /请求超时/);
assert.equal(createHeroSmsClient(), null);
assert.throws(() => createHeroSmsClient({ apiKey: "test-hero-key", apiBase: "file:///tmp/api" }), /HTTP 或 HTTPS/);
console.log("Hero SMS tests passed");
