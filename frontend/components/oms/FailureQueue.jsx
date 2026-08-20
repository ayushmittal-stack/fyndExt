import React from 'react';

import { formatUtc } from './omsModel';
import { OmsStateView } from './OmsStateView';

function groupState(group, names) {
  if (group.loading && !group.loaded) {
    return <OmsStateView kind="loading" title={`Loading ${names.loading}`} message={`Loading one bounded page of ${names.loading}.`} />;
  }
  if (group.errorOperation === 'initial' && !group.rows.length) {
    return <OmsStateView kind="error" title={`Could not load ${names.loading}`} message={`${names.singular} data could not be loaded. Use Refresh to try again.`} />;
  }
  if (group.loaded && !group.rows.length) {
    return <p className="oms-failure-empty">No {names.loading} loaded.</p>;
  }
  return null;
}

function GroupWarning({ group, title, moreTitle }) {
  if (!group.error || !group.rows.length) return null;
  return <OmsStateView
    kind="warning"
    title={group.errorOperation === 'more' ? moreTitle : title}
    message="Verified rows remain visible and the same cursor remains available."
  />;
}

function JobFailure({ row, onSelect }) {
  return <li><button className="oms-failure-row" type="button" onClick={() => onSelect?.(row)}>
    <div><strong className="oms-document">{row.documentNumber || 'Document unavailable'}</strong><span className="oms-identifier">Shipment {row.shipmentId}</span></div>
    <div><span className="oms-failure-state">{row.state}</span><strong className="oms-safe-code">{row.safeCode}</strong><p>{row.failureMessage}</p></div>
    <dl><div><dt>Attempts</dt><dd>Attempt {row.attemptCount}</dd></div><div><dt>Failed</dt><dd><time dateTime={row.updatedAt}>{formatUtc(row.updatedAt)}</time></dd></div></dl>
  </button></li>;
}

function PreJobFailure({ row, onSelect }) {
  return <li><button className="oms-failure-row oms-failure-row--prejob" type="button" onClick={() => onSelect?.(row)}>
    <div><strong className="oms-identifier">Shipment {row.shipmentId}</strong><span>Rejected before job</span></div>
    <div><strong className="oms-safe-code">{row.safeCode}</strong><p>Shipment processing was rejected before a job was created.</p></div>
    <dl><div><dt>Rejected</dt><dd><time dateTime={row.updatedAt}>{formatUtc(row.updatedAt)}</time></dd></div></dl>
  </button></li>;
}

export function FailureQueue({ value, onLoadMore, onSelect }) {
  const jobRows = [...value.job.rows].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const jobShipmentIds = new Set(jobRows.map(row => row.shipmentId));
  const preJobRows = value.preJob.rows
    .filter(row => !jobShipmentIds.has(row.shipmentId))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  return <section className="oms-failure-queue" aria-label="Failure queues">
    <section className="oms-failure-group" aria-labelledby="oms-job-failures-title">
      <header><h2 id="oms-job-failures-title">Job failures</h2><span>{jobRows.length} loaded job {jobRows.length === 1 ? 'failure' : 'failures'}</span></header>
      {groupState(value.job, { loading: 'job failures', singular: 'Job failure' })}
      {!!jobRows.length && <ul>{jobRows.map(row => <JobFailure key={row.key} row={row} onSelect={onSelect} />)}</ul>}
      <GroupWarning group={value.job} title="Job failure refresh failed" moreTitle="Could not load more job failures" />
      {value.job.cursor !== null && <button className="oms-load-more" type="button" disabled={value.job.loading || value.job.loadingMore} onClick={() => onLoadMore('job')}>{value.job.loadingMore ? 'Loading more job failures…' : 'Load more job failures'}</button>}
    </section>
    <section className="oms-failure-group" aria-labelledby="oms-prejob-failures-title">
      <header><h2 id="oms-prejob-failures-title">Rejected before a job was created</h2><span>{preJobRows.length} loaded pre-job {preJobRows.length === 1 ? 'rejection' : 'rejections'}</span></header>
      {groupState(value.preJob, { loading: 'pre-job rejections', singular: 'Pre-job rejection' })}
      {!!preJobRows.length && <ul>{preJobRows.map(row => <PreJobFailure key={row.key} row={row} onSelect={onSelect} />)}</ul>}
      <GroupWarning group={value.preJob} title="Pre-job rejection refresh failed" moreTitle="Could not load more pre-job rejections" />
      {value.preJob.cursor !== null && <button className="oms-load-more" type="button" disabled={value.preJob.loading || value.preJob.loadingMore} onClick={() => onLoadMore('preJob')}>{value.preJob.loadingMore ? 'Loading more pre-job rejections…' : 'Load more pre-job rejections'}</button>}
    </section>
  </section>;
}
