import assert from "node:assert/strict";
import {
  createProxyPool, LEGACY_PROXY_SETTING_KEY, MAX_PROXY_POOL_SIZE, normalizeProxyPool,
  normalizeProxySelection, normalizeProxyUrl, PROXY_POOL_SETTING_KEY, workspaceProxyPool,
} from "../src/proxy-pool.mjs";

const raw = [
  "http://fixture-a:private-a@proxy-a.example.invalid:8080",
  "socks5h://fixture-b:private-b@proxy-b.example.invalid:1080",
  "https://fixture-c:private-c@proxy-c.example.invalid:8443",
];
const [a, b, c] = raw.map(normalizeProxyUrl);
const pool = createProxyPool({ readPool: () => raw });
assert.deepEqual(Array.from({ length: 8 }, () => pool.take()), [a, b, c, a, b, c, a, b]);
assert.deepEqual(pool.current(), [a, b, c]);

const single = createProxyPool({ readPool: () => [a] });
assert.deepEqual(Array.from({ length: 3 }, () => single.take()), [a, a, a]);
assert.equal(single.canRotate({ mode: "workspace" }), false);
const empty = createProxyPool();
assert.equal(empty.take(), "");
assert.deepEqual(empty.current(), []);
assert.equal(empty.canRotate({ mode: "workspace" }), false);
assert.equal(pool.canRotate({ mode: "workspace" }), true);

const weighted = createProxyPool({ readPool: () => [a, a, b] });
assert.deepEqual(Array.from({ length: 6 }, () => weighted.take()), [a, a, b, a, a, b], "duplicate entries retain their ordered weight");
assert.deepEqual(normalizeProxyPool(` \r\n ${raw[0]} \r\n\r\n${raw[1]}\n`), [a, b]);
assert.deepEqual(normalizeProxyPool(["", raw[0], " ", raw[0]]), [a, a]);
assert.deepEqual(normalizeProxyPool(null), []);
assert.deepEqual(normalizeProxyPool(""), []);
assert.throws(() => normalizeProxyPool({}), { code: "INVALID_PROXY_CONFIG", status: 400 });
assert.equal(normalizeProxyPool(Array(MAX_PROXY_POOL_SIZE).fill(a)).length, MAX_PROXY_POOL_SIZE);
assert.throws(() => normalizeProxyPool(Array(MAX_PROXY_POOL_SIZE + 1).fill(a)), { code: "INVALID_PROXY_CONFIG" });
for (const invalidPool of [
  `${raw[0]}\n\nftp://private-user:private-secret@proxy.example.invalid:21`,
  [raw[0], "", "http://private-user:private-secret@"],
  [raw[0], "", 123],
]) {
  assert.throws(() => normalizeProxyPool(invalidPool), (failure) => {
    assert.equal(failure.code, "INVALID_PROXY_CONFIG");
    assert.equal(failure.status, 400);
    assert.match(failure.message, /第 3 行/);
    assert.doesNotMatch(failure.message, /private-user|private-secret|proxy\.example|ftp:\/\/|http:\/\/private/);
    return true;
  });
}
assert.throws(() => normalizeProxyUrl(`${a}\tinvalid`), { code: "INVALID_PROXY_CONFIG" });
assert.throws(() => normalizeProxyUrl(123), { code: "INVALID_PROXY_CONFIG" });

const isolatedOne = createProxyPool({ readPool: () => [a, b] });
const isolatedTwo = createProxyPool({ readPool: () => [a, b] });
assert.equal(isolatedOne.take(), a);
assert.equal(isolatedOne.take(), b);
assert.equal(isolatedTwo.take(), a, "separate CDK allocators do not share a cursor");

let persisted = {};
const persistentOptions = { readPool: () => [a, b, c], readState: () => persisted, writeState: (state) => { persisted = structuredClone(state); } };
let restored = createProxyPool(persistentOptions);
assert.equal(restored.take(), a);
restored = createProxyPool(persistentOptions);
assert.equal(restored.take(), b, "reconstruction resumes the synchronously saved cursor");
assert.equal(createProxyPool(persistentOptions).take(), c);
const encodedState = JSON.stringify(persisted);
for (const secret of [...raw, "fixture-a", "private-a", "proxy-a.example.invalid"]) assert.equal(encodedState.includes(secret), false, "cursor state contains no proxy credentials or endpoint");

const concurrent = createProxyPool({ readPool: () => [a, b, c] });
const calls = Array.from({ length: 15 }, () => Promise.resolve().then(() => concurrent.take()));
assert.deepEqual(await Promise.all(calls), Array.from({ length: 15 }, (_, index) => [a, b, c][index % 3]), "concurrent scheduling reserves each ordered position exactly once");

let configured = [a, b, c];
const changing = createProxyPool({ readPool: () => configured });
assert.equal(changing.take(), a);
configured = [c, b];
assert.equal(changing.take(), c, "changed workspace lists restart at their first entry");
configured = [a, b, c];
assert.equal(changing.take(), a, "changing back to a former list also restarts it");
assert.equal(changing.take(), b);
changing.reset();
assert.equal(changing.take(), a, "explicit reset restarts an unchanged list");
configured = [];
changing.reset();
assert.equal(changing.take(), "");
configured = [a, b, c];
changing.reset();
assert.equal(changing.take(), a, "settings resets cover clearing and restoring a former list");

let workspace = [a, b];
const mixed = createProxyPool({ readPool: () => workspace });
assert.equal(mixed.take(), a);
assert.equal(mixed.take([c, a]), c);
assert.equal(mixed.take(), b, "custom pool allocation does not reset the workspace cursor");
assert.equal(mixed.take([c, a]), a);
workspace = [b, c];
assert.equal(mixed.take(), b);
assert.equal(mixed.take([c, a]), c, "workspace edits do not reset unrelated custom cursors");
mixed.reset();
assert.equal(mixed.take([c, a]), a, "workspace reset does not reset a custom pool");
assert.equal(mixed.take(), b);

assert.equal(normalizeProxySelection({}), null);
assert.deepEqual(normalizeProxySelection({ useProxyPool: true }), { mode: "workspace" });
assert.deepEqual(normalizeProxySelection({ proxyPool: `${raw[0]}\n${raw[1]}` }), { mode: "pool", proxies: [a, b] });
assert.deepEqual(normalizeProxySelection({ proxyPool: [] }), { mode: "pool", proxies: [] });
assert.deepEqual(normalizeProxySelection({ proxyUrl: raw[0] }), { mode: "fixed", proxyUrl: a });
assert.deepEqual(normalizeProxySelection({ proxyUrl: "" }), { mode: "fixed", proxyUrl: "" }, "legacy explicit direct mode is distinct from omission");
for (const selection of [
  { useProxyPool: true, proxyUrl: "" }, { useProxyPool: true, proxyPool: [] },
  { proxyPool: [], proxyUrl: "" }, { useProxyPool: false },
]) assert.throws(() => normalizeProxySelection(selection), { code: "INVALID_PROXY_CONFIG", status: 400 });
assert.equal(empty.resolve(null), "");
assert.equal(empty.resolve({ mode: "fixed", proxyUrl: a }), a);
assert.equal(empty.resolve({ mode: "fixed", proxyUrl: "" }), "");
assert.equal(empty.resolve({ mode: "pool", proxies: [a, b] }), a);
assert.equal(empty.resolve({ mode: "pool", proxies: [a, b] }), b);
assert.equal(empty.canRotate({ mode: "pool", proxies: [a, b] }), true);
assert.equal(empty.canRotate({ mode: "pool", proxies: [a] }), false);
assert.equal(empty.canRotate({ mode: "fixed", proxyUrl: a }), false);
assert.throws(() => empty.resolve({ mode: "unknown" }), { code: "INVALID_PROXY_CONFIG" });

assert.deepEqual(workspaceProxyPool({ [LEGACY_PROXY_SETTING_KEY]: raw[0] }), [a]);
assert.deepEqual(workspaceProxyPool({ [LEGACY_PROXY_SETTING_KEY]: `${raw[0]}\n${raw[1]}` }), [a, b]);
assert.deepEqual(workspaceProxyPool({ [PROXY_POOL_SETTING_KEY]: [a, b], [LEGACY_PROXY_SETTING_KEY]: c }), [a, b]);
assert.deepEqual(workspaceProxyPool({ [PROXY_POOL_SETTING_KEY]: JSON.stringify([a, b]), [LEGACY_PROXY_SETTING_KEY]: c }), [a, b]);
assert.deepEqual(workspaceProxyPool({ [PROXY_POOL_SETTING_KEY]: "", [LEGACY_PROXY_SETTING_KEY]: a }), [], "an explicitly empty new setting never falls back to a legacy proxy");
assert.deepEqual(workspaceProxyPool({ [PROXY_POOL_SETTING_KEY]: [], [LEGACY_PROXY_SETTING_KEY]: a }), []);
assert.deepEqual(workspaceProxyPool({ [PROXY_POOL_SETTING_KEY]: "[]", [LEGACY_PROXY_SETTING_KEY]: a }), []);
assert.throws(() => workspaceProxyPool({ [PROXY_POOL_SETTING_KEY]: "[broken" }), { code: "INVALID_PROXY_CONFIG" });

console.log("proxy pool tests passed (ordered allocation, concurrency, durable cursors, isolation, validation, selection and migration; no network)");
