import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import {
  getShipmentTimeline,
  listShipmentActivity,
} from '../../services/shipmentActivityApi';
import './shipment-activity.css';

const REFRESH_DELAY_MS = 5000;
const RECENT_LIMIT = 20;
const TIMELINE_LIMIT = 50;
const OLDER_TIMELINE_NOT_FOUND = Symbol('older-timeline-not-found');

const STAGE_LABELS = Object.freeze({
  WEBHOOK: 'Webhook receipt',
  JOB: 'Shipment job',
  VALIDATION: 'Local validation',
  PAYLOAD: 'Invoice payload',
  FYND_LOCK: 'Fynd invoice lock',
  OEIS_SUBMISSION: 'OEIS submission',
  OEIS_ARTIFACT: 'OEIS artifact',
  OUTBOX: 'Outbox delivery',
  FYND_TRANSITION: 'Fynd shipment transition',
  RETRY: 'Retry scheduling',
  LEASE: 'Lease recovery',
  MIGRATION: 'Legacy migration',
});

const ACTION_LABELS = Object.freeze({
  WEBHOOK_RECEIVED: 'Webhook received',
  WEBHOOK_ACCEPTED: 'Webhook accepted',
  WEBHOOK_DUPLICATE: 'Duplicate webhook recognized',
  WEBHOOK_IGNORED: 'Webhook ignored',
  WEBHOOK_REJECTED: 'Webhook rejected',
  JOB_CLAIMED: 'Job claimed',
  VALIDATION_STARTED: 'Local validation started',
  VALIDATION_PASSED: 'Local validation passed',
  VALIDATION_FAILED: 'Local validation failed',
  PAYLOAD_PREPARED: 'Invoice payload prepared',
  FYND_LOCK_REQUESTED: 'Fynd invoice lock requested',
  FYND_LOCK_CONFIRMED: 'Fynd invoice lock confirmed',
  FYND_LOCK_FAILED: 'Fynd invoice lock failed',
  FYND_LOCK_READBACK: 'Fynd invoice lock readback',
  OEIS_SUBMISSION_HELD: 'OEIS submission held',
  OEIS_SUBMISSION_REQUESTED: 'OEIS submission requested',
  OEIS_RESPONSE_RECEIVED: 'OEIS response received',
  OEIS_SUBMISSION_FAILED: 'OEIS submission failed',
  OEIS_ARTIFACT_STORED: 'OEIS artifact stored',
  OUTBOX_CLAIMED: 'Outbox claimed',
  FYND_TRANSITION_REQUESTED: 'Fynd shipment transition requested',
  FYND_TRANSITION_CONFIRMED: 'Fynd shipment transition confirmed',
  FYND_TRANSITION_FAILED: 'Fynd shipment transition failed',
  FYND_TRANSITION_READBACK: 'Fynd shipment transition readback',
  RETRY_SCHEDULED: 'Retry scheduled',
  LEASE_RECOVERED: 'Lease recovered',
  JOB_DATA_FAILED: 'Job data failed',
  JOB_INDETERMINATE: 'Job indeterminate',
  JOB_COMPLETED: 'Job completed',
  LEGACY_STATE_IMPORTED: 'Legacy state imported',
});

const OUTCOME_LABELS = Object.freeze({
  STARTED: 'Started',
  SUCCESS: 'Success',
  FAILURE: 'Failure',
  TIMEOUT: 'Timeout',
  RETRY_SCHEDULED: 'Retry scheduled',
  HELD: 'Held',
  INDETERMINATE: 'Indeterminate',
});

const UTC_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function formatUtc(value) {
  return `${UTC_FORMATTER.format(new Date(value))} UTC`;
}

function trimDecimal(value) {
  return value.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60000) return `${trimDecimal(milliseconds / 1000)} s`;
  const minutes = Math.floor(milliseconds / 60000);
  const seconds = (milliseconds % 60000) / 1000;
  return `${minutes} min ${trimDecimal(seconds)} s`;
}

function errorKind(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return 'request-failed';
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, 'kind');
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return 'request-failed';
  }
  return ['unauthorized', 'not-found', 'request-failed'].includes(descriptor.value)
    ? descriptor.value
    : 'request-failed';
}

function valueText(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function Definition({ label, value, mono = false }) {
  return (
    <div className="shipment-activity-definition">
      <dt>{label}</dt>
      <dd className={mono ? 'shipment-activity-mono' : undefined}>{valueText(value)}</dd>
    </div>
  );
}

function ActivityLoadingState({ children }) {
  return (
    <div
      className="shipment-activity-loading"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <img
        className="shipment-activity-loading-image"
        src="/assets/language-switch-loader.webp"
        alt=""
        aria-hidden="true"
      />
      <span>{children}</span>
    </div>
  );
}

function TaxSummaries({ summaries }) {
  return (
    <div className="shipment-activity-definition shipment-activity-definition-wide">
      <dt>Tax summaries</dt>
      <dd>
        <ul className="shipment-activity-nested-list">
          {summaries.map((tax, index) => (
            <li key={index}>
              <span>{valueText(tax.category)}</span>
              <span>{valueText(tax.rate)}</span>
              <span>{valueText(tax.reasonCode)}</span>
              <span>{valueText(tax.lineCount)} lines</span>
            </li>
          ))}
        </ul>
      </dd>
    </div>
  );
}

function ValidationCodes({ codes }) {
  return (
    <div className="shipment-activity-definition shipment-activity-definition-wide">
      <dt>Validation codes</dt>
      <dd>
        {codes.length === 0 ? '—' : (
          <ul className="shipment-activity-code-list">
            {codes.map(code => <li key={code} className="shipment-activity-mono">{code}</li>)}
          </ul>
        )}
      </dd>
    </div>
  );
}

function SafeSummary({ summary }) {
  if (!summary) return null;

  if (summary.kind === 'FYND_REQUEST') {
    return (
      <div className="shipment-activity-summary">
        <h5>Fynd request</h5>
        <dl>
          <Definition label="Operation" value={summary.operation} />
          <Definition label="Shipment ID" value={summary.shipmentId} mono />
          <Definition label="Document number" value={summary.documentNumber} mono />
          <Definition label="Requested lock" value={summary.requestedLock} />
          <Definition label="Requested status" value={summary.requestedStatus} mono />
        </dl>
      </div>
    );
  }

  if (summary.kind === 'FYND_RESPONSE') {
    return (
      <div className="shipment-activity-summary">
        <h5>Fynd response</h5>
        <dl>
          <Definition label="Operation" value={summary.operation} />
          <Definition label="Shipment ID" value={summary.shipmentId} mono />
          <Definition label="Document number" value={summary.documentNumber} mono />
          <Definition label="Response status" value={summary.responseStatus} />
          <Definition label="Locked" value={summary.locked} />
          <Definition label="Shipment state" value={summary.shipmentState} mono />
          <Definition label="Final classification" value={summary.finalStateClassification} />
          <Definition label="Retryable" value={summary.retryable} />
          <Definition label="Latency" value={`${summary.latencyMs} ms`} />
        </dl>
      </div>
    );
  }

  if (summary.kind === 'OEIS_REQUEST') {
    return (
      <div className="shipment-activity-summary">
        <h5>OEIS request</h5>
        <dl>
          <Definition label="Document number" value={summary.documentNumber} mono />
          <Definition label="Document type" value={summary.documentType} />
          <Definition label="Line count" value={summary.lineCount} />
          <Definition label="Currency" value={summary.currency} />
          <Definition label="Net amount" value={summary.netAmount} mono />
          <Definition label="Tax amount" value={summary.taxAmount} mono />
          <Definition label="Total amount" value={summary.totalAmount} mono />
          <TaxSummaries summaries={summary.taxSummaries} />
          <Definition label="Request bytes" value={summary.requestByteCount} />
          <Definition label="Request SHA-256" value={summary.requestSha256} mono />
          <Definition label="Attempt number" value={summary.attemptNumber} />
          <Definition label="Timeout" value={`${summary.timeoutMs} ms`} />
        </dl>
      </div>
    );
  }

  if (summary.kind === 'OEIS_RESPONSE') {
    return (
      <div className="shipment-activity-summary">
        <h5>OEIS response</h5>
        <dl>
          <Definition label="HTTP status" value={summary.httpStatus} />
          <Definition label="System exception" value={summary.isSystemException} />
          <Definition label="Validation result" value={summary.validationResult} />
          <Definition label="Reporting status" value={summary.reportingStatus} />
          <Definition label="Clearance status" value={summary.clearanceStatus} />
          <Definition label="Invoice number" value={summary.invoiceNumber} mono />
          <Definition label="Transaction number" value={summary.transactionNumber} mono />
          <Definition label="UUID" value={summary.uuid} mono />
          <Definition label="Invoice counter" value={summary.invoiceCounter} mono />
          <Definition label="Matching key" value={summary.matchingKey} mono />
          <ValidationCodes codes={summary.validationCodes} />
          <Definition label="Response bytes" value={summary.responseByteCount} />
          <Definition label="Response SHA-256" value={summary.responseSha256} mono />
          <Definition label="Retryable" value={summary.retryable} />
          <Definition label="Latency" value={`${summary.latencyMs} ms`} />
        </dl>
      </div>
    );
  }

  if (summary.kind === 'OEIS_ARTIFACT') {
    return (
      <div className="shipment-activity-summary">
        <h5>OEIS artifact</h5>
        <dl>
          <Definition label="Signed XML retained" value={summary.signedXmlPresent} />
          <Definition label="Signed XML bytes" value={summary.signedXmlByteCount} />
          <Definition label="Signed XML SHA-256" value={summary.signedXmlSha256} mono />
          <Definition label="QR retained" value={summary.qrPresent} />
          <Definition label="QR bytes" value={summary.qrByteCount} />
          <Definition label="QR SHA-256" value={summary.qrSha256} mono />
        </dl>
      </div>
    );
  }

  return <p className="shipment-activity-summary-unavailable">Safe summary unavailable</p>;
}

function EventRow({ item }) {
  const hasSecondaryTime = item.startedAt !== item.occurredAt || item.completedAt !== null;
  return (
    <li className={`shipment-activity-event shipment-activity-event-${item.outcome.toLowerCase()}`}>
      <div className="shipment-activity-time-tab">
        <time dateTime={item.occurredAt}>{formatUtc(item.occurredAt)}</time>
      </div>
      <span className="shipment-activity-notch" aria-hidden="true" />
      <article className="shipment-activity-event-body">
        <div className="shipment-activity-event-heading">
          <div>
            <span className="shipment-activity-stage">{STAGE_LABELS[item.stage]}</span>
            <h4>{ACTION_LABELS[item.action]}</h4>
          </div>
          <span className={`shipment-activity-outcome shipment-activity-outcome-${item.outcome.toLowerCase()}`}>
            {OUTCOME_LABELS[item.outcome]}
          </span>
        </div>
        <dl className="shipment-activity-event-meta">
          <Definition label="Attempt" value={item.attemptNumber > 0 ? `Attempt ${item.attemptNumber}` : 'No external attempt'} />
          <Definition label="Duration" value={item.durationMs === null ? null : formatDuration(item.durationMs)} />
          {item.queueDelayMs !== null && <Definition label="Queue delay" value={formatDuration(item.queueDelayMs)} />}
          {item.retryDelayMs !== null && <Definition label="Retry delay" value={formatDuration(item.retryDelayMs)} />}
          {item.nextAttemptAt !== null && (
            <div className="shipment-activity-definition">
              <dt>Next attempt</dt>
              <dd><time dateTime={item.nextAttemptAt}>{formatUtc(item.nextAttemptAt)}</time></dd>
            </div>
          )}
          <Definition label="Safe code" value={item.safeCode} mono />
          <Definition label="Job ID" value={item.jobId} mono />
          <Definition label="Document number" value={item.documentNumber} mono />
          <Definition label="Artifact record ID" value={item.artifactJobId} mono />
          {hasSecondaryTime && (
            <div className="shipment-activity-definition shipment-activity-definition-wide">
              <dt>Evidence window</dt>
              <dd className="shipment-activity-time-range">
                <span>Started <time dateTime={item.startedAt}>{formatUtc(item.startedAt)}</time></span>
                {item.completedAt !== null && (
                  <span>Completed <time dateTime={item.completedAt}>{formatUtc(item.completedAt)}</time></span>
                )}
              </dd>
            </div>
          )}
        </dl>
        <SafeSummary summary={item.requestSummary} />
        <SafeSummary summary={item.responseSummary} />
      </article>
    </li>
  );
}

function emptyViewState(route) {
  return {
    displayRoute: route,
    heads: [],
    selectedShipmentId: null,
    timeline: [],
    headCursor: null,
    timelineCursor: null,
    initialLoading: document.visibilityState !== 'hidden',
    timelineLoading: false,
    refreshing: false,
    manualBusy: false,
    loadingOlderHeads: false,
    loadingOlderTimeline: false,
    terminal: false,
    missingTimeline: false,
    warning: null,
    liveMessage: '',
  };
}

export const ShipmentActivityLog = forwardRef(function ShipmentActivityLog(
  {
    companyId,
    routeKey = String(companyId),
    routeTerminal = false,
    onSessionUnauthorized,
  },
  refreshRef,
) {
  const normalizedRouteKey = String(routeKey);
  const [view, setView] = useState(() => emptyViewState(normalizedRouteKey));
  const sessionRef = useRef(null);

  function write(session, update) {
    if (sessionRef.current !== session || !session.active || session.terminal) return;
    setView(previous => {
      if (previous.displayRoute !== session.routeKey) return previous;
      return typeof update === 'function' ? update(previous) : { ...previous, ...update };
    });
  }

  function clearTimer(session) {
    if (session.timer !== null) {
      clearTimeout(session.timer);
      session.timer = null;
    }
  }

  function terminate(session, { notifyParent = true } = {}) {
    if (sessionRef.current !== session || !session.active || session.terminal) return;
    session.terminal = true;
    session.selectionGeneration += 1;
    session.selectedShipmentId = null;
    session.refreshInFlight = false;
    session.manualRequests = 0;
    session.resumeImmediately = false;
    clearTimer(session);
    settleExtensionRefresh(session.activeExtensionRefresh, 'unauthorized');
    settleExtensionRefresh(session.queuedExtensionRefresh, 'unauthorized');
    session.activeExtensionRefresh = null;
    session.queuedExtensionRefresh = null;
    setView(previous => {
      if (previous.displayRoute !== session.routeKey) return previous;
      return {
        ...emptyViewState(session.routeKey),
        initialLoading: false,
        terminal: true,
        liveMessage: '',
      };
    });
    if (notifyParent) onSessionUnauthorized?.(session.routeKey);
  }

  function canSchedule(session) {
    return sessionRef.current === session
      && session.active
      && !session.terminal
      && document.visibilityState !== 'hidden'
      && !session.refreshInFlight
      && session.manualRequests === 0;
  }

  function schedule(session) {
    clearTimer(session);
    if (!canSchedule(session)) return;
    session.timer = setTimeout(() => {
      session.timer = null;
      startRefresh(session);
    }, REFRESH_DELAY_MS);
  }

  function finishManualRequest(session) {
    if (sessionRef.current !== session || !session.active) return;
    session.manualRequests = Math.max(0, session.manualRequests - 1);
    write(session, { manualBusy: session.manualRequests > 0 });
    if (session.manualRequests > 0) return;
    if (session.queuedExtensionRefresh !== null) {
      Promise.resolve().then(() => launchQueuedExtensionRefresh(session));
      return;
    }
    if (session.resumeImmediately && document.visibilityState !== 'hidden'
        && !session.terminal && !session.refreshInFlight) {
      session.resumeImmediately = false;
      Promise.resolve().then(() => startRefresh(session));
      return;
    }
    schedule(session);
  }

  function settleExtensionRefresh(request, status) {
    if (!request || request.settled) return;
    request.settled = true;
    request.resolve({ status, generation: request.generation });
  }

  function launchQueuedExtensionRefresh(session) {
    if (sessionRef.current !== session || !session.active) {
      settleExtensionRefresh(session.queuedExtensionRefresh, 'stale');
      session.queuedExtensionRefresh = null;
      return;
    }
    if (session.terminal) {
      settleExtensionRefresh(session.queuedExtensionRefresh, 'unauthorized');
      session.queuedExtensionRefresh = null;
      return;
    }
    if (session.refreshInFlight || session.manualRequests > 0
        || session.activeExtensionRefresh !== null) return;
    const request = session.queuedExtensionRefresh;
    if (!request) return;
    session.queuedExtensionRefresh = null;
    session.activeExtensionRefresh = request;
    Promise.resolve()
      .then(() => startRefresh(session, { manual: true, generation: request.generation }))
      .then(result => settleExtensionRefresh(request, result?.status || 'partial'))
      .catch(() => settleExtensionRefresh(request, 'partial'))
      .finally(() => {
        if (session.activeExtensionRefresh === request) session.activeExtensionRefresh = null;
        if (sessionRef.current !== session || !session.active || session.terminal) return;
        if (session.queuedExtensionRefresh !== null) launchQueuedExtensionRefresh(session);
        else schedule(session);
      });
  }

  function requestExtensionRefresh(generation) {
    const session = sessionRef.current;
    if (!session || !session.active) return Promise.resolve({ status: 'stale', generation });
    if (session.terminal) return Promise.resolve({ status: 'unauthorized', generation });
    if (session.activeExtensionRefresh !== null) return session.activeExtensionRefresh.promise;
    if (session.queuedExtensionRefresh !== null) return session.queuedExtensionRefresh.promise;
    let resolve;
    const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
    session.queuedExtensionRefresh = {
      generation,
      promise,
      resolve,
      settled: false,
    };
    clearTimer(session);
    launchQueuedExtensionRefresh(session);
    return promise;
  }

  async function fetchRecentDepth(session) {
    const pages = [];
    let before = null;
    const requestedDepth = Math.max(1, session.headDepth);
    for (let index = 0; index < requestedDepth; index += 1) {
      const result = await listShipmentActivity({
        companyId: session.companyId,
        limit: RECENT_LIMIT,
        before,
      });
      if (sessionRef.current !== session || !session.active || session.terminal) return null;
      pages.push(result);
      before = result.nextBefore;
      if (before === null) break;
    }
    return {
      items: pages.flatMap(result => result.items),
      nextBefore: pages[pages.length - 1].nextBefore,
      depth: pages.length,
    };
  }

  async function fetchTimelineDepth(session, shipmentId, selectionGeneration) {
    const pages = [];
    let before = null;
    const requestedDepth = Math.max(1, session.timelineDepth);
    for (let index = 0; index < requestedDepth; index += 1) {
      let result;
      try {
        result = await getShipmentTimeline({
          companyId: session.companyId,
          shipmentId,
          limit: TIMELINE_LIMIT,
          before,
        });
      } catch (error) {
        if (before !== null && errorKind(error) === 'not-found') {
          throw OLDER_TIMELINE_NOT_FOUND;
        }
        throw error;
      }
      if (sessionRef.current !== session || !session.active || session.terminal
          || session.selectionGeneration !== selectionGeneration
          || session.selectedShipmentId !== shipmentId) return null;
      pages.push(result);
      before = result.nextBefore;
      if (before === null) break;
    }
    return {
      items: pages.slice().reverse().flatMap(result => result.items),
      nextBefore: pages[pages.length - 1].nextBefore,
      depth: pages.length,
    };
  }

  function handleTransient(session) {
    write(session, previous => ({
      ...previous,
      initialLoading: false,
      timelineLoading: false,
      refreshing: false,
      warning: previous.heads.length > 0 || previous.timeline.length > 0
        ? 'Shipment activity could not be refreshed. Showing the last verified evidence.'
        : 'Shipment activity could not be loaded. It will retry while this tab is visible.',
      liveMessage: previous.heads.length > 0 || previous.timeline.length > 0
        ? 'Refresh failed; the verified shipment evidence remains available.'
        : 'The initial shipment activity request failed and will retry.',
    }));
  }

  function handleTimelineNotFound(session, selectionGeneration) {
    if (session.selectionGeneration !== selectionGeneration) return;
    session.suppressAutoSelect = true;
    session.selectedShipmentId = null;
    session.timelineDepth = 1;
    session.timelineCursor = null;
    session.selectionGeneration += 1;
    write(session, previous => ({
      ...previous,
      selectedShipmentId: null,
      timeline: [],
      timelineCursor: null,
      timelineLoading: false,
      missingTimeline: true,
      warning: null,
      liveMessage: 'The selected shipment timeline is unavailable.',
    }));
  }

  function handleOlderTimelineFailure(session) {
    write(session, previous => ({
      ...previous,
      timelineLoading: false,
      refreshing: false,
      warning: 'Older activity could not be loaded. The current evidence is unchanged.',
      liveMessage: 'The older timeline request failed; existing evidence is unchanged.',
    }));
  }

  async function startRefresh(session, { manual = false, generation = null } = {}) {
    if (sessionRef.current !== session || !session.active || session.terminal
        || (!manual && document.visibilityState === 'hidden') || session.refreshInFlight
        || session.manualRequests > 0) {
      return {
        status: session.terminal ? 'unauthorized' : 'stale',
        generation,
      };
    }
    clearTimer(session);
    session.refreshInFlight = true;
    const selectionGenerationAtStart = session.selectionGeneration;
    write(session, previous => ({
      ...previous,
      initialLoading: previous.initialLoading,
      refreshing: previous.heads.length > 0,
    }));

    try {
      const recent = await fetchRecentDepth(session);
      if (!recent) return { status: 'stale', generation };
      session.headDepth = recent.depth;
      session.headCursor = recent.nextBefore;
      const selectionChangedDuringRecent = session.selectionGeneration
        !== selectionGenerationAtStart;

      let selected = session.selectedShipmentId;
      if (selectionChangedDuringRecent) {
        write(session, previous => ({
          ...previous,
          heads: recent.items,
          headCursor: recent.nextBefore,
          initialLoading: false,
          refreshing: false,
        }));
        return { status: 'success', generation };
      }

      if (recent.items.length === 0 && selected === null) {
        session.timelineDepth = 1;
        session.timelineCursor = null;
        write(session, previous => ({
          ...previous,
          heads: [],
          headCursor: recent.nextBefore,
          selectedShipmentId: null,
          timeline: [],
          timelineCursor: null,
          initialLoading: false,
          timelineLoading: false,
          refreshing: false,
          warning: null,
          missingTimeline: false,
          liveMessage: 'The recent shipment list is empty.',
        }));
        return { status: 'success', generation };
      }

      if (selected === null && recent.items.length > 0 && !session.suppressAutoSelect) {
        selected = recent.items[0].shipmentId;
        session.selectedShipmentId = selected;
        session.selectionGeneration += 1;
        session.timelineDepth = 1;
        session.timelineCursor = null;
      }
      const selectionGeneration = session.selectionGeneration;
      write(session, previous => ({
        ...previous,
        heads: recent.items,
        headCursor: recent.nextBefore,
        selectedShipmentId: selected,
        initialLoading: false,
        timelineLoading: selected !== null
          && (previous.selectedShipmentId !== selected || previous.timelineLoading),
        refreshing: false,
        warning: null,
        missingTimeline: false,
        ...(previous.selectedShipmentId === selected ? null : { timeline: [], timelineCursor: null }),
      }));

      if (selected === null) return { status: 'success', generation };
      try {
        const details = await fetchTimelineDepth(session, selected, selectionGeneration);
        if (!details) return { status: 'stale', generation };
        session.timelineDepth = details.depth;
        session.timelineCursor = details.nextBefore;
        write(session, previous => ({
          ...previous,
          timeline: details.items,
          timelineCursor: details.nextBefore,
          timelineLoading: false,
          warning: null,
          liveMessage: 'Shipment activity refreshed.',
        }));
      } catch (error) {
        if (session.selectionGeneration !== selectionGeneration
            || session.selectedShipmentId !== selected) return;
        if (error === OLDER_TIMELINE_NOT_FOUND) {
          handleOlderTimelineFailure(session);
          return { status: 'partial', generation };
        }
        const kind = errorKind(error);
        if (kind === 'unauthorized') {
          terminate(session);
          return { status: 'unauthorized', generation };
        }
        if (kind === 'not-found') handleTimelineNotFound(session, selectionGeneration);
        else handleTransient(session);
        return { status: 'partial', generation };
      }
    } catch (error) {
      if (errorKind(error) === 'unauthorized') {
        terminate(session);
        return { status: 'unauthorized', generation };
      }
      handleTransient(session);
      return { status: 'partial', generation };
    } finally {
      if (sessionRef.current === session && session.active) {
        session.refreshInFlight = false;
        write(session, previous => ({ ...previous, refreshing: false, initialLoading: false }));
        if (session.queuedExtensionRefresh !== null && !session.terminal) {
          Promise.resolve().then(() => launchQueuedExtensionRefresh(session));
        } else if (session.resumeImmediately && document.visibilityState !== 'hidden' && !session.terminal) {
          session.resumeImmediately = false;
          Promise.resolve().then(() => startRefresh(session));
        } else {
          schedule(session);
        }
      }
    }
    return { status: 'success', generation };
  }

  async function selectShipment(shipmentId) {
    const session = sessionRef.current;
    if (!session || !session.active || session.terminal) return;
    clearTimer(session);
    session.suppressAutoSelect = false;
    session.selectedShipmentId = shipmentId;
    session.timelineDepth = 1;
    session.timelineCursor = null;
    session.selectionGeneration += 1;
    const selectionGeneration = session.selectionGeneration;
    session.manualRequests += 1;
    write(session, previous => ({
      ...previous,
      selectedShipmentId: shipmentId,
      timeline: [],
      timelineCursor: null,
      timelineLoading: true,
      manualBusy: true,
      loadingOlderTimeline: false,
      missingTimeline: false,
      warning: null,
      liveMessage: `Loading retained evidence for ${shipmentId}.`,
    }));
    try {
      const details = await fetchTimelineDepth(session, shipmentId, selectionGeneration);
      if (!details) return;
      session.timelineDepth = details.depth;
      session.timelineCursor = details.nextBefore;
      write(session, previous => ({
        ...previous,
        timeline: details.items,
        timelineCursor: details.nextBefore,
        timelineLoading: false,
        warning: null,
        liveMessage: `Retained evidence loaded for ${shipmentId}.`,
      }));
    } catch (error) {
      if (session.selectionGeneration !== selectionGeneration
          || session.selectedShipmentId !== shipmentId) return;
      const kind = errorKind(error);
      if (kind === 'unauthorized') terminate(session);
      else if (kind === 'not-found') handleTimelineNotFound(session, selectionGeneration);
      else handleTransient(session);
    } finally {
      if (sessionRef.current === session && session.active) {
        finishManualRequest(session);
      }
    }
  }

  async function loadOlderHeads() {
    const session = sessionRef.current;
    if (!session || !session.active || session.terminal || session.refreshInFlight
        || session.manualRequests > 0 || session.headCursor === null) return;
    clearTimer(session);
    const cursor = session.headCursor;
    session.manualRequests += 1;
    write(session, {
      manualBusy: true,
      loadingOlderHeads: true,
      liveMessage: 'Loading older shipments.',
    });
    try {
      const result = await listShipmentActivity({
        companyId: session.companyId,
        limit: RECENT_LIMIT,
        before: cursor,
      });
      if (sessionRef.current !== session || !session.active || session.terminal) return;
      session.headDepth += 1;
      session.headCursor = result.nextBefore;
      write(session, previous => ({
        ...previous,
        heads: [...previous.heads, ...result.items],
        headCursor: result.nextBefore,
        loadingOlderHeads: false,
        warning: null,
        liveMessage: 'Older shipments loaded.',
      }));
    } catch (error) {
      if (errorKind(error) === 'unauthorized') terminate(session);
      else write(session, {
        loadingOlderHeads: false,
        warning: 'Older activity could not be loaded. The current evidence is unchanged.',
        liveMessage: 'The older shipment request failed; existing evidence is unchanged.',
      });
    } finally {
      if (sessionRef.current === session && session.active) {
        write(session, { loadingOlderHeads: false });
        finishManualRequest(session);
      }
    }
  }

  async function loadOlderTimeline() {
    const session = sessionRef.current;
    if (!session || !session.active || session.terminal || session.refreshInFlight
        || session.manualRequests > 0 || session.timelineCursor === null
        || session.selectedShipmentId === null) return;
    clearTimer(session);
    const cursor = session.timelineCursor;
    const shipmentId = session.selectedShipmentId;
    const selectionGeneration = session.selectionGeneration;
    session.manualRequests += 1;
    write(session, {
      manualBusy: true,
      loadingOlderTimeline: true,
      liveMessage: 'Loading older activity.',
    });
    try {
      const result = await getShipmentTimeline({
        companyId: session.companyId,
        shipmentId,
        limit: TIMELINE_LIMIT,
        before: cursor,
      });
      if (sessionRef.current !== session || !session.active || session.terminal
          || session.selectionGeneration !== selectionGeneration
          || session.selectedShipmentId !== shipmentId) return;
      session.timelineDepth += 1;
      session.timelineCursor = result.nextBefore;
      write(session, previous => ({
        ...previous,
        timeline: [...result.items, ...previous.timeline],
        timelineCursor: result.nextBefore,
        loadingOlderTimeline: false,
        warning: null,
        liveMessage: 'Older activity loaded.',
      }));
    } catch (error) {
      if (session.selectionGeneration !== selectionGeneration
          || session.selectedShipmentId !== shipmentId) return;
      const kind = errorKind(error);
      if (kind === 'unauthorized') terminate(session);
      else write(session, {
        loadingOlderTimeline: false,
        warning: 'Older activity could not be loaded. The current evidence is unchanged.',
        liveMessage: 'The older timeline request failed; existing evidence is unchanged.',
      });
    } finally {
      if (sessionRef.current === session && session.active) {
        if (session.selectionGeneration === selectionGeneration
            && session.selectedShipmentId === shipmentId) {
          write(session, { loadingOlderTimeline: false });
        }
        finishManualRequest(session);
      }
    }
  }

  useEffect(() => {
    const session = {
      routeKey: normalizedRouteKey,
      companyId,
      active: true,
      terminal: false,
      timer: null,
      refreshInFlight: false,
      manualRequests: 0,
      resumeImmediately: false,
      headDepth: 1,
      timelineDepth: 1,
      headCursor: null,
      timelineCursor: null,
      selectedShipmentId: null,
      selectionGeneration: 0,
      suppressAutoSelect: false,
      activeExtensionRefresh: null,
      queuedExtensionRefresh: null,
    };
    sessionRef.current = session;
    setView(emptyViewState(normalizedRouteKey));

    const onVisibilityChange = () => {
      if (sessionRef.current !== session || !session.active || session.terminal) return;
      if (document.visibilityState === 'hidden') {
        clearTimer(session);
        write(session, { liveMessage: 'Mongo activity refresh paused · tab hidden' });
        return;
      }
      if (session.refreshInFlight || session.manualRequests > 0) {
        session.resumeImmediately = true;
      } else {
        session.resumeImmediately = false;
        startRefresh(session);
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    if (document.visibilityState !== 'hidden') startRefresh(session);

    return () => {
      session.active = false;
      session.selectionGeneration += 1;
      settleExtensionRefresh(session.activeExtensionRefresh, 'stale');
      settleExtensionRefresh(session.queuedExtensionRefresh, 'stale');
      session.activeExtensionRefresh = null;
      session.queuedExtensionRefresh = null;
      clearTimer(session);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [companyId, normalizedRouteKey]);

  useEffect(() => {
    if (!routeTerminal) return;
    const session = sessionRef.current;
    if (session?.routeKey === normalizedRouteKey) {
      terminate(session, { notifyParent: false });
    }
  }, [normalizedRouteKey, routeTerminal]);

  useImperativeHandle(refreshRef, () => ({
    refreshAll: requestExtensionRefresh,
  }), [normalizedRouteKey]);

  const isCurrentRoute = view.displayRoute === normalizedRouteKey;
  const shown = isCurrentRoute ? view : emptyViewState(normalizedRouteKey);
  const hidden = document.visibilityState === 'hidden';
  const refreshLabel = shown.terminal
    ? 'Mongo activity refresh stopped · reauthenticate'
    : hidden
      ? 'Mongo activity refresh paused · tab hidden'
      : 'Mongo activity refresh · 5s';
  const selectedHead = shown.heads.find(item => item.shipmentId === shown.selectedShipmentId);

  return (
    <section className="shipment-activity-shell" aria-labelledby="shipment-activity-title">
      <header className="shipment-activity-header">
        <div className="shipment-activity-heading-block">
          <p className="shipment-activity-eyebrow">90-day Mongo evidence ledger</p>
          <h2 id="shipment-activity-title">Shipment activity log</h2>
          <p className="shipment-activity-supporting">Trusted shipment steps, retained without raw customer or invoice bodies.</p>
        </div>
        <div className="shipment-activity-refresh-block">
          <span className={`shipment-activity-refresh-dot${hidden || shown.terminal ? ' shipment-activity-refresh-dot-paused' : ''}`} aria-hidden="true" />
          <span className="shipment-activity-refresh-label">{refreshLabel}</span>
          <span className="shipment-activity-readonly">Read-only Mongo evidence</span>
        </div>
      </header>

      {shown.terminal ? (
        <p className="shipment-activity-alert shipment-activity-alert-terminal" role="alert">
          Your session has expired. Reauthenticate in Fynd to view shipment activity.
        </p>
      ) : (
        <div className="shipment-activity-layout">
          <aside className="shipment-activity-recent" aria-labelledby="shipment-activity-recent-title">
            <div className="shipment-activity-panel-heading">
              <h3 id="shipment-activity-recent-title">Recent shipments</h3>
              <span>{shown.heads.length} loaded</span>
            </div>
            {shown.initialLoading && shown.heads.length === 0 ? (
              <ActivityLoadingState>Loading recent shipment activity…</ActivityLoadingState>
            ) : shown.heads.length === 0 && !shown.warning ? (
              <div className="shipment-activity-state">
                <strong>No shipment activity recorded</strong>
                <p>New shipment processing events will appear after the extension receives them.</p>
              </div>
            ) : (
              <ul className="shipment-activity-head-list" aria-label="Recent shipments">
                {shown.heads.map(item => {
                  const selected = item.shipmentId === shown.selectedShipmentId;
                  return (
                    <li key={item.shipmentId}>
                      <button
                        type="button"
                        className="shipment-activity-head-button"
                        aria-pressed={selected}
                        onClick={() => selectShipment(item.shipmentId)}
                      >
                        <span className="shipment-activity-head-id">{item.shipmentId}</span>
                        <span className="shipment-activity-head-document">{valueText(item.documentNumber)}</span>
                        <span className="shipment-activity-head-action">{ACTION_LABELS[item.lastAction]}</span>
                        <span className="shipment-activity-head-stage">{STAGE_LABELS[item.lastStage]}</span>
                        <span className={`shipment-activity-head-outcome shipment-activity-head-outcome-${item.lastOutcome.toLowerCase()}`}>
                          {OUTCOME_LABELS[item.lastOutcome]}
                        </span>
                        <time dateTime={item.lastOccurredAt}>{formatUtc(item.lastOccurredAt)}</time>
                        {item.lastSafeCode !== null && <code>{item.lastSafeCode}</code>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {shown.headCursor !== null && (
              <button
                type="button"
                className="shipment-activity-load-button"
                disabled={shown.manualBusy || shown.loadingOlderHeads
                  || shown.refreshing || shown.timelineLoading}
                onClick={loadOlderHeads}
              >
                {shown.loadingOlderHeads ? 'Loading older shipments…' : 'Load older shipments'}
              </button>
            )}
          </aside>

          <main className="shipment-activity-timeline-panel">
            {shown.missingTimeline && (
              <p className="shipment-activity-alert" role="alert">
                This shipment timeline is no longer available. Select another shipment.
              </p>
            )}
            {shown.selectedShipmentId === null ? (
              <p className="shipment-activity-state">Select a shipment to inspect its retained evidence.</p>
            ) : (
              <>
                <div className="shipment-activity-timeline-heading">
                  <div>
                    <span>Shipment</span>
                    <h3 className="shipment-activity-mono">{shown.selectedShipmentId}</h3>
                    {selectedHead && <p className="shipment-activity-mono">{valueText(selectedHead.documentNumber)}</p>}
                  </div>
                  <p>Chronological evidence · oldest to newest</p>
                </div>
                {shown.timelineLoading && shown.timeline.length === 0 ? (
                  <ActivityLoadingState>Loading shipment timeline…</ActivityLoadingState>
                ) : (
                  <ol className="shipment-activity-timeline" aria-label="Chronological evidence · oldest to newest">
                    {shown.timeline.map((item, index) => <EventRow key={index} item={item} />)}
                  </ol>
                )}
                {shown.timelineCursor !== null && (
                  <button
                    type="button"
                    className="shipment-activity-load-button shipment-activity-load-timeline"
                    disabled={shown.manualBusy || shown.loadingOlderTimeline
                      || shown.refreshing || shown.timelineLoading}
                    onClick={loadOlderTimeline}
                  >
                    {shown.loadingOlderTimeline ? 'Loading older activity…' : 'Load older activity'}
                  </button>
                )}
              </>
            )}
          </main>
        </div>
      )}

      {shown.warning && (
        <p className="shipment-activity-alert" role="alert">{shown.warning}</p>
      )}
      <p className="shipment-activity-live" role="status" aria-live="polite" aria-atomic="true">
        {shown.liveMessage}
      </p>
    </section>
  );
});
