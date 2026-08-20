import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { OmsHeader } from './OmsHeader';
import { OmsStateView } from './OmsStateView';
import { ShipmentFilters } from './ShipmentFilters';
import { ShipmentQueueTabs } from './ShipmentQueueTabs';
import { ShipmentTable } from './ShipmentTable';
import { ShipmentDetail } from './ShipmentDetail';
import { FailureQueue } from './FailureQueue';
import { filterLoadedRows, QUEUE_IDS, queueLabel } from './omsModel';
import { useOmsWorkspaceData } from './useOmsWorkspaceData';

export function OmsWorkspace() {
  const { company_id: companyId } = useParams();
  const [filters, setFilters] = useState({ search: '', stage: '', outcome: '' });
  const workspace = useOmsWorkspaceData({ companyId });
  const isShipments = workspace.activeQueue === QUEUE_IDS.SHIPMENTS;
  const isFailures = workspace.activeQueue === QUEUE_IDS.FAILURES;

  useEffect(() => {
    if (!isShipments || !workspace.queueView.loaded) return;
    const stages = new Set(workspace.queueView.rows.map(row => row.stage));
    const outcomes = new Set(workspace.queueView.rows.map(row => row.outcome));
    setFilters(current => {
      const stage = current.stage && !stages.has(current.stage) ? '' : current.stage;
      const outcome = current.outcome && !outcomes.has(current.outcome) ? '' : current.outcome;
      return stage === current.stage && outcome === current.outcome ? current : { ...current, stage, outcome };
    });
  }, [isShipments, workspace.queueView.loaded, workspace.queueView.rows]);

  const rows = filterLoadedRows(workspace.queueView.rows, filters);
  if (!companyId) return <StaticWorkspace />;
  if (workspace.terminal) return <main className="oms-workspace" aria-labelledby="oms-workspace-title">
    <OmsHeader onRefresh={workspace.refresh} refreshing={false} refreshDisabled showRefresh={false} />
    <OmsStateView kind="unauthorized" title="Session expired" message="Reauthenticate in Fynd to view shipment activity." />
  </main>;
  if (workspace.detailView.row) return <main className="oms-workspace" aria-labelledby="oms-workspace-title">
    <ShipmentDetail detail={workspace.detailView} actions={workspace.evidenceActions} backLabel={`Back to ${queueLabel(workspace.detailView.row.source)}`} onBack={workspace.closeDetail} onRefresh={workspace.refreshDetail} onLoadOlder={workspace.loadOlderActivity} />
  </main>;
  return (
    <main className="oms-workspace" aria-labelledby="oms-workspace-title">
      <OmsHeader onRefresh={workspace.refresh} refreshing={workspace.queueBusy} refreshDisabled={workspace.queueBusyMore} lastRefreshed={workspace.lastRefreshed} showRefresh />
      <ShipmentQueueTabs activeQueue={workspace.activeQueue} counts={workspace.queueCounts} onChange={workspace.setActiveQueue} />
      <section id="oms-queue-panel" role="tabpanel" aria-labelledby={`oms-tab-${workspace.activeQueue}`}>
        {isFailures ? <FailureQueue value={workspace.failureView} onLoadMore={workspace.loadMoreFailures} onSelect={workspace.selectRow} /> : <>
          {isShipments &&
          <ShipmentFilters filters={filters} onChange={setFilters} onReset={() => setFilters({ search: '', stage: '', outcome: '' })} showing={rows.length} loaded={workspace.queueView.rows.length} rows={workspace.queueView.rows} />}
          {workspace.queueView.loading && !workspace.queueView.loaded ? <OmsStateView kind="loading" title={isShipments ? 'Loading shipments' : 'Loading held shipments'} message="Loading the latest bounded shipment page." />
            : workspace.queueView.errorOperation === 'initial' && workspace.queueView.rows.length === 0 ? <OmsStateView kind="error" title={isShipments ? 'Could not load shipments' : 'Could not load held shipments'} message={`${isShipments ? 'Shipment activity' : 'Held shipment'} data could not be loaded. Use Refresh to try again.`} />
              : workspace.queueView.loaded && workspace.queueView.rows.length === 0 ? <OmsStateView kind="empty" title={isShipments ? 'No shipments loaded' : 'No held shipments loaded'} message={isShipments ? 'No recent shipment activity is available.' : 'No held dry-run journeys are available.'} />
                : <ShipmentTable rows={isShipments ? rows : workspace.queueView.rows} onSelect={workspace.selectRow} />}
          {workspace.queueView.error && workspace.queueView.rows.length > 0 && <OmsStateView kind="warning" title={workspace.queueView.errorOperation === 'more' ? (isShipments ? 'Could not load more shipments' : 'Could not load more held shipments') : (isShipments ? 'Shipment refresh failed' : 'Held refresh failed')} message={workspace.queueView.errorOperation === 'more' ? 'The loaded shipments remain visible. You can try Load more again.' : `${isShipments ? 'Could not refresh shipments' : 'Could not refresh held shipments'}; last loaded data is still being shown.`} />}
          {workspace.feedback.message && !workspace.queueView.error && <p className="oms-feedback" role="status" aria-live="polite" aria-atomic="true">{workspace.feedback.message}</p>}
          {workspace.queueView.cursor !== null && <button className="oms-load-more" type="button" disabled={workspace.queueView.loadingMore || workspace.queueView.loading} onClick={workspace.loadMore}>{workspace.queueView.loadingMore ? 'Loading more…' : 'Load more'}</button>}
        </>}
      </section>
    </main>
  );
}

function StaticWorkspace() {
  return (
    <main className="oms-workspace" aria-labelledby="oms-workspace-title">
      <header className="oms-page-header"><div><p className="oms-page-header__eyebrow">Invoice operations</p><h1 id="oms-workspace-title">E-Invoicing Shipments</h1><p className="oms-page-header__supporting">Shipment operations, arranged like Fynd OMS.</p></div><span className="oms-page-header__phase">New experience preview</span></header>

      <section className="oms-empty-shell" aria-labelledby="oms-empty-shell-title">
        <div className="oms-empty-shell__route" aria-hidden="true">
          <span className="oms-empty-shell__node" />
          <span className="oms-empty-shell__line" />
          <span className="oms-empty-shell__node is-active" />
          <span className="oms-empty-shell__line" />
          <span className="oms-empty-shell__node" />
        </div>
        <p className="oms-empty-shell__eyebrow">Phase 1</p>
        <h2 id="oms-empty-shell-title">Shipment workspace</h2>
        <p>The paginated shipment list will be introduced after this shell is reviewed.</p>
      </section>
    </main>
  );
}
