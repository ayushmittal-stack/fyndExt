import React, { useRef, useState } from 'react';

import { OmsStateView } from './OmsStateView';
import { ShipmentActivityDrawer } from './ShipmentActivityDrawer';
import { ShipmentEvidence } from './ShipmentEvidence';
import { ShipmentJourney } from './ShipmentJourney';
import { ShipmentSummary } from './ShipmentSummary';
import { formatUtc } from './omsModel';

export function ShipmentDetail({ detail, actions, backLabel = 'Back to Shipments', onBack, onRefresh, onLoadOlder }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const triggerRef = useRef(null);
  if (!detail.row) return null;
  const timelineUnavailable = detail.timelineError?.kind === 'not-found';
  const timelineInitialFailure = detail.timelineError?.kind === 'request-failed' && !detail.timelineVerified;
  const journeyUnavailable = detail.journeyError?.kind === 'not-found';
  const journeyInitialFailure = detail.journeyError?.kind === 'request-failed' && !detail.journeyVerified;
  return <>
    <section className="oms-detail" data-testid="oms-detail-background">
      <header className="oms-detail-header"><button className="oms-detail-back" type="button" onClick={onBack}>{backLabel}</button><div><p className="oms-detail-eyebrow">Shipment</p><h1 id="oms-workspace-title" className="oms-detail-title">{detail.row.shipmentId}</h1></div><div>{detail.lastRefreshed && <p className="oms-last-refreshed" role="status" aria-live="polite" aria-atomic="true">Last refreshed {formatUtc(detail.lastRefreshed)}</p>}<button className="oms-refresh" type="button" disabled={detail.loading || detail.refreshing || detail.loadingOlder} onClick={onRefresh}>{detail.refreshing ? 'Refreshing…' : 'Refresh detail'}</button></div></header>
      {detail.loading && !detail.timeline.length && <OmsStateView kind="loading" title="Loading shipment evidence" message="Loading the bounded activity timeline." />}
      {timelineUnavailable && <OmsStateView kind="unavailable" title="Shipment evidence unavailable" message="This shipment's activity timeline is no longer available." />}
      {timelineInitialFailure && <OmsStateView kind="error" title="Could not load shipment evidence" message="Shipment activity could not be loaded. Use Refresh detail to try again." />}
      {detail.timelineVerified && <>
        <ShipmentSummary row={detail.row} timeline={detail.timeline} />
        <ShipmentJourney timeline={detail.timeline} />
      </>}
      {journeyUnavailable && <OmsStateView kind="unavailable" title="Journey evidence unavailable" message="The related dry-run journey is no longer available." />}
      {journeyInitialFailure && <OmsStateView kind="error" title="Could not load journey evidence" message="The related dry-run journey could not be loaded. Use Refresh detail to try again." />}
      {detail.timelineError?.operation === 'refresh' && detail.timelineVerified && <OmsStateView kind="warning" title="Shipment evidence refresh failed" message="Verified evidence remains available where loaded." />}
      {detail.journeyError?.operation === 'refresh' && detail.journeyVerified && <OmsStateView kind="warning" title="Journey evidence refresh failed" message="Timeline evidence remains available." />}
      {detail.warning && <p className="oms-feedback" role="status">{detail.warning}</p>}
      {(detail.timelineVerified || detail.journey) && <ShipmentEvidence timeline={detail.timelineVerified ? detail.timeline : []} journey={detail.journey} actions={actions} />}
      {detail.timelineVerified && <button ref={triggerRef} className="oms-activity-trigger" type="button" disabled={detail.loading || detail.refreshing} onClick={() => setDrawerOpen(true)}>View activity</button>}
    </section>
    {drawerOpen && <ShipmentActivityDrawer timeline={detail.timeline} cursor={detail.cursor} loadingOlder={detail.loadingOlder || detail.loading || detail.refreshing} warning={detail.olderWarning} onLoadOlder={onLoadOlder} onClose={() => setDrawerOpen(false)} triggerRef={triggerRef} />}
  </>;
}
