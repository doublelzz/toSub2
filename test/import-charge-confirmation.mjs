import assert from "node:assert/strict";
import fs from "node:fs/promises";
import React, { useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { X } from "lucide-react";
import { transformWithEsbuild } from "vite";
import { cdkFetch, setImportConfirmation } from "../web/src/cdk-api.mjs";

const originalFetch = globalThis.fetch; const originalWindow = globalThis.window;
const calls = []; const confirmations = [];
let accepted = true;
let quote = { count: 2, added: 1, updated: 1, charge: 1, balance: 30, after: 29, canImport: true };
let pool = { id: "other", name: "其他", enabled: true, available: true, fee: 10, feeVersion: 1 };
let poolStatus = 200;
const payload = { text: "new@example.invalid----fixture\nold@example.invalid----fixture\nNEW@example.invalid----fixture", phoneBindingMode: "automatic", phoneBindingEnabled: true, smsProvider: { id: "pool", config: { categoryId: "other", quotedFee: 999, feeVersion: 999, apiKey: "obsolete-fixture-key" } } };
globalThis.window = { dispatchEvent: () => true };
globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  if (url === "/api/imports/preview") return Response.json(quote);
  if (url.startsWith("/api/sms-pool?categoryId=")) return Response.json(pool, { status: poolStatus });
  if (url === "/api/jobs/batch") return Response.json({ created: 1, updated: 1 });
  throw Error(`Unexpected confirmation request: ${url}`);
};
setImportConfirmation(async (value) => {
  assert.equal(calls.filter((call) => call.url === "/api/jobs/batch").length, 0, "confirmation cannot import, reserve quota or purchase a number");
  confirmations.push(value); return accepted;
});
const importBatch = (body = payload) => cdkFetch("/api/jobs/batch", { method: "POST", headers: { "x-console-token": "fixture-token", "idempotency-key": "fixture-review" }, body: JSON.stringify(body) });
const reset = () => { calls.length = 0; confirmations.length = 0; };

const source = (await fs.readFile(new URL("../web/src/ImportChargeDialog.jsx", import.meta.url), "utf8")).replace(/^import[^\n]+\n/gm, "").replace("export default function", "function");
const compiled = await transformWithEsbuild(source, "ImportChargeDialog.jsx", { loader: "jsx", jsx: "transform" });
const ImportChargeDialog = new Function("React", "useRef", "X", "useDialogFocus", `${compiled.code};return ImportChargeDialog;`)(React, useRef, X, () => {});
const render = (value) => renderToStaticMarkup(React.createElement(ImportChargeDialog, { quote: value, onClose() {} }));
try {
  await importBatch();
  assert.equal(confirmations.length, 1, "one combined confirmation covers import and SMS");
  assert.deepEqual(confirmations[0].smsPool, { categoryId: "other", categoryName: "其他", feeVersion: 1, count: 2, fee: 10, maximum: 20, admin: false }, "server-deduplicated accounts include existing accounts needing phone verification");
  const posted = calls.find((call) => call.url === "/api/jobs/batch");
  assert.deepEqual(JSON.parse(posted.options.body).smsProvider, { id: "pool", config: { categoryId: "other", quotedFee: 10, feeVersion: 1 } }, "the accepted live fee, rather than cached fee or secret settings, is submitted");
  assert.equal(posted.options.headers.get("idempotency-key"), "fixture-review");
  let markup = render(confirmations[0]);
  assert.match(markup, /确认导入并使用接码池/); assert.match(markup, /最高合计/); assert.match(markup, /21<small/);
  assert.match(markup, /每个账号手机验证成功扣 10 次/); assert.match(markup, /最高合计不会一次性扣除/);

  reset(); quote = { ...quote, count: 1, added: 1, updated: 0 }; await importBatch();
  markup = render(confirmations[0]); assert.match(markup, /11<small/); assert.equal(confirmations[0].charge, 1);

  reset(); accepted = false;
  await assert.rejects(importBatch(), /已取消导入/);
  assert.equal(confirmations.length, 1); assert.deepEqual(calls.map((call) => call.url), ["/api/imports/preview", "/api/sms-pool?categoryId=other"]);
  accepted = true;

  reset(); pool = { ...pool, fee: 8 }; await importBatch();
  assert.equal(confirmations[0].smsPool.fee, 8); assert.equal(JSON.parse(calls.at(-1).options.body).smsProvider.config.quotedFee, 8);

  reset(); quote = { ...quote, count: 2, added: 0, updated: 2, charge: 0, balance: 10, after: 10 }; await importBatch();
  markup = render(confirmations[0]); assert.match(markup, /余额最多支持 1 个账号接码/); assert.match(markup, /其余任务余额不足时停止取号/);
  assert.equal(confirmations[0].smsPool.maximum, 16, "batch SMS cap is not limited to new-account import fees");

  reset(); quote = { ...quote, balance: null, after: null }; await importBatch();
  assert.deepEqual(confirmations[0].smsPool, { categoryId: "other", categoryName: "其他", feeVersion: 1, count: 2, fee: 0, maximum: 0, admin: true });
  assert.equal(JSON.parse(calls.at(-1).options.body).smsProvider.config.quotedFee, 8, "administrator requests still pin the configured server fee");
  assert.match(render(confirmations[0]), /导入与接码均不扣 CDK 次数/);

  reset(); quote = { ...quote, balance: 30, after: 30 }; await importBatch({ ...payload, phoneBindingMode: "manual" });
  assert.equal(confirmations.length, 1); assert.equal(confirmations[0].smsPool, undefined);
  assert.equal(calls.some((call) => call.url === "/api/sms-pool?categoryId=other"), false, "manual imports retain only the ordinary import confirmation");

  reset(); const own = { ...payload, smsProvider: { id: "custom", config: { fixture: true } } }; await importBatch(own);
  assert.equal(confirmations[0].smsPool, undefined); assert.equal(calls.some((call) => call.url === "/api/sms-pool?categoryId=other"), false);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), own, "private provider imports are unchanged");

  reset(); pool = { ...pool, id: "us", name: "美区", fee: 5, feeVersion: 4 }; await importBatch({ ...payload, smsProvider: { id: "pool", config: { categoryId: "us", quotedFee: 999, feeVersion: 1 } } });
  assert.ok(calls.some((call) => call.url === "/api/sms-pool?categoryId=us"));
  assert.equal(confirmations[0].smsPool.categoryName, "美区"); assert.match(render(confirmations[0]), /接码池 · 美区/);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body).smsProvider.config, { categoryId: "us", quotedFee: 5, feeVersion: 4 });
  reset(); await assert.rejects(importBatch({ ...payload, smsProvider: { id: "pool", config: {} } }), /请选择接码池分类/); assert.equal(confirmations.length, 0);
  reset(); pool = { ...pool, id: "other", name: "其他", fee: 8, feeVersion: 1 };
  reset(); quote = { ...quote, balance: 2, after: 2 }; await assert.rejects(importBatch(), /需要预留 8 次/);
  assert.equal(confirmations.length, 0); assert.equal(calls.length, 2);
  reset(); quote = { ...quote, canImport: false, added: 3, charge: 3 }; await assert.rejects(importBatch(), /可用次数不足/);
  assert.equal(confirmations.length, 0); assert.equal(calls.length, 1);
  quote = { ...quote, canImport: true, balance: 30, after: 27 };
  reset(); pool.available = false; await assert.rejects(importBatch(), /已停用或暂时无法取号/); assert.equal(confirmations.length, 0); assert.equal(calls.length, 2);
  reset(); pool.available = true; pool.fee = -1; await assert.rejects(importBatch(), /费用尚未确认/); assert.equal(confirmations.length, 0); assert.equal(calls.length, 2);
  reset(); poolStatus = 500; await assert.rejects(importBatch(), /无法读取接码池费用/); assert.equal(confirmations.length, 0); assert.equal(calls.length, 2);
  console.log("Import charge confirmation passed (one review, unchanged import fee, deduplicated SMS cap, live fee pinning, cancellation, ownership, partial balance and manual/private provider paths)");
} finally { setImportConfirmation(null); globalThis.fetch = originalFetch; globalThis.window = originalWindow; }
