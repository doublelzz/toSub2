import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-phone-binding-"));
const backendPort = await port();
const consolePort = await port();
const backendUrl = `http://127.0.0.1:${backendPort}`;
const base = `http://127.0.0.1:${consolePort}`;
const backend = spawn(process.execPath, ["test/mock-add-phone-page-server.mjs", String(backendPort)], { cwd: project, windowsHide: true, stdio: "ignore" });
let child;
let headers;
let id;
let logs = "";
let lastJob;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fetchJson = async (url, options) => {
  const response = await fetch(url, options);
  assert.equal(response.ok, true, `${response.status} ${await response.clone().text()}`);
  return response.json();
};
const post = (route, body = {}) => fetch(`${base}/api/jobs${route}`, { method: "POST", headers, body: JSON.stringify(body) });
const getJobs = (filters = {}) => fetchJson(`${base}/api/jobs?${new URLSearchParams(filters)}`, { headers });
async function until(callback, label) {
  for (let i = 0; i < 180; i++) {
    const result = await callback();
    if (result) return result;
    await delay(100);
  }
  const jobLogs = id ? await fetchJson(`${base}/api/jobs/${id}/logs`, { headers }) : {};
  throw new Error(`${label}\n${JSON.stringify(lastJob)}\n${jobLogs.logs || ""}\n${logs}`);
}
const jobWhen = predicate => until(async () => {
  const job = (await getJobs()).jobs.find(job => job.id === id);
  lastJob = job;
  return job && predicate(job) ? job : null;
}, "job state did not settle");
async function startConsole() {
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(consolePort)], {
    cwd: project, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test", TOSUB2_TEST_SENTINEL_TOKEN: "mock-sentinel-challenge", TOSUB2_TEST_SENTINEL_SO_TOKEN: "mock-so-token", ONBOARDING_OUTPUT_ROOT: path.join(root, "jobs"), CHATGPT_BASE: backendUrl, AUTH_BASE: backendUrl, LOCALAPPDATA: path.join(root, "credentials"), TOSUB2_MAC_CREDENTIAL_ROOT: path.join(root, "credentials") },
  });
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  const token = await until(async () => { try { return (await fetchJson(`${base}/api/bootstrap`)).token; } catch { return null; } }, "console did not start");
  headers = { "x-console-token": token, "content-type": "application/json" };
}
async function stop(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise(resolve => proc.once("exit", resolve));
  proc.kill("SIGTERM");
  await exited;
}
try {
  await until(async () => { try { return await fetchJson(`${backendUrl}/__phone-requests`); } catch { return null; } }, "mock did not start");
  await startConsole();
  assert.equal((await post("", { email: "invalid@example.com", phoneBindingEnabled: "false" })).status, 400);
  const created = await fetchJson(`${base}/api/jobs`, { method: "POST", headers, body: JSON.stringify({ email: "add-phone-page@example.com", phoneBindingEnabled: false }) });
  id = created.job.id;
  assert.equal(created.job.phoneBindingEnabled, false);
  await jobWhen(job => job.status === "email_otp");
  assert.equal((await post(`/${id}/input`, { action: "email_otp", value: "123456" })).status, 200);
  let job = await jobWhen(job => job.status === "phone_skipped");
  assert.equal(job.canDownload, false);
  assert.equal(job.canCheckAccountInsights, true);
  assert.equal(job.accountInsights.quota.windows[0].remainingPercent, 75);
  assert.equal(job.accountInsights.subscription.planType, "plus");
  assert.equal(job.accountInsights.resetCredits.availableCount, 1);
  assert.deepEqual(await fetchJson(`${backendUrl}/__phone-requests`), { send: 0, validate: 0 });
  assert.equal((await post(`/${id}/sms-number`, { providerId: "lubansms", config: { apiKey: "synthetic" } })).status, 409);
  assert.equal((await post(`/${id}/input`, { action: "phone", value: "+60123456789" })).status, 409);
  assert.equal((await fetch(`${base}/api/jobs/${id}/download`, { headers })).status, 409);
  const disabled = await getJobs({ phoneBinding: "disabled" });
  assert.equal(disabled.pagination.total, 1);
  assert.equal(disabled.stats.phoneDisabled, 1);
  assert.equal(disabled.stats.completed, 0);
  assert.equal(disabled.stats.active, 0, "skipped phone task must release its concurrency slot");
  assert.equal((await getJobs({ phoneBinding: "enabled" })).pagination.total, 0);
  assert.equal((await post(`/${id}/account-insights`)).status, 200);
  job = await jobWhen(job => job.status === "phone_skipped" && !job.accountInsightsChecking);
  assert.equal(job.accountInsights.status, "ok");
  assert.equal(job.canDownload, false, "checking account info must not mark OAuth complete");
  await stop(child);
  // Simulate a process interrupted during a recheck of an unfinished OAuth job.
  const metadataPath = path.join(root, "jobs", id, "job-meta.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  Object.assign(metadata, { status: "checking_account", queued_mode: "account_insights", account_insights_return_status: "phone_skipped" });
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  await startConsole();
  job = await jobWhen(job => job.status === "phone_skipped");
  assert.equal(job.phoneBindingEnabled, false);
  assert.equal(job.accountInsights.status, "ok");
  assert.equal((await post(`/${id}/retry`)).status, 200);
  await jobWhen(job => job.status === "phone_skipped" && job.attempt >= 2);
  assert.deepEqual(await fetchJson(`${backendUrl}/__phone-requests`), { send: 0, validate: 0 });
  assert.equal((await post("/reauthorize-batch", { ids: [id] })).status, 200);
  await jobWhen(job => job.status === "phone_skipped" && job.attempt >= 3);
  assert.deepEqual(await fetchJson(`${backendUrl}/__phone-requests`), { send: 0, validate: 0 });
  const repeated = await fetchJson(`${base}/api/jobs/batch`, { method: "POST", headers, body: JSON.stringify({ text: "add-phone-page@example.com", phoneBindingEnabled: false }) });
  assert.equal(repeated.updated, 1);
  assert.equal(repeated.created, 0);
  assert.equal(repeated.jobs[0].id, id);
  const enabled = await fetchJson(`${base}/api/jobs/batch`, { method: "POST", headers, body: JSON.stringify({ text: "add-phone-page@example.com", phoneBindingEnabled: true }) });
  assert.equal(enabled.jobs[0].phoneBindingEnabled, true);
  assert.equal((await getJobs({ phoneBinding: "enabled" })).pagination.total, 1);
  assert.equal((await getJobs({ phoneBinding: "disabled" })).pagination.total, 0);
  assert.equal((await post(`/${id}/retry`)).status, 200);
  await jobWhen(job => job.status === "phone");
  assert.equal((await post(`/${id}/input`, { action: "phone", value: "+60123456789" })).status, 200);
  await jobWhen(job => job.status === "phone_otp");
  assert.equal((await post(`/${id}/input`, { action: "phone_otp", value: "654321" })).status, 200);
  job = await jobWhen(job => job.status === "completed");
  assert.equal(job.canDownload, true);
  const counts = await fetchJson(`${backendUrl}/__phone-requests`);
  assert(counts.send > 0 && counts.validate > 0, "enabled phone tasks must retain their existing flow");
  const jobLogs = await fetchJson(`${base}/api/jobs/${id}/logs`, { headers });
  assert.doesNotMatch(jobLogs.logs, /synthetic-session-signature/);
  assert.doesNotMatch(JSON.stringify(job), /synthetic-session-signature|refresh_token|accessToken/);
  console.log("Phone binding console: import switches, session insights, no phone requests, recheck, restart, grouping, deduplication and enabled authorization passed (local fixtures).");
} finally {
  await stop(child);
  await stop(backend);
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith("tosub2-phone-binding-")) await fs.rm(root, { recursive: true, force: true });
}
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const number = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return number;
}
