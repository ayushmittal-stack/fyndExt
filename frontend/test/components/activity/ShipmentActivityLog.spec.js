import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import { ShipmentActivityLog } from '../../../components/activity/ShipmentActivityLog';
import {
  getShipmentTimeline,
  listShipmentActivity,
} from '../../../services/shipmentActivityApi';

jest.mock('../../../services/shipmentActivityApi', () => ({
  listShipmentActivity: jest.fn(),
  getShipmentTimeline: jest.fn(),
}));

const NOW = '2026-08-17T14:10:00.000Z';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function page(items = [], nextBefore = null) {
  return { items, nextBefore };
}

function head(shipmentId, overrides = {}) {
  return {
    shipmentId,
    jobId: 41,
    documentNumber: `VR-${shipmentId}`,
    lastStage: 'WEBHOOK',
    lastAction: 'WEBHOOK_ACCEPTED',
    lastOutcome: 'SUCCESS',
    lastSafeCode: null,
    firstOccurredAt: NOW,
    lastOccurredAt: NOW,
    version: 1,
    ...overrides,
  };
}

function event(action, outcome, overrides = {}) {
  return {
    jobId: 41,
    documentNumber: 'VR-178',
    stage: 'WEBHOOK',
    action,
    outcome,
    attemptNumber: 0,
    startedAt: NOW,
    completedAt: '2026-08-17T14:10:00.125Z',
    durationMs: 125,
    queueDelayMs: null,
    retryDelayMs: null,
    nextAttemptAt: null,
    safeCode: null,
    requestSummary: null,
    responseSummary: null,
    artifactJobId: null,
    occurredAt: NOW,
    ...overrides,
  };
}

function timeline(shipmentId, items = [], nextBefore = null) {
  return { shipmentId, items, nextBefore };
}

function fixedError(kind) {
  return Object.assign(new Error('private upstream message'), { kind });
}

function setVisibility(value) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

function renderLog(props = {}) {
  return render(
    <ShipmentActivityLog companyId="12655" routeKey="route-a" {...props} />,
  );
}

describe('ShipmentActivityLog', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    listShipmentActivity.mockResolvedValue(page());
    getShipmentTimeline.mockResolvedValue(timeline('shipment-178'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('renders the labelled read-only ledger and its initial and empty states', async () => {
    const pending = deferred();
    listShipmentActivity.mockReturnValue(pending.promise);
    renderLog();

    const region = screen.getByRole('region', { name: 'Shipment activity log' });
    expect(within(region).getByText('90-day Mongo evidence ledger')).toBeInTheDocument();
    expect(within(region).getByText('Trusted shipment steps, retained without raw customer or invoice bodies.')).toBeInTheDocument();
    expect(within(region).getByText('Mongo activity refresh · 5s')).toBeInTheDocument();
    const recentLoadingText = within(region).getByText('Loading recent shipment activity…');
    const recentLoading = recentLoadingText.closest('[role="status"]');
    expect(recentLoading).toHaveAttribute('aria-live', 'polite');
    expect(recentLoading).toHaveAttribute('aria-atomic', 'true');
    const recentLoadingImage = recentLoading.querySelector('img');
    expect(recentLoadingImage).toHaveAttribute('src', '/assets/language-switch-loader.webp');
    expect(recentLoadingImage).toHaveAttribute('alt', '');
    expect(recentLoadingImage).toHaveAttribute('aria-hidden', 'true');

    pending.resolve(page());
    expect(await screen.findByText('No shipment activity recorded')).toBeInTheDocument();
    expect(screen.getByText('New shipment processing events will appear after the extension receives them.')).toBeInTheDocument();
    expect(screen.queryByText('Loading recent shipment activity…')).not.toBeInTheDocument();
    expect(screen.queryByText('Chronological evidence · oldest to newest')).not.toBeInTheDocument();
    expect(getShipmentTimeline).not.toHaveBeenCalled();
  });

  test('does not restore the large recent loader while refreshing a settled empty ledger', async () => {
    jest.useFakeTimers();
    const backgroundRefresh = deferred();
    const manualRefresh = deferred();
    listShipmentActivity
      .mockResolvedValueOnce(page())
      .mockReturnValueOnce(backgroundRefresh.promise)
      .mockReturnValueOnce(manualRefresh.promise);
    const ref = React.createRef();
    render(<ShipmentActivityLog ref={ref} companyId="12655" routeKey="route-a" />);

    expect(await screen.findByText('No shipment activity recorded')).toBeInTheDocument();
    await act(async () => jest.advanceTimersByTime(5000));
    expect(listShipmentActivity).toHaveBeenCalledTimes(2);
    expect(screen.getByText('No shipment activity recorded')).toBeInTheDocument();
    expect(screen.queryByText('Loading recent shipment activity…')).not.toBeInTheDocument();

    await act(async () => backgroundRefresh.resolve(page()));
    let refreshPromise;
    act(() => {
      refreshPromise = ref.current.refreshAll(8);
    });
    await waitFor(() => expect(listShipmentActivity).toHaveBeenCalledTimes(3));
    expect(screen.getByText('No shipment activity recorded')).toBeInTheDocument();
    expect(screen.queryByText('Loading recent shipment activity…')).not.toBeInTheDocument();

    await act(async () => manualRefresh.resolve(page()));
    await expect(refreshPromise).resolves.toEqual({ status: 'success', generation: 8 });
  });

  test('auto-selects the first shipment and renders chronological evidence with literal labels', async () => {
    const items = [
      event('FYND_LOCK_CONFIRMED', 'SUCCESS', {
        stage: 'FYND_LOCK',
        attemptNumber: 1,
        occurredAt: '2026-08-17T14:10:00.000Z',
        safeCode: 'LOCK_CONFIRMED',
      }),
      event('VALIDATION_FAILED', 'FAILURE', {
        stage: 'VALIDATION',
        occurredAt: '2026-08-17T14:10:01.000Z',
        safeCode: 'LOCAL_VALIDATION_FAILED',
      }),
      event('OEIS_SUBMISSION_FAILED', 'TIMEOUT', {
        stage: 'OEIS_SUBMISSION',
        attemptNumber: 2,
        occurredAt: '2026-08-17T14:10:02.000Z',
        safeCode: 'OEIS_TIMEOUT',
      }),
      event('RETRY_SCHEDULED', 'RETRY_SCHEDULED', {
        stage: 'RETRY',
        occurredAt: '2026-08-17T14:10:03.000Z',
        retryDelayMs: 61500,
        nextAttemptAt: '2026-08-17T14:11:04.500Z',
        safeCode: 'RETRY_PENDING',
      }),
      event('OEIS_SUBMISSION_HELD', 'HELD', {
        stage: 'OEIS_SUBMISSION',
        occurredAt: '2026-08-17T14:10:04.000Z',
        safeCode: 'SHIPMENT_HELD',
      }),
      event('JOB_CLAIMED', 'SUCCESS', {
        stage: 'JOB',
        occurredAt: '2026-08-17T14:10:05.000Z',
        queueDelayMs: 925,
      }),
      event('JOB_INDETERMINATE', 'INDETERMINATE', {
        stage: 'JOB',
        occurredAt: '2026-08-17T14:10:06.000Z',
        safeCode: 'REMOTE_STATE_UNKNOWN',
      }),
      event('JOB_COMPLETED', 'SUCCESS', {
        stage: 'JOB',
        occurredAt: '2026-08-17T14:10:07.000Z',
        durationMs: 60125,
        completedAt: '2026-08-17T14:11:00.125Z',
      }),
    ];
    listShipmentActivity.mockResolvedValue(page([head('shipment-178')]));
    getShipmentTimeline.mockResolvedValue(timeline('shipment-178', items));
    renderLog();

    const selection = await screen.findByRole('button', { name: /shipment-178/i });
    expect(selection).toHaveAttribute('aria-pressed', 'true');
    expect(getShipmentTimeline).toHaveBeenCalledWith({
      companyId: '12655',
      shipmentId: 'shipment-178',
      limit: 50,
      before: null,
    });
    const ordered = await screen.findByRole('list', { name: 'Chronological evidence · oldest to newest' });
    const rows = within(ordered).getAllByRole('listitem');
    expect(rows).toHaveLength(8);
    expect(rows.map(row => row.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('Fynd invoice lock confirmed'),
      expect.stringContaining('Local validation failed'),
      expect.stringContaining('OEIS submission failed'),
      expect.stringContaining('Retry scheduled'),
      expect.stringContaining('OEIS submission held'),
      expect.stringContaining('Job claimed'),
      expect.stringContaining('Job indeterminate'),
      expect.stringContaining('Job completed'),
    ]));
    expect(within(ordered).getByText('Failure')).toBeInTheDocument();
    expect(within(ordered).getByText('Timeout')).toBeInTheDocument();
    expect(within(ordered).getByText('Held')).toBeInTheDocument();
    expect(within(ordered).getByText('Indeterminate')).toBeInTheDocument();
    expect(within(ordered).getByText('1 min 1.5 s')).toBeInTheDocument();
    expect(within(ordered).getByText('925 ms')).toBeInTheDocument();
    expect(within(ordered).getByText('1 min 0.13 s')).toBeInTheDocument();
    expect(within(ordered).getAllByText(/UTC/).length).toBeGreaterThanOrEqual(9);
    within(ordered).getAllByRole('time').forEach(node => expect(node).toHaveAttribute('dateTime'));
  });

  test('renders only fixed fields from all five safe summary families', async () => {
    const fyndRequest = {
      kind: 'FYND_REQUEST', operation: 'lock', shipmentId: 'shipment-178',
      documentNumber: 'VR-178', requestedLock: true, requestedStatus: null,
      buyerEmail: 'pii@example.test', rawBody: 'RAW-FYND-BODY',
    };
    const fyndResponse = {
      kind: 'FYND_RESPONSE', operation: 'lock', shipmentId: 'shipment-178',
      documentNumber: 'VR-178', responseStatus: 200, locked: true,
      shipmentState: 'LOCKED', finalStateClassification: 'LOCKED',
      retryable: false, latencyMs: 12, token: 'SECRET-TOKEN',
    };
    const oeisRequest = {
      kind: 'OEIS_REQUEST', documentNumber: 'VR-178', documentType: 'TAX_INVOICE',
      lineCount: 2, currency: 'SAR', netAmount: '100.00', taxAmount: '15.00',
      totalAmount: '115.00', taxSummaries: [{ category: 'S', rate: '15.00', reasonCode: null, lineCount: 2, customerName: 'PRIVATE' }],
      requestByteCount: 820, requestSha256: 'a'.repeat(64),
      endpointPath: '/API/V2/Transaction/UpdateInvoiceData', attemptNumber: 1,
      timeoutMs: 30000, signedXml: '<xml>PRIVATE</xml>',
    };
    const oeisResponse = {
      kind: 'OEIS_RESPONSE', httpStatus: 200, isSystemException: false,
      validationResult: 'VALID', reportingStatus: 'REPORTED', clearanceStatus: null,
      invoiceNumber: 'INV-178', transactionNumber: 'TX-178',
      uuid: '123e4567-e89b-12d3-a456-426614174000', invoiceCounter: 8,
      matchingKey: 'MATCH-178', validationCodes: ['BR-KSA-01', 'BR-KSA-02'],
      responseByteCount: 250, responseSha256: 'b'.repeat(64), retryable: false,
      latencyMs: 88, qrData: 'PRIVATE-QR',
    };
    const artifact = {
      kind: 'OEIS_ARTIFACT', signedXmlPresent: true, signedXmlByteCount: 2000,
      signedXmlSha256: 'c'.repeat(64), qrPresent: true, qrByteCount: 240,
      qrSha256: 'd'.repeat(64), decodedXml: 'PRIVATE-DECODED-XML',
    };
    const items = [
      event('FYND_LOCK_REQUESTED', 'STARTED', { stage: 'FYND_LOCK', completedAt: null, durationMs: null, requestSummary: fyndRequest }),
      event('FYND_LOCK_CONFIRMED', 'SUCCESS', { stage: 'FYND_LOCK', requestSummary: null, responseSummary: fyndResponse }),
      event('OEIS_SUBMISSION_REQUESTED', 'STARTED', { stage: 'OEIS_SUBMISSION', completedAt: null, durationMs: null, requestSummary: oeisRequest }),
      event('OEIS_RESPONSE_RECEIVED', 'SUCCESS', { stage: 'OEIS_SUBMISSION', requestSummary: null, responseSummary: oeisResponse }),
      event('OEIS_ARTIFACT_STORED', 'SUCCESS', { stage: 'OEIS_ARTIFACT', responseSummary: artifact, artifactJobId: 73 }),
      event('JOB_COMPLETED', 'SUCCESS', { stage: 'JOB', responseSummary: { kind: 'UNTRUSTED', password: 'DO-NOT-RENDER' } }),
    ];
    listShipmentActivity.mockResolvedValue(page([head('shipment-178')]));
    getShipmentTimeline.mockResolvedValue(timeline('shipment-178', items));
    renderLog();

    const chronology = await screen.findByRole('list', { name: 'Chronological evidence · oldest to newest' });
    expect(within(chronology).getAllByText('Fynd request').length).toBeGreaterThan(0);
    expect(within(chronology).getAllByText('Requested lock').length).toBeGreaterThan(0);
    expect(within(chronology).getAllByText('Yes').length).toBeGreaterThan(0);
    expect(within(chronology).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(chronology).getByText('OEIS request')).toBeInTheDocument();
    expect(within(chronology).getByText('Tax summaries')).toBeInTheDocument();
    expect(within(chronology).getByText('BR-KSA-01')).toBeInTheDocument();
    expect(oeisRequest.endpointPath).toBe('/API/V2/Transaction/UpdateInvoiceData');
    expect(within(chronology).queryByText('Endpoint path')).not.toBeInTheDocument();
    expect(chronology).not.toHaveTextContent('/API/V2/Transaction/UpdateInvoiceData');
    expect(within(chronology).getAllByText('OEIS artifact').length).toBeGreaterThan(0);
    expect(within(chronology).getByText('Safe summary unavailable')).toBeInTheDocument();
    [
      'pii@example.test', 'RAW-FYND-BODY', 'PRIVATE', 'SECRET-TOKEN',
      '<xml>PRIVATE</xml>', 'PRIVATE-QR', 'PRIVATE-DECODED-XML', 'DO-NOT-RENDER',
    ].forEach(secret => expect(screen.queryByText(secret)).not.toBeInTheDocument());
    expect(chronology.textContent).not.toContain('[object Object]');
  });

  test('clears old details immediately when selecting a different shipment and ignores the stale response', async () => {
    const second = deferred();
    listShipmentActivity.mockResolvedValue(page([head('shipment-a'), head('shipment-b')]));
    getShipmentTimeline.mockImplementation(({ shipmentId }) => {
      if (shipmentId === 'shipment-a') return Promise.resolve(timeline('shipment-a', [event('WEBHOOK_ACCEPTED', 'SUCCESS', { documentNumber: 'A-OLD' })]));
      return second.promise;
    });
    renderLog();
    expect(await screen.findByText('A-OLD')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /shipment-b/i }));
    expect(screen.queryByText('A-OLD')).not.toBeInTheDocument();
    const timelineLoadingText = screen.getByText('Loading shipment timeline…');
    const timelineLoading = timelineLoadingText.closest('[role="status"]');
    expect(timelineLoading).toHaveAttribute('aria-live', 'polite');
    expect(timelineLoading).toHaveAttribute('aria-atomic', 'true');
    const timelineLoadingImage = timelineLoading.querySelector('img');
    expect(timelineLoadingImage).toHaveAttribute('src', '/assets/language-switch-loader.webp');
    expect(timelineLoadingImage).toHaveAttribute('alt', '');
    expect(timelineLoadingImage).toHaveAttribute('aria-hidden', 'true');
    second.resolve(timeline('shipment-b', [event('JOB_COMPLETED', 'SUCCESS', { stage: 'JOB', documentNumber: 'B-NEW' })]));
    expect(await screen.findByText('B-NEW')).toBeInTheDocument();
    expect(screen.queryByText('A-OLD')).not.toBeInTheDocument();
  });

  test('does not restore the large timeline loader while polling settled empty evidence', async () => {
    jest.useFakeTimers();
    const backgroundTimeline = deferred();
    listShipmentActivity.mockResolvedValue(page([head('shipment-178')]));
    getShipmentTimeline
      .mockResolvedValueOnce(timeline('shipment-178'))
      .mockReturnValueOnce(backgroundTimeline.promise);
    renderLog();

    expect(await screen.findByRole('list', {
      name: 'Chronological evidence · oldest to newest',
    })).toBeInTheDocument();
    await act(async () => jest.advanceTimersByTime(5000));
    await waitFor(() => expect(getShipmentTimeline).toHaveBeenCalledTimes(2));

    expect(screen.getByRole('list', {
      name: 'Chronological evidence · oldest to newest',
    })).toBeInTheDocument();
    expect(screen.queryByText('Loading shipment timeline…')).not.toBeInTheDocument();

    await act(async () => backgroundTimeline.resolve(timeline('shipment-178')));
  });

  test('ignores a stale selection error, including 401, after a newer selection succeeds', async () => {
    const staleFirstSelection = deferred();
    listShipmentActivity.mockResolvedValue(page([head('shipment-a'), head('shipment-b')]));
    getShipmentTimeline.mockImplementation(({ shipmentId }) => {
      if (shipmentId === 'shipment-a') return staleFirstSelection.promise;
      return Promise.resolve(timeline('shipment-b', [
        event('JOB_COMPLETED', 'SUCCESS', { stage: 'JOB', documentNumber: 'CURRENT-B' }),
      ]));
    });
    renderLog();
    const secondButton = await screen.findByRole('button', { name: /shipment-b/i });

    fireEvent.click(secondButton);
    expect(await screen.findByText('CURRENT-B')).toBeInTheDocument();
    staleFirstSelection.reject(fixedError('unauthorized'));
    await act(async () => Promise.resolve());

    expect(screen.getByText('CURRENT-B')).toBeInTheDocument();
    expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
  });

  test('uses opaque cursors and preserves server order for both load-older controls', async () => {
    listShipmentActivity
      .mockResolvedValueOnce(page([head('shipment-new')], 'head_cursor'))
      .mockResolvedValueOnce(page([head('shipment-old')], null));
    getShipmentTimeline
      .mockResolvedValueOnce(timeline('shipment-new', [event('JOB_COMPLETED', 'SUCCESS', { stage: 'JOB', documentNumber: 'NEW-EVENT', occurredAt: '2026-08-17T14:11:00.000Z' })], 'timeline_cursor'))
      .mockResolvedValueOnce(timeline('shipment-new', [event('WEBHOOK_ACCEPTED', 'SUCCESS', { documentNumber: 'OLD-EVENT', occurredAt: '2026-08-17T14:09:00.000Z' })], null));
    renderLog();
    expect(await screen.findByText('NEW-EVENT')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load older shipments' }));
    expect(await screen.findByRole('button', { name: /shipment-old/i })).toBeInTheDocument();
    expect(listShipmentActivity).toHaveBeenLastCalledWith({ companyId: '12655', limit: 20, before: 'head_cursor' });

    fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
    expect(await screen.findByText('OLD-EVENT')).toBeInTheDocument();
    expect(getShipmentTimeline).toHaveBeenLastCalledWith({ companyId: '12655', shipmentId: 'shipment-new', limit: 50, before: 'timeline_cursor' });
    const rows = within(screen.getByRole('list', { name: 'Chronological evidence · oldest to newest' })).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('OLD-EVENT');
    expect(rows[1]).toHaveTextContent('NEW-EVENT');
  });

  test('retains rows and cursor after an older-page failure so the same request can be retried', async () => {
    listShipmentActivity.mockResolvedValue(page([head('shipment-178')]));
    getShipmentTimeline
      .mockResolvedValueOnce(timeline('shipment-178', [event('WEBHOOK_ACCEPTED', 'SUCCESS', { documentNumber: 'KEPT-EVENT' })], 'same_cursor'))
      .mockRejectedValueOnce(fixedError('request-failed'))
      .mockResolvedValueOnce(timeline('shipment-178', [event('JOB_CLAIMED', 'SUCCESS', { stage: 'JOB', documentNumber: 'OLDER-EVENT', queueDelayMs: 3 })], null));
    renderLog();
    expect(await screen.findByText('KEPT-EVENT')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
    expect(await screen.findByText('Older activity could not be loaded. The current evidence is unchanged.')).toBeInTheDocument();
    expect(screen.getByText('KEPT-EVENT')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
    expect(await screen.findByText('OLDER-EVENT')).toBeInTheDocument();
    expect(getShipmentTimeline.mock.calls.slice(-2).map(([input]) => input.before)).toEqual(['same_cursor', 'same_cursor']);
  });

  test.each(['unauthorized', 'request-failed'])(
    'ignores a stale load-older %s after a newer selection succeeds',
    async kind => {
      const staleOlderPage = deferred();
      listShipmentActivity
        .mockResolvedValueOnce(page([head('shipment-a'), head('shipment-b')], 'older_heads'))
        .mockResolvedValue(page([], null));
      getShipmentTimeline.mockImplementation(({ shipmentId, before }) => {
        if (shipmentId === 'shipment-a' && before === null) {
          return Promise.resolve(timeline('shipment-a', [event('WEBHOOK_ACCEPTED', 'SUCCESS', { documentNumber: 'A-BASE' })], 'older_a'));
        }
        if (shipmentId === 'shipment-a') return staleOlderPage.promise;
        return Promise.resolve(timeline(
          'shipment-b',
          [event('JOB_COMPLETED', 'SUCCESS', { stage: 'JOB', documentNumber: 'CURRENT-B' })],
          'older_b',
        ));
      });
      renderLog();
      expect(await screen.findByText('A-BASE')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
      fireEvent.click(screen.getByRole('button', { name: /shipment-b/i }));
      expect(await screen.findByText('CURRENT-B')).toBeInTheDocument();
      const callsBeforeBlockedClick = getShipmentTimeline.mock.calls.length;
      const listCallsBeforeBlockedClick = listShipmentActivity.mock.calls.length;
      expect(screen.getByRole('button', { name: 'Load older activity' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Load older shipments' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
      fireEvent.click(screen.getByRole('button', { name: 'Load older shipments' }));
      expect(getShipmentTimeline).toHaveBeenCalledTimes(callsBeforeBlockedClick);
      expect(listShipmentActivity).toHaveBeenCalledTimes(listCallsBeforeBlockedClick);

      staleOlderPage.reject(fixedError(kind));
      await act(async () => Promise.resolve());

      expect(screen.getByText('CURRENT-B')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Load older activity' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Load older shipments' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Load older shipments' }));
      await waitFor(() => expect(listShipmentActivity).toHaveBeenCalledTimes(
        listCallsBeforeBlockedClick + 1,
      ));
      await waitFor(() => expect(
        screen.getByRole('button', { name: 'Load older activity' }),
      ).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
      await waitFor(() => expect(getShipmentTimeline).toHaveBeenCalledTimes(
        callsBeforeBlockedClick + 1,
      ));
      expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
      expect(screen.queryByText('Older activity could not be loaded. The current evidence is unchanged.')).not.toBeInTheDocument();
    },
  );

  test('does not start requests while hidden and refreshes immediately when visible', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    renderLog();
    expect(screen.getByText('Mongo activity refresh paused · tab hidden')).toBeInTheDocument();
    expect(listShipmentActivity).not.toHaveBeenCalled();

    act(() => setVisibility('visible'));
    await waitFor(() => expect(listShipmentActivity).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Mongo activity refresh · 5s')).toBeInTheDocument();
  });

  test('refreshes immediately after visibility resumes during a pending manual request', async () => {
    jest.useFakeTimers();
    const olderPage = deferred();
    listShipmentActivity
      .mockResolvedValueOnce(page([head('shipment-178')], 'older_heads'))
      .mockReturnValueOnce(olderPage.promise)
      .mockResolvedValue(page([head('shipment-178')]));
    getShipmentTimeline.mockResolvedValue(
      timeline('shipment-178', [event('WEBHOOK_ACCEPTED', 'SUCCESS')]),
    );
    renderLog();
    await screen.findByRole('button', { name: /shipment-178/i });

    fireEvent.click(screen.getByRole('button', { name: 'Load older shipments' }));
    expect(listShipmentActivity).toHaveBeenCalledTimes(2);
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));

    await act(async () => {
      olderPage.resolve(page([head('shipment-177')]));
    });
    await act(async () => Promise.resolve());

    expect(listShipmentActivity).toHaveBeenCalledTimes(3);
    await act(async () => jest.advanceTimersByTime(4999));
    expect(listShipmentActivity).toHaveBeenCalledTimes(3);
    await act(async () => jest.advanceTimersByTime(1));
    expect(listShipmentActivity).toHaveBeenCalledTimes(4);
  });

  test('uses a post-settlement five-second self-schedule and never overlaps polling', async () => {
    jest.useFakeTimers();
    const first = deferred();
    listShipmentActivity.mockReturnValueOnce(first.promise).mockResolvedValue(page());
    renderLog();
    expect(listShipmentActivity).toHaveBeenCalledTimes(1);

    await act(async () => jest.advanceTimersByTime(10000));
    expect(listShipmentActivity).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(page()));
    await act(async () => jest.advanceTimersByTime(4999));
    expect(listShipmentActivity).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(1));
    expect(listShipmentActivity).toHaveBeenCalledTimes(2);
  });

  test('does not start a duplicate timeline leg when selection changes during a recent refresh', async () => {
    jest.useFakeTimers();
    const refreshedHeads = deferred();
    const selectedTimeline = deferred();
    listShipmentActivity
      .mockResolvedValueOnce(page([head('shipment-a'), head('shipment-b')]))
      .mockReturnValueOnce(refreshedHeads.promise)
      .mockResolvedValue(page([head('shipment-a'), head('shipment-b')]));
    getShipmentTimeline.mockImplementation(({ shipmentId }) => {
      if (shipmentId === 'shipment-a') {
        return Promise.resolve(timeline('shipment-a', [event('WEBHOOK_ACCEPTED', 'SUCCESS', { documentNumber: 'A-EVIDENCE' })]));
      }
      if (shipmentId === 'shipment-b' && getShipmentTimeline.mock.calls
        .filter(([input]) => input.shipmentId === 'shipment-b').length === 1) {
        return selectedTimeline.promise;
      }
      return Promise.resolve(timeline('shipment-b', [event('JOB_COMPLETED', 'SUCCESS', {
        stage: 'JOB',
        documentNumber: 'DUPLICATE-POLL-EVIDENCE',
      })]));
    });
    renderLog();
    expect(await screen.findByText('A-EVIDENCE')).toBeInTheDocument();

    await act(async () => jest.advanceTimersByTime(5000));
    expect(listShipmentActivity).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: /shipment-b/i }));
    expect(getShipmentTimeline.mock.calls
      .filter(([input]) => input.shipmentId === 'shipment-b')).toHaveLength(1);

    await act(async () => {
      refreshedHeads.resolve(page([head('shipment-a'), head('shipment-b')]));
    });
    await act(async () => Promise.resolve());

    expect(getShipmentTimeline.mock.calls
      .filter(([input]) => input.shipmentId === 'shipment-b')).toHaveLength(1);
    await act(async () => {
      selectedTimeline.resolve(timeline('shipment-b', [event('JOB_COMPLETED', 'SUCCESS', {
        stage: 'JOB',
        documentNumber: 'LATEST-B-EVIDENCE',
      })]));
    });
    expect(await screen.findByText('LATEST-B-EVIDENCE')).toBeInTheDocument();
    expect(screen.queryByText('DUPLICATE-POLL-EVIDENCE')).not.toBeInTheDocument();
  });

  test('refetches the accepted page depth sequentially on the next refresh', async () => {
    jest.useFakeTimers();
    listShipmentActivity
      .mockResolvedValueOnce(page([head('shipment-new')], 'h1'))
      .mockResolvedValueOnce(page([head('shipment-old')], null))
      .mockResolvedValueOnce(page([head('shipment-newer')], 'rh1'))
      .mockResolvedValueOnce(page([head('shipment-new')], null));
    getShipmentTimeline
      .mockResolvedValueOnce(timeline('shipment-new', [event('JOB_COMPLETED', 'SUCCESS', { stage: 'JOB' })]))
      .mockResolvedValueOnce(timeline('shipment-new', [event('JOB_COMPLETED', 'SUCCESS', { stage: 'JOB' })]));
    renderLog();
    await screen.findByRole('button', { name: /shipment-new/i });
    fireEvent.click(screen.getByRole('button', { name: 'Load older shipments' }));
    await screen.findByRole('button', { name: /shipment-old/i });

    await act(async () => jest.advanceTimersByTime(5000));
    await waitFor(() => expect(listShipmentActivity).toHaveBeenCalledTimes(4));
    expect(listShipmentActivity.mock.calls.slice(2).map(([input]) => input.before)).toEqual([null, 'rh1']);
  });

  test('queues an extension refresh behind pagination and preserves accepted head depth', async () => {
    const ref = React.createRef();
    const olderHeads = deferred();
    listShipmentActivity
      .mockResolvedValueOnce(page([head('shipment-new')], 'older_heads'))
      .mockReturnValueOnce(olderHeads.promise)
      .mockResolvedValueOnce(page([head('shipment-fresh')], 'fresh_older'))
      .mockResolvedValueOnce(page([head('shipment-old')], null));
    getShipmentTimeline.mockImplementation(({ shipmentId }) => Promise.resolve(timeline(
      shipmentId,
      [event('JOB_COMPLETED', 'SUCCESS', { stage: 'JOB', documentNumber: `EVENT-${shipmentId}` })],
    )));
    render(<ShipmentActivityLog ref={ref} companyId="12655" routeKey="route-a" />);
    await screen.findByText('EVENT-shipment-new');

    fireEvent.click(screen.getByRole('button', { name: 'Load older shipments' }));
    expect(listShipmentActivity).toHaveBeenCalledTimes(2);
    let refreshPromise;
    act(() => {
      refreshPromise = ref.current.refreshAll(7);
    });
    expect(listShipmentActivity).toHaveBeenCalledTimes(2);

    await act(async () => olderHeads.resolve(page([head('shipment-old')], null)));
    await waitFor(() => expect(listShipmentActivity).toHaveBeenCalledTimes(4));
    await expect(refreshPromise).resolves.toEqual({ status: 'success', generation: 7 });
    expect(listShipmentActivity.mock.calls.slice(2).map(([input]) => input.before))
      .toEqual([null, 'fresh_older']);
    expect(await screen.findByRole('button', { name: /shipment-fresh/i })).toBeInTheDocument();
  });

  test('retains the selected evidence when a background deeper-cursor page returns 404', async () => {
    jest.useFakeTimers();
    listShipmentActivity.mockResolvedValue(page([head('shipment-178')]));
    getShipmentTimeline
      .mockResolvedValueOnce(timeline('shipment-178', [event('JOB_COMPLETED', 'SUCCESS', { stage: 'JOB', documentNumber: 'NEW-PAGE' })], 'older_initial'))
      .mockResolvedValueOnce(timeline('shipment-178', [event('WEBHOOK_ACCEPTED', 'SUCCESS', { documentNumber: 'OLD-PAGE' })], null))
      .mockResolvedValueOnce(timeline('shipment-178', [event('JOB_COMPLETED', 'SUCCESS', { stage: 'JOB', documentNumber: 'FRESH-PAGE' })], 'older_rebased'))
      .mockRejectedValueOnce(fixedError('not-found'));
    renderLog();
    expect(await screen.findByText('NEW-PAGE')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load older activity' }));
    expect(await screen.findByText('OLD-PAGE')).toBeInTheDocument();

    await act(async () => jest.advanceTimersByTime(5000));

    expect(await screen.findByText('Older activity could not be loaded. The current evidence is unchanged.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /shipment-178/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('OLD-PAGE')).toBeInTheDocument();
    expect(screen.getByText('NEW-PAGE')).toBeInTheDocument();
    expect(screen.queryByText('FRESH-PAGE')).not.toBeInTheDocument();
  });

  test('retains verified evidence on a transient refresh failure', async () => {
    jest.useFakeTimers();
    listShipmentActivity
      .mockResolvedValueOnce(page([head('shipment-178')]))
      .mockRejectedValueOnce(fixedError('request-failed'));
    getShipmentTimeline.mockResolvedValue(timeline('shipment-178', [event('WEBHOOK_ACCEPTED', 'SUCCESS', { documentNumber: 'VERIFIED-EVENT' })]));
    renderLog();
    expect(await screen.findByText('VERIFIED-EVENT')).toBeInTheDocument();

    await act(async () => jest.advanceTimersByTime(5000));
    expect(await screen.findByText('Shipment activity could not be refreshed. Showing the last verified evidence.')).toBeInTheDocument();
    expect(screen.getByText('VERIFIED-EVENT')).toBeInTheDocument();
  });

  test('clears a missing selected timeline and suppresses automatic reselection until the operator selects', async () => {
    listShipmentActivity.mockResolvedValue(page([head('shipment-178')]));
    getShipmentTimeline.mockRejectedValueOnce(fixedError('not-found')).mockResolvedValueOnce(timeline('shipment-178', [event('WEBHOOK_ACCEPTED', 'SUCCESS')]));
    renderLog();
    expect(await screen.findByText('This shipment timeline is no longer available. Select another shipment.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /shipment-178/i })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Select a shipment to inspect its retained evidence.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /shipment-178/i }));
    expect(await screen.findByText('Chronological evidence · oldest to newest')).toBeInTheDocument();
    expect(getShipmentTimeline).toHaveBeenCalledTimes(2);
  });

  test('makes a current-route 401 terminal and ignores late success and visibility changes', async () => {
    jest.useFakeTimers();
    const staleTimeline = deferred();
    listShipmentActivity.mockResolvedValue(page([head('shipment-a'), head('shipment-b')]));
    getShipmentTimeline
      .mockReturnValueOnce(staleTimeline.promise)
      .mockRejectedValueOnce(fixedError('unauthorized'));
    renderLog();
    await waitFor(() => expect(getShipmentTimeline).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: /shipment-b/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has expired. Reauthenticate in Fynd to view shipment activity.');
    expect(screen.getByText('Mongo activity refresh stopped · reauthenticate')).toBeInTheDocument();
    staleTimeline.resolve(timeline('shipment-a', [event('WEBHOOK_ACCEPTED', 'SUCCESS', { documentNumber: 'LATE-PRIVATE' })]));
    await act(async () => Promise.resolve());
    expect(screen.queryByText('LATE-PRIVATE')).not.toBeInTheDocument();
    const callsAtStop = listShipmentActivity.mock.calls.length;
    act(() => setVisibility('hidden'));
    act(() => setVisibility('visible'));
    await act(async () => jest.advanceTimersByTime(10000));
    expect(listShipmentActivity).toHaveBeenCalledTimes(callsAtStop);
  });

  test('isolates route sessions, including stale success and stale 401', async () => {
    const routeA = deferred();
    listShipmentActivity
      .mockReturnValueOnce(routeA.promise)
      .mockResolvedValueOnce(page([head('shipment-b')]));
    getShipmentTimeline.mockResolvedValue(timeline('shipment-b', [event('JOB_COMPLETED', 'SUCCESS', { stage: 'JOB', documentNumber: 'ROUTE-B' })]));
    const view = renderLog();
    view.rerender(<ShipmentActivityLog companyId="99887" routeKey="route-b" />);
    expect(await screen.findByText('ROUTE-B')).toBeInTheDocument();

    routeA.reject(fixedError('unauthorized'));
    await act(async () => Promise.resolve());
    expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
    expect(screen.getByText('ROUTE-B')).toBeInTheDocument();
  });

  test('removes timers/listeners and ignores writes after unmount', async () => {
    jest.useFakeTimers();
    const pending = deferred();
    listShipmentActivity.mockReturnValue(pending.promise);
    const listenerSpy = jest.spyOn(document, 'removeEventListener');
    const view = renderLog();
    view.unmount();
    pending.resolve(page([head('unmounted-shipment')]));
    await act(async () => Promise.resolve());
    await act(async () => jest.advanceTimersByTime(10000));
    expect(listShipmentActivity).toHaveBeenCalledTimes(1);
    expect(listenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    listenerSpy.mockRestore();
  });

  test('exposes only native read-only interactions and polite or alert status semantics', async () => {
    listShipmentActivity.mockResolvedValue(page([head('shipment-178')], 'h1'));
    getShipmentTimeline.mockResolvedValue(timeline('shipment-178', [event('WEBHOOK_ACCEPTED', 'SUCCESS')], 't1'));
    const { container } = renderLog();
    await screen.findByText('Chronological evidence · oldest to newest');
    expect(screen.getByRole('list', { name: 'Recent shipments' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[download]')).toBeNull();
    const names = screen.getAllByRole('button').map(button => button.textContent.toLowerCase()).join(' ');
    expect(names).not.toMatch(/copy|download|retry now|submit|unlock|transition|open artifact/);
  });
});
