import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readPhoneEvidence, writePhoneEvidence } from "../src/phone-verification-evidence.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-phone-evidence-"));
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const base = `http://127.0.0.1:${port}`;
const backend = spawn(process.execPath, ["test/mock-add-phone-page-server.mjs", String(port)], { windowsHide: true, stdio: "ignore" });
let child;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(20); }
  throw new Error(label);
}
async function run(name, mismatch = false) {
  const directory = path.join(root, name); await fs.mkdir(directory);
  const context = { version: 1, operationId: crypto.randomUUID(), allocationId: crypto.randomUUID(), jobId: crypto.randomUUID(), runId: crypto.randomUUID(),
    orderId: "fixture-order", providerId: "smsbower", phone: "+60123456789" };
  const contextPath = path.join(directory, "context.json"); const resultPath = path.join(directory, "result.json");
  await writePhoneEvidence(contextPath, mismatch ? { ...context, runId: crypto.randomUUID() } : context);
  let output = ""; const sent = new Set();
  child = spawn(process.execPath, ["src/protocol-login.mjs", "--email", "add-phone-page@example.com", "--native-http", "--output-mode", "sub2api", "--sub2api-out", path.join(directory, "oauth.json"), "--checkpoint", path.join(directory, "checkpoint.json")], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NODE_ENV: "test", CHATGPT_BASE: base, AUTH_BASE: base,
      TOSUB2_TEST_SENTINEL_TOKEN: "mock-sentinel-challenge", TOSUB2_TEST_SENTINEL_SO_TOKEN: "mock-so-token",
      CHATGPT_PROXY_URL: "", CHATGPT_LOGIN_PASSWORD: "", CHATGPT_TOTP_SECRET: "",
      TOSUB2_PHONE_CONTEXT_PATH: contextPath, TOSUB2_PHONE_RESULT_PATH: resultPath, TOSUB2_PHONE_JOB_ID: context.jobId, TOSUB2_PHONE_RUN_ID: context.runId },
  });
  child.stdin.on("error", () => {});
  const answer = chunk => {
    output += chunk;
    for (const [kind, pattern, value] of [["email", "Email OTP (r=resend, q=quit):", "123456"], ["phone", "Phone number, E.164 format", context.phone], ["otp", "Phone OTP (r=resend, p=change phone, q=quit):", "654321"]]) {
      if (output.includes(pattern) && !sent.has(kind)) { sent.add(kind); child.stdin.write(`${value}\n`); }
    }
  };
  child.stdout.on("data", answer); child.stderr.on("data", chunk => { output += chunk; });
  const exitCode = await new Promise((resolve, reject) => { const timeout = setTimeout(() => { child.kill(); reject(new Error(`protocol timeout: ${output}`)); }, 15000); child.once("close", code => { clearTimeout(timeout); resolve(code); }); });
  child = null;
  if (mismatch) { assert.notEqual(exitCode, 0); assert.match(output, /PHONE_CONTEXT_MISMATCH/); assert.equal(await fs.access(resultPath).then(() => true, () => false), false); }
  else {
    assert.equal(exitCode, 0, output);
    const result = await readPhoneEvidence(resultPath, context);
    assert.equal(result.state, "verified"); assert.equal(result.orderId, "fixture-order"); assert.ok(result.verifiedAt);
    assert.ok(!JSON.stringify(result).includes("654321"), "verification proof must not contain OTP");
    assert.ok(!JSON.stringify(result).includes("accessToken"), "verification proof must not contain credentials");
    await assert.rejects(readPhoneEvidence(resultPath, { ...context, orderId: "another-order" }), /PHONE_EVIDENCE_MISMATCH/);
  }
}
try {
  await wait(async () => { try { return (await fetch(`${base}/__phone-requests`)).ok; } catch { return false; } }, "fixture server unavailable");
  await run("verified");
  const before = await (await fetch(`${base}/__phone-requests`)).json();
  await run("mismatched-context", true);
  const after = await (await fetch(`${base}/__phone-requests`)).json();
  assert.equal(after.validate, before.validate, "a different run's context must fail before submitting the OTP");
  console.log("[ok] private phone verification evidence: real protocol/local mock success, identity binding and no OTP retention");
} finally {
  child?.kill();
  const exited = new Promise(resolve => backend.once("exit", resolve)); backend.kill(); await exited;
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}
