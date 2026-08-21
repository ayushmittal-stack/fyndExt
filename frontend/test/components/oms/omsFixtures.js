export const shipmentPage = {
  items: [
    {
      shipmentId: 'shipment-100', jobId: 100, documentNumber: 'INV-100', lastStage: 'OEIS_SUBMISSION',
      lastAction: 'OEIS_RESPONSE_RECEIVED', lastOutcome: 'SUCCESS', lastSafeCode: null,
      firstOccurredAt: '2026-08-19T09:00:00.000Z', lastOccurredAt: '2026-08-19T10:00:00.000Z', version: 1,
    },
    {
      shipmentId: 'shipment-99', jobId: 99, documentNumber: null, lastStage: 'FYND_LOCK',
      lastAction: 'FYND_LOCK_FAILED', lastOutcome: 'TIMEOUT', lastSafeCode: 'LOCK_TIMEOUT',
      firstOccurredAt: '2026-08-19T08:00:00.000Z', lastOccurredAt: '2026-08-19T08:30:00.000Z', version: 1,
    },
  ],
  nextBefore: 'cursor-99',
};

export const nextShipmentPage = {
  items: [
    shipmentPage.items[1],
    {
      shipmentId: 'shipment-98', jobId: 98, documentNumber: 'INV-98', lastStage: 'JOB',
      lastAction: 'JOB_COMPLETED', lastOutcome: 'SUCCESS', lastSafeCode: null,
      firstOccurredAt: '2026-08-19T07:00:00.000Z', lastOccurredAt: '2026-08-19T07:30:00.000Z', version: 1,
    },
  ],
  nextBefore: null,
};

export const timelinePage = {
  shipmentId: 'shipment-100',
  items: [
    {
      jobId: 100, documentNumber: 'INV-100', stage: 'WEBHOOK', action: 'WEBHOOK_RECEIVED', outcome: 'SUCCESS',
      attemptNumber: 0, startedAt: '2026-08-19T09:00:00.000Z', completedAt: '2026-08-19T09:00:00.000Z',
      durationMs: 0, queueDelayMs: null, retryDelayMs: null, nextAttemptAt: null, safeCode: null,
      requestSummary: null, responseSummary: null, artifactJobId: null, occurredAt: '2026-08-19T09:00:00.000Z',
    },
    {
      jobId: 100, documentNumber: 'INV-100', stage: 'FYND_LOCK', action: 'FYND_LOCK_CONFIRMED', outcome: 'SUCCESS',
      attemptNumber: 1, startedAt: '2026-08-19T09:01:00.000Z', completedAt: '2026-08-19T09:01:01.000Z',
      durationMs: 1000, queueDelayMs: 250, retryDelayMs: null, nextAttemptAt: null, safeCode: null,
      requestSummary: null, responseSummary: { kind: 'FYND_RESPONSE', operation: 'LOCK', shipmentId: 'shipment-100', documentNumber: 'INV-100', responseStatus: 200, locked: true, shipmentState: 'locked', finalStateClassification: 'LOCKED', retryable: false, latencyMs: 1000 }, artifactJobId: 700, occurredAt: '2026-08-19T09:01:01.000Z',
    },
    {
      jobId: 100, documentNumber: 'INV-100', stage: 'RETRY', action: 'RETRY_SCHEDULED', outcome: 'RETRY_SCHEDULED',
      attemptNumber: 2, startedAt: '2026-08-19T09:02:00.000Z', completedAt: '2026-08-19T09:02:00.000Z',
      durationMs: 0, queueDelayMs: null, retryDelayMs: 60000, nextAttemptAt: '2026-08-19T09:03:00.000Z', safeCode: 'OEIS_RETRY',
      requestSummary: null, responseSummary: null, artifactJobId: null, occurredAt: '2026-08-19T09:02:00.000Z',
    },
  ],
  nextBefore: 'timeline-cursor-100',
};

export const olderTimelinePage = {
  shipmentId: 'shipment-100',
  items: [
    {
      jobId: 100, documentNumber: 'INV-100', stage: 'VALIDATION', action: 'VALIDATION_PASSED', outcome: 'SUCCESS',
      attemptNumber: 0, startedAt: '2026-08-19T08:59:00.000Z', completedAt: '2026-08-19T08:59:00.000Z',
      durationMs: 0, queueDelayMs: null, retryDelayMs: null, nextAttemptAt: null, safeCode: null,
      requestSummary: null, responseSummary: null, artifactJobId: null, occurredAt: '2026-08-19T08:59:00.000Z',
    },
    timelinePage.items[0],
  ],
  nextBefore: null,
};

export const dryRunJourney = {
  mode: 'dry-run',
  job: { jobId: 100, shipmentId: 'shipment-100', documentNumber: 'INV-100', state: 'SUBMISSION_HELD' },
  normalizedSnapshot: { shipmentId: 'shipment-100', branchCode: 'DXB', customerName: 'must not render' },
  steps: {
    payloadPreparation: { status: 'completed', requestHash: 'a'.repeat(64), requestBytes: 63, withinLimit: true, privateNote: 'must not render' },
    fyndLock: {
      status: 'completed', operation: 'platform.order.updateShipmentLock',
      request: { body: {
        entity_type: 'shipments', action: 'lock', action_type: 'complete',
        entities: [{ id: 'shipment-100', reason_text: 'OEIS invoice INV-100', privateField: 'must not render' }],
        privateField: 'must not render',
      } },
      result: { locked: true },
    },
    oeisSubmission: { status: 'held', method: 'POST', bodyFileName: 'INV-100-oeis-request.json', sanitized: true, warning: 'Sanitized diagnostic only', url: 'https://private.example/', curl: 'secret' },
    fyndTransition: {
      status: 'blocked', operation: 'platform.order.updateShipmentStatus', executable: false,
      requestTemplate: { body: {
        task: false, force_transition: false, unlock_before_transition: true, lock_after_transition: false,
        statuses: [{
          status: 'bag_invoiced',
          shipments: [{
            identifier: 'shipment-100', products: [],
            data_updates: {
              products: [{ data: { store_invoice_id: '$OEIS_RESPONSE.InvoiceNumber[0:25]' } }],
              entities: [{ data: { store_invoice_id: '$OEIS_RESPONSE.InvoiceNumber[0:25]' } }],
            },
            privateField: 'must not render',
          }],
          privateField: 'must not render',
        }],
        privateField: 'must not render',
      } },
    },
  },
};

export const heldPage = {
  items: [
    {
      jobId: 100, shipmentId: 'shipment-100', documentNumber: 'INV-100', state: 'SUBMISSION_HELD',
      lockedAt: '2026-08-19T09:01:00.000Z', createdAt: '2026-08-19T09:00:00.000Z',
      updatedAt: '2026-08-19T09:01:00.000Z', version: 1,
    },
    {
      jobId: 99, shipmentId: 'held-99', documentNumber: 'INV-99', state: 'SUBMISSION_HELD',
      lockedAt: null, createdAt: '2026-08-19T08:00:00.000Z',
      updatedAt: '2026-08-19T08:00:00.000Z', version: 1,
    },
  ],
  nextBeforeId: 99,
};

export const nextHeldPage = {
  items: [heldPage.items[1], {
    jobId: 98, shipmentId: 'held-98', documentNumber: 'INV-98', state: 'SUBMISSION_HELD',
    lockedAt: '2026-08-19T07:00:00.000Z', createdAt: '2026-08-19T06:59:00.000Z',
    updatedAt: '2026-08-19T07:00:00.000Z', version: 1,
  }],
  nextBeforeId: null,
};

export const jobFailurePage = {
  items: [
    {
      jobId: 70, shipmentId: 'failed-70', documentNumber: 'INV-70', state: 'DATA_FAILED',
      failureCode: 'LOCAL_VALIDATION_FAILED', failureMessage: 'Invoice data failed local validation.',
      attemptCount: 2, lockRecordedAt: null, createdAt: '2026-08-19T06:00:00.000Z',
      failedAt: '2026-08-19T06:01:00.000Z', version: 2,
    },
  ],
  nextBeforeId: 70,
};

export const preJobFailurePage = {
  items: [
    {
      shipmentId: 'failed-70', jobId: null, documentNumber: null, lastStage: 'VALIDATION',
      lastAction: 'VALIDATION_FAILED', lastOutcome: 'FAILURE', lastSafeCode: 'DUPLICATE_SENTINEL',
      firstOccurredAt: '2026-08-19T05:00:00.000Z', lastOccurredAt: '2026-08-19T05:01:00.000Z', version: 1,
    },
    {
      shipmentId: 'prejob-60', jobId: null, documentNumber: null, lastStage: 'VALIDATION',
      lastAction: 'VALIDATION_FAILED', lastOutcome: 'FAILURE', lastSafeCode: 'CURRENCY_UNSUPPORTED',
      firstOccurredAt: '2026-08-19T04:00:00.000Z', lastOccurredAt: '2026-08-19T04:01:00.000Z', version: 1,
    },
  ],
  nextBefore: 'prejob-cursor-60',
};

test('provides bounded recent-activity pages for OMS component tests', () => {
  expect(shipmentPage.items).toHaveLength(2);
  expect(shipmentPage.nextBefore).toBe('cursor-99');
  expect(nextShipmentPage.nextBefore).toBeNull();
});
