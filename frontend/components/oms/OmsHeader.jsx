import React from 'react';
import { formatUtc } from './omsModel';

export function OmsHeader({ onRefresh, refreshing, refreshDisabled, lastRefreshed, showRefresh = true }) {
  return <header className="oms-page-header">
    <div>
      <p className="oms-page-header__eyebrow">Invoice operations</p>
      <h1 id="oms-workspace-title">E-Invoicing Shipments</h1>
      <p className="oms-page-header__supporting">Shipment operations, arranged like Fynd OMS.</p>
    </div>
    <div className="oms-header-actions">
      {lastRefreshed && <p className="oms-last-refreshed" role="status" aria-live="polite" aria-atomic="true">Last refreshed {formatUtc(lastRefreshed)}</p>}
      {showRefresh && <button className="oms-refresh" type="button" disabled={refreshDisabled || refreshing} onClick={onRefresh}>
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>}
    </div>
  </header>;
}
