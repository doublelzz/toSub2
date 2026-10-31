import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Megaphone } from "lucide-react";
import { AnnouncementDialog } from "./Announcement.jsx";
import { ANNOUNCEMENT_READ_KEY, dismissAnnouncement, hasDismissedAnnouncement } from "./announcement-read-state.mjs";

export default function AnnouncementEntry({ announcement }) {
  const [displayed, setDisplayed] = useState(null);

  useEffect(() => {
    if (!announcement?.enabled || !announcement.id) { setDisplayed(null); return; }
    if (displayed || hasDismissedAnnouncement(announcement.id)) return;
    let pending;
    const tryOpen = () => {
      if (!hasDismissedAnnouncement(announcement.id) && !document.querySelector('[role="dialog"][aria-modal="true"]')) {
        setDisplayed((current) => current || announcement);
      }
    };
    // Let an import confirmation or another active task finish before interrupting.
    const observer = new window.MutationObserver(() => { clearTimeout(pending); pending = setTimeout(tryOpen, 0); });
    observer.observe(document.body, { childList: true, subtree: true });
    pending = setTimeout(tryOpen, 0);
    return () => { observer.disconnect(); clearTimeout(pending); };
  }, [announcement?.id, announcement?.enabled, displayed]);

  useEffect(() => {
    const synchronize = (event) => {
      if (event.key !== ANNOUNCEMENT_READ_KEY && event.key !== null) return;
      setDisplayed((current) => current && hasDismissedAnnouncement(current.id) ? null : current);
    };
    window.addEventListener("storage", synchronize);
    return () => window.removeEventListener("storage", synchronize);
  }, []);

  if (!announcement?.enabled || !announcement.id) return null;
  const close = () => { dismissAnnouncement(displayed?.id); setDisplayed(null); };
  return <>
    <button type="button" className="secondary-button announcement-entry" aria-label="查看公告与使用教程" onClick={() => setDisplayed(announcement)}><Megaphone size={16} aria-hidden="true" />公告 / 教程</button>
    {displayed && createPortal(<AnnouncementDialog announcement={displayed.id === announcement.id ? announcement : displayed} onClose={close} />, document.body)}
  </>;
}
