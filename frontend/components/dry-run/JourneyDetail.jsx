import React from 'react';

import { JsonPanel } from './JsonPanel';

function deferredValues(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Object.prototype.hasOwnProperty.call(value, '$deferred')) {
    found.push(value.$deferred);
  }
  Object.values(value).forEach(child => deferredValues(child, found));
  return found;
}

function ownFields(value, fields) {
  const result = {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return result;
  fields.forEach(field => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      result[field] = descriptor.value;
    }
  });
  return result;
}

function diagnosticSnapshot(value) {
  const snapshot = ownFields(value, [
    'shipmentId', 'confirmedAt', 'branchCode', 'currency', 'paymentMode', 'amountPaid',
    'policyVersion', 'taxEligibility', 'bags', 'deliveryCharge',
  ]);
  if (snapshot.taxEligibility) {
    snapshot.taxEligibility = ownFields(snapshot.taxEligibility, [
      'governmentBorneVatEligible', 'reasonCode', 'evidenceReference', 'verifiedAt',
    ]);
  }
  if (Array.isArray(snapshot.bags)) {
    snapshot.bags = snapshot.bags.map(valueBag => {
      const bag = ownFields(valueBag, [
        'bagId', 'lineNumber', 'productCode', 'quantity', 'financialBreakup', 'prices',
      ]);
      bag.financialBreakup = ownFields(bag.financialBreakup, [
        'price_effective', 'promotion_effective_discount', 'coupon_effective_discount',
        'value_of_good', 'gst_tax_percentage', 'gst_fee', 'amount_paid', 'delivery_charge',
      ]);
      if (bag.prices) {
        bag.prices = ownFields(bag.prices, [
          'promotion_effective_discount', 'coupon_effective_discount',
        ]);
      }
      return bag;
    });
  }
  if (snapshot.deliveryCharge) {
    snapshot.deliveryCharge = ownFields(snapshot.deliveryCharge, [
      'taxCategory', 'taxRate', 'netAmount', 'taxAmount', 'paidAmount',
    ]);
  }
  return snapshot;
}

export function JourneyDetail({ detail, onDownload, feedback }) {
  const { job, normalizedSnapshot, steps } = detail;
  const deferred = deferredValues(steps.fyndTransition.requestTemplate);
  const safeSnapshot = diagnosticSnapshot(normalizedSnapshot);

  return (
    <article className="dry-run-detail" aria-label={`Dry-run journey ${job.documentNumber}`}>
      <header className="dry-run-detail-header">
        <div>
          <p className="dry-run-eyebrow">Evidence path / job {job.jobId}</p>
          <h2>{job.documentNumber}</h2>
          <p className="dry-run-detail-id">
            Shipment <span className="dry-run-job-value">{job.shipmentId}</span>
          </p>
        </div>
        <span className="dry-run-held-chip">SUBMISSION_HELD</span>
      </header>

      <div className="dry-run-lock-warning" role="note">
        <strong>The real shipment is locked.</strong>
        <span>No OEIS submission or Fynd invoice transition ran. Manual cleanup is required after this held run.</span>
      </div>

      <ol className="dry-run-rail" aria-label="Invoice safety journey">
        <li className="dry-run-node dry-run-node-complete">
          <span className="dry-run-node-marker">✓</span>
          <span><strong>Webhook</strong><small>bag_confirmed</small></span>
        </li>
        <li className="dry-run-node dry-run-node-complete">
          <span className="dry-run-node-marker">✓</span>
          <span><strong>Diagnostic payload</strong><small>Sanitized bytes stored</small></span>
        </li>
        <li className="dry-run-node dry-run-node-complete">
          <span className="dry-run-node-marker">✓</span>
          <span><strong>Fynd lock</strong><small>Real lock completed</small></span>
        </li>
        <li className="dry-run-node dry-run-node-held">
          <span className="dry-run-node-marker">!</span>
          <span><strong>OEIS held</strong><small>Circuit intentionally open</small></span>
        </li>
        <li className="dry-run-node dry-run-node-blocked">
          <span className="dry-run-node-marker">×</span>
          <span><strong>Fynd transition</strong><small>Blocked</small></span>
        </li>
      </ol>

      <div className="dry-run-panels">
        <JsonPanel title="Normalized shipment snapshot" value={safeSnapshot} />
        <JsonPanel title="Exact Fynd lock request" value={steps.fyndLock.request}>
          <p className="dry-run-panel-note">Live builder · result locked: {String(steps.fyndLock.result.locked)}</p>
        </JsonPanel>

        <section className="dry-run-panel dry-run-oeis-panel" aria-labelledby="dry-run-oeis-title">
          <div className="dry-run-panel-static-heading">
            <h3 id="dry-run-oeis-title">OEIS diagnostic request</h3>
            <span className="dry-run-held-chip">Held</span>
          </div>
          <dl className="dry-run-evidence-grid">
            <div><dt>Method</dt><dd>{steps.oeisSubmission.method}</dd></div>
            <div><dt>Request bytes</dt><dd>{steps.payloadPreparation.requestBytes}</dd></div>
            <div className="dry-run-evidence-wide"><dt>SHA-256</dt><dd>{steps.payloadPreparation.requestHash}</dd></div>
          </dl>
          <p className="dry-run-curl-warning">
            Sanitized diagnostic only; it cannot be submitted to OEIS unchanged.
          </p>
          <button className="dry-run-button" type="button" onClick={onDownload}>
            Download diagnostic JSON
          </button>
        </section>

        <JsonPanel title="Blocked Fynd transition" value={steps.fyndTransition.requestTemplate}>
          <p className="dry-run-panel-note">
            This template is evidence only. It is not executable because OEIS did not return the two values below.
          </p>
          <ul className="dry-run-deferred-list" aria-label="Deferred transition values">
            {deferred.map(item => <li className="dry-run-deferred" key={item}>{item}</li>)}
          </ul>
        </JsonPanel>
      </div>

      <p className="dry-run-live-feedback" role="status" aria-live="polite">
        {feedback.message}{feedback.count > 1 ? ` · ${feedback.count}` : ''}
      </p>
    </article>
  );
}
