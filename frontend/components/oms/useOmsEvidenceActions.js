import { useCallback, useEffect, useRef, useState } from 'react';

import { getDryRunPodCurl, getDryRunRequestBlob } from '../../services/dryRunApi';
import { buildPodCurl, canCopyPodCurl } from './omsModel';

const OBJECT_URL_LIFETIME_MS = 1000;
const EMPTY_FEEDBACK = Object.freeze({ message: '', count: 0 });

function errorKind(error) {
  if (!error || typeof error !== 'object') return 'request-failed';
  return ['unauthorized', 'not-found', 'request-failed'].includes(error.kind) ? error.kind : 'request-failed';
}

function canDownloadDiagnostic(row, journey) {
  return journey?.mode === 'dry-run'
    && row?.jobId === journey?.job?.jobId
    && typeof journey?.steps?.oeisSubmission?.bodyFileName === 'string'
    && journey.steps.oeisSubmission.bodyFileName.trim() !== '';
}

function actionIdentity(companyId, row, journey) {
  if (!companyId || !row || !journey) return null;
  return JSON.stringify({
    companyId: String(companyId),
    rowKey: row.key,
    jobId: journey.job?.jobId ?? null,
    requestHash: journey.steps?.payloadPreparation?.requestHash ?? null,
    bodyFileName: journey.steps?.oeisSubmission?.bodyFileName ?? null,
    downloadEligible: canDownloadDiagnostic(row, journey),
    podCurlEligible: canCopyPodCurl(journey),
  });
}

export function useOmsEvidenceActions({
  companyId, row, journey, detailBusy, sessionActive, isSessionActive, onUnauthorized, onJourneyMissing,
}) {
  const identity = actionIdentity(companyId, row, journey);
  const identityRef = useRef(identity);
  const detailBusyRef = useRef(detailBusy);
  const sessionActiveRef = useRef(sessionActive);
  const mountedRef = useRef(false);
  const downloadActionRef = useRef(0);
  const copyActionRef = useRef(0);
  const downloadInFlightRef = useRef(false);
  const copyInFlightRef = useRef(false);
  const objectUrlsRef = useRef(new Map());
  const [downloading, setDownloading] = useState(false);
  const [copyingPodCurl, setCopyingPodCurl] = useState(false);
  const [feedback, setFeedback] = useState(EMPTY_FEEDBACK);

  if (identityRef.current !== identity) {
    identityRef.current = identity;
    downloadActionRef.current += 1;
    copyActionRef.current += 1;
    downloadInFlightRef.current = false;
    copyInFlightRef.current = false;
  }
  detailBusyRef.current = detailBusy;
  sessionActiveRef.current = sessionActive;

  const announce = useCallback(message => {
    setFeedback(current => ({ message, count: current.message === message ? current.count + 1 : 1 }));
  }, []);

  const revokeObjectUrl = useCallback(url => {
    if (!objectUrlsRef.current.has(url)) return;
    const timer = objectUrlsRef.current.get(url);
    if (timer !== null) window.clearTimeout(timer);
    objectUrlsRef.current.delete(url);
    URL.revokeObjectURL(url);
  }, []);

  const clearObjectUrls = useCallback(() => {
    objectUrlsRef.current.forEach((timer, url) => {
      if (timer !== null) window.clearTimeout(timer);
      URL.revokeObjectURL(url);
    });
    objectUrlsRef.current.clear();
  }, []);

  const invalidate = useCallback(() => {
    downloadActionRef.current += 1;
    copyActionRef.current += 1;
    downloadInFlightRef.current = false;
    copyInFlightRef.current = false;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidate();
      clearObjectUrls();
    };
  }, [clearObjectUrls, invalidate]);

  useEffect(() => {
    setDownloading(false);
    setCopyingPodCurl(false);
    setFeedback(EMPTY_FEEDBACK);
  }, [identity]);

  useEffect(() => {
    if (sessionActive) return;
    invalidate();
    clearObjectUrls();
    setDownloading(false);
    setCopyingPodCurl(false);
    setFeedback(EMPTY_FEEDBACK);
  }, [clearObjectUrls, invalidate, sessionActive]);

  const canDownload = canDownloadDiagnostic(row, journey);
  const canCopy = row?.jobId === journey?.job?.jobId && canCopyPodCurl(journey);

  const downloadDiagnostic = useCallback(async () => {
    if (!canDownload || detailBusyRef.current || !sessionActiveRef.current || !isSessionActive()
      || downloadInFlightRef.current || copyInFlightRef.current || !identity) return;
    const capturedIdentity = identity;
    const jobId = journey.job.jobId;
    const filename = journey.steps.oeisSubmission.bodyFileName;
    const actionId = downloadActionRef.current + 1;
    downloadActionRef.current = actionId;
    downloadInFlightRef.current = true;
    setDownloading(true);
    setFeedback(EMPTY_FEEDBACK);
    let createdUrl = null;
    const isCurrent = () => mountedRef.current && sessionActiveRef.current && isSessionActive()
      && !detailBusyRef.current && identityRef.current === capturedIdentity
      && downloadActionRef.current === actionId;
    try {
      const blob = await getDryRunRequestBlob({ companyId, jobId });
      if (!isCurrent()) return;
      createdUrl = URL.createObjectURL(blob);
      objectUrlsRef.current.set(createdUrl, null);
      const link = document.createElement('a');
      link.href = createdUrl;
      link.download = filename;
      try {
        link.click();
      } catch (error) {
        revokeObjectUrl(createdUrl);
        createdUrl = null;
        throw error;
      }
      if (!isCurrent()) {
        revokeObjectUrl(createdUrl);
        createdUrl = null;
        return;
      }
      const urlForCleanup = createdUrl;
      const timer = window.setTimeout(() => revokeObjectUrl(urlForCleanup), OBJECT_URL_LIFETIME_MS);
      objectUrlsRef.current.set(createdUrl, timer);
      createdUrl = null;
      if (isCurrent()) announce('Diagnostic JSON downloaded');
    } catch (error) {
      if (createdUrl !== null) revokeObjectUrl(createdUrl);
      if (!isCurrent()) return;
      if (errorKind(error) === 'unauthorized') {
        invalidate();
        clearObjectUrls();
        onUnauthorized();
      } else announce('Diagnostic JSON could not be downloaded');
    } finally {
      if (downloadActionRef.current === actionId) {
        downloadInFlightRef.current = false;
        setDownloading(false);
      }
    }
  }, [announce, canDownload, clearObjectUrls, companyId, identity, invalidate, isSessionActive, journey, onUnauthorized, revokeObjectUrl]);

  const copyPodCurl = useCallback(async () => {
    if (!canCopy || detailBusyRef.current || !sessionActiveRef.current || !isSessionActive()
      || copyInFlightRef.current || downloadInFlightRef.current || !identity) return;
    const capturedIdentity = identity;
    const jobId = journey.job.jobId;
    const actionId = copyActionRef.current + 1;
    copyActionRef.current = actionId;
    copyInFlightRef.current = true;
    setCopyingPodCurl(true);
    setFeedback(EMPTY_FEEDBACK);
    const isCurrent = () => mountedRef.current && sessionActiveRef.current && isSessionActive()
      && !detailBusyRef.current && identityRef.current === capturedIdentity
      && copyActionRef.current === actionId;
    let envelope = null;
    let command = null;
    try {
      envelope = await getDryRunPodCurl({ companyId, jobId });
      if (!isCurrent()) return;
      command = buildPodCurl(envelope);
      let clipboard = null;
      let writeText = null;
      try {
        clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard;
        writeText = typeof clipboard?.writeText === 'function' ? clipboard.writeText : null;
      } catch {
        clipboard = null;
      }
      let copied = false;
      if (writeText && isCurrent()) {
        try {
          await writeText.call(clipboard, command);
          copied = true;
        } catch {
          copied = false;
        }
      }
      if (isCurrent()) announce(copied ? 'Pod cURL copied' : 'Pod cURL could not be copied');
    } catch (error) {
      if (!isCurrent()) return;
      const kind = errorKind(error);
      if (kind === 'unauthorized') {
        invalidate();
        clearObjectUrls();
        onUnauthorized();
      } else if (kind === 'not-found') {
        invalidate();
        onJourneyMissing();
      }
      else announce('Pod cURL could not be copied');
    } finally {
      command = null;
      envelope = null;
      if (copyActionRef.current === actionId) {
        copyInFlightRef.current = false;
        setCopyingPodCurl(false);
      }
    }
  }, [announce, canCopy, clearObjectUrls, companyId, identity, invalidate, isSessionActive, journey, onJourneyMissing, onUnauthorized]);

  return {
    canDownload, canCopy, detailBusy, downloading, copyingPodCurl, feedback,
    downloadDiagnostic, copyPodCurl,
  };
}
