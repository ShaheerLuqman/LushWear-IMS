// Polaris Modal wired the way every form modal here works: a pinned Cancel/submit
// footer, Enter submits, and the primary button reflects the in-flight save.
import type { ReactNode } from 'react';
import { Modal, type ModalProps } from '@shopify/polaris';

export function FormModal({
  title, onClose, onSubmit, submitLabel = 'Save', saving, disabled, destructive, size, children,
}: {
  title: string;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel?: string;
  saving?: boolean;
  disabled?: boolean;
  destructive?: boolean;
  size?: ModalProps['size'];
  children: ReactNode;
}) {
  return (
    <Modal
      open onClose={onClose} title={title} size={size}
      primaryAction={{ content: submitLabel, onAction: onSubmit, loading: saving, disabled, destructive }}
      secondaryActions={[{ content: 'Cancel', onAction: onClose, disabled: saving }]}
    >
      <Modal.Section>
        <form autoComplete="off" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
          {children}
          <button type="submit" hidden />
        </form>
      </Modal.Section>
    </Modal>
  );
}
