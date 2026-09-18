// Header bell icon + dropdown history panel. React port of notifications.js's initNotifications().
import { useEffect, useRef, useState } from 'react';
import { Button, Tooltip } from '@shopify/polaris';
import { NotificationFilledIcon, NotificationIcon } from '@shopify/polaris-icons';
import { useToast } from './ToastContext';

function formatRelativeTime(timestampMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function NotificationBell() {
  const { notifications, unreadCount, markAllRead, clearAll } = useToast();
  const [open, setOpen] = useState(false);
  const [ringing, setRinging] = useState(false);
  const [panelPos, setPanelPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const prevUnreadRef = useRef(unreadCount);

  useEffect(() => {
    if (unreadCount > prevUnreadRef.current) {
      setRinging(true);
      const timer = setTimeout(() => setRinging(false), 600);
      prevUnreadRef.current = unreadCount;
      return () => clearTimeout(timer);
    }
    prevUnreadRef.current = unreadCount;
  }, [unreadCount]);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function toggle() {
    const opening = !open;
    if (opening && wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      setPanelPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 340) });
    }
    setOpen(opening);
    if (opening) markAllRead();
  }

  return (
    <div className={`header-notif-wrap${ringing ? ' ringing' : ''}`} ref={wrapRef}>
      <Tooltip content="Notifications">
        <Button
          icon={unreadCount > 0 ? NotificationFilledIcon : NotificationIcon}
          accessibilityLabel="Notifications"
          ariaExpanded={open}
          pressed={open}
          onClick={toggle}
        />
      </Tooltip>
      {unreadCount > 0 && <span className="notif-badge">{unreadCount > 9 ? '9+' : unreadCount}</span>}
      {open && (
        <div className="notif-panel" role="menu" aria-label="Notifications" style={{ display: 'block', top: panelPos.top, left: panelPos.left }}>
          <div className="notif-panel-header">
            <span>Notifications</span>
            <button type="button" className="notif-clear-btn" disabled={notifications.length === 0} onClick={clearAll}>Clear all</button>
          </div>
          <div className="notif-list">
            {notifications.length === 0
              ? <div className="notif-empty">No notifications yet</div>
              : notifications.map((n) => (
                <div key={n.id} className={`notif-item ${n.type}${n.read ? '' : ' unread'}`}>
                  <div className="notif-item-body">
                    <div className="notif-item-message">{n.message}</div>
                    <div className="notif-item-time">{formatRelativeTime(n.time)}</div>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
