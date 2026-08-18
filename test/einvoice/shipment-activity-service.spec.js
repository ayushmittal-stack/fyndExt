'use strict';

const { EinvoiceError } = require('../../src/einvoice/errors');
const {
  createAuditEvent,
  createEventKey,
  createOperationKey,
  sanitizeFyndSummary,
  sanitizeOeisSummary,
} = require('../../src/einvoice/audit/audit-contract');
const {
  encodeHeadCursor,
  encodeTimelineCursor,
} = require('../../src/einvoice/audit/audit-cursor');
const {
  createShipmentActivityService,
} = require('../../src/einvoice/shipment-activity-service');

const NOW = '2026-08-18T00:00:00.000Z';
const COMPANY_ID = '15862';
const SHIPMENT_ID = '17869621195841424928';
const DOCUMENT_NUMBER = `VR-${SHIPMENT_ID}-1`;

function eventAt({
  occurredAt,
  parentVersion,
  action = 'VALIDATION_PASSED',
  outcome = 'SUCCESS',
  safeCode = null,
  shipmentId = SHIPMENT_ID,
  jobId = 42,
  documentNumber = DOCUMENT_NUMBER,
} = {}) {
  const stage = action.startsWith('VALIDATION_') ? 'VALIDATION' : 'JOB';
  const eventKey = createEventKey({
    kind: 'ENTITY',
    companyId: COMPANY_ID,
    shipmentId,
    scopeKind: 'JOB',
    scopeId: String(jobId),
    parentVersion,
    attemptNumber: 1,
    stage,
    action,
    outcome,
  });
  return createAuditEvent({
    eventKey,
    operationKey: null,
    companyId: COMPANY_ID,
    applicationId: 'app-1',
    shipmentId,
    jobId,
    documentNumber,
    stage,
    action,
    outcome,
    attemptNumber: 1,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode,
    requestSummary: null,
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(occurredAt) });
}

function headFor(event, overrides = {}) {
  return Object.freeze({
    companyId: event.companyId,
    shipmentId: event.shipmentId,
    jobId: event.jobId,
    documentNumber: event.documentNumber,
    lastStage: event.stage,
    lastAction: event.action,
    lastOutcome: event.outcome,
    lastSafeCode: event.safeCode,
    firstOccurredAt: event.occurredAt,
    lastOccurredAt: event.occurredAt,
    lastEventKey: event.eventKey,
    expiresAt: event.expiresAt,
    version: 0,
    ...overrides,
  });
}

function preJobFailureEventAt({
  occurredAt,
  shipmentId,
  action = 'VALIDATION_FAILED',
  safeCode = action === 'WEBHOOK_REJECTED' ? 'WEBHOOK_INVALID' : 'LOCAL_VALIDATION_FAILED',
} = {}) {
  const stage = action === 'WEBHOOK_REJECTED' ? 'WEBHOOK'
    : action === 'VALIDATION_FAILED' ? 'VALIDATION' : 'JOB';
  const eventKey = createEventKey({
    kind: 'ENTITY',
    companyId: COMPANY_ID,
    shipmentId,
    scopeKind: 'WEBHOOK',
    scopeId: `event-${shipmentId}`,
    parentVersion: 0,
    attemptNumber: 0,
    stage,
    action,
    outcome: 'FAILURE',
  });
  return createAuditEvent({
    eventKey,
    operationKey: null,
    companyId: COMPANY_ID,
    applicationId: 'app-private-not-public',
    shipmentId,
    jobId: null,
    documentNumber: null,
    stage,
    action,
    outcome: 'FAILURE',
    attemptNumber: 0,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode,
    requestSummary: null,
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(occurredAt) });
}

function operationEventAt({
  occurredAt,
  stage,
  requestedAction,
  action,
  outcome,
  requestSummary = null,
  responseSummary = null,
  artifactJobId = null,
  safeCode = null,
  startedAt = null,
}) {
  const operationKey = createOperationKey({
    targetKind: 'JOB',
    targetId: '42',
    expectedParentVersion: 1,
    attemptNumber: 1,
    stage,
    action: requestedAction,
  });
  return createAuditEvent({
    eventKey: createEventKey({
      kind: 'OPERATION', operationKey, stage, action, outcome,
    }),
    operationKey,
    companyId: COMPANY_ID,
    applicationId: 'app-1',
    shipmentId: SHIPMENT_ID,
    jobId: 42,
    documentNumber: DOCUMENT_NUMBER,
    stage,
    action,
    outcome,
    attemptNumber: 1,
    startedAt: new Date(startedAt || occurredAt),
    completedAt: outcome === 'STARTED' ? null : new Date(occurredAt),
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode,
    requestSummary,
    responseSummary,
    artifactJobId,
  }, { now: () => new Date(occurredAt) });
}

function artifactEventAt(occurredAt, responseSummary) {
  const eventKey = createEventKey({
    kind: 'ENTITY',
    companyId: COMPANY_ID,
    shipmentId: SHIPMENT_ID,
    scopeKind: 'JOB',
    scopeId: '42',
    parentVersion: 2,
    attemptNumber: 1,
    stage: 'OEIS_ARTIFACT',
    action: 'OEIS_ARTIFACT_STORED',
    outcome: 'SUCCESS',
  });
  return createAuditEvent({
    eventKey,
    operationKey: null,
    companyId: COMPANY_ID,
    applicationId: 'app-1',
    shipmentId: SHIPMENT_ID,
    jobId: 42,
    documentNumber: DOCUMENT_NUMBER,
    stage: 'OEIS_ARTIFACT',
    action: 'OEIS_ARTIFACT_STORED',
    outcome: 'SUCCESS',
    attemptNumber: 1,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: null,
    responseSummary,
    artifactJobId: 42,
  }, { now: () => new Date(occurredAt) });
}

function repositoryWith({ heads, failures, events } = {}) {
  return {
    listShipmentAuditHeadsForCompany: jest.fn(async () => heads || {
      items: [], nextBefore: null,
    }),
    listPreJobFailureHeadsForCompany: jest.fn(async () => failures || {
      items: [], nextBefore: null,
    }),
    listShipmentAuditEventsForCompany: jest.fn(async () => events || {
      items: [], nextBefore: null,
    }),
  };
}

function serviceWith(repository, now = () => new Date(NOW)) {
  return createShipmentActivityService({ repository, now });
}

async function expectSafeRejection(promise, code, message) {
  const error = await promise.catch(value => value);
  expect(error).toBeInstanceOf(EinvoiceError);
  expect(error).toMatchObject({ code, message, retryable: false });
  expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false);
}

describe('shipment activity service', () => {
  test('returns an exact frozen service surface', () => {
    const service = serviceWith(repositoryWith());
    expect(Reflect.ownKeys(service)).toEqual([
      'listShipments', 'listPreJobFailures', 'getTimeline',
    ]);
    expect(Object.isFrozen(service)).toBe(true);
    expect(typeof service.listShipments).toBe('function');
    expect(typeof service.listPreJobFailures).toBe('function');
    expect(typeof service.getTimeline).toBe('function');
  });

  test('lists newest-first shipment heads and encodes the exact continuation tuple', async () => {
    const newest = eventAt({
      occurredAt: '2026-08-17T12:00:00.000Z', parentVersion: 2,
    });
    const older = eventAt({
      occurredAt: '2026-08-17T11:00:00.000Z',
      parentVersion: 1,
      shipmentId: '17869621195841424927',
      jobId: 41,
      documentNumber: 'VR-17869621195841424927-1',
    });
    const repository = repositoryWith({
      heads: {
        items: [headFor(newest, { version: 2 }), headFor(older, { version: 1 })],
        nextBefore: {
          lastOccurredAt: older.occurredAt,
          shipmentId: older.shipmentId,
        },
      },
    });
    const result = await serviceWith(repository).listShipments({
      companyId: COMPANY_ID, limit: 2, before: null,
    });

    expect(repository.listShipmentAuditHeadsForCompany).toHaveBeenCalledWith({
      companyId: COMPANY_ID, limit: 2, before: null,
    });
    expect(result).toEqual({
      items: [
        {
          shipmentId: newest.shipmentId,
          jobId: newest.jobId,
          documentNumber: newest.documentNumber,
          lastStage: 'VALIDATION',
          lastAction: 'VALIDATION_PASSED',
          lastOutcome: 'SUCCESS',
          lastSafeCode: null,
          firstOccurredAt: newest.occurredAt,
          lastOccurredAt: newest.occurredAt,
          version: 2,
        },
        {
          shipmentId: older.shipmentId,
          jobId: older.jobId,
          documentNumber: older.documentNumber,
          lastStage: 'VALIDATION',
          lastAction: 'VALIDATION_PASSED',
          lastOutcome: 'SUCCESS',
          lastSafeCode: null,
          firstOccurredAt: older.occurredAt,
          lastOccurredAt: older.occurredAt,
          version: 1,
        },
      ],
      nextBefore: encodeHeadCursor({
        lastOccurredAt: older.occurredAt,
        shipmentId: older.shipmentId,
      }),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
    expect(result.items[0]).not.toHaveProperty('companyId');
    expect(result.items[0]).not.toHaveProperty('lastEventKey');
    expect(result.items[0]).not.toHaveProperty('expiresAt');
  });

  test('independently paginates and privacy-projects both pre-job failure actions', async () => {
    const newest = preJobFailureEventAt({
      shipmentId: 'pre-job-validation', action: 'VALIDATION_FAILED',
      occurredAt: '2026-08-17T12:00:00.000Z',
    });
    const older = preJobFailureEventAt({
      shipmentId: 'pre-job-webhook', action: 'WEBHOOK_REJECTED',
      occurredAt: '2026-08-17T11:00:00.000Z',
    });
    const repository = repositoryWith({
      failures: {
        items: [headFor(newest, { version: 2 }), headFor(older, { version: 1 })],
        nextBefore: {
          lastOccurredAt: older.occurredAt,
          shipmentId: older.shipmentId,
        },
      },
    });
    const result = await serviceWith(repository).listPreJobFailures({
      companyId: COMPANY_ID, limit: 2, before: null,
    });

    expect(repository.listPreJobFailureHeadsForCompany).toHaveBeenCalledWith({
      companyId: COMPANY_ID, limit: 2, before: null,
    });
    expect(result).toEqual({
      items: [
        {
          shipmentId: 'pre-job-validation',
          jobId: null,
          documentNumber: null,
          lastStage: 'VALIDATION',
          lastAction: 'VALIDATION_FAILED',
          lastOutcome: 'FAILURE',
          lastSafeCode: 'LOCAL_VALIDATION_FAILED',
          firstOccurredAt: newest.occurredAt,
          lastOccurredAt: newest.occurredAt,
          version: 2,
        },
        {
          shipmentId: 'pre-job-webhook',
          jobId: null,
          documentNumber: null,
          lastStage: 'WEBHOOK',
          lastAction: 'WEBHOOK_REJECTED',
          lastOutcome: 'FAILURE',
          lastSafeCode: 'WEBHOOK_INVALID',
          firstOccurredAt: older.occurredAt,
          lastOccurredAt: older.occurredAt,
          version: 1,
        },
      ],
      nextBefore: encodeHeadCursor({
        lastOccurredAt: older.occurredAt, shipmentId: older.shipmentId,
      }),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
    expect(Reflect.ownKeys(result.items[0])).toEqual([
      'shipmentId', 'jobId', 'documentNumber', 'lastStage', 'lastAction',
      'lastOutcome', 'lastSafeCode', 'firstOccurredAt', 'lastOccurredAt', 'version',
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /companyId|applicationId|eventKey|expiresAt|requestSummary|responseSummary|transport/i,
    );
  });

  test.each([
    ['job-bound', eventAt({
      occurredAt: '2026-08-17T11:00:00.000Z', parentVersion: 1,
      action: 'JOB_DATA_FAILED', outcome: 'FAILURE', safeCode: 'LOCAL_VALIDATION_FAILED',
    })],
    ['nonfailure', eventAt({
      occurredAt: '2026-08-17T11:00:00.000Z', parentVersion: 1,
    })],
    ['other action', preJobFailureEventAt({
      shipmentId: 'pre-job-other', action: 'JOB_DATA_FAILED',
      occurredAt: '2026-08-17T11:00:00.000Z',
    })],
  ])('fails closed when the pre-job repository returns a %s head', async (_label, event) => {
    const repository = repositoryWith({
      failures: { items: [headFor(event)], nextBefore: null },
    });
    await expectSafeRejection(serviceWith(repository).listPreJobFailures({
      companyId: COMPANY_ID, limit: 20, before: null,
    }), 'SHIPMENT_ACTIVITY_DATA_INVALID', 'Shipment activity data is invalid');
  });

  test('decodes a pre-job cursor independently and normalizes filtered-anchor rejection', async () => {
    const anchor = preJobFailureEventAt({
      shipmentId: 'pre-job-anchor', occurredAt: '2026-08-17T11:00:00.000Z',
    });
    const before = encodeHeadCursor({
      lastOccurredAt: anchor.occurredAt, shipmentId: anchor.shipmentId,
    });
    const repository = repositoryWith();
    repository.listPreJobFailureHeadsForCompany.mockRejectedValue(
      new EinvoiceError('REPOSITORY_INPUT_INVALID', 'private filtered anchor detail'),
    );

    await expectSafeRejection(serviceWith(repository).listPreJobFailures({
      companyId: COMPANY_ID, limit: 20, before,
    }), 'SHIPMENT_ACTIVITY_NOT_FOUND', 'Shipment activity was not found');
    expect(repository.listPreJobFailureHeadsForCompany).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      limit: 20,
      before: { lastOccurredAt: anchor.occurredAt, shipmentId: anchor.shipmentId },
    });
  });

  test('rejects malformed pre-job input and repository rows before returning bytes', async () => {
    const repository = repositoryWith();
    const service = serviceWith(repository);
    await expectSafeRejection(service.listPreJobFailures({
      companyId: COMPANY_ID, limit: 20, before: 'not-canonical-base64url',
    }), 'SHIPMENT_ACTIVITY_REQUEST_INVALID', 'Shipment activity request is invalid');
    expect(repository.listPreJobFailureHeadsForCompany).not.toHaveBeenCalled();

    const valid = preJobFailureEventAt({
      shipmentId: 'pre-job-private', occurredAt: '2026-08-17T11:00:00.000Z',
    });
    repository.listPreJobFailureHeadsForCompany.mockResolvedValue({
      items: [{ ...headFor(valid), rawPayload: 'PRIVATE_SENTINEL' }],
      nextBefore: null,
    });
    await expectSafeRejection(service.listPreJobFailures({
      companyId: COMPANY_ID, limit: 20, before: null,
    }), 'SHIPMENT_ACTIVITY_DATA_INVALID', 'Shipment activity data is invalid');
  });

  test('returns each repository timeline page chronologically and keeps cursor position newest-first', async () => {
    const newest = eventAt({
      occurredAt: '2026-08-17T12:00:00.000Z',
      parentVersion: 2,
      action: 'JOB_COMPLETED',
    });
    const older = eventAt({
      occurredAt: '2026-08-17T11:00:00.000Z', parentVersion: 1,
    });
    const repository = repositoryWith({
      events: {
        items: [newest, older],
        nextBefore: { occurredAt: older.occurredAt, eventKey: older.eventKey },
      },
    });
    const result = await serviceWith(repository).getTimeline({
      companyId: COMPANY_ID, shipmentId: SHIPMENT_ID, limit: 2, before: null,
    });

    expect(repository.listShipmentAuditEventsForCompany).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      shipmentId: SHIPMENT_ID,
      limit: 2,
      before: null,
    });
    expect(result.shipmentId).toBe(SHIPMENT_ID);
    expect(result.items.map(item => item.occurredAt)).toEqual([
      older.occurredAt,
      newest.occurredAt,
    ]);
    expect(result.nextBefore).toBe(encodeTimelineCursor({
      occurredAt: older.occurredAt,
      eventKey: older.eventKey,
    }));
    expect(Reflect.ownKeys(result.items[0])).toEqual([
      'jobId', 'documentNumber', 'stage', 'action', 'outcome', 'attemptNumber',
      'startedAt', 'completedAt', 'durationMs', 'queueDelayMs', 'retryDelayMs',
      'nextAttemptAt', 'safeCode', 'requestSummary', 'responseSummary',
      'artifactJobId', 'occurredAt',
    ]);
    expect(result.items[0]).not.toHaveProperty('eventKey');
    expect(result.items[0]).not.toHaveProperty('operationKey');
    expect(result.items[0]).not.toHaveProperty('applicationId');
    expect(Object.isFrozen(result.items[0])).toBe(true);
  });

  test('rejects a repeated event identity even when its timestamps differ', async () => {
    const newer = eventAt({
      occurredAt: '2026-08-17T12:00:00.000Z', parentVersion: 1,
    });
    const older = eventAt({
      occurredAt: '2026-08-17T11:00:00.000Z', parentVersion: 1,
    });
    expect(newer.eventKey).toBe(older.eventKey);
    const repository = repositoryWith({
      events: { items: [newer, older], nextBefore: null },
    });

    await expectSafeRejection(serviceWith(repository).getTimeline({
      companyId: COMPANY_ID, shipmentId: SHIPMENT_ID, limit: 50, before: null,
    }), 'SHIPMENT_ACTIVITY_DATA_INVALID', 'Shipment activity data is invalid');
  });

  test('orders canonical expanded-year timestamps by their actual instants', async () => {
    const chronologicallyOlder = eventAt({
      occurredAt: '9999-12-31T23:59:59.999Z', parentVersion: 1,
    });
    const chronologicallyNewer = eventAt({
      occurredAt: '+010000-01-01T00:00:00.000Z', parentVersion: 2,
    });
    const repository = repositoryWith({
      events: {
        items: [chronologicallyOlder, chronologicallyNewer],
        nextBefore: null,
      },
    });

    await expectSafeRejection(serviceWith(repository).getTimeline({
      companyId: COMPANY_ID, shipmentId: SHIPMENT_ID, limit: 50, before: null,
    }), 'SHIPMENT_ACTIVITY_DATA_INVALID', 'Shipment activity data is invalid');
  });

  test('freshly validates and deep-copies every supported external summary family', async () => {
    const fyndRequest = sanitizeFyndSummary('REQUEST', {
      operation: 'LOCK',
      shipmentId: SHIPMENT_ID,
      documentNumber: DOCUMENT_NUMBER,
      requestedLock: true,
      requestedStatus: null,
    });
    const fyndResponse = sanitizeFyndSummary('RESPONSE', {
      operation: 'LOCK',
      shipmentId: SHIPMENT_ID,
      documentNumber: DOCUMENT_NUMBER,
      responseStatus: 200,
      locked: true,
      shipmentState: 'bag_confirmed',
      finalStateClassification: 'LOCKED',
      retryable: false,
      latencyMs: 1000,
    });
    const oeisRequest = sanitizeOeisSummary('REQUEST', {
      documentNumber: DOCUMENT_NUMBER,
      documentType: 'IN',
      lineCount: 1,
      currency: 'SAR',
      netAmount: '267.00',
      taxAmount: '0.00',
      totalAmount: '267.00',
      taxSummaries: [{ category: 'Z', rate: '0.00', reasonCode: 'VATEX-SA-HEA', lineCount: 1 }],
      requestByteCount: 123,
      requestSha256: 'a'.repeat(64),
      endpointPath: '/API/V2/Transaction/UpdateInvoiceData',
      attemptNumber: 1,
      timeoutMs: 5000,
    });
    const oeisResponse = sanitizeOeisSummary('RESPONSE', {
      httpStatus: 200,
      isSystemException: false,
      validationResult: 'VALID',
      reportingStatus: 'REPORTED',
      clearanceStatus: 'CLEARED',
      invoiceNumber: 'INV-42',
      transactionNumber: 'TX-42',
      uuid: '123e4567-e89b-12d3-a456-426614174000',
      invoiceCounter: '42',
      matchingKey: 'MATCH-42',
      validationCodes: ['VALID'],
      responseByteCount: 321,
      responseSha256: 'b'.repeat(64),
      retryable: false,
      latencyMs: 1000,
    });
    const artifact = sanitizeOeisSummary('ARTIFACT', {
      signedXmlPresent: true,
      signedXmlByteCount: 100,
      signedXmlSha256: 'c'.repeat(64),
      qrPresent: true,
      qrByteCount: 50,
      qrSha256: 'd'.repeat(64),
    });
    const fixtures = [
      operationEventAt({
        occurredAt: '2026-08-17T11:00:00.000Z',
        stage: 'FYND_LOCK',
        requestedAction: 'FYND_LOCK_REQUESTED',
        action: 'FYND_LOCK_REQUESTED',
        outcome: 'STARTED',
        requestSummary: fyndRequest,
      }),
      operationEventAt({
        occurredAt: '2026-08-17T11:01:00.000Z',
        startedAt: '2026-08-17T11:00:59.000Z',
        stage: 'FYND_LOCK',
        requestedAction: 'FYND_LOCK_REQUESTED',
        action: 'FYND_LOCK_CONFIRMED',
        outcome: 'SUCCESS',
        responseSummary: fyndResponse,
      }),
      operationEventAt({
        occurredAt: '2026-08-17T11:02:00.000Z',
        stage: 'OEIS_SUBMISSION',
        requestedAction: 'OEIS_SUBMISSION_REQUESTED',
        action: 'OEIS_SUBMISSION_REQUESTED',
        outcome: 'STARTED',
        requestSummary: oeisRequest,
      }),
      operationEventAt({
        occurredAt: '2026-08-17T11:03:00.000Z',
        startedAt: '2026-08-17T11:02:59.000Z',
        stage: 'OEIS_SUBMISSION',
        requestedAction: 'OEIS_SUBMISSION_REQUESTED',
        action: 'OEIS_RESPONSE_RECEIVED',
        outcome: 'SUCCESS',
        responseSummary: oeisResponse,
        artifactJobId: 42,
      }),
      artifactEventAt('2026-08-17T11:04:00.000Z', artifact),
    ];

    for (const event of fixtures) {
      const repository = repositoryWith({
        events: { items: [event], nextBefore: null },
      });
      const result = await serviceWith(repository).getTimeline({
        companyId: COMPANY_ID, shipmentId: SHIPMENT_ID, limit: 50, before: null,
      });
      expect(result.items[0].requestSummary).toEqual(event.requestSummary);
      expect(result.items[0].responseSummary).toEqual(event.responseSummary);
      if (event.requestSummary !== null) {
        expect(result.items[0].requestSummary).not.toBe(event.requestSummary);
        expect(Object.isFrozen(result.items[0].requestSummary)).toBe(true);
      }
      if (event.responseSummary !== null) {
        expect(result.items[0].responseSummary).not.toBe(event.responseSummary);
        expect(Object.isFrozen(result.items[0].responseSummary)).toBe(true);
      }
    }
  });

  test('decodes canonical cursors before the repository call', async () => {
    const event = eventAt({
      occurredAt: '2026-08-17T11:00:00.000Z', parentVersion: 1,
    });
    const headBefore = encodeHeadCursor({
      lastOccurredAt: event.occurredAt, shipmentId: event.shipmentId,
    });
    const timelineBefore = encodeTimelineCursor({
      occurredAt: event.occurredAt, eventKey: event.eventKey,
    });
    const repository = repositoryWith({
      heads: { items: [], nextBefore: null },
      events: { items: [], nextBefore: null },
    });
    const service = serviceWith(repository);

    await service.listShipments({ companyId: COMPANY_ID, limit: 20, before: headBefore });
    await service.getTimeline({
      companyId: COMPANY_ID, shipmentId: SHIPMENT_ID, limit: 50, before: timelineBefore,
    });

    expect(repository.listShipmentAuditHeadsForCompany).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      limit: 20,
      before: { lastOccurredAt: event.occurredAt, shipmentId: event.shipmentId },
    });
    expect(repository.listShipmentAuditEventsForCompany).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      shipmentId: SHIPMENT_ID,
      limit: 50,
      before: { occurredAt: event.occurredAt, eventKey: event.eventKey },
    });
  });

  test('rejects head and timeline rows that are not strictly older than the decoded cursor', async () => {
    const anchor = eventAt({
      occurredAt: '2026-08-17T11:00:00.000Z', parentVersion: 1,
    });
    const newer = eventAt({
      occurredAt: '2026-08-17T12:00:00.000Z', parentVersion: 2,
    });
    const service = serviceWith(repositoryWith({
      heads: { items: [headFor(newer)], nextBefore: null },
      events: { items: [newer], nextBefore: null },
    }));

    await expectSafeRejection(service.listShipments({
      companyId: COMPANY_ID,
      limit: 20,
      before: encodeHeadCursor({
        lastOccurredAt: anchor.occurredAt,
        shipmentId: anchor.shipmentId,
      }),
    }), 'SHIPMENT_ACTIVITY_DATA_INVALID', 'Shipment activity data is invalid');
    await expectSafeRejection(service.getTimeline({
      companyId: COMPANY_ID,
      shipmentId: SHIPMENT_ID,
      limit: 50,
      before: encodeTimelineCursor({
        occurredAt: anchor.occurredAt,
        eventKey: anchor.eventKey,
      }),
    }), 'SHIPMENT_ACTIVITY_DATA_INVALID', 'Shipment activity data is invalid');
  });

  test('rejects a cursor identity repeated on an older adjacent page', async () => {
    const anchor = eventAt({
      occurredAt: '2026-08-17T11:00:00.000Z', parentVersion: 1,
    });
    const repeated = eventAt({
      occurredAt: '2026-08-17T10:00:00.000Z', parentVersion: 1,
    });
    expect(repeated.eventKey).toBe(anchor.eventKey);
    const service = serviceWith(repositoryWith({
      heads: { items: [headFor(repeated)], nextBefore: null },
      events: { items: [repeated], nextBefore: null },
    }));

    await expectSafeRejection(service.listShipments({
      companyId: COMPANY_ID,
      limit: 20,
      before: encodeHeadCursor({
        lastOccurredAt: anchor.occurredAt,
        shipmentId: anchor.shipmentId,
      }),
    }), 'SHIPMENT_ACTIVITY_DATA_INVALID', 'Shipment activity data is invalid');
    await expectSafeRejection(service.getTimeline({
      companyId: COMPANY_ID,
      shipmentId: SHIPMENT_ID,
      limit: 50,
      before: encodeTimelineCursor({
        occurredAt: anchor.occurredAt,
        eventKey: anchor.eventKey,
      }),
    }), 'SHIPMENT_ACTIVITY_DATA_INVALID', 'Shipment activity data is invalid');
  });

  test.each([
    [{ companyId: COMPANY_ID, limit: 0, before: null }],
    [{ companyId: COMPANY_ID, limit: 51, before: null }],
    [{ companyId: '015862', limit: 20, before: null }],
    [{ companyId: COMPANY_ID, limit: 20, before: '' }],
    [{ companyId: COMPANY_ID, limit: 20, before: 'not-a-cursor' }],
    [{ companyId: COMPANY_ID, limit: 20, before: null, extra: true }],
  ])('rejects malformed list input before repository work: %j', async input => {
    const repository = repositoryWith();
    await expectSafeRejection(
      serviceWith(repository).listShipments(input),
      'SHIPMENT_ACTIVITY_REQUEST_INVALID',
      'Shipment activity request is invalid',
    );
    expect(repository.listShipmentAuditHeadsForCompany).not.toHaveBeenCalled();
  });

  test('maps an anchored repository input failure to the fixed not-found result', async () => {
    const event = eventAt({
      occurredAt: '2026-08-17T11:00:00.000Z', parentVersion: 1,
    });
    const repository = repositoryWith();
    repository.listShipmentAuditEventsForCompany.mockRejectedValue(new EinvoiceError(
      'REPOSITORY_INPUT_INVALID', 'private repository detail',
    ));

    await expectSafeRejection(serviceWith(repository).getTimeline({
      companyId: COMPANY_ID,
      shipmentId: SHIPMENT_ID,
      limit: 50,
      before: encodeTimelineCursor({ occurredAt: event.occurredAt, eventKey: event.eventKey }),
    }), 'SHIPMENT_ACTIVITY_NOT_FOUND', 'Shipment activity was not found');
  });

  test('returns not found for an initial empty timeline but permits an empty continuation page', async () => {
    const event = eventAt({
      occurredAt: '2026-08-17T11:00:00.000Z', parentVersion: 1,
    });
    const repository = repositoryWith({ events: { items: [], nextBefore: null } });
    const service = serviceWith(repository);

    await expectSafeRejection(service.getTimeline({
      companyId: COMPANY_ID, shipmentId: SHIPMENT_ID, limit: 50, before: null,
    }), 'SHIPMENT_ACTIVITY_NOT_FOUND', 'Shipment activity was not found');
    await expect(service.getTimeline({
      companyId: COMPANY_ID,
      shipmentId: SHIPMENT_ID,
      limit: 50,
      before: encodeTimelineCursor({ occurredAt: event.occurredAt, eventKey: event.eventKey }),
    })).resolves.toEqual({ shipmentId: SHIPMENT_ID, items: [], nextBefore: null });
  });

  test.each([
    page => ({ ...page, extra: true }),
    page => ({ ...page, items: new Proxy(page.items, {}) }),
    page => ({ ...page, nextBefore: { ...page.nextBefore, shipmentId: 'different' } }),
    page => ({ ...page, items: [{ ...page.items[0], rawBody: 'PRIVATE_SENTINEL' }] }),
    page => ({ ...page, items: [{ ...page.items[0], expiresAt: NOW }] }),
  ])('fails closed on corrupt repository head data', async mutate => {
    const event = eventAt({
      occurredAt: '2026-08-17T11:00:00.000Z', parentVersion: 1,
    });
    const valid = {
      items: [headFor(event)],
      nextBefore: { lastOccurredAt: event.occurredAt, shipmentId: event.shipmentId },
    };
    const repository = repositoryWith({ heads: mutate(valid) });
    await expectSafeRejection(serviceWith(repository).listShipments({
      companyId: COMPANY_ID, limit: 20, before: null,
    }), 'SHIPMENT_ACTIVITY_DATA_INVALID', 'Shipment activity data is invalid');
  });

  test('normalizes repository failure without retaining private details', async () => {
    const repository = repositoryWith();
    repository.listShipmentAuditHeadsForCompany.mockRejectedValue(
      new Error('mongodb+srv://private-user:private-password@example.invalid/raw'),
    );
    const error = await serviceWith(repository).listShipments({
      companyId: COMPANY_ID, limit: 20, before: null,
    }).catch(value => value);
    expect(error).toEqual(expect.objectContaining({
      code: 'SHIPMENT_ACTIVITY_READ_FAILED',
      message: 'Shipment activity could not be read',
    }));
    expect(`${error.message} ${error.stack}`).not.toMatch(/private-user|private-password|example\.invalid/);
  });

  test('rejects hostile factory surfaces without executing traps', () => {
    let calls = 0;
    const proxy = new Proxy(repositoryWith(), {
      get() { calls += 1; throw new Error('private trap'); },
    });
    expect(() => createShipmentActivityService({
      repository: proxy, now: () => new Date(NOW),
    })).toThrow(expect.objectContaining({
      code: 'SHIPMENT_ACTIVITY_SERVICE_INVALID',
      message: 'Shipment activity service configuration is invalid',
    }));
    expect(calls).toBe(0);
  });

  test('normalizes a hostile clock rejection without inspecting the thrown Proxy', async () => {
    let clockCalls = 0;
    let trapCalls = 0;
    const hostile = new Proxy(new Error('PRIVATE_CLOCK_SENTINEL'), {
      getPrototypeOf() {
        trapCalls += 1;
        throw new Error('PRIVATE_CLOCK_TRAP');
      },
    });
    const repository = repositoryWith();
    const service = serviceWith(repository, () => {
      clockCalls += 1;
      throw hostile;
    });

    await expectSafeRejection(service.listShipments({
      companyId: COMPANY_ID, limit: 20, before: null,
    }), 'SHIPMENT_ACTIVITY_SERVICE_INVALID', 'Shipment activity service configuration is invalid');
    expect(clockCalls).toBe(1);
    expect(trapCalls).toBe(0);
    expect(repository.listShipmentAuditHeadsForCompany).not.toHaveBeenCalled();
  });

  test('replaces a spoofed fixed clock error with a fresh safe service error', async () => {
    const spoof = {
      code: 'SHIPMENT_ACTIVITY_SERVICE_INVALID',
      message: 'Shipment activity service configuration is invalid',
      privateDetail: 'PRIVATE_CLOCK_DETAIL',
    };
    const repository = repositoryWith();
    const error = await serviceWith(repository, () => { throw spoof; }).listShipments({
      companyId: COMPANY_ID, limit: 20, before: null,
    }).catch(value => value);

    expect(error).not.toBe(spoof);
    expect(error).toBeInstanceOf(EinvoiceError);
    expect(error).toMatchObject({
      code: 'SHIPMENT_ACTIVITY_SERVICE_INVALID',
      message: 'Shipment activity service configuration is invalid',
    });
    expect(error).not.toHaveProperty('privateDetail');
    expect(repository.listShipmentAuditHeadsForCompany).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: 'Fynd shipment and document identity',
      event: () => operationEventAt({
        occurredAt: '2026-08-17T11:00:00.000Z',
        stage: 'FYND_LOCK',
        requestedAction: 'FYND_LOCK_REQUESTED',
        action: 'FYND_LOCK_REQUESTED',
        outcome: 'STARTED',
        requestSummary: sanitizeFyndSummary('REQUEST', {
          operation: 'LOCK',
          shipmentId: 'foreign-shipment',
          documentNumber: 'VR-foreign-shipment-1',
          requestedLock: true,
          requestedStatus: null,
        }),
      }),
    },
    {
      name: 'OEIS document and attempt identity',
      event: () => operationEventAt({
        occurredAt: '2026-08-17T11:00:00.000Z',
        stage: 'OEIS_SUBMISSION',
        requestedAction: 'OEIS_SUBMISSION_REQUESTED',
        action: 'OEIS_SUBMISSION_REQUESTED',
        outcome: 'STARTED',
        requestSummary: sanitizeOeisSummary('REQUEST', {
          documentNumber: 'VR-foreign-shipment-1',
          documentType: 'IN',
          lineCount: 1,
          currency: 'SAR',
          netAmount: '100.00',
          taxAmount: '15.00',
          totalAmount: '115.00',
          taxSummaries: [{ category: 'S', rate: '15.00', reasonCode: null, lineCount: 1 }],
          requestByteCount: 2,
          requestSha256: 'a'.repeat(64),
          endpointPath: '/API/V2/Transaction/UpdateInvoiceData',
          attemptNumber: 2,
          timeoutMs: 5_000,
        }),
      }),
    },
  ])('rejects a summary whose $name conflicts with its outer event', async ({ event }) => {
    const repository = repositoryWith({
      events: { items: [event()], nextBefore: null },
    });
    await expectSafeRejection(serviceWith(repository).getTimeline({
      companyId: COMPANY_ID, shipmentId: SHIPMENT_ID, limit: 50, before: null,
    }), 'SHIPMENT_ACTIVITY_DATA_INVALID', 'Shipment activity data is invalid');
  });

  test.each([
    { jobId: null, documentNumber: DOCUMENT_NUMBER },
    { jobId: 42, documentNumber: null },
  ])('rejects a head whose job/document identity is only partially present: %j', async identity => {
    const event = eventAt({
      occurredAt: '2026-08-17T11:00:00.000Z', parentVersion: 1,
    });
    const repository = repositoryWith({
      heads: { items: [headFor(event, identity)], nextBefore: null },
    });
    await expectSafeRejection(serviceWith(repository).listShipments({
      companyId: COMPANY_ID, limit: 20, before: null,
    }), 'SHIPMENT_ACTIVITY_DATA_INVALID', 'Shipment activity data is invalid');
  });

  test('rejects a whitespace-only persisted document identity', async () => {
    const event = eventAt({
      occurredAt: '2026-08-17T11:00:00.000Z', parentVersion: 1,
    });
    const repository = repositoryWith({
      heads: {
        items: [headFor(event, { documentNumber: '   ' })],
        nextBefore: null,
      },
    });
    await expectSafeRejection(serviceWith(repository).listShipments({
      companyId: COMPANY_ID, limit: 20, before: null,
    }), 'SHIPMENT_ACTIVITY_DATA_INVALID', 'Shipment activity data is invalid');
  });
});
