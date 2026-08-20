import React from 'react';

import { formatUtc } from './omsModel';
import { ShipmentStatusChip } from './ShipmentStatusChip';

function display(value, fallback = 'Unavailable') { return value === null || value === undefined || value === '' ? fallback : String(value); }

export function ShipmentSummary({ row, timeline }) {
  const latest = timeline[timeline.length - 1];
  return <section className="oms-detail-summary" aria-labelledby="oms-overview-title">
    <div><p className="oms-detail-eyebrow">Shipment evidence</p><h2 id="oms-overview-title">Overview</h2></div>
    <ShipmentStatusChip outcome={latest?.outcome || row.outcome} />
    <dl className="oms-detail-definitions">
      <div><dt>Shipment ID</dt><dd className="oms-identifier">{display(row.shipmentId)}</dd></div>
      <div><dt>Document number</dt><dd className="oms-document">{display(row.documentNumber)}</dd></div>
      <div><dt>Job ID</dt><dd className="oms-identifier">{display(row.jobId)}</dd></div>
      <div><dt>Latest update</dt><dd>{formatUtc(latest?.occurredAt || row.updatedAt)}</dd></div>
      <div><dt>Safe code</dt><dd className="oms-safe-code">{display(latest?.safeCode || row.safeCode)}</dd></div>
    </dl>
  </section>;
}
