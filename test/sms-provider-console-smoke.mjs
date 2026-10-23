import assert from "node:assert/strict";
import "./console-auth.mjs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tosub2-sms-provider-"));
const smsActions = [];
let smsChecks = 0;
let autoRotateNumberCalls = 0;
let customInboxChecks = 0;
const smsServer = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/custom-inbox") {
    customInboxChecks += 1;
    const messages = customInboxChecks === 1
      ? [{ id: "old-sms", text: "OpenAI code\n111111\n" }]
      : [
          { id: "new-sms", text: "OpenAI code\n654321\n" },
          { id: "old-sms", text: "OpenAI code\n111111\n" },
        ];
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ messages }));
    return;
  }
  const isOffers = url.pathname === "/api/v1/activations/offers/sms";
  const isQuality = url.pathname === "/api/v1/stats/deliverability";
  const action = isOffers ? "offers" : isQuality ? "quality" : url.searchParams.get("action");
  const isHero = isOffers || isQuality || url.pathname === "/hero/handler_api.php";
  smsActions.push({
    provider: isHero ? "herosms" : "smsbower",
    action,
    status: url.searchParams.get("status"),
    maxPrice: url.searchParams.get("maxPrice"),
    providerIds: url.searchParams.get("providerIds"),
    country: url.searchParams.get("country"),
    fixedPrice: url.searchParams.get("fixedPrice"),
  });
  let body = "BAD_ACTION";
  if (action === "getNumber") {
    if (url.searchParams.get("api_key") === "auto-rotate-key" && autoRotateNumberCalls++ === 0) {
      body = "NO_NUMBERS";
    } else {
      body = `ACCESS_NUMBER:mock-activation-${autoRotateNumberCalls}:60123456789`;
    }
  }
  if (action === "getStatus") body = ++smsChecks < 2 ? "STATUS_WAIT_CODE" : "STATUS_OK:654321";
  if (isHero && url.searchParams.get("api_key") === "hero-cancel-key" && action === "getStatus") body = "STATUS_WAIT_CODE";
  if (isOffers) {
    assert.equal(req.headers.authorization, "ApiKey test-hero-key");
    assert.equal(url.searchParams.get("services"), "dr");
    body = JSON.stringify({ data: { dr: {
      7: { map: { "0.1800": 8 } },
      16: { map: { "0.4200": 12 } },
    } } });
  }
  if (isQuality) {
    assert.equal(req.headers.authorization, "ApiKey test-hero-key");
    assert.deepEqual(url.searchParams.getAll("services[]"), ["dr"]);
    body = JSON.stringify({ data: { dr: [{ country: 7, successRate: 94 }, { country: 16, successRate: 72 }] } });
  }
  if (action === "getTopCountriesByService") body = JSON.stringify({
    japan: { 3301: { price: 0.42, count: 12 } },
    malaysia: { 3401: { price: 0.18, count: 8 } },
  });
  if (action === "getPricesV3") body = JSON.stringify({
    1001: { dr: { 3301: { price: 0.42, count: 12 }, 3302: { price: 0.1, count: 20 } } },
    7: { dr: { 3401: { price: 0.18, count: 8 }, 3402: { price: 0.08, count: 40 } } },
  });
  if (action === "getCountries") body = JSON.stringify({ countries: [
    { id: 350, activate_org_code: "1001", slug: "japan", eng: "Japan", chn: "日本" },
    { id: 71, activate_org_code: "7", slug: "malaysia", eng: "Malaysia", chn: "马来西亚" },
  ] });
  if (action === "getCountries" && isHero) body = JSON.stringify({
    7: { id: 7, chn: "马来西亚", eng: "Malaysia" },
    16: { id: 16, chn: "英国", eng: "England" },
  });
  if (action === "setStatus") {
    body = { "1": "ACCESS_READY", "6": "ACCESS_ACTIVATION", "8": "ACCESS_CANCEL" }[url.searchParams.get("status")] || "BAD_STATUS";
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
});
await listen(smsServer);

const consolePort = await findAvailablePort();
const baseUrl = `http://127.0.0.1:${consolePort}`;
const child = spawn(process.execPath, [path.join(projectRoot, "src", "console-server.mjs"), "--host", "127.0.0.1", "--port", String(consolePort)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ONBOARDING_OUTPUT_ROOT: outputRoot,
    TOSUB2_MAC_CREDENTIAL_ROOT: path.join(outputRoot, "test-mac-credentials"),
    ONBOARDING_PROTOCOL_SCRIPT: path.join(projectRoot, "test", "mock-protocol-login.mjs"),
    TOSUB2_TLS_PROFILE: "chrome142",
    SMSBOWER_API_BASE: `http://127.0.0.1:${smsServer.address().port}/handler_api.php`,
    HERO_SMS_API_BASE: `http://127.0.0.1:${smsServer.address().port}/hero/handler_api.php`,
    SMS_POLL_INTERVAL_MS: "20",
    SMS_POLL_TIMEOUT_MS: "3000",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let logs = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { logs += chunk; });
child.stderr.on("data", (chunk) => { logs += chunk; });
const childExit = new Promise((resolve) => child.once("exit", resolve));

try {
  const bootstrap = await waitForJson(`${baseUrl}/api/bootstrap`);
  assert.deepEqual(bootstrap.features.smsProviders.map((provider) => provider.id), ["luban", "smsbower", "herosms", "custom"]);
  const headers = { "content-type": "application/json", "x-console-token": bootstrap.token };
  const optionsResponse = await fetch(`${baseUrl}/api/sms-providers/smsbower/options`, {
    method: "POST",
    headers,
    body: JSON.stringify({ config: { apiKey: "test-api-key", service: "dr", country: "1001" } }),
  });
  const optionsText = await optionsResponse.text();
  assert.equal(optionsResponse.status, 200, optionsText);
  const optionData = JSON.parse(optionsText);
  assert.deepEqual(optionData.options.map((option) => option.country), ["7", "1001", "7", "1001"]);
  assert.deepEqual(optionData.options.map((option) => option.grade), ["unknown", "unknown", "gold", "gold"]);
  assert.equal(optionData.options[0].providerIds, "3402");
  assert.equal(optionData.options[0].price, 0.08);

  for (const variant of ["coalesced", "split", "failed", "resume"]) {
    const numbersBefore = smsActions.filter(item => item.action === "getNumber").length;
    const pollsBefore = smsActions.filter(item => item.action === "getStatus").length;
    const completionsBefore = smsActions.filter(item => item.action === "setStatus" && item.status === "6").length;
    const smsProvider = { id: "smsbower", config: {
      apiKey: "test-api-key", service: "dr", country: "1001", maxPrice: "0.42", providerIds: "3301", maxRotationAttempts: "1",
    } };
    const response = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST", headers,
      body: JSON.stringify({
        email: `insights-phone-${variant}@example.com`, phoneBindingMode: variant === "resume" ? "manual" : "automatic", smsProvider,
      }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const { job: automatic } = await response.json();
    if (variant === "resume") {
      await waitForJob(headers, automatic.id, job => job.status === "phone_skipped");
      assert.equal(smsActions.filter(item => item.action === "getNumber").length, numbersBefore);
      const start = await fetch(`${baseUrl}/api/jobs/${automatic.id}/start-phone`, {
        method: "POST", headers, body: JSON.stringify({ smsProvider }),
      });
      assert.equal(start.status, 200, await start.text());
    }
    const completedAutomatic = await waitForJob(headers, automatic.id, job => job.status === "completed");
    assert.equal(completedAutomatic.smsStatus, "completed", `${variant}: SMS must finish without manual input`);
    assert.equal(completedAutomatic.phoneVerificationStatus, "verified");
    assert.equal(smsActions.filter(item => item.action === "getNumber").length, numbersBefore + 1,
      `${variant}: detecting the phone prompt must acquire exactly one number automatically`);
    assert.ok(smsActions.filter(item => item.action === "getStatus").length > pollsBefore);
    for (let index = 0; index < 50; index++) {
      if (smsActions.filter(item => item.action === "setStatus" && item.status === "6").length > completionsBefore) break;
      await delay(20);
    }
    assert.equal(smsActions.filter(item => item.action === "setStatus" && item.status === "6").length, completionsBefore + 1);
    const jobLogs = await fetch(`${baseUrl}/api/jobs/${automatic.id}/logs`, { headers }).then(response => response.json());
    assert.match(jobLogs.logs, /\[sms\].*SMSBower.*1\/1/);
  }

  const batchCreatedResponse = await fetch(`${baseUrl}/api/jobs/batch`, {
    method: "POST", headers,
    body: JSON.stringify({ text: Array.from({ length: 22 }, (_, index) => `insights-phone-batch-${index}@example.com`).join("\n"), phoneBindingMode: "manual" }),
  });
  assert.equal(batchCreatedResponse.status, 201);
  const batchJobs = (await batchCreatedResponse.json()).jobs;
  const batchIds = batchJobs.map(job => job.id);
  let batchPage;
  for (let index = 0; index < 100; index++) {
    batchPage = await fetch(`${baseUrl}/api/jobs?search=insights-phone-batch-`, { headers }).then(response => response.json());
    if (batchPage.selection.length === 22 && batchPage.selection.every(job => job.canStartPhoneBinding)) break;
    await delay(100);
  }
  assert.equal(batchPage.jobs.length, 20);
  assert.equal(batchPage.selection.length, 22);
  assert.ok(batchPage.selection.every(job => job.canStartPhoneBinding), "cross-page selection must include phone eligibility");
  const firstBatchId = batchPage.jobs[0].id;
  const secondBatchId = batchIds.find(id => !batchPage.jobs.some(job => job.id === id));
  const batchSmsProvider = { id: "smsbower", config: { apiKey: "test-api-key", service: "dr", country: "1001", maxPrice: "0.42", providerIds: "3301", maxRotationAttempts: "1" } };
  const numbersBeforeBatch = smsActions.filter(item => item.action === "getNumber").length;
  const invalidBatchSetup = await fetch(`${baseUrl}/api/jobs/start-phone-batch`, {
    method: "POST", headers, body: JSON.stringify({ ids: [firstBatchId] }),
  });
  assert.equal(invalidBatchSetup.status, 400);
  const missingBatchJob = await fetch(`${baseUrl}/api/jobs/start-phone-batch`, {
    method: "POST", headers, body: JSON.stringify({ ids: [firstBatchId, "missing-job"], smsProvider: batchSmsProvider }),
  });
  assert.equal(missingBatchJob.status, 404);
  assert.equal(smsActions.filter(item => item.action === "getNumber").length, numbersBeforeBatch,
    "invalid selection or platform config must not acquire numbers");
  const completedFixture = await fetch(`${baseUrl}/api/jobs?search=insights-phone-coalesced`, { headers }).then(response => response.json());
  const batchRequest = () => fetch(`${baseUrl}/api/jobs/start-phone-batch`, {
    method: "POST", headers,
    body: JSON.stringify({ ids: [firstBatchId, secondBatchId, firstBatchId, completedFixture.jobs[0].id], smsProvider: batchSmsProvider }),
  });
  const batchResponses = await Promise.all([batchRequest(), batchRequest()]);
  const batchResults = await Promise.all(batchResponses.map(response => response.json()));
  assert.equal(batchResults.reduce((count, result) => count + (result.started || 0), 0), 2,
    "overlapping batch requests must enqueue each selected eligible task once");
  assert.ok(batchResponses.every(response => [200, 409].includes(response.status)));
  assert.ok(batchResults.some(result => result.skipped >= 1), "verified accounts must be skipped");
  for (const selectedId of [firstBatchId, secondBatchId]) {
    // The second selected task is off the first page of the unfinished list.
    for (let attempt = 0; attempt < 100; attempt++) {
      const email = batchJobs.find(job => job.id === selectedId).email;
      const page = await fetch(`${baseUrl}/api/jobs?search=${encodeURIComponent(email)}`, { headers }).then(response => response.json());
      const job = page.jobs.find(job => job.id === selectedId);
      if (job?.status === "completed") break;
      if (attempt === 99) {
        const detail = await fetch(`${baseUrl}/api/jobs/${selectedId}/logs`, { headers }).then(response => response.json());
        assert.fail(`selected batch task did not complete: ${JSON.stringify(job)}\n${detail.logs}`);
      }
      await delay(50);
    }
  }
  assert.equal(smsActions.filter(item => item.action === "getNumber").length, numbersBeforeBatch + 2);
  const remainingBatch = await fetch(`${baseUrl}/api/jobs?phoneBinding=disabled&search=insights-phone-batch-`, { headers }).then(response => response.json());
  assert.equal(remainingBatch.pagination.total, 20, "unselected unfinished tasks must not start phone binding");
  assert.ok(remainingBatch.selection.every(job => job.status === "phone_skipped"));

  const createdResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "sms-provider@example.com" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  await waitForJob(headers, created.job.id, (job) => job.status === "phone");

  const numberResponse = await fetch(`${baseUrl}/api/jobs/${created.job.id}/sms-number`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      providerId: "smsbower",
      config: { apiKey: "test-api-key", service: "dr", country: "1001", maxPrice: "0.42", providerIds: "3301" },
    }),
  });
  assert.equal(numberResponse.status, 200, await numberResponse.text());
  const completed = await waitForJob(headers, created.job.id, (job) => job.status === "completed");
  assert.equal(completed.smsProviderName, "SMSBower");
  assert.equal(completed.smsStatus, "completed");
  assert.ok(smsActions.some((item) => item.action === "getNumber"));
  assert.ok(smsActions.some((item) => item.action === "getStatus"));
  assert.ok(smsActions.some((item) => item.action === "setStatus" && item.status === "1"));
  assert.ok(smsActions.some((item) => item.action === "setStatus" && item.status === "6"));
  assert.ok(smsActions.some((item) => item.action === "getNumber" && item.maxPrice === "0.42"));
  assert.ok(smsActions.some((item) => item.action === "getNumber" && item.providerIds === "3301"));

  const completedOrderCount = smsActions.filter((item) => item.action === "setStatus" && item.status === "6").length;
  const releasedOrderCount = smsActions.filter((item) => item.action === "setStatus" && item.status === "8").length;
  const smsChecksBeforeRejectedNumber = smsChecks;
  const rejectedResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "sms-recently-used@example.com" }),
  });
  assert.equal(rejectedResponse.status, 201);
  const rejected = await rejectedResponse.json();
  await waitForJob(headers, rejected.job.id, (job) => job.status === "phone");
  const rejectedNumberResponse = await fetch(`${baseUrl}/api/jobs/${rejected.job.id}/sms-number`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      providerId: "smsbower",
      config: {
        apiKey: "test-api-key",
        service: "dr",
        country: "1001",
        maxPrice: "0.42",
        providerIds: "3301",
        maxRotationAttempts: "1",
      },
    }),
  });
  assert.equal(rejectedNumberResponse.status, 200, await rejectedNumberResponse.text());
  const returnedToPhone = await waitForJob(
    headers,
    rejected.job.id,
    (job) => job.status === "phone" && /\u8fd1\u671f\u5df2\u88ab\u4f7f\u7528/.test(job.phoneError || ""),
  );
  assert.equal(returnedToPhone.smsStatus, "error");
  assert.equal(smsChecks - smsChecksBeforeRejectedNumber, 1);
  assert.equal(
    smsActions.filter((item) => item.action === "setStatus" && item.status === "6").length,
    completedOrderCount,
  );
  assert.equal(
    smsActions.filter((item) => item.action === "setStatus" && item.status === "8").length,
    releasedOrderCount + 1,
  );

  const autoRotateCreatedResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "auto-rotate@example.com" }),
  });
  assert.equal(autoRotateCreatedResponse.status, 201);
  const autoRotateCreated = await autoRotateCreatedResponse.json();
  await waitForJob(headers, autoRotateCreated.job.id, (job) => job.status === "phone");
  const autoRotateNumberResponse = await fetch(`${baseUrl}/api/jobs/${autoRotateCreated.job.id}/sms-number`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      providerId: "smsbower",
      config: {
        apiKey: "auto-rotate-key",
        service: "dr",
        country: "1001",
        maxPrice: "0.42",
        providerIds: "3301",
        maxRotationAttempts: "3",
        rotationIntervalSeconds: "0.02",
      },
    }),
  });
  assert.equal(autoRotateNumberResponse.status, 200, await autoRotateNumberResponse.text());
  const autoRotated = await waitForJob(headers, autoRotateCreated.job.id, (job) => job.status === "completed");
  assert.equal(autoRotated.smsStatus, "completed");
  assert.equal(autoRotateNumberCalls, 2);

  const customCreatedResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "custom-sms@example.com" }),
  });
  assert.equal(customCreatedResponse.status, 201);
  const customCreated = await customCreatedResponse.json();
  await waitForJob(headers, customCreated.job.id, (job) => job.status === "phone");
  const customNumberResponse = await fetch(`${baseUrl}/api/jobs/${customCreated.job.id}/sms-number`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      providerId: "custom",
      config: {
        entries: `+8613711111111----${baseUrl.replace(String(consolePort), String(smsServer.address().port))}/custom-inbox`,
      },
    }),
  });
  assert.equal(customNumberResponse.status, 200, await customNumberResponse.text());
  const customCompleted = await waitForJob(headers, customCreated.job.id, (job) => job.status === "completed");
  assert.equal(customCompleted.smsProviderName, "自定义接码");
  assert.equal(customCompleted.currentPhone, "+8613711111111");
  assert.equal(customCompleted.smsStatus, "completed");
  assert.ok(customInboxChecks >= 2);

  const heroOptionsResponse = await fetch(`${baseUrl}/api/sms-providers/herosms/options`, {
    method: "POST", headers,
    body: JSON.stringify({ config: { apiKey: "test-hero-key" } }),
  });
  assert.equal(heroOptionsResponse.status, 200);
  const heroOptions = await heroOptionsResponse.json();
  assert.equal(heroOptions.providerId, "herosms");
  assert.deepEqual(heroOptions.options.map(({ country }) => country), ["7", "16"]);
  assert.deepEqual(heroOptions.options.map(({ successRate }) => successRate), [94, 72]);
  const heroResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST", headers, body: JSON.stringify({ email: "hero-sms@example.com" }),
  });
  assert.equal(heroResponse.status, 201);
  const hero = await heroResponse.json();
  await waitForJob(headers, hero.job.id, (job) => job.status === "phone");
  const heroNumberResponse = await fetch(`${baseUrl}/api/jobs/${hero.job.id}/sms-number`, {
    method: "POST", headers,
    body: JSON.stringify({ providerId: "herosms", config: { apiKey: "test-hero-key", country: "7", maxPrice: "0.18", countryLabel: "马来西亚" } }),
  });
  assert.equal(heroNumberResponse.status, 200, await heroNumberResponse.text());
  const heroCompleted = await waitForJob(headers, hero.job.id, (job) => job.status === "completed");
  assert.equal(heroCompleted.smsProviderId, "herosms");
  assert.equal(heroCompleted.smsProviderName, "Hero SMS");
  assert.equal(heroCompleted.smsStatus, "completed");
  const heroActions = smsActions.filter(({ provider }) => provider === "herosms");
  assert.ok(heroActions.some((item) => item.action === "getNumber" && item.country === "7" && item.maxPrice === "0.18" && item.fixedPrice === "true" && item.providerIds === null));
  assert.ok(!heroActions.some((item) => item.action === "setStatus" && item.status === "1"));
  assert.ok(heroActions.some((item) => item.action === "setStatus" && item.status === "6"));
  const heroMetadata = await fs.readFile(path.join(outputRoot, hero.job.id, "job-meta.json"), "utf8");
  assert.equal(heroMetadata.includes("test-hero-key"), false);
  assert.equal(logs.includes("test-hero-key"), false);

  const cancelResponse = await fetch(`${baseUrl}/api/jobs`, {
    method: "POST", headers, body: JSON.stringify({ email: "hero-cancel@example.com" }),
  });
  const cancelJob = (await cancelResponse.json()).job;
  await waitForJob(headers, cancelJob.id, (job) => job.status === "phone");
  const cancelNumberResponse = await fetch(`${baseUrl}/api/jobs/${cancelJob.id}/sms-number`, {
    method: "POST", headers,
    body: JSON.stringify({ providerId: "herosms", config: { apiKey: "hero-cancel-key", country: "16", maxPrice: "0.42" } }),
  });
  assert.equal(cancelNumberResponse.status, 200);
  await waitForJob(headers, cancelJob.id, (job) => job.status === "phone_otp");
  const heroCancelCount = smsActions.filter((item) => item.provider === "herosms" && item.action === "setStatus" && item.status === "8").length;
  const cancelledResponse = await fetch(`${baseUrl}/api/jobs/${cancelJob.id}/cancel`, { method: "POST", headers, body: "{}" });
  assert.equal(cancelledResponse.status, 200);
  await waitForJob(headers, cancelJob.id, (job) => job.status === "canceled");
  for (let index = 0; index < 50; index += 1) {
    if (smsActions.filter((item) => item.provider === "herosms" && item.action === "setStatus" && item.status === "8").length > heroCancelCount) break;
    await delay(20);
  }
  assert.equal(smsActions.filter((item) => item.provider === "herosms" && item.action === "setStatus" && item.status === "8").length, heroCancelCount + 1);
  console.log("sms provider console tests passed");
} catch (error) {
  error.message = `${error.message}\nConsole output:\n${logs}`;
  throw error;
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.race([childExit, delay(2_000)]);
  await close(smsServer);
  await fs.rm(outputRoot, { recursive: true, force: true });
}

async function waitForJson(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {}
    await delay(100);
  }
  throw new Error("console did not start");
}

async function waitForJob(headers, jobId, predicate) {
  const deadline = Date.now() + 10_000;
  let lastJob = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/jobs`, { headers });
    const page = await response.json();
    const job = page.jobs.find((item) => item.id === jobId);
    lastJob = job || lastJob;
    if (job && predicate(job)) return job;
    if (job?.status === "failed") throw new Error(job.lastError || "task failed");
    await delay(50);
  }
  throw new Error(`task did not reach expected state: ${JSON.stringify(lastJob)}`);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
