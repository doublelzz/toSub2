export const ANNOUNCEMENT_READ_KEY = "tosub2.announcement.dismissed-versions.v1";
const dismissedInMemory = new Set();

function savedVersions() {
  try {
    const value = JSON.parse(window.localStorage.getItem(ANNOUNCEMENT_READ_KEY) || "[]");
    return Array.isArray(value) ? value.filter((id) => typeof id === "string").slice(-50) : [];
  } catch { return []; }
}

export function hasDismissedAnnouncement(id) {
  return dismissedInMemory.has(id) || savedVersions().includes(id);
}

export function dismissAnnouncement(id) {
  if (!id) return;
  dismissedInMemory.add(id);
  try {
    const versions = [...new Set([...savedVersions(), ...dismissedInMemory])].slice(-50);
    window.localStorage.setItem(ANNOUNCEMENT_READ_KEY, JSON.stringify(versions));
  } catch { /* Keep the current session usable when browser storage is unavailable. */ }
}
