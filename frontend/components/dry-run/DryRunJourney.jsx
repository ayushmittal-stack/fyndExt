import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

import {
  getDryRunJourney,
  getDryRunPodCurl,
  getDryRunRequestBlob,
  listDryRunFailures,
  listDryRuns,
} from '../../services/dryRunApi';
import { listPreJobFailures } from '../../services/shipmentActivityApi';
import { FailedShipments } from './FailedShipments';
import { HeldJobList } from './HeldJobList';
import { JourneyDetail } from './JourneyDetail';
import './dry-run.css';

const POLL_INTERVAL_MS = 5000;
const OBJECT_URL_LIFETIME_MS = 1000;
const EMPTY_FEEDBACK = Object.freeze({ message: '', count: 0 });

function errorCopy(kind) {
  if (kind === 'unauthorized') {
    return 'Your session has expired. Reauthenticate in Fynd to inspect held journeys.';
  }
  return 'Dry-run data could not be loaded.';
}

function detailIdentity(value) {
  if (!value) return null;
  return `${value.job.jobId}:${value.steps.payloadPreparation.requestHash}`;
}

function canCopyPodCurl(value) {
  return value?.mode === 'dry-run'
    && value.job?.state === 'SUBMISSION_HELD'
    && value.steps?.fyndLock?.status === 'completed'
    && value.steps.fyndLock.result?.locked === true
    && value.steps?.oeisSubmission?.status === 'held';
}

function posixSingleQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildPodCurl(envelope) {
  return [
    `printf '%s' ${posixSingleQuote(envelope.requestJson)} | curl --disable --silent --show-error --max-redirs 0 \\`,
    `  --request ${envelope.method} \\`,
    `  --noproxy ${posixSingleQuote('*')} \\`,
    `  --url ${posixSingleQuote(envelope.url)} \\`,
    `  --header ${posixSingleQuote(`Authorization: APIkey ${envelope.apiKey}`)} \\`,
    `  --header ${posixSingleQuote('Connection: keep-alive')} \\`,
    `  --header ${posixSingleQuote('Content-Type: application/json')} \\`,
    '  --data-binary @-',
  ].join('\n');
}

function mergeFailuresDescending(current, refreshed) {
  const byJobId = new Map(current.map(item => [item.jobId, item]));
  refreshed.forEach(item => byJobId.set(item.jobId, item));
  return [...byJobId.values()].sort((left, right) => right.jobId - left.jobId);
}

function mergePreJobFailuresDescending(current, refreshed) {
  const byShipmentId = new Map(current.map(item => [item.shipmentId, item]));
  refreshed.forEach(item => byShipmentId.set(item.shipmentId, item));
  return [...byShipmentId.values()].sort((left, right) => {
    const byTime = Date.parse(right.lastOccurredAt) - Date.parse(left.lastOccurredAt);
    return byTime || right.shipmentId.localeCompare(left.shipmentId);
  });
}

function settleExtensionRequest(request, status) {
  if (!request || request.settled) return;
  request.settled = true;
  request.resolve({ status, generation: request.generation });
}

export const DryRunJourney = forwardRef(function DryRunJourney(
  {
    companyId,
    routeKey = String(companyId),
    onRefreshAll,
    extensionRefreshing = false,
    extensionRefreshDisabled = false,
    extensionRefreshMessage = '',
    routeTerminal = false,
    onSessionUnauthorized,
  },
  refreshRef,
) {
  const [jobs, setJobs] = useState([]);
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(null);
  const [missingSelection, setMissingSelection] = useState(false);
  const [feedback, setFeedback] = useState(EMPTY_FEEDBACK);
  const [copyingPodCurl, setCopyingPodCurl] = useState(false);
  const [failures, setFailures] = useState([]);
  const [failureLoading, setFailureLoading] = useState(true);
  const [failureError, setFailureError] = useState(null);
  const [failureNextBeforeId, setFailureNextBeforeId] = useState(null);
  const [failureLoadingOlder, setFailureLoadingOlder] = useState(false);
  const [preJobFailures, setPreJobFailures] = useState([]);
  const [preJobLoading, setPreJobLoading] = useState(true);
  const [preJobError, setPreJobError] = useState(null);
  const [preJobNextBefore, setPreJobNextBefore] = useState(null);
  const [preJobLoadingOlder, setPreJobLoadingOlder] = useState(false);
  const [displayRouteKey, setDisplayRouteKey] = useState(routeKey);
  const [visibility, setVisibility] = useState(document.visibilityState);
  const mountedRef = useRef(false);
  const selectedRef = useRef(null);
  const stoppedRef = useRef(false);
  const suppressAutoSelectRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const pollTimerRef = useRef(null);
  const detailInFlightRef = useRef(false);
  const detailRequestRef = useRef(0);
  const sessionRef = useRef(0);
  const failureGenerationRef = useRef(0);
  const failureInFlightRef = useRef(false);
  const failureCursorRef = useRef(null);
  const failureOlderLoadedRef = useRef(false);
  const failureDepthRef = useRef(1);
  const preJobGenerationRef = useRef(0);
  const preJobInFlightRef = useRef(false);
  const preJobCursorRef = useRef(null);
  const preJobOlderLoadedRef = useRef(false);
  const preJobDepthRef = useRef(1);
  const extensionRefreshRef = useRef({ active: null, queued: null });
  const runExtensionRefreshRef = useRef(null);
  const selectionGenerationRef = useRef(0);
  const detailIdentityRef = useRef(null);
  const podCurlEligibleRef = useRef(false);
  const podCurlActionRef = useRef(0);
  const podCurlInFlightRef = useRef(false);
  const blobCacheRef = useRef(new Map());
  const objectUrlsRef = useRef(new Map());

  function refreshWorkInFlight() {
    return refreshInFlightRef.current
      || detailInFlightRef.current
      || failureInFlightRef.current
      || preJobInFlightRef.current;
  }

  function maybeStartExtensionRefresh() {
    const coordinator = extensionRefreshRef.current;
    const request = coordinator.queued;
    if (!request || coordinator.active || refreshWorkInFlight()) return;
    if (!mountedRef.current || request.sessionId !== sessionRef.current) {
      coordinator.queued = null;
      settleExtensionRequest(request, 'stale');
      return;
    }
    if (stoppedRef.current) {
      coordinator.queued = null;
      settleExtensionRequest(request, 'unauthorized');
      return;
    }
    coordinator.queued = null;
    coordinator.active = request;
    Promise.resolve()
      .then(() => runExtensionRefreshRef.current(request.generation))
      .then(result => settleExtensionRequest(request, result?.status || 'partial'))
      .catch(() => settleExtensionRequest(request, 'partial'))
      .finally(() => {
        if (extensionRefreshRef.current.active === request) {
          extensionRefreshRef.current.active = null;
        }
        maybeStartExtensionRefresh();
      });
  }

  function requestExtensionRefresh(generation) {
    if (!mountedRef.current) return Promise.resolve({ status: 'stale', generation });
    if (stoppedRef.current) return Promise.resolve({ status: 'unauthorized', generation });
    const coordinator = extensionRefreshRef.current;
    if (coordinator.active) return coordinator.active.promise;
    if (coordinator.queued) return coordinator.queued.promise;
    let resolve;
    const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
    coordinator.queued = {
      generation,
      sessionId: sessionRef.current,
      promise,
      resolve,
      settled: false,
    };
    maybeStartExtensionRefresh();
    return promise;
  }

  const announce = useCallback(message => {
    setFeedback(current => ({
      message,
      count: current.message === message ? current.count + 1 : 1,
    }));
  }, []);

  const cancelPodCurlAction = useCallback(() => {
    podCurlActionRef.current += 1;
    podCurlInFlightRef.current = false;
    if (mountedRef.current) setCopyingPodCurl(false);
  }, []);

  const clearMissingSelection = useCallback(() => {
    suppressAutoSelectRef.current = true;
    cancelPodCurlAction();
    selectionGenerationRef.current += 1;
    selectedRef.current = null;
    detailIdentityRef.current = null;
    podCurlEligibleRef.current = false;
    setSelectedJobId(null);
    setDetail(null);
    setFeedback(EMPTY_FEEDBACK);
    setMissingSelection(true);
  }, [cancelPodCurlAction]);

  const revokeObjectUrl = useCallback(url => {
    if (!objectUrlsRef.current.has(url)) return;
    const timerId = objectUrlsRef.current.get(url);
    if (timerId !== null) window.clearTimeout(timerId);
    objectUrlsRef.current.delete(url);
    URL.revokeObjectURL(url);
  }, []);

  const stopForUnauthorized = useCallback((sessionId, { notifyParent = true } = {}) => {
    if (!mountedRef.current || sessionId !== sessionRef.current || stoppedRef.current) return;
    stoppedRef.current = true;
    cancelPodCurlAction();
    refreshInFlightRef.current = false;
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    failureGenerationRef.current += 1;
    failureInFlightRef.current = false;
    failureCursorRef.current = null;
    failureOlderLoadedRef.current = false;
    failureDepthRef.current = 1;
    preJobGenerationRef.current += 1;
    preJobInFlightRef.current = false;
    preJobCursorRef.current = null;
    preJobOlderLoadedRef.current = false;
    preJobDepthRef.current = 1;
    settleExtensionRequest(extensionRefreshRef.current.active, 'unauthorized');
    settleExtensionRequest(extensionRefreshRef.current.queued, 'unauthorized');
    extensionRefreshRef.current = { active: null, queued: null };
    detailRequestRef.current += 1;
    detailInFlightRef.current = false;
    selectionGenerationRef.current += 1;
    selectedRef.current = null;
    detailIdentityRef.current = null;
    podCurlEligibleRef.current = false;
    setJobs([]);
    setSelectedJobId(null);
    setDetail(null);
    setLoading(false);
    setDetailLoading(false);
    setMissingSelection(false);
    setFeedback(EMPTY_FEEDBACK);
    setCopyingPodCurl(false);
    setFailures([]);
    setFailureLoading(false);
    setFailureError(null);
    setFailureNextBeforeId(null);
    setFailureLoadingOlder(false);
    setPreJobFailures([]);
    setPreJobLoading(false);
    setPreJobError(null);
    setPreJobNextBefore(null);
    setPreJobLoadingOlder(false);
    setError('unauthorized');
    objectUrlsRef.current.forEach((timerId, url) => {
      if (timerId !== null) window.clearTimeout(timerId);
      URL.revokeObjectURL(url);
    });
    objectUrlsRef.current.clear();
    blobCacheRef.current.clear();
    if (notifyParent) onSessionUnauthorized?.(routeKey);
  }, [cancelPodCurlAction, onSessionUnauthorized, routeKey]);

  const loadDetail = useCallback(async (jobId, { replacePending = false } = {}) => {
    if (!jobId || stoppedRef.current) {
      return { status: stoppedRef.current ? 'unauthorized' : 'stale' };
    }
    if (detailInFlightRef.current && !replacePending) return { status: 'stale' };
    const sessionId = sessionRef.current;
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    detailInFlightRef.current = true;
    if (mountedRef.current) setDetailLoading(true);
    try {
      const nextDetail = await getDryRunJourney({ companyId, jobId });
      if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current
          || requestId !== detailRequestRef.current || selectedRef.current !== jobId) {
        return { status: 'stale' };
      }
      const nextIdentity = detailIdentity(nextDetail);
      const nextPodCurlEligible = canCopyPodCurl(nextDetail);
      if (detailIdentityRef.current !== nextIdentity
          || podCurlEligibleRef.current !== nextPodCurlEligible) {
        cancelPodCurlAction();
        setFeedback(EMPTY_FEEDBACK);
      }
      detailIdentityRef.current = nextIdentity;
      podCurlEligibleRef.current = nextPodCurlEligible;
      setDetail(nextDetail);
      setMissingSelection(false);
      setError(null);
      return { status: 'success' };
    } catch (requestError) {
      if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current
          || requestId !== detailRequestRef.current) return { status: 'stale' };
      if (requestError?.kind === 'unauthorized') {
        stopForUnauthorized(sessionId);
        return { status: 'unauthorized' };
      } else if (requestError?.kind === 'not-found') {
        clearMissingSelection();
        return { status: 'partial' };
      } else {
        setError('request-failed');
        return { status: 'partial' };
      }
    } finally {
      if (sessionId === sessionRef.current && requestId === detailRequestRef.current) {
        detailInFlightRef.current = false;
        if (mountedRef.current && !stoppedRef.current) setDetailLoading(false);
        maybeStartExtensionRefresh();
      }
    }
  }, [cancelPodCurlAction, clearMissingSelection, companyId, stopForUnauthorized]);

  const refresh = useCallback(async ({ manual = false } = {}) => {
    if (!mountedRef.current || stoppedRef.current || refreshInFlightRef.current
        || (!manual && document.visibilityState !== 'visible')) {
      return { status: stoppedRef.current ? 'unauthorized' : 'stale' };
    }
    const sessionId = sessionRef.current;
    refreshInFlightRef.current = true;
    try {
      const page = await listDryRuns({ companyId, limit: 20 });
      if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current) {
        return { status: 'stale' };
      }
      const nextJobs = Array.isArray(page.items) ? page.items : [];
      setJobs(nextJobs);
      setLoading(false);
      setError(null);

      if (nextJobs.length === 0) {
        cancelPodCurlAction();
        selectionGenerationRef.current += 1;
        selectedRef.current = null;
        detailIdentityRef.current = null;
        podCurlEligibleRef.current = false;
        setSelectedJobId(null);
        setDetail(null);
        setFeedback(EMPTY_FEEDBACK);
        return { status: 'success' };
      }

      let jobId = selectedRef.current;
      if (jobId === null && !suppressAutoSelectRef.current) {
        jobId = nextJobs[0].jobId;
        selectionGenerationRef.current += 1;
        selectedRef.current = jobId;
        setSelectedJobId(jobId);
        setFeedback(EMPTY_FEEDBACK);
      }
      if (jobId !== null && !stoppedRef.current) return await loadDetail(jobId);
      return { status: 'success' };
    } catch (requestError) {
      if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current) {
        return { status: 'stale' };
      }
      setLoading(false);
      if (requestError?.kind === 'unauthorized') {
        stopForUnauthorized(sessionId);
        return { status: 'unauthorized' };
      }
      setError('request-failed');
      return { status: 'partial' };
    } finally {
      if (sessionId === sessionRef.current) {
        refreshInFlightRef.current = false;
        maybeStartExtensionRefresh();
      }
    }
  }, [cancelPodCurlAction, companyId, loadDetail, stopForUnauthorized]);

  const refreshFailures = useCallback(async () => {
    if (!mountedRef.current || stoppedRef.current || failureInFlightRef.current
        || document.visibilityState !== 'visible') return;
    const sessionId = sessionRef.current;
    const generation = failureGenerationRef.current;
    failureInFlightRef.current = true;
    try {
      const page = await listDryRunFailures({ companyId, limit: 20 });
      if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current
          || generation !== failureGenerationRef.current) return;
      const hasOlderRows = failureOlderLoadedRef.current;
      setFailures(current => {
        if (!hasOlderRows) return page.items;
        return mergeFailuresDescending(current, page.items);
      });
      if (!hasOlderRows) {
        failureCursorRef.current = page.nextBeforeId;
        setFailureNextBeforeId(page.nextBeforeId);
      }
      setFailureLoading(false);
      setFailureError(null);
    } catch (requestError) {
      if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current
          || generation !== failureGenerationRef.current) return;
      setFailureLoading(false);
      if (requestError?.kind === 'unauthorized') stopForUnauthorized(sessionId);
      else setFailureError('request-failed');
    } finally {
      if (sessionId === sessionRef.current && generation === failureGenerationRef.current) {
        failureInFlightRef.current = false;
        maybeStartExtensionRefresh();
      }
    }
  }, [companyId, stopForUnauthorized]);

  const loadOlderFailures = useCallback(async () => {
    const beforeId = failureCursorRef.current;
    if (beforeId === null || !mountedRef.current || stoppedRef.current
        || failureInFlightRef.current) return;
    const sessionId = sessionRef.current;
    const generation = failureGenerationRef.current;
    failureInFlightRef.current = true;
    setFailureLoadingOlder(true);
    try {
      const page = await listDryRunFailures({ companyId, limit: 20, beforeId });
      if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current
          || generation !== failureGenerationRef.current) return;
      setFailures(current => {
        const knownIds = new Set(current.map(item => item.jobId));
        const appended = [...current];
        page.items.forEach(item => {
          if (knownIds.has(item.jobId)) return;
          knownIds.add(item.jobId);
          appended.push(item);
        });
        return appended;
      });
      failureOlderLoadedRef.current = true;
      failureDepthRef.current += 1;
      failureCursorRef.current = page.nextBeforeId;
      setFailureNextBeforeId(page.nextBeforeId);
      setFailureError(null);
    } catch (requestError) {
      if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current
          || generation !== failureGenerationRef.current) return;
      if (requestError?.kind === 'unauthorized') stopForUnauthorized(sessionId);
      else setFailureError('request-failed');
    } finally {
      if (sessionId === sessionRef.current && generation === failureGenerationRef.current) {
        failureInFlightRef.current = false;
        if (mountedRef.current && !stoppedRef.current) setFailureLoadingOlder(false);
        maybeStartExtensionRefresh();
      }
    }
  }, [companyId, stopForUnauthorized]);

  const refreshPreJobFailures = useCallback(async () => {
    if (!mountedRef.current || stoppedRef.current || preJobInFlightRef.current
        || document.visibilityState !== 'visible') return;
    const sessionId = sessionRef.current;
    const generation = preJobGenerationRef.current;
    preJobInFlightRef.current = true;
    try {
      const page = await listPreJobFailures({ companyId, limit: 20 });
      if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current
          || generation !== preJobGenerationRef.current) return;
      const hasOlderRows = preJobOlderLoadedRef.current;
      setPreJobFailures(current => (
        hasOlderRows ? mergePreJobFailuresDescending(current, page.items) : page.items
      ));
      if (!hasOlderRows) {
        preJobCursorRef.current = page.nextBefore;
        setPreJobNextBefore(page.nextBefore);
      }
      setPreJobLoading(false);
      setPreJobError(null);
    } catch (requestError) {
      if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current
          || generation !== preJobGenerationRef.current) return;
      setPreJobLoading(false);
      if (requestError?.kind === 'unauthorized') stopForUnauthorized(sessionId);
      else setPreJobError('request-failed');
    } finally {
      if (sessionId === sessionRef.current && generation === preJobGenerationRef.current) {
        preJobInFlightRef.current = false;
        maybeStartExtensionRefresh();
      }
    }
  }, [companyId, stopForUnauthorized]);

  const loadOlderPreJobFailures = useCallback(async () => {
    const before = preJobCursorRef.current;
    if (before === null || !mountedRef.current || stoppedRef.current
        || preJobInFlightRef.current) return;
    const sessionId = sessionRef.current;
    const generation = preJobGenerationRef.current;
    preJobInFlightRef.current = true;
    setPreJobLoadingOlder(true);
    try {
      const page = await listPreJobFailures({ companyId, limit: 20, before });
      if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current
          || generation !== preJobGenerationRef.current) return;
      setPreJobFailures(current => mergePreJobFailuresDescending(current, page.items));
      preJobOlderLoadedRef.current = true;
      preJobDepthRef.current += 1;
      preJobCursorRef.current = page.nextBefore;
      setPreJobNextBefore(page.nextBefore);
      setPreJobError(null);
    } catch (requestError) {
      if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current
          || generation !== preJobGenerationRef.current) return;
      if (requestError?.kind === 'unauthorized') stopForUnauthorized(sessionId);
      else setPreJobError('request-failed');
    } finally {
      if (sessionId === sessionRef.current && generation === preJobGenerationRef.current) {
        preJobInFlightRef.current = false;
        if (mountedRef.current && !stoppedRef.current) setPreJobLoadingOlder(false);
        maybeStartExtensionRefresh();
      }
    }
  }, [companyId, stopForUnauthorized]);

  const refreshFailureDepth = useCallback(async () => {
    if (!mountedRef.current || stoppedRef.current || failureInFlightRef.current) {
      return { status: stoppedRef.current ? 'unauthorized' : 'stale' };
    }
    const sessionId = sessionRef.current;
    const generation = failureGenerationRef.current;
    const requestedDepth = Math.max(1, failureDepthRef.current);
    const pages = [];
    let beforeId = null;
    failureInFlightRef.current = true;
    try {
      for (let index = 0; index < requestedDepth; index += 1) {
        const input = { companyId, limit: 20 };
        if (beforeId !== null) input.beforeId = beforeId;
        const page = await listDryRunFailures(input);
        if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current
            || generation !== failureGenerationRef.current) return { status: 'stale' };
        pages.push(page);
        beforeId = page.nextBeforeId;
        if (beforeId === null) break;
      }
      const items = mergeFailuresDescending([], pages.flatMap(page => page.items));
      const lastPage = pages[pages.length - 1];
      failureDepthRef.current = pages.length;
      failureOlderLoadedRef.current = pages.length > 1;
      failureCursorRef.current = lastPage.nextBeforeId;
      setFailures(items);
      setFailureNextBeforeId(lastPage.nextBeforeId);
      setFailureLoading(false);
      setFailureError(null);
      return { status: 'success' };
    } catch (requestError) {
      if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current
          || generation !== failureGenerationRef.current) return { status: 'stale' };
      if (requestError?.kind === 'unauthorized') {
        stopForUnauthorized(sessionId);
        return { status: 'unauthorized' };
      }
      setFailureError('request-failed');
      return { status: 'partial' };
    } finally {
      if (sessionId === sessionRef.current && generation === failureGenerationRef.current) {
        failureInFlightRef.current = false;
        maybeStartExtensionRefresh();
      }
    }
  }, [companyId, stopForUnauthorized]);

  const refreshPreJobDepth = useCallback(async () => {
    if (!mountedRef.current || stoppedRef.current || preJobInFlightRef.current) {
      return { status: stoppedRef.current ? 'unauthorized' : 'stale' };
    }
    const sessionId = sessionRef.current;
    const generation = preJobGenerationRef.current;
    const requestedDepth = Math.max(1, preJobDepthRef.current);
    const pages = [];
    let before = null;
    preJobInFlightRef.current = true;
    try {
      for (let index = 0; index < requestedDepth; index += 1) {
        const input = { companyId, limit: 20 };
        if (before !== null) input.before = before;
        const page = await listPreJobFailures(input);
        if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current
            || generation !== preJobGenerationRef.current) return { status: 'stale' };
        pages.push(page);
        before = page.nextBefore;
        if (before === null) break;
      }
      const items = mergePreJobFailuresDescending([], pages.flatMap(page => page.items));
      const lastPage = pages[pages.length - 1];
      preJobDepthRef.current = pages.length;
      preJobOlderLoadedRef.current = pages.length > 1;
      preJobCursorRef.current = lastPage.nextBefore;
      setPreJobFailures(items);
      setPreJobNextBefore(lastPage.nextBefore);
      setPreJobLoading(false);
      setPreJobError(null);
      return { status: 'success' };
    } catch (requestError) {
      if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current
          || generation !== preJobGenerationRef.current) return { status: 'stale' };
      if (requestError?.kind === 'unauthorized') {
        stopForUnauthorized(sessionId);
        return { status: 'unauthorized' };
      }
      setPreJobError('request-failed');
      return { status: 'partial' };
    } finally {
      if (sessionId === sessionRef.current && generation === preJobGenerationRef.current) {
        preJobInFlightRef.current = false;
        maybeStartExtensionRefresh();
      }
    }
  }, [companyId, stopForUnauthorized]);

  runExtensionRefreshRef.current = async generation => {
    const results = await Promise.all([
      refresh({ manual: true }),
      refreshFailureDepth(),
      refreshPreJobDepth(),
    ]);
    const statuses = results.map(result => result?.status || 'partial');
    if (statuses.includes('unauthorized')) return { status: 'unauthorized', generation };
    if (statuses.includes('partial')) return { status: 'partial', generation };
    if (statuses.every(status => status === 'stale')) return { status: 'stale', generation };
    return { status: 'success', generation };
  };

  useEffect(() => {
    mountedRef.current = true;
    sessionRef.current += 1;
    failureGenerationRef.current += 1;
    preJobGenerationRef.current += 1;
    stoppedRef.current = false;
    suppressAutoSelectRef.current = false;
    selectedRef.current = null;
    detailIdentityRef.current = null;
    podCurlEligibleRef.current = false;
    podCurlActionRef.current += 1;
    podCurlInFlightRef.current = false;
    selectionGenerationRef.current += 1;
    refreshInFlightRef.current = false;
    detailInFlightRef.current = false;
    detailRequestRef.current += 1;
    failureInFlightRef.current = false;
    failureCursorRef.current = null;
    failureOlderLoadedRef.current = false;
    failureDepthRef.current = 1;
    preJobInFlightRef.current = false;
    preJobCursorRef.current = null;
    preJobOlderLoadedRef.current = false;
    preJobDepthRef.current = 1;
    extensionRefreshRef.current = { active: null, queued: null };
    setJobs([]);
    setSelectedJobId(null);
    setDetail(null);
    setLoading(true);
    setDetailLoading(false);
    setError(null);
    setMissingSelection(false);
    setFeedback(EMPTY_FEEDBACK);
    setCopyingPodCurl(false);
    setFailures([]);
    setFailureLoading(true);
    setFailureError(null);
    setFailureNextBeforeId(null);
    setFailureLoadingOlder(false);
    setPreJobFailures([]);
    setPreJobLoading(true);
    setPreJobError(null);
    setPreJobNextBefore(null);
    setPreJobLoadingOlder(false);
    setDisplayRouteKey(routeKey);
    refresh();
    refreshFailures();
    refreshPreJobFailures();
    const intervalId = window.setInterval(() => {
      refresh();
      refreshFailures();
      refreshPreJobFailures();
    }, POLL_INTERVAL_MS);
    pollTimerRef.current = intervalId;
    return () => {
      mountedRef.current = false;
      sessionRef.current += 1;
      failureGenerationRef.current += 1;
      preJobGenerationRef.current += 1;
      selectionGenerationRef.current += 1;
      detailRequestRef.current += 1;
      podCurlEligibleRef.current = false;
      podCurlActionRef.current += 1;
      podCurlInFlightRef.current = false;
      settleExtensionRequest(extensionRefreshRef.current.active, 'stale');
      settleExtensionRequest(extensionRefreshRef.current.queued, 'stale');
      extensionRefreshRef.current = { active: null, queued: null };
      window.clearInterval(intervalId);
      if (pollTimerRef.current === intervalId) pollTimerRef.current = null;
      objectUrlsRef.current.forEach((timerId, url) => {
        if (timerId !== null) window.clearTimeout(timerId);
        URL.revokeObjectURL(url);
      });
      objectUrlsRef.current.clear();
      blobCacheRef.current.clear();
    };
  }, [refresh, refreshFailures, refreshPreJobFailures, routeKey]);

  useEffect(() => {
    if (routeTerminal) {
      stopForUnauthorized(sessionRef.current, { notifyParent: false });
    }
  }, [routeTerminal, stopForUnauthorized]);

  useEffect(() => {
    const onVisibilityChange = () => setVisibility(document.visibilityState);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useImperativeHandle(refreshRef, () => ({
    refreshAll: requestExtensionRefresh,
  }), [routeKey]);

  const selectJob = useCallback(jobId => {
    suppressAutoSelectRef.current = false;
    cancelPodCurlAction();
    selectionGenerationRef.current += 1;
    selectedRef.current = jobId;
    detailIdentityRef.current = null;
    podCurlEligibleRef.current = false;
    setSelectedJobId(jobId);
    setDetail(null);
    setMissingSelection(false);
    setError(null);
    setFeedback(EMPTY_FEEDBACK);
    loadDetail(jobId, { replacePending: true });
  }, [cancelPodCurlAction, loadDetail]);

  const download = useCallback(async () => {
    if (!detail) return;
    const jobId = detail.job.jobId;
    const requestHash = detail.steps.payloadPreparation.requestHash;
    const identity = `${jobId}:${requestHash}`;
    const sessionId = sessionRef.current;
    const selectionGeneration = selectionGenerationRef.current;
    const cacheKey = identity;
    let blobPromise = blobCacheRef.current.get(cacheKey);
    if (!blobPromise) {
      blobPromise = getDryRunRequestBlob({ companyId, jobId });
      blobCacheRef.current.set(cacheKey, blobPromise);
    }
    try {
      const blob = await blobPromise;
      if (!mountedRef.current || stoppedRef.current || sessionId !== sessionRef.current
          || selectionGeneration !== selectionGenerationRef.current
          || identity !== detailIdentityRef.current) return;
      const url = URL.createObjectURL(blob);
      objectUrlsRef.current.set(url, null);
      const link = document.createElement('a');
      link.href = url;
      link.download = detail.steps.oeisSubmission.bodyFileName;
      try {
        link.click();
      } catch (clickError) {
        revokeObjectUrl(url);
        throw clickError;
      }
      const timerId = window.setTimeout(() => revokeObjectUrl(url), OBJECT_URL_LIFETIME_MS);
      objectUrlsRef.current.set(url, timerId);
      if (mountedRef.current && !stoppedRef.current && sessionId === sessionRef.current
          && selectionGeneration === selectionGenerationRef.current
          && identity === detailIdentityRef.current) announce('Diagnostic JSON downloaded');
    } catch (requestError) {
      blobCacheRef.current.delete(cacheKey);
      if (!mountedRef.current || sessionId !== sessionRef.current
          || selectionGeneration !== selectionGenerationRef.current
          || identity !== detailIdentityRef.current) return;
      if (requestError?.kind === 'unauthorized') stopForUnauthorized(sessionId);
      else if (!stoppedRef.current) announce('Diagnostic JSON could not be downloaded');
    }
  }, [announce, companyId, detail, revokeObjectUrl, stopForUnauthorized]);

  const copyPodCurl = useCallback(async () => {
    if (!detail || !canCopyPodCurl(detail) || podCurlInFlightRef.current
        || stoppedRef.current) return;
    const jobId = detail.job.jobId;
    const identity = detailIdentity(detail);
    if (selectedRef.current !== jobId || detailIdentityRef.current !== identity
        || !podCurlEligibleRef.current) return;
    const sessionId = sessionRef.current;
    const selectionGeneration = selectionGenerationRef.current;
    const actionId = podCurlActionRef.current + 1;
    podCurlActionRef.current = actionId;
    podCurlInFlightRef.current = true;
    setCopyingPodCurl(true);
    setFeedback(EMPTY_FEEDBACK);
    let envelope = null;
    let command = null;
    const isCurrent = () => mountedRef.current
      && !stoppedRef.current
      && sessionId === sessionRef.current
      && selectionGeneration === selectionGenerationRef.current
      && actionId === podCurlActionRef.current
      && selectedRef.current === jobId
      && detailIdentityRef.current === identity
      && podCurlEligibleRef.current;
    try {
      envelope = await getDryRunPodCurl({ companyId, jobId });
      if (!isCurrent()) return;
      command = buildPodCurl(envelope);
      let copied = false;
      let clipboard = null;
      let writeText = null;
      try {
        clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard;
        writeText = typeof clipboard?.writeText === 'function' ? clipboard.writeText : null;
      } catch {
        clipboard = null;
        writeText = null;
      }
      if (writeText) {
        try {
          await writeText.call(clipboard, command);
          copied = true;
        } catch {
          copied = false;
        }
      }
      if (!isCurrent()) return;
      announce(copied ? 'Pod cURL copied' : 'Pod cURL could not be copied');
    } catch (requestError) {
      if (!isCurrent()) return;
      if (requestError?.kind === 'unauthorized') stopForUnauthorized(sessionId);
      else if (requestError?.kind === 'not-found') clearMissingSelection();
      else announce('Pod cURL could not be copied');
    } finally {
      command = null;
      envelope = null;
      if (mountedRef.current && !stoppedRef.current
          && sessionId === sessionRef.current && actionId === podCurlActionRef.current) {
        podCurlInFlightRef.current = false;
        setCopyingPodCurl(false);
      }
    }
  }, [announce, clearMissingSelection, companyId, detail, stopForUnauthorized]);

  const routeMatchesDisplay = displayRouteKey === routeKey;
  const displayedError = routeMatchesDisplay ? error : null;
  const displayedJobs = routeMatchesDisplay ? jobs : [];
  const displayedFailures = routeMatchesDisplay ? failures : [];
  const displayedPreJobFailures = routeMatchesDisplay ? preJobFailures : [];
  const pollLabel = displayedError === 'unauthorized'
    ? 'Polling stopped · reauthenticate'
    : visibility === 'visible'
      ? 'Visible · polling 5s'
      : 'Hidden · polling paused';
  const pollClass = displayedError === 'unauthorized'
    ? 'dry-run-poll-status-stopped'
    : visibility === 'visible'
      ? 'dry-run-poll-status-active'
      : 'dry-run-poll-status-paused';

  return (
    <section className="dry-run-shell" aria-labelledby="dry-run-title">
      <header className="dry-run-titlebar">
        <div>
          <p className="dry-run-eyebrow">Invoice safety console</p>
          <h1 id="dry-run-title">Where the real shipment stopped</h1>
        </div>
        <div className="dry-run-titlebar-actions">
          {onRefreshAll && (
            <button
              type="button"
              className="dry-run-refresh-button"
              aria-label="Refresh all extension data"
              aria-busy={extensionRefreshing}
              disabled={extensionRefreshing || extensionRefreshDisabled}
              onClick={onRefreshAll}
            >
              {extensionRefreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
          <span className={`dry-run-poll-status ${pollClass}`}>
            <span className="dry-run-poll-dot" aria-hidden="true" />
            {pollLabel}
          </span>
        </div>
      </header>

      {onRefreshAll && (
        <p className="dry-run-refresh-live" role="status" aria-live="polite">
          {extensionRefreshMessage}
        </p>
      )}

      {displayedError === 'unauthorized' && (
        <div className="dry-run-state dry-run-state-error" role="alert">{errorCopy(displayedError)}</div>
      )}
      {displayedError === 'request-failed' && (
        <div className="dry-run-state dry-run-state-error" role="alert">{errorCopy(displayedError)}</div>
      )}
      {(!routeMatchesDisplay || loading) && (
        <div
          className="dry-run-state dry-run-loading-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <img
            className="dry-run-loading-status__image"
            src="/assets/language-switch-loader.webp"
            alt=""
            aria-hidden="true"
          />
          <span className="dry-run-loading-status__text">Loading held journeys…</span>
        </div>
      )}
      {routeMatchesDisplay && !loading && !displayedError && displayedJobs.length === 0 && (
        <div className="dry-run-state">
          <strong>No held invoice journeys</strong>
          <span>New held invoice journeys will appear after the Fynd lock completes.</span>
        </div>
      )}

      {routeMatchesDisplay && !loading && displayedError !== 'unauthorized' && displayedJobs.length > 0 && (
        <div className="dry-run-workspace">
          <HeldJobList jobs={displayedJobs} selectedJobId={selectedJobId} onSelect={selectJob} />
          <main className="dry-run-main">
            {missingSelection && (
              <div className="dry-run-state">Select another held journey to inspect.</div>
            )}
            {detailLoading && !detail && selectedJobId !== null && (
              <div
                className="dry-run-state dry-run-loading-status"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                <img
                  className="dry-run-loading-status__image"
                  src="/assets/language-switch-loader.webp"
                  alt=""
                  aria-hidden="true"
                />
                <span className="dry-run-loading-status__text">Loading journey evidence…</span>
              </div>
            )}
            {detail && (
              <JourneyDetail
                detail={detail}
                feedback={feedback}
                canCopyPodCurl={canCopyPodCurl(detail)}
                copyingPodCurl={copyingPodCurl}
                onDownload={download}
                onCopyPodCurl={copyPodCurl}
              />
            )}
          </main>
        </div>
      )}

      <FailedShipments
        failures={displayedFailures}
        loading={!routeMatchesDisplay || failureLoading}
        error={routeMatchesDisplay ? failureError : null}
        stopped={displayedError === 'unauthorized'}
        nextBeforeId={routeMatchesDisplay ? failureNextBeforeId : null}
        loadingOlder={routeMatchesDisplay && failureLoadingOlder}
        onLoadOlder={loadOlderFailures}
        preJobFailures={displayedPreJobFailures}
        preJobLoading={!routeMatchesDisplay || preJobLoading}
        preJobError={routeMatchesDisplay ? preJobError : null}
        preJobNextBefore={routeMatchesDisplay ? preJobNextBefore : null}
        preJobLoadingOlder={routeMatchesDisplay && preJobLoadingOlder}
        onLoadOlderPreJob={loadOlderPreJobFailures}
        reauthenticationAnnounced
      />
    </section>
  );
});
