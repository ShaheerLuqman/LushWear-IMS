// Toast popups + the notification bell's history panel. React port of
// delivery-status.js's showToast() + notifications.js - in-memory only,
// resets on reload, same as before.
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { Toast } from '@shopify/polaris';

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
  current: { id: number; message: string; type: ToastType } | null;
  dismiss: () => void;
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
  const [current, setCurrent] = useState<{ id: number; message: string; type: ToastType } | null>(null);

  const showToast = useCallback((message: string, type: ToastType = 'info', { silent = false }: { silent?: boolean } = {}) => {
    setCurrent({ id: Date.now(), message, type });

    if (!silent) {
      setNotifications((prev) => {
        const next = [{ id: `${Date.now()}-${Math.random()}`, message, type, time: Date.now(), read: false }, ...prev];
        return next.slice(0, NOTIFICATIONS_MAX);
      });
    }
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => (prev.some((n) => !n.read) ? prev.map((n) => ({ ...n, read: true })) : prev));
  }, []);

  const clearAll = useCallback(() => setNotifications([]), []);
  const dismiss = useCallback(() => setCurrent(null), []);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return (
    <ToastContext.Provider value={{ showToast, current, dismiss, notifications, unreadCount, markAllRead, clearAll }}>
      {children}
    </ToastContext.Provider>
  );
}

/** Renders the active toast. Polaris Toast needs a Frame ancestor, so this is mounted
 * inside each Frame (AppShell, AdminPortal) rather than by the provider itself. */
export function ToastHost() {
  const { current, dismiss } = useToast();
  if (!current) return null;
  return <Toast key={current.id} content={current.message} error={current.type === 'error'} duration={3000} onDismiss={dismiss} />;
}
