// Toast popups + the notification bell's history panel. React port of
// delivery-status.js's showToast() + notifications.js - in-memory only,
// resets on reload, same as before.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface NotificationItem {
  id: string;
  message: string;
  type: ToastType;
  time: number;
  read: boolean;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType, opts?: { silent?: boolean }) => void;
  notifications: NotificationItem[];
  unreadCount: number;
  markAllRead: () => void;
  clearAll: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast() used outside <ToastProvider>');
  return ctx;
}

const NOTIFICATIONS_MAX = 50;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [current, setCurrent] = useState<{ message: string; type: ToastType; visible: boolean } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string, type: ToastType = 'info', { silent = false }: { silent?: boolean } = {}) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setCurrent({ message, type, visible: true });
    hideTimer.current = setTimeout(() => setCurrent((c) => (c ? { ...c, visible: false } : c)), 3000);

    if (!silent) {
      setNotifications((prev) => {
        const next = [{ id: `${Date.now()}-${Math.random()}`, message, type, time: Date.now(), read: false }, ...prev];
        return next.slice(0, NOTIFICATIONS_MAX);
      });
    }
  }, []);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => (prev.some((n) => !n.read) ? prev.map((n) => ({ ...n, read: true })) : prev));
  }, []);

  const clearAll = useCallback(() => setNotifications([]), []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <ToastContext.Provider value={{ showToast, notifications, unreadCount, markAllRead, clearAll }}>
      {children}
      {current && <div className={`toast ${current.type}${current.visible ? ' show' : ''}`}>{current.message}</div>}
    </ToastContext.Provider>
  );
}
