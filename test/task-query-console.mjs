import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-query-ui-"));
const probe = net.createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child;
let output = "";
try {
  for (let index = 0; index < 29; index++) {
    const directory = path.join(root, crypto.randomUUID());
    await fs.mkdir(directory);
    const email = `query-${String(index).padStart(2, "0")}@example.com`;
    await fs.writeFile(path.join(directory, "sub2api-import-oauth.json"), JSON.stringify({ type: "sub2api-data", version: 1, accounts: [{ credentials: { email } }] }));
    await fs.writeFile(path.join(directory, "job-meta.json"), JSON.stringify({ version: 1, email, status: "completed", result_saved: true, ...(index < 25 ? { phone_binding_enabled: false } : {}), created_at: index < 25 ? "2026-10-13T01:00:00.000Z" : "2026-10-11T01:00:00.000Z", updated_at: "2026-10-13T02:00:00.000Z", last_operation_at: "2026-10-13T02:00:00.000Z" }));
  }
  child = spawn(process.execPath, ["src/console-server.mjs", "--host", "127.0.0.1", "--port", String(port)], { cwd: projectRoot, env: { ...process.env, ONBOARDING_OUTPUT_ROOT: root }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  let token;
  for (let attempt = 0; attempt < 80; attempt++) {
    try { token = (await (await fetch(`${base}/api/bootstrap`)).json()).token; break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert(token, "isolated console did not start");
  const headers = { "x-console-token": token, "content-type": "application/json" };
  const dates = { start: "2026-10-12T16:00:00.000Z", end: "2026-10-13T16:00:00.000Z", todayStart: "2026-10-12T16:00:00.000Z", todayEnd: "2026-10-13T16:00:00.000Z" };
  const get = async (filters) => (await fetch(`${base}/api/jobs?${new URLSearchParams(filters)}`, { headers })).json();
  const first = await get({ ...dates, page: 1 });
  assert.equal(first.pagination.total, 25);
  assert.equal(first.jobs.length, 20);
  assert.equal(first.selection.length, 25);
  assert.equal(first.stats.total, 29);
  assert.equal(first.stats.today, 25);
  const disabled = await get({ phoneBinding: "disabled", page: 2 });
  assert.equal(disabled.pagination.total, 25);
  assert.equal(disabled.jobs.length, 5);
  assert(disabled.jobs.every(job => job.phoneBindingEnabled === false));
  assert.equal(disabled.selection.length, 25);
  assert.equal(disabled.stats.phoneDisabled, 25);
  assert.equal(disabled.stats.phoneEnabled, 4);
  const enabled = await get({ phoneBinding: "enabled" });
  assert.equal(enabled.pagination.total, 4);
  assert(enabled.jobs.every(job => job.phoneBindingEnabled === true));
  const second = await get({ ...dates, page: 2 });
  assert.equal(second.jobs.length, 5);
  assert.equal(new Set([...first.jobs, ...second.jobs].map((job) => job.id)).size, 25);
  const searched = await get({ ...dates, search: "query-00", page: 2 });
  assert.equal(searched.pagination.total, 1);
  assert.equal(searched.pagination.page, 1);
  assert.equal(searched.selection.length, 1);
  assert.equal(searched.stats.total, 29);
  const exact = await (await fetch(`${base}/api/jobs/query`, { method: "POST", headers, body: JSON.stringify({ ...dates, emails: ["query-00@example.com", "query-28@example.com"], status: "completed" }) })).json();
  assert.equal(exact.pagination.total, 1);
  assert.equal(exact.jobs[0].email, "query-00@example.com");
  assert.equal((await get({ ...dates, dateField: "lastOperationAt" })).pagination.total, 29);
  assert.equal((await fetch(`${base}/api/jobs?status=unknown`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/jobs?phoneBinding=unknown`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/jobs?start=${encodeURIComponent(dates.start)}`, { headers })).status, 400);
  console.log("Task query HTTP: filtering before pagination, global statistics and exact email intersection passed");
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith("tosub2-query-ui-")) await fs.rm(root, { recursive: true, force: true });
}
