// Change password modal, opened from Settings > Account.
import { useState } from 'react';
import { FormLayout, InlineError, TextField } from '@shopify/polaris';
import { apiJson } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { FormModal } from '../../components/FormModal';

export function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { showToast } = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function submit() {
    setError('');
    if (current.length < 8 || next.length < 8) { setError('Passwords must be at least 8 characters'); return; }
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
    <FormModal title="Change password" onClose={onClose} onSubmit={submit} submitLabel="Save password" saving={saving} size="small">
      <FormLayout>
        <TextField label="Current password" type="password" autoComplete="current-password" maxLength={128} value={current} onChange={setCurrent} autoFocus />
        <TextField label="New password" type="password" autoComplete="new-password" maxLength={128} value={next} onChange={setNext} />
        <TextField label="Confirm new password" type="password" autoComplete="new-password" maxLength={128} value={confirm} onChange={setConfirm} />
        {error && <InlineError message={error} fieldID="changePassword" />}
      </FormLayout>
    </FormModal>
  );
}
