// In-app confirm dialog (replaces window.confirm everywhere) - React port of
// delivery-status.js's showAppConfirm(). useConfirm() returns a function with
// the exact same Promise<boolean> contract.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
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
        <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) finish(false); }}>
          <div className="modal-content delete-confirm-modal-content app-confirm-modal-content">
            <div className="modal-header">
              <h2>{pending.title || 'Confirm'}</h2>
              <button type="button" className="modal-close" aria-label="Close" onClick={() => finish(false)}>&times;</button>
            </div>
            <div className="modal-body">
              <p className="app-confirm-message">{pending.message}</p>
            </div>
            <div className="modal-pinned-footer">
              <button type="button" className="btn btn-secondary" onClick={() => finish(false)}>Cancel</button>
              <button type="button" className={pending.danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => finish(true)}>
                {pending.confirmText || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
