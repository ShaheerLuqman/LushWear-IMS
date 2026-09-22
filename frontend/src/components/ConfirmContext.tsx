// In-app confirm dialog (replaces window.confirm everywhere) - React port of
// delivery-status.js's showAppConfirm(). useConfirm() returns a function with
// the exact same Promise<boolean> contract.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Modal, Text } from '@shopify/polaris';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
  /** Seconds the confirm button stays disabled, for irreversible actions -
   * long enough that it can't be clicked through on reflex. */
  holdSeconds?: number;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm() used outside <ConfirmProvider>');
  return ctx;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const [held, setHeld] = useState(0);

  useEffect(() => {
    setHeld(pending?.holdSeconds || 0);
    if (!pending?.holdSeconds) return;
    const timer = setInterval(() => setHeld((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise((resolve) => setPending({ ...options, resolve }));
  }, []);

  function finish(ok: boolean) {
    pending?.resolve(ok);
    setPending(null);
  }

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && (
        <Modal
          open onClose={() => finish(false)} title={pending.title || 'Confirm'} size="small"
          primaryAction={{
            content: held > 0 ? `${pending.confirmText || 'Confirm'} (${held})` : (pending.confirmText || 'Confirm'),
            destructive: pending.danger, disabled: held > 0, onAction: () => finish(true),
          }}
          secondaryActions={[{ content: 'Cancel', onAction: () => finish(false) }]}
        >
          <Modal.Section><Text as="p">{pending.message}</Text></Modal.Section>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}
