import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { FailedShipments } from '../../../components/dry-run/FailedShipments';

const FAILURE = Object.freeze({
  jobId: 51,
  shipmentId: 'shipment-51-with-a-very-long-safe-identifier',
  documentNumber: 'VR-shipment-51-1',
  state: 'DATA_FAILED',
  failureCode: 'LOCAL_VALIDATION_FAILED',
  failureMessage: 'Invoice data failed local validation.',
  attemptCount: 2,
  lockRecordedAt: null,
  createdAt: '2026-08-13T09:00:00.000Z',
  failedAt: '2026-08-13T10:00:00.000Z',
  version: 3,
});

const PRE_JOB_FAILURE = Object.freeze({
  shipmentId: 'shipment-currency-unsupported',
  jobId: null,
  documentNumber: null,
  lastStage: 'VALIDATION',
  lastAction: 'VALIDATION_FAILED',
  lastOutcome: 'FAILURE',
  lastSafeCode: 'CURRENCY_UNSUPPORTED',
  firstOccurredAt: '2026-08-13T08:00:00.000Z',
  lastOccurredAt: '2026-08-13T08:00:01.000Z',
  version: 1,
});

function renderLedger(overrides = {}) {
  return render(<FailedShipments
    failures={[]}
    loading={false}
    error={null}
    stopped={false}
    nextBeforeId={null}
    loadingOlder={false}
    onLoadOlder={jest.fn()}
    preJobFailures={[]}
    preJobLoading={false}
    preJobError={null}
    preJobNextBefore={null}
    preJobLoadingOlder={false}
    onLoadOlderPreJob={jest.fn()}
    {...overrides}
  />);
}

function expectScopedLoadingStatus() {
  const text = screen.getByText('Loading failed shipments…');
  const status = text.closest('[role="status"]');
  expect(status).not.toBeNull();
  expect(status).toHaveAttribute('aria-live', 'polite');
  expect(status).toHaveAttribute('aria-atomic', 'true');
  expect(status).not.toHaveClass('loader');
  const image = status.querySelector('img');
  expect(image).not.toBeNull();
  expect(image).toHaveAttribute('src', '/assets/language-switch-loader.webp');
  expect(image).toHaveAttribute('alt', '');
  expect(image).toHaveAttribute('aria-hidden', 'true');
}

describe('FailedShipments', () => {
  test('renders a semantic summary-only incident ledger with only safe failure fields', () => {
    const hostile = '<img src=x onerror="window.__failedInjected=true"><script>bad()</script>';
    const failure = {
      ...FAILURE,
      failureMessage: hostile,
      lockRecordedAt: '2026-08-13T09:59:00.000Z',
      buyerName: 'BUYER-NAME-SENTINEL',
      buyerNationalId: 'NATIONAL-ID-SENTINEL',
      rawError: 'RAW-ERROR-SENTINEL',
      snapshot: { private: 'SNAPSHOT-SENTINEL' },
      requestJson: 'REQUEST-JSON-SENTINEL',
    };
    const { container } = renderLedger({ failures: [failure] });

    const section = screen.getByRole('region', { name: 'Failed shipments' });
    expect(within(section).getByText('VR-shipment-51-1')).toBeInTheDocument();
    expect(within(section).getByText(/shipment-51-with-a-very-long-safe-identifier/)).toBeInTheDocument();
    expect(within(section).getByText('DATA_FAILED')).toBeInTheDocument();
    expect(within(section).getByText('LOCAL_VALIDATION_FAILED')).toBeInTheDocument();
    expect(within(section).getByText(hostile)).toBeInTheDocument();
    expect(within(section).getByText('2')).toBeInTheDocument();
    expect(within(section).getAllByRole('time').map(node => node.dateTime)).toEqual([
      '2026-08-13T09:00:00.000Z',
      '2026-08-13T10:00:00.000Z',
      '2026-08-13T09:59:00.000Z',
    ]);
    expect(section).toHaveTextContent('Lock recorded');
    expect(section.textContent).not.toMatch(/BUYER-NAME-SENTINEL|NATIONAL-ID-SENTINEL|RAW-ERROR-SENTINEL|SNAPSHOT-SENTINEL|REQUEST-JSON-SENTINEL/);
    expect(container.querySelectorAll('script, img, a, button, input, select, textarea')).toHaveLength(0);
  });

  test.each([
    [{}, 'No failed shipments recorded.'],
    [{ error: 'request-failed' }, 'Failed-shipment data could not be loaded.'],
    [{ stopped: true }, 'Your session has expired. Reauthenticate in Fynd to inspect held journeys.'],
  ])('renders the precise data state %#', (props, copy) => {
    renderLedger(props);
    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  test.each([
    { loading: true },
    { preJobLoading: true },
    { loading: true, preJobLoading: true },
  ])('shows an accessible scoped loader while empty shipment failure data loads %#', props => {
    renderLedger(props);
    expectScopedLoadingStatus();
  });

  test('retains loaded failure rows without replacing them with a loader during refresh', () => {
    renderLedger({ failures: [FAILURE], loading: true, preJobLoading: true });

    expect(screen.getByText(FAILURE.documentNumber)).toBeInTheDocument();
    expect(screen.queryByText('Loading failed shipments…')).not.toBeInTheDocument();
    expect(document.querySelector('.loader')).not.toBeInTheDocument();
  });

  test('retains rows with a polite fixed warning after a transient refresh failure', () => {
    renderLedger({ failures: [FAILURE], error: 'request-failed' });

    expect(screen.getByText(FAILURE.documentNumber)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed-shipment data could not be loaded.');
  });

  test('renders a shipment-style pre-job rejection with fixed safe copy and no invented job fields', () => {
    const hostile = {
      ...PRE_JOB_FAILURE,
      rawPayload: 'RAW-PAYLOAD-SENTINEL',
      buyerName: 'BUYER-NAME-SENTINEL',
    };
    const { container } = renderLedger({ preJobFailures: [hostile] });

    const section = screen.getByRole('region', { name: 'Failed shipments' });
    expect(within(section).getByRole('heading', { name: 'Rejected before a job was created' }))
      .toBeInTheDocument();
    expect(within(section).getByRole('heading', { name: 'Job failures' })).toBeInTheDocument();
    expect(within(section).getByText('shipment-currency-unsupported')).toBeInTheDocument();
    expect(within(section).getByText('REJECTED BEFORE JOB')).toBeInTheDocument();
    expect(within(section).getByText('CURRENCY_UNSUPPORTED')).toBeInTheDocument();
    expect(within(section).getByText('Shipment processing was rejected before a job was created.'))
      .toBeInTheDocument();
    expect(within(section).getAllByRole('time').map(node => node.dateTime)).toEqual([
      '2026-08-13T08:00:00.000Z',
      '2026-08-13T08:00:01.000Z',
    ]);
    expect(section).toHaveTextContent('Received');
    expect(section).toHaveTextContent('Rejected');
    expect(section).not.toHaveTextContent(/Attempts|Lock recorded|Document not assigned|Job ID/);
    expect(section.textContent).not.toMatch(/RAW-PAYLOAD-SENTINEL|BUYER-NAME-SENTINEL/);
    expect(container.querySelector('.failed-shipment-prejob')).toBeInTheDocument();
  });

  test('sorts each group newest-first, suppresses a pre-job duplicate, and labels the loaded count', () => {
    const olderJob = {
      ...FAILURE,
      jobId: 49,
      shipmentId: 'job-older',
      documentNumber: 'VR-JOB-OLDER',
      failedAt: '2026-08-13T07:00:00.000Z',
    };
    const duplicatePreJob = {
      ...PRE_JOB_FAILURE,
      shipmentId: FAILURE.shipmentId,
      lastOccurredAt: '2026-08-13T11:00:00.000Z',
    };
    const olderPreJob = {
      ...PRE_JOB_FAILURE,
      shipmentId: 'prejob-older',
      firstOccurredAt: '2026-08-13T06:00:00.000Z',
      lastOccurredAt: '2026-08-13T06:00:01.000Z',
    };
    const { container } = renderLedger({
      failures: [olderJob, FAILURE],
      preJobFailures: [olderPreJob, duplicatePreJob, PRE_JOB_FAILURE],
    });

    expect(screen.getByText('4 loaded failures')).toBeInTheDocument();
    expect(screen.queryAllByText(FAILURE.shipmentId)).toHaveLength(1);
    expect(
      [...container.querySelectorAll('.failed-shipments-prejob-list .failed-shipment-shipment')]
        .map(node => node.textContent),
    ).toEqual([
      'Shipment shipment-currency-unsupported',
      'Shipment prejob-older',
    ]);
    expect(
      [...container.querySelectorAll('.failed-shipments-job-list .failed-shipment-document')]
        .map(node => node.textContent),
    ).toEqual(['VR-shipment-51-1', 'VR-JOB-OLDER']);
  });

  test('exposes independent pagination controls and busy states for both groups', () => {
    const onLoadOlder = jest.fn();
    const onLoadOlderPreJob = jest.fn();
    const { rerender } = renderLedger({
      failures: [FAILURE],
      nextBeforeId: 51,
      onLoadOlder,
      preJobFailures: [PRE_JOB_FAILURE],
      preJobNextBefore: 'cHJlX2pvYl9jdXJzb3I',
      onLoadOlderPreJob,
    });

    const section = screen.getByRole('region', { name: 'Failed shipments' });
    fireEvent.click(within(section).getByRole('button', { name: 'Load older pre-job failures' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Load older job failures' }));
    expect(onLoadOlderPreJob).toHaveBeenCalledTimes(1);
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(within(section).getAllByRole('button')).toHaveLength(2);

    rerender(<FailedShipments
      failures={[FAILURE]}
      loading={false}
      error={null}
      stopped={false}
      nextBeforeId={51}
      loadingOlder
      onLoadOlder={onLoadOlder}
      preJobFailures={[PRE_JOB_FAILURE]}
      preJobLoading={false}
      preJobError={null}
      preJobNextBefore="cHJlX2pvYl9jdXJzb3I"
      preJobLoadingOlder
      onLoadOlderPreJob={onLoadOlderPreJob}
    />);
    expect(screen.getByRole('button', { name: 'Loading older pre-job failures…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Loading older job failures…' })).toBeDisabled();
  });
});
