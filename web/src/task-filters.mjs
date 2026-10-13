export const DEFAULT_FILTERS = { search: "", status: "all", dateField: "createdAt", preset: "all", startDate: "", endDate: "" };
export const AUTH_STATUSES = { all: "所有状态", running: "进行中", queued: "排队中", waiting: "待输入", completed: "已完成", failed: "失败", recoverable: "可恢复", canceled: "已取消" };

export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function localDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return dayKey(date) === value ? date : null;
}

export function dateBounds(filters, now = new Date()) {
  let start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let end = new Date(start);
  end.setDate(end.getDate() + 1);
  if (filters.preset === "all") return { start: null, end: null };
  if (filters.preset === "yesterday") { start.setDate(start.getDate() - 1); end.setDate(end.getDate() - 1); }
  if (filters.preset === "week") start.setDate(start.getDate() - 6);
  if (filters.preset === "month") start.setDate(start.getDate() - 29);
  if (filters.preset === "custom") {
    start = localDay(filters.startDate);
    end = localDay(filters.endDate);
    if (!start || !end) return { error: "请选择开始日期和结束日期" };
    if (start > end) return { error: "开始日期不能晚于结束日期" };
    end.setDate(end.getDate() + 1);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

export function queryFilters(filters, now = new Date()) {
  const bounds = dateBounds(filters, now);
  if (bounds.error) return bounds;
  const today = dateBounds({ preset: "today" }, now);
  return { search: filters.search.trim(), status: filters.status, dateField: filters.dateField, ...(bounds.start ? bounds : {}), todayStart: today.start, todayEnd: today.end };
}

export function matchesDate(row, filters, now = new Date()) {
  const bounds = dateBounds(filters, now);
  if (bounds.error) return false;
  if (!bounds.start) return true;
  const time = Date.parse(row[filters.dateField]);
  return Number.isFinite(time) && time >= Date.parse(bounds.start) && time < Date.parse(bounds.end);
}

export function hasFilters(filters) {
  return Boolean(filters.search.trim() || filters.status !== "all" || filters.preset !== "all");
}
