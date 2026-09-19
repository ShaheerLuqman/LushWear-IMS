// Packaging List modal - order numbers typed in or extracted from an uploaded labels PDF,
// generates a packaging-list PDF. Ported from orders-actions.js's openPackagingListModal/
// handlePackagingListPdfUpload/generatePackagingListFromNumbers.
import { useRef, useState } from 'react';
import { FormLayout, Text } from '@shopify/polaris';
import { FormModal } from '../../components/FormModal';
import { OrderNumbersField } from '../../components/OrderNumbersField';
import { apiRequest } from '../../api';
import { useToast } from '../../toast/ToastContext';
import { parseOrderNumbersFromText } from '../../logic/loadSheets';

function packagingListPdfFilename(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `packaging_list_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}.pdf`;
}

export function PackagingListModal({ initialOrderNumbers, onClose }: { initialOrderNumbers: Array<string | number>; onClose: () => void }) {
  const { showToast } = useToast();
  const [orderNumbersText, setOrderNumbersText] = useState(() => [...new Set(initialOrderNumbers.map(String))].join('\n'));
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const orderNumbers = parseOrderNumbersFromText(orderNumbersText);

  async function onPdfUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length === 0) return;
    setUploading(true);
    // Start from order numbers already entered so multiple uploads accumulate.
    const merged: string[] = [];
    const seen = new Set<string>();
    const addNumbers = (nums: Array<string | number>) => {
      for (const n of nums) {
        const key = String(n).trim();
        if (key && !seen.has(key)) { seen.add(key); merged.push(key); }
      }
    };
    addNumbers(orderNumbers);
    const failed: string[] = [];
    try {
      for (const file of files) {
        try {
          const formData = new FormData();
          formData.append('file', file);
          const res = await apiRequest('/orders/extract-order-numbers-from-pdf', { method: 'POST', body: formData, fallback: 'Failed to read PDF' });
          const data = await res.json();
          addNumbers(data.order_numbers || []);
        } catch (err) {
          failed.push(file.name);
          console.error(`Failed to read ${file.name}:`, err);
        }
      }
      setOrderNumbersText(merged.join('\n'));
      if (failed.length) showToast(`Could not read ${failed.length} PDF(s): ${failed.join(', ')}`, 'error');
      else if (merged.length === 0) showToast('No order numbers found in the selected PDF(s)', 'error');
      else showToast(`Found ${merged.length} order number(s) from ${files.length > 1 ? `${files.length} PDFs` : 'PDF'}`, 'success');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function generate() {
    if (orderNumbers.length === 0) { showToast('Enter at least one valid order number (one per line).', 'error', { silent: true }); return; }
    setGenerating(true);
    try {
      const res = await apiRequest('/orders/generate-packaging-list-by-numbers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order_numbers: orderNumbers }),
        fallback: 'Failed to generate packaging list',
      });
      const matchedCount = parseInt(res.headers.get('X-Matched-Count') || '0', 10);
      const notFound = (res.headers.get('X-Not-Found') || '').split(',').filter(Boolean);
      const cancelled = (res.headers.get('X-Cancelled') || '').split(',').filter(Boolean);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = packagingListPdfFilename();
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      onClose();
      const notes: string[] = [];
      if (notFound.length > 0) notes.push(`Not found: ${notFound.join(', ')}`);
      if (cancelled.length > 0) notes.push(`Cancelled (excluded): ${cancelled.join(', ')}`);
      showToast(notes.length ? `Packaging list saved (${matchedCount} order(s)). ${notes.join('. ')}` : `Packaging list saved (${matchedCount} order(s))`, notes.length ? 'info' : 'success');
    } catch (e: any) {
      showToast(e?.message || 'Failed to generate packaging list', 'error');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <FormModal
      title="Packaging List" onClose={onClose} onSubmit={generate} submitLabel="Generate packaging list" saving={generating}
      extraActions={[{ content: 'Upload PDFs', loading: uploading, onAction: () => fileInputRef.current?.click() }]}
    >
      <FormLayout>
        <Text as="p" tone="subdued">Enter order numbers (one per line), or upload a labels PDF to fill them automatically.</Text>
        <OrderNumbersField value={orderNumbersText} onChange={setOrderNumbersText} rows={10} />
      </FormLayout>
      <input ref={fileInputRef} type="file" accept="application/pdf,.pdf" multiple style={{ display: 'none' }} onChange={onPdfUpload} />
    </FormModal>
  );
}
