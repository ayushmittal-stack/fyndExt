import {
  QUEUE_IDS,
  actionLabel,
  appendUniqueRows,
  buildPodCurl,
  canCopyPodCurl,
  eventIdentity,
  filterLoadedRows,
  formatDuration,
  formatUtc,
  normalizeHeldRow,
  normalizeJobFailureRow,
  normalizePreJobFailureRow,
  normalizeShipmentRow,
  outcomeLabel,
  projectDiagnosticSnapshot,
  stageLabel,
  statusTone,
} from '../../../components/oms/omsModel';

test('normalizes each queue response into the shared OMS row shape', () => {
  expect(normalizeShipmentRow({
    shipmentId: 'shipment-1', jobId: 7, documentNumber: 'INV-1', lastStage: 'OEIS_SUBMISSION',
    lastAction: 'OEIS_RESPONSE_RECEIVED', lastOutcome: 'SUCCESS', lastSafeCode: null,
    lastOccurredAt: '2026-08-19T10:00:00.000Z',
  })).toEqual({
    key: 'shipments:shipment-1:7', raw: expect.any(Object),
    source: 'shipments', shipmentId: 'shipment-1', jobId: 7, documentNumber: 'INV-1',
    stage: 'OEIS_SUBMISSION', action: 'OEIS_RESPONSE_RECEIVED', outcome: 'SUCCESS',
    safeCode: null, updatedAt: '2026-08-19T10:00:00.000Z', failureMessage: null, attemptCount: null,
  });
  expect(normalizeHeldRow({
    jobId: 8, shipmentId: 'shipment-2', documentNumber: 'INV-2', createdAt: '2026-08-19T09:00:00.000Z',
  })).toEqual({
    key: 'held:8', raw: expect.any(Object), failureMessage: null, attemptCount: null,
    source: 'held', shipmentId: 'shipment-2', jobId: 8, documentNumber: 'INV-2',
    stage: 'OEIS_SUBMISSION', action: 'OEIS_SUBMISSION_HELD', outcome: 'HELD',
    safeCode: null, updatedAt: '2026-08-19T09:00:00.000Z',
  });
  expect(normalizeJobFailureRow({
    jobId: 9, shipmentId: 'shipment-3', documentNumber: null, state: 'DATA_FAILED',
    failureCode: 'PAYLOAD_INVALID', failureMessage: 'Bad payload', attemptCount: 2,
    failedAt: '2026-08-19T08:00:00.000Z',
  })).toEqual({
    key: 'failures:job:9', raw: expect.any(Object),
    source: 'failures', shipmentId: 'shipment-3', jobId: 9, documentNumber: null,
    state: 'DATA_FAILED',
    stage: 'JOB', action: 'JOB_DATA_FAILED', outcome: 'FAILURE', safeCode: 'PAYLOAD_INVALID',
    updatedAt: '2026-08-19T08:00:00.000Z', failureMessage: 'Bad payload', attemptCount: 2,
  });
  expect(normalizePreJobFailureRow({
    shipmentId: 'shipment-4', lastStage: 'WEBHOOK', lastAction: 'WEBHOOK_REJECTED',
    lastOutcome: 'FAILURE', lastSafeCode: 'WEBHOOK_REJECTED',
    lastOccurredAt: '2026-08-19T07:00:00.000Z',
  })).toEqual({
    key: 'failures:prejob:shipment-4', raw: expect.any(Object), failureMessage: null, attemptCount: null,
    source: 'failures', shipmentId: 'shipment-4', jobId: null, documentNumber: null,
    stage: 'WEBHOOK', action: 'WEBHOOK_REJECTED', outcome: 'FAILURE',
    safeCode: 'WEBHOOK_REJECTED', updatedAt: '2026-08-19T07:00:00.000Z',
  });
});

test.each([
  ['WEBHOOK', 'Webhook receipt', stageLabel], ['JOB', 'Shipment job', stageLabel],
  ['VALIDATION', 'Local validation', stageLabel], ['PAYLOAD', 'Invoice payload', stageLabel],
  ['FYND_LOCK', 'Fynd invoice lock', stageLabel], ['OEIS_SUBMISSION', 'OEIS submission', stageLabel],
  ['OEIS_ARTIFACT', 'OEIS artifact', stageLabel], ['OUTBOX', 'Outbox delivery', stageLabel],
  ['FYND_TRANSITION', 'Fynd shipment transition', stageLabel], ['RETRY', 'Retry scheduling', stageLabel],
  ['LEASE', 'Lease recovery', stageLabel], ['MIGRATION', 'Legacy migration', stageLabel],
  ['WEBHOOK_RECEIVED', 'Webhook received', actionLabel], ['WEBHOOK_ACCEPTED', 'Webhook accepted', actionLabel],
  ['WEBHOOK_DUPLICATE', 'Duplicate webhook recognized', actionLabel], ['WEBHOOK_IGNORED', 'Webhook ignored', actionLabel],
  ['WEBHOOK_REJECTED', 'Webhook rejected', actionLabel], ['JOB_CLAIMED', 'Job claimed', actionLabel],
  ['VALIDATION_STARTED', 'Local validation started', actionLabel], ['VALIDATION_PASSED', 'Local validation passed', actionLabel],
  ['VALIDATION_FAILED', 'Local validation failed', actionLabel], ['PAYLOAD_PREPARED', 'Invoice payload prepared', actionLabel],
  ['FYND_LOCK_REQUESTED', 'Fynd invoice lock requested', actionLabel], ['FYND_LOCK_CONFIRMED', 'Fynd invoice lock confirmed', actionLabel],
  ['FYND_LOCK_FAILED', 'Fynd invoice lock failed', actionLabel], ['FYND_LOCK_READBACK', 'Fynd invoice lock readback', actionLabel],
  ['OEIS_SUBMISSION_HELD', 'OEIS submission held', actionLabel], ['OEIS_SUBMISSION_REQUESTED', 'OEIS submission requested', actionLabel],
  ['OEIS_RESPONSE_RECEIVED', 'OEIS response received', actionLabel], ['OEIS_SUBMISSION_FAILED', 'OEIS submission failed', actionLabel],
  ['OEIS_ARTIFACT_STORED', 'OEIS artifact stored', actionLabel], ['OUTBOX_CLAIMED', 'Outbox claimed', actionLabel],
  ['FYND_TRANSITION_REQUESTED', 'Fynd shipment transition requested', actionLabel], ['FYND_TRANSITION_CONFIRMED', 'Fynd shipment transition confirmed', actionLabel],
  ['FYND_TRANSITION_FAILED', 'Fynd shipment transition failed', actionLabel], ['FYND_TRANSITION_READBACK', 'Fynd shipment transition readback', actionLabel],
  ['RETRY_SCHEDULED', 'Retry scheduled', actionLabel], ['LEASE_RECOVERED', 'Lease recovered', actionLabel],
  ['JOB_DATA_FAILED', 'Job data failed', actionLabel], ['JOB_INDETERMINATE', 'Job indeterminate', actionLabel],
  ['JOB_COMPLETED', 'Job completed', actionLabel], ['LEGACY_STATE_IMPORTED', 'Legacy state imported', actionLabel],
  ['SUCCESS', 'Success', outcomeLabel],
  ['FAILURE', 'Failure', outcomeLabel], ['TIMEOUT', 'Timeout', outcomeLabel], ['HELD', 'Held', outcomeLabel],
  ['STARTED', 'Started', outcomeLabel], ['INDETERMINATE', 'Indeterminate', outcomeLabel],
])('uses trusted labels for %s', (value, expected, label) => {
  expect(label(value)).toBe(expected);
});

test('formats invalid dates safely and duration values compactly', () => {
  expect(formatUtc('invalid')).toBe('Time unavailable');
  expect(formatUtc(null)).toBe('Time unavailable');
  expect(formatUtc(undefined)).toBe('Time unavailable');
  expect(formatUtc('')).toBe('Time unavailable');
  expect(formatDuration(999)).toBe('999 ms');
  expect(formatDuration(1200)).toBe('1.2 s');
  expect(formatDuration(62000)).toBe('1 min 2 s');
});

test('filters only loaded rows by case-insensitive identifiers and exact filters', () => {
  const rows = [
    { shipmentId: 'SHIP-A', documentNumber: 'Invoice-1', safeCode: 'LOCK_TIMEOUT', stage: 'FYND_LOCK', outcome: 'TIMEOUT' },
    { shipmentId: 'SHIP-B', documentNumber: null, safeCode: null, stage: 'JOB', outcome: 'SUCCESS' },
  ];
  expect(filterLoadedRows(rows, { search: 'invoice', stage: '', outcome: '' })).toEqual([rows[0]]);
  expect(filterLoadedRows(rows, { search: 'timeout', stage: 'FYND_LOCK', outcome: 'TIMEOUT' })).toEqual([rows[0]]);
  expect(filterLoadedRows(rows, { search: 'ship', stage: 'JOB', outcome: 'SUCCESS' })).toEqual([rows[1]]);
});

test('deduplicates stable server order with a source identity', () => {
  const first = { source: 'shipments', shipmentId: 's-1', jobId: 1, updatedAt: 'one' };
  const duplicate = { ...first, updatedAt: 'two' };
  const second = { source: 'shipments', shipmentId: 's-2', jobId: 2 };
  expect(eventIdentity(first)).toBe(eventIdentity(duplicate));
  expect(appendUniqueRows([first], [duplicate, second])).toEqual([first, second]);
});

test('allowlists only own data diagnostic fields without fabricating nested values', () => {
  const accessor = {};
  Object.defineProperty(accessor, 'shipmentId', { enumerable: true, get: () => { throw new Error('getter called'); } });
  expect(projectDiagnosticSnapshot(accessor)).toEqual({});
  expect(projectDiagnosticSnapshot({
    shipmentId: 's-1', currency: 'SAR', buyerName: 'private',
    taxEligibility: { reasonCode: 'A', nationalId: 'private' },
    bags: [{ bagId: 'bag-1', quantity: 1, private: 'nope' }], deliveryCharge: null,
  })).toEqual({
    shipmentId: 's-1', currency: 'SAR', taxEligibility: { reasonCode: 'A' },
    bags: [{ bagId: 'bag-1', quantity: 1 }], deliveryCharge: null,
  });
});

test('builds an eligible pod curl using POSIX single quoting without DOM output', () => {
  const detail = {
    mode: 'dry-run', job: { state: 'SUBMISSION_HELD' },
    steps: { fyndLock: { status: 'completed', result: { locked: true } }, oeisSubmission: { status: 'held' } },
  };
  expect(canCopyPodCurl(detail)).toBe(true);
  [
    { ...detail, mode: 'live' }, { ...detail, job: { state: 'COMPLETED' } },
    { ...detail, steps: { ...detail.steps, fyndLock: { status: 'pending', result: { locked: true } } } },
    { ...detail, steps: { ...detail.steps, fyndLock: { status: 'completed', result: { locked: false } } } },
    { ...detail, steps: { ...detail.steps, oeisSubmission: { status: 'submitted' } } },
  ].forEach(ineligible => expect(canCopyPodCurl(ineligible)).toBe(false));
  expect(buildPodCurl({
    method: 'POST', url: 'https://oeis.test/$()', apiKey: 'key`value',
    requestJson: "{\"note\":\"O'Reilly $(id) `date`\nnext\"}",
  })).toBe(
    "curl --silent --show-error --max-redirs 0 \\\n" +
    "  --request POST \\\n" +
    "  --url 'https://oeis.test/$()' \\\n" +
    "  --header 'Authorization: APIkey key`value' \\\n" +
    "  --header 'Connection: keep-alive' \\\n" +
    "  --header 'Content-Type: application/json' \\\n" +
    "  --data-binary '{\"note\":\"O'\"'\"'Reilly $(id) `date`\nnext\"}'",
  );
  expect(QUEUE_IDS).toEqual({ SHIPMENTS: 'shipments', HELD: 'held', FAILURES: 'failures' });
  expect(statusTone('RETRY_SCHEDULED')).toBe('info');
});
