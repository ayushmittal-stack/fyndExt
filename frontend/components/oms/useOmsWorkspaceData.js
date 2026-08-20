import { useCallback, useEffect, useRef, useState } from 'react';

import { getShipmentTimeline, listPreJobFailures, listShipmentActivity } from '../../services/shipmentActivityApi';
import { getDryRunJourney, listDryRunFailures, listDryRuns } from '../../services/dryRunApi';
import {
  appendUniqueRows, normalizeHeldRow, normalizeJobFailureRow,
  normalizePreJobFailureRow, normalizeShipmentRow, QUEUE_IDS,
} from './omsModel';
import { useOmsEvidenceActions } from './useOmsEvidenceActions';

const EMPTY_QUEUE = Object.freeze({
  rows: [], cursor: null, loading: false, loadingMore: false, error: null,
  errorOperation: null, loaded: false,
});
const EMPTY_FAILURE_GROUP = Object.freeze({ ...EMPTY_QUEUE });
const EMPTY_FAILURE_QUEUE = Object.freeze({
  ...EMPTY_QUEUE, job: EMPTY_FAILURE_GROUP, preJob: EMPTY_FAILURE_GROUP,
});
const EMPTY_FEEDBACK = Object.freeze({ message: '', count: 0 });
const EMPTY_DETAIL = Object.freeze({
  row: null, timeline: [], cursor: null, journey: null, loading: false,
  refreshing: false, timelineError: null, journeyError: null, warning: '', lastRefreshed: null,
  loadingOlder: false, olderWarning: '', timelineVerified: false, journeyVerified: false,
});

function errorKind(error) {
  if (!error || typeof error !== 'object') return 'request-failed';
  return ['unauthorized', 'not-found', 'request-failed'].includes(error.kind) ? error.kind : 'request-failed';
}

function initialQueues() {
  return {
    [QUEUE_IDS.SHIPMENTS]: { ...EMPTY_QUEUE },
    [QUEUE_IDS.HELD]: { ...EMPTY_QUEUE },
    [QUEUE_IDS.FAILURES]: { ...EMPTY_FAILURE_QUEUE, job: { ...EMPTY_FAILURE_GROUP }, preJob: { ...EMPTY_FAILURE_GROUP } },
  };
}

function queueRequest(queue, companyId, cursor) {
  return queue === QUEUE_IDS.HELD
    ? listDryRuns({ companyId, limit: 20, beforeId: cursor })
    : listShipmentActivity({ companyId, limit: 20, before: cursor });
}

function queuePage(queue, page) {
  return queue === QUEUE_IDS.HELD
    ? { rows: page.items.map(normalizeHeldRow), cursor: page.nextBeforeId }
    : { rows: page.items.map(normalizeShipmentRow), cursor: page.nextBefore };
}

function feedbackForQueue(queue, append) {
  if (queue === QUEUE_IDS.HELD) {
    return append
      ? 'Could not load more held shipments. You can try again.'
      : 'Could not refresh held shipments; last loaded data is still being shown.';
  }
  return append
    ? 'Could not load more shipments. You can try again.'
    : 'Could not refresh shipments; last loaded data is still being shown.';
}

export function useOmsWorkspaceData({ companyId }) {
  const [activeQueue, setActiveQueueState] = useState(QUEUE_IDS.SHIPMENTS);
  const [queues, setQueues] = useState(initialQueues);
  const [terminal, setTerminal] = useState(null);
  const [feedback, setFeedback] = useState(EMPTY_FEEDBACK);
  const [lastRefreshedByQueue, setLastRefreshedByQueue] = useState({});
  const [detailView, setDetailView] = useState(EMPTY_DETAIL);
  const mountedRef = useRef(false);
  const activeQueueRef = useRef(QUEUE_IDS.SHIPMENTS);
  const terminalRef = useRef(null);
  const queuesRef = useRef(initialQueues());
  const initialShipmentRequestRef = useRef(null);
  const requestGenerationRef = useRef(0);
  const queueInFlightRef = useRef(false);
  const failureGenerationRef = useRef({ job: 0, preJob: 0 });
  const failureInFlightRef = useRef({ job: false, preJob: false });
  const selectedRowRef = useRef(null);
  const detailGenerationRef = useRef(0);
  const detailInFlightRef = useRef(false);

  const updateQueues = useCallback(updater => {
    setQueues(current => {
      const next = updater(current);
      queuesRef.current = next;
      return next;
    });
  }, []);

  const announce = useCallback(message => {
    setFeedback(current => ({ message, count: current.message === message ? current.count + 1 : 1 }));
  }, []);

  const stopForUnauthorized = useCallback(() => {
    terminalRef.current = 'unauthorized';
    requestGenerationRef.current += 1;
    failureGenerationRef.current.job += 1;
    failureGenerationRef.current.preJob += 1;
    selectedRowRef.current = null;
    detailGenerationRef.current += 1;
    detailInFlightRef.current = false;
    queueInFlightRef.current = false;
    failureInFlightRef.current = { job: false, preJob: false };
    setDetailView(EMPTY_DETAIL);
    setTerminal('unauthorized');
  }, []);

  const isSessionActive = useCallback(() => mountedRef.current && !terminalRef.current, []);

  const isCurrentDetail = useCallback((generation, rowKey) => mountedRef.current && !terminalRef.current
    && detailGenerationRef.current === generation && selectedRowRef.current?.key === rowKey
    && activeQueueRef.current === selectedRowRef.current?.source, []);

  const timelineItems = useCallback(items => items.map(item => ({
    ...item,
    key: `timeline:${item.shipmentId || selectedRowRef.current?.shipmentId || ''}:${item.occurredAt}:${item.stage}:${item.action}:${item.outcome}:${item.attemptNumber}`,
  })), []);

  const loadDetail = useCallback(async ({ refresh = false } = {}) => {
    const row = selectedRowRef.current;
    if (!mountedRef.current || !row || !companyId || terminalRef.current || detailInFlightRef.current
      || row.source !== activeQueueRef.current) return;
    const generation = detailGenerationRef.current;
    const rowKey = row.key;
    detailInFlightRef.current = true;
    setDetailView(current => current.row?.key === rowKey ? {
      ...current, loading: !refresh, refreshing: refresh, warning: '', timelineError: null,
      journeyError: null,
    } : current);
    const timelineRequest = getShipmentTimeline({ companyId, shipmentId: row.shipmentId, limit: 50, before: null });
    const journeyRequest = row.jobId === null || row.jobId === undefined
      ? null : getDryRunJourney({ companyId, jobId: row.jobId });
    const settle = async (request, resource) => {
      if (!request) return true;
      try {
        const result = await request;
        if (!isCurrentDetail(generation, rowKey)) return false;
        if (resource === 'timeline') {
          setDetailView(current => current.row?.key !== rowKey ? current : {
            ...current, timeline: timelineItems(result.items), cursor: result.nextBefore,
            timelineError: null, timelineVerified: true,
          });
        } else {
          setDetailView(current => current.row?.key !== rowKey ? current : {
            ...current, journey: result, journeyError: null, journeyVerified: true,
          });
        }
        return true;
      } catch (error) {
        if (!isCurrentDetail(generation, rowKey)) return false;
        const kind = errorKind(error);
        if (kind === 'unauthorized') { stopForUnauthorized(); return false; }
        setDetailView(current => {
          if (current.row?.key !== rowKey) return current;
          const verified = resource === 'timeline' ? current.timelineVerified : current.journeyVerified;
          const resourceError = { kind, operation: refresh ? 'refresh' : 'initial' };
          const unavailable = kind === 'not-found';
          const warning = kind === 'request-failed' && refresh && verified
            ? 'Could not refresh shipment evidence; verified evidence is still being shown.' : current.warning;
          return resource === 'timeline'
            ? {
              ...current,
              timeline: unavailable ? [] : current.timeline,
              cursor: unavailable ? null : current.cursor,
              timelineVerified: unavailable ? false : current.timelineVerified,
              timelineError: resourceError,
              warning,
            }
            : {
              ...current,
              journey: unavailable ? null : current.journey,
              journeyVerified: unavailable ? false : current.journeyVerified,
              journeyError: resourceError,
              warning,
            };
        });
        return false;
      }
    };
    const results = await Promise.all([settle(timelineRequest, 'timeline'), settle(journeyRequest, 'journey')]);
    if (isCurrentDetail(generation, rowKey)) {
      setDetailView(current => current.row?.key !== rowKey ? current : {
        ...current, loading: false, refreshing: false,
        lastRefreshed: results.every(Boolean) ? new Date().toISOString() : current.lastRefreshed,
      });
      detailInFlightRef.current = false;
    }
  }, [companyId, isCurrentDetail, stopForUnauthorized, timelineItems]);

  const selectRow = useCallback(row => {
    if (!row || terminalRef.current || row.source !== activeQueueRef.current) return;
    detailGenerationRef.current += 1;
    selectedRowRef.current = row;
    detailInFlightRef.current = false;
    setDetailView({ ...EMPTY_DETAIL, row, loading: true });
    Promise.resolve().then(() => loadDetail());
  }, [loadDetail]);

  const closeDetail = useCallback(() => {
    detailGenerationRef.current += 1;
    detailInFlightRef.current = false;
    selectedRowRef.current = null;
    setDetailView(EMPTY_DETAIL);
  }, []);

  const refreshDetail = useCallback(() => loadDetail({ refresh: true }), [loadDetail]);

  const loadOlderActivity = useCallback(async () => {
    const current = selectedRowRef.current;
    const cursor = detailView.cursor;
    if (!current || cursor === null || terminalRef.current || detailInFlightRef.current
      || detailView.loading || detailView.refreshing
      || current.source !== activeQueueRef.current) return;
    const generation = detailGenerationRef.current;
    const rowKey = current.key;
    detailInFlightRef.current = true;
    setDetailView(view => view.row?.key === rowKey ? { ...view, loadingOlder: true, olderWarning: '' } : view);
    try {
      const page = await getShipmentTimeline({ companyId, shipmentId: current.shipmentId, limit: 50, before: cursor });
      if (!isCurrentDetail(generation, rowKey)) return;
      const incoming = timelineItems(page.items);
      setDetailView(view => view.row?.key !== rowKey ? view : {
        ...view, timeline: appendUniqueRows(incoming, view.timeline), cursor: page.nextBefore,
        loadingOlder: false, olderWarning: '',
      });
    } catch (error) {
      if (!isCurrentDetail(generation, rowKey)) return;
      if (errorKind(error) === 'unauthorized') { stopForUnauthorized(); return; }
      setDetailView(view => view.row?.key === rowKey ? {
        ...view, loadingOlder: false, olderWarning: 'Could not load older activity. You can try again.',
      } : view);
    } finally {
      if (detailGenerationRef.current === generation) detailInFlightRef.current = false;
    }
  }, [companyId, detailView.cursor, detailView.loading, detailView.refreshing, isCurrentDetail, stopForUnauthorized, timelineItems]);

  const requestQueue = useCallback(async (queue, { cursor = null, append = false, bootstrap = false } = {}) => {
    if (!companyId || terminalRef.current || queueInFlightRef.current || activeQueueRef.current !== queue
      || ![QUEUE_IDS.SHIPMENTS, QUEUE_IDS.HELD].includes(queue)) return;
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    queueInFlightRef.current = true;
    setFeedback(EMPTY_FEEDBACK);
    updateQueues(current => ({ ...current, [queue]: {
      ...(current[queue] || EMPTY_QUEUE), error: null, errorOperation: null,
      loading: !append, loadingMore: append,
    } }));
    try {
      let request;
      if (queue === QUEUE_IDS.SHIPMENTS && bootstrap) {
        const companyKey = String(companyId);
        const existing = initialShipmentRequestRef.current;
        if (existing?.companyKey === companyKey) request = existing.request;
        else {
          request = listShipmentActivity({ companyId, limit: 20, before: null });
          const entry = { companyKey, request };
          initialShipmentRequestRef.current = entry;
          const remove = () => {
            if (initialShipmentRequestRef.current === entry) initialShipmentRequestRef.current = null;
          };
          request.then(remove, remove);
        }
      } else request = queueRequest(queue, companyId, cursor);
      const result = queuePage(queue, await request);
      if (!mountedRef.current || terminalRef.current || activeQueueRef.current !== queue
        || requestGenerationRef.current !== generation) return;
      setFeedback(EMPTY_FEEDBACK);
      updateQueues(current => {
        const queueState = current[queue] || EMPTY_QUEUE;
        return { ...current, [queue]: {
          ...queueState, rows: append ? appendUniqueRows(queueState.rows, result.rows) : result.rows,
          cursor: result.cursor, loading: false, loadingMore: false, error: null,
          errorOperation: null, loaded: true,
        } };
      });
      if (!append) setLastRefreshedByQueue(current => ({ ...current, [queue]: new Date().toISOString() }));
    } catch (error) {
      if (!mountedRef.current || activeQueueRef.current !== queue || requestGenerationRef.current !== generation) return;
      const kind = errorKind(error);
      const currentQueue = queuesRef.current[queue] || EMPTY_QUEUE;
      if (kind === 'unauthorized') stopForUnauthorized();
      else {
        updateQueues(current => {
          const state = current[queue] || EMPTY_QUEUE;
          const firstLoad = !state.loaded && state.rows.length === 0;
          return { ...current, [queue]: {
            ...state, loading: false, loadingMore: false, error: kind,
            errorOperation: append ? 'more' : firstLoad ? 'initial' : 'refresh',
          } };
        });
        if (currentQueue.loaded) announce(feedbackForQueue(queue, append));
      }
    } finally {
      if (requestGenerationRef.current === generation) queueInFlightRef.current = false;
    }
  }, [announce, companyId, stopForUnauthorized, updateQueues]);

  const requestFailureGroup = useCallback(async (group, { cursor = null, append = false } = {}) => {
    if (!companyId || terminalRef.current || activeQueueRef.current !== QUEUE_IDS.FAILURES
      || failureInFlightRef.current[group]) return;
    const generation = failureGenerationRef.current[group] + 1;
    failureGenerationRef.current[group] = generation;
    failureInFlightRef.current[group] = true;
    updateQueues(current => {
      const failureQueue = current[QUEUE_IDS.FAILURES] || EMPTY_FAILURE_QUEUE;
      return { ...current, [QUEUE_IDS.FAILURES]: {
        ...failureQueue, [group]: {
          ...(failureQueue[group] || EMPTY_FAILURE_GROUP), error: null, errorOperation: null,
          loading: !append, loadingMore: append,
        },
      } };
    });
    try {
      const page = group === 'job'
        ? await listDryRunFailures({ companyId, limit: 20, beforeId: cursor })
        : await listPreJobFailures({ companyId, limit: 20, before: cursor });
      if (!mountedRef.current || terminalRef.current || activeQueueRef.current !== QUEUE_IDS.FAILURES
        || failureGenerationRef.current[group] !== generation) return;
      const incoming = page.items.map(group === 'job' ? normalizeJobFailureRow : normalizePreJobFailureRow);
      const nextCursor = group === 'job' ? page.nextBeforeId : page.nextBefore;
      updateQueues(current => {
        const failureQueue = current[QUEUE_IDS.FAILURES] || EMPTY_FAILURE_QUEUE;
        const oldGroup = failureQueue[group] || EMPTY_FAILURE_GROUP;
        const nextGroup = {
          ...oldGroup, rows: append ? appendUniqueRows(oldGroup.rows, incoming) : incoming,
          cursor: nextCursor, loading: false, loadingMore: false, error: null,
          errorOperation: null, loaded: true,
        };
        return { ...current, [QUEUE_IDS.FAILURES]: {
          ...failureQueue, [group]: nextGroup,
          loaded: group === 'job' ? nextGroup.loaded && failureQueue.preJob.loaded : failureQueue.job.loaded && nextGroup.loaded,
        } };
      });
      return true;
    } catch (error) {
      if (!mountedRef.current || activeQueueRef.current !== QUEUE_IDS.FAILURES
        || failureGenerationRef.current[group] !== generation) return;
      const kind = errorKind(error);
      if (kind === 'unauthorized') stopForUnauthorized();
      else updateQueues(current => {
        const failureQueue = current[QUEUE_IDS.FAILURES] || EMPTY_FAILURE_QUEUE;
        const oldGroup = failureQueue[group] || EMPTY_FAILURE_GROUP;
        const firstLoad = !oldGroup.loaded && oldGroup.rows.length === 0;
        return { ...current, [QUEUE_IDS.FAILURES]: {
          ...failureQueue, [group]: {
            ...oldGroup, loading: false, loadingMore: false, error: kind,
            errorOperation: append ? 'more' : firstLoad ? 'initial' : 'refresh',
          },
        } };
      });
      return false;
    } finally {
      if (failureGenerationRef.current[group] === generation) failureInFlightRef.current[group] = false;
    }
  }, [companyId, stopForUnauthorized, updateQueues]);

  const requestFailures = useCallback(async () => {
    if (activeQueueRef.current !== QUEUE_IDS.FAILURES || terminalRef.current) return;
    setFeedback(EMPTY_FEEDBACK);
    const results = await Promise.all([
      requestFailureGroup('job', { cursor: null, append: false }),
      requestFailureGroup('preJob', { cursor: null, append: false }),
    ]);
    if (mountedRef.current && !terminalRef.current && activeQueueRef.current === QUEUE_IDS.FAILURES
      && results.every(Boolean)) {
      setLastRefreshedByQueue(current => ({ ...current, [QUEUE_IDS.FAILURES]: new Date().toISOString() }));
    }
  }, [requestFailureGroup]);

  useEffect(() => {
    mountedRef.current = true;
    terminalRef.current = null;
    activeQueueRef.current = QUEUE_IDS.SHIPMENTS;
    requestGenerationRef.current += 1;
    failureGenerationRef.current.job += 1;
    failureGenerationRef.current.preJob += 1;
    queueInFlightRef.current = false;
    failureInFlightRef.current = { job: false, preJob: false };
    selectedRowRef.current = null;
    detailGenerationRef.current += 1;
    detailInFlightRef.current = false;
    const freshQueues = initialQueues();
    queuesRef.current = freshQueues;
    setQueues(freshQueues);
    setActiveQueueState(QUEUE_IDS.SHIPMENTS);
    setTerminal(null);
    setFeedback(EMPTY_FEEDBACK);
    setLastRefreshedByQueue({});
    setDetailView(EMPTY_DETAIL);
    if (companyId) requestQueue(QUEUE_IDS.SHIPMENTS, { bootstrap: true });
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      failureGenerationRef.current.job += 1;
      failureGenerationRef.current.preJob += 1;
      detailGenerationRef.current += 1;
      selectedRowRef.current = null;
      queueInFlightRef.current = false;
      failureInFlightRef.current = { job: false, preJob: false };
      detailInFlightRef.current = false;
    };
  // Route/company changes intentionally create a fresh OMS data session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  const setActiveQueue = useCallback(queue => {
    if (!Object.values(QUEUE_IDS).includes(queue) || queue === activeQueueRef.current || terminalRef.current) return;
    requestGenerationRef.current += 1;
    failureGenerationRef.current.job += 1;
    failureGenerationRef.current.preJob += 1;
    detailGenerationRef.current += 1;
    selectedRowRef.current = null;
    detailInFlightRef.current = false;
    queueInFlightRef.current = false;
    failureInFlightRef.current = { job: false, preJob: false };
    setDetailView(EMPTY_DETAIL);
    updateQueues(current => {
      const next = { ...current };
      [QUEUE_IDS.SHIPMENTS, QUEUE_IDS.HELD].forEach(id => {
        next[id] = { ...(current[id] || EMPTY_QUEUE), loading: false, loadingMore: false };
      });
      const failures = current[QUEUE_IDS.FAILURES] || EMPTY_FAILURE_QUEUE;
      next[QUEUE_IDS.FAILURES] = {
        ...failures,
        job: { ...failures.job, loading: false, loadingMore: false },
        preJob: { ...failures.preJob, loading: false, loadingMore: false },
      };
      return next;
    });
    activeQueueRef.current = queue;
    setActiveQueueState(queue);
    const state = queuesRef.current[queue];
    if (queue === QUEUE_IDS.FAILURES) {
      if (!state?.loaded) requestFailures();
    } else if (!state?.loaded) requestQueue(queue, { cursor: null });
  }, [requestFailures, requestQueue, updateQueues]);

  const refresh = useCallback(() => {
    if (activeQueueRef.current === QUEUE_IDS.FAILURES) requestFailures();
    else requestQueue(activeQueueRef.current, { cursor: null });
  }, [requestFailures, requestQueue]);

  const loadMore = useCallback(() => {
    const queue = activeQueueRef.current;
    const cursor = queuesRef.current[queue]?.cursor;
    if (cursor !== null && cursor !== undefined) requestQueue(queue, { cursor, append: true });
  }, [requestQueue]);

  const loadMoreFailures = useCallback(group => {
    const cursor = queuesRef.current[QUEUE_IDS.FAILURES]?.[group]?.cursor;
    if (cursor !== null && cursor !== undefined) requestFailureGroup(group, { cursor, append: true });
  }, [requestFailureGroup]);

  const markJourneyMissing = useCallback(() => {
    const rowKey = selectedRowRef.current?.key;
    setDetailView(current => current.row?.key === rowKey ? {
      ...current, journey: null, journeyVerified: false,
      journeyError: { kind: 'not-found', operation: 'initial' },
    } : current);
  }, []);

  const evidenceActions = useOmsEvidenceActions({
    companyId,
    row: detailView.row,
    journey: detailView.journey,
    detailBusy: detailView.loading || detailView.refreshing || detailView.loadingOlder,
    sessionActive: terminal === null,
    isSessionActive,
    onUnauthorized: stopForUnauthorized,
    onJourneyMissing: markJourneyMissing,
  });

  const queueView = queues[activeQueue] || EMPTY_QUEUE;
  const failureView = queues[QUEUE_IDS.FAILURES] || EMPTY_FAILURE_QUEUE;
  const jobShipmentIds = new Set(failureView.job.rows.map(row => row.shipmentId));
  const visiblePreJobCount = failureView.preJob.rows.filter(item => !jobShipmentIds.has(item.shipmentId)).length;
  const queueCounts = {
    [QUEUE_IDS.SHIPMENTS]: queues[QUEUE_IDS.SHIPMENTS]?.rows.length || 0,
    [QUEUE_IDS.HELD]: queues[QUEUE_IDS.HELD]?.rows.length || 0,
    [QUEUE_IDS.FAILURES]: failureView.job.rows.length + visiblePreJobCount,
  };
  const queueBusy = activeQueue === QUEUE_IDS.FAILURES
    ? failureView.job.loading || failureView.preJob.loading
    : queueView.loading;
  const queueBusyMore = activeQueue === QUEUE_IDS.FAILURES
    ? failureView.job.loadingMore || failureView.preJob.loadingMore
    : queueView.loadingMore;
  return {
    activeQueue, queueView, failureView, queueCounts, queueBusy, queueBusyMore,
    detailView, terminal, feedback, lastRefreshed: lastRefreshedByQueue[activeQueue] || null,
    setActiveQueue, refresh, loadMore, loadMoreFailures, selectRow, closeDetail, refreshDetail,
    loadOlderActivity, evidenceActions,
    downloadDiagnostic: evidenceActions.downloadDiagnostic,
    copyPodCurl: evidenceActions.copyPodCurl,
  };
}
