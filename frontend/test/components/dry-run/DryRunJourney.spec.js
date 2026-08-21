import React from 'react';
import { createHash } from 'crypto';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { DryRunJourney } from '../../../components/dry-run/DryRunJourney';
import {
  getDryRunJourney,
  getDryRunPodCurl,
  getDryRunRequestBlob,
  listDryRunFailures,
  listDryRuns,
} from '../../../services/dryRunApi';
import { listPreJobFailures } from '../../../services/shipmentActivityApi';
import { createDryRunService } from '../../../../src/einvoice/dry-run-service';

jest.mock('../../../services/dryRunApi', () => ({
  listDryRuns: jest.fn(),
  listDryRunFailures: jest.fn(),
  getDryRunJourney: jest.fn(),
  getDryRunPodCurl: jest.fn(),
  getDryRunRequestBlob: jest.fn(),
}));

jest.mock('../../../services/shipmentActivityApi', () => ({
  listPreJobFailures: jest.fn(),
}));

const PRIMARY_DOCUMENT_NUMBER = 'VR-17861361389811907489-1';
const PRIMARY_SHIPMENT_ID = '17861361389811907489';
const REQUEST_HASH = '196838dcf2c4086737b4f69480bff502ddf512b4b439a43ea1a8694d70f244c3';
const OEIS_URL = "https://oeis.example.test/root'quoted/API/V2/Transaction/UpdateInvoiceData";
const POD_URL = "https://oeis.example.test/root'quoted/$path;$(touch)/`whoami`/API/V2/Transaction/UpdateInvoiceData";
const POD_REQUEST_JSON = '[{"NOTE":"O\'Reilly $HOME `uname` $(id); * ? [x]","UNICODE":"رياض"}]';
const POD_API_KEY = "live'key$HOME $(id) `uname`; * ?";
const POD_ENVELOPE = Object.freeze({
  method: 'POST',
  url: POD_URL,
  requestJson: POD_REQUEST_JSON,
  requestHash: '0031c9b6b00670fdc2102695338f1db6c6e8e8ea598bef58f3c61cec35ebcaab',
  byteCount: 71,
  apiKey: POD_API_KEY,
});
const EXPECTED_POD_CURL = [
  'curl --silent --show-error --max-redirs 0 \\',
  '  --request POST \\',
  "  --url 'https://oeis.example.test/root'\"'\"'quoted/$path;$(touch)/`whoami`/API/V2/Transaction/UpdateInvoiceData' \\",
  "  --header 'Authorization: APIkey live'\"'\"'key$HOME $(id) `uname`; * ?' \\",
  "  --header 'Connection: keep-alive' \\",
  "  --header 'Content-Type: application/json' \\",
  "  --data-binary '[{\"NOTE\":\"O'\"'\"'Reilly $HOME `uname` $(id); * ? [x]\",\"UNICODE\":\"رياض\"}]'",
].join('\n');
const SECOND_POD_REQUEST_JSON = '[{"TRAN_DOC_NO":"VR-1","NOTE":"second O\'Reilly $HOME $(id) `uname`"}]';
const SECOND_POD_API_KEY = "fresh'key$PATH $(false) `id`; []";
const SECOND_POD_ENVELOPE = Object.freeze({
  method: 'POST',
  url: "https://oeis.example.test/second'fresh/API/V2/Transaction/UpdateInvoiceData",
  requestJson: SECOND_POD_REQUEST_JSON,
  requestHash: 'a2c2b716b6b77a271f5a295a505bdb27c0a91e439514032c60eb602f70255210',
  byteCount: 69,
  apiKey: SECOND_POD_API_KEY,
});
const EXPECTED_SECOND_POD_CURL = [
  'curl --silent --show-error --max-redirs 0 \\',
  '  --request POST \\',
  "  --url 'https://oeis.example.test/second'\"'\"'fresh/API/V2/Transaction/UpdateInvoiceData' \\",
  "  --header 'Authorization: APIkey fresh'\"'\"'key$PATH $(false) `id`; []' \\",
  "  --header 'Connection: keep-alive' \\",
  "  --header 'Content-Type: application/json' \\",
  "  --data-binary '[{\"TRAN_DOC_NO\":\"VR-1\",\"NOTE\":\"second O'\"'\"'Reilly $HOME $(id) `uname`\"}]'",
].join('\n');

const jobs = [
  {
    jobId: 42,
    shipmentId: PRIMARY_SHIPMENT_ID,
    documentNumber: PRIMARY_DOCUMENT_NUMBER,
    state: 'SUBMISSION_HELD',
    lockedAt: '2026-08-13T10:00:00.000Z',
    createdAt: '2026-08-13T09:59:00.000Z',
    updatedAt: '2026-08-13T10:00:00.000Z',
    version: 4,
  },
  {
    jobId: 41,
    shipmentId: 'shipment-old',
    documentNumber: 'VR-OLD',
    state: 'SUBMISSION_HELD',
    lockedAt: '2026-08-13T09:00:00.000Z',
    createdAt: '2026-08-13T08:59:00.000Z',
    updatedAt: '2026-08-13T09:00:00.000Z',
    version: 3,
  },
];

const failures = [
  {
    jobId: 51,
    shipmentId: 'failed-shipment-51',
    documentNumber: 'VR-FAILED-51',
    state: 'DATA_FAILED',
    failureCode: 'LOCAL_VALIDATION_FAILED',
    failureMessage: 'Invoice data failed local validation.',
    attemptCount: 2,
    lockRecordedAt: null,
    createdAt: '2026-08-13T09:00:00.000Z',
    failedAt: '2026-08-13T10:00:00.000Z',
    version: 3,
  },
  {
    jobId: 50,
    shipmentId: 'failed-shipment-50',
    documentNumber: 'VR-FAILED-50',
    state: 'INDETERMINATE',
    failureCode: 'OEIS_UNKNOWN_RESULT',
    failureMessage: 'Invoice outcome is indeterminate and requires operator review.',
    attemptCount: 4,
    lockRecordedAt: '2026-08-13T08:59:30.000Z',
    createdAt: '2026-08-13T08:00:00.000Z',
    failedAt: '2026-08-13T09:00:00.000Z',
    version: 5,
  },
];

const preJobFailures = [
  {
    shipmentId: 'prejob-currency-unsupported',
    jobId: null,
    documentNumber: null,
    lastStage: 'VALIDATION',
    lastAction: 'VALIDATION_FAILED',
    lastOutcome: 'FAILURE',
    lastSafeCode: 'CURRENCY_UNSUPPORTED',
    firstOccurredAt: '2026-08-13T07:00:00.000Z',
    lastOccurredAt: '2026-08-13T07:00:01.000Z',
    version: 1,
  },
];

function detailFor(jobId = 42, requestHash = REQUEST_HASH) {
  const job = jobs.find(item => item.jobId === jobId) || jobs[0];
  return {
    schemaVersion: 1,
    mode: 'dry-run',
    job: {
      jobId: job.jobId,
      shipmentId: job.shipmentId,
      documentNumber: job.documentNumber,
      state: job.state,
      lockedAt: job.lockedAt,
      version: job.version,
    },
    normalizedSnapshot: {
      shipmentId: job.shipmentId,
      confirmedAt: '2026-08-13T09:59:57.000Z',
      branchCode: 'R1',
      currency: 'SAR',
      paymentMode: 'CARD',
      amountPaid: '115.00',
      bags: [{
        bagId: 'bag-1',
        lineNumber: 1,
        productCode: 'SKU-1',
        quantity: 1,
        financialBreakup: {
          price_effective: '115.00',
          promotion_effective_discount: '0.00',
          coupon_effective_discount: '0.00',
          value_of_good: '100.00',
          gst_tax_percentage: '15.00',
          gst_fee: '15.00',
          amount_paid: '115.00',
        },
        prices: {
          promotion_effective_discount: '0.00',
          coupon_effective_discount: '0.00',
        },
      }],
    },
    steps: {
      webhook: {
        status: 'completed',
        event: 'application/shipment/update/v1',
        triggerStatus: 'bag_confirmed',
      },
      payloadPreparation: {
        status: 'completed',
        requestHash,
        requestBytes: 63,
        withinLimit: true,
      },
      fyndLock: {
        status: 'completed',
        source: 'derived-with-live-builder',
        operation: 'platform.order.updateShipmentLock',
        request: {
          body: {
            entity_type: 'shipments',
            action: 'lock',
            action_type: 'complete',
            entities: [{ id: job.shipmentId, reason_text: `OEIS invoice ${job.documentNumber}` }],
          },
        },
        result: { locked: true },
      },
      oeisSubmission: {
        status: 'held',
        method: 'POST',
        url: OEIS_URL,
        bodyDownloadUrl: `/api/einvoice/dry-runs/${jobId}/oeis-request`,
        bodyFileName: `${job.documentNumber}-oeis-request.json`,
        curl: [
          'curl --silent --show-error --max-redirs 0 \\',
          '  --request POST \\',
          "  --url 'https://oeis.example.test/root'\"'\"'quoted/API/V2/Transaction/UpdateInvoiceData' \\",
          "  --header 'Content-Type: application/json' \\",
          '  --header "Authorization: APIkey ${OEIS_API_KEY:?OEIS_API_KEY is required}" \\',
          `  --data-binary '@${job.documentNumber}-oeis-request.json'`,
        ].join('\n'),
        warning: 'Executing this cURL performs a real OEIS submission.',
      },
      fyndTransition: {
        status: 'blocked',
        operation: 'platform.order.updateShipmentStatus',
        executable: false,
        requestTemplate: {
          body: {
            task: false,
            force_transition: false,
            unlock_before_transition: true,
            lock_after_transition: false,
            statuses: [
              {
                status: 'bag_invoiced',
                shipments: [
                  {
                    identifier: job.shipmentId,
                    products: [],
                    data_updates: {
                      products: [{ data: { store_invoice_id: '$OEIS_RESPONSE.InvoiceNumber[0:25]' } }],
                      entities: [{
                        data: {
                          store_invoice_id: '$OEIS_RESPONSE.InvoiceNumber[0:25]',
                          meta: {
                            einvoice_info: {
                              invoice: {
                                InvoiceNumber: '$OEIS_RESPONSE.InvoiceNumber',
                                SignedQRCode: {
                                  $deferred: 'QRCodeData',
                                },
                              },
                            },
                            xml: {
                              content: {
                                $deferred: 'decoded ReportingApiResponse.SignedXmlEncoded',
                              },
                              filename: '$OEIS_RESPONSE.InvoiceNumber.xml',
                            },
                          },
                        },
                      }],
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => Promise.resolve());
}

function expectScopedLoadingStatus(copy) {
  const text = screen.getByText(copy);
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
  return status;
}

describe('DryRunJourney', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    listDryRuns.mockResolvedValue({ items: jobs, nextBeforeId: null });
    listDryRunFailures.mockResolvedValue({ items: failures, nextBeforeId: null });
    listPreJobFailures.mockResolvedValue({ items: [], nextBefore: null });
    getDryRunJourney.mockImplementation(({ jobId }) => Promise.resolve(detailFor(jobId)));
    getDryRunPodCurl.mockResolvedValue(POD_ENVELOPE);
    getDryRunRequestBlob.mockResolvedValue(new Blob(['exact bytes'], { type: 'application/json' }));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: undefined,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    delete navigator.clipboard;
    delete document.execCommand;
  });

  test('keeps the hand-derived frontend contract aligned with the real backend service', async () => {
    const requestJson = '[{"TRAN_DOC_NO":"VR-17861361389811907489-1","NOTE":"رياض"}]';
    const expected = detailFor();
    expected.normalizedSnapshot.policyVersion = '2026-08-17';
    expected.normalizedSnapshot.taxEligibility = {
      governmentBorneVatEligible: true,
      reasonCode: 'VATEX-SA-HEA',
      evidenceReference: 'event-evidence-8a',
      verifiedAt: '2026-08-13T09:59:57.000Z',
    };
    expected.steps.oeisSubmission.bodyFileName = `${PRIMARY_DOCUMENT_NUMBER}-oeis-diagnostic.json`;
    expected.steps.oeisSubmission.sanitized = true;
    expected.steps.oeisSubmission.warning = 'Sanitized diagnostic only; it is not valid for OEIS submission.';
    delete expected.steps.oeisSubmission.curl;
    const repository = {
      listDryRunJobsForCompany: jest.fn().mockResolvedValue({ items: [], nextBeforeId: null }),
      listFailedJobsForCompany: jest.fn().mockResolvedValue({ items: [], nextBeforeId: null }),
      getDryRunJobForCompany: jest.fn().mockResolvedValue({
        id: 42,
        companyId: '12655',
        state: 'SUBMISSION_HELD',
        shipmentId: PRIMARY_SHIPMENT_ID,
        documentNumber: PRIMARY_DOCUMENT_NUMBER,
        shipmentSnapshot: {
          ...expected.normalizedSnapshot,
          taxEligibility: {
            ...expected.normalizedSnapshot.taxEligibility,
            buyerName: 'BUYER-NAME-NOT-FOR-FRONTEND',
            buyerNationalId: '1234567890',
          },
        },
        oeisRequestJson: requestJson,
        requestHash: REQUEST_HASH,
        lockedAt: '2026-08-13T10:00:00.000Z',
        version: 4,
      }),
      getDryRunRequestForCompany: jest.fn().mockResolvedValue({
        jobId: 42,
        documentNumber: PRIMARY_DOCUMENT_NUMBER,
        requestJson,
        requestHash: REQUEST_HASH,
      }),
    };
    const service = createDryRunService({
      repository,
      oeisBaseUrl: "https://oeis.example.test/root'quoted",
      oeisApiKey: 'frontend-contract-test-key',
      maxRequestBytes: 63,
    });

    await expect(service.getDryRunJourney({ companyId: '12655', jobId: 42 }))
      .resolves.toEqual(expected);
  });

  test('shows an accessible scoped loader for the initial held journeys request', async () => {
    const pending = deferred();
    listDryRuns.mockReturnValueOnce(pending.promise);
    render(<DryRunJourney companyId="12655" />);

    expect(screen.getByText('Invoice safety console')).toBeInTheDocument();
    expect(screen.queryAllByText(/\bUAT\b/i)).toHaveLength(0);
    expectScopedLoadingStatus('Loading held journeys…');

    pending.resolve({ items: [], nextBeforeId: null });
    expect(await screen.findByText('No held invoice journeys')).toBeInTheDocument();
    expect(screen.queryByText('Loading held journeys…')).not.toBeInTheDocument();
    expect(screen.getByText('New held invoice journeys will appear after the Fynd lock completes.'))
      .toBeInTheDocument();
  });

  test('shows the scoped loader only while selected journey evidence is initially empty', async () => {
    const pendingDetail = deferred();
    getDryRunJourney.mockReturnValueOnce(pendingDetail.promise);
    render(<DryRunJourney companyId="12655" />);

    await screen.findByRole('button', { name: new RegExp(PRIMARY_DOCUMENT_NUMBER) });
    expectScopedLoadingStatus('Loading journey evidence…');

    pendingDetail.resolve(detailFor());
    expect(await screen.findByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`))
      .toBeInTheDocument();
    expect(screen.queryByText('Loading journey evidence…')).not.toBeInTheDocument();
  });

  test('retains selected journey evidence instead of showing a loader during background polling', async () => {
    jest.useFakeTimers();
    const pendingDetailPoll = deferred();
    getDryRunJourney
      .mockResolvedValueOnce(detailFor())
      .mockReturnValueOnce(pendingDetailPoll.promise);
    render(<DryRunJourney companyId="12655" />);
    expect(await screen.findByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`))
      .toBeInTheDocument();

    await act(async () => jest.advanceTimersByTime(5000));
    await waitFor(() => expect(getDryRunJourney).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`))
      .toBeInTheDocument();
    expect(screen.queryByText('Loading journey evidence…')).not.toBeInTheDocument();

    pendingDetailPoll.resolve(detailFor());
    await flush();
  });

  test('retains loaded journeys and failures during a manual extension refresh', async () => {
    const ref = React.createRef();
    const pendingListRefresh = deferred();
    listDryRuns
      .mockResolvedValueOnce({ items: jobs, nextBeforeId: null })
      .mockReturnValueOnce(pendingListRefresh.promise);
    render(<DryRunJourney ref={ref} companyId="12655" />);
    expect(await screen.findByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`))
      .toBeInTheDocument();
    expect(await screen.findByText('VR-FAILED-51')).toBeInTheDocument();

    let refreshPromise;
    act(() => {
      refreshPromise = ref.current.refreshAll(7);
    });
    await waitFor(() => expect(listDryRuns).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`))
      .toBeInTheDocument();
    expect(screen.getByText('VR-FAILED-51')).toBeInTheDocument();
    expect(screen.queryByText('Loading held journeys…')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading journey evidence…')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading failed shipments…')).not.toBeInTheDocument();

    let refreshResult;
    await act(async () => {
      pendingListRefresh.resolve({ items: jobs, nextBeforeId: null });
      refreshResult = await refreshPromise;
    });
    expect(refreshResult).toEqual({ status: 'success', generation: 7 });
  });

  test('loads failed shipments independently and resolves to its precise empty state', async () => {
    const pendingFailures = deferred();
    listDryRunFailures.mockReturnValueOnce(pendingFailures.promise);
    render(<DryRunJourney companyId="12655" />);

    expect(screen.getByText('Loading failed shipments…')).toBeInTheDocument();
    expect(await screen.findByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`)).toBeInTheDocument();
    pendingFailures.resolve({ items: [], nextBeforeId: null });
    expect(await screen.findByText('No failed shipments recorded.')).toBeInTheDocument();
    expect(listDryRunFailures).toHaveBeenCalledWith({ companyId: '12655', limit: 20 });
  });

  test('shows a CURRENCY_UNSUPPORTED shipment rejected before a job was created', async () => {
    listPreJobFailures.mockResolvedValueOnce({ items: preJobFailures, nextBefore: null });

    render(<DryRunJourney companyId="12655" />);

    const group = await screen.findByRole('region', { name: 'Rejected before a job was created' });
    expect(within(group).getByText('prejob-currency-unsupported')).toBeInTheDocument();
    expect(within(group).getByText('REJECTED BEFORE JOB')).toBeInTheDocument();
    expect(within(group).getByText('CURRENCY_UNSUPPORTED')).toBeInTheDocument();
    expect(within(group).getByText('Shipment processing was rejected before a job was created.'))
      .toBeInTheDocument();
    expect(listPreJobFailures).toHaveBeenCalledWith({ companyId: '12655', limit: 20 });
  });

  test('paginates and deduplicates pre-job and job failures with independent cursors and in-flight guards', async () => {
    const olderJobs = deferred();
    const olderPreJobs = deferred();
    const oldestJob = {
      ...failures[1], jobId: 49, shipmentId: 'failed-shipment-49', documentNumber: 'VR-FAILED-49',
    };
    const oldestPreJob = {
      ...preJobFailures[0],
      shipmentId: 'prejob-older',
      firstOccurredAt: '2026-08-13T06:00:00.000Z',
      lastOccurredAt: '2026-08-13T06:00:01.000Z',
    };
    listDryRunFailures
      .mockResolvedValueOnce({ items: failures, nextBeforeId: 50 })
      .mockReturnValueOnce(olderJobs.promise);
    listPreJobFailures
      .mockResolvedValueOnce({ items: preJobFailures, nextBefore: 'cHJlX2pvYl9jdXJzb3I' })
      .mockReturnValueOnce(olderPreJobs.promise);
    render(<DryRunJourney companyId="12655" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Load older pre-job failures' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Load older job failures' }));
    fireEvent.click(screen.getByRole('button', { name: 'Loading older pre-job failures…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Loading older job failures…' }));

    expect(listPreJobFailures).toHaveBeenCalledTimes(2);
    expect(listPreJobFailures).toHaveBeenLastCalledWith({
      companyId: '12655', limit: 20, before: 'cHJlX2pvYl9jdXJzb3I',
    });
    expect(listDryRunFailures).toHaveBeenCalledTimes(2);
    expect(listDryRunFailures).toHaveBeenLastCalledWith({
      companyId: '12655', limit: 20, beforeId: 50,
    });

    olderPreJobs.resolve({
      items: [preJobFailures[0], oldestPreJob, { ...oldestPreJob }],
      nextBefore: null,
    });
    olderJobs.resolve({ items: [failures[1], oldestJob, { ...oldestJob }], nextBeforeId: null });
    expect(await screen.findByText('prejob-older')).toBeInTheDocument();
    expect(await screen.findByText('VR-FAILED-49')).toBeInTheDocument();
    expect(screen.getAllByText('prejob-currency-unsupported')).toHaveLength(1);
    expect(screen.getAllByText('prejob-older')).toHaveLength(1);
    expect(screen.getAllByText('VR-FAILED-49')).toHaveLength(1);
  });

  test('queues an extension refresh behind pagination and reloads held detail and both failure depths', async () => {
    const ref = React.createRef();
    const olderJobs = deferred();
    const olderPreJobs = deferred();
    const oldJob = {
      ...failures[1], jobId: 49, shipmentId: 'failed-shipment-49', documentNumber: 'VR-FAILED-49',
    };
    const oldPreJob = {
      ...preJobFailures[0],
      shipmentId: 'prejob-older',
      firstOccurredAt: '2026-08-13T06:00:00.000Z',
      lastOccurredAt: '2026-08-13T06:00:01.000Z',
    };
    listDryRunFailures
      .mockResolvedValueOnce({ items: failures, nextBeforeId: 50 })
      .mockReturnValueOnce(olderJobs.promise)
      .mockResolvedValueOnce({ items: failures, nextBeforeId: 50 })
      .mockResolvedValueOnce({ items: [oldJob], nextBeforeId: null });
    listPreJobFailures
      .mockResolvedValueOnce({ items: preJobFailures, nextBefore: 'prejob_cursor' })
      .mockReturnValueOnce(olderPreJobs.promise)
      .mockResolvedValueOnce({ items: preJobFailures, nextBefore: 'prejob_cursor' })
      .mockResolvedValueOnce({ items: [oldPreJob], nextBefore: null });
    render(<DryRunJourney ref={ref} companyId="12655" routeKey="route-a" />);
    await screen.findByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`);

    fireEvent.click(await screen.findByRole('button', { name: 'Load older pre-job failures' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load older job failures' }));
    let refreshPromise;
    act(() => {
      refreshPromise = ref.current.refreshAll(11);
    });
    expect(listDryRuns).toHaveBeenCalledTimes(1);
    expect(getDryRunJourney).toHaveBeenCalledTimes(1);
    expect(listDryRunFailures).toHaveBeenCalledTimes(2);
    expect(listPreJobFailures).toHaveBeenCalledTimes(2);

    await act(async () => {
      olderJobs.resolve({ items: [oldJob], nextBeforeId: null });
      olderPreJobs.resolve({ items: [oldPreJob], nextBefore: null });
    });

    await waitFor(() => expect(listDryRuns).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getDryRunJourney).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(listDryRunFailures).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(listPreJobFailures).toHaveBeenCalledTimes(4));
    await expect(refreshPromise).resolves.toEqual({ status: 'success', generation: 11 });
    expect(listDryRunFailures.mock.calls.slice(2).map(([input]) => input.beforeId))
      .toEqual([undefined, 50]);
    expect(listPreJobFailures.mock.calls.slice(2).map(([input]) => input.before))
      .toEqual([undefined, 'prejob_cursor']);
  });

  test('retains pre-job rows through a transient refresh and clears the warning on recovery', async () => {
    jest.useFakeTimers();
    listPreJobFailures
      .mockResolvedValueOnce({ items: preJobFailures, nextBefore: null })
      .mockRejectedValueOnce({ kind: 'request-failed' })
      .mockResolvedValue({ items: preJobFailures, nextBefore: null });
    render(<DryRunJourney companyId="12655" />);
    await screen.findByText('prejob-currency-unsupported');

    await act(async () => jest.advanceTimersByTime(5000));
    expect(screen.getByText('prejob-currency-unsupported')).toBeInTheDocument();
    expect(screen.getByText('Failed-shipment data could not be loaded.')).toBeInTheDocument();

    await act(async () => jest.advanceTimersByTime(5000));
    expect(screen.queryByText('Failed-shipment data could not be loaded.')).not.toBeInTheDocument();
    expect(screen.getByText('prejob-currency-unsupported')).toBeInTheDocument();
  });

  test('makes a current-session pre-job 401 terminal for all dry-run data', async () => {
    listPreJobFailures.mockRejectedValueOnce({ kind: 'unauthorized' });
    render(<DryRunJourney companyId="12655" />);

    expect(await screen.findByText('Polling stopped · reauthenticate')).toBeInTheDocument();
    expect(screen.getAllByText(/session has expired/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(PRIMARY_DOCUMENT_NUMBER)).not.toBeInTheDocument();
    expect(screen.queryByText('VR-FAILED-51')).not.toBeInTheDocument();
  });

  test('appends and deduplicates older failures without overlapping pagination requests', async () => {
    const older = deferred();
    const oldest = { ...failures[1], jobId: 49, shipmentId: 'failed-shipment-49', documentNumber: 'VR-FAILED-49' };
    listDryRunFailures
      .mockResolvedValueOnce({ items: failures, nextBeforeId: 50 })
      .mockReturnValueOnce(older.promise);
    render(<DryRunJourney companyId="12655" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Load older job failures' }));
    expect(screen.getByRole('button', { name: 'Loading older job failures…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Loading older job failures…' }));
    expect(listDryRunFailures).toHaveBeenCalledTimes(2);
    expect(listDryRunFailures).toHaveBeenLastCalledWith({ companyId: '12655', limit: 20, beforeId: 50 });

    older.resolve({ items: [failures[1], oldest, { ...oldest }], nextBeforeId: null });
    expect(await screen.findByText('VR-FAILED-49')).toBeInTheDocument();
    expect(screen.getAllByText('VR-FAILED-50')).toHaveLength(1);
    expect(screen.getAllByText('VR-FAILED-49')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load older job failures' })).not.toBeInTheDocument();
  });

  test('retains failure rows through a transient refresh and clears the warning on recovery', async () => {
    jest.useFakeTimers();
    listDryRunFailures
      .mockResolvedValueOnce({ items: failures, nextBeforeId: null })
      .mockRejectedValueOnce({ kind: 'request-failed' })
      .mockResolvedValue({ items: failures, nextBeforeId: null });
    render(<DryRunJourney companyId="12655" />);
    await screen.findByText('VR-FAILED-51');

    await act(async () => jest.advanceTimersByTime(5000));
    expect(screen.getByRole('region', { name: 'Failed shipments' })).toHaveTextContent('VR-FAILED-51');
    expect(screen.getByText('Failed-shipment data could not be loaded.')).toBeInTheDocument();

    await act(async () => jest.advanceTimersByTime(5000));
    expect(screen.queryByText('Failed-shipment data could not be loaded.')).not.toBeInTheDocument();
    expect(screen.getByText('VR-FAILED-51')).toBeInTheDocument();
  });

  test('reconciles a fresh first page while preserving loaded older rows and their cursor', async () => {
    jest.useFakeTimers();
    const failure = jobId => ({
      ...failures[0],
      jobId,
      shipmentId: `failed-shipment-${jobId}`,
      documentNumber: `VR-FAILED-${jobId}`,
    });
    listDryRunFailures
      .mockResolvedValueOnce({ items: [failure(100), failure(99)], nextBeforeId: 99 })
      .mockResolvedValueOnce({ items: [failure(98), failure(97)], nextBeforeId: 97 })
      .mockResolvedValueOnce({ items: [failure(101), failure(100)], nextBeforeId: 100 })
      .mockResolvedValueOnce({ items: [], nextBeforeId: null });
    const { container } = render(<DryRunJourney companyId="12655" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load older job failures' }));
    await screen.findByText('VR-FAILED-97');

    await act(async () => jest.advanceTimersByTime(5000));
    expect(
      [...container.querySelectorAll('.failed-shipment-document')].map(row => row.textContent),
    ).toEqual([
      'VR-FAILED-101',
      'VR-FAILED-100',
      'VR-FAILED-99',
      'VR-FAILED-98',
      'VR-FAILED-97',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Load older job failures' }));
    await flush();
    expect(listDryRunFailures).toHaveBeenLastCalledWith({ companyId: '12655', limit: 20, beforeId: 97 });
  });

  test('starts and polls failures only while visible and never overlaps an in-flight request', async () => {
    jest.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const pending = deferred();
    listDryRunFailures.mockReturnValue(pending.promise);
    render(<DryRunJourney companyId="12655" />);
    await flush();
    expect(listDryRunFailures).not.toHaveBeenCalled();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => jest.advanceTimersByTime(5000));
    expect(listDryRunFailures).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(10000));
    expect(listDryRunFailures).toHaveBeenCalledTimes(1);

    pending.resolve({ items: [], nextBeforeId: null });
    await flush();
  });

  test('keeps a current reauthentication stop sticky against a delayed failure-list success', async () => {
    jest.useFakeTimers();
    const pendingPoll = deferred();
    listDryRunFailures
      .mockResolvedValueOnce({ items: failures, nextBeforeId: null })
      .mockReturnValueOnce(pendingPoll.promise);
    getDryRunRequestBlob.mockRejectedValue({ kind: 'unauthorized' });
    render(<DryRunJourney companyId="12655" />);
    await screen.findByText('VR-FAILED-51');

    await act(async () => jest.advanceTimersByTime(5000));
    fireEvent.click(screen.getByRole('button', { name: 'Download diagnostic JSON' }));
    await flush();
    expect(screen.queryByText('VR-FAILED-51')).not.toBeInTheDocument();
    expect(screen.getAllByText(/reauthenticate in Fynd/i).length).toBeGreaterThan(0);

    pendingPoll.resolve({ items: failures, nextBeforeId: null });
    await flush();
    expect(screen.queryByText('VR-FAILED-51')).not.toBeInTheDocument();
    await act(async () => jest.advanceTimersByTime(10000));
    expect(listDryRunFailures).toHaveBeenCalledTimes(2);
  });

  test('clears old-company failures immediately before the new route resolves', async () => {
    const companyB = deferred();
    const companyBFailure = {
      ...failures[0], jobId: 71, shipmentId: 'company-b-failure', documentNumber: 'VR-COMPANY-B-FAILURE',
    };
    listDryRunFailures.mockImplementation(({ companyId }) => (
      companyId === '12655'
        ? Promise.resolve({ items: failures, nextBeforeId: null })
        : companyB.promise
    ));
    const { rerender } = render(<DryRunJourney companyId="12655" />);
    await screen.findByText('VR-FAILED-51');

    rerender(<DryRunJourney companyId="99887" />);
    expect(screen.queryByText('VR-FAILED-51')).not.toBeInTheDocument();
    companyB.resolve({ items: [companyBFailure], nextBeforeId: null });
    expect(await screen.findByText('VR-COMPANY-B-FAILURE')).toBeInTheDocument();
  });

  test('ignores a delayed old-company failure-list 401 after the new route succeeds', async () => {
    const oldCompany = deferred();
    const companyBFailure = {
      ...failures[0], jobId: 71, shipmentId: 'company-b-failure', documentNumber: 'VR-COMPANY-B-FAILURE',
    };
    listDryRunFailures.mockImplementation(({ companyId }) => (
      companyId === '12655'
        ? oldCompany.promise
        : Promise.resolve({ items: [companyBFailure], nextBeforeId: null })
    ));
    const { rerender } = render(<DryRunJourney companyId="12655" />);
    rerender(<DryRunJourney companyId="99887" />);
    expect(await screen.findByText('VR-COMPANY-B-FAILURE')).toBeInTheDocument();

    oldCompany.reject({ kind: 'unauthorized' });
    await flush();
    expect(screen.getByText('VR-COMPANY-B-FAILURE')).toBeInTheDocument();
    expect(screen.queryByText(/Polling stopped/)).not.toBeInTheDocument();
  });

  test('scopes rows to an application route and ignores a delayed prior-route success', async () => {
    jest.useFakeTimers();
    const oldRoutePoll = deferred();
    const oldRouteFailure = {
      ...failures[0], jobId: 81, shipmentId: 'app-1-failure', documentNumber: 'VR-APP-1',
    };
    const staleOldRouteFailure = {
      ...failures[0], jobId: 82, shipmentId: 'app-1-stale', documentNumber: 'VR-APP-1-STALE',
    };
    const newRouteFailure = {
      ...failures[0], jobId: 91, shipmentId: 'app-2-failure', documentNumber: 'VR-APP-2',
    };
    listDryRunFailures
      .mockResolvedValueOnce({ items: [oldRouteFailure], nextBeforeId: null })
      .mockReturnValueOnce(oldRoutePoll.promise)
      .mockResolvedValueOnce({ items: [newRouteFailure], nextBeforeId: null });
    const { rerender } = render(
      <DryRunJourney companyId="12655" routeKey="company:12655:application:app-1" />,
    );
    await screen.findByText('VR-APP-1');
    await act(async () => jest.advanceTimersByTime(5000));

    rerender(<DryRunJourney companyId="12655" routeKey="company:12655:application:app-2" />);
    expect(screen.queryByText('VR-APP-1')).not.toBeInTheDocument();
    expect(await screen.findByText('VR-APP-2')).toBeInTheDocument();

    oldRoutePoll.resolve({ items: [staleOldRouteFailure], nextBeforeId: null });
    await flush();
    expect(screen.getByText('VR-APP-2')).toBeInTheDocument();
    expect(screen.queryByText('VR-APP-1-STALE')).not.toBeInTheDocument();
  });

  test('ignores a delayed prior-application 401 after the new route succeeds', async () => {
    jest.useFakeTimers();
    const oldRoutePoll = deferred();
    const oldRouteFailure = {
      ...failures[0], jobId: 81, shipmentId: 'app-1-failure', documentNumber: 'VR-APP-1',
    };
    const newRouteFailure = {
      ...failures[0], jobId: 91, shipmentId: 'app-2-failure', documentNumber: 'VR-APP-2',
    };
    listDryRunFailures
      .mockResolvedValueOnce({ items: [oldRouteFailure], nextBeforeId: null })
      .mockReturnValueOnce(oldRoutePoll.promise)
      .mockResolvedValueOnce({ items: [newRouteFailure], nextBeforeId: null });
    const { rerender } = render(
      <DryRunJourney companyId="12655" routeKey="company:12655:application:app-1" />,
    );
    await screen.findByText('VR-APP-1');
    await act(async () => jest.advanceTimersByTime(5000));

    rerender(<DryRunJourney companyId="12655" routeKey="company:12655:application:app-2" />);
    expect(screen.queryByText('VR-APP-1')).not.toBeInTheDocument();
    expect(await screen.findByText('VR-APP-2')).toBeInTheDocument();

    oldRoutePoll.reject({ kind: 'unauthorized' });
    await flush();
    expect(screen.getByText('VR-APP-2')).toBeInTheDocument();
    expect(screen.queryByText(/Polling stopped/)).not.toBeInTheDocument();
  });

  test('resets a sticky reauthentication stop when the application route changes', async () => {
    const newRouteFailure = {
      ...failures[0], jobId: 91, shipmentId: 'app-2-failure', documentNumber: 'VR-APP-2',
    };
    listDryRunFailures
      .mockRejectedValueOnce({ kind: 'unauthorized' })
      .mockResolvedValueOnce({ items: [newRouteFailure], nextBeforeId: null });
    const { rerender } = render(
      <DryRunJourney companyId="12655" routeKey="company:12655:application:app-1" />,
    );
    expect(await screen.findByText(/Polling stopped/)).toBeInTheDocument();

    rerender(<DryRunJourney companyId="12655" routeKey="company:12655:application:app-2" />);
    expect(screen.queryByText(/Polling stopped/)).not.toBeInTheDocument();
    expect(await screen.findByText('VR-APP-2')).toBeInTheDocument();
    expect(screen.getByText('Visible · polling 5s')).toBeInTheDocument();
  });

  test('ignores failure-list completion after unmount', async () => {
    const pending = deferred();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    listDryRunFailures.mockReturnValue(pending.promise);
    const { unmount } = render(<DryRunJourney companyId="12655" />);
    unmount();

    pending.reject({ kind: 'unauthorized' });
    await flush();
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test('selects the newest job by default and lets an operator inspect another job', async () => {
    render(<DryRunJourney companyId="12655" />);

    expect(await screen.findByRole('heading', { name: PRIMARY_DOCUMENT_NUMBER })).toBeInTheDocument();
    await waitFor(() => expect(getDryRunJourney).toHaveBeenCalledWith({
      companyId: '12655',
      jobId: 42,
    }));
    expect(screen.getByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /VR-OLD/ }));
    expect(await screen.findByLabelText('Dry-run journey VR-OLD')).toBeInTheDocument();
  });

  test('renders diagnostic evidence without exposing endpoint or cURL fields present in the backend detail', async () => {
    const { container } = render(<DryRunJourney companyId="12655" />);

    const expected = detailFor();
    const snapshotPanel = (await screen.findByRole('heading', { name: 'Normalized shipment snapshot' })).closest('details');
    expect(screen.getByText('Diagnostic payload')).toBeInTheDocument();
    expect(screen.getByText('Sanitized bytes stored')).toBeInTheDocument();
    expect(screen.queryByText(/Exact bytes/i)).not.toBeInTheDocument();
    const lockPanel = screen.getByRole('heading', { name: 'Exact Fynd lock request' }).closest('details');
    const transitionPanel = screen.getByRole('heading', { name: 'Blocked Fynd transition' }).closest('details');
    expect(within(snapshotPanel).getByRole('code').textContent)
      .toBe(JSON.stringify(expected.normalizedSnapshot, null, 2));
    expect(within(lockPanel).getByRole('code').textContent).toBe(JSON.stringify(expected.steps.fyndLock.request, null, 2));
    expect(within(transitionPanel).getByRole('code').textContent)
      .toBe(JSON.stringify(expected.steps.fyndTransition.requestTemplate, null, 2));
    const renderedSnapshot = JSON.parse(within(snapshotPanel).getByRole('code').textContent);
    expect(renderedSnapshot.confirmedAt).toBe('2026-08-13T09:59:57.000Z');
    expect(renderedSnapshot.bags[0].financialBreakup).toEqual({
      price_effective: '115.00',
      promotion_effective_discount: '0.00',
      coupon_effective_discount: '0.00',
      value_of_good: '100.00',
      gst_tax_percentage: '15.00',
      gst_fee: '15.00',
      amount_paid: '115.00',
    });
    expect(renderedSnapshot.bags[0].prices).toEqual({
      promotion_effective_discount: '0.00',
      coupon_effective_discount: '0.00',
    });
    const renderedLock = JSON.parse(within(lockPanel).getByRole('code').textContent);
    expect(renderedLock.body.entities).toEqual([{
      id: PRIMARY_SHIPMENT_ID,
      reason_text: `OEIS invoice ${PRIMARY_DOCUMENT_NUMBER}`,
    }]);
    const renderedTransition = JSON.parse(within(transitionPanel).getByRole('code').textContent);
    const transitionShipment = renderedTransition.body.statuses[0].shipments[0];
    expect(transitionShipment.data_updates.products).toEqual([{
      data: { store_invoice_id: '$OEIS_RESPONSE.InvoiceNumber[0:25]' },
    }]);
    expect(transitionShipment.data_updates.entities[0].data.meta.einvoice_info.invoice.InvoiceNumber)
      .toBe('$OEIS_RESPONSE.InvoiceNumber');
    expect(transitionShipment.data_updates.entities[0].data.meta.xml.filename)
      .toBe('$OEIS_RESPONSE.InvoiceNumber.xml');
    const oeisPanel = screen.getByRole('region', { name: 'OEIS diagnostic request' });
    expect(oeisPanel).toHaveTextContent('POST');
    expect(oeisPanel).toHaveTextContent('63');
    expect(oeisPanel).toHaveTextContent(REQUEST_HASH);
    expect(expected.steps.oeisSubmission.url).toBe(OEIS_URL);
    expect(expected.steps.oeisSubmission.curl).toContain('/API/V2/Transaction/UpdateInvoiceData');
    expect(oeisPanel).not.toHaveTextContent(OEIS_URL);
    expect(within(oeisPanel).queryByText('Endpoint')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent('/API/V2/Transaction/UpdateInvoiceData');
    expect(screen.queryByRole('region', { name: 'Sanitized diagnostic cURL' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy diagnostic cURL' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download diagnostic JSON' })).toBeInTheDocument();
    expect(screen.queryAllByText(/\bUAT\b/i)).toHaveLength(0);
    expect(expected.steps.oeisSubmission.bodyDownloadUrl).toBe('/api/einvoice/dry-runs/42/oeis-request');
    expect(expected.steps.oeisSubmission.bodyFileName)
      .toBe(`${PRIMARY_DOCUMENT_NUMBER}-oeis-request.json`);
    expect(expected.steps.oeisSubmission.warning)
      .toBe('Executing this cURL performs a real OEIS submission.');
    expect(screen.getByText(/real shipment is locked/i)).toBeInTheDocument();
    expect(screen.getByText(/manual cleanup is required/i)).toBeInTheDocument();
    expect(container.querySelectorAll('.dry-run-deferred')).toHaveLength(2);
    expect(screen.getByText('QRCodeData')).toBeInTheDocument();
    expect(screen.getByText('decoded ReportingApiResponse.SignedXmlEncoded')).toBeInTheDocument();

    ['approve', 'resume', 'submit', 'unlock'].forEach(label => {
      expect(screen.queryByRole('button', { name: new RegExp(label, 'i') })).not.toBeInTheDocument();
    });
  });

  test('drops unknown hostile and buyer fields without creating executable elements', async () => {
    const hostile = '<img src=x onerror="window.__dryRunInjected=true"><script>window.__dryRunInjected=true</script>';
    const hostileDetail = detailFor();
    hostileDetail.normalizedSnapshot.operatorNote = hostile;
    hostileDetail.normalizedSnapshot.buyerName = 'BUYER-NAME-SENTINEL';
    hostileDetail.normalizedSnapshot.buyerNationalId = 'NATIONAL-ID-SENTINEL';
    getDryRunJourney.mockResolvedValue(hostileDetail);
    window.__dryRunInjected = false;
    const { container } = render(<DryRunJourney companyId="12655" />);

    const snapshotPanel = (await screen.findByRole('heading', { name: 'Normalized shipment snapshot' })).closest('details');
    expect(within(snapshotPanel).getByRole('code').textContent).not.toMatch(/BUYER-NAME-SENTINEL|NATIONAL-ID-SENTINEL/);
    expect(within(snapshotPanel).getByRole('code').textContent).not.toContain('<img src=x onerror=');
    expect(within(snapshotPanel).getByRole('code').textContent).not.toContain('<script>window.__dryRunInjected=true</script>');
    expect(container.querySelectorAll('script, img')).toHaveLength(0);
    expect(window.__dryRunInjected).toBe(false);
    delete window.__dryRunInjected;
  });

  test('ignores legacy server cURL fields and does not fetch a fresh command until the eligible action is clicked', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const detail = detailFor();
    expect(detail.steps.oeisSubmission.curl).toContain('curl --silent');
    getDryRunJourney.mockResolvedValue(detail);
    const { container } = render(<DryRunJourney companyId="12655" />);

    await screen.findByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`);
    expect(screen.queryByRole('button', { name: 'Copy diagnostic cURL' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy pod cURL' })).toBeInTheDocument();
    expect(getDryRunPodCurl).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(container).not.toHaveTextContent(detail.steps.oeisSubmission.curl);
    expect(container).not.toHaveTextContent(POD_URL);
    expect(container).not.toHaveTextContent(POD_REQUEST_JSON);
    expect(container).not.toHaveTextContent(POD_API_KEY);
    expect(container).not.toHaveTextContent('/oeis-pod-curl');
  });

  test.each([
    ['non-dry-run mode', value => { value.mode = 'live'; }],
    ['non-held job', value => { value.job.state = 'COMPLETED'; }],
    ['incomplete Fynd lock', value => { value.steps.fyndLock.status = 'pending'; }],
    ['unlocked Fynd result', value => { value.steps.fyndLock.result.locked = false; }],
    ['non-held OEIS step', value => { value.steps.oeisSubmission.status = 'completed'; }],
  ])('hides the real-submission action for a %s', async (_case, mutate) => {
    const detail = detailFor();
    mutate(detail);
    getDryRunJourney.mockResolvedValue(detail);
    render(<DryRunJourney companyId="12655" />);

    await screen.findByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`);
    expect(screen.queryByRole('button', { name: 'Copy pod cURL' })).not.toBeInTheDocument();
    expect(screen.queryByText(/pasting it in the app pod performs a real OEIS submission/i))
      .not.toBeInTheDocument();
    expect(getDryRunPodCurl).not.toHaveBeenCalled();
  });

  test('fetches every click, POSIX-quotes exact fresh bytes, and never renders the command or envelope', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    getDryRunPodCurl
      .mockResolvedValueOnce(POD_ENVELOPE)
      .mockResolvedValueOnce(SECOND_POD_ENVELOPE);
    const { container } = render(<DryRunJourney companyId="12655" />);

    const button = await screen.findByRole('button', { name: 'Copy pod cURL' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-busy', 'false');
    expect(screen.getByText(/pasting it in the app pod performs a real OEIS submission/i))
      .toHaveTextContent(/will not automatically record or reconcile that manual response/i);
    expect(screen.getByText(/pasting it in the app pod performs a real OEIS submission/i))
      .toHaveTextContent(/run the copied command only once\. Repeating it may create a duplicate invoice\./i);
    expect(getDryRunPodCurl).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenNthCalledWith(1, EXPECTED_POD_CURL));
    expect(getDryRunPodCurl).toHaveBeenNthCalledWith(1, { companyId: '12655', jobId: 42 });
    expect(screen.getByText('Pod cURL copied').closest('[role="status"]'))
      .toHaveAttribute('aria-live', 'polite');

    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenNthCalledWith(2, EXPECTED_SECOND_POD_CURL));
    expect(getDryRunPodCurl).toHaveBeenCalledTimes(2);
    expect(getDryRunPodCurl).toHaveBeenNthCalledWith(2, { companyId: '12655', jobId: 42 });
    expect(button).toHaveAttribute('aria-busy', 'false');
    expect(button).toBeEnabled();
    expect(container).not.toHaveTextContent(POD_URL);
    expect(container).not.toHaveTextContent(POD_REQUEST_JSON);
    expect(container).not.toHaveTextContent(SECOND_POD_REQUEST_JSON);
    expect(container).not.toHaveTextContent(POD_API_KEY);
    expect(container).not.toHaveTextContent(SECOND_POD_API_KEY);
    expect(container).not.toHaveTextContent('/oeis-pod-curl');
    expect(container).not.toHaveTextContent('Authorization: APIkey');
    expect(document.querySelector('textarea')).toBeNull();
  });

  test('copies even a large valid request in the requested direct data-binary format', async () => {
    const requestJson = JSON.stringify([{ NOTE: 'x'.repeat((128 * 1024) + 1) }]);
    const envelope = Object.freeze({
      method: 'POST',
      url: POD_URL,
      requestJson,
      requestHash: createHash('sha256').update(requestJson, 'utf8').digest('hex'),
      byteCount: Buffer.byteLength(requestJson, 'utf8'),
      apiKey: POD_API_KEY,
    });
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    getDryRunPodCurl.mockResolvedValue(envelope);
    const { container } = render(<DryRunJourney companyId="12655" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Copy pod cURL' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0];
    expect(envelope.byteCount).toBeGreaterThan(128 * 1024);
    expect(copied.startsWith('curl --silent --show-error --max-redirs 0 \\'))
      .toBe(true);
    expect(copied.indexOf(requestJson)).toBe(copied.lastIndexOf(requestJson));
    expect(copied).toContain(`  --data-binary '${requestJson}'`);
    expect(copied).not.toContain("printf '%s'");
    expect(copied).not.toContain('| curl');
    expect(copied).not.toContain('--data-binary @-');
    expect(container.textContent.includes(requestJson)).toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });

  test('copies the direct OEIS curl layout without a stdin pipeline', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(<DryRunJourney companyId="12655" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Copy pod cURL' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0][0];
    expect(copied).toBe(EXPECTED_POD_CURL);
    expect(copied).not.toContain('printf');
    expect(copied).not.toContain('@-');
  });

  test('marks the copy action busy and ignores duplicate clicks while one fresh request is pending', async () => {
    const pending = deferred();
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    getDryRunPodCurl.mockReturnValue(pending.promise);
    render(<DryRunJourney companyId="12655" />);

    const button = await screen.findByRole('button', { name: 'Copy pod cURL' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(getDryRunPodCurl).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');

    pending.resolve(POD_ENVELOPE);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(EXPECTED_POD_CURL));
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-busy', 'false');
  });

  test('does not materialize the command in the DOM when the Clipboard API is unavailable', async () => {
    const execCommand = jest.fn(() => true);
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });
    const { container } = render(<DryRunJourney companyId="12655" />);
    const button = await screen.findByRole('button', { name: 'Copy pod cURL' });
    const appendToBody = jest.spyOn(document.body, 'appendChild');

    try {
      fireEvent.click(button);
      expect(await screen.findByText('Pod cURL could not be copied')).toBeInTheDocument();
      expect(execCommand).not.toHaveBeenCalled();
      expect(appendToBody).not.toHaveBeenCalled();
      expect(document.querySelector('textarea')).toBeNull();
      expect(container).not.toHaveTextContent(POD_REQUEST_JSON);
      expect(container).not.toHaveTextContent(POD_URL);
      expect(container).not.toHaveTextContent(POD_API_KEY);
    } finally {
      appendToBody.mockRestore();
    }
  });

  test('does not materialize the command in the DOM after clipboard rejection', async () => {
    const writeText = jest.fn().mockRejectedValue(
      new Error(`PRIVATE ${POD_URL} ${POD_REQUEST_JSON} ${POD_API_KEY}`),
    );
    const execCommand = jest.fn(() => true);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommand,
    });
    const { container } = render(<DryRunJourney companyId="12655" />);
    const button = await screen.findByRole('button', { name: 'Copy pod cURL' });
    const appendToBody = jest.spyOn(document.body, 'appendChild');

    try {
      fireEvent.click(button);
      expect(await screen.findByText('Pod cURL could not be copied')).toBeInTheDocument();
      expect(writeText).toHaveBeenCalledWith(EXPECTED_POD_CURL);
      expect(execCommand).not.toHaveBeenCalled();
      expect(appendToBody).not.toHaveBeenCalled();
      expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument();
      expect(container).not.toHaveTextContent(POD_URL);
      expect(container).not.toHaveTextContent(POD_REQUEST_JSON);
      expect(container).not.toHaveTextContent(POD_API_KEY);
      expect(document.querySelector('textarea')).toBeNull();
      expect(screen.getByRole('button', { name: 'Copy pod cURL' })).toBeEnabled();
    } finally {
      appendToBody.mockRestore();
    }
  });

  test('routes a current pod-cURL 401 through the terminal unauthorized flow', async () => {
    const onSessionUnauthorized = jest.fn();
    getDryRunPodCurl.mockRejectedValue({
      kind: 'unauthorized',
      message: `PRIVATE ${POD_URL} ${POD_REQUEST_JSON} ${POD_API_KEY}`,
    });
    render(
      <DryRunJourney
        companyId="12655"
        routeKey="company:12655"
        onSessionUnauthorized={onSessionUnauthorized}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Copy pod cURL' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/reauthenticate in Fynd/i);
    expect(onSessionUnauthorized).toHaveBeenCalledWith('company:12655');
    expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy pod cURL' })).not.toBeInTheDocument();
  });

  test('clears a stale held selection when the current pod-cURL request returns 404', async () => {
    getDryRunPodCurl.mockRejectedValue({
      kind: 'not-found',
      message: `PRIVATE ${POD_URL} ${POD_REQUEST_JSON} ${POD_API_KEY}`,
    });
    render(<DryRunJourney companyId="12655" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Copy pod cURL' }));
    expect(await screen.findByText('Select another held journey to inspect.')).toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy pod cURL' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /VR-OLD/ })).toBeInTheDocument();
  });

  test('does not clear or copy the new selection when an old pod-cURL request later returns 404', async () => {
    const pending = deferred();
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    getDryRunPodCurl.mockReturnValueOnce(pending.promise);
    render(<DryRunJourney companyId="12655" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy pod cURL' }));

    fireEvent.click(screen.getByRole('button', { name: /VR-OLD/ }));
    expect(await screen.findByLabelText('Dry-run journey VR-OLD')).toBeInTheDocument();
    pending.reject({
      kind: 'not-found', message: `PRIVATE ${POD_URL} ${POD_REQUEST_JSON} ${POD_API_KEY}`,
    });
    await flush();

    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Dry-run journey VR-OLD')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy pod cURL' })).toBeEnabled();
    expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pod cURL copied/i)).not.toBeInTheDocument();
  });

  test('does not copy or stop a changed route session when the old request later returns 401', async () => {
    const pending = deferred();
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    getDryRunPodCurl.mockReturnValueOnce(pending.promise);
    const view = render(<DryRunJourney companyId="12655" routeKey="route-a" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy pod cURL' }));

    view.rerender(<DryRunJourney companyId="12655" routeKey="route-b" />);
    await waitFor(() => expect(getDryRunJourney).toHaveBeenCalledTimes(2));
    pending.reject({
      kind: 'unauthorized', message: `PRIVATE ${POD_URL} ${POD_REQUEST_JSON} ${POD_API_KEY}`,
    });
    await flush();

    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Copy pod cURL' })).toBeEnabled();
    expect(screen.queryByText(/reauthenticate/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pod cURL copied/i)).not.toBeInTheDocument();
  });

  test('does not copy or report after unmount while a pod-cURL request is pending', async () => {
    const pending = deferred();
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    getDryRunPodCurl.mockReturnValueOnce(pending.promise);
    const { unmount } = render(<DryRunJourney companyId="12655" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy pod cURL' }));

    unmount();
    pending.resolve(POD_ENVELOPE);
    await flush();

    expect(writeText).not.toHaveBeenCalled();
    expect(document.querySelector('textarea')).toBeNull();
  });

  test('downloads authenticated exact bytes and caches the Blob by job and request hash', async () => {
    jest.useFakeTimers();
    const exactBlob = new Blob(['exact bytes'], { type: 'application/json' });
    getDryRunRequestBlob.mockResolvedValue(exactBlob);
    const createObjectURL = jest.fn()
      .mockReturnValueOnce('blob:exact-request-1')
      .mockReturnValueOnce('blob:exact-request-2');
    const revokeObjectURL = jest.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<DryRunJourney companyId="12655" />);

    const download = await screen.findByRole('button', { name: 'Download diagnostic JSON' });
    fireEvent.click(download);
    await flush();
    expect(createObjectURL).toHaveBeenNthCalledWith(1, exactBlob);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await act(async () => jest.advanceTimersByTime(5000));
    fireEvent.click(screen.getByRole('button', { name: 'Download diagnostic JSON' }));
    await flush();

    expect(getDryRunRequestBlob).toHaveBeenCalledTimes(1);
    expect(getDryRunRequestBlob).toHaveBeenCalledWith({ companyId: '12655', jobId: 42 });
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenNthCalledWith(2, exactBlob);
    expect(click).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:exact-request-1');
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:exact-request-2');
    await act(async () => jest.advanceTimersByTime(1000));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:exact-request-2');
    click.mockRestore();
  });

  test('fetches a new body when the polled request hash changes', async () => {
    jest.useFakeTimers();
    const firstBlob = new Blob(['first exact bytes']);
    const secondBlob = new Blob(['second exact bytes']);
    getDryRunRequestBlob
      .mockResolvedValueOnce(firstBlob)
      .mockResolvedValueOnce(secondBlob);
    getDryRunJourney
      .mockResolvedValueOnce(detailFor(42, '1'.repeat(64)))
      .mockResolvedValue(detailFor(42, '2'.repeat(64)));
    const createObjectURL = jest.fn()
      .mockReturnValueOnce('blob:first')
      .mockReturnValueOnce('blob:second');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(<DryRunJourney companyId="12655" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Download diagnostic JSON' }));
    await flush();
    await act(async () => jest.advanceTimersByTime(5000));
    fireEvent.click(screen.getByRole('button', { name: 'Download diagnostic JSON' }));
    await flush();

    expect(getDryRunRequestBlob).toHaveBeenCalledTimes(2);
    expect(createObjectURL).toHaveBeenNthCalledWith(1, firstBlob);
    expect(createObjectURL).toHaveBeenNthCalledWith(2, secondBlob);
    click.mockRestore();
  });

  test('ignores a pending old-hash Blob after detail polling changes the request identity', async () => {
    jest.useFakeTimers();
    const oldHashBlob = deferred();
    getDryRunRequestBlob.mockReturnValueOnce(oldHashBlob.promise);
    getDryRunJourney
      .mockResolvedValueOnce(detailFor(42, '1'.repeat(64)))
      .mockResolvedValue(detailFor(42, '2'.repeat(64)));
    const createObjectURL = jest.fn(() => 'blob:stale-hash');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
    render(<DryRunJourney companyId="12655" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download diagnostic JSON' }));

    await act(async () => jest.advanceTimersByTime(5000));
    oldHashBlob.resolve(new Blob(['old hash exact bytes']));
    await flush();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  test('does not download an old selection Blob after selection changes', async () => {
    const oldBlob = deferred();
    getDryRunRequestBlob.mockReturnValue(oldBlob.promise);
    const createObjectURL = jest.fn(() => 'blob:stale');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
    render(<DryRunJourney companyId="12655" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download diagnostic JSON' }));
    fireEvent.click(screen.getByRole('button', { name: /VR-OLD/ }));
    await screen.findByLabelText('Dry-run journey VR-OLD');

    oldBlob.resolve(new Blob(['stale exact bytes']));
    await flush();
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  test('ignores an old company Blob 401 instead of stopping the new company session', async () => {
    const oldBlob = deferred();
    getDryRunRequestBlob.mockReturnValue(oldBlob.promise);
    const companyJob = { ...jobs[0], jobId: 99, documentNumber: 'VR-COMPANY-TWO' };
    listDryRuns.mockImplementation(({ companyId }) => Promise.resolve({
      items: companyId === '12655' ? jobs : [companyJob],
      nextBeforeId: null,
    }));
    getDryRunJourney.mockImplementation(({ jobId }) => {
      const value = detailFor();
      value.job = jobId === 99 ? companyJob : value.job;
      return Promise.resolve(value);
    });
    const { rerender } = render(<DryRunJourney companyId="12655" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download diagnostic JSON' }));
    rerender(<DryRunJourney companyId="99887" />);
    await screen.findByLabelText('Dry-run journey VR-COMPANY-TWO');

    oldBlob.reject({ kind: 'unauthorized' });
    await flush();
    expect(screen.queryByText(/reauthenticate/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Dry-run journey VR-COMPANY-TWO')).toBeInTheDocument();
  });

  test('revokes a created URL when link click throws', async () => {
    const revokeObjectURL = jest.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn(() => 'blob:failed-click') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('click failed');
    });
    render(<DryRunJourney companyId="12655" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download diagnostic JSON' }));
    await flush();

    expect(revokeObjectURL).toHaveBeenCalledWith('blob:failed-click');
    expect(screen.getByRole('status')).toHaveTextContent('could not be downloaded');
    click.mockRestore();
  });

  test('revokes outstanding object URLs on unmount before delayed cleanup', async () => {
    jest.useFakeTimers();
    const revokeObjectURL = jest.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: jest.fn(() => 'blob:unmount') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { unmount } = render(<DryRunJourney companyId="12655" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download diagnostic JSON' }));
    await flush();
    expect(revokeObjectURL).not.toHaveBeenCalled();

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:unmount');
    await act(async () => jest.runOnlyPendingTimers());
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  test('polls list and detail every five seconds only while visible and cleans up on unmount', async () => {
    jest.useFakeTimers();
    const { unmount } = render(<DryRunJourney companyId="12655" />);
    await flush();
    expect(listDryRuns).toHaveBeenCalledTimes(1);
    expect(getDryRunJourney).toHaveBeenCalledTimes(1);

    await act(async () => jest.advanceTimersByTime(5000));
    expect(listDryRuns).toHaveBeenCalledTimes(2);
    expect(getDryRunJourney).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => jest.advanceTimersByTime(10000));
    expect(listDryRuns).toHaveBeenCalledTimes(2);
    expect(getDryRunJourney).toHaveBeenCalledTimes(2);

    unmount();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => jest.advanceTimersByTime(10000));
    expect(listDryRuns).toHaveBeenCalledTimes(2);
  });

  test('does not overlap polling requests', async () => {
    jest.useFakeTimers();
    const pendingPoll = deferred();
    listDryRuns
      .mockResolvedValueOnce({ items: jobs, nextBeforeId: null })
      .mockReturnValueOnce(pendingPoll.promise);
    render(<DryRunJourney companyId="12655" />);
    await flush();

    await act(async () => jest.advanceTimersByTime(5000));
    await act(async () => jest.advanceTimersByTime(10000));
    expect(listDryRuns).toHaveBeenCalledTimes(2);

    pendingPoll.resolve({ items: jobs, nextBeforeId: null });
    await flush();
  });

  test('does not let a stale detail response overwrite a newer user selection', async () => {
    const oldSelection = deferred();
    getDryRunJourney.mockImplementation(({ jobId }) => (
      jobId === 42 ? oldSelection.promise : Promise.resolve(detailFor(41))
    ));
    render(<DryRunJourney companyId="12655" />);

    fireEvent.click(await screen.findByRole('button', { name: /VR-OLD/ }));
    expect(await screen.findByLabelText('Dry-run journey VR-OLD')).toBeInTheDocument();

    oldSelection.resolve(detailFor(42));
    await flush();
    expect(screen.getByLabelText('Dry-run journey VR-OLD')).toBeInTheDocument();
    expect(screen.queryByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`)).not.toBeInTheDocument();
  });

  test('does not let an old company response overwrite a changed route context', async () => {
    const oldCompany = deferred();
    const companyJob = {
      ...jobs[0],
      jobId: 99,
      shipmentId: 'shipment-company-two',
      documentNumber: 'VR-COMPANY-TWO',
    };
    listDryRuns.mockImplementation(({ companyId }) => (
      companyId === '12655'
        ? oldCompany.promise
        : Promise.resolve({ items: [companyJob], nextBeforeId: null })
    ));
    const companyDetail = detailFor();
    companyDetail.job = companyJob;
    companyDetail.normalizedSnapshot.shipmentId = companyJob.shipmentId;
    getDryRunJourney.mockResolvedValue(companyDetail);
    const { rerender } = render(<DryRunJourney companyId="12655" />);

    rerender(<DryRunJourney companyId="99887" />);
    expect(await screen.findByLabelText('Dry-run journey VR-COMPANY-TWO')).toBeInTheDocument();

    oldCompany.resolve({ items: jobs, nextBeforeId: null });
    await flush();
    expect(screen.getByLabelText('Dry-run journey VR-COMPANY-TWO')).toBeInTheDocument();
    expect(screen.queryByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(PRIMARY_DOCUMENT_NUMBER) })).not.toBeInTheDocument();
  });

  test('stops polling after unauthorized access and shows reauthentication guidance', async () => {
    jest.useFakeTimers();
    listDryRuns.mockRejectedValue({ kind: 'unauthorized', message: 'sanitized' });
    render(<DryRunJourney companyId="12655" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/reauthenticate/i);
    await act(async () => jest.advanceTimersByTime(15000));
    expect(listDryRuns).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Polling stopped · reauthenticate')).toBeInTheDocument();
  });

  test('keeps current-session unauthorized terminal when an in-flight poll later succeeds', async () => {
    jest.useFakeTimers();
    const pendingPoll = deferred();
    listDryRuns
      .mockResolvedValueOnce({ items: jobs, nextBeforeId: null })
      .mockReturnValueOnce(pendingPoll.promise);
    getDryRunRequestBlob.mockRejectedValue({ kind: 'unauthorized' });
    render(<DryRunJourney companyId="12655" />);
    await screen.findByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`);

    await act(async () => jest.advanceTimersByTime(5000));
    fireEvent.click(screen.getByRole('button', { name: 'Download diagnostic JSON' }));
    await flush();
    expect(screen.getByText(/reauthenticate in Fynd/i)).toBeInTheDocument();
    pendingPoll.resolve({ items: jobs, nextBeforeId: null });
    await flush();

    expect(screen.getByText(/reauthenticate in Fynd/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`)).not.toBeInTheDocument();
    await act(async () => jest.advanceTimersByTime(10000));
    expect(listDryRuns).toHaveBeenCalledTimes(2);
  });

  test('retains authorized journey evidence and the lock warning across a transient list failure', async () => {
    jest.useFakeTimers();
    listDryRuns
      .mockResolvedValueOnce({ items: jobs, nextBeforeId: null })
      .mockRejectedValueOnce({ kind: 'request-failed', message: 'sanitized' })
      .mockResolvedValue({ items: jobs, nextBeforeId: null });
    render(<DryRunJourney companyId="12655" />);
    await screen.findByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`);

    await act(async () => jest.advanceTimersByTime(5000));
    expect(screen.getByRole('alert')).toHaveTextContent('Dry-run data could not be loaded.');
    expect(screen.getByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`)).toBeInTheDocument();
    expect(screen.getByText(/real shipment is locked/i)).toBeInTheDocument();
    expect(screen.getByText(/manual cleanup is required/i)).toBeInTheDocument();

    await act(async () => jest.advanceTimersByTime(5000));
    await flush();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`)).toBeInTheDocument();
  });

  test('retains authorized journey evidence across a transient detail failure and clears the banner on recovery', async () => {
    jest.useFakeTimers();
    getDryRunJourney
      .mockResolvedValueOnce(detailFor())
      .mockRejectedValueOnce({ kind: 'request-failed', message: 'sanitized' })
      .mockResolvedValue(detailFor());
    render(<DryRunJourney companyId="12655" />);
    await screen.findByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`);

    await act(async () => jest.advanceTimersByTime(5000));
    expect(screen.getByRole('alert')).toHaveTextContent('Dry-run data could not be loaded.');
    expect(screen.getByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`)).toBeInTheDocument();
    expect(screen.getByText(/manual cleanup is required/i)).toBeInTheDocument();

    await act(async () => jest.advanceTimersByTime(5000));
    await flush();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`)).toBeInTheDocument();
  });

  test('returns to list state when the selected held job disappears', async () => {
    getDryRunJourney.mockRejectedValue({ kind: 'not-found', message: 'sanitized' });
    render(<DryRunJourney companyId="12655" />);

    expect(await screen.findByText('Select another held journey to inspect.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /VR-OLD/ })).toBeInTheDocument();
  });

  test('keeps 404 list state through fresh polls until the user explicitly selects', async () => {
    jest.useFakeTimers();
    const freshJob = { ...jobs[1], jobId: 40, documentNumber: 'VR-FRESH' };
    listDryRuns
      .mockResolvedValueOnce({ items: jobs, nextBeforeId: null })
      .mockResolvedValue({ items: [freshJob, ...jobs], nextBeforeId: null });
    getDryRunJourney
      .mockRejectedValueOnce({ kind: 'not-found' })
      .mockImplementation(({ jobId }) => Promise.resolve(detailFor(jobId === 41 ? 41 : 42)));
    render(<DryRunJourney companyId="12655" />);
    expect(await screen.findByText('Select another held journey to inspect.')).toBeInTheDocument();

    await act(async () => jest.advanceTimersByTime(10000));
    expect(screen.getByRole('button', { name: /VR-FRESH/ })).toBeInTheDocument();
    expect(getDryRunJourney).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Select another held journey to inspect.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /VR-OLD/ }));
    expect(await screen.findByLabelText('Dry-run journey VR-OLD')).toBeInTheDocument();
    expect(getDryRunJourney).toHaveBeenCalledTimes(2);
  });

  test('labels hidden polling as paused and visible polling as active', async () => {
    render(<DryRunJourney companyId="12655" />);
    await screen.findByLabelText(`Dry-run journey ${PRIMARY_DOCUMENT_NUMBER}`);
    expect(screen.getByText('Visible · polling 5s')).toBeInTheDocument();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.getByText('Hidden · polling paused')).toBeInTheDocument();
    const pollDot = document.querySelector('.dry-run-poll-dot');
    expect(pollDot).not.toBeNull();
    expect(pollDot.parentElement).toHaveClass('dry-run-poll-status-paused');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.getByText('Visible · polling 5s')).toBeInTheDocument();
  });

  test('labels held time as a timestamp with timezone semantics', async () => {
    render(<DryRunJourney companyId="12655" />);
    const newest = await screen.findByRole('button', { name: new RegExp(PRIMARY_DOCUMENT_NUMBER) });
    expect(newest).toHaveTextContent(/Held at .*(UTC|GMT)/);
  });

  test('shows a sanitized operational error without raw server detail', async () => {
    listDryRuns.mockRejectedValue({
      kind: 'request-failed',
      message: 'Dry-run data could not be loaded.',
      response: { data: { message: 'postgres password and customer address' } },
    });
    render(<DryRunJourney companyId="12655" />);

    expect(await screen.findByText('Dry-run data could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText(/postgres password/i)).not.toBeInTheDocument();
  });

});
