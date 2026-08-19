'use strict';

const { Long, MongoOperationTimeoutError, MongoServerError } = require('mongodb');

const { EinvoiceError } = require('../../src/einvoice/errors');
const {
  AUDIT_RETENTION_MS,
  createAuditEvent,
  createEventKey,
  createOperationKey,
  sanitizeFyndSummary,
  sanitizeOeisSummary,
} = require('../../src/einvoice/audit/audit-contract');
const {
  JOB_STATES,
  MONGO_REPOSITORY_METHODS,
  REQUIRED_REPOSITORY_METHODS,
  assertMongoInvoiceRepository,
} = require('../../src/einvoice/repositories/invoice-repository');
const {
  decodeDate,
  decodeNonnegativeLong,
  decodeNullableDate,
  decodeNullablePositiveLong,
  decodePositiveLong,
  encodeDate,
  encodeNonnegativeLong,
  encodeNullableDate,
  encodeNullablePositiveLong,
  encodePositiveLong,
} = require('../../src/einvoice/repositories/mongo-repository-codec');
const {
  MONGO_COLLECTION_NAMES,
  MONGO_INDEX_CATALOG,
} = require('../../src/einvoice/repositories/mongo-indexes');
const {
  MONGO_TRANSACTION_TIMEOUT_MS,
  createMongoInvoiceRepository,
} = require('../../src/einvoice/repositories/mongo-invoice-repository');
const {
  createMongoRepositoryHarness,
  sameBson,
} = require('../utils/mongo-repository-harness');

const FIXED_NOW = new Date('2026-08-17T10:00:00.000Z');
const RECEIVED_AT = '2026-08-17T09:59:00.000Z';
const LIVE_LEASE_EXPIRES_AT = new Date('2026-08-17T10:05:00.000Z');
const PREPARED_REQUEST_JSON = '[]';
const PREPARED_REQUEST_HASH = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const PRE_JOB_FAILURE_HEAD_REPAIR_MARKER = Object.freeze({
  _id: 'shipment_audit_heads_pre_job_failure_precedence_v1',
  migration: 'PRE_JOB_FAILURE_HEAD_PRECEDENCE',
  version: 1,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function safeErrorExpectation(code, message, retryable = false) {
  return expect.objectContaining({
    name: 'EinvoiceError',
    code,
    message,
    retryable,
  });
}

function createRepository(options = {}) {
  const harness = options.harness || createMongoRepositoryHarness();
  let currentNow = options.now || FIXED_NOW;
  let clockCalls = 0;
  const repository = createMongoInvoiceRepository({
    db: harness.db,
    client: harness.client,
    now: () => {
      clockCalls += 1;
      return new Date(currentNow);
    },
  });
  return {
    harness,
    repository,
    clock: {
      calls: () => clockCalls,
      set(value) { currentNow = value; },
      reset() { clockCalls = 0; },
    },
  };
}

async function initializeRepository(options = {}) {
  const fixture = createRepository(options);
  await fixture.repository.initialize();
  fixture.clock.reset();
  return fixture;
}

function eventRecord(overrides = {}) {
  return {
    eventId: 'event-1',
    companyId: 'company-1',
    applicationId: 'application-1',
    shipmentId: 'shipment-1',
    eventType: 'application/shipment/update/v1',
    status: 'bag_confirmed',
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

function normalizedShipment(overrides = {}) {
  return {
    shipmentId: 'shipment-1',
    confirmedAt: '2026-08-17T09:58:00.000Z',
    branchCode: 'store-1',
    currency: 'SAR',
    paymentMode: 'CARD',
    amountPaid: '115.00',
    policyVersion: '2026-08-17',
    taxEligibility: {
      governmentBorneVatEligible: false,
      reasonCode: null,
      evidenceReference: 'event-1',
      verifiedAt: '2026-08-17T09:58:00.000Z',
      buyerName: null,
      buyerNationalId: null,
    },
    bags: [{
      bagId: 'bag-1',
      lineNumber: 1,
      productCode: 'product-1',
      quantity: 1,
      financialBreakup: {
        price_effective: '115.00',
        promotion_effective_discount: '0.00',
        coupon_effective_discount: '15.00',
        value_of_good: '100.00',
        gst_tax_percentage: '15.00',
        gst_fee: '15.00',
        amount_paid: '115.00',
      },
      prices: {
        promotion_effective_discount: '0.00',
        coupon_effective_discount: '15.00',
      },
    }],
    ...overrides,
  };
}

function webhookReceiptAudit({
  event = eventRecord(),
  occurredAt = '2026-08-17T09:59:30.000Z',
} = {}) {
  const eventKey = createEventKey({
    kind: 'WEBHOOK_RECEIPT',
    companyId: event.companyId,
    eventId: event.eventId,
  });
  return createAuditEvent({
    eventKey,
    operationKey: null,
    companyId: event.companyId,
    applicationId: event.applicationId,
    shipmentId: event.shipmentId,
    jobId: null,
    documentNumber: null,
    stage: 'WEBHOOK',
    action: 'WEBHOOK_RECEIVED',
    outcome: 'SUCCESS',
    attemptNumber: 0,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: null,
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(occurredAt) });
}

function webhookEntityAudit({
  event = eventRecord(),
  occurredAt = '2026-08-17T09:59:30.000Z',
} = {}) {
  const eventKey = createEventKey({
    kind: 'ENTITY',
    companyId: event.companyId,
    shipmentId: event.shipmentId,
    scopeKind: 'WEBHOOK',
    scopeId: event.eventId,
    parentVersion: 0,
    attemptNumber: 0,
    stage: 'WEBHOOK',
    action: 'WEBHOOK_IGNORED',
    outcome: 'SUCCESS',
  });
  return createAuditEvent({
    eventKey,
    operationKey: null,
    companyId: event.companyId,
    applicationId: event.applicationId,
    shipmentId: event.shipmentId,
    jobId: null,
    documentNumber: null,
    stage: 'WEBHOOK',
    action: 'WEBHOOK_IGNORED',
    outcome: 'SUCCESS',
    attemptNumber: 0,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: null,
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(occurredAt) });
}

function webhookValidationAudit({
  event = eventRecord(),
  action = 'VALIDATION_PASSED',
  outcome = action === 'VALIDATION_STARTED' ? 'STARTED' : 'SUCCESS',
  occurredAt = '2026-08-17T09:59:30.000Z',
  startedAt = null,
  completedAt = null,
} = {}) {
  const eventKey = createEventKey({
    kind: 'ENTITY',
    companyId: event.companyId,
    shipmentId: event.shipmentId,
    scopeKind: 'WEBHOOK',
    scopeId: event.eventId,
    parentVersion: 0,
    attemptNumber: 0,
    stage: 'VALIDATION',
    action,
    outcome,
  });
  return createAuditEvent({
    eventKey,
    operationKey: null,
    companyId: event.companyId,
    applicationId: event.applicationId,
    shipmentId: event.shipmentId,
    jobId: null,
    documentNumber: null,
    stage: 'VALIDATION',
    action,
    outcome,
    attemptNumber: 0,
    startedAt: startedAt === null ? null : new Date(startedAt),
    completedAt: completedAt === null ? null : new Date(completedAt),
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: null,
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(occurredAt) });
}

function webhookAcceptedAudit({
  event = eventRecord(),
  jobId = 1,
  documentNumber = `VR-${event.shipmentId}-1`,
  occurredAt = '2026-08-17T09:59:30.000Z',
} = {}) {
  const eventKey = createEventKey({
    kind: 'ENTITY',
    companyId: event.companyId,
    shipmentId: event.shipmentId,
    scopeKind: 'WEBHOOK',
    scopeId: event.eventId,
    parentVersion: 0,
    attemptNumber: 0,
    stage: 'WEBHOOK',
    action: 'WEBHOOK_ACCEPTED',
    outcome: 'SUCCESS',
  });
  return createAuditEvent({
    eventKey,
    operationKey: null,
    companyId: event.companyId,
    applicationId: event.applicationId,
    shipmentId: event.shipmentId,
    jobId,
    documentNumber,
    stage: 'WEBHOOK',
    action: 'WEBHOOK_ACCEPTED',
    outcome: 'SUCCESS',
    attemptNumber: 0,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: null,
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(occurredAt) });
}

function preJobFailureAudit({
  companyId = 'company-1',
  applicationId = 'application-1',
  shipmentId = 'shipment-pre-job',
  eventId = `event-${shipmentId}`,
  action = 'VALIDATION_FAILED',
  safeCode = action === 'WEBHOOK_REJECTED' ? 'WEBHOOK_INVALID' : 'LOCAL_VALIDATION_FAILED',
  occurredAt = '2026-08-17T10:00:00.000Z',
  startedAt = null,
  completedAt = null,
} = {}) {
  const stage = action === 'WEBHOOK_REJECTED' ? 'WEBHOOK'
    : action === 'VALIDATION_FAILED' ? 'VALIDATION' : 'JOB';
  const eventKey = createEventKey({
    kind: 'ENTITY',
    companyId,
    shipmentId,
    scopeKind: 'WEBHOOK',
    scopeId: eventId,
    parentVersion: 0,
    attemptNumber: 0,
    stage,
    action,
    outcome: 'FAILURE',
  });
  return createAuditEvent({
    eventKey,
    operationKey: null,
    companyId,
    applicationId,
    shipmentId,
    jobId: null,
    documentNumber: null,
    stage,
    action,
    outcome: 'FAILURE',
    attemptNumber: 0,
    startedAt: startedAt === null ? null : new Date(startedAt),
    completedAt: completedAt === null ? null : new Date(completedAt),
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode,
    requestSummary: null,
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(occurredAt) });
}

function sameClockPreJobFailureLifecycle({
  event = eventRecord({
    eventId: 'same-clock-0',
    shipmentId: 'shipment-same-clock-0',
  }),
  occurredAt = FIXED_NOW.toISOString(),
} = {}) {
  const receipt = webhookReceiptAudit({ event, occurredAt });
  const validationStarted = webhookValidationAudit({
    event, action: 'VALIDATION_STARTED', occurredAt,
  });
  const commonFailure = {
    companyId: event.companyId,
    applicationId: event.applicationId,
    shipmentId: event.shipmentId,
    eventId: event.eventId,
    safeCode: 'WEBHOOK_VALIDATION_FAILED',
    occurredAt,
    startedAt: occurredAt,
    completedAt: occurredAt,
  };
  const validationFailed = preJobFailureAudit({
    ...commonFailure, action: 'VALIDATION_FAILED',
  });
  const webhookRejected = preJobFailureAudit({
    ...commonFailure, action: 'WEBHOOK_REJECTED',
  });
  return {
    event,
    receipt,
    validationStarted,
    validationFailed,
    webhookRejected,
    events: [receipt, validationStarted, validationFailed, webhookRejected],
  };
}

function findLongDocument(documents, field, value) {
  const encoded = Long.fromNumber(value);
  return documents.find(document => Long.isLong(document[field]) && document[field].equals(encoded));
}

function replaceJob(harness, jobId, patch) {
  const encoded = Long.fromNumber(jobId);
  harness.replaceDocuments('invoice_jobs', harness.documents('invoice_jobs').map(job => (
    job.jobId.equals(encoded) ? { ...job, ...patch } : job
  )));
}

function readyJobPatch({
  state = JOB_STATES.LOCK_PENDING,
  attemptCount = 1,
  version = 1,
  lockedAt = null,
  ...overrides
} = {}) {
  return {
    state,
    attemptCount,
    version,
    oeisRequestJson: PREPARED_REQUEST_JSON,
    requestHash: PREPARED_REQUEST_HASH,
    leaseOwner: 'worker-1',
    leaseExpiresAt: new Date(LIVE_LEASE_EXPIRES_AT),
    lockedAt,
    ...overrides,
  };
}

function storedAuditEvent(event) {
  return {
    ...event,
    jobId: event.jobId === null ? null : Long.fromNumber(event.jobId),
    startedAt: event.startedAt === null ? null : new Date(event.startedAt),
    completedAt: event.completedAt === null ? null : new Date(event.completedAt),
    nextAttemptAt: event.nextAttemptAt === null ? null : new Date(event.nextAttemptAt),
    artifactJobId: event.artifactJobId === null ? null : Long.fromNumber(event.artifactJobId),
    occurredAt: new Date(event.occurredAt),
    expiresAt: new Date(event.expiresAt),
  };
}

function storedAuditHead(event, overrides = {}) {
  const stored = storedAuditEvent(event);
  return {
    companyId: stored.companyId,
    shipmentId: stored.shipmentId,
    jobId: stored.jobId,
    documentNumber: stored.documentNumber,
    lastStage: stored.stage,
    lastAction: stored.action,
    lastOutcome: stored.outcome,
    lastSafeCode: stored.safeCode,
    firstOccurredAt: new Date(stored.occurredAt),
    lastOccurredAt: new Date(stored.occurredAt),
    lastEventKey: stored.eventKey,
    expiresAt: new Date(stored.expiresAt),
    version: 0,
    ...overrides,
  };
}

async function acceptFor(harness, repository, suffix, { companyId = 'company-1', dryRun = false } = {}) {
  const shipmentId = `shipment-${suffix}`;
  const accepted = await repository.acceptWebhook(
    eventRecord({ eventId: `event-${suffix}`, companyId, shipmentId }),
    normalizedShipment({ shipmentId }),
    dryRun,
  );
  return { accepted, shipmentId, job: findLongDocument(harness.documents('invoice_jobs'), 'jobId', accepted.jobId) };
}

async function makeHeldJob(harness, repository, suffix, options = {}) {
  const accepted = await acceptFor(harness, repository, suffix, { ...options, dryRun: true });
  const requestJson = ` [ { "TRAN_DOC_NO" : "VR-${accepted.shipmentId}-1", "NOTE" : "رياض" } ] `;
  replaceJob(harness, accepted.accepted.jobId, {
    state: JOB_STATES.SUBMISSION_HELD,
    oeisRequestJson: requestJson,
    requestHash: `request-hash-${suffix}`,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    lockedAt: new Date(FIXED_NOW),
    version: 4,
    updatedAt: new Date(FIXED_NOW),
  });
  return { ...accepted, requestJson };
}

function entityAudit({
  companyId = 'company-1',
  applicationId = 'application-1',
  shipmentId = 'shipment-1',
  jobId = 1,
  documentNumber = `VR-${shipmentId}-1`,
  scopeId = String(jobId),
  parentVersion = 0,
  attemptNumber = 0,
  stage = 'VALIDATION',
  action = 'VALIDATION_PASSED',
  outcome = 'SUCCESS',
  safeCode = null,
  occurredAt = '2026-08-17T10:00:00.000Z',
} = {}) {
  const eventKey = createEventKey({
    kind: 'ENTITY',
    companyId,
    shipmentId,
    scopeKind: 'JOB',
    scopeId,
    parentVersion,
    attemptNumber,
    stage,
    action,
    outcome,
  });
  return createAuditEvent({
    eventKey,
    operationKey: null,
    companyId,
    applicationId,
    shipmentId,
    jobId,
    documentNumber,
    stage,
    action,
    outcome,
    attemptNumber,
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

function lockOperationAudit({
  companyId = 'company-1',
  applicationId = 'application-1',
  shipmentId = 'shipment-1',
  jobId = 1,
  expectedParentVersion = 0,
  attemptNumber = 1,
  occurredAt = '2026-08-17T10:00:00.000Z',
  summaryShipmentId = shipmentId,
  summaryDocumentNumber = `VR-${shipmentId}-1`,
} = {}) {
  const operationKey = createOperationKey({
    targetKind: 'JOB',
    targetId: String(jobId),
    expectedParentVersion,
    attemptNumber,
    stage: 'FYND_LOCK',
    action: 'FYND_LOCK_REQUESTED',
  });
  const eventKey = createEventKey({
    kind: 'OPERATION',
    operationKey,
    stage: 'FYND_LOCK',
    action: 'FYND_LOCK_REQUESTED',
    outcome: 'STARTED',
  });
  const event = createAuditEvent({
    eventKey,
    operationKey,
    companyId,
    applicationId,
    shipmentId,
    jobId,
    documentNumber: `VR-${shipmentId}-1`,
    stage: 'FYND_LOCK',
    action: 'FYND_LOCK_REQUESTED',
    outcome: 'STARTED',
    attemptNumber,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: sanitizeFyndSummary('REQUEST', {
      operation: 'LOCK',
      shipmentId: summaryShipmentId,
      documentNumber: summaryDocumentNumber,
      requestedLock: true,
      requestedStatus: null,
    }),
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(occurredAt) });
  return { operationKey, eventKey, event };
}

function oeisOperationAudit({
  companyId = 'company-1',
  applicationId = 'application-1',
  shipmentId = 'shipment-1',
  jobId = 1,
  expectedParentVersion = 0,
  attemptNumber = 1,
  occurredAt = '2026-08-17T10:00:00.000Z',
  requestSha256 = PREPARED_REQUEST_HASH,
  summaryDocumentNumber = `VR-${shipmentId}-1`,
  summaryDocumentType = 'IN',
  summaryAttemptNumber = attemptNumber,
} = {}) {
  const operationKey = createOperationKey({
    targetKind: 'JOB',
    targetId: String(jobId),
    expectedParentVersion,
    attemptNumber,
    stage: 'OEIS_SUBMISSION',
    action: 'OEIS_SUBMISSION_REQUESTED',
  });
  const eventKey = createEventKey({
    kind: 'OPERATION',
    operationKey,
    stage: 'OEIS_SUBMISSION',
    action: 'OEIS_SUBMISSION_REQUESTED',
    outcome: 'STARTED',
  });
  const event = createAuditEvent({
    eventKey,
    operationKey,
    companyId,
    applicationId,
    shipmentId,
    jobId,
    documentNumber: `VR-${shipmentId}-1`,
    stage: 'OEIS_SUBMISSION',
    action: 'OEIS_SUBMISSION_REQUESTED',
    outcome: 'STARTED',
    attemptNumber,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: sanitizeOeisSummary('REQUEST', {
      documentNumber: summaryDocumentNumber,
      documentType: summaryDocumentType,
      lineCount: 1,
      currency: 'SAR',
      netAmount: '100.00',
      taxAmount: '15.00',
      totalAmount: '115.00',
      taxSummaries: [{ category: 'S', rate: '15.00', reasonCode: null, lineCount: 1 }],
      requestByteCount: Buffer.byteLength(PREPARED_REQUEST_JSON, 'utf8'),
      requestSha256,
      endpointPath: '/API/V2/Transaction/UpdateInvoiceData',
      attemptNumber: summaryAttemptNumber,
      timeoutMs: 15_000,
    }),
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(occurredAt) });
  return { operationKey, eventKey, event };
}

function lockReadbackAudit({
  companyId = 'company-1',
  applicationId = 'application-1',
  shipmentId = 'shipment-1',
  jobId = 1,
  expectedParentVersion = 0,
  attemptNumber = 1,
  occurredAt = '2026-08-17T10:00:00.000Z',
} = {}) {
  const operationKey = createOperationKey({
    targetKind: 'JOB',
    targetId: String(jobId),
    expectedParentVersion,
    attemptNumber,
    stage: 'FYND_LOCK',
    action: 'FYND_LOCK_READBACK',
  });
  const eventKey = createEventKey({
    kind: 'OPERATION',
    operationKey,
    stage: 'FYND_LOCK',
    action: 'FYND_LOCK_READBACK',
    outcome: 'STARTED',
  });
  const event = createAuditEvent({
    eventKey,
    operationKey,
    companyId,
    applicationId,
    shipmentId,
    jobId,
    documentNumber: `VR-${shipmentId}-1`,
    stage: 'FYND_LOCK',
    action: 'FYND_LOCK_READBACK',
    outcome: 'STARTED',
    attemptNumber,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: sanitizeFyndSummary('REQUEST', {
      operation: 'LOCK_READBACK',
      shipmentId,
      documentNumber: `VR-${shipmentId}-1`,
      requestedLock: null,
      requestedStatus: null,
    }),
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(occurredAt) });
  return { operationKey, eventKey, event };
}

function lockOutcomeAudit(started, {
  companyId = 'company-1',
  applicationId = 'application-1',
  shipmentId = 'shipment-1',
  jobId = 1,
  attemptNumber = 1,
  completedAt = '2026-08-17T10:00:00.025Z',
} = {}) {
  const eventKey = createEventKey({
    kind: 'OPERATION',
    operationKey: started.operationKey,
    stage: 'FYND_LOCK',
    action: 'FYND_LOCK_CONFIRMED',
    outcome: 'SUCCESS',
  });
  return createAuditEvent({
    eventKey,
    operationKey: started.operationKey,
    companyId,
    applicationId,
    shipmentId,
    jobId,
    documentNumber: `VR-${shipmentId}-1`,
    stage: 'FYND_LOCK',
    action: 'FYND_LOCK_CONFIRMED',
    outcome: 'SUCCESS',
    attemptNumber,
    startedAt: new Date(started.event.occurredAt),
    completedAt: new Date(completedAt),
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: null,
    responseSummary: sanitizeFyndSummary('RESPONSE', {
      operation: 'LOCK',
      shipmentId,
      documentNumber: `VR-${shipmentId}-1`,
      responseStatus: 200,
      locked: true,
      shipmentState: 'bag_confirmed',
      finalStateClassification: 'LOCKED',
      retryable: false,
      latencyMs: Date.parse(completedAt) - Date.parse(started.event.occurredAt),
    }),
    artifactJobId: null,
  }, { now: () => new Date(completedAt) });
}

describe('Mongo repository staged port and BSON codecs', () => {
  test('keeps the legacy port unchanged and adds the exact frozen staged Mongo capability', () => {
    expect(REQUIRED_REPOSITORY_METHODS).toEqual([
      'initialize',
      'acceptWebhook',
      'claimNextJob',
      'savePreparedRequest',
      'markShipmentLocked',
      'markOeisAcceptedAndEnqueue',
      'scheduleJobRetry',
      'markJobFailed',
      'markJobIndeterminate',
      'claimNextOutbox',
      'scheduleOutboxRetry',
      'markOutboxIndeterminate',
      'completeOutboxAndJob',
      'releaseExpiredLeases',
      'getJob',
      'getArtifact',
      'close',
    ]);
    expect(MONGO_REPOSITORY_METHODS).toEqual([
      'listDryRunJobsForCompany',
      'listFailedJobsForCompany',
      'getDryRunJobForCompany',
      'getDryRunRequestForCompany',
      'appendAuditEvents',
      'beginExternalOperation',
      'findUnresolvedAuditOperation',
      'listShipmentAuditHeadsForCompany',
      'listPreJobFailureHeadsForCompany',
      'listShipmentAuditEventsForCompany',
      'importHeldOeisResponseAndEnqueue',
    ]);
    expect(Object.isFrozen(MONGO_REPOSITORY_METHODS)).toBe(true);
    expect(MONGO_TRANSACTION_TIMEOUT_MS).toBe(5_000);
    expect(typeof MONGO_TRANSACTION_TIMEOUT_MS).toBe('number');
    expect(Object.isFrozen(MONGO_TRANSACTION_TIMEOUT_MS)).toBe(true);
  });

  test('validates a frozen plain own-data repository without executing accessors or Proxy traps', async () => {
    const { repository } = createRepository();
    expect(assertMongoInvoiceRepository(repository)).toBe(repository);
    expect(Object.getPrototypeOf(repository)).toBe(Object.prototype);
    expect(Object.isFrozen(repository)).toBe(true);

    let getterCalls = 0;
    const accessor = { ...repository };
    Object.defineProperty(accessor, 'appendAuditEvents', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('private repository getter');
      },
    });
    expect(() => assertMongoInvoiceRepository(accessor)).toThrow(
      safeErrorExpectation('REPOSITORY_PORT_INVALID', 'Invoice repository does not implement the required interface'),
    );
    expect(getterCalls).toBe(0);

    const extraAccessor = { ...repository };
    Object.defineProperty(extraAccessor, 'privateExtension', {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error('extra private repository getter');
      },
    });
    expect(() => assertMongoInvoiceRepository(extraAccessor)).toThrow(
      safeErrorExpectation('REPOSITORY_PORT_INVALID', 'Invoice repository does not implement the required interface'),
    );
    expect(getterCalls).toBe(0);

    const traps = { get: 0, getPrototypeOf: 0, getOwnPropertyDescriptor: 0 };
    const proxy = new Proxy(repository, {
      get(target, property, receiver) {
        traps.get += 1;
        return Reflect.get(target, property, receiver);
      },
      getPrototypeOf(target) {
        traps.getPrototypeOf += 1;
        return Reflect.getPrototypeOf(target);
      },
      getOwnPropertyDescriptor(target, property) {
        traps.getOwnPropertyDescriptor += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    expect(() => assertMongoInvoiceRepository(proxy)).toThrow(
      safeErrorExpectation('REPOSITORY_PORT_INVALID', 'Invoice repository does not implement the required interface'),
    );
    expect(traps).toEqual({ get: 0, getPrototypeOf: 0, getOwnPropertyDescriptor: 0 });
  });

  test.each([
    ['positive zero', () => encodePositiveLong(0), 'REPOSITORY_INPUT_INVALID'],
    ['positive unsafe', () => encodePositiveLong(Number.MAX_SAFE_INTEGER + 1), 'REPOSITORY_INPUT_INVALID'],
    ['nonnegative negative', () => encodeNonnegativeLong(-1), 'REPOSITORY_INPUT_INVALID'],
    ['decoded number', () => decodePositiveLong(1), 'REPOSITORY_DATA_INVALID'],
    ['decoded zero', () => decodePositiveLong(Long.ZERO), 'REPOSITORY_DATA_INVALID'],
    ['decoded negative', () => decodeNonnegativeLong(Long.NEG_ONE), 'REPOSITORY_DATA_INVALID'],
    ['decoded unsafe', () => decodePositiveLong(Long.fromString('9007199254740992')), 'REPOSITORY_DATA_INVALID'],
  ])('rejects %s at the BSON Long boundary with a fixed safe error', (_label, operation, code) => {
    expect(operation).toThrow(safeErrorExpectation(
      code,
      code === 'REPOSITORY_INPUT_INVALID'
        ? 'Invoice repository input is invalid'
        : 'Invoice repository data is invalid',
    ));
  });

  test('round-trips zero, one, and MAX_SAFE_INTEGER as exact signed BSON Long values', () => {
    const one = encodePositiveLong(1);
    const maximum = encodePositiveLong(Number.MAX_SAFE_INTEGER);
    const zero = encodeNonnegativeLong(0);

    expect(Long.isLong(one)).toBe(true);
    expect(Long.isLong(maximum)).toBe(true);
    expect(Long.isLong(zero)).toBe(true);
    expect(one.equals(Long.ONE)).toBe(true);
    expect(maximum.equals(Long.fromString('9007199254740991'))).toBe(true);
    expect(zero.equals(Long.ZERO)).toBe(true);
    expect(decodePositiveLong(one)).toBe(1);
    expect(decodePositiveLong(maximum)).toBe(Number.MAX_SAFE_INTEGER);
    expect(decodeNonnegativeLong(zero)).toBe(0);
    expect(encodeNullablePositiveLong(null)).toBeNull();
    expect(decodeNullablePositiveLong(null)).toBeNull();
  });

  test('rejects Long subclasses and transparent Long proxies without executing traps', () => {
    class LongSubclass extends Long {}
    const subclass = new LongSubclass(1, 0, false);
    let traps = 0;
    const proxy = new Proxy(Long.ONE, {
      get() { traps += 1; return undefined; },
      getPrototypeOf() { traps += 1; return Long.prototype; },
    });

    expect(() => decodePositiveLong(subclass)).toThrow(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
    expect(() => decodePositiveLong(proxy)).toThrow(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
    expect(traps).toBe(0);
  });

  test('rejects malformed exact Long own fields without executing stored accessors', () => {
    let accessorCalls = 0;
    const accessorLong = Long.fromNumber(1);
    Object.defineProperty(accessorLong, 'unsigned', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return false;
      },
    });
    const overriddenLong = Long.fromNumber(1);
    Object.defineProperty(overriddenLong, 'toBigInt', {
      enumerable: false,
      get() {
        accessorCalls += 1;
        return Long.prototype.toBigInt;
      },
    });
    const fractionalLong = Long.fromNumber(1);
    fractionalLong.low = 1.5;

    for (const value of [accessorLong, overriddenLong, fractionalLong]) {
      expect(() => decodePositiveLong(value)).toThrow(
        safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
      );
    }
    expect(accessorCalls).toBe(0);
  });

  test('converts only canonical millisecond timestamps to fresh exact BSON Dates and back', () => {
    const encoded = encodeDate('2026-08-17T10:00:00.000Z');
    expect(encoded).toBeInstanceOf(Date);
    expect(Object.getPrototypeOf(encoded)).toBe(Date.prototype);
    expect(encoded.toISOString()).toBe('2026-08-17T10:00:00.000Z');
    expect(decodeDate(encoded)).toBe('2026-08-17T10:00:00.000Z');
    expect(encodeNullableDate(null)).toBeNull();
    expect(decodeNullableDate(null)).toBeNull();

    encoded.setUTCFullYear(2030);
    expect(encodeDate('2026-08-17T10:00:00.000Z').toISOString())
      .toBe('2026-08-17T10:00:00.000Z');
  });

  test.each([
    ['offset ISO input', () => encodeDate('2026-08-17T13:00:00.000+03:00'), 'REPOSITORY_INPUT_INVALID'],
    ['missing milliseconds', () => encodeDate('2026-08-17T10:00:00Z'), 'REPOSITORY_INPUT_INVALID'],
    ['native Date input', () => encodeDate(FIXED_NOW), 'REPOSITORY_INPUT_INVALID'],
    ['stored ISO string', () => decodeDate(FIXED_NOW.toISOString()), 'REPOSITORY_DATA_INVALID'],
    ['invalid stored Date', () => decodeDate(new Date(Number.NaN)), 'REPOSITORY_DATA_INVALID'],
    ['stored expanded year', () => decodeDate(new Date(Date.UTC(10_000, 0, 1))), 'REPOSITORY_DATA_INVALID'],
    ['Date subclass', () => decodeDate(new (class extends Date {})(FIXED_NOW)), 'REPOSITORY_DATA_INVALID'],
  ])('rejects %s at the BSON Date boundary', (_label, operation, code) => {
    expect(operation).toThrow(safeErrorExpectation(
      code,
      code === 'REPOSITORY_INPUT_INVALID'
        ? 'Invoice repository input is invalid'
        : 'Invoice repository data is invalid',
    ));
  });
});

describe('Mongo repository initialization and lifecycle foundation', () => {
  test('is import-pure and rejects unsafe factory surfaces without touching the driver', () => {
    const harness = createMongoRepositoryHarness();
    const repository = createMongoInvoiceRepository({
      db: harness.db,
      client: harness.client,
      now: () => new Date(FIXED_NOW),
    });
    expect(harness.trace.collectionCalls).toEqual([]);
    expect(harness.trace.startedSessions).toBe(0);
    expect(Object.isFrozen(repository)).toBe(true);

    let getterCalls = 0;
    const options = { client: harness.client, now: () => new Date(FIXED_NOW) };
    Object.defineProperty(options, 'db', {
      enumerable: true,
      get() { getterCalls += 1; throw new Error('private db getter'); },
    });
    expect(() => createMongoInvoiceRepository(options)).toThrow(
      safeErrorExpectation('REPOSITORY_CONFIG_INVALID', 'Invoice repository configuration is invalid'),
    );
    expect(getterCalls).toBe(0);

    const proxy = new Proxy({ db: harness.db, client: harness.client }, {
      get() { throw new Error('private options trap'); },
    });
    expect(() => createMongoInvoiceRepository(proxy)).toThrow(
      safeErrorExpectation('REPOSITORY_CONFIG_INVALID', 'Invoice repository configuration is invalid'),
    );
  });

  test('publishes the exact stable collection and secondary-index catalog', () => {
    expect(MONGO_COLLECTION_NAMES).toEqual([
      'fdk_sessions',
      'webhook_events',
      'invoice_jobs',
      'invoice_artifacts',
      'oeis_response_attempts',
      'invoice_outbox',
      'counters',
      'migration_markers',
      'shipment_audit_events',
      'shipment_audit_heads',
    ]);
    expect(MONGO_INDEX_CATALOG).toEqual({
      fdk_sessions: [{
        name: 'fdk_sessions_expiresAt_ttl',
        key: { expiresAt: 1 },
        expireAfterSeconds: 0,
      }],
      webhook_events: [{
        name: 'webhook_events_companyId_eventId_uq',
        key: { companyId: 1, eventId: 1 },
        unique: true,
        collation: { locale: 'simple' },
      }],
      invoice_jobs: [
        { name: 'invoice_jobs_jobId_uq', key: { jobId: 1 }, unique: true },
        {
          name: 'invoice_jobs_companyId_shipmentId_documentType_uq',
          key: { companyId: 1, shipmentId: 1, documentType: 1 },
          unique: true,
          collation: { locale: 'simple' },
        },
        {
          name: 'invoice_jobs_companyId_documentNumber_uq',
          key: { companyId: 1, documentNumber: 1 },
          unique: true,
          collation: { locale: 'simple' },
        },
        {
          name: 'invoice_jobs_claim',
          key: { state: 1, dueAt: 1, leaseExpiresAt: 1, jobId: 1 },
          collation: { locale: 'simple' },
        },
        {
          name: 'invoice_jobs_companyId_state_jobId_list',
          key: { companyId: 1, state: 1, jobId: -1 },
          collation: { locale: 'simple' },
        },
      ],
      invoice_artifacts: [
        { name: 'invoice_artifacts_jobId_uq', key: { jobId: 1 }, unique: true },
        { name: 'invoice_artifacts_transactionNumber_uq', key: { transactionNumber: 1 }, unique: true },
        { name: 'invoice_artifacts_uuid_uq', key: { uuid: 1 }, unique: true },
      ],
      oeis_response_attempts: [
        {
          name: 'oeis_response_attempts_jobId_attemptNumber_uq',
          key: { jobId: 1, attemptNumber: 1 }, unique: true,
        },
        {
          name: 'oeis_response_attempts_responseIdentity_uq',
          key: { responseIdentity: 1 }, unique: true, collation: { locale: 'simple' },
        },
        {
          name: 'oeis_response_attempts_expiresAt_ttl',
          key: { expiresAt: 1 }, expireAfterSeconds: 0,
        },
      ],
      invoice_outbox: [
        { name: 'invoice_outbox_outboxId_uq', key: { outboxId: 1 }, unique: true },
        {
          name: 'invoice_outbox_jobId_action_uq',
          key: { jobId: 1, action: 1 },
          unique: true,
          collation: { locale: 'simple' },
        },
        {
          name: 'invoice_outbox_claim',
          key: { parentState: 1, status: 1, dueAt: 1, leaseExpiresAt: 1, outboxId: 1 },
          collation: { locale: 'simple' },
        },
      ],
      counters: [],
      migration_markers: [],
      shipment_audit_events: [
        {
          name: 'shipment_audit_events_eventKey_uq',
          key: { eventKey: 1 },
          unique: true,
          collation: { locale: 'simple' },
        },
        {
          name: 'shipment_audit_events_timeline',
          key: { companyId: 1, shipmentId: 1, occurredAt: -1, eventKey: -1 },
          collation: { locale: 'simple' },
        },
        {
          name: 'shipment_audit_events_recent',
          key: { companyId: 1, occurredAt: -1, _id: -1 },
          collation: { locale: 'simple' },
        },
        {
          name: 'shipment_audit_events_unresolved',
          key: { operationKey: 1, outcome: 1 },
          collation: { locale: 'simple' },
        },
        {
          name: 'shipment_audit_events_unresolved_target',
          key: {
            companyId: 1,
            jobId: 1,
            stage: 1,
            outcome: 1,
            occurredAt: -1,
            eventKey: -1,
          },
          collation: { locale: 'simple' },
        },
        {
          name: 'shipment_audit_events_pre_job_failure_repair',
          key: {
            jobId: 1,
            documentNumber: 1,
            outcome: 1,
            action: 1,
            _id: 1,
            expiresAt: 1,
          },
          collation: { locale: 'simple' },
        },
        {
          name: 'shipment_audit_events_expiresAt_ttl',
          key: { expiresAt: 1 },
          expireAfterSeconds: 0,
        },
      ],
      shipment_audit_heads: [
        {
          name: 'shipment_audit_heads_companyId_shipmentId_uq',
          key: { companyId: 1, shipmentId: 1 },
          unique: true,
          collation: { locale: 'simple' },
        },
        {
          name: 'shipment_audit_heads_recent',
          key: { companyId: 1, lastOccurredAt: -1, shipmentId: -1 },
          collation: { locale: 'simple' },
        },
        {
          name: 'shipment_audit_heads_pre_job_failures',
          key: {
            companyId: 1,
            jobId: 1,
            documentNumber: 1,
            lastOutcome: 1,
            lastAction: 1,
            lastOccurredAt: -1,
            shipmentId: -1,
            expiresAt: 1,
          },
          collation: { locale: 'simple' },
        },
        {
          name: 'shipment_audit_heads_expiresAt_ttl',
          key: { expiresAt: 1 },
          expireAfterSeconds: 0,
        },
      ],
    });
    expect(Object.isFrozen(MONGO_COLLECTION_NAMES)).toBe(true);
    expect(Object.isFrozen(MONGO_INDEX_CATALOG)).toBe(true);
    expect(Object.isFrozen(MONGO_INDEX_CATALOG.invoice_jobs[0].key)).toBe(true);
  });

  test('creates every owned index, verifies the pre-created FDK TTL index, seeds BSON counters, and aborts a real transaction probe', async () => {
    const { harness, repository, clock } = await initializeRepository();

    expect(harness.trace.databaseOperations.filter(operation => (
      operation.method === 'createCollection'
    ))).toEqual(MONGO_COLLECTION_NAMES.map(name => ({
      method: 'createCollection', name, options: {},
    })));
    expect(harness.trace.databaseOperations.filter(operation => (
      operation.method === 'listCollections'
    ))).toEqual([{
      method: 'listCollections', filter: {}, options: { nameOnly: false },
    }]);
    expect([...new Set(harness.trace.collectionCalls)].sort()).toEqual(
      [...MONGO_COLLECTION_NAMES].sort(),
    );
    expect(harness.trace.operations.filter(operation => (
      operation.collection === 'fdk_sessions' && operation.method === 'createIndex'
    ))).toEqual([]);
    for (const collectionName of MONGO_COLLECTION_NAMES) {
      expect(harness.indexes(collectionName).map(index => index.name)).toEqual([
        '_id_',
        ...MONGO_INDEX_CATALOG[collectionName].map(index => index.name),
      ]);
    }
    expect(harness.documents('counters')).toHaveLength(2);
    expect(harness.documents('counters')).toEqual(expect.arrayContaining([
      expect.objectContaining({ _id: 'invoice_job' }),
      expect.objectContaining({ _id: 'invoice_outbox' }),
    ]));
    for (const counter of harness.documents('counters')) {
      expect(Long.isLong(counter.value)).toBe(true);
      expect(counter.value.equals(Long.ZERO)).toBe(true);
    }
    expect(harness.trace.transactionOptions).toEqual([{
      readPreference: 'primary',
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      timeoutMS: 5_000,
    }]);
    expect(harness.trace.aborts).toBe(1);
    expect(harness.trace.commits).toBe(0);
    expect(harness.trace.startedSessions).toBe(1);
    expect(harness.trace.endedSessions).toBe(1);
    expect(harness.documents('migration_markers')).toEqual([
      PRE_JOB_FAILURE_HEAD_REPAIR_MARKER,
    ]);
    expect(clock.calls()).toBe(0);

    await expect(repository.initialize()).resolves.toBeUndefined();
    expect(harness.trace.startedSessions).toBe(1);
  });

  test('a valid completion marker skips the bounded repair scan and clock', async () => {
    const harness = createMongoRepositoryHarness();
    harness.seed('migration_markers', [PRE_JOB_FAILURE_HEAD_REPAIR_MARKER]);
    const fixture = createRepository({ harness });

    await expect(fixture.repository.initialize()).resolves.toBeUndefined();

    expect(fixture.clock.calls()).toBe(0);
    expect(harness.documents('migration_markers')).toEqual([
      PRE_JOB_FAILURE_HEAD_REPAIR_MARKER,
    ]);
    expect(harness.trace.operations.filter(operation => (
      operation.collection === 'shipment_audit_events'
      && operation.method === 'find'
      && operation.filter?.jobId === null
      && operation.filter?.documentNumber === null
      && operation.filter?.outcome === 'FAILURE'
    ))).toEqual([]);
    expect(harness.trace.operations.filter(operation => (
      operation.collection === 'migration_markers' && operation.method === 'updateOne'
    ))).toEqual([]);
  });

  test('a corrupt completion marker fails closed before the repair scan', async () => {
    const harness = createMongoRepositoryHarness();
    harness.seed('migration_markers', [{
      ...PRE_JOB_FAILURE_HEAD_REPAIR_MARKER,
      version: 2,
    }]);
    const fixture = createRepository({ harness });

    await expect(fixture.repository.initialize()).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_INITIALIZATION_FAILED', 'Invoice repository initialization failed',
    ));

    expect(fixture.clock.calls()).toBe(0);
    expect(harness.trace.operations.filter(operation => (
      operation.collection === 'shipment_audit_events'
      && operation.method === 'find'
      && operation.filter?.jobId === null
      && operation.filter?.documentNumber === null
      && operation.filter?.outcome === 'FAILURE'
    ))).toEqual([]);
    expect(harness.trace.operations.filter(operation => (
      operation.collection === 'migration_markers' && operation.method === 'updateOne'
    ))).toEqual([]);
  });

  test('a completion-write crash leaves repair resumable and duplicate replay valid', async () => {
    const fixture = createRepository();
    const {
      receipt, validationStarted, validationFailed, webhookRejected, events,
    } = sameClockPreJobFailureLifecycle();
    fixture.harness.seed('shipment_audit_events', events.map(audit => ({
      _id: fixture.harness.nextObjectId(),
      ...storedAuditEvent(audit),
    })));
    fixture.harness.seed('shipment_audit_heads', [{
      _id: fixture.harness.nextObjectId(),
      ...storedAuditHead(receipt, { version: 19 }),
    }]);
    fixture.harness.throwNext(
      'migration_markers', 'updateOne', new Error('private marker write failure'),
    );

    await expect(fixture.repository.initialize()).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_INITIALIZATION_FAILED', 'Invoice repository initialization failed',
    ));
    expect(fixture.harness.documents('migration_markers')).toEqual([]);
    expect(fixture.harness.documents('shipment_audit_heads')).toEqual([
      expect.objectContaining({
        lastAction: 'VALIDATION_FAILED',
        lastEventKey: validationFailed.eventKey,
        version: 19,
      }),
    ]);

    await expect(fixture.repository.initialize()).resolves.toBeUndefined();
    expect(fixture.harness.documents('migration_markers')).toEqual([
      PRE_JOB_FAILURE_HEAD_REPAIR_MARKER,
    ]);
    await expect(fixture.repository.appendAuditEvents([
      webhookRejected, validationFailed, validationStarted, receipt,
    ])).resolves.toBeUndefined();
    expect(fixture.harness.documents('shipment_audit_events')).toHaveLength(4);
    expect(fixture.harness.documents('shipment_audit_heads')).toEqual([
      expect.objectContaining({
        lastAction: 'VALIDATION_FAILED',
        lastEventKey: validationFailed.eventKey,
        version: 19,
      }),
    ]);
  });

  test('concurrent initializers safely converge on one exact completion marker', async () => {
    const harness = createMongoRepositoryHarness();
    const first = createRepository({ harness });
    const second = createRepository({ harness });

    await expect(Promise.all([
      first.repository.initialize(), second.repository.initialize(),
    ])).resolves.toEqual([undefined, undefined]);

    expect(harness.documents('migration_markers')).toEqual([
      PRE_JOB_FAILURE_HEAD_REPAIR_MARKER,
    ]);
    expect(harness.trace.operations.filter(operation => (
      operation.collection === 'migration_markers' && operation.method === 'updateOne'
    ))).toHaveLength(2);
    expect(first.clock.calls()).toBe(1);
    expect(second.clock.calls()).toBe(1);
  });

  test('initialization canonicalizes a seeded legacy same-clock failure head before reads and replay', async () => {
    const fixture = createRepository();
    const {
      event,
      receipt,
      validationStarted,
      validationFailed,
      webhookRejected,
      events,
    } = sameClockPreJobFailureLifecycle();
    expect(receipt.eventKey > validationStarted.eventKey).toBe(true);
    expect(receipt.eventKey > validationFailed.eventKey).toBe(true);
    expect(receipt.eventKey > webhookRejected.eventKey).toBe(true);
    const firstOccurredAt = new Date('2026-08-17T09:59:00.000Z');
    const legacyVersion = 27;
    fixture.harness.seed('shipment_audit_events', events.map(audit => ({
      _id: fixture.harness.nextObjectId(),
      ...storedAuditEvent(audit),
    })));
    fixture.harness.seed('shipment_audit_heads', [{
      _id: fixture.harness.nextObjectId(),
      ...storedAuditHead(receipt, { firstOccurredAt, version: legacyVersion }),
    }]);

    await expect(fixture.repository.initialize()).resolves.toBeUndefined();

    const repaired = fixture.harness.documents('shipment_audit_heads');
    expect(repaired).toEqual([
      expect.objectContaining({
        companyId: event.companyId,
        shipmentId: event.shipmentId,
        jobId: null,
        documentNumber: null,
        lastStage: 'VALIDATION',
        lastAction: 'VALIDATION_FAILED',
        lastOutcome: 'FAILURE',
        lastSafeCode: 'WEBHOOK_VALIDATION_FAILED',
        firstOccurredAt,
        lastOccurredAt: new Date(validationFailed.occurredAt),
        lastEventKey: validationFailed.eventKey,
        expiresAt: new Date(validationFailed.expiresAt),
        version: legacyVersion,
      }),
    ]);
    expect(fixture.clock.calls()).toBe(1);
    expect(fixture.harness.trace.transactionOptions).toHaveLength(2);
    expect(fixture.harness.trace.transactionOptions).toEqual([
      expect.objectContaining({ timeoutMS: MONGO_TRANSACTION_TIMEOUT_MS }),
      expect.objectContaining({ timeoutMS: MONGO_TRANSACTION_TIMEOUT_MS }),
    ]);
    expect(fixture.harness.trace.commits).toBe(1);

    const writesBeforeRead = fixture.harness.trace.operations.filter(operation => (
      operation.collection === 'shipment_audit_heads' && operation.method === 'updateOne'
    )).length;
    await expect(fixture.repository.listPreJobFailureHeadsForCompany({
      companyId: event.companyId, limit: 20, before: null,
    })).resolves.toEqual({
      items: [expect.objectContaining({
        shipmentId: event.shipmentId,
        lastAction: 'VALIDATION_FAILED',
        lastOutcome: 'FAILURE',
        version: legacyVersion,
      })],
      nextBefore: null,
    });
    expect(fixture.harness.trace.operations.filter(operation => (
      operation.collection === 'shipment_audit_heads' && operation.method === 'updateOne'
    ))).toHaveLength(writesBeforeRead);
    expect(fixture.harness.documents('shipment_audit_heads')).toEqual(repaired);

    await expect(fixture.repository.appendAuditEvents([
      webhookRejected, validationFailed, validationStarted, receipt,
    ])).resolves.toBeUndefined();
    expect(fixture.harness.documents('shipment_audit_events')).toHaveLength(4);
    expect(fixture.harness.documents('shipment_audit_heads')).toEqual(repaired);
  });

  test('initialization restores a job-bound accepted maximum from a mixed legacy same-clock head', async () => {
    const fixture = createRepository();
    const event = eventRecord({
      eventId: 'mixed-clock-0',
      shipmentId: 'shipment-mixed-clock-0',
    });
    const lifecycle = sameClockPreJobFailureLifecycle({ event });
    const accepted = webhookAcceptedAudit({
      event,
      jobId: 73,
      documentNumber: 'VR-shipment-mixed-clock-0-1',
      occurredAt: FIXED_NOW.toISOString(),
    });
    const events = [...lifecycle.events, accepted];
    expect(events.every(audit => audit.occurredAt === FIXED_NOW.toISOString())).toBe(true);
    expect(events.filter(audit => audit !== lifecycle.validationStarted).every(
      audit => lifecycle.validationStarted.eventKey > audit.eventKey,
    )).toBe(true);
    const firstOccurredAt = new Date('2026-08-17T09:57:00.000Z');
    fixture.harness.seed('shipment_audit_events', events.map(audit => ({
      _id: fixture.harness.nextObjectId(),
      ...storedAuditEvent(audit),
    })));
    fixture.harness.seed('shipment_audit_heads', [{
      _id: fixture.harness.nextObjectId(),
      ...storedAuditHead(lifecycle.validationStarted, {
        firstOccurredAt,
        version: 23,
      }),
    }]);

    await expect(fixture.repository.initialize()).resolves.toBeUndefined();
    await expect(fixture.repository.appendAuditEvents([
      accepted,
      lifecycle.webhookRejected,
      lifecycle.validationFailed,
      lifecycle.validationStarted,
      lifecycle.receipt,
    ])).resolves.toBeUndefined();

    expect(fixture.harness.documents('shipment_audit_events')).toHaveLength(5);
    expect(fixture.harness.documents('shipment_audit_heads')).toEqual([
      expect.objectContaining({
        companyId: event.companyId,
        shipmentId: event.shipmentId,
        jobId: Long.fromNumber(73),
        documentNumber: 'VR-shipment-mixed-clock-0-1',
        lastStage: 'WEBHOOK',
        lastAction: 'WEBHOOK_ACCEPTED',
        lastOutcome: 'SUCCESS',
        lastSafeCode: null,
        firstOccurredAt,
        lastOccurredAt: new Date(accepted.occurredAt),
        lastEventKey: accepted.eventKey,
        expiresAt: new Date(accepted.expiresAt),
        version: 23,
      }),
    ]);
    await expect(fixture.repository.listPreJobFailureHeadsForCompany({
      companyId: event.companyId, limit: 20, before: null,
    })).resolves.toEqual({ items: [], nextBefore: null });
  });

  test('initialization selects the canonical same-clock event through bounded pages', async () => {
    const fixture = createRepository();
    const event = eventRecord({
      eventId: 'mixed-clock-0',
      shipmentId: 'shipment-mixed-clock-paged',
    });
    const lifecycle = sameClockPreJobFailureLifecycle({ event });
    const accepted = webhookAcceptedAudit({
      event,
      jobId: 81,
      documentNumber: 'VR-shipment-mixed-clock-paged-1',
      occurredAt: FIXED_NOW.toISOString(),
    });
    const decoys = Array.from({ length: 100 }, (_unused, index) => webhookReceiptAudit({
      event: eventRecord({
        eventId: `mixed-clock-decoy-${String(index).padStart(3, '0')}`,
        shipmentId: event.shipmentId,
      }),
      occurredAt: FIXED_NOW.toISOString(),
    }));
    const events = [...lifecycle.events, accepted, ...decoys];
    fixture.harness.seed('shipment_audit_events', events.map(audit => ({
      _id: fixture.harness.nextObjectId(),
      ...storedAuditEvent(audit),
    })));
    fixture.harness.seed('shipment_audit_heads', [{
      _id: fixture.harness.nextObjectId(),
      ...storedAuditHead(lifecycle.validationStarted, { version: 29 }),
    }]);

    await expect(fixture.repository.initialize()).resolves.toBeUndefined();

    expect(fixture.harness.documents('shipment_audit_heads')).toEqual([
      expect.objectContaining({
        jobId: Long.fromNumber(81),
        lastAction: 'WEBHOOK_ACCEPTED',
        lastEventKey: accepted.eventKey,
        version: 29,
      }),
    ]);
    const canonicalScans = fixture.harness.trace.operations.filter(operation => (
      operation.collection === 'shipment_audit_events'
      && operation.method === 'find'
      && operation.session === true
      && operation.filter?.companyId === event.companyId
      && operation.filter?.shipmentId === event.shipmentId
      && operation.filter?.occurredAt instanceof Date
      && operation.filter?.action === undefined
    ));
    expect(canonicalScans).toHaveLength(2);
    expect(canonicalScans[0].filter).not.toHaveProperty('eventKey');
    expect(canonicalScans[1].filter).toEqual(expect.objectContaining({
      eventKey: { $gt: expect.any(String) },
    }));
  });

  test('initialization fails closed when one same-clock repair set exceeds 1000 rows', async () => {
    const fixture = createRepository();
    const event = eventRecord({
      eventId: 'mixed-clock-0',
      shipmentId: 'shipment-mixed-clock-oversized',
    });
    const lifecycle = sameClockPreJobFailureLifecycle({ event });
    const accepted = webhookAcceptedAudit({
      event,
      jobId: 91,
      documentNumber: 'VR-shipment-mixed-clock-oversized-1',
      occurredAt: FIXED_NOW.toISOString(),
    });
    const decoys = Array.from({ length: 996 }, (_unused, index) => webhookReceiptAudit({
      event: eventRecord({
        eventId: `mixed-clock-oversized-${String(index).padStart(4, '0')}`,
        shipmentId: event.shipmentId,
      }),
      occurredAt: FIXED_NOW.toISOString(),
    }));
    fixture.harness.seed('shipment_audit_events', [
      ...lifecycle.events, accepted, ...decoys,
    ].map(audit => ({
      _id: fixture.harness.nextObjectId(),
      ...storedAuditEvent(audit),
    })));
    fixture.harness.seed('shipment_audit_heads', [{
      _id: fixture.harness.nextObjectId(),
      ...storedAuditHead(lifecycle.validationStarted, { version: 31 }),
    }]);
    const legacyHead = fixture.harness.documents('shipment_audit_heads');

    await expect(fixture.repository.initialize()).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_INITIALIZATION_FAILED', 'Invoice repository initialization failed',
    ));

    expect(fixture.harness.documents('shipment_audit_heads')).toEqual(legacyHead);
    expect(fixture.harness.documents('migration_markers')).toEqual([]);
    expect(fixture.harness.trace.commits).toBe(0);
  });

  test('initialization iterates beyond one bounded failure-evidence page', async () => {
    const fixture = createRepository();
    const events = [];
    const heads = [];
    for (let index = 0; index < 100; index += 1) {
      const failure = preJobFailureAudit({
        shipmentId: `shipment-repair-page-${String(index).padStart(3, '0')}`,
        eventId: `event-repair-page-${String(index).padStart(3, '0')}`,
      });
      events.push({ _id: fixture.harness.nextObjectId(), ...storedAuditEvent(failure) });
      heads.push({ _id: fixture.harness.nextObjectId(), ...storedAuditHead(failure) });
    }
    const legacyEvent = eventRecord({
      eventId: 'same-clock-0',
      shipmentId: 'shipment-same-clock-0',
    });
    const legacyReceipt = webhookReceiptAudit({
      event: legacyEvent, occurredAt: FIXED_NOW.toISOString(),
    });
    const legacyFailure = preJobFailureAudit({
      companyId: legacyEvent.companyId,
      applicationId: legacyEvent.applicationId,
      shipmentId: legacyEvent.shipmentId,
      eventId: legacyEvent.eventId,
      occurredAt: FIXED_NOW.toISOString(),
    });
    expect(legacyReceipt.eventKey > legacyFailure.eventKey).toBe(true);
    events.push(
      { _id: fixture.harness.nextObjectId(), ...storedAuditEvent(legacyReceipt) },
      { _id: fixture.harness.nextObjectId(), ...storedAuditEvent(legacyFailure) },
    );
    heads.push({
      _id: fixture.harness.nextObjectId(),
      ...storedAuditHead(legacyReceipt, { version: 9 }),
    });
    fixture.harness.seed('shipment_audit_events', events);
    fixture.harness.seed('shipment_audit_heads', heads);

    await expect(fixture.repository.initialize()).resolves.toBeUndefined();

    expect(fixture.harness.documents('shipment_audit_heads').find(
      head => head.shipmentId === legacyEvent.shipmentId,
    )).toEqual(expect.objectContaining({
      lastAction: 'VALIDATION_FAILED',
      lastEventKey: legacyFailure.eventKey,
      version: 9,
    }));
    const validationFailureScans = fixture.harness.trace.operations.filter(operation => (
      operation.collection === 'shipment_audit_events'
      && operation.method === 'find'
      && operation.filter?.jobId === null
      && operation.filter?.documentNumber === null
      && operation.filter?.outcome === 'FAILURE'
      && operation.filter?.action === 'VALIDATION_FAILED'
    ));
    expect(validationFailureScans).toHaveLength(2);
    expect(validationFailureScans[0].filter).not.toHaveProperty('_id');
    expect(validationFailureScans[1].filter).toEqual(expect.objectContaining({
      _id: { $gt: expect.anything() },
    }));
    expect(fixture.harness.trace.commits).toBe(1);
  });

  test('initialization fails closed instead of repairing a legacy head without exact backing evidence', async () => {
    const fixture = createRepository();
    const {
      receipt, validationFailed, webhookRejected,
    } = sameClockPreJobFailureLifecycle();
    fixture.harness.seed('shipment_audit_events', [validationFailed, webhookRejected].map(audit => ({
      _id: fixture.harness.nextObjectId(),
      ...storedAuditEvent(audit),
    })));
    fixture.harness.seed('shipment_audit_heads', [{
      _id: fixture.harness.nextObjectId(),
      ...storedAuditHead(receipt, { version: 13 }),
    }]);
    const legacyHead = fixture.harness.documents('shipment_audit_heads');

    await expect(fixture.repository.initialize()).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_INITIALIZATION_FAILED', 'Invoice repository initialization failed',
    ));

    expect(fixture.harness.documents('migration_markers')).toEqual([]);
    expect(fixture.harness.documents('shipment_audit_heads')).toEqual(legacyHead);
    expect(fixture.harness.trace.commits).toBe(0);
    expect(() => fixture.repository.listPreJobFailureHeadsForCompany({
      companyId: 'company-1', limit: 20, before: null,
    })).toThrow(safeErrorExpectation(
      'REPOSITORY_NOT_INITIALIZED', 'Invoice repository is not initialized',
    ));
  });

  test('accepts Atlas omitting redundant simple collation metadata on default collections', async () => {
    const harness = createMongoRepositoryHarness({ omitSimpleCollationMetadata: true });
    const { repository } = createRepository({ harness });

    await expect(repository.initialize()).resolves.toBeUndefined();
    for (const [collectionName, definitions] of Object.entries(MONGO_INDEX_CATALOG)) {
      const actual = harness.indexes(collectionName);
      for (const definition of definitions.filter(index => index.collation)) {
        const stored = actual.find(index => index.name === definition.name);
        expect(stored).toBeDefined();
        expect(Object.prototype.hasOwnProperty.call(stored, 'collation')).toBe(false);
      }
    }
    const requestedSimple = harness.trace.operations.filter(operation => (
      operation.method === 'createIndex' && operation.options.collation?.locale === 'simple'
    )).map(operation => `${operation.collection}:${operation.options.name}`).sort();
    const expectedSimple = Object.entries(MONGO_INDEX_CATALOG).flatMap(
      ([collectionName, definitions]) => definitions
        .filter(definition => definition.collation)
        .map(definition => `${collectionName}:${definition.name}`),
    ).sort();
    expect(requestedSimple).toEqual(expectedSimple);
  });

  test('uses Atlas-compatible unfiltered namespace enumeration and validates names locally', async () => {
    const harness = createMongoRepositoryHarness({ rejectListCollectionsInFilter: true });
    const { repository } = createRepository({ harness });

    await expect(repository.initialize()).resolves.toBeUndefined();
    expect(harness.trace.databaseOperations.filter(operation => (
      operation.method === 'listCollections'
    ))).toEqual([{
      method: 'listCollections',
      filter: {},
      options: { nameOnly: false },
    }]);
  });

  test('rejects a required collection with nonempty server options', async () => {
    const harness = createMongoRepositoryHarness();
    harness.replaceCollectionOptions('counters', { capped: true });
    const { repository } = createRepository({ harness });

    await expect(repository.initialize()).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_INITIALIZATION_FAILED', 'Invoice repository initialization failed'),
    );
    expect(harness.trace.startedSessions).toBe(0);
  });

  test('two repositories safely resolve concurrent collection-creation races', async () => {
    const harness = createMongoRepositoryHarness();
    const first = createRepository({ harness }).repository;
    const second = createRepository({ harness }).repository;

    await expect(Promise.all([first.initialize(), second.initialize()])).resolves.toEqual([
      undefined, undefined,
    ]);
    expect([...harness.namespaces].sort()).toEqual([...MONGO_COLLECTION_NAMES].sort());
    expect(harness.trace.namespaceExistsErrors).toBeGreaterThanOrEqual(MONGO_COLLECTION_NAMES.length);
    expect(harness.trace.startedSessions).toBe(2);
    expect(harness.trace.endedSessions).toBe(2);
  });

  test('coalesces concurrent initialization and retries cleanly after a safe failure', async () => {
    const firstHarness = createMongoRepositoryHarness();
    const gate = deferred();
    firstHarness.gateNext('webhook_events', 'createIndex', gate.promise);
    const firstRepository = createRepository({ harness: firstHarness }).repository;
    const first = firstRepository.initialize();
    const second = firstRepository.initialize();
    expect(second).toBe(first);
    await Promise.resolve();
    gate.resolve('webhook_events_companyId_eventId_uq');
    await expect(first).resolves.toBeUndefined();
    expect(firstHarness.trace.startedSessions).toBe(1);

    const retryHarness = createMongoRepositoryHarness();
    retryHarness.throwNext('webhook_events', 'createIndex', new Error('raw private index failure'));
    const retryRepository = createRepository({ harness: retryHarness }).repository;
    await expect(retryRepository.initialize()).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_INITIALIZATION_FAILED', 'Invoice repository initialization failed'),
    );
    await expect(retryRepository.initialize()).resolves.toBeUndefined();
  });

  test.each([
    ['missing FDK TTL index', harness => harness.replaceIndexes('fdk_sessions', [
      { v: 2, key: { _id: 1 }, name: '_id_', unique: true },
    ])],
    ['unexpected secondary index', harness => harness.ensureCollection('invoice_jobs').indexes.push({
      v: 2, key: { state: 1 }, name: 'unexpected_state_index',
    })],
    ['equivalent index under another name', harness => harness.ensureCollection('webhook_events').indexes.push({
      v: 2,
      key: { companyId: 1, eventId: 1 },
      name: 'wrong_equivalent_name',
      unique: true,
      collation: { locale: 'simple' },
    })],
    ['same name with a changed key', harness => harness.ensureCollection('webhook_events').indexes.push({
      v: 2,
      key: { eventId: 1, companyId: 1 },
      name: 'webhook_events_companyId_eventId_uq',
      unique: true,
      collation: { locale: 'simple' },
    })],
    ['same name without unique', harness => harness.ensureCollection('webhook_events').indexes.push({
      v: 2,
      key: { companyId: 1, eventId: 1 },
      name: 'webhook_events_companyId_eventId_uq',
      collation: { locale: 'simple' },
    })],
    ['same name with a non-simple collation', harness => harness.ensureCollection('webhook_events').indexes.push({
      v: 2,
      key: { companyId: 1, eventId: 1 },
      name: 'webhook_events_companyId_eventId_uq',
      unique: true,
      collation: { locale: 'en' },
    })],
    ['same TTL name with a nonzero expiry', harness => harness.replaceIndexes('fdk_sessions', [
      { v: 2, key: { _id: 1 }, name: '_id_', unique: true },
      {
        v: 2,
        key: { expiresAt: 1 },
        name: 'fdk_sessions_expiresAt_ttl',
        expireAfterSeconds: 60,
      },
    ])],
    ['partial index option', harness => harness.ensureCollection('webhook_events').indexes.push({
      v: 2,
      key: { companyId: 1, eventId: 1 },
      name: 'webhook_events_companyId_eventId_uq',
      unique: true,
      collation: { locale: 'simple' },
      partialFilterExpression: { status: 'accepted' },
    })],
    ['explicit sparse false option', harness => harness.ensureCollection('webhook_events').indexes.push({
      v: 2,
      key: { companyId: 1, eventId: 1 },
      name: 'webhook_events_companyId_eventId_uq',
      unique: true,
      collation: { locale: 'simple' },
      sparse: false,
    })],
    ['explicit hidden false option', harness => harness.ensureCollection('webhook_events').indexes.push({
      v: 2,
      key: { companyId: 1, eventId: 1 },
      name: 'webhook_events_companyId_eventId_uq',
      unique: true,
      collation: { locale: 'simple' },
      hidden: false,
    })],
    ['own undefined partial option', harness => harness.ensureCollection('webhook_events').indexes.push({
      v: 2,
      key: { companyId: 1, eventId: 1 },
      name: 'webhook_events_companyId_eventId_uq',
      unique: true,
      collation: { locale: 'simple' },
      partialFilterExpression: undefined,
    })],
  ])('fails initialization for a stable-catalog mismatch: %s', async (_label, mutate) => {
    const harness = createMongoRepositoryHarness();
    mutate(harness);
    const { repository } = createRepository({ harness });
    const error = await repository.initialize().catch(value => value);
    expect(error).toEqual(
      safeErrorExpectation('REPOSITORY_INITIALIZATION_FAILED', 'Invoice repository initialization failed'),
    );
    expect(`${error.message} ${error.stack}`).not.toMatch(/raw|private|synthetic index/i);
    expect(harness.trace.startedSessions).toBe(0);
  });

  test('validates counter seed and transaction-probe driver results before becoming ready', async () => {
    const malformedSeed = createMongoRepositoryHarness();
    malformedSeed.returnNext('counters', 'updateOne', {
      acknowledged: true,
      matchedCount: 'private malformed count',
      modifiedCount: 0,
      upsertedCount: 0,
      upsertedId: null,
    });
    const seedRepository = createRepository({ harness: malformedSeed }).repository;
    await expect(seedRepository.initialize()).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_INITIALIZATION_FAILED', 'Invoice repository initialization failed'),
    );
    expect(malformedSeed.trace.startedSessions).toBe(0);

    const malformedProbe = createMongoRepositoryHarness();
    malformedProbe.returnNext('migration_markers', 'insertOne', {
      acknowledged: false,
      insertedId: '__repository_transaction_probe__',
    });
    const probeRepository = createRepository({ harness: malformedProbe }).repository;
    await expect(probeRepository.initialize()).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_INITIALIZATION_FAILED', 'Invoice repository initialization failed'),
    );
    expect(malformedProbe.trace.aborts).toBe(0);
    expect(malformedProbe.trace.endedSessions).toBe(1);
  });

  test('validates existing BSON counters while preserving imported nonnegative safe values', async () => {
    const valid = createMongoRepositoryHarness();
    valid.seed('counters', [
      { _id: 'invoice_job', value: Long.fromInt(40) },
      { _id: 'invoice_outbox', value: Long.fromString(String(Number.MAX_SAFE_INTEGER)) },
    ]);
    await expect(createRepository({ harness: valid }).repository.initialize()).resolves.toBeUndefined();
    expect(valid.documents('counters').find(counter => counter._id === 'invoice_job').value
      .equals(Long.fromInt(40))).toBe(true);
    expect(valid.documents('counters').find(counter => counter._id === 'invoice_outbox').value
      .equals(Long.fromString(String(Number.MAX_SAFE_INTEGER)))).toBe(true);

    for (const value of [
      undefined,
      0,
      Long.NEG_ONE,
      Long.fromString('9007199254740992'),
      Long.fromInt(1, true),
    ]) {
      const invalid = createMongoRepositoryHarness();
      invalid.seed('counters', [{
        _id: 'invoice_job',
        ...(value === undefined ? {} : { value }),
      }]);
      const repository = createRepository({ harness: invalid }).repository;
      await expect(repository.initialize()).rejects.toEqual(
        safeErrorExpectation('REPOSITORY_INITIALIZATION_FAILED', 'Invoice repository initialization failed'),
      );
      expect(invalid.trace.startedSessions).toBe(0);
    }
  });

  test('close rejects new work synchronously, drains registered work via allSettled, is cached, and never closes the shared client', async () => {
    const { harness, repository } = await initializeRepository();
    const gate = deferred();
    harness.gateNext('invoice_jobs', 'findOne', gate.promise);
    const inFlight = repository.getJob(1);
    const firstClose = repository.close();
    const secondClose = repository.close();
    expect(secondClose).toBe(firstClose);
    expect(() => repository.getJob(2)).toThrow(
      safeErrorExpectation('REPOSITORY_CLOSED', 'Invoice repository is closed'),
    );
    let closeSettled = false;
    firstClose.then(() => { closeSettled = true; });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    gate.resolve(null);
    await expect(inFlight).resolves.toBeNull();
    await expect(firstClose).resolves.toBeUndefined();
    expect(harness.trace.clientCloseCalls).toBe(0);
  });

  test('does not preserve arbitrary repository-shaped driver errors or leak raw details', async () => {
    const harness = createMongoRepositoryHarness();
    harness.throwNext('webhook_events', 'createIndex', new EinvoiceError(
      'REPOSITORY_DATA_INVALID',
      'private synthetic driver detail',
    ));
    const { repository } = createRepository({ harness });
    const error = await repository.initialize().catch(value => value);
    expect(error).toEqual(
      safeErrorExpectation('REPOSITORY_INITIALIZATION_FAILED', 'Invoice repository initialization failed'),
    );
    expect(`${error.message} ${error.stack}`).not.toMatch(/private synthetic driver detail/);
  });

  test('maps an unknown transaction commit result to the fixed terminal error without retrying', async () => {
    const { harness, repository } = await initializeRepository();
    harness.makeNextCommitUnknown();
    const beforeCallbacks = harness.trace.transactionCallbacks;
    const error = await repository.appendAuditEvents([]).catch(value => value);
    expect(error).toEqual(safeErrorExpectation(
      'REPOSITORY_TRANSACTION_UNKNOWN',
      'Invoice repository transaction result is unknown',
    ));
    expect(harness.trace.transactionCallbacks - beforeCallbacks).toBe(1);
  });

  test('normalizes a transaction callback timeout without leaking its raw detail', async () => {
    const { harness, repository } = await initializeRepository();
    const raw = new MongoOperationTimeoutError('synthetic private callback timeout');
    harness.throwNext('shipment_audit_events', 'findOne', raw);
    const beforeCallbacks = harness.trace.transactionCallbacks;

    const error = await repository.appendAuditEvents([entityAudit()]).catch(value => value);
    expect(error).toEqual(safeErrorExpectation(
      'REPOSITORY_UNAVAILABLE', 'Invoice repository is unavailable', true,
    ));
    expect(`${error.message} ${error.stack}`).not.toContain('synthetic private callback timeout');
    expect(harness.trace.transactionCallbacks - beforeCallbacks).toBe(1);
    expect(harness.documents('shipment_audit_events')).toEqual([]);
  });

  test('the harness identifies real Mongo unknown-commit labels rather than message text', () => {
    const error = new MongoServerError({ message: 'different text' });
    error.addErrorLabel('UnknownTransactionCommitResult');
    expect(error.hasErrorLabel('UnknownTransactionCommitResult')).toBe(true);
    expect(sameBson(Long.ONE, Long.fromInt(1))).toBe(true);
  });
});

describe('Mongo webhook acceptance and transactional counters', () => {
  test('atomically stores exact webhook/job bytes, supplied audit, canonical accepted branch, and BSON head', async () => {
    const { harness, repository } = await initializeRepository();
    const shipment = normalizedShipment({
      customer: { name: 'MUST NOT PERSIST' },
      bags: normalizedShipment().bags.map(bag => ({
        ...bag,
        privateAddress: 'MUST NOT PERSIST',
        financialBreakup: {
          ...bag.financialBreakup,
          unrelated_total: '999.00',
        },
      })),
    });
    const receipt = webhookReceiptAudit();

    await expect(repository.acceptWebhook(eventRecord(), shipment, false, [receipt]))
      .resolves.toEqual({ created: true, jobId: 1 });

    const jobs = harness.documents('invoice_jobs');
    const webhooks = harness.documents('webhook_events');
    const events = harness.documents('shipment_audit_events');
    const heads = harness.documents('shipment_audit_heads');
    expect(jobs).toHaveLength(1);
    expect(webhooks).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(heads).toHaveLength(1);

    const job = jobs[0];
    expect(Long.isLong(job.jobId)).toBe(true);
    expect(job.jobId.equals(Long.ONE)).toBe(true);
    expect(job).toEqual(expect.objectContaining({
      companyId: 'company-1',
      applicationId: 'application-1',
      shipmentId: 'shipment-1',
      documentType: 'IN',
      documentNumber: 'VR-shipment-1-1',
      state: JOB_STATES.RECEIVED,
      shipmentSnapshotJson: JSON.stringify(normalizedShipment()),
      oeisRequestJson: null,
      requestHash: null,
      attemptCount: 0,
      nextAttemptAt: new Date(RECEIVED_AT),
      dueAt: new Date(RECEIVED_AT),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      lockedAt: null,
      pendingOperation: null,
      version: 0,
      createdAt: new Date(RECEIVED_AT),
      updatedAt: new Date(RECEIVED_AT),
    }));
    expect(JSON.stringify(job)).not.toMatch(/MUST NOT PERSIST|unrelated_total/);

    expect(Long.isLong(webhooks[0].jobId)).toBe(true);
    expect(webhooks[0]).toEqual(expect.objectContaining({
      eventId: 'event-1',
      companyId: 'company-1',
      applicationId: 'application-1',
      shipmentId: 'shipment-1',
      eventType: 'application/shipment/update/v1',
      status: 'bag_confirmed',
      receivedAt: new Date(RECEIVED_AT),
      processedAt: new Date(RECEIVED_AT),
    }));

    const accepted = events.find(event => event.action === 'WEBHOOK_ACCEPTED');
    const storedReceipt = events.find(event => event.action === 'WEBHOOK_RECEIVED');
    expect(accepted).toEqual(expect.objectContaining({
      eventKey: 'v1.pYKVDufNDoVw_FciSDp2b47c926vIxIPuB5nySCBaks',
      operationKey: null,
      companyId: 'company-1',
      applicationId: 'application-1',
      shipmentId: 'shipment-1',
      jobId: Long.ONE,
      documentNumber: 'VR-shipment-1-1',
      stage: 'WEBHOOK',
      action: 'WEBHOOK_ACCEPTED',
      outcome: 'SUCCESS',
      attemptNumber: 0,
      occurredAt: new Date(FIXED_NOW),
      expiresAt: new Date(FIXED_NOW.getTime() + AUDIT_RETENTION_MS),
    }));
    expect(storedReceipt.eventKey).toBe(receipt.eventKey);
    expect(storedReceipt.occurredAt).toEqual(new Date(receipt.occurredAt));
    expect(Long.isLong(accepted.jobId)).toBe(true);
    expect(storedReceipt.jobId).toBeNull();

    expect(heads[0]).toEqual(expect.objectContaining({
      companyId: 'company-1',
      shipmentId: 'shipment-1',
      jobId: Long.ONE,
      documentNumber: 'VR-shipment-1-1',
      lastStage: 'WEBHOOK',
      lastAction: 'WEBHOOK_ACCEPTED',
      lastOutcome: 'SUCCESS',
      firstOccurredAt: new Date(receipt.occurredAt),
      lastOccurredAt: new Date(FIXED_NOW),
      lastEventKey: accepted.eventKey,
      expiresAt: new Date(FIXED_NOW.getTime() + AUDIT_RETENTION_MS),
      version: 1,
    }));

    const counterMutation = harness.trace.operations.find(operation => (
      operation.collection === 'counters' && operation.method === 'findOneAndUpdate'
    ));
    expect(counterMutation).toEqual(expect.objectContaining({
      filter: {
        _id: 'invoice_job',
        value: { $lt: Long.fromString('9007199254740991') },
      },
      update: { $inc: { value: Long.ONE } },
      options: expect.objectContaining({ returnDocument: 'after', session: true }),
    }));
    for (const operation of harness.trace.operations.filter(candidate => (
      ['invoice_jobs', 'webhook_events', 'shipment_audit_events', 'shipment_audit_heads']
        .includes(candidate.collection)
      && ['insertOne', 'insertMany', 'updateOne', 'findOneAndUpdate'].includes(candidate.method)
    )).slice(-5)) {
      expect(operation.session).not.toBe(false);
      expect(operation.options?.session).not.toBe(false);
    }

    const publicJob = await repository.getJob(1);
    expect(publicJob).toEqual(expect.objectContaining({
      id: 1,
      companyId: 'company-1',
      shipmentSnapshot: normalizedShipment(),
      createdAt: RECEIVED_AT,
      nextAttemptAt: RECEIVED_AT,
    }));
    expect(Object.isFrozen(publicJob)).toBe(true);
    expect(Object.isFrozen(publicJob.shipmentSnapshot)).toBe(true);
  });

  test('same-event and same-shipment replays keep first dry/live intent and append one idempotent duplicate branch per event', async () => {
    const { harness, repository, clock } = await initializeRepository();
    const first = await repository.acceptWebhook(eventRecord(), normalizedShipment(), true);
    clock.set(new Date('2026-08-17T10:01:00.000Z'));
    const sameEvent = await repository.acceptWebhook(
      eventRecord({ receivedAt: '2026-08-17T10:00:30.000Z' }),
      normalizedShipment(),
      false,
    );
    clock.set(new Date('2026-08-17T10:02:00.000Z'));
    const sameShipment = await repository.acceptWebhook(
      eventRecord({ eventId: 'event-2' }),
      normalizedShipment(),
      false,
    );
    clock.set(new Date('2026-08-17T10:03:00.000Z'));
    const repeatedDuplicate = await repository.acceptWebhook(
      eventRecord({ eventId: 'event-2' }),
      normalizedShipment(),
      false,
    );

    expect(first).toEqual({ created: true, jobId: 1 });
    expect(sameEvent).toEqual({ created: false, jobId: 1 });
    expect(sameShipment).toEqual({ created: false, jobId: 1 });
    expect(repeatedDuplicate).toEqual({ created: false, jobId: 1 });
    expect(harness.documents('invoice_jobs')).toHaveLength(1);
    expect(harness.documents('webhook_events')).toHaveLength(2);
    expect(harness.documents('invoice_jobs')[0].state).toBe(JOB_STATES.DRY_RUN_RECEIVED);
    expect(harness.documents('shipment_audit_events').filter(
      event => event.action === 'WEBHOOK_DUPLICATE',
    )).toHaveLength(2);
    expect(harness.documents('shipment_audit_events')).toHaveLength(3);
    const eventOneDuplicate = harness.documents('shipment_audit_events').find(event => (
      event.eventKey === 'v1.IcgEOREebwMY5Y02F5VRAcQHMTVSXlIaasVZIjfcJlc'
    ));
    expect(eventOneDuplicate).toEqual(expect.objectContaining({
      action: 'WEBHOOK_DUPLICATE',
      jobId: Long.ONE,
      occurredAt: new Date('2026-08-17T10:01:00.000Z'),
    }));
    expect(harness.documents('shipment_audit_heads')[0]).toEqual(expect.objectContaining({
      lastAction: 'WEBHOOK_DUPLICATE',
      lastOccurredAt: new Date('2026-08-17T10:02:00.000Z'),
      version: 2,
    }));

    clock.set(new Date('2026-08-17T10:04:00.000Z'));
    const live = await repository.acceptWebhook(
      eventRecord({ eventId: 'event-live', shipmentId: 'shipment-live' }),
      normalizedShipment({ shipmentId: 'shipment-live' }),
      false,
    );
    clock.set(new Date('2026-08-17T10:05:00.000Z'));
    await repository.acceptWebhook(
      eventRecord({ eventId: 'event-live-2', shipmentId: 'shipment-live' }),
      normalizedShipment({ shipmentId: 'shipment-live' }),
      true,
    );
    expect(findLongDocument(harness.documents('invoice_jobs'), 'jobId', live.jobId).state)
      .toBe(JOB_STATES.RECEIVED);
  });

  test.each([
    ['shipment identity', { shipmentId: 'shipment-2' }, normalizedShipment({ shipmentId: 'shipment-2' })],
    ['status', { status: 'bag_cancelled' }, normalizedShipment()],
    ['application identity', { applicationId: 'application-2' }, normalizedShipment()],
    ['event type', { eventType: 'application/shipment/other/v1' }, normalizedShipment()],
    ['snapshot bytes', {}, normalizedShipment({ amountPaid: '116.00' })],
  ])('commits validation + rejection audit before throwing same-event %s conflict', async (
    _label,
    eventOverrides,
    shipment,
  ) => {
    const { harness, repository, clock } = await initializeRepository();
    await repository.acceptWebhook(
      eventRecord(), normalizedShipment(), false, [webhookValidationAudit()],
    );
    clock.set(new Date('2026-08-17T10:01:00.000Z'));
    const conflictEvent = eventRecord(eventOverrides);
    const validation = webhookValidationAudit({ event: conflictEvent });
    const before = Object.fromEntries([
      'counters', 'invoice_jobs', 'webhook_events',
    ].map(name => [name, harness.documents(name)]));
    const beforeCommits = harness.trace.commits;

    await expect(repository.acceptWebhook(
      conflictEvent, shipment, false, [validation],
    )).rejects.toEqual(
      safeErrorExpectation('IDEMPOTENCY_CONFLICT', 'Webhook event identity conflicts with an existing event'),
    );
    for (const [name, documents] of Object.entries(before)) {
      expect(harness.documents(name)).toEqual(documents);
    }
    expect(harness.trace.commits).toBe(beforeCommits + 1);
    const storedValidation = harness.documents('shipment_audit_events').filter(
      event => event.eventKey === validation.eventKey,
    );
    const rejected = harness.documents('shipment_audit_events').filter(
      event => event.action === 'WEBHOOK_REJECTED',
    );
    expect(storedValidation).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toEqual(expect.objectContaining({
      companyId: conflictEvent.companyId,
      applicationId: conflictEvent.applicationId,
      shipmentId: conflictEvent.shipmentId,
      stage: 'WEBHOOK',
      action: 'WEBHOOK_REJECTED',
      outcome: 'FAILURE',
      safeCode: 'IDEMPOTENCY_CONFLICT',
      operationKey: null,
      attemptNumber: 0,
    }));
    expect(harness.documents('shipment_audit_heads').find(
      head => head.shipmentId === conflictEvent.shipmentId,
    )).toEqual(expect.objectContaining({
      lastAction: 'WEBHOOK_REJECTED',
      lastOutcome: 'FAILURE',
      lastSafeCode: 'IDEMPOTENCY_CONFLICT',
    }));
  });

  test('commits one rejection for same-shipment application/snapshot drift without job/webhook/counter mutation', async () => {
    const { harness, repository } = await initializeRepository();
    await repository.acceptWebhook(eventRecord(), normalizedShipment());
    for (const [event, shipment] of [
      [eventRecord({ eventId: 'event-2', applicationId: 'application-2' }), normalizedShipment()],
      [eventRecord({ eventId: 'event-3' }), normalizedShipment({ amountPaid: '116.00' })],
    ]) {
      await expect(repository.acceptWebhook(
        event, shipment, false, [webhookValidationAudit({ event })],
      )).rejects.toEqual(
        safeErrorExpectation('IDEMPOTENCY_CONFLICT', 'Webhook shipment data conflicts with an existing invoice job'),
      );
    }
    expect(harness.documents('counters').find(counter => counter._id === 'invoice_job').value.equals(Long.ONE))
      .toBe(true);
    expect(harness.documents('webhook_events')).toHaveLength(1);
    expect(harness.documents('invoice_jobs')).toHaveLength(1);
    expect(harness.documents('shipment_audit_events').filter(
      event => event.action === 'WEBHOOK_REJECTED',
    )).toHaveLength(2);
  });

  test('commits webhook conflict audit with a real nonzero semantic-validation lifecycle', async () => {
    const { harness, repository } = await initializeRepository();
    await repository.acceptWebhook(eventRecord(), normalizedShipment());
    const conflictEvent = eventRecord({ eventId: 'event-2', applicationId: 'application-2' });
    const validation = webhookValidationAudit({
      event: conflictEvent,
      startedAt: '2026-08-17T09:59:00.000Z',
      completedAt: '2026-08-17T09:59:30.000Z',
    });

    await expect(repository.acceptWebhook(
      conflictEvent,
      normalizedShipment(),
      false,
      [validation],
    )).rejects.toEqual(safeErrorExpectation(
      'IDEMPOTENCY_CONFLICT', 'Webhook shipment data conflicts with an existing invoice job',
    ));
    expect(harness.documents('shipment_audit_events')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventKey: validation.eventKey,
        action: 'VALIDATION_PASSED',
        durationMs: 30_000,
      }),
      expect.objectContaining({ action: 'WEBHOOK_REJECTED', safeCode: 'IDEMPOTENCY_CONFLICT' }),
    ]));
  });

  test('commits a same-clock conflict when hash order places validation after rejection', async () => {
    const { harness, repository } = await initializeRepository();
    await repository.acceptWebhook(eventRecord(), normalizedShipment());
    const conflictEvent = eventRecord({
      eventId: 'same-clock-2',
      applicationId: 'application-2',
    });
    const validation = webhookValidationAudit({
      event: conflictEvent,
      occurredAt: FIXED_NOW.toISOString(),
      startedAt: '2026-08-17T09:59:30.000Z',
      completedAt: FIXED_NOW.toISOString(),
    });
    const rejectionKey = createEventKey({
      kind: 'ENTITY',
      companyId: conflictEvent.companyId,
      shipmentId: conflictEvent.shipmentId,
      scopeKind: 'WEBHOOK',
      scopeId: conflictEvent.eventId,
      parentVersion: 0,
      attemptNumber: 0,
      stage: 'WEBHOOK',
      action: 'WEBHOOK_REJECTED',
      outcome: 'FAILURE',
    });
    expect(rejectionKey < validation.eventKey).toBe(true);

    await expect(repository.acceptWebhook(
      conflictEvent,
      normalizedShipment(),
      false,
      [validation],
    )).rejects.toEqual(safeErrorExpectation(
      'IDEMPOTENCY_CONFLICT', 'Webhook shipment data conflicts with an existing invoice job',
    ));
    expect(harness.documents('shipment_audit_events')).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventKey: validation.eventKey, action: 'VALIDATION_PASSED' }),
      expect.objectContaining({ eventKey: rejectionKey, action: 'WEBHOOK_REJECTED' }),
    ]));
  });

  test('commits document-number conflict audit without leaking conflicting identity or snapshots', async () => {
    const { harness, repository } = await initializeRepository();
    const accepted = await repository.acceptWebhook(eventRecord(), normalizedShipment());
    replaceJob(harness, accepted.jobId, { documentNumber: 'VR-shipment-2-1' });
    const conflictEvent = eventRecord({ eventId: 'event-2', shipmentId: 'shipment-2' });
    const privateSnapshot = normalizedShipment({
      shipmentId: 'shipment-2',
      amountPaid: '987654321.00',
    });
    const before = Object.fromEntries([
      'counters', 'invoice_jobs', 'webhook_events',
    ].map(name => [name, harness.documents(name)]));

    const error = await repository.acceptWebhook(
      conflictEvent,
      privateSnapshot,
      false,
      [webhookValidationAudit({ event: conflictEvent })],
    ).catch(value => value);

    expect(error).toEqual(safeErrorExpectation(
      'IDEMPOTENCY_CONFLICT',
      'Webhook shipment data conflicts with an existing invoice job',
    ));
    for (const [name, documents] of Object.entries(before)) {
      expect(harness.documents(name)).toEqual(documents);
    }
    const serialized = JSON.stringify({
      error: { message: error.message, stack: error.stack },
      events: harness.documents('shipment_audit_events'),
      heads: harness.documents('shipment_audit_heads'),
    });
    expect(serialized).not.toContain('987654321.00');
    expect(serialized).not.toContain('private');
    expect(harness.documents('shipment_audit_events').filter(
      event => event.action === 'WEBHOOK_REJECTED',
    )).toHaveLength(1);
  });

  test('classifies corrupt stored job identity as repository data before conflict audit construction', async () => {
    const { harness, repository } = await initializeRepository();
    const accepted = await repository.acceptWebhook(eventRecord(), normalizedShipment());
    replaceJob(harness, accepted.jobId, { documentNumber: 'VR-private\u0000driver-text' });
    const conflictEvent = eventRecord({ eventId: 'event-2', applicationId: 'application-2' });
    const before = Object.fromEntries([
      'counters', 'invoice_jobs', 'webhook_events',
      'shipment_audit_events', 'shipment_audit_heads',
    ].map(name => [name, harness.documents(name)]));

    await expect(repository.acceptWebhook(
      conflictEvent,
      normalizedShipment(),
      false,
      [webhookValidationAudit({ event: conflictEvent })],
    )).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    for (const [name, documents] of Object.entries(before)) {
      expect(harness.documents(name)).toEqual(documents);
    }
  });

  test('rejects a stored webhook foreign key that points at an unrelated job before conflict audit', async () => {
    const { harness, repository } = await initializeRepository();
    await repository.acceptWebhook(eventRecord(), normalizedShipment());
    const unrelated = await repository.acceptWebhook(eventRecord({
      eventId: 'event-foreign',
      companyId: 'company-foreign',
      applicationId: 'application-foreign',
      shipmentId: 'shipment-foreign',
    }), normalizedShipment({ shipmentId: 'shipment-foreign' }));
    harness.replaceDocuments('webhook_events', harness.documents('webhook_events').map(event => (
      event.eventId === 'event-1'
        ? { ...event, jobId: Long.fromNumber(unrelated.jobId) }
        : event
    )));
    const conflictEvent = eventRecord({ applicationId: 'application-2' });
    const before = Object.fromEntries([
      'counters', 'invoice_jobs', 'webhook_events',
      'shipment_audit_events', 'shipment_audit_heads',
    ].map(name => [name, harness.documents(name)]));

    await expect(repository.acceptWebhook(
      conflictEvent,
      normalizedShipment(),
      false,
      [webhookValidationAudit({ event: conflictEvent })],
    )).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    for (const [name, documents] of Object.entries(before)) {
      expect(harness.documents(name)).toEqual(documents);
    }
  });

  test('callback and later platform replay keep the rejection first clock and one audit row', async () => {
    const { harness, repository, clock } = await initializeRepository();
    await repository.acceptWebhook(eventRecord(), normalizedShipment());
    const conflictEvent = eventRecord({ applicationId: 'application-2' });
    const validation = webhookValidationAudit({ event: conflictEvent });
    harness.replayNextTransaction(1);
    await expect(repository.acceptWebhook(
      conflictEvent, normalizedShipment(), false, [validation],
    )).rejects.toEqual(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    const first = harness.documents('shipment_audit_events').find(
      event => event.action === 'WEBHOOK_REJECTED',
    );
    expect(first.occurredAt).toEqual(new Date(FIXED_NOW));

    clock.set(new Date('2026-08-17T10:05:00.000Z'));
    await expect(repository.acceptWebhook(
      conflictEvent, normalizedShipment(), false, [validation],
    )).rejects.toEqual(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    const rejected = harness.documents('shipment_audit_events').filter(
      event => event.action === 'WEBHOOK_REJECTED',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].occurredAt).toEqual(new Date(FIXED_NOW));
  });

  test.each([
    ['empty bundle', event => []],
    ['wrong action', event => [webhookValidationAudit({
      event, action: 'VALIDATION_STARTED', outcome: 'STARTED',
    })]],
    ['extra event', event => [
      webhookValidationAudit({ event }),
      webhookValidationAudit({
        event,
        action: 'VALIDATION_STARTED',
        outcome: 'STARTED',
        occurredAt: '2026-08-17T09:59:29.000Z',
      }),
    ]],
    ['completion after occurrence', event => {
      const validation = webhookValidationAudit({ event });
      return [{
        ...validation,
        completedAt: '2026-08-17T09:59:31.000Z',
        durationMs: 1_000,
      }];
    }],
  ])('rejects a webhook conflict %s instead of committing incomplete audit', async (
    _label,
    buildEvents,
  ) => {
    const { harness, repository } = await initializeRepository();
    await repository.acceptWebhook(eventRecord(), normalizedShipment());
    const conflictEvent = eventRecord({ eventId: 'event-2', applicationId: 'application-2' });
    const before = Object.fromEntries([
      'counters', 'invoice_jobs', 'webhook_events',
      'shipment_audit_events', 'shipment_audit_heads',
    ].map(name => [name, harness.documents(name)]));

    await expect(repository.acceptWebhook(
      conflictEvent,
      normalizedShipment(),
      false,
      buildEvents(conflictEvent),
    )).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    for (const [name, documents] of Object.entries(before)) {
      expect(harness.documents(name)).toEqual(documents);
    }
  });

  test('rejects future-dated validation that would outrank webhook rejection head', async () => {
    const { harness, repository } = await initializeRepository();
    await repository.acceptWebhook(eventRecord(), normalizedShipment());
    const conflictEvent = eventRecord({ eventId: 'event-2', applicationId: 'application-2' });
    const before = Object.fromEntries([
      'counters', 'invoice_jobs', 'webhook_events',
      'shipment_audit_events', 'shipment_audit_heads',
    ].map(name => [name, harness.documents(name)]));

    await expect(repository.acceptWebhook(
      conflictEvent,
      normalizedShipment(),
      false,
      [webhookValidationAudit({
        event: conflictEvent,
        occurredAt: '2026-08-17T10:01:00.000Z',
      })],
    )).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    for (const [name, documents] of Object.entries(before)) {
      expect(harness.documents(name)).toEqual(documents);
    }
  });

  test.each(['audit', 'head', 'unknown'])('%s failure never guesses an idempotency conflict commit', async failure => {
    const { harness, repository } = await initializeRepository();
    await repository.acceptWebhook(eventRecord(), normalizedShipment());
    const conflictEvent = eventRecord({ applicationId: 'application-2' });
    const before = Object.fromEntries([
      'counters', 'invoice_jobs', 'webhook_events',
      'shipment_audit_events', 'shipment_audit_heads',
    ].map(name => [name, harness.documents(name)]));
    if (failure === 'audit') {
      harness.returnNext('shipment_audit_events', 'insertOne', {
        acknowledged: false,
        insertedId: null,
      });
    } else if (failure === 'head') {
      harness.returnNext('shipment_audit_heads', 'updateOne', {
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 0,
        upsertedId: null,
      });
    } else {
      harness.makeNextCommitUnknown();
    }

    await expect(repository.acceptWebhook(
      conflictEvent,
      normalizedShipment(),
      false,
      [webhookValidationAudit({ event: conflictEvent })],
    )).rejects.toEqual(expect.objectContaining({
      code: failure === 'unknown'
        ? 'REPOSITORY_TRANSACTION_UNKNOWN'
        : 'REPOSITORY_DATA_INVALID',
    }));
    if (failure !== 'unknown') {
      for (const [name, documents] of Object.entries(before)) {
        expect(harness.documents(name)).toEqual(documents);
      }
    }
  });

  test.each([null, 'true', 1, {}, []])('rejects invalid dry-run intent %p before clock or transaction work', async dryRunEnabled => {
    const { harness, repository, clock } = await initializeRepository();
    const beforeCallbacks = harness.trace.transactionCallbacks;
    await expect(repository.acceptWebhook(
      eventRecord(), normalizedShipment(), dryRunEnabled,
    )).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(clock.calls()).toBe(0);
    expect(harness.trace.transactionCallbacks).toBe(beforeCallbacks);
  });

  test('replayed transaction callbacks and concurrent acceptances commit distinct IDs exactly once', async () => {
    const { harness, repository } = await initializeRepository();
    harness.replayNextTransaction(1);
    const beforeCallbacks = harness.trace.transactionCallbacks;
    const replayed = await repository.acceptWebhook(eventRecord(), normalizedShipment());
    expect(replayed).toEqual({ created: true, jobId: 1 });
    expect(harness.trace.transactionCallbacks - beforeCallbacks).toBe(2);
    expect(harness.documents('invoice_jobs')).toHaveLength(1);
    expect(harness.documents('webhook_events')).toHaveLength(1);

    const results = await Promise.all([
      repository.acceptWebhook(
        eventRecord({ eventId: 'event-a', shipmentId: 'shipment-a' }),
        normalizedShipment({ shipmentId: 'shipment-a' }),
      ),
      repository.acceptWebhook(
        eventRecord({ eventId: 'event-b', shipmentId: 'shipment-b' }),
        normalizedShipment({ shipmentId: 'shipment-b' }),
      ),
    ]);
    expect(results.map(result => result.jobId).sort((left, right) => left - right)).toEqual([2, 3]);
    expect(new Set(harness.documents('invoice_jobs').map(job => job.jobId.toString())).size).toBe(3);
    expect(harness.documents('counters').find(counter => counter._id === 'invoice_job').value
      .equals(Long.fromInt(3))).toBe(true);
  });

  test('a duplicate-key abort uses a fresh session and does not consume a committed counter value', async () => {
    const { harness, repository } = await initializeRepository();
    const duplicate = new MongoServerError({ message: 'raw duplicate race', code: 11000 });
    duplicate.code = 11000;
    harness.throwNext('webhook_events', 'insertOne', duplicate);
    const beforeSessions = harness.trace.startedSessions;

    await expect(repository.acceptWebhook(eventRecord(), normalizedShipment()))
      .resolves.toEqual({ created: true, jobId: 1 });
    expect(harness.trace.startedSessions - beforeSessions).toBe(2);
    expect(harness.documents('invoice_jobs')).toHaveLength(1);
    expect(harness.documents('webhook_events')).toHaveLength(1);
    expect(harness.documents('counters').find(counter => counter._id === 'invoice_job').value
      .equals(Long.ONE)).toBe(true);
  });

  test('counter failures roll back job/webhook/audit writes and the next acceptance reuses the uncommitted ID', async () => {
    const { harness, repository } = await initializeRepository();
    harness.returnNext('invoice_jobs', 'insertOne', {
      acknowledged: false,
      insertedId: Long.ONE,
    });
    await expect(repository.acceptWebhook(eventRecord(), normalizedShipment())).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
    expect(harness.documents('invoice_jobs')).toEqual([]);
    expect(harness.documents('webhook_events')).toEqual([]);
    expect(harness.documents('shipment_audit_events')).toEqual([]);
    expect(harness.documents('counters').find(counter => counter._id === 'invoice_job').value
      .equals(Long.ZERO)).toBe(true);

    await expect(repository.acceptWebhook(eventRecord(), normalizedShipment()))
      .resolves.toEqual({ created: true, jobId: 1 });
  });

  test('seeds from an imported maximum, allocates MAX_SAFE_INTEGER once, then fails atomically at exhaustion', async () => {
    const imported = createMongoRepositoryHarness();
    imported.seed('counters', [{ _id: 'invoice_job', value: Long.fromInt(40) }]);
    const importedRepository = createRepository({ harness: imported }).repository;
    await importedRepository.initialize();
    await expect(importedRepository.acceptWebhook(eventRecord(), normalizedShipment()))
      .resolves.toEqual({ created: true, jobId: 41 });

    const maximum = createMongoRepositoryHarness();
    maximum.seed('counters', [{
      _id: 'invoice_job',
      value: Long.fromString('9007199254740990'),
    }]);
    const maximumRepository = createRepository({ harness: maximum }).repository;
    await maximumRepository.initialize();
    await expect(maximumRepository.acceptWebhook(eventRecord(), normalizedShipment()))
      .resolves.toEqual({ created: true, jobId: Number.MAX_SAFE_INTEGER });
    const before = maximum.documents('invoice_jobs');
    await expect(maximumRepository.acceptWebhook(
      eventRecord({ eventId: 'event-2', shipmentId: 'shipment-2' }),
      normalizedShipment({ shipmentId: 'shipment-2' }),
    )).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_ID_EXHAUSTED', 'Invoice repository identifier space is exhausted',
    ));
    expect(maximum.documents('invoice_jobs')).toEqual(before);
    expect(maximum.documents('counters').find(counter => counter._id === 'invoice_job').value
      .equals(Long.fromString('9007199254740991'))).toBe(true);
  });

  test.each([
    ['missing', []],
    ['number', [{ _id: 'invoice_job', value: 7 }]],
    ['negative Long', [{ _id: 'invoice_job', value: Long.NEG_ONE }]],
    ['unsafe Long', [{ _id: 'invoice_job', value: Long.fromString('9007199254740992') }]],
  ])('rejects a %s counter as corrupt before any insert', async (_label, replacement) => {
    const harness = createMongoRepositoryHarness();
    const repository = createRepository({ harness }).repository;
    await repository.initialize();
    const other = harness.documents('counters').filter(counter => counter._id !== 'invoice_job');
    harness.replaceDocuments('counters', [...other, ...replacement]);

    await expect(repository.acceptWebhook(eventRecord(), normalizedShipment())).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
    expect(harness.documents('invoice_jobs')).toEqual([]);
  });

  test('decodes the transaction result before commit and maps malformed counter output to safe data corruption', async () => {
    const { harness, repository } = await initializeRepository();
    harness.returnNext('counters', 'findOneAndUpdate', {
      _id: 'invoice_job',
      value: Number.MAX_SAFE_INTEGER,
    });
    const beforeCommits = harness.trace.commits;
    await expect(repository.acceptWebhook(eventRecord(), normalizedShipment())).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
    expect(harness.trace.commits).toBe(beforeCommits);
    expect(harness.documents('invoice_jobs')).toEqual([]);
  });

  test('unknown commit is terminal, not retried, even though the harness exposes the committed write', async () => {
    const { harness, repository } = await initializeRepository();
    harness.makeNextCommitUnknown();
    const beforeCallbacks = harness.trace.transactionCallbacks;
    await expect(repository.acceptWebhook(eventRecord(), normalizedShipment())).rejects.toEqual(
      safeErrorExpectation(
        'REPOSITORY_TRANSACTION_UNKNOWN',
        'Invoice repository transaction result is unknown',
      ),
    );
    expect(harness.trace.transactionCallbacks - beforeCallbacks).toBe(1);
    expect(harness.documents('invoice_jobs')).toHaveLength(1);
    expect(harness.documents('webhook_events')).toHaveLength(1);
  });
});

describe('Mongo tenant-scoped job and dry-run reads', () => {
  test('lists only held dry runs newest-first with exclusive numeric pagination and frozen summaries', async () => {
    const { harness, repository } = await initializeRepository();
    const first = await makeHeldJob(harness, repository, 'held-first');
    const second = await makeHeldJob(harness, repository, 'held-second');
    await makeHeldJob(harness, repository, 'held-foreign', { companyId: 'company-2' });
    await acceptFor(harness, repository, 'live');
    const failed = await acceptFor(harness, repository, 'failed');
    replaceJob(harness, failed.accepted.jobId, { state: JOB_STATES.DATA_FAILED });

    const firstPage = await repository.listDryRunJobsForCompany({
      companyId: 'company-1', limit: 1, beforeId: null,
    });
    expect(firstPage).toEqual({
      items: [{
        jobId: second.accepted.jobId,
        shipmentId: second.shipmentId,
        documentNumber: `VR-${second.shipmentId}-1`,
        state: JOB_STATES.SUBMISSION_HELD,
        lockedAt: FIXED_NOW.toISOString(),
        createdAt: RECEIVED_AT,
        updatedAt: FIXED_NOW.toISOString(),
        version: 4,
      }],
      nextBeforeId: second.accepted.jobId,
    });
    expect(Object.isFrozen(firstPage)).toBe(true);
    expect(Object.isFrozen(firstPage.items)).toBe(true);
    expect(Object.isFrozen(firstPage.items[0])).toBe(true);
    await expect(repository.listDryRunJobsForCompany({
      companyId: 'company-1', limit: 20, beforeId: firstPage.nextBeforeId,
    })).resolves.toEqual({
      items: [expect.objectContaining({
        jobId: first.accepted.jobId,
        shipmentId: first.shipmentId,
      })],
      nextBeforeId: null,
    });

    const listOperations = harness.trace.operations.filter(operation => (
      operation.collection === 'invoice_jobs' && operation.method === 'find'
    ));
    expect(listOperations.at(-1).filter).toEqual({
      companyId: 'company-1',
      state: JOB_STATES.SUBMISSION_HELD,
      jobId: { $lt: Long.fromNumber(second.accepted.jobId) },
    });
  });

  test('returns a tenant/state-scoped held job and preserves exact prepared request bytes', async () => {
    const { harness, repository } = await initializeRepository();
    const held = await makeHeldJob(harness, repository, 'detail');
    const foreign = await makeHeldJob(harness, repository, 'foreign', { companyId: 'company-2' });
    const live = await acceptFor(harness, repository, 'live-detail');

    const job = await repository.getDryRunJobForCompany({
      companyId: 'company-1', jobId: held.accepted.jobId,
    });
    expect(job).toEqual(expect.objectContaining({
      id: held.accepted.jobId,
      companyId: 'company-1',
      state: JOB_STATES.SUBMISSION_HELD,
      shipmentSnapshot: normalizedShipment({ shipmentId: held.shipmentId }),
      oeisRequestJson: held.requestJson,
      oeisRequest: [{ TRAN_DOC_NO: `VR-${held.shipmentId}-1`, NOTE: 'رياض' }],
    }));
    expect(job).not.toHaveProperty('pendingOperation');
    expect(Object.isFrozen(job.oeisRequest)).toBe(true);

    await expect(repository.getDryRunRequestForCompany({
      companyId: 'company-1', jobId: held.accepted.jobId,
    })).resolves.toEqual({
      jobId: held.accepted.jobId,
      documentNumber: `VR-${held.shipmentId}-1`,
      requestJson: held.requestJson,
      requestHash: 'request-hash-detail',
    });

    for (const query of [
      { companyId: 'company-1', jobId: foreign.accepted.jobId },
      { companyId: 'company-2', jobId: held.accepted.jobId },
      { companyId: 'company-1', jobId: live.accepted.jobId },
      { companyId: 'company-1', jobId: 999_999 },
    ]) {
      await expect(repository.getDryRunJobForCompany(query)).resolves.toBeNull();
      await expect(repository.getDryRunRequestForCompany(query)).resolves.toBeNull();
    }
  });

  test('lists only terminal failures with summary privacy, tenant isolation, and exclusive pagination', async () => {
    const { harness, repository } = await initializeRepository();
    const dataFailed = await acceptFor(harness, repository, 'failure-data');
    const indeterminate = await acceptFor(harness, repository, 'failure-indeterminate');
    const foreign = await acceptFor(harness, repository, 'failure-foreign', { companyId: 'company-2' });
    const held = await makeHeldJob(harness, repository, 'failure-held');
    const privateMessage = 'SENTINEL PRIVATE STORED FAILURE MESSAGE';
    const privateSnapshot = '{"buyerNationalId":"1098765432"}';
    for (const [job, state, code] of [
      [dataFailed, JOB_STATES.DATA_FAILED, 'LOCAL_VALIDATION_FAILED'],
      [indeterminate, JOB_STATES.INDETERMINATE, 'OEIS_UNKNOWN_RESULT'],
      [foreign, JOB_STATES.DATA_FAILED, 'PRIVATE_FOREIGN_CODE'],
    ]) {
      replaceJob(harness, job.accepted.jobId, {
        state,
        attemptCount: 3,
        lastErrorCode: code,
        lastErrorMessage: privateMessage,
        shipmentSnapshotJson: privateSnapshot,
        lockedAt: new Date(FIXED_NOW),
        updatedAt: new Date(FIXED_NOW),
        pendingOperation: {
          operationKey: 'private-operation-must-not-project',
        },
        version: 7,
      });
    }

    const firstPage = await repository.listFailedJobsForCompany({
      companyId: 'company-1', limit: 1, beforeId: null,
    });
    expect(firstPage).toEqual({
      items: [{
        jobId: indeterminate.accepted.jobId,
        shipmentId: indeterminate.shipmentId,
        documentNumber: `VR-${indeterminate.shipmentId}-1`,
        state: JOB_STATES.INDETERMINATE,
        attemptCount: 3,
        lastErrorCode: 'OEIS_UNKNOWN_RESULT',
        lockedAt: FIXED_NOW.toISOString(),
        createdAt: RECEIVED_AT,
        updatedAt: FIXED_NOW.toISOString(),
        version: 7,
      }],
      nextBeforeId: indeterminate.accepted.jobId,
    });
    expect(Object.isFrozen(firstPage)).toBe(true);
    expect(Object.isFrozen(firstPage.items)).toBe(true);
    expect(JSON.stringify(firstPage)).not.toMatch(
      /SENTINEL|1098765432|pendingOperation|operationKey|lastErrorMessage|shipmentSnapshot|requestHash|artifact|outbox/i,
    );

    await expect(repository.listFailedJobsForCompany({
      companyId: 'company-1', limit: 20, beforeId: firstPage.nextBeforeId,
    })).resolves.toEqual({
      items: [expect.objectContaining({ jobId: dataFailed.accepted.jobId })],
      nextBeforeId: null,
    });
    await expect(repository.listFailedJobsForCompany({
      companyId: 'company-2', limit: 20, beforeId: null,
    })).resolves.toEqual({
      items: [expect.objectContaining({ jobId: foreign.accepted.jobId })],
      nextBeforeId: null,
    });
    expect(firstPage.items.map(item => item.jobId)).not.toContain(held.accepted.jobId);
  });

  test.each([
    ['missing list query', 'listDryRunJobsForCompany', undefined],
    ['blank company', 'listDryRunJobsForCompany', { companyId: ' ', limit: 20, beforeId: null }],
    ['zero limit', 'listDryRunJobsForCompany', { companyId: 'company-1', limit: 0, beforeId: null }],
    ['excessive limit', 'listFailedJobsForCompany', { companyId: 'company-1', limit: 101, beforeId: null }],
    ['zero cursor', 'listFailedJobsForCompany', { companyId: 'company-1', limit: 20, beforeId: 0 }],
    ['string job ID', 'getDryRunJobForCompany', { companyId: 'company-1', jobId: '1' }],
    ['unsafe job ID', 'getDryRunRequestForCompany', {
      companyId: 'company-1', jobId: Number.MAX_SAFE_INTEGER + 1,
    }],
  ])('rejects %s before reaching Mongo', async (_label, method, query) => {
    const { harness, repository } = await initializeRepository();
    const before = harness.trace.operations.length;
    await expect(repository[method](query)).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository read input is invalid',
    ));
    expect(harness.trace.operations).toHaveLength(before);
  });

  test('rejects inherited, accessor, and transparent Proxy read queries without executing caller code', async () => {
    const { harness, repository } = await initializeRepository();
    let getterCalls = 0;
    const accessor = { limit: 20, beforeId: null };
    Object.defineProperty(accessor, 'companyId', {
      enumerable: true,
      get() { getterCalls += 1; throw new Error('private query getter'); },
    });
    const inherited = Object.assign(Object.create({ companyId: 'company-1' }), {
      limit: 20, beforeId: null,
    });
    const traps = { get: 0, getPrototypeOf: 0, getOwnPropertyDescriptor: 0 };
    const proxy = new Proxy({ companyId: 'company-1', limit: 20, beforeId: null }, {
      get() { traps.get += 1; return undefined; },
      getPrototypeOf(target) { traps.getPrototypeOf += 1; return Reflect.getPrototypeOf(target); },
      getOwnPropertyDescriptor(target, property) {
        traps.getOwnPropertyDescriptor += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
    });
    const before = harness.trace.operations.length;
    for (const query of [accessor, inherited, proxy]) {
      await expect(repository.listFailedJobsForCompany(query)).rejects.toEqual(
        safeErrorExpectation('REPOSITORY_INPUT_INVALID', 'Invoice repository read input is invalid'),
      );
    }
    expect(getterCalls).toBe(0);
    expect(traps).toEqual({ get: 0, getPrototypeOf: 0, getOwnPropertyDescriptor: 0 });
    expect(harness.trace.operations).toHaveLength(before);
  });

  test('corrupt authoritative JSON or BSON fields fail closed with no raw stored value', async () => {
    const { harness, repository } = await initializeRepository();
    const accepted = await acceptFor(harness, repository, 'corrupt');
    replaceJob(harness, accepted.accepted.jobId, {
      shipmentSnapshotJson: '{"customer":"<private>",',
    });
    const error = await repository.getJob(accepted.accepted.jobId).catch(value => value);
    expect(error).toEqual(safeErrorExpectation(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    expect(`${error.message} ${error.stack}`).not.toMatch(/<private>|customer/);

    replaceJob(harness, accepted.accepted.jobId, {
      shipmentSnapshotJson: JSON.stringify(normalizedShipment({ shipmentId: accepted.shipmentId })),
      createdAt: 'not a BSON Date',
    });
    await expect(repository.getJob(accepted.accepted.jobId)).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
  });

  test('rejects a stored job whose due time diverges from its authoritative schedule', async () => {
    const { harness, repository } = await initializeRepository();
    const accepted = await acceptFor(harness, repository, 'due-corrupt');
    replaceJob(harness, accepted.accepted.jobId, {
      dueAt: new Date('2026-08-17T10:00:01.000Z'),
    });

    await expect(repository.getJob(accepted.accepted.jobId)).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
  });

  test('normalizes raw driver read failures without preserving raw messages or repository-shaped errors', async () => {
    const { harness, repository } = await initializeRepository();
    for (const raw of [
      new Error('raw driver URI synthetic-private-value'),
      new EinvoiceError('REPOSITORY_DATA_INVALID', 'caller-controlled private detail'),
    ]) {
      harness.throwNext('invoice_jobs', 'findOne', raw);
      const error = await repository.getJob(1).catch(value => value);
      expect(error).toEqual(safeErrorExpectation(
        'REPOSITORY_UNAVAILABLE', 'Invoice repository is unavailable', true,
      ));
      expect(`${error.message} ${error.stack}`).not.toMatch(
        /raw driver URI|synthetic-private-value|caller-controlled private detail/,
      );
    }
  });
});

describe('Mongo audit append, heads, timelines, and cursors', () => {
  test('rejects standalone external lifecycle events instead of creating orphan intents', async () => {
    const { harness, repository } = await initializeRepository();
    const started = lockOperationAudit({ jobId: 999 });
    const outcome = lockOutcomeAudit(started, { jobId: 999 });
    const before = harness.trace.operations.length;

    for (const event of [started.event, outcome]) {
      await expect(repository.appendAuditEvents([event])).rejects.toEqual(
        safeErrorExpectation('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid'),
      );
    }
    expect(harness.trace.operations).toHaveLength(before);
    expect(harness.documents('shipment_audit_events')).toEqual([]);
  });

  test('rejects an external lifecycle event from the webhook common bundle', async () => {
    const { harness, repository, clock } = await initializeRepository();
    const started = lockOperationAudit({ jobId: 999 });
    const before = harness.trace.operations.length;

    await expect(repository.acceptWebhook(
      eventRecord(), normalizedShipment(), false, [started.event],
    )).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid'),
    );
    expect(clock.calls()).toBe(0);
    expect(harness.trace.operations).toHaveLength(before);
    expect(harness.documents('invoice_jobs')).toEqual([]);
    expect(harness.documents('shipment_audit_events')).toEqual([]);
  });

  test('appends events idempotently and maintains first/latest head tuples without regressing on late events', async () => {
    const { harness, repository } = await initializeRepository();
    const first = entityAudit({
      occurredAt: '2026-08-17T10:00:00.000Z',
      parentVersion: 1,
    });
    const later = entityAudit({
      stage: 'JOB',
      action: 'JOB_DATA_FAILED',
      outcome: 'FAILURE',
      safeCode: 'LOCAL_VALIDATION_FAILED',
      occurredAt: '2026-08-17T10:02:00.000Z',
      parentVersion: 2,
    });
    const late = entityAudit({
      stage: 'VALIDATION',
      action: 'VALIDATION_STARTED',
      outcome: 'STARTED',
      occurredAt: '2026-08-17T09:00:00.000Z',
      parentVersion: 0,
    });

    await expect(repository.appendAuditEvents([first])).resolves.toBeUndefined();
    await expect(repository.appendAuditEvents([later, late])).resolves.toBeUndefined();
    const beforeDuplicate = harness.documents('shipment_audit_heads')[0];
    await expect(repository.appendAuditEvents([later])).resolves.toBeUndefined();

    expect(harness.documents('shipment_audit_events')).toHaveLength(3);
    expect(harness.documents('shipment_audit_heads')).toHaveLength(1);
    expect(harness.documents('shipment_audit_heads')[0]).toEqual(expect.objectContaining({
      companyId: 'company-1',
      shipmentId: 'shipment-1',
      firstOccurredAt: new Date('2026-08-17T09:00:00.000Z'),
      lastOccurredAt: new Date('2026-08-17T10:02:00.000Z'),
      lastEventKey: later.eventKey,
      lastStage: 'JOB',
      lastAction: 'JOB_DATA_FAILED',
      lastOutcome: 'FAILURE',
      lastSafeCode: 'LOCAL_VALIDATION_FAILED',
      expiresAt: new Date(Date.parse(later.expiresAt)),
      version: 1,
    }));
    expect(harness.documents('shipment_audit_heads')[0]).toEqual(beforeDuplicate);

    const tieA = entityAudit({
      scopeId: '100', parentVersion: 3, occurredAt: '2026-08-17T10:03:00.000Z',
    });
    const tieB = entityAudit({
      scopeId: '101', parentVersion: 3, occurredAt: '2026-08-17T10:03:00.000Z',
    });
    const [lower, higher] = [tieA, tieB].sort((left, right) => (
      left.eventKey < right.eventKey ? -1 : 1
    ));
    await repository.appendAuditEvents([lower, higher]);
    expect(harness.documents('shipment_audit_heads')[0]).toEqual(expect.objectContaining({
      lastOccurredAt: new Date('2026-08-17T10:03:00.000Z'),
      lastEventKey: higher.eventKey,
      version: 3,
    }));
  });

  test('keeps a terminal pre-job failure as the head across a hostile full same-clock lifecycle', async () => {
    const { harness, repository } = await initializeRepository();
    const occurredAt = FIXED_NOW.toISOString();
    const event = eventRecord({
      eventId: 'same-clock-0',
      shipmentId: 'shipment-same-clock-0',
    });
    const receipt = webhookReceiptAudit({ event, occurredAt });
    const validationStarted = webhookValidationAudit({
      event, action: 'VALIDATION_STARTED', occurredAt,
    });
    const validationFailed = preJobFailureAudit({
      companyId: event.companyId,
      applicationId: event.applicationId,
      shipmentId: event.shipmentId,
      eventId: event.eventId,
      action: 'VALIDATION_FAILED',
      safeCode: 'WEBHOOK_VALIDATION_FAILED',
      occurredAt,
      startedAt: occurredAt,
      completedAt: occurredAt,
    });
    const webhookRejected = preJobFailureAudit({
      companyId: event.companyId,
      applicationId: event.applicationId,
      shipmentId: event.shipmentId,
      eventId: event.eventId,
      action: 'WEBHOOK_REJECTED',
      safeCode: 'WEBHOOK_VALIDATION_FAILED',
      occurredAt,
      startedAt: occurredAt,
      completedAt: occurredAt,
    });
    expect(receipt.eventKey > validationStarted.eventKey).toBe(true);
    expect(receipt.eventKey > validationFailed.eventKey).toBe(true);
    expect(receipt.eventKey > webhookRejected.eventKey).toBe(true);

    await repository.appendAuditEvents([receipt]);
    await repository.appendAuditEvents([validationStarted]);
    await repository.appendAuditEvents([validationFailed, webhookRejected]);

    expect(harness.documents('shipment_audit_events')).toHaveLength(4);
    expect(harness.documents('shipment_audit_heads')).toEqual([
      expect.objectContaining({
        companyId: event.companyId,
        shipmentId: event.shipmentId,
        jobId: null,
        documentNumber: null,
        lastAction: 'VALIDATION_FAILED',
        lastOutcome: 'FAILURE',
        lastSafeCode: 'WEBHOOK_VALIDATION_FAILED',
        lastOccurredAt: new Date(occurredAt),
        lastEventKey: validationFailed.eventKey,
        version: 1,
      }),
    ]);
    await expect(repository.listPreJobFailureHeadsForCompany({
      companyId: event.companyId, limit: 20, before: null,
    })).resolves.toEqual({
      items: [expect.objectContaining({
        shipmentId: event.shipmentId,
        lastAction: 'VALIDATION_FAILED',
        lastOutcome: 'FAILURE',
      })],
      nextBefore: null,
    });

    const headBeforeReplay = harness.documents('shipment_audit_heads');
    await expect(repository.appendAuditEvents([
      webhookRejected, validationFailed, validationStarted, receipt,
    ])).resolves.toBeUndefined();
    expect(harness.documents('shipment_audit_events')).toHaveLength(4);
    expect(harness.documents('shipment_audit_heads')).toEqual(headBeforeReplay);
  });

  test('keeps a same-clock job-bound acceptance above hostile null-job lifecycle hashes', async () => {
    const { harness, repository } = await initializeRepository();
    const occurredAt = FIXED_NOW.toISOString();
    const event = eventRecord({
      eventId: 'same-clock-0',
      shipmentId: 'shipment-same-clock-0',
    });
    const shipment = normalizedShipment({ shipmentId: event.shipmentId });
    const receipt = webhookReceiptAudit({ event, occurredAt });
    const validationStarted = webhookValidationAudit({
      event, action: 'VALIDATION_STARTED', occurredAt,
    });
    const validationPassed = webhookValidationAudit({
      event,
      occurredAt,
      startedAt: occurredAt,
      completedAt: occurredAt,
    });

    await repository.appendAuditEvents([receipt]);
    await repository.appendAuditEvents([validationStarted]);
    await expect(repository.acceptWebhook(
      event, shipment, false, [validationPassed],
    )).resolves.toEqual({ created: true, jobId: 1 });

    const accepted = harness.documents('shipment_audit_events').find(
      audit => audit.action === 'WEBHOOK_ACCEPTED',
    );
    expect(receipt.eventKey > accepted.eventKey).toBe(true);
    expect(harness.documents('shipment_audit_heads')).toEqual([
      expect.objectContaining({
        shipmentId: event.shipmentId,
        jobId: Long.ONE,
        documentNumber: `VR-${event.shipmentId}-1`,
        lastAction: 'WEBHOOK_ACCEPTED',
        lastOutcome: 'SUCCESS',
        lastEventKey: accepted.eventKey,
      }),
    ]);
    await expect(repository.listPreJobFailureHeadsForCompany({
      companyId: event.companyId, limit: 20, before: null,
    })).resolves.toEqual({ items: [], nextBefore: null });
  });

  test('retains binary event-key ordering for same-clock job-bound lifecycle events', async () => {
    const { harness, repository } = await initializeRepository();
    const occurredAt = FIXED_NOW.toISOString();
    const validationStarted = entityAudit({
      shipmentId: 'shipment-job-order',
      documentNumber: 'VR-shipment-job-order-1',
      action: 'VALIDATION_STARTED',
      outcome: 'STARTED',
      occurredAt,
    });
    const validationFailed = entityAudit({
      shipmentId: 'shipment-job-order',
      documentNumber: 'VR-shipment-job-order-1',
      action: 'VALIDATION_FAILED',
      outcome: 'FAILURE',
      safeCode: 'LOCAL_VALIDATION_FAILED',
      occurredAt,
    });
    expect(validationStarted.eventKey > validationFailed.eventKey).toBe(true);

    await repository.appendAuditEvents([validationStarted, validationFailed]);

    expect(harness.documents('shipment_audit_heads')).toEqual([
      expect.objectContaining({
        jobId: Long.ONE,
        documentNumber: 'VR-shipment-job-order-1',
        lastAction: 'VALIDATION_STARTED',
        lastOutcome: 'STARTED',
        lastEventKey: validationStarted.eventKey,
      }),
    ]);
  });

  test('rejects same audit key with different content and an existing event whose head is absent', async () => {
    const { harness, repository } = await initializeRepository();
    const event = entityAudit();
    await repository.appendAuditEvents([event]);
    await expect(repository.appendAuditEvents([{ ...event, applicationId: 'application-other' }]))
      .rejects.toEqual(safeErrorExpectation(
        'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
      ));
    expect(harness.documents('shipment_audit_events')).toHaveLength(1);

    harness.replaceDocuments('shipment_audit_heads', []);
    await expect(repository.appendAuditEvents([event])).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
  });

  test('rejects corrupt head stage/action and exact-TTL invariants before a later event can repair them', async () => {
    for (const [suffix, corrupt] of [
      ['stage', head => ({ ...head, lastStage: 'PAYLOAD' })],
      ['ttl', head => ({
        ...head,
        expiresAt: new Date(head.expiresAt.getTime() + 1),
      })],
    ]) {
      const { harness, repository } = await initializeRepository();
      const first = entityAudit({
        shipmentId: `shipment-head-${suffix}`,
        documentNumber: `VR-shipment-head-${suffix}-1`,
        occurredAt: '2026-08-17T10:00:00.000Z',
      });
      const later = entityAudit({
        shipmentId: `shipment-head-${suffix}`,
        documentNumber: `VR-shipment-head-${suffix}-1`,
        parentVersion: 1,
        occurredAt: '2026-08-17T10:01:00.000Z',
      });
      await repository.appendAuditEvents([first]);
      harness.replaceDocuments('shipment_audit_heads', harness.documents(
        'shipment_audit_heads',
      ).map(corrupt));
      const corruptHead = harness.documents('shipment_audit_heads');

      await expect(repository.appendAuditEvents([later])).rejects.toEqual(
        safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
      );
      expect(harness.documents('shipment_audit_heads')).toEqual(corruptHead);
      expect(harness.documents('shipment_audit_events').some(
        event => event.eventKey === later.eventKey,
      )).toBe(false);
    }
  });

  test('rejects an internally valid but mismatching head at an inserted equal latest tuple', async () => {
    const { harness, repository } = await initializeRepository();
    const event = entityAudit();
    await repository.appendAuditEvents([event]);
    harness.replaceDocuments('shipment_audit_events', []);
    harness.replaceDocuments('shipment_audit_heads', harness.documents(
      'shipment_audit_heads',
    ).map(head => ({
      ...head,
      lastAction: 'VALIDATION_FAILED',
      lastOutcome: 'FAILURE',
      lastSafeCode: 'LOCAL_VALIDATION_FAILED',
    })));
    const corruptHead = harness.documents('shipment_audit_heads');

    await expect(repository.appendAuditEvents([event])).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
    expect(harness.documents('shipment_audit_events')).toEqual([]);
    expect(harness.documents('shipment_audit_heads')).toEqual(corruptHead);
  });

  test('allows the final safe head-version increment then rolls back a later tuple at exhaustion', async () => {
    const { harness, repository } = await initializeRepository();
    const first = entityAudit({ occurredAt: '2026-08-17T10:00:00.000Z' });
    const reachesMaximum = entityAudit({
      parentVersion: 1,
      occurredAt: '2026-08-17T10:01:00.000Z',
    });
    const overflows = entityAudit({
      parentVersion: 2,
      occurredAt: '2026-08-17T10:02:00.000Z',
    });
    await repository.appendAuditEvents([first]);
    harness.replaceDocuments('shipment_audit_heads', harness.documents(
      'shipment_audit_heads',
    ).map(head => ({ ...head, version: Number.MAX_SAFE_INTEGER - 1 })));

    await expect(repository.appendAuditEvents([reachesMaximum])).resolves.toBeUndefined();
    expect(harness.documents('shipment_audit_heads')[0].version).toBe(Number.MAX_SAFE_INTEGER);
    const before = {
      events: harness.documents('shipment_audit_events'),
      heads: harness.documents('shipment_audit_heads'),
    };

    await expect(repository.appendAuditEvents([overflows])).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
    expect(harness.documents('shipment_audit_events')).toEqual(before.events);
    expect(harness.documents('shipment_audit_heads')).toEqual(before.heads);
  });

  test('rejects an older duplicate when its live head points to a phantom later event', async () => {
    const { harness, repository } = await initializeRepository();
    const older = entityAudit({ occurredAt: '2026-08-17T10:00:00.000Z' });
    const latest = entityAudit({
      parentVersion: 1,
      occurredAt: '2026-08-17T10:01:00.000Z',
    });
    await repository.appendAuditEvents([older, latest]);
    harness.replaceDocuments('shipment_audit_events', harness.documents(
      'shipment_audit_events',
    ).filter(event => event.eventKey !== latest.eventKey));
    const before = {
      events: harness.documents('shipment_audit_events'),
      heads: harness.documents('shipment_audit_heads'),
    };

    await expect(repository.appendAuditEvents([older])).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
    expect(harness.documents('shipment_audit_events')).toEqual(before.events);
    expect(harness.documents('shipment_audit_heads')).toEqual(before.heads);
  });

  test('rejects field and tuple mismatches in a live head before a newer append can overwrite them', async () => {
    for (const [suffix, corrupt] of [
      ['field', head => ({ ...head, lastSafeCode: 'HEAD_POINTER_MISMATCH' })],
      ['tuple', head => ({
        ...head,
        lastOccurredAt: new Date(head.lastOccurredAt.getTime() + 1),
        expiresAt: new Date(head.expiresAt.getTime() + 1),
      })],
    ]) {
      const { harness, repository } = await initializeRepository();
      const first = entityAudit({
        shipmentId: `shipment-pointer-${suffix}`,
        documentNumber: `VR-shipment-pointer-${suffix}-1`,
        occurredAt: '2026-08-17T10:00:00.000Z',
      });
      const later = entityAudit({
        shipmentId: `shipment-pointer-${suffix}`,
        documentNumber: `VR-shipment-pointer-${suffix}-1`,
        parentVersion: 1,
        occurredAt: '2026-08-17T10:01:00.000Z',
      });
      await repository.appendAuditEvents([first]);
      harness.replaceDocuments('shipment_audit_heads', harness.documents(
        'shipment_audit_heads',
      ).map(corrupt));
      const before = {
        events: harness.documents('shipment_audit_events'),
        heads: harness.documents('shipment_audit_heads'),
      };

      await expect(repository.appendAuditEvents([later])).rejects.toEqual(
        safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
      );
      expect(harness.documents('shipment_audit_events')).toEqual(before.events);
      expect(harness.documents('shipment_audit_heads')).toEqual(before.heads);
    }
  });

  test('revives a logically expired head from a newer live event after TTL removes its backing event', async () => {
    const { harness, repository } = await initializeRepository();
    const expired = entityAudit({
      occurredAt: '2026-05-01T10:00:00.000Z',
    });
    const live = entityAudit({
      parentVersion: 1,
      occurredAt: '2026-08-17T10:00:00.001Z',
    });
    await repository.appendAuditEvents([expired]);
    harness.replaceDocuments('shipment_audit_events', []);

    await expect(repository.appendAuditEvents([live])).resolves.toBeUndefined();
    expect(harness.documents('shipment_audit_heads')[0]).toEqual(expect.objectContaining({
      firstOccurredAt: new Date(expired.occurredAt),
      lastOccurredAt: new Date(live.occurredAt),
      lastEventKey: live.eventKey,
      expiresAt: new Date(live.expiresAt),
      version: 1,
    }));
  });

  test('keeps first webhook receipt/entity clocks on platform replay but rejects nonclock drift', async () => {
    const { harness, repository } = await initializeRepository();
    const firstReceipt = webhookReceiptAudit({ occurredAt: '2026-08-17T09:59:00.000Z' });
    const firstEntity = webhookEntityAudit({ occurredAt: '2026-08-17T09:59:30.000Z' });
    const firstValidationStarted = webhookValidationAudit({
      action: 'VALIDATION_STARTED', occurredAt: '2026-08-17T09:59:40.000Z',
    });
    const firstValidationPassed = webhookValidationAudit({ occurredAt: '2026-08-17T09:59:50.000Z' });
    const laterReceipt = webhookReceiptAudit({ occurredAt: '2026-08-17T10:01:00.000Z' });
    const laterEntity = webhookEntityAudit({ occurredAt: '2026-08-17T10:01:30.000Z' });
    const laterValidationStarted = webhookValidationAudit({
      action: 'VALIDATION_STARTED', occurredAt: '2026-08-17T10:01:40.000Z',
    });
    const laterValidationPassed = webhookValidationAudit({ occurredAt: '2026-08-17T10:01:50.000Z' });
    await repository.appendAuditEvents([
      firstReceipt, firstEntity, firstValidationStarted, firstValidationPassed,
    ]);
    const before = {
      events: harness.documents('shipment_audit_events'),
      heads: harness.documents('shipment_audit_heads'),
    };

    await expect(repository.appendAuditEvents([
      laterReceipt, laterEntity, laterValidationStarted, laterValidationPassed,
    ])).resolves.toBeUndefined();
    expect(harness.documents('shipment_audit_events')).toEqual(before.events);
    expect(harness.documents('shipment_audit_heads')).toEqual(before.heads);

    for (const replay of [
      { ...laterReceipt, applicationId: 'application-other' },
      { ...laterEntity, jobId: 99 },
    ]) {
      await expect(repository.appendAuditEvents([replay])).rejects.toEqual(safeErrorExpectation(
        'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
      ));
    }
    expect(harness.documents('shipment_audit_events')).toEqual(before.events);
    expect(harness.documents('shipment_audit_heads')).toEqual(before.heads);
  });

  test('keeps job-scoped validation replay clock-exact', async () => {
    const { repository } = await initializeRepository();
    const first = entityAudit({ occurredAt: '2026-08-17T10:00:00.000Z' });
    const later = entityAudit({ occurredAt: '2026-08-17T10:01:00.000Z' });
    await repository.appendAuditEvents([first]);
    await expect(repository.appendAuditEvents([later])).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
  });

  test('lists live heads by exclusive binary tuple, requires an exact tenant anchor, and fetches limit plus one', async () => {
    const { harness, repository } = await initializeRepository();
    const events = [
      entityAudit({ shipmentId: 'shipment-a', jobId: 1, occurredAt: '2026-08-17T10:01:00.000Z' }),
      entityAudit({ shipmentId: 'shipment-b', jobId: 2, occurredAt: '2026-08-17T10:02:00.000Z' }),
      entityAudit({ shipmentId: 'shipment-c', jobId: 3, occurredAt: '2026-08-17T10:03:00.000Z' }),
      entityAudit({
        shipmentId: 'shipment-foreign', companyId: 'company-2', jobId: 4,
        occurredAt: '2026-08-17T10:04:00.000Z',
      }),
      entityAudit({
        shipmentId: 'shipment-expired', jobId: 5,
        occurredAt: '2026-05-01T10:00:00.000Z',
      }),
    ];
    await repository.appendAuditEvents(events);

    const firstPage = await repository.listShipmentAuditHeadsForCompany({
      companyId: 'company-1', limit: 2, before: null,
    });
    expect(firstPage).toEqual({
      items: [
        expect.objectContaining({ shipmentId: 'shipment-c', jobId: 3 }),
        expect.objectContaining({ shipmentId: 'shipment-b', jobId: 2 }),
      ],
      nextBefore: {
        lastOccurredAt: '2026-08-17T10:02:00.000Z',
        shipmentId: 'shipment-b',
      },
    });
    expect(Object.isFrozen(firstPage)).toBe(true);
    expect(Object.isFrozen(firstPage.items[0])).toBe(true);
    expect(firstPage.items.map(item => item.shipmentId)).not.toContain('shipment-expired');
    await expect(repository.listShipmentAuditHeadsForCompany({
      companyId: 'company-1', limit: 2, before: firstPage.nextBefore,
    })).resolves.toEqual({
      items: [expect.objectContaining({ shipmentId: 'shipment-a', jobId: 1 })],
      nextBefore: null,
    });

    const headFinds = harness.trace.operations.filter(operation => (
      operation.collection === 'shipment_audit_heads' && operation.method === 'find'
    ));
    expect(headFinds.at(-1).filter).toEqual({
      companyId: 'company-1',
      expiresAt: { $gt: new Date(FIXED_NOW) },
      $or: [
        { lastOccurredAt: { $lt: new Date('2026-08-17T10:02:00.000Z') } },
        {
          lastOccurredAt: new Date('2026-08-17T10:02:00.000Z'),
          shipmentId: { $lt: 'shipment-b' },
        },
      ],
    });

    for (const before of [
      { lastOccurredAt: '2026-08-17T10:02:00.001Z', shipmentId: 'shipment-b' },
      { lastOccurredAt: '2026-08-17T10:02:00.000Z', shipmentId: 'shipment-missing' },
    ]) {
      await expect(repository.listShipmentAuditHeadsForCompany({
        companyId: 'company-1', limit: 2, before,
      })).rejects.toEqual(safeErrorExpectation(
        'REPOSITORY_INPUT_INVALID', 'Invoice repository read input is invalid',
      ));
    }
  });

  test('lists only live pre-job failures by an exclusive tuple and rejects anchors outside the filtered feed', async () => {
    const { harness, repository } = await initializeRepository();
    const included = [
      preJobFailureAudit({
        shipmentId: 'pre-job-a', action: 'VALIDATION_FAILED',
        occurredAt: '2026-08-17T10:01:00.000Z',
      }),
      preJobFailureAudit({
        shipmentId: 'pre-job-b', action: 'WEBHOOK_REJECTED',
        occurredAt: '2026-08-17T10:02:00.000Z',
      }),
      preJobFailureAudit({
        shipmentId: 'pre-job-c', action: 'VALIDATION_FAILED',
        occurredAt: '2026-08-17T10:03:00.000Z',
      }),
    ];
    const foreign = preJobFailureAudit({
      companyId: 'company-2', shipmentId: 'pre-job-foreign',
      occurredAt: '2026-08-17T10:04:00.000Z',
    });
    const expired = preJobFailureAudit({
      shipmentId: 'pre-job-expired', occurredAt: '2026-05-01T10:00:00.000Z',
    });
    const jobBound = entityAudit({
      shipmentId: 'pre-job-job-bound', jobId: 99,
      documentNumber: 'VR-pre-job-job-bound-1', stage: 'VALIDATION',
      action: 'VALIDATION_FAILED', outcome: 'FAILURE', safeCode: 'LOCAL_VALIDATION_FAILED',
      occurredAt: '2026-08-17T10:05:00.000Z',
    });
    const nonfailure = webhookEntityAudit({
      event: eventRecord({ eventId: 'event-nonfailure', shipmentId: 'pre-job-nonfailure' }),
      occurredAt: '2026-08-17T10:06:00.000Z',
    });
    const otherAction = preJobFailureAudit({
      shipmentId: 'pre-job-other-action', action: 'JOB_DATA_FAILED',
      safeCode: 'LOCAL_VALIDATION_FAILED', occurredAt: '2026-08-17T10:07:00.000Z',
    });
    await repository.appendAuditEvents([
      ...included, foreign, expired, jobBound, nonfailure, otherAction,
    ]);

    const firstPage = await repository.listPreJobFailureHeadsForCompany({
      companyId: 'company-1', limit: 2, before: null,
    });
    expect(firstPage).toEqual({
      items: [
        expect.objectContaining({
          shipmentId: 'pre-job-c', jobId: null, documentNumber: null,
          lastAction: 'VALIDATION_FAILED', lastOutcome: 'FAILURE',
        }),
        expect.objectContaining({
          shipmentId: 'pre-job-b', jobId: null, documentNumber: null,
          lastAction: 'WEBHOOK_REJECTED', lastOutcome: 'FAILURE',
        }),
      ],
      nextBefore: {
        lastOccurredAt: '2026-08-17T10:02:00.000Z', shipmentId: 'pre-job-b',
      },
    });
    expect(Object.isFrozen(firstPage)).toBe(true);
    expect(Object.isFrozen(firstPage.items[0])).toBe(true);
    await expect(repository.listPreJobFailureHeadsForCompany({
      companyId: 'company-1', limit: 2, before: firstPage.nextBefore,
    })).resolves.toEqual({
      items: [expect.objectContaining({ shipmentId: 'pre-job-a' })],
      nextBefore: null,
    });

    const pageFind = harness.trace.operations.filter(operation => (
      operation.collection === 'shipment_audit_heads' && operation.method === 'find'
    )).at(-1);
    expect(pageFind.filter).toEqual({
      companyId: 'company-1',
      jobId: null,
      documentNumber: null,
      lastOutcome: 'FAILURE',
      lastAction: { $in: ['WEBHOOK_REJECTED', 'VALIDATION_FAILED'] },
      expiresAt: { $gt: new Date(FIXED_NOW) },
      $or: [
        { lastOccurredAt: { $lt: new Date('2026-08-17T10:02:00.000Z') } },
        {
          lastOccurredAt: new Date('2026-08-17T10:02:00.000Z'),
          shipmentId: { $lt: 'pre-job-b' },
        },
      ],
    });

    for (const excluded of [foreign, expired, jobBound, nonfailure, otherAction]) {
      await expect(repository.listPreJobFailureHeadsForCompany({
        companyId: 'company-1',
        limit: 2,
        before: { lastOccurredAt: excluded.occurredAt, shipmentId: excluded.shipmentId },
      })).rejects.toEqual(safeErrorExpectation(
        'REPOSITORY_INPUT_INVALID', 'Invoice repository read input is invalid',
      ));
    }
  });

  test('fails closed on a malformed stored pre-job failure head and malformed cursor input', async () => {
    const { harness, repository } = await initializeRepository();
    const event = preJobFailureAudit({ shipmentId: 'pre-job-corrupt' });
    await repository.appendAuditEvents([event]);
    harness.replaceDocuments('shipment_audit_heads', harness.documents(
      'shipment_audit_heads',
    ).map(head => ({ ...head, lastSafeCode: 'private invalid code' })));

    await expect(repository.listPreJobFailureHeadsForCompany({
      companyId: 'company-1', limit: 20, before: null,
    })).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    const before = harness.trace.operations.length;
    await expect(repository.listPreJobFailureHeadsForCompany({
      companyId: 'company-1', limit: 20,
      before: { lastOccurredAt: 'not-an-instant', shipmentId: 'pre-job-corrupt' },
    })).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository read input is invalid',
    ));
    expect(harness.trace.operations).toHaveLength(before);
  });

  test('lists one tenant shipment timeline newest-first with exact cursor boundaries and logical expiry', async () => {
    const { harness, repository } = await initializeRepository();
    const events = [
      entityAudit({ parentVersion: 1, occurredAt: '2026-08-17T10:01:00.000Z' }),
      entityAudit({ parentVersion: 2, occurredAt: '2026-08-17T10:02:00.000Z' }),
      entityAudit({ parentVersion: 3, occurredAt: '2026-08-17T10:03:00.000Z' }),
      entityAudit({
        parentVersion: 4, companyId: 'company-2',
        occurredAt: '2026-08-17T10:04:00.000Z',
      }),
      entityAudit({ parentVersion: 5, occurredAt: '2026-05-01T10:00:00.000Z' }),
    ];
    await repository.appendAuditEvents(events);

    const firstPage = await repository.listShipmentAuditEventsForCompany({
      companyId: 'company-1', shipmentId: 'shipment-1', limit: 2, before: null,
    });
    expect(firstPage.items.map(item => item.occurredAt)).toEqual([
      '2026-08-17T10:03:00.000Z',
      '2026-08-17T10:02:00.000Z',
    ]);
    expect(firstPage.nextBefore).toEqual({
      occurredAt: '2026-08-17T10:02:00.000Z',
      eventKey: firstPage.items[1].eventKey,
    });
    expect(Object.isFrozen(firstPage.items[0])).toBe(true);
    expect(firstPage.items[0]).not.toHaveProperty('_id');

    await expect(repository.listShipmentAuditEventsForCompany({
      companyId: 'company-1',
      shipmentId: 'shipment-1',
      limit: 2,
      before: firstPage.nextBefore,
    })).resolves.toEqual({
      items: [expect.objectContaining({ occurredAt: '2026-08-17T10:01:00.000Z' })],
      nextBefore: null,
    });

    const timelineFinds = harness.trace.operations.filter(operation => (
      operation.collection === 'shipment_audit_events' && operation.method === 'find'
    ));
    expect(timelineFinds.at(-1).filter).toEqual({
      companyId: 'company-1',
      shipmentId: 'shipment-1',
      expiresAt: { $gt: new Date(FIXED_NOW) },
      $or: [
        { occurredAt: { $lt: new Date('2026-08-17T10:02:00.000Z') } },
        {
          occurredAt: new Date('2026-08-17T10:02:00.000Z'),
          eventKey: { $lt: firstPage.items[1].eventKey },
        },
      ],
    });
  });

  test('fails closed instead of returning a non-allowlisted stored audit summary', async () => {
    const { harness, repository } = await initializeRepository();
    const event = entityAudit();
    await repository.appendAuditEvents([event]);
    harness.replaceDocuments('shipment_audit_events', harness.documents('shipment_audit_events').map(
      stored => stored.eventKey === event.eventKey
        ? { ...stored, requestSummary: { rawToken: 'synthetic-private-value' } }
        : stored,
    ));

    const error = await repository.listShipmentAuditEventsForCompany({
      companyId: event.companyId,
      shipmentId: event.shipmentId,
      limit: 20,
      before: null,
    }).catch(value => value);
    expect(error).toEqual(safeErrorExpectation(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    expect(`${error.message} ${error.stack}`).not.toContain('synthetic-private-value');
  });

  test('fails closed when a stored audit action is paired with the wrong stage', async () => {
    const { harness, repository } = await initializeRepository();
    const event = entityAudit();
    await repository.appendAuditEvents([event]);
    harness.replaceDocuments('shipment_audit_events', harness.documents('shipment_audit_events').map(
      stored => stored.eventKey === event.eventKey ? { ...stored, stage: 'PAYLOAD' } : stored,
    ));

    await expect(repository.listShipmentAuditEventsForCompany({
      companyId: event.companyId,
      shipmentId: event.shipmentId,
      limit: 20,
      before: null,
    })).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
  });

  test('rejects malformed and stale audit cursors before running the page query', async () => {
    const { harness, repository } = await initializeRepository();
    const event = entityAudit();
    await repository.appendAuditEvents([event]);
    const invalidQueries = [
      ['listShipmentAuditHeadsForCompany', {
        companyId: 'company-1', limit: 0, before: null,
      }],
      ['listShipmentAuditHeadsForCompany', {
        companyId: 'company-1', limit: 20, before: {
          lastOccurredAt: 'not-an-instant', shipmentId: 'shipment-1',
        },
      }],
      ['listPreJobFailureHeadsForCompany', {
        companyId: 'company-1', limit: 20, before: {
          lastOccurredAt: 'not-an-instant', shipmentId: 'shipment-1',
        },
      }],
      ['listShipmentAuditEventsForCompany', {
        companyId: 'company-1', shipmentId: 'shipment-1', limit: 20,
        before: { occurredAt: event.occurredAt, eventKey: 'v1.invalid' },
      }],
      ['listShipmentAuditEventsForCompany', {
        companyId: 'company-2', shipmentId: 'shipment-1', limit: 20,
        before: { occurredAt: event.occurredAt, eventKey: event.eventKey },
      }],
    ];
    for (const [method, query] of invalidQueries) {
      const before = harness.trace.operations.length;
      await expect(repository[method](query)).rejects.toEqual(safeErrorExpectation(
        'REPOSITORY_INPUT_INVALID', 'Invoice repository read input is invalid',
      ));
      expect(harness.trace.operations.length - before).toBeLessThanOrEqual(1);
    }
  });
});

describe('Mongo durable external-operation intents and unresolved recovery', () => {
  test('atomically CASes a JOB intent, persists its STARTED event/head, and stores strict private pending metadata', async () => {
    const { harness, repository } = await initializeRepository();
    const accepted = await acceptFor(harness, repository, 'intent');
    replaceJob(harness, accepted.accepted.jobId, readyJobPatch({
      attemptCount: 2,
      version: 5,
    }));
    const started = lockOperationAudit({
      shipmentId: accepted.shipmentId,
      jobId: accepted.accepted.jobId,
      expectedParentVersion: 5,
      attemptNumber: 2,
      occurredAt: '2026-08-17T10:00:01.000Z',
    });

    const result = await repository.beginExternalOperation({
      targetKind: 'JOB',
      targetId: accepted.accepted.jobId,
      expectedVersion: 5,
      event: started.event,
    });
    expect(result).toEqual({
      targetKind: 'JOB',
      targetId: String(accepted.accepted.jobId),
      operationKey: started.operationKey,
      eventKey: started.eventKey,
      stage: 'FYND_LOCK',
      action: 'FYND_LOCK_REQUESTED',
      attemptNumber: 2,
      startedAt: started.event.startedAt,
      targetVersion: 6,
    });
    expect(Reflect.ownKeys(result)).toEqual([
      'targetKind', 'targetId', 'operationKey', 'eventKey', 'stage', 'action',
      'attemptNumber', 'startedAt', 'targetVersion',
    ]);
    expect(Object.isFrozen(result)).toBe(true);

    const storedJob = findLongDocument(
      harness.documents('invoice_jobs'), 'jobId', accepted.accepted.jobId,
    );
    expect(storedJob.version).toBe(6);
    expect(storedJob.pendingOperation).toEqual({
      operationKey: started.operationKey,
      eventKey: started.eventKey,
      stage: 'FYND_LOCK',
      action: 'FYND_LOCK_REQUESTED',
      attemptNumber: 2,
      expectedParentVersion: 5,
      startedAt: new Date(started.event.startedAt),
      targetKind: 'JOB',
      targetId: Long.fromNumber(accepted.accepted.jobId),
    });
    expect(harness.documents('shipment_audit_events').find(
      event => event.eventKey === started.eventKey,
    )).toEqual(expect.objectContaining({ jobId: Long.fromNumber(accepted.accepted.jobId) }));
    expect(harness.documents('shipment_audit_heads').find(
      head => head.shipmentId === accepted.shipmentId,
    )).toEqual(expect.objectContaining({ lastEventKey: started.eventKey }));
    const publicJob = await repository.getJob(accepted.accepted.jobId);
    expect(publicJob.version).toBe(6);
    expect(publicJob).not.toHaveProperty('pendingOperation');

    replaceJob(harness, accepted.accepted.jobId, {
      pendingOperation: {
        ...storedJob.pendingOperation,
        expectedParentVersion: 6,
      },
    });
    await expect(repository.getJob(accepted.accepted.jobId)).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );

    const transitionEventKey = createEventKey({
      kind: 'OPERATION',
      operationKey: started.operationKey,
      stage: 'FYND_TRANSITION',
      action: 'FYND_TRANSITION_REQUESTED',
      outcome: 'STARTED',
    });
    replaceJob(harness, accepted.accepted.jobId, {
      pendingOperation: {
        ...storedJob.pendingOperation,
        eventKey: transitionEventKey,
        stage: 'FYND_TRANSITION',
        action: 'FYND_TRANSITION_REQUESTED',
      },
    });
    await expect(repository.getJob(accepted.accepted.jobId)).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
  });

  test('returns the exact existing pending operation idempotently and conflicts on a different intent', async () => {
    const { harness, repository } = await initializeRepository();
    const accepted = await acceptFor(harness, repository, 'intent-repeat');
    replaceJob(harness, accepted.accepted.jobId, readyJobPatch({ version: 3 }));
    const first = lockOperationAudit({
      shipmentId: accepted.shipmentId,
      jobId: accepted.accepted.jobId,
      expectedParentVersion: 3,
    });
    const input = {
      targetKind: 'JOB', targetId: accepted.accepted.jobId, expectedVersion: 3, event: first.event,
    };
    const created = await repository.beginExternalOperation(input);
    const before = {
      jobs: harness.documents('invoice_jobs'),
      events: harness.documents('shipment_audit_events'),
      heads: harness.documents('shipment_audit_heads'),
    };
    const replayed = await repository.beginExternalOperation(input);
    expect(replayed).toEqual(created);
    expect(replayed).not.toBe(created);
    expect(Reflect.ownKeys(replayed)).toEqual([
      'targetKind', 'targetId', 'operationKey', 'eventKey', 'stage', 'action',
      'attemptNumber', 'startedAt', 'targetVersion',
    ]);
    expect(harness.documents('invoice_jobs')).toEqual(before.jobs);
    expect(harness.documents('shipment_audit_events')).toEqual(before.events);
    expect(harness.documents('shipment_audit_heads')).toEqual(before.heads);

    const different = lockOperationAudit({
      shipmentId: accepted.shipmentId,
      jobId: accepted.accepted.jobId,
      expectedParentVersion: 4,
      attemptNumber: 2,
    });
    await expect(repository.beginExternalOperation({
      targetKind: 'JOB', targetId: accepted.accepted.jobId, expectedVersion: 4, event: different.event,
    })).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
    ));
  });

  test('rejects pending metadata that rolls target version or attempt backward, including after audit TTL', async () => {
    const { harness, repository, clock } = await initializeRepository();
    const accepted = await acceptFor(harness, repository, 'pending-monotonicity');
    replaceJob(harness, accepted.accepted.jobId, readyJobPatch({
      attemptCount: 2,
      version: 5,
    }));
    const started = lockOperationAudit({
      shipmentId: accepted.shipmentId,
      jobId: accepted.accepted.jobId,
      expectedParentVersion: 5,
      attemptNumber: 2,
    });
    await repository.beginExternalOperation({
      targetKind: 'JOB', targetId: accepted.accepted.jobId, expectedVersion: 5,
      event: started.event,
    });
    const storedJob = findLongDocument(
      harness.documents('invoice_jobs'), 'jobId', accepted.accepted.jobId,
    );
    const impossiblePending = ({ expectedParentVersion, attemptNumber }) => {
      const operationKey = createOperationKey({
        targetKind: 'JOB',
        targetId: String(accepted.accepted.jobId),
        expectedParentVersion,
        attemptNumber,
        stage: 'FYND_LOCK',
        action: 'FYND_LOCK_REQUESTED',
      });
      return {
        ...storedJob.pendingOperation,
        operationKey,
        eventKey: createEventKey({
          kind: 'OPERATION', operationKey, stage: 'FYND_LOCK',
          action: 'FYND_LOCK_REQUESTED', outcome: 'STARTED',
        }),
        expectedParentVersion,
        attemptNumber,
      };
    };

    replaceJob(harness, accepted.accepted.jobId, {
      pendingOperation: impossiblePending({ expectedParentVersion: 6, attemptNumber: 2 }),
    });
    await expect(repository.getJob(accepted.accepted.jobId)).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );

    replaceJob(harness, accepted.accepted.jobId, {
      pendingOperation: impossiblePending({
        expectedParentVersion: Number.MAX_SAFE_INTEGER,
        attemptNumber: 2,
      }),
    });
    await expect(repository.getJob(accepted.accepted.jobId)).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );

    replaceJob(harness, accepted.accepted.jobId, {
      pendingOperation: impossiblePending({ expectedParentVersion: 5, attemptNumber: 3 }),
    });
    clock.set(new Date(Date.parse(started.event.expiresAt)));
    await expect(repository.findUnresolvedAuditOperation({
      companyId: 'company-1', jobId: accepted.accepted.jobId, stage: 'FYND_LOCK',
    })).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
  });

  test('requires a current complete lease, exact attempt, prepared bytes, and action-specific job stage', async () => {
    const { harness, repository } = await initializeRepository();
    const cases = [
      ['missing lease owner', { leaseOwner: null }],
      ['missing lease expiry', { leaseExpiresAt: null }],
      ['expired lease', { leaseExpiresAt: new Date(FIXED_NOW) }],
      ['missing prepared bytes', { oeisRequestJson: null }],
      ['missing prepared hash', { requestHash: null }],
      ['prepared bytes hash mismatch', { requestHash: 'b'.repeat(64) }],
      ['lock operation after lock', { state: JOB_STATES.LOCKED, lockedAt: new Date(RECEIVED_AT) }],
      ['locked retry classified as lock', { state: JOB_STATES.RETRY_WAIT, lockedAt: new Date(RECEIVED_AT) }],
    ];
    for (const [suffix, patch] of cases) {
      const accepted = await acceptFor(harness, repository, `guard-${suffix.replaceAll(' ', '-')}`);
      replaceJob(harness, accepted.accepted.jobId, readyJobPatch({ version: 3, ...patch }));
      const started = lockOperationAudit({
        shipmentId: accepted.shipmentId,
        jobId: accepted.accepted.jobId,
        expectedParentVersion: 3,
      });
      await expect(repository.beginExternalOperation({
        targetKind: 'JOB', targetId: accepted.accepted.jobId, expectedVersion: 3,
        event: started.event,
      })).rejects.toEqual(safeErrorExpectation(
        'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
      ));
      expect(findLongDocument(
        harness.documents('invoice_jobs'), 'jobId', accepted.accepted.jobId,
      )).toEqual(expect.objectContaining({ version: 3, pendingOperation: null }));
      expect(harness.documents('shipment_audit_events').find(
        event => event.eventKey === started.eventKey,
      )).toBeUndefined();
    }

    const attemptMismatch = await acceptFor(harness, repository, 'guard-attempt');
    replaceJob(harness, attemptMismatch.accepted.jobId, readyJobPatch({
      attemptCount: 2,
      version: 4,
    }));
    const wrongAttempt = lockOperationAudit({
      shipmentId: attemptMismatch.shipmentId,
      jobId: attemptMismatch.accepted.jobId,
      expectedParentVersion: 4,
      attemptNumber: 99,
    });
    await expect(repository.beginExternalOperation({
      targetKind: 'JOB', targetId: attemptMismatch.accepted.jobId, expectedVersion: 4,
      event: wrongAttempt.event,
    })).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
    ));

    const wrongRetry = await acceptFor(harness, repository, 'guard-oeis-retry');
    replaceJob(harness, wrongRetry.accepted.jobId, readyJobPatch({
      state: JOB_STATES.RETRY_WAIT,
      attemptCount: 3,
      version: 5,
      lockedAt: null,
    }));
    const wrongOeisStage = oeisOperationAudit({
      shipmentId: wrongRetry.shipmentId,
      jobId: wrongRetry.accepted.jobId,
      expectedParentVersion: 5,
      attemptNumber: 3,
    });
    await expect(repository.beginExternalOperation({
      targetKind: 'JOB', targetId: wrongRetry.accepted.jobId, expectedVersion: 5,
      event: wrongOeisStage.event,
    })).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
    ));

    const corruptOeis = await acceptFor(harness, repository, 'guard-oeis-hash');
    const corruptHash = 'b'.repeat(64);
    replaceJob(harness, corruptOeis.accepted.jobId, readyJobPatch({
      state: JOB_STATES.LOCKED,
      attemptCount: 3,
      version: 6,
      lockedAt: new Date(RECEIVED_AT),
      requestHash: corruptHash,
    }));
    const corruptOeisEvent = oeisOperationAudit({
      shipmentId: corruptOeis.shipmentId,
      jobId: corruptOeis.accepted.jobId,
      expectedParentVersion: 6,
      attemptNumber: 3,
      requestSha256: corruptHash,
    });
    await expect(repository.beginExternalOperation({
      targetKind: 'JOB', targetId: corruptOeis.accepted.jobId, expectedVersion: 6,
      event: corruptOeisEvent.event,
    })).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
    ));
  });

  test('rejects cross-shipment, document, type, attempt, and digest summary identity before mutation', async () => {
    const { harness, repository } = await initializeRepository();
    const fyndCases = [
      ['shipment', { summaryShipmentId: 'shipment-other' }],
      ['document', { summaryDocumentNumber: 'VR-shipment-other-1' }],
    ];
    for (const [suffix, override] of fyndCases) {
      const accepted = await acceptFor(harness, repository, `summary-fynd-${suffix}`);
      replaceJob(harness, accepted.accepted.jobId, readyJobPatch({ version: 3 }));
      const started = lockOperationAudit({
        shipmentId: accepted.shipmentId,
        jobId: accepted.accepted.jobId,
        expectedParentVersion: 3,
        ...override,
      });
      await expect(repository.beginExternalOperation({
        targetKind: 'JOB', targetId: accepted.accepted.jobId, expectedVersion: 3,
        event: started.event,
      })).rejects.toEqual(
        safeErrorExpectation('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid'),
      );
      expect(findLongDocument(
        harness.documents('invoice_jobs'), 'jobId', accepted.accepted.jobId,
      )).toEqual(expect.objectContaining({ version: 3, pendingOperation: null }));
      expect(harness.documents('shipment_audit_events').some(
        event => event.eventKey === started.eventKey,
      )).toBe(false);
    }

    const oeisCases = [
      ['document', { summaryDocumentNumber: 'VR-shipment-other-1' }],
      ['type', { summaryDocumentType: 'CN' }],
      ['attempt', { summaryAttemptNumber: 99 }],
      ['digest', { requestSha256: 'b'.repeat(64) }],
    ];
    for (const [suffix, override] of oeisCases) {
      const accepted = await acceptFor(harness, repository, `summary-oeis-${suffix}`);
      replaceJob(harness, accepted.accepted.jobId, readyJobPatch({
        state: JOB_STATES.LOCKED,
        attemptCount: 2,
        version: 4,
        lockedAt: new Date(RECEIVED_AT),
      }));
      const started = oeisOperationAudit({
        shipmentId: accepted.shipmentId,
        jobId: accepted.accepted.jobId,
        expectedParentVersion: 4,
        attemptNumber: 2,
        ...override,
      });
      await expect(repository.beginExternalOperation({
        targetKind: 'JOB', targetId: accepted.accepted.jobId, expectedVersion: 4,
        event: started.event,
      })).rejects.toEqual(
        safeErrorExpectation('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid'),
      );
      expect(findLongDocument(
        harness.documents('invoice_jobs'), 'jobId', accepted.accepted.jobId,
      )).toEqual(expect.objectContaining({ version: 4, pendingOperation: null }));
      expect(harness.documents('shipment_audit_events').some(
        event => event.eventKey === started.eventKey,
      )).toBe(false);
    }
  });

  test('begins OEIS only from a live leased locked job with matching prepared metadata', async () => {
    const { harness, repository } = await initializeRepository();
    const accepted = await acceptFor(harness, repository, 'oeis-intent');
    replaceJob(harness, accepted.accepted.jobId, readyJobPatch({
      state: JOB_STATES.LOCKED,
      attemptCount: 3,
      version: 4,
      lockedAt: new Date(RECEIVED_AT),
    }));
    const started = oeisOperationAudit({
      shipmentId: accepted.shipmentId,
      jobId: accepted.accepted.jobId,
      expectedParentVersion: 4,
      attemptNumber: 3,
    });

    await expect(repository.beginExternalOperation({
      targetKind: 'JOB', targetId: accepted.accepted.jobId, expectedVersion: 4,
      event: started.event,
    })).resolves.toEqual({
      targetKind: 'JOB',
      targetId: String(accepted.accepted.jobId),
      operationKey: started.operationKey,
      eventKey: started.eventKey,
      stage: 'OEIS_SUBMISSION',
      action: 'OEIS_SUBMISSION_REQUESTED',
      attemptNumber: 3,
      startedAt: started.event.startedAt,
      targetVersion: 5,
    });
  });

  test('finds pending intent by tenant/job/stage despite current version drift and survives audit TTL deletion', async () => {
    const { harness, repository, clock } = await initializeRepository();
    const accepted = await acceptFor(harness, repository, 'recovery');
    replaceJob(harness, accepted.accepted.jobId, readyJobPatch({
      attemptCount: 4,
      version: 7,
    }));
    const started = lockOperationAudit({
      shipmentId: accepted.shipmentId,
      jobId: accepted.accepted.jobId,
      expectedParentVersion: 7,
      attemptNumber: 4,
    });
    await repository.beginExternalOperation({
      targetKind: 'JOB', targetId: accepted.accepted.jobId, expectedVersion: 7, event: started.event,
    });
    replaceJob(harness, accepted.accepted.jobId, { version: 12, attemptCount: 9 });

    const query = { companyId: 'company-1', jobId: accepted.accepted.jobId, stage: 'FYND_LOCK' };
    const recovery = await repository.findUnresolvedAuditOperation(query);
    expect(recovery).toEqual({
      targetKind: 'JOB',
      targetId: String(accepted.accepted.jobId),
      operationKey: started.operationKey,
      eventKey: started.eventKey,
      stage: 'FYND_LOCK',
      action: 'FYND_LOCK_REQUESTED',
      attemptNumber: 4,
      startedAt: started.event.startedAt,
      targetVersion: 12,
    });
    expect(Reflect.ownKeys(recovery)).toEqual([
      'targetKind', 'targetId', 'operationKey', 'eventKey', 'stage', 'action',
      'attemptNumber', 'startedAt', 'targetVersion',
    ]);
    expect(Object.isFrozen(recovery)).toBe(true);
    await expect(repository.findUnresolvedAuditOperation({
      companyId: 'company-2', jobId: accepted.accepted.jobId, stage: 'FYND_LOCK',
    })).resolves.toBeNull();
    await expect(repository.findUnresolvedAuditOperation({
      companyId: 'company-1', jobId: accepted.accepted.jobId, stage: 'OEIS_SUBMISSION',
    })).resolves.toBeNull();

    clock.set(new Date(Date.parse(started.event.expiresAt) + 1));
    await expect(repository.findUnresolvedAuditOperation(query)).resolves.toEqual(recovery);
  });

  test('treats a missing pending STARTED event as corruption until its exact logical expiry', async () => {
    const { harness, repository, clock } = await initializeRepository();
    const accepted = await acceptFor(harness, repository, 'missing-start');
    replaceJob(harness, accepted.accepted.jobId, readyJobPatch({ version: 6 }));
    const started = lockOperationAudit({
      shipmentId: accepted.shipmentId,
      jobId: accepted.accepted.jobId,
      expectedParentVersion: 6,
    });
    const input = {
      targetKind: 'JOB', targetId: accepted.accepted.jobId, expectedVersion: 6,
      event: started.event,
    };
    const created = await repository.beginExternalOperation(input);
    harness.replaceDocuments('shipment_audit_events', harness.documents(
      'shipment_audit_events',
    ).filter(event => event.eventKey !== started.eventKey));
    const query = {
      companyId: 'company-1', jobId: accepted.accepted.jobId, stage: 'FYND_LOCK',
    };

    for (const operation of [
      () => repository.findUnresolvedAuditOperation(query),
      () => repository.beginExternalOperation(input),
    ]) {
      await expect(operation()).rejects.toEqual(
        safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
      );
    }

    clock.set(new Date(Date.parse(started.event.startedAt) + AUDIT_RETENTION_MS));
    await expect(repository.findUnresolvedAuditOperation(query)).resolves.toEqual(created);
    await expect(repository.beginExternalOperation(input)).resolves.toEqual(created);
  });

  test('refuses to guess when live audit evidence has multiple unresolved operations or an outcome against uncleared pending state', async () => {
    const { harness, repository } = await initializeRepository();
    const accepted = await acceptFor(harness, repository, 'ambiguous');
    replaceJob(harness, accepted.accepted.jobId, readyJobPatch({ version: 2 }));
    const first = lockOperationAudit({
      shipmentId: accepted.shipmentId,
      jobId: accepted.accepted.jobId,
      expectedParentVersion: 2,
      attemptNumber: 1,
    });
    await repository.beginExternalOperation({
      targetKind: 'JOB', targetId: accepted.accepted.jobId, expectedVersion: 2, event: first.event,
    });
    const second = lockOperationAudit({
      shipmentId: accepted.shipmentId,
      jobId: accepted.accepted.jobId,
      expectedParentVersion: 3,
      attemptNumber: 2,
      occurredAt: '2026-08-17T10:01:00.000Z',
    });
    harness.seed('shipment_audit_events', [storedAuditEvent(second.event)]);
    const query = { companyId: 'company-1', jobId: accepted.accepted.jobId, stage: 'FYND_LOCK' };
    await expect(repository.findUnresolvedAuditOperation(query)).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );

    harness.replaceDocuments('shipment_audit_events', harness.documents('shipment_audit_events').filter(
      event => event.eventKey !== second.eventKey,
    ));
    const outcome = lockOutcomeAudit(first, {
      shipmentId: accepted.shipmentId,
      jobId: accepted.accepted.jobId,
      attemptNumber: 1,
    });
    harness.seed('shipment_audit_events', [storedAuditEvent(outcome)]);
    await expect(repository.findUnresolvedAuditOperation(query)).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
  });

  test('validates external intent target/version/event coupling before any OUTBOX lookup', async () => {
    const { harness, repository } = await initializeRepository();
    const accepted = await acceptFor(harness, repository, 'intent-invalid');
    replaceJob(harness, accepted.accepted.jobId, readyJobPatch({ version: 1 }));
    const started = lockOperationAudit({
      shipmentId: accepted.shipmentId,
      jobId: accepted.accepted.jobId,
      expectedParentVersion: 0,
    });
    await expect(repository.beginExternalOperation({
      targetKind: 'JOB', targetId: accepted.accepted.jobId, expectedVersion: 0, event: started.event,
    })).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
    ));
    await expect(repository.beginExternalOperation({
      targetKind: 'OUTBOX', targetId: 1, expectedVersion: 0, event: started.event,
    })).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(harness.documents('shipment_audit_events').find(event => event.eventKey === started.eventKey))
      .toBeUndefined();
  });

  test('returns null when transition recovery has no matching outbox', async () => {
    const { harness, repository, clock } = await initializeRepository();
    const before = harness.trace.operations.length;

    await expect(repository.findUnresolvedAuditOperation({
      companyId: 'company-1', jobId: 1, stage: 'FYND_TRANSITION',
    })).resolves.toBeNull();
    expect(clock.calls()).toBe(1);
    expect(harness.trace.operations.length).toBeGreaterThan(before);
  });

  test('rejects a maximum safe expected version before clock, transaction, or increment work', async () => {
    const { harness, repository, clock } = await initializeRepository();
    const started = lockOperationAudit({
      expectedParentVersion: Number.MAX_SAFE_INTEGER,
    });
    const before = harness.trace.operations.length;

    await expect(repository.beginExternalOperation({
      targetKind: 'JOB', targetId: 1, expectedVersion: Number.MAX_SAFE_INTEGER,
      event: started.event,
    })).rejects.toEqual(
      safeErrorExpectation('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid'),
    );
    expect(clock.calls()).toBe(0);
    expect(harness.trace.operations).toHaveLength(before);
  });

  test('rejects safe FYND lock readback as a second durable external-operation intent', async () => {
    const { harness, repository } = await initializeRepository();
    const accepted = await acceptFor(harness, repository, 'readback-intent');
    replaceJob(harness, accepted.accepted.jobId, { state: JOB_STATES.LOCK_PENDING, version: 2 });
    const readback = lockReadbackAudit({
      shipmentId: accepted.shipmentId,
      jobId: accepted.accepted.jobId,
      expectedParentVersion: 2,
    });
    const before = harness.trace.operations.length;

    await expect(repository.beginExternalOperation({
      targetKind: 'JOB',
      targetId: accepted.accepted.jobId,
      expectedVersion: 2,
      event: readback.event,
    })).rejects.toEqual(safeErrorExpectation(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(harness.trace.operations).toHaveLength(before);
    expect(findLongDocument(
      harness.documents('invoice_jobs'), 'jobId', accepted.accepted.jobId,
    ).pendingOperation).toBeNull();
    expect(harness.documents('shipment_audit_events').find(
      event => event.eventKey === readback.eventKey,
    )).toBeUndefined();
  });
});
