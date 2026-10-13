const RUNNING = new Set(["starting", "working", "finalizing", "refreshing", "checking_account", "totp_starting", "password_add_starting"]);
const WAITING = new Set(["password", "mfa_otp", "totp_setup_otp", "email_otp", "phone", "phone_otp"]);
const RECOVERABLE = new Set(["reauth_required", "resume_available", "phone_skipped"]);
const GROUPS = new Set(["all", "running", "queued", "waiting", "completed", "failed", "canceled", "recoverable"]);

function badQuery(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function instant(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw badQuery(`${label}格式错误`);
  }
  return Date.parse(value);
}

export function normalizeTaskQuery(value = {}, now = new Date()) {
  const search = String(value.search || "").trim().toLowerCase();
  if (search.length > 200) throw badQuery("邮箱关键词最多 200 个字符");
  const status = value.status || "all";
  if (!GROUPS.has(status)) throw badQuery("任务状态筛选无效");
  const phoneBinding = value.phoneBinding || "all";
  if (!["all", "enabled", "disabled"].includes(phoneBinding)) throw badQuery("接码任务筛选无效");
  const dateField = value.dateField || "createdAt";
  if (!["createdAt", "lastOperationAt"].includes(dateField)) throw badQuery("日期字段筛选无效");
  const start = instant(value.start, "开始时间");
  const end = instant(value.end, "结束时间");
  if ((start === null) !== (end === null) || (start !== null && start >= end)) throw badQuery("请选择有效的完整日期范围");
  let todayStart = instant(value.todayStart, "当天开始时间");
  let todayEnd = instant(value.todayEnd, "当天结束时间");
  if ((todayStart === null) !== (todayEnd === null)) throw badQuery("当天统计需要完整时间范围");
  if (todayStart === null) {
    const local = new Date(now);
    local.setHours(0, 0, 0, 0);
    todayStart = local.getTime();
    local.setDate(local.getDate() + 1);
    todayEnd = local.getTime();
  }
  if (todayEnd <= todayStart || todayEnd - todayStart > 27 * 60 * 60 * 1000) throw badQuery("当天统计时间范围无效");
  return { search, status, phoneBinding, dateField, start, end, todayStart, todayEnd };
}

export function taskStatusGroup(status) {
  if (RUNNING.has(status)) return "running";
  if (WAITING.has(status)) return "waiting";
  if (RECOVERABLE.has(status)) return "recoverable";
  return status;
}

export function matchesTaskQuery(job, query) {
  if (query.phoneBinding === "enabled" && job.phoneBindingEnabled === false) return false;
  if (query.phoneBinding === "disabled" && job.phoneBindingEnabled !== false) return false;
  if (query.search && !String(job.email).toLowerCase().includes(query.search)) return false;
  if (query.status !== "all" && taskStatusGroup(job.status) !== query.status) return false;
  if (query.start !== null) {
    const timestamp = Date.parse(job[query.dateField] || (query.dateField === "lastOperationAt" ? job.createdAt : ""));
    if (!Number.isFinite(timestamp) || timestamp < query.start || timestamp >= query.end) return false;
  }
  return true;
}

export function summarizeTasks(jobs, query) {
  const stats = { total: jobs.length, today: 0, running: 0, waiting: 0, queued: 0, completed: 0, failed: 0, canceled: 0, recoverable: 0, phoneEnabled: 0, phoneDisabled: 0 };
  for (const job of jobs) {
    if (job.phoneBindingEnabled === false) stats.phoneDisabled++; else stats.phoneEnabled++;
    const timestamp = Date.parse(job.createdAt);
    if (timestamp >= query.todayStart && timestamp < query.todayEnd) stats.today++;
    const group = taskStatusGroup(job.status);
    if (Object.hasOwn(stats, group)) stats[group]++;
  }
  return stats;
}
