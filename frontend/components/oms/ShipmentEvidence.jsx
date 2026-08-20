import React from 'react';

import { formatDuration, formatUtc, projectDiagnosticSnapshot } from './omsModel';

function value(item) { return item === null || item === undefined || item === '' ? 'Unavailable' : String(item); }
function Definition({ label, children }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
function Fields({ fields }) { return <dl className="oms-evidence-definitions">{fields.map(([label, item]) => <Definition key={label} label={label}>{value(item)}</Definition>)}</dl>; }

function TaxSummaries({ summaries }) {
  return <div className="oms-evidence-tax"><h4>Tax summaries</h4>{(Array.isArray(summaries) ? summaries : []).map((tax, index) => <Fields key={`${tax.category || 'tax'}-${index}`} fields={[['Category', tax.category], ['Rate', tax.rate], ['Reason code', tax.reasonCode], ['Line count', tax.lineCount]]} />)}</div>;
}

function SafeSummary({ summary }) {
  if (!summary) return null;
  if (summary.kind === 'FYND_REQUEST') return <Fields fields={[['Operation', summary.operation], ['Shipment ID', summary.shipmentId], ['Document number', summary.documentNumber], ['Requested lock', summary.requestedLock], ['Requested status', summary.requestedStatus]]} />;
  if (summary.kind === 'FYND_RESPONSE') return <Fields fields={[['Operation', summary.operation], ['Shipment ID', summary.shipmentId], ['Document number', summary.documentNumber], ['Response status', summary.responseStatus], ['Locked', summary.locked], ['Shipment state', summary.shipmentState], ['Final classification', summary.finalStateClassification], ['Retryable', summary.retryable], ['Latency', summary.latencyMs === null ? null : `${summary.latencyMs} ms`]]} />;
  if (summary.kind === 'OEIS_REQUEST') return <><Fields fields={[['Document number', summary.documentNumber], ['Document type', summary.documentType], ['Line count', summary.lineCount], ['Currency', summary.currency], ['Net amount', summary.netAmount], ['Tax amount', summary.taxAmount], ['Total amount', summary.totalAmount], ['Request bytes', summary.requestByteCount], ['Request SHA-256', summary.requestSha256], ['Endpoint path', summary.endpointPath], ['Attempt number', summary.attemptNumber], ['Timeout', summary.timeoutMs === null ? null : `${summary.timeoutMs} ms`]]} /><TaxSummaries summaries={summary.taxSummaries} /></>;
  if (summary.kind === 'OEIS_RESPONSE') return <Fields fields={[['HTTP status', summary.httpStatus], ['System exception', summary.isSystemException], ['Validation result', summary.validationResult], ['Reporting status', summary.reportingStatus], ['Clearance status', summary.clearanceStatus], ['Invoice number', summary.invoiceNumber], ['Transaction number', summary.transactionNumber], ['UUID', summary.uuid], ['Invoice counter', summary.invoiceCounter], ['Matching key', summary.matchingKey], ['Validation codes', Array.isArray(summary.validationCodes) ? summary.validationCodes.join(', ') : null], ['Response bytes', summary.responseByteCount], ['Response SHA-256', summary.responseSha256], ['Retryable', summary.retryable], ['Latency', summary.latencyMs === null ? null : `${summary.latencyMs} ms`]]} />;
  if (summary.kind === 'OEIS_ARTIFACT') return <Fields fields={[['Signed XML retained', summary.signedXmlPresent], ['Signed XML bytes', summary.signedXmlByteCount], ['Signed XML SHA-256', summary.signedXmlSha256], ['QR retained', summary.qrPresent], ['QR bytes', summary.qrByteCount], ['QR SHA-256', summary.qrSha256]]} />;
  return null;
}

function TimelineEvidence({ event }) {
  return <article className="oms-evidence-event"><h3>{event.action.replaceAll('_', ' ')}</h3><Fields fields={[
    ['Attempt', event.attemptNumber > 0 ? `Attempt ${event.attemptNumber}` : 'No external attempt'], ['Occurred', formatUtc(event.occurredAt)], ['Started', formatUtc(event.startedAt)], ['Completed', event.completedAt === null ? null : formatUtc(event.completedAt)], ['Duration', event.durationMs === null ? null : formatDuration(event.durationMs)], ['Queue delay', event.queueDelayMs === null ? null : formatDuration(event.queueDelayMs)], ['Retry delay', event.retryDelayMs === null ? null : formatDuration(event.retryDelayMs)], ['Next attempt', event.nextAttemptAt === null ? null : formatUtc(event.nextAttemptAt)], ['Safe code', event.safeCode], ['Job ID', event.jobId], ['Document number', event.documentNumber], ['Artifact record ID', event.artifactJobId],
  ]} />{event.requestSummary && <details><summary>Request evidence</summary><SafeSummary summary={event.requestSummary} /></details>}{event.responseSummary && <details><summary>Response evidence</summary><SafeSummary summary={event.responseSummary} /></details>}</article>;
}

function JourneyEvidence({ journey }) {
  const steps = journey?.steps;
  if (!steps) return null;
  const request = steps.fyndLock?.request?.body;
  const transition = steps.fyndTransition;
  const template = transition?.requestTemplate?.body;
  const status = Array.isArray(template?.statuses) ? template.statuses[0] : null;
  const shipment = Array.isArray(status?.shipments) ? status.shipments[0] : null;
  return <><details><summary>Payload preparation</summary><Fields fields={[['Status', steps.payloadPreparation?.status], ['Request SHA-256', steps.payloadPreparation?.requestHash], ['Request bytes', steps.payloadPreparation?.requestBytes], ['Within limit', steps.payloadPreparation?.withinLimit]]} /></details><details><summary>Exact Fynd lock request</summary><Fields fields={[['Status', steps.fyndLock?.status], ['Operation', steps.fyndLock?.operation], ['Entity type', request?.entity_type], ['Action', request?.action], ['Action type', request?.action_type], ['Shipment ID', Array.isArray(request?.entities) ? request.entities[0]?.id : null], ['Reason', Array.isArray(request?.entities) ? request.entities[0]?.reason_text : null], ['Locked', steps.fyndLock?.result?.locked]]} /></details><details><summary>OEIS diagnostic metadata</summary><Fields fields={[['Status', steps.oeisSubmission?.status], ['Method', steps.oeisSubmission?.method], ['Diagnostic filename', steps.oeisSubmission?.bodyFileName], ['Sanitized', steps.oeisSubmission?.sanitized], ['Warning', steps.oeisSubmission?.warning]]} /></details><details><summary>Fynd transition evidence</summary><Fields fields={[['Status', transition?.status], ['Operation', transition?.operation], ['Executable', transition?.executable], ['Task', template?.task], ['Force transition', template?.force_transition], ['Unlock before transition', template?.unlock_before_transition], ['Lock after transition', template?.lock_after_transition], ['Transition status', status?.status], ['Shipment identifier', shipment?.identifier]]} /></details></>;
}

function EvidenceActions({ journey, actions }) {
  const canDownload = actions?.canDownload && typeof actions?.downloadDiagnostic === 'function';
  const canCopy = actions?.canCopy && typeof actions?.copyPodCurl === 'function';
  if (!canDownload && !canCopy) return null;
  const warningId = `oms-pod-curl-warning-${journey?.job?.jobId}`;
  return <section className="oms-evidence-actions" aria-label="Diagnostic actions">
    {canCopy && <p className="oms-pod-curl-warning" id={warningId} role="note" aria-label="Real submission warning"><strong>Real submission warning.</strong>{' '}Pasting the copied command in the app pod performs a real OEIS submission. Run the copied command only once. Repeating it may create a duplicate invoice. The extension will not automatically record or reconcile that manual response.</p>}
    <div>
      {canDownload && <button className="oms-evidence-action" type="button" disabled={actions.downloading || actions.copyingPodCurl || actions.detailBusy} aria-busy={actions.downloading ? 'true' : 'false'} onClick={actions.downloadDiagnostic}>{actions.downloading ? 'Downloading…' : 'Download diagnostic JSON'}</button>}
      {canCopy && <button className="oms-evidence-action" type="button" disabled={actions.copyingPodCurl || actions.downloading || actions.detailBusy} aria-busy={actions.copyingPodCurl ? 'true' : 'false'} aria-describedby={warningId} onClick={actions.copyPodCurl}>Copy pod cURL</button>}
    </div>
    <p className="oms-action-feedback" role="status" aria-live="polite" aria-atomic="true">{actions?.feedback?.message || ''}{actions?.feedback?.count > 1 ? ` · ${actions.feedback.count}` : ''}</p>
  </section>;
}

export function ShipmentEvidence({ timeline, journey, actions }) {
  const normalized = projectDiagnosticSnapshot(journey?.normalizedSnapshot);
  return <section className="oms-evidence" aria-labelledby="oms-evidence-title"><h2 id="oms-evidence-title">Evidence</h2><EvidenceActions journey={journey} actions={actions} />{timeline.map(event => <TimelineEvidence key={event.key || `${event.occurredAt}:${event.action}`} event={event} />)}<JourneyEvidence journey={journey} />{journey?.normalizedSnapshot && <details className="oms-evidence-json"><summary>Normalized shipment snapshot</summary><pre>{JSON.stringify(normalized, null, 2)}</pre></details>}</section>;
}
