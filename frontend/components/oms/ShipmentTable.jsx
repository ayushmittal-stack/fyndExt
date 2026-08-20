import React from 'react';
import { actionLabel, formatUtc, outcomeLabel, stageLabel } from './omsModel';
import { ShipmentStatusChip } from './ShipmentStatusChip';

function value(value, fallback) { return value || fallback; }
export function ShipmentTable({ rows, onSelect }) {
  if (!rows.length) return <p className="oms-empty-table">No loaded shipments match these filters.</p>;
  return <div className="oms-shipment-table" aria-label="Loaded shipments">{rows.map(row => <button
    className="oms-shipment-row" key={row.key} type="button"
    aria-label={`Shipment ${row.shipmentId}, ${outcomeLabel(row.outcome)}`} onClick={() => onSelect?.(row)}
  >
    <span className="oms-identifier" title={row.shipmentId}>{row.shipmentId}</span>
    <span className="oms-document" title={row.documentNumber || undefined}>{value(row.documentNumber, 'Document unavailable')}</span>
    <span>{stageLabel(row.stage)} · {actionLabel(row.action)}</span>
    <ShipmentStatusChip outcome={row.outcome} />
    <span className="oms-safe-code" title={row.safeCode || undefined}>{value(row.safeCode, 'Safe code unavailable')}</span>
    <time dateTime={row.updatedAt}>{formatUtc(row.updatedAt)}</time>
  </button>)}</div>;
}
