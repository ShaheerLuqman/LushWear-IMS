// Change password modal, opened from Settings > Account. Ported from the deleted
// app-core.js's initChangePasswordModal.
import { useState } from 'react';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { showToast } = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError('');
    if (next !== confirm) { setError('New passwords do not match'); return; }
    setSaving(true);
    try {
      await apiJson('/auth/change-password', { method: 'POST', body: { current_password: current, new_password: next } });
      showToast('Password updated', 'success');
      onClose();
    } catch (ex: any) {
      setError(ex?.message || 'Could not update password');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content password-change-modal-content">
        <div className="modal-header">
          <h2>Change password</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <form className="password-change-form" autoComplete="off" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div className="form-group">
              <label htmlFor="changePasswordCurrent">Current password</label>
              <input type="password" id="changePasswordCurrent" className="auth-gate-input" minLength={8} maxLength={128} required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
            </div>
            <div className="form-group">
              <label htmlFor="changePasswordNew">New password</label>
              <input type="password" id="changePasswordNew" className="auth-gate-input" minLength={8} maxLength={128} required autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="changePasswordNewConfirm">Confirm new password</label>
              <input type="password" id="changePasswordNewConfirm" className="auth-gate-input" minLength={8} maxLength={128} required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {error && <p className="auth-gate-error" role="alert">{error}</p>}
          </form>
        </div>
        <div className="modal-pinned-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={submit}>{saving ? 'Saving...' : 'Save password'}</button>
        </div>
      </div>
    </div>
  );
}
