import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { matchesTaskQuery, normalizeTaskQuery, summarizeTasks, taskStatusGroup } from "../src/task-query.mjs";
import { dateBounds, DEFAULT_FILTERS, localDay, matchesDate } from "../web/src/task-filters.mjs";

const window = { start: "2026-10-12T16:00:00.000Z", end: "2026-10-13T16:00:00.000Z" };
const query = normalizeTaskQuery({ ...window, todayStart: window.start, todayEnd: window.end });
const jobs = [
  { email: "start@example.com", status: "completed", createdAt: window.start, lastOperationAt: "2026-10-13T02:00:00Z" },
  { email: "last@example.com", status: "email_otp", createdAt: "2026-10-13T15:59:59.999Z" },
  { email: "next@example.com", status: "working", createdAt: window.end },
  { email: "old@example.com", status: "failed", createdAt: "2026-10-01T00:00:00Z", lastOperationAt: window.start },
  { email: "unknown@example.com", status: "queued", createdAt: "" },
];
assert.deepEqual(jobs.filter((job) => matchesTaskQuery(job, query)).map((job) => job.email), ["start@example.com", "last@example.com"]);
assert.equal(summarizeTasks(jobs, query).today, 2);
assert.equal(summarizeTasks(jobs, query).total, 5);
assert.equal(summarizeTasks(jobs, query).waiting, 1);
assert.equal(summarizeTasks(jobs, query).running, 1);
assert.equal(taskStatusGroup("phone_otp"), "waiting");
assert.equal(taskStatusGroup("checking_account"), "running");
assert.equal(taskStatusGroup("resume_available"), "recoverable");
const combined = normalizeTaskQuery({ ...window, search: " START@ ", status: "completed", todayStart: window.start, todayEnd: window.end });
assert.deepEqual(jobs.filter((job) => matchesTaskQuery(job, combined)).map((job) => job.email), ["start@example.com"]);
const operated = normalizeTaskQuery({ ...window, dateField: "lastOperationAt" });
assert(jobs.filter((job) => matchesTaskQuery(job, operated)).some((job) => job.email === "old@example.com"));
for (const value of [{ status: "invalid" }, { dateField: "updatedAt" }, { start: window.start }, { start: window.end, end: window.start }, { todayStart: window.start }, { todayStart: window.start, todayEnd: "2026-10-15T00:00:00Z" }, { search: "a".repeat(201) }]) {
  assert.throws(() => normalizeTaskQuery(value), (error) => error.status === 400);
}
assert.equal(localDay("2026-02-30"), null);
assert.equal(matchesDate({ createdAt: "" }, { ...DEFAULT_FILTERS, preset: "today" }), false);
assert(dateBounds({ preset: "custom", startDate: "2026-10-14", endDate: "2026-10-13" }).error);
assert(dateBounds({ preset: "custom", startDate: "", endDate: "" }).error);
// Calendar arithmetic must preserve the 23/25-hour daylight-saving days.
const moduleUrl = new URL("../web/src/task-filters.mjs", import.meta.url).href;
const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
  import assert from 'node:assert/strict';
  import { dateBounds } from ${JSON.stringify(moduleUrl)};
  const spring = dateBounds({ preset:'today' }, new Date(2026,2,8,12));
  const autumn = dateBounds({ preset:'today' }, new Date(2026,10,1,12));
  assert.equal(Date.parse(spring.end)-Date.parse(spring.start), 23*60*60*1000);
  assert.equal(Date.parse(autumn.end)-Date.parse(autumn.start), 25*60*60*1000);
  const week = dateBounds({ preset:'week' }, new Date(2026,2,8,12));
  assert.equal(new Date(week.start).getDate(), 2);
`], { env: { ...process.env, TZ: "America/New_York" }, encoding: "utf8" });
assert.equal(child.status, 0, child.stderr);
console.log("Task queries: date boundaries, status groups, combined filters, unknown dates and DST passed");
