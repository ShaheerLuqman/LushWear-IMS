// Per-order shipping details, opened from a fulfillment row's kebab. Mirrors
// PostEx's own booking screen; fields it lacks are hidden for Couriers Next.
import { useEffect, useState } from 'react';
import { fulfillmentLineItemLabel, fulfillmentOrderDetailString, type FulfillmentOrder } from '../../logic/fulfillment';

export function FulfillmentDetailsModal({
  order, isCouriersNext, pickupLabel, onClose, onSave,
}: {
  order: FulfillmentOrder;
  isCouriersNext: boolean;
  pickupLabel: string;
  onClose: () => void;
  onSave: (patch: Partial<FulfillmentOrder>) => void;
}) {
  const [email, setEmail] = useState(order.email || '');
  const [instructions, setInstructions] = useState(order.instructions || '');
  const [handling, setHandling] = useState(order.handling || 'Standard');
  const [pieces, setPieces] = useState(String(order.pieces ?? 1));
  const [invoiceDivision, setInvoiceDivision] = useState(String(order.invoiceDivision ?? 1));

  // Shows the "- FRAGILE" bullet live while the modal is open; the backend also
  // adds it at send time (idempotently) for any booking that skips this modal.
  useEffect(() => {
    setInstructions((prev) => {
      const lines = prev.split('\n').filter((l) => l.trim().toUpperCase() !== '- FRAGILE');
      if (handling === 'Fragile') {
        while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
        lines.push('- FRAGILE');
      }
      return lines.join('\n');
    });
  }, [handling]);

  const lineItems = order.line_items || [];

  function submit() {
    onSave({
      email: email.trim(),
      instructions: instructions.trim(),
      handling,
      pieces: Math.max(1, parseInt(pieces, 10) || 1),
      invoiceDivision: Math.max(1, parseInt(invoiceDivision, 10) || 1),
    });
  }

  return (
    <div className="modal active" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content fulfillment-details-modal-content">
        <div className="modal-header">
          <h2>Shipping Details</h2>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="fulfillment-details-subtitle">Order #{order.order_number} · {order.name}</p>
          <form autoComplete="off" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <div className="form-group">
              <label htmlFor="fulfillmentDetailsPickup">Pickup Location</label>
              <input type="text" id="fulfillmentDetailsPickup" className="form-input" readOnly value={pickupLabel} />
            </div>
            {!isCouriersNext && (
              <div className="form-group">
                <label htmlFor="fulfillmentDetailsHandling">Handling</label>
                <select id="fulfillmentDetailsHandling" className="form-input" value={handling} onChange={(e) => setHandling(e.target.value)}>
                  <option value="Standard">Standard</option>
                  <option value="Fragile">Fragile</option>
                </select>
              </div>
            )}
            <div className="form-group">
              <label htmlFor="fulfillmentDetailsEmail">Email Address</label>
              <input type="email" id="fulfillmentDetailsEmail" className="form-input" placeholder="user@user.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </div>
            <div className="fulfillment-details-grid">
              <div className="form-group">
                <label htmlFor="fulfillmentDetailsPieces">Pieces</label>
                <input type="number" id="fulfillmentDetailsPieces" className="form-input" min={1} step={1} value={pieces} onChange={(e) => setPieces(e.target.value)} />
              </div>
              {!isCouriersNext && (
                <div className="form-group">
                  <label htmlFor="fulfillmentDetailsInvoiceDivision">Invoice Division</label>
                  <input type="number" id="fulfillmentDetailsInvoiceDivision" className="form-input" min={1} step={1} value={invoiceDivision} onChange={(e) => setInvoiceDivision(e.target.value)} />
                </div>
              )}
            </div>
            {!isCouriersNext && (
              <div className="form-group">
                <label htmlFor="fulfillmentDetailsPaymentMethod">Payment Method</label>
                <input type="text" id="fulfillmentDetailsPaymentMethod" className="form-input" value="Manual" readOnly />
              </div>
            )}
            <div className="form-group fulfillment-details-readonly">
              <label>Fulfillment Products</label>
              <ul className="fulfillment-details-products">
                {lineItems.length
                  ? lineItems.map((li, i) => <li key={i}>{String(li.qty)} &times; {fulfillmentLineItemLabel(li)}</li>)
                  : <li className="fulfillment-details-empty">No products on this order</li>}
              </ul>
            </div>
            <div className="form-group">
              <label htmlFor="fulfillmentDetailsProductString">Products</label>
              <textarea id="fulfillmentDetailsProductString" className="form-input" rows={2} readOnly value={fulfillmentOrderDetailString(lineItems)} />
            </div>
            <div className="form-group">
              <label htmlFor="fulfillmentDetailsInstructions">{isCouriersNext ? 'Special Instructions' : 'Remarks'}</label>
              <textarea id="fulfillmentDetailsInstructions" className="form-input" rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
            </div>
          </form>
        </div>
        <div className="modal-pinned-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={submit}>Save</button>
        </div>
      </div>
    </div>
  );
}
