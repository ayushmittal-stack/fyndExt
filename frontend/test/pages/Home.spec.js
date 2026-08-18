import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

import { Home } from '../../pages/Home';
import {
  getDryRunJourney,
  getDryRunRequestBlob,
  listDryRunFailures,
  listDryRuns,
} from '../../services/dryRunApi';
import {
  getShipmentTimeline,
  listPreJobFailures,
  listShipmentActivity,
} from '../../services/shipmentActivityApi';

jest.mock('../../services/dryRunApi', () => ({
  listDryRuns: jest.fn(),
  listDryRunFailures: jest.fn(),
  getDryRunJourney: jest.fn(),
  getDryRunRequestBlob: jest.fn(),
}));

jest.mock('../../services/shipmentActivityApi', () => ({
  listShipmentActivity: jest.fn(),
  listPreJobFailures: jest.fn(),
  getShipmentTimeline: jest.fn(),
}));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const activityHead = (shipmentId, documentNumber = `VR-${shipmentId}`) => ({
  shipmentId,
  jobId: 51,
  documentNumber,
  lastStage: 'WEBHOOK',
  lastAction: 'WEBHOOK_ACCEPTED',
  lastOutcome: 'SUCCESS',
  lastSafeCode: null,
  firstOccurredAt: '2026-08-17T14:10:00.000Z',
  lastOccurredAt: '2026-08-17T14:10:00.000Z',
  version: 1,
});

const activityEvent = (documentNumber) => ({
  jobId: 51,
  documentNumber,
  stage: 'WEBHOOK',
  action: 'WEBHOOK_ACCEPTED',
  outcome: 'SUCCESS',
  attemptNumber: 0,
  startedAt: '2026-08-17T14:10:00.000Z',
  completedAt: '2026-08-17T14:10:00.010Z',
  durationMs: 10,
  queueDelayMs: null,
  retryDelayMs: null,
  nextAttemptAt: null,
  safeCode: null,
  requestSummary: null,
  responseSummary: null,
  artifactJobId: null,
  occurredAt: '2026-08-17T14:10:00.000Z',
});

const heldJob = {
  jobId: 42,
  shipmentId: 'held-shipment-42',
  documentNumber: 'VR-HELD-42',
  state: 'SUBMISSION_HELD',
  lockedAt: '2026-08-17T14:10:00.000Z',
  createdAt: '2026-08-17T14:09:00.000Z',
  updatedAt: '2026-08-17T14:10:00.000Z',
  version: 1,
};

function Navigation() {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate('/company/99887/')}>Change company</button>
      <button
        type="button"
        onClick={() => navigate('/company/12655/application/app-2')}
      >
        Change application
      </button>
      <button
        type="button"
        onClick={() => navigate('/company/12655/application/platform')}
      >
        Change to platform-named application
      </button>
      <button type="button" onClick={() => navigate('/company/12655/')}>
        Change to platform route
      </button>
    </>
  );
}

function renderPath(path) {
  return render(
    <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Navigation />
      <Routes>
        <Route path="/company/:company_id/" element={<Home />} />
        <Route path="/company/:company_id/application/:application_id" element={<Home />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Home routes', () => {
  let mock;

  beforeEach(() => {
    jest.resetAllMocks();
    mock = new MockAdapter(axios);
    listDryRuns.mockResolvedValue({ items: [], nextBeforeId: null });
    listDryRunFailures.mockResolvedValue({ items: [], nextBeforeId: null });
    listPreJobFailures.mockResolvedValue({ items: [], nextBefore: null });
    getDryRunJourney.mockResolvedValue(null);
    listShipmentActivity.mockResolvedValue({ items: [], nextBefore: null });
    getShipmentTimeline.mockImplementation(({ shipmentId }) => Promise.resolve({
      shipmentId,
      items: [],
      nextBefore: null,
    }));
  });

  afterEach(() => {
    mock.restore();
    jest.useRealTimers();
  });

  test('renders only the two operational panels without unrelated API requests', async () => {
    renderPath('/company/12655/');

    expect(screen.getByRole('heading', { name: 'Where the real shipment stopped' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Shipment activity log' })).toBeInTheDocument();
    expect(await screen.findByText('No held invoice journeys')).toBeInTheDocument();
    expect(await screen.findByText('No shipment activity recorded')).toBeInTheDocument();
    expect(listDryRunFailures).toHaveBeenCalledWith({ companyId: '12655', limit: 20 });
    expect(mock.history.get).toHaveLength(0);
  });

  test('places the Mongo activity ledger after the dry-run journey', async () => {
    renderPath('/company/12655/');

    const dryRunHeading = screen.getByRole('heading', { name: 'Where the real shipment stopped' });
    const activityHeading = screen.getByRole('heading', { name: 'Shipment activity log' });
    expect(dryRunHeading.compareDocumentPosition(activityHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByText('No shipment activity recorded')).toBeInTheDocument();
    expect(listShipmentActivity).toHaveBeenCalledWith({ companyId: '12655', limit: 20, before: null });
    expect(mock.history.get).toHaveLength(0);
  });

  test('supplies the application company to both operational panels without unrelated requests', async () => {
    renderPath('/company/12655/application/app-1');

    expect(await screen.findByText('No held invoice journeys')).toBeInTheDocument();
    expect(await screen.findByText('No shipment activity recorded')).toBeInTheDocument();
    expect(listDryRuns).toHaveBeenCalledWith({ companyId: '12655', limit: 20 });
    expect(listDryRunFailures).toHaveBeenCalledWith({ companyId: '12655', limit: 20 });
    expect(listShipmentActivity).toHaveBeenCalledWith({ companyId: '12655', limit: 20, before: null });
    expect(mock.history.get).toHaveLength(0);
  });

  test('remounts and synchronously clears activity when only the application route changes', async () => {
    const oldTimeline = deferred();
    listShipmentActivity
      .mockResolvedValueOnce({ items: [activityHead('shipment-a', 'ACTIVITY-A')], nextBefore: null })
      .mockResolvedValueOnce({ items: [activityHead('shipment-b', 'ACTIVITY-B')], nextBefore: null });
    getShipmentTimeline.mockImplementation(({ shipmentId }) => {
      if (shipmentId === 'shipment-a') return oldTimeline.promise;
      return Promise.resolve({ shipmentId, items: [activityEvent('ACTIVITY-B')], nextBefore: null });
    });
    renderPath('/company/12655/application/app-1');
    expect(await screen.findByRole('button', { name: /shipment-a/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Change application' }));
    expect(screen.queryByRole('button', { name: /shipment-a/i })).not.toBeInTheDocument();
    expect((await screen.findAllByText('ACTIVITY-B')).length).toBeGreaterThan(0);
    expect(listShipmentActivity).toHaveBeenCalledTimes(2);

    oldTimeline.reject(Object.assign(new Error('private route A error'), { kind: 'unauthorized' }));
    await act(async () => Promise.resolve());
    expect(screen.getAllByText('ACTIVITY-B').length).toBeGreaterThan(0);
    expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
  });

  test('remounts the journey when only the application route changes', async () => {
    const failure = (jobId, application) => ({
      jobId,
      shipmentId: `${application}-shipment`,
      documentNumber: `VR-${application.toUpperCase()}`,
      state: 'DATA_FAILED',
      failureCode: 'LOCAL_VALIDATION_FAILED',
      failureMessage: 'Invoice data failed local validation.',
      attemptCount: 1,
      lockRecordedAt: null,
      createdAt: '2026-08-13T09:00:00.000Z',
      failedAt: '2026-08-13T10:00:00.000Z',
      version: 1,
    });
    listDryRunFailures
      .mockResolvedValueOnce({ items: [failure(81, 'app-1')], nextBeforeId: null })
      .mockResolvedValueOnce({ items: [failure(91, 'app-2')], nextBeforeId: null });
    renderPath('/company/12655/application/app-1');
    expect(await screen.findByText('VR-APP-1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Change application' }));
    expect(screen.queryByText('VR-APP-1')).not.toBeInTheDocument();
    expect(await screen.findByText('VR-APP-2')).toBeInTheDocument();
    expect(listDryRunFailures).toHaveBeenCalledTimes(2);
  });

  test('isolates the platform route from an application literally named platform', async () => {
    jest.useFakeTimers();
    const oldPlatformPoll = deferred();
    const failure = (jobId, documentNumber) => ({
      jobId,
      shipmentId: `failed-shipment-${jobId}`,
      documentNumber,
      state: 'DATA_FAILED',
      failureCode: 'LOCAL_VALIDATION_FAILED',
      failureMessage: 'Invoice data failed local validation.',
      attemptCount: 1,
      lockRecordedAt: null,
      createdAt: '2026-08-13T09:00:00.000Z',
      failedAt: '2026-08-13T10:00:00.000Z',
      version: 1,
    });
    listDryRunFailures
      .mockResolvedValueOnce({ items: [failure(81, 'VR-PLATFORM-ROUTE')], nextBeforeId: null })
      .mockReturnValueOnce(oldPlatformPoll.promise)
      .mockResolvedValueOnce({ items: [failure(91, 'VR-PLATFORM-APPLICATION')], nextBeforeId: null });
    renderPath('/company/12655/');
    expect(await screen.findByText('VR-PLATFORM-ROUTE')).toBeInTheDocument();
    await act(async () => jest.advanceTimersByTime(5000));

    fireEvent.click(screen.getByRole('button', { name: 'Change to platform-named application' }));
    expect(screen.queryByText('VR-PLATFORM-ROUTE')).not.toBeInTheDocument();
    expect(await screen.findByText('VR-PLATFORM-APPLICATION')).toBeInTheDocument();
    expect(listDryRunFailures).toHaveBeenCalledTimes(3);

    oldPlatformPoll.resolve({ items: [failure(82, 'VR-STALE-PLATFORM-ROUTE')], nextBeforeId: null });
    await act(async () => Promise.resolve());
    expect(screen.getByText('VR-PLATFORM-APPLICATION')).toBeInTheDocument();
    expect(screen.queryByText('VR-STALE-PLATFORM-ROUTE')).not.toBeInTheDocument();
  });

  test('one native refresh click fans out once across exactly the two operational panels', async () => {
    listDryRuns.mockResolvedValue({ items: [heldJob], nextBeforeId: null });
    listShipmentActivity.mockResolvedValue({
      items: [activityHead('refresh-shipment', 'REFRESH-ACTIVITY')],
      nextBefore: null,
    });
    getShipmentTimeline.mockResolvedValue({
      shipmentId: 'refresh-shipment',
      items: [activityEvent('REFRESH-ACTIVITY')],
      nextBefore: null,
    });
    renderPath('/company/12655/');
    await waitFor(() => expect(getDryRunJourney).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText('REFRESH-ACTIVITY')).length).toBeGreaterThan(0);

    listDryRuns.mockClear();
    listDryRunFailures.mockClear();
    listPreJobFailures.mockClear();
    getDryRunJourney.mockClear();
    listShipmentActivity.mockClear();
    getShipmentTimeline.mockClear();
    getDryRunRequestBlob.mockClear();
    mock.resetHistory();

    const button = screen.getByRole('button', { name: 'Refresh all extension data' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    fireEvent.click(button);

    expect(await screen.findByText('All extension data refreshed.')).toBeInTheDocument();
    expect(mock.history.get).toHaveLength(0);
    expect(listDryRuns).toHaveBeenCalledTimes(1);
    expect(getDryRunJourney).toHaveBeenCalledTimes(1);
    expect(listDryRunFailures).toHaveBeenCalledTimes(1);
    expect(listPreJobFailures).toHaveBeenCalledTimes(1);
    expect(listShipmentActivity).toHaveBeenCalledTimes(1);
    expect(getShipmentTimeline).toHaveBeenCalledTimes(1);
    expect(getDryRunRequestBlob).not.toHaveBeenCalled();
  });

  test('the slowest settlement controls busy state and rapid double click never overlaps or reloads', async () => {
    const slowActivity = deferred();
    renderPath('/company/12655/');
    await screen.findByText('No held invoice journeys');
    await screen.findByText('No shipment activity recorded');

    listDryRuns.mockClear();
    listDryRunFailures.mockClear();
    listPreJobFailures.mockClear();
    listShipmentActivity.mockReset();
    listShipmentActivity.mockReturnValueOnce(slowActivity.promise);
    mock.resetHistory();
    const originalHref = window.location.href;
    const button = screen.getByRole('button', { name: 'Refresh all extension data' });

    fireEvent.click(button);
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveTextContent('Refreshing…');
    await waitFor(() => expect(listShipmentActivity).toHaveBeenCalledTimes(1));
    expect(listDryRuns).toHaveBeenCalledTimes(1);
    expect(listDryRunFailures).toHaveBeenCalledTimes(1);
    expect(listPreJobFailures).toHaveBeenCalledTimes(1);
    expect(mock.history.get).toHaveLength(0);
    expect(window.location.href).toBe(originalHref);
    expect(button).toBeDisabled();

    slowActivity.resolve({ items: [], nextBefore: null });
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveAttribute('aria-busy', 'false');
    expect(button).toHaveTextContent('Refresh');
    expect(screen.getByText('All extension data refreshed.')).toBeInTheDocument();
  });

  test('retains operational activity and reports partial completion after a transient refresh failure', async () => {
    listShipmentActivity.mockResolvedValue({
      items: [activityHead('kept-shipment', 'KEPT-ACTIVITY')],
      nextBefore: null,
    });
    getShipmentTimeline.mockResolvedValue({
      shipmentId: 'kept-shipment',
      items: [activityEvent('KEPT-ACTIVITY')],
      nextBefore: null,
    });
    renderPath('/company/12655/');
    expect(await screen.findByRole('button', { name: /kept-shipment/i })).toBeInTheDocument();
    listShipmentActivity.mockRejectedValueOnce(new Error('private upstream detail'));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh all extension data' }));

    expect(await screen.findByText(
      'Some extension data could not be refreshed. Existing data is still shown.',
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /kept-shipment/i })).toBeInTheDocument();
    expect(screen.queryByText(/private upstream detail/i)).not.toBeInTheDocument();
    expect(mock.history.get).toHaveLength(0);
  });

  test.each(['dry-run', 'activity'])(
    'a current-route %s 401 clears every protected region and stops sibling polling',
    async origin => {
      jest.useFakeTimers();
      listDryRuns.mockResolvedValue({ items: [heldJob], nextBeforeId: null });
      listShipmentActivity.mockResolvedValue({
        items: [activityHead('session-activity', 'SESSION-ACTIVITY')],
        nextBefore: null,
      });
      renderPath('/company/12655/');
      expect(await screen.findByText('VR-HELD-42')).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: /session-activity/i })).toBeInTheDocument();

      if (origin === 'dry-run') {
        listPreJobFailures.mockRejectedValueOnce({ kind: 'unauthorized' });
      } else {
        listShipmentActivity.mockRejectedValueOnce({ kind: 'unauthorized' });
      }
      const button = screen.getByRole('button', { name: 'Refresh all extension data' });
      fireEvent.click(button);

      expect(await screen.findByText('Polling stopped · reauthenticate')).toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByText('Mongo activity refresh stopped · reauthenticate')).toBeInTheDocument();
        expect(button).toBeDisabled();
        expect(button).toHaveAttribute('aria-busy', 'false');
        expect(screen.queryByText('VR-HELD-42')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /session-activity/i })).not.toBeInTheDocument();
      });

      const callsAtStop = {
        dryRuns: listDryRuns.mock.calls.length,
        jobFailures: listDryRunFailures.mock.calls.length,
        preJobFailures: listPreJobFailures.mock.calls.length,
        activity: listShipmentActivity.mock.calls.length,
      };
      await act(async () => {
        jest.advanceTimersByTime(10000);
        await Promise.resolve();
      });
      expect(listDryRuns).toHaveBeenCalledTimes(callsAtStop.dryRuns);
      expect(listDryRunFailures).toHaveBeenCalledTimes(callsAtStop.jobFailures);
      expect(listPreJobFailures).toHaveBeenCalledTimes(callsAtStop.preJobFailures);
      expect(listShipmentActivity).toHaveBeenCalledTimes(callsAtStop.activity);
      expect(mock.history.get).toHaveLength(0);
    },
  );

  test('a terminal operational 401 clears both panels and resets on a new route', async () => {
    listDryRuns.mockResolvedValue({ items: [heldJob], nextBeforeId: null });
    listShipmentActivity.mockResolvedValue({
      items: [activityHead('session-activity', 'SESSION-ACTIVITY')],
      nextBefore: null,
    });
    renderPath('/company/12655/');
    expect(await screen.findByText('VR-HELD-42')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /session-activity/i })).toBeInTheDocument();
    await waitFor(() => expect(listPreJobFailures).toHaveBeenCalledTimes(1));
    const originalHref = window.location.href;

    listPreJobFailures.mockRejectedValueOnce({ kind: 'unauthorized' });
    const button = screen.getByRole('button', { name: 'Refresh all extension data' });
    fireEvent.click(button);
    await waitFor(() => {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-busy', 'false');
      expect(screen.queryByText('VR-HELD-42')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /session-activity/i })).not.toBeInTheDocument();
    });
    expect(screen.getByText('Polling stopped · reauthenticate')).toBeInTheDocument();
    expect(screen.getByText('Mongo activity refresh stopped · reauthenticate')).toBeInTheDocument();
    expect(window.location.href).toBe(originalHref);

    listDryRuns.mockResolvedValue({ items: [], nextBeforeId: null });
    listShipmentActivity.mockResolvedValue({ items: [], nextBefore: null });
    fireEvent.click(screen.getByRole('button', { name: 'Change company' }));
    expect(await screen.findByText('No held invoice journeys')).toBeInTheDocument();
    expect(await screen.findByText('No shipment activity recorded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh all extension data' })).toBeEnabled();
    expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
    expect(mock.history.get).toHaveLength(0);
  });

  test('a terminal 401 settles refresh immediately when a sibling request never settles', async () => {
    const unauthorizedActivity = deferred();
    const neverSettlingDryRun = new Promise(() => {});
    renderPath('/company/12655/');
    await screen.findByText('No held invoice journeys');
    await screen.findByText('No shipment activity recorded');
    await waitFor(() => expect(listPreJobFailures).toHaveBeenCalledTimes(1));

    listDryRuns.mockReturnValueOnce(neverSettlingDryRun);
    listShipmentActivity.mockReturnValueOnce(unauthorizedActivity.promise);
    const button = screen.getByRole('button', { name: 'Refresh all extension data' });

    fireEvent.click(button);
    await waitFor(() => expect(listShipmentActivity).toHaveBeenCalledTimes(2));
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    unauthorizedActivity.reject({ kind: 'unauthorized' });

    await waitFor(() => {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-busy', 'false');
      expect(button).toHaveTextContent('Refresh');
    });
    expect(screen.getByText('Polling stopped · reauthenticate')).toBeInTheDocument();
    expect(screen.getByText('Mongo activity refresh stopped · reauthenticate')).toBeInTheDocument();
    expect(mock.history.get).toHaveLength(0);
  });

  test('route change releases the new refresh control and isolates late prior-route settlement', async () => {
    const oldDryRun = deferred();
    let manualStarted = false;
    listDryRuns.mockImplementation(({ companyId }) => {
      if (companyId === '99887') return Promise.resolve({ items: [], nextBeforeId: null });
      if (manualStarted) return oldDryRun.promise;
      return Promise.resolve({ items: [], nextBeforeId: null });
    });
    renderPath('/company/12655/');
    expect(await screen.findByText('No held invoice journeys')).toBeInTheDocument();
    await screen.findByText('No shipment activity recorded');
    manualStarted = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh all extension data' }));
    expect(screen.getByRole('button', { name: 'Refresh all extension data' })).toBeDisabled();
    await waitFor(() => expect(listDryRuns).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: 'Change company' }));
    await waitFor(() => expect(listDryRuns).toHaveBeenCalledWith({ companyId: '99887', limit: 20 }));
    expect(await screen.findByText('No held invoice journeys')).toBeInTheDocument();
    const newRouteButton = screen.getByRole('button', { name: 'Refresh all extension data' });
    expect(newRouteButton).toBeEnabled();

    oldDryRun.reject({ kind: 'unauthorized' });
    await act(async () => Promise.resolve());
    expect(screen.queryByText(/session has expired/i)).not.toBeInTheDocument();
    expect(newRouteButton).toBeEnabled();
    expect(mock.history.get).toHaveLength(0);
  });
});
