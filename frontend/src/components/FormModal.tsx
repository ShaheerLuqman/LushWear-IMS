// Polaris Modal wired the way every form modal here works: a pinned Cancel/submit
// footer, Enter submits, and the primary button reflects the in-flight save.
import type { ReactNode } from 'react';
import { Modal, type ModalProps } from '@shopify/polaris';

export function FormModal({
  title, onClose, onSubmit, submitLabel = 'Save', saving, disabled, destructive, size, children, extraActions = [],
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
  /** Footer buttons besides Cancel/submit (e.g. "Upload PDFs"). */
  extraActions?: NonNullable<ModalProps['secondaryActions']>;
}) {
  return (
    <Modal
      open onClose={onClose} title={title} size={size}
      primaryAction={{ content: submitLabel, onAction: onSubmit, loading: saving, disabled, destructive }}
      secondaryActions={[...extraActions, { content: 'Cancel', onAction: onClose, disabled: saving }]}
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

/** Read-only modal (reports, details): a Close button plus any extra actions. */
export function InfoModal({
  title, onClose, size, children, actions = [],
}: {
  title: string;
  onClose: () => void;
  size?: ModalProps['size'];
  children: ReactNode;
  actions?: NonNullable<ModalProps['secondaryActions']>;
}) {
  return (
    <Modal open onClose={onClose} title={title} size={size} primaryAction={{ content: 'Close', onAction: onClose }} secondaryActions={actions}>
      <Modal.Section>{children}</Modal.Section>
    </Modal>
  );
}
