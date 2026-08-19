'use strict';

const { createHash } = require('crypto');
const { Long } = require('mongodb');

const {
  createAuditBundle,
  createAuditEvent,
  createEventKey,
  createOperationKey,
  sanitizeFyndSummary,
  sanitizeOeisSummary,
} = require('../../src/einvoice/audit/audit-contract');
const {
  JOB_STATES,
  OUTBOX_ACTIONS,
  OUTBOX_STATUSES,
} = require('../../src/einvoice/repositories/invoice-repository');
const {
  MONGO_TRANSACTION_TIMEOUT_MS,
  createMongoInvoiceRepository,
} = require('../../src/einvoice/repositories/mongo-invoice-repository');
const { createMongoRepositoryHarness } = require('../utils/mongo-repository-harness');

const NOW = new Date('2026-08-17T10:00:00.000Z');
const RECEIVED_AT = '2026-08-17T09:59:00.000Z';
const JOB_LEASE = '2026-08-17T10:05:00.000Z';
const OUTBOX_LEASE = '2026-08-17T10:06:00.000Z';
const XML = '<signed>secret Riyadh</signed>';
const XML_BASE64 = Buffer.from(XML, 'utf8').toString('base64');
const XML_SHA256 = createHash('sha256').update(Buffer.from(XML, 'utf8')).digest('hex');
const AUDIT_INPUT_FIELDS = Object.freeze([
  'eventKey', 'operationKey', 'companyId', 'applicationId', 'shipmentId', 'jobId',
  'documentNumber', 'stage', 'action', 'outcome', 'attemptNumber', 'startedAt',
  'completedAt', 'queueDelayMs', 'retryDelayMs', 'safeCode', 'requestSummary',
  'responseSummary', 'artifactJobId',
]);

function safeError(code, message, retryable = false) {
  return expect.objectContaining({ name: 'EinvoiceError', code, message, retryable });
}

function auditInput(event, overrides = {}) {
  return {
    ...Object.fromEntries(AUDIT_INPUT_FIELDS.map(field => [field, event[field]])),
    startedAt: event.startedAt === null ? null : new Date(event.startedAt),
    completedAt: event.completedAt === null ? null : new Date(event.completedAt),
    ...overrides,
  };
}

function eventRecord(suffix = '1') {
  return {
    eventId: `event-${suffix}`,
    companyId: 'company-1',
    applicationId: 'application-1',
    shipmentId: `shipment-${suffix}`,
    eventType: 'application/shipment/update/v1',
    status: 'bag_confirmed',
    receivedAt: RECEIVED_AT,
  };
}

function normalizedShipment(suffix = '1') {
  return {
    shipmentId: `shipment-${suffix}`,
    confirmedAt: '2026-08-17T09:58:00.000Z',
    branchCode: 'store-1',
    currency: 'SAR',
    paymentMode: 'CARD',
    amountPaid: '115.00',
    policyVersion: '2026-08-17',
    taxEligibility: {
      governmentBorneVatEligible: false,
      reasonCode: null,
      evidenceReference: `event-${suffix}`,
      verifiedAt: '2026-08-17T09:58:00.000Z',
      buyerName: null,
      buyerNationalId: null,
    },
    bags: [{
      bagId: `bag-${suffix}`,
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
  };
}

function createFixture({ harness = createMongoRepositoryHarness(), now = NOW } = {}) {
  let currentNow = new Date(now);
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
      reset() { clockCalls = 0; },
      set(value) { currentNow = new Date(value); },
    },
  };
}

async function readyFixture(options = {}) {
  const fixture = createFixture(options);
  await fixture.repository.initialize();
  fixture.clock.reset();
  return fixture;
}

function findLong(harness, collection, field, id) {
  const encoded = Long.fromNumber(id);
  return harness.documents(collection).find(
    row => Long.isLong(row[field]) && row[field].equals(encoded),
  );
}

function replaceLong(harness, collection, field, id, patch) {
  const encoded = Long.fromNumber(id);
  harness.replaceDocuments(collection, harness.documents(collection).map(row => (
    Long.isLong(row[field]) && row[field].equals(encoded) ? { ...row, ...patch } : row
  )));
}

function acceptedArtifact(job, overrides = {}) {
  return {
    invoiceNumber: job.documentNumber,
    transactionNumber: 'transaction-1',
    uuid: '123e4567-e89b-12d3-a456-426614174000',
    invoiceCounter: '1',
    matchingKey: 'matching-key-1',
    responseStatus: 'OEIS_ACCEPTED_REPORTING_PENDING',
    signedXmlBase64: XML_BASE64,
    signedXml: XML,
    signedXmlSha256: XML_SHA256,
    qrCodeData: 'qr-data-1',
    ...overrides,
  };
}

async function makeLocked(fixture, suffix = '1') {
  const accepted = await fixture.repository.acceptWebhook(
    eventRecord(suffix), normalizedShipment(suffix), false,
  );
  const claimed = await fixture.repository.claimNextJob('job-worker', JOB_LEASE);
  const requestJson = `[{"TRAN_DOC_NO":"VR-shipment-${suffix}-1"}]`;
  const requestHash = createHash('sha256').update(requestJson, 'utf8').digest('hex');
  const prepared = await fixture.repository.savePreparedRequest(
    accepted.jobId, requestJson, requestHash, claimed.version,
  );
  return fixture.repository.markShipmentLocked(prepared.id, prepared.version);
}

async function makeHeld(fixture, suffix = 'held') {
  const accepted = await fixture.repository.acceptWebhook(
    eventRecord(suffix), normalizedShipment(suffix), true,
  );
  const claimed = await fixture.repository.claimNextJob('job-worker', JOB_LEASE);
  const requestJson = JSON.stringify([{
    TRAN_DOC_NO: `VR-shipment-${suffix}-1`, TRAN_LINE_NO: 1,
    INV_TOTAL_AMOUNT: '115.00', INV_CUSTOMER_PAID_AMOUNT: '115.00',
    INV_CUSTOMER_AMOUNT_DUE: '0.00',
  }]);
  const requestHash = createHash('sha256').update(requestJson).digest('hex');
  const prepared = await fixture.repository.savePreparedRequest(
    accepted.jobId, requestJson, requestHash, claimed.version,
  );
  const held = await fixture.repository.markShipmentLocked(prepared.id, prepared.version);
  return { held, requestJson, requestHash };
}

test('atomically imports one bounded real response for an exact held job and enqueues Fynd', async () => {
  const fixture = await readyFixture();
  const { held, requestJson, requestHash } = await makeHeld(fixture);
  const rows = JSON.parse(requestJson);
  rows[0].INV_CUSTOMER_PAID_AMOUNT = '0.00';
  rows[0].INV_CUSTOMER_AMOUNT_DUE = rows[0].INV_TOTAL_AMOUNT;
  const correctedRequestJson = JSON.stringify(rows);
  const correctedRequestHash = createHash('sha256').update(correctedRequestJson).digest('hex');
  const responseJson = JSON.stringify({ private: 'complete response', signed: true });
  const responseSha256 = createHash('sha256').update(responseJson).digest('hex');
  const artifact = acceptedArtifact(held);

  const result = await fixture.repository.importHeldOeisResponseAndEnqueue({
    companyId: held.companyId,
    shipmentId: held.shipmentId,
    jobId: held.id,
    expectedVersion: held.version,
    previousRequestHash: requestHash,
    correctedRequestJson,
    correctedRequestHash,
    artifact,
    responseEvidence: {
      attemptNumber: held.attemptCount,
      httpStatus: 200,
      responseJson,
      responseByteCount: Buffer.byteLength(responseJson),
      responseSha256,
      oeisInvoiceNumber: 'OEIS-INVOICE-1',
    },
  });

  expect(result.job).toEqual(expect.objectContaining({
    state: JOB_STATES.FYND_TRANSITION_PENDING,
    requestHash: correctedRequestHash,
    oeisRequestJson: correctedRequestJson,
    version: held.version + 1,
  }));
  expect(result.outbox).toEqual(expect.objectContaining({ status: OUTBOX_STATUSES.PENDING }));
  expect(result.outbox.payload).toEqual({
    shipmentId: held.shipmentId,
    documentNumber: held.documentNumber,
    oeisInvoiceNumber: 'OEIS-INVOICE-1',
  });
  expect(fixture.harness.documents('invoice_artifacts')).toHaveLength(1);
  expect(fixture.harness.documents('oeis_response_attempts')).toEqual([
    expect.objectContaining({
      responseJson, responseSha256, responseByteCount: Buffer.byteLength(responseJson),
      httpStatus: 200, outcome: 'SUCCESS', oeisInvoiceNumber: 'OEIS-INVOICE-1',
      responseIdentity: 'SUCCESS:OEIS-INVOICE-1',
    }),
  ]);
});

async function enqueue(fixture, suffix = '1', auditEvents = []) {
  const locked = await makeLocked(fixture, suffix);
  const suffixHash = createHash('sha256').update(String(suffix)).digest('hex');
  const artifact = acceptedArtifact(locked, {
    transactionNumber: `transaction-${suffix}`,
    uuid: `${suffixHash.slice(0, 8)}-${suffixHash.slice(8, 12)}-${suffixHash.slice(12, 16)}-${suffixHash.slice(16, 20)}-${suffixHash.slice(20, 32)}`,
  });
  const result = await fixture.repository.markOeisAcceptedAndEnqueue(
    locked.id,
    artifact,
    {
      shipmentId: locked.shipmentId,
      documentNumber: locked.documentNumber,
      ignoredSecret: artifact.signedXmlBase64,
    },
    locked.version,
    auditEvents,
  );
  return { locked, artifact, ...result };
}

function transitionStarted(job, outbox, occurredAt = NOW) {
  const operationKey = createOperationKey({
    targetKind: 'OUTBOX',
    targetId: String(outbox.id),
    expectedParentVersion: outbox.version,
    attemptNumber: outbox.attemptCount,
    stage: 'FYND_TRANSITION',
    action: 'FYND_TRANSITION_REQUESTED',
  });
  const event = createAuditEvent({
    eventKey: createEventKey({
      kind: 'OPERATION', operationKey, stage: 'FYND_TRANSITION',
      action: 'FYND_TRANSITION_REQUESTED', outcome: 'STARTED',
    }),
    operationKey,
    companyId: job.companyId,
    applicationId: job.applicationId,
    shipmentId: job.shipmentId,
    jobId: job.id,
    documentNumber: job.documentNumber,
    stage: 'FYND_TRANSITION',
    action: 'FYND_TRANSITION_REQUESTED',
    outcome: 'STARTED',
    attemptNumber: outbox.attemptCount,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: sanitizeFyndSummary('REQUEST', {
      operation: 'TRANSITION',
      shipmentId: job.shipmentId,
      documentNumber: job.documentNumber,
      requestedLock: null,
      requestedStatus: 'bag_invoiced',
    }),
    responseSummary: null,
    artifactJobId: job.id,
  }, { now: () => new Date(occurredAt) });
  return { operationKey, event };
}

function transitionOutcome(job, outbox, started, {
  action = 'FYND_TRANSITION_CONFIRMED',
  outcome = 'SUCCESS',
  safeCode = null,
  retryable = false,
  finalStateClassification = 'INVOICED',
  completedAt = '2026-08-17T10:00:00.025Z',
  summaryShipmentId = job.shipmentId,
  summaryDocumentNumber = job.documentNumber,
  locked = null,
  responseStatus = null,
  shipmentState = finalStateClassification === 'INVOICED' ? 'bag_invoiced' : null,
  artifactJobId = job.id,
} = {}) {
  return createAuditEvent({
    eventKey: createEventKey({
      kind: 'OPERATION', operationKey: started.operationKey,
      stage: 'FYND_TRANSITION', action, outcome,
    }),
    operationKey: started.operationKey,
    companyId: job.companyId,
    applicationId: job.applicationId,
    shipmentId: job.shipmentId,
    jobId: job.id,
    documentNumber: job.documentNumber,
    stage: 'FYND_TRANSITION',
    action,
    outcome,
    attemptNumber: outbox.attemptCount,
    startedAt: new Date(started.event.startedAt),
    completedAt: new Date(completedAt),
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode,
    requestSummary: null,
    responseSummary: sanitizeFyndSummary('RESPONSE', {
      operation: 'TRANSITION',
      shipmentId: summaryShipmentId,
      documentNumber: summaryDocumentNumber,
      responseStatus,
      locked,
      shipmentState,
      finalStateClassification,
      retryable,
      latencyMs: Date.parse(completedAt) - Date.parse(started.event.startedAt),
    }),
    artifactJobId,
  }, { now: () => new Date(completedAt) });
}

function transitionReadbackPair(job, outbox, expectedVersion, {
  locked = false,
  shipmentState = 'bag_invoiced',
  finalStateClassification = 'INVOICED',
  retryable = false,
  responseStatus = null,
  startedSafeCode = null,
  terminalOutcome = 'SUCCESS',
  terminalSafeCode = null,
} = {}) {
  const operationKey = createOperationKey({
    targetKind: 'OUTBOX',
    targetId: String(outbox.id),
    expectedParentVersion: expectedVersion,
    attemptNumber: outbox.attemptCount,
    stage: 'FYND_TRANSITION',
    action: 'FYND_TRANSITION_READBACK',
  });
  const startedAt = new Date('2026-08-17T10:00:00.030Z');
  const completedAt = new Date('2026-08-17T10:00:00.040Z');
  const common = {
    operationKey,
    companyId: job.companyId,
    applicationId: job.applicationId,
    shipmentId: job.shipmentId,
    jobId: job.id,
    documentNumber: job.documentNumber,
    stage: 'FYND_TRANSITION',
    action: 'FYND_TRANSITION_READBACK',
    attemptNumber: outbox.attemptCount,
    queueDelayMs: null,
    retryDelayMs: null,
    artifactJobId: job.id,
  };
  return [
    createAuditEvent({
      ...common,
      eventKey: createEventKey({
        kind: 'OPERATION', operationKey, stage: 'FYND_TRANSITION',
        action: 'FYND_TRANSITION_READBACK', outcome: 'STARTED',
      }),
      outcome: 'STARTED',
      startedAt: null,
      completedAt: null,
      safeCode: startedSafeCode,
      requestSummary: sanitizeFyndSummary('REQUEST', {
        operation: 'TRANSITION_READBACK',
        shipmentId: job.shipmentId,
        documentNumber: job.documentNumber,
        requestedLock: null,
        requestedStatus: null,
      }),
      responseSummary: null,
    }, { now: () => startedAt }),
    createAuditEvent({
      ...common,
      eventKey: createEventKey({
        kind: 'OPERATION', operationKey, stage: 'FYND_TRANSITION',
        action: 'FYND_TRANSITION_READBACK', outcome: terminalOutcome,
      }),
      outcome: terminalOutcome,
      startedAt,
      completedAt,
      safeCode: terminalSafeCode,
      requestSummary: null,
      responseSummary: sanitizeFyndSummary('RESPONSE', {
        operation: 'TRANSITION_READBACK',
        shipmentId: job.shipmentId,
        documentNumber: job.documentNumber,
        responseStatus,
        locked,
        shipmentState,
        finalStateClassification,
        retryable,
        latencyMs: completedAt.getTime() - startedAt.getTime(),
      }),
    }, { now: () => completedAt }),
  ];
}

function outboxMutationEvent(job, outbox, expectedVersion, {
  stage,
  action,
  outcome,
  safeCode = null,
  retryDelayMs = null,
  occurredAt = '2026-08-17T10:00:00.026Z',
}) {
  return createAuditEvent({
    eventKey: createEventKey({
      kind: 'ENTITY',
      companyId: job.companyId,
      shipmentId: job.shipmentId,
      scopeKind: 'OUTBOX',
      scopeId: String(outbox.id),
      parentVersion: expectedVersion,
      attemptNumber: outbox.attemptCount,
      stage,
      action,
      outcome,
    }),
    operationKey: null,
    companyId: job.companyId,
    applicationId: job.applicationId,
    shipmentId: job.shipmentId,
    jobId: job.id,
    documentNumber: job.documentNumber,
    stage,
    action,
    outcome,
    attemptNumber: outbox.attemptCount,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs,
    safeCode,
    requestSummary: null,
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(occurredAt) });
}

function claimCompanionEvent(job) {
  return createAuditEvent({
    eventKey: createEventKey({
      kind: 'ENTITY',
      companyId: job.companyId,
      shipmentId: job.shipmentId,
      scopeKind: 'JOB',
      scopeId: String(job.id),
      parentVersion: job.version,
      attemptNumber: job.attemptCount,
      stage: 'VALIDATION',
      action: 'VALIDATION_PASSED',
      outcome: 'SUCCESS',
    }),
    operationKey: null,
    companyId: job.companyId,
    applicationId: job.applicationId,
    shipmentId: job.shipmentId,
    jobId: job.id,
    documentNumber: job.documentNumber,
    stage: 'VALIDATION',
    action: 'VALIDATION_PASSED',
    outcome: 'SUCCESS',
    attemptNumber: job.attemptCount,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: null,
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date('2026-08-17T09:59:59.000Z') });
}

function oeisStarted(job) {
  const operationKey = createOperationKey({
    targetKind: 'JOB',
    targetId: String(job.id),
    expectedParentVersion: job.version,
    attemptNumber: job.attemptCount,
    stage: 'OEIS_SUBMISSION',
    action: 'OEIS_SUBMISSION_REQUESTED',
  });
  const event = createAuditEvent({
    eventKey: createEventKey({
      kind: 'OPERATION', operationKey, stage: 'OEIS_SUBMISSION',
      action: 'OEIS_SUBMISSION_REQUESTED', outcome: 'STARTED',
    }),
    operationKey,
    companyId: job.companyId,
    applicationId: job.applicationId,
    shipmentId: job.shipmentId,
    jobId: job.id,
    documentNumber: job.documentNumber,
    stage: 'OEIS_SUBMISSION',
    action: 'OEIS_SUBMISSION_REQUESTED',
    outcome: 'STARTED',
    attemptNumber: job.attemptCount,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: sanitizeOeisSummary('REQUEST', {
      documentNumber: job.documentNumber,
      documentType: 'IN',
      lineCount: 1,
      currency: 'SAR',
      netAmount: '100.00',
      taxAmount: '15.00',
      totalAmount: '115.00',
      taxSummaries: [{ category: 'S', rate: '15.00', reasonCode: null, lineCount: 1 }],
      requestByteCount: Buffer.byteLength(job.oeisRequestJson, 'utf8'),
      requestSha256: job.requestHash,
      endpointPath: '/API/V2/Transaction/UpdateInvoiceData',
      attemptNumber: job.attemptCount,
      timeoutMs: 15_000,
    }),
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(NOW) });
  return { operationKey, event };
}

function oeisAcceptedBundle(job, accepted, started, {
  responseSummary = {},
  responseCompletedAt = '2026-08-17T10:00:00.025Z',
  responseOccurredAt = responseCompletedAt,
  responseSafeCode = null,
  responseArtifactJobId = null,
  artifactSafeCode = null,
} = {}) {
  const completedAt = new Date(responseCompletedAt);
  const response = createAuditEvent({
    eventKey: createEventKey({
      kind: 'OPERATION', operationKey: started.operationKey, stage: 'OEIS_SUBMISSION',
      action: 'OEIS_RESPONSE_RECEIVED', outcome: 'SUCCESS',
    }),
    operationKey: started.operationKey,
    companyId: job.companyId,
    applicationId: job.applicationId,
    shipmentId: job.shipmentId,
    jobId: job.id,
    documentNumber: job.documentNumber,
    stage: 'OEIS_SUBMISSION',
    action: 'OEIS_RESPONSE_RECEIVED',
    outcome: 'SUCCESS',
    attemptNumber: job.attemptCount,
    startedAt: new Date(started.event.startedAt),
    completedAt,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: responseSafeCode,
    requestSummary: null,
    responseSummary: sanitizeOeisSummary('RESPONSE', {
      httpStatus: 200,
      isSystemException: false,
      validationResult: 'VALID',
      reportingStatus: 'PENDING',
      clearanceStatus: null,
      invoiceNumber: accepted.invoiceNumber,
      transactionNumber: accepted.transactionNumber,
      uuid: accepted.uuid,
      invoiceCounter: accepted.invoiceCounter,
      matchingKey: accepted.matchingKey,
      validationCodes: [],
      responseByteCount: null,
      responseSha256: null,
      retryable: false,
      latencyMs: completedAt.getTime() - Date.parse(started.event.startedAt),
      ...responseSummary,
    }),
    artifactJobId: responseArtifactJobId,
  }, { now: () => new Date(responseOccurredAt) });
  const artifactOccurredAt = new Date('2026-08-17T10:00:00.026Z');
  const artifactEvent = createAuditEvent({
    eventKey: createEventKey({
      kind: 'ENTITY', companyId: job.companyId, shipmentId: job.shipmentId,
      scopeKind: 'JOB', scopeId: String(job.id), parentVersion: job.version,
      attemptNumber: job.attemptCount, stage: 'OEIS_ARTIFACT',
      action: 'OEIS_ARTIFACT_STORED', outcome: 'SUCCESS',
    }),
    operationKey: null,
    companyId: job.companyId,
    applicationId: job.applicationId,
    shipmentId: job.shipmentId,
    jobId: job.id,
    documentNumber: job.documentNumber,
    stage: 'OEIS_ARTIFACT',
    action: 'OEIS_ARTIFACT_STORED',
    outcome: 'SUCCESS',
    attemptNumber: job.attemptCount,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: artifactSafeCode,
    requestSummary: null,
    responseSummary: sanitizeOeisSummary('ARTIFACT', {
      signedXmlPresent: true,
      signedXmlByteCount: Buffer.byteLength(XML, 'utf8'),
      signedXmlSha256: XML_SHA256,
      qrPresent: accepted.qrCodeData !== null,
      qrByteCount: accepted.qrCodeData === null
        ? null : Buffer.byteLength(accepted.qrCodeData, 'utf8'),
      qrSha256: accepted.qrCodeData === null
        ? null : createHash('sha256').update(accepted.qrCodeData, 'utf8').digest('hex'),
    }),
    artifactJobId: job.id,
  }, { now: () => artifactOccurredAt });
  return [response, artifactEvent];
}

async function claimOutbox(fixture, worker = 'outbox-worker') {
  return fixture.repository.claimNextOutbox(worker, OUTBOX_LEASE);
}

async function beginTransition(fixture, claimed) {
  const job = await fixture.repository.getJob(claimed.jobId);
  const started = transitionStarted(job, claimed);
  const recovery = await fixture.repository.beginExternalOperation({
    targetKind: 'OUTBOX',
    targetId: claimed.id,
    expectedVersion: claimed.version,
    event: started.event,
  });
  return { job, started, recovery };
}

function mutationState(harness) {
  return Object.fromEntries([
    'counters', 'invoice_jobs', 'invoice_artifacts', 'invoice_outbox',
    'shipment_audit_events', 'shipment_audit_heads',
  ].map(name => [name, harness.documents(name)]));
}

describe('Mongo OEIS artifact and outbox enqueue contract', () => {
  test('atomically stores exact BSON/public artifact, lightweight outbox, parent cache, and counter', async () => {
    const fixture = await readyFixture();
    const { locked, artifact, job, outbox } = await enqueue(fixture);

    expect(job).toEqual(expect.objectContaining({
      id: locked.id,
      state: JOB_STATES.FYND_TRANSITION_PENDING,
      version: locked.version + 1,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    }));
    expect(outbox).toEqual({
      id: 1,
      jobId: locked.id,
      action: OUTBOX_ACTIONS.FYND_TRANSITION,
      payloadJson: `{"shipmentId":"${locked.shipmentId}","documentNumber":"${locked.documentNumber}","oeisInvoiceNumber":"${locked.documentNumber}"}`,
      payload: {
        shipmentId: locked.shipmentId,
        documentNumber: locked.documentNumber,
        oeisInvoiceNumber: locked.documentNumber,
      },
      status: OUTBOX_STATUSES.PENDING,
      attemptCount: 0,
      nextAttemptAt: NOW.toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      version: 0,
      createdAt: NOW.toISOString(),
      completedAt: null,
    });
    expect(Object.isFrozen(outbox)).toBe(true);
    expect(Object.isFrozen(outbox.payload)).toBe(true);
    expect(outbox).not.toHaveProperty('parentState');
    expect(outbox).not.toHaveProperty('parentVersion');
    expect(outbox).not.toHaveProperty('pendingOperation');

    const rawArtifact = findLong(fixture.harness, 'invoice_artifacts', 'jobId', locked.id);
    expect(rawArtifact).toEqual(expect.objectContaining({
      jobId: Long.fromNumber(locked.id),
      invoiceNumber: locked.documentNumber,
      transactionNumber: artifact.transactionNumber,
      uuid: artifact.uuid,
      invoiceCounter: artifact.invoiceCounter,
      matchingKey: artifact.matchingKey,
      responseStatus: 'OEIS_ACCEPTED_REPORTING_PENDING',
      signedXmlBase64: XML_BASE64,
      signedXmlSha256: XML_SHA256,
      qrCodeData: artifact.qrCodeData,
      createdAt: new Date(NOW),
    }));
    expect(rawArtifact).not.toHaveProperty('signedXml');
    const rawOutbox = findLong(fixture.harness, 'invoice_outbox', 'outboxId', outbox.id);
    expect(rawOutbox).toEqual(expect.objectContaining({
      outboxId: Long.ONE,
      jobId: Long.fromNumber(locked.id),
      parentState: JOB_STATES.FYND_TRANSITION_PENDING,
      parentVersion: job.version,
      dueAt: new Date(NOW),
      nextAttemptAt: new Date(NOW),
      pendingOperation: null,
    }));
    expect(fixture.harness.documents('counters').find(row => row._id === 'invoice_outbox').value)
      .toEqual(Long.ONE);

    const stored = await fixture.repository.getArtifact(locked.id);
    expect(stored).toEqual({
      jobId: locked.id,
      invoiceNumber: artifact.invoiceNumber,
      transactionNumber: artifact.transactionNumber,
      uuid: artifact.uuid,
      invoiceCounter: artifact.invoiceCounter,
      matchingKey: artifact.matchingKey,
      responseStatus: artifact.responseStatus,
      signedXmlBase64: artifact.signedXmlBase64,
      signedXmlSha256: artifact.signedXmlSha256,
      qrCodeData: artifact.qrCodeData,
      createdAt: NOW.toISOString(),
    });
    expect(Object.isFrozen(stored)).toBe(true);
  });

  test('atomically resolves OEIS intent with exact response/artifact events and final audit head', async () => {
    const fixture = await readyFixture();
    const locked = await makeLocked(fixture, 'oeis-audit');
    const started = oeisStarted(locked);
    const recovery = await fixture.repository.beginExternalOperation({
      targetKind: 'JOB',
      targetId: locked.id,
      expectedVersion: locked.version,
      event: started.event,
    });
    const current = await fixture.repository.getJob(locked.id);
    const accepted = acceptedArtifact(current);
    const bundle = oeisAcceptedBundle(current, accepted, started);

    const result = await fixture.repository.markOeisAcceptedAndEnqueue(
      current.id,
      accepted,
      { shipmentId: current.shipmentId, documentNumber: current.documentNumber },
      recovery.targetVersion,
      bundle,
    );

    expect(result.job.state).toBe(JOB_STATES.FYND_TRANSITION_PENDING);
    expect(findLong(fixture.harness, 'invoice_jobs', 'jobId', current.id).pendingOperation)
      .toBeNull();
    expect(fixture.harness.documents('shipment_audit_events').filter(event => (
      bundle.some(candidate => candidate.eventKey === event.eventKey)
    ))).toHaveLength(2);
    expect(fixture.harness.documents('shipment_audit_heads')).toContainEqual(
      expect.objectContaining({
        companyId: current.companyId,
        shipmentId: current.shipmentId,
        lastAction: 'OEIS_ARTIFACT_STORED',
        lastEventKey: bundle[1].eventKey,
      }),
    );
  });

  test('accepts an OEIS response/artifact bundle built from one occurrence clock', async () => {
    const fixture = await readyFixture();
    const locked = await makeLocked(fixture, 'oeis-one-clock');
    const started = oeisStarted(locked);
    const recovery = await fixture.repository.beginExternalOperation({
      targetKind: 'JOB', targetId: locked.id, expectedVersion: locked.version,
      event: started.event,
    });
    const current = await fixture.repository.getJob(locked.id);
    const accepted = acceptedArtifact(current);
    const prepared = oeisAcceptedBundle(current, accepted, started);
    const bundleAt = new Date('2026-08-17T10:00:00.025Z');
    const bundle = createAuditBundle([
      auditInput(prepared[0]),
      auditInput(prepared[1], { startedAt: null, completedAt: null }),
    ], { now: () => bundleAt });

    await expect(fixture.repository.markOeisAcceptedAndEnqueue(
      current.id,
      accepted,
      { shipmentId: current.shipmentId, documentNumber: current.documentNumber },
      recovery.targetVersion,
      bundle,
    )).resolves.toEqual(expect.objectContaining({
      outbox: expect.objectContaining({ status: OUTBOX_STATUSES.PENDING }),
    }));
    const expectedHead = [...bundle].sort((left, right) => (
      left.eventKey < right.eventKey ? -1 : left.eventKey > right.eventKey ? 1 : 0
    )).at(-1);
    expect(fixture.harness.documents('shipment_audit_heads')).toContainEqual(
      expect.objectContaining({
        lastEventKey: expectedHead.eventKey,
        lastAction: expectedHead.action,
      }),
    );
  });

  test.each(['audit', 'head'])(
    'rolls back counter, artifact, outbox, parent, and evidence on enqueue %s failure',
    async failure => {
      const fixture = await readyFixture();
      const locked = await makeLocked(fixture, `oeis-${failure}-rollback`);
      const started = oeisStarted(locked);
      const recovery = await fixture.repository.beginExternalOperation({
        targetKind: 'JOB', targetId: locked.id, expectedVersion: locked.version,
        event: started.event,
      });
      const current = await fixture.repository.getJob(locked.id);
      const accepted = acceptedArtifact(current);
      const bundle = oeisAcceptedBundle(current, accepted, started);
      if (failure === 'audit') {
        fixture.harness.returnNext('shipment_audit_events', 'insertOne', {
          acknowledged: false, insertedId: null,
        });
      } else {
        fixture.harness.returnNext('shipment_audit_heads', 'updateOne', {
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
          upsertedCount: 0,
          upsertedId: null,
        });
      }
      const before = mutationState(fixture.harness);

      await expect(fixture.repository.markOeisAcceptedAndEnqueue(
        current.id,
        accepted,
        { shipmentId: current.shipmentId, documentNumber: current.documentNumber },
        recovery.targetVersion,
        bundle,
      )).rejects.toEqual(safeError(
        'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
      ));
      expect(mutationState(fixture.harness)).toEqual(before);
    },
  );

  test('rejects a reversed OEIS accepted/artifact bundle before any enqueue mutation', async () => {
    const fixture = await readyFixture();
    const locked = await makeLocked(fixture, 'oeis-reversed-bundle');
    const started = oeisStarted(locked);
    const recovery = await fixture.repository.beginExternalOperation({
      targetKind: 'JOB', targetId: locked.id, expectedVersion: locked.version,
      event: started.event,
    });
    const current = await fixture.repository.getJob(locked.id);
    const accepted = acceptedArtifact(current);
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.markOeisAcceptedAndEnqueue(
      current.id,
      accepted,
      { shipmentId: current.shipmentId, documentNumber: current.documentNumber },
      recovery.targetVersion,
      oeisAcceptedBundle(current, accepted, started).reverse(),
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('rejects artifact-only enqueue evidence when no OEIS intent is pending', async () => {
    const fixture = await readyFixture();
    const locked = await makeLocked(fixture, 'artifact-only-evidence');
    const accepted = acceptedArtifact(locked);
    const artifactEvent = oeisAcceptedBundle(
      locked, accepted, oeisStarted(locked),
    )[1];
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.markOeisAcceptedAndEnqueue(
      locked.id,
      accepted,
      { shipmentId: locked.shipmentId, documentNumber: locked.documentNumber },
      locked.version,
      [artifactEvent],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test.each([
    ['non-success HTTP status', { httpStatus: 500 }],
    ['system exception', { isSystemException: true }],
    ['clearance result', { clearanceStatus: 'CLEARED' }],
    ['validation errors', { validationCodes: ['OEIS_REJECTED'] }],
    ['retained raw response', { responseByteCount: 4, responseSha256: '0'.repeat(64) }],
  ])('rejects accepted OEIS evidence with %s before artifact/outbox mutation', async (
    _label,
    responseSummary,
  ) => {
    const fixture = await readyFixture();
    const locked = await makeLocked(fixture, `oeis-semantic-${_label}`);
    const started = oeisStarted(locked);
    const recovery = await fixture.repository.beginExternalOperation({
      targetKind: 'JOB', targetId: locked.id, expectedVersion: locked.version,
      event: started.event,
    });
    const current = await fixture.repository.getJob(locked.id);
    const accepted = acceptedArtifact(current);
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.markOeisAcceptedAndEnqueue(
      current.id,
      accepted,
      { shipmentId: current.shipmentId, documentNumber: current.documentNumber },
      recovery.targetVersion,
      oeisAcceptedBundle(current, accepted, started, { responseSummary }),
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test.each([
    ['response success code', { responseSafeCode: 'UNEXPECTED_SUCCESS' }],
    ['response artifact identity', { responseArtifactJobId: 'current' }],
    ['artifact success code', { artifactSafeCode: 'UNEXPECTED_SUCCESS' }],
  ])('rejects accepted OEIS evidence with contradictory %s nullable fields', async (
    _label,
    bundleOptions,
  ) => {
    const fixture = await readyFixture();
    const locked = await makeLocked(
      fixture, `oeis-nullable-${_label.replaceAll(' ', '-')}`,
    );
    const started = oeisStarted(locked);
    const recovery = await fixture.repository.beginExternalOperation({
      targetKind: 'JOB', targetId: locked.id, expectedVersion: locked.version,
      event: started.event,
    });
    const current = await fixture.repository.getJob(locked.id);
    const accepted = acceptedArtifact(current);
    const options = bundleOptions.responseArtifactJobId === 'current'
      ? { ...bundleOptions, responseArtifactJobId: current.id }
      : bundleOptions;
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.markOeisAcceptedAndEnqueue(
      current.id,
      accepted,
      { shipmentId: current.shipmentId, documentNumber: current.documentNumber },
      recovery.targetVersion,
      oeisAcceptedBundle(current, accepted, started, options),
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('rejects an OEIS response whose lifecycle completes after artifact storage', async () => {
    const fixture = await readyFixture();
    const locked = await makeLocked(fixture, 'oeis-late-completion');
    const started = oeisStarted(locked);
    const recovery = await fixture.repository.beginExternalOperation({
      targetKind: 'JOB', targetId: locked.id, expectedVersion: locked.version,
      event: started.event,
    });
    const current = await fixture.repository.getJob(locked.id);
    const accepted = acceptedArtifact(current);
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.markOeisAcceptedAndEnqueue(
      current.id,
      accepted,
      { shipmentId: current.shipmentId, documentNumber: current.documentNumber },
      recovery.targetVersion,
      oeisAcceptedBundle(current, accepted, started, {
        responseCompletedAt: '2026-08-17T10:00:00.027Z',
        responseOccurredAt: '2026-08-17T10:00:00.025Z',
      }),
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test.each([
    [
      'noncanonical artifact UUID',
      { uuid: '123E4567-E89B-12D3-A456-426614174000' },
      { uuid: null },
    ],
    [
      'non-ASCII artifact transaction number',
      { transactionNumber: 'معاملة-1' },
      { transactionNumber: null },
    ],
  ])('accepts %s while retaining its safe null audit projection', async (
    _label,
    artifactOverrides,
    responseSummary,
  ) => {
    const fixture = await readyFixture();
    const locked = await makeLocked(fixture, `oeis-projection-${_label}`);
    const started = oeisStarted(locked);
    const recovery = await fixture.repository.beginExternalOperation({
      targetKind: 'JOB', targetId: locked.id, expectedVersion: locked.version,
      event: started.event,
    });
    const current = await fixture.repository.getJob(locked.id);
    const accepted = acceptedArtifact(current, artifactOverrides);

    await expect(fixture.repository.markOeisAcceptedAndEnqueue(
      current.id,
      accepted,
      { shipmentId: current.shipmentId, documentNumber: current.documentNumber },
      recovery.targetVersion,
      oeisAcceptedBundle(current, accepted, started, { responseSummary }),
    )).resolves.toEqual(expect.objectContaining({
      outbox: expect.objectContaining({ status: OUTBOX_STATUSES.PENDING }),
    }));
    expect(await fixture.repository.getArtifact(current.id)).toEqual(expect.objectContaining(
      artifactOverrides,
    ));
  });

  test.each([
    ['invoice identity', job => acceptedArtifact(job, { invoiceNumber: 'other' })],
    ['status', job => acceptedArtifact(job, { responseStatus: 'ACCEPTED' })],
    ['noncanonical Base64', job => acceptedArtifact(job, { signedXmlBase64: `${XML_BASE64}\n` })],
    ['decoded bytes', job => acceptedArtifact(job, { signedXml: `${XML}!` })],
    ['hash case', job => acceptedArtifact(job, { signedXmlSha256: XML_SHA256.toUpperCase() })],
    ['hash value', job => acceptedArtifact(job, { signedXmlSha256: '0'.repeat(64) })],
    ['blank QR', job => acceptedArtifact(job, { qrCodeData: ' ' })],
    ['proxy', job => new Proxy(acceptedArtifact(job), {})],
    ['accessor', job => {
      const value = acceptedArtifact(job);
      Object.defineProperty(value, 'signedXml', {
        enumerable: true,
        get() { throw new Error('private getter'); },
      });
      return value;
    }],
  ])('rejects invalid artifact %s without clock/session/allocation/mutation', async (_label, build) => {
    const fixture = await readyFixture();
    const locked = await makeLocked(fixture, `bad-${_label}`);
    fixture.clock.reset();
    const beforeCallbacks = fixture.harness.trace.transactionCallbacks;
    const before = mutationState(fixture.harness);
    await expect(fixture.repository.markOeisAcceptedAndEnqueue(
      locked.id,
      build(locked),
      { shipmentId: locked.shipmentId, documentNumber: locked.documentNumber },
      locked.version,
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID',
      'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
    expect(fixture.clock.calls()).toBe(0);
    expect(fixture.harness.trace.transactionCallbacks).toBe(beforeCallbacks);
  });

  test('rejects NUL/replacement/invalid UTF-8 and invalid reference identity', async () => {
    const builders = [
      job => {
        const xml = '<x>\u0000</x>';
        return acceptedArtifact(job, {
          signedXml: xml,
          signedXmlBase64: Buffer.from(xml).toString('base64'),
          signedXmlSha256: createHash('sha256').update(xml).digest('hex'),
        });
      },
      job => {
        const bytes = Buffer.from([0xc3, 0x28]);
        return acceptedArtifact(job, {
          signedXml: bytes.toString('utf8'),
          signedXmlBase64: bytes.toString('base64'),
          signedXmlSha256: createHash('sha256').update(bytes).digest('hex'),
        });
      },
    ];
    for (const [index, build] of builders.entries()) {
      const fixture = await readyFixture();
      const locked = await makeLocked(fixture, `utf-${index}`);
      const before = mutationState(fixture.harness);
      await expect(fixture.repository.markOeisAcceptedAndEnqueue(
        locked.id,
        build(locked),
        { shipmentId: locked.shipmentId, documentNumber: locked.documentNumber },
        locked.version,
      )).rejects.toEqual(expect.objectContaining({ code: 'REPOSITORY_INPUT_INVALID' }));
      expect(mutationState(fixture.harness)).toEqual(before);
    }
    const fixture = await readyFixture();
    const locked = await makeLocked(fixture, 'bad-reference');
    await expect(fixture.repository.markOeisAcceptedAndEnqueue(
      locked.id,
      acceptedArtifact(locked),
      { shipmentId: 'other', documentNumber: locked.documentNumber },
      locked.version,
    )).rejects.toEqual(expect.objectContaining({ code: 'REPOSITORY_INPUT_INVALID' }));
  });

  test('requires eligible parent version, valid prepared bytes, locked timestamp, and live complete lease', async () => {
    const cases = [
      { patch: {}, versionOffset: -1 },
      { patch: { leaseExpiresAt: new Date(NOW) } },
      { patch: { leaseOwner: null } },
      { patch: { oeisRequestJson: '{}' }, expectedCode: 'REPOSITORY_DATA_INVALID' },
      { patch: { state: JOB_STATES.RETRY_WAIT, lockedAt: null } },
    ];
    for (const [index, testCase] of cases.entries()) {
      const fixture = await readyFixture();
      const locked = await makeLocked(fixture, `guard-${index}`);
      replaceLong(fixture.harness, 'invoice_jobs', 'jobId', locked.id, testCase.patch);
      const before = mutationState(fixture.harness);
      await expect(fixture.repository.markOeisAcceptedAndEnqueue(
        locked.id,
        acceptedArtifact(locked),
        { shipmentId: locked.shipmentId, documentNumber: locked.documentNumber },
        locked.version + (testCase.versionOffset || 0),
      )).rejects.toEqual(expect.objectContaining({
        code: testCase.expectedCode || 'REPOSITORY_VERSION_CONFLICT',
      }));
      expect(mutationState(fixture.harness)).toEqual(before);
    }
  });

  test('rolls back enqueue when its valid-shaped parent post-image drifts', async () => {
    const fixture = await readyFixture();
    const locked = await makeLocked(fixture, 'enqueue-post-image');
    const raw = findLong(fixture.harness, 'invoice_jobs', 'jobId', locked.id);
    fixture.harness.returnNext('invoice_jobs', 'findOneAndUpdate', {
      ...raw,
      documentNumber: 'VR-driver-drift-1',
      state: JOB_STATES.FYND_TRANSITION_PENDING,
      dueAt: raw.createdAt,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      pendingOperation: null,
      version: locked.version + 1,
      updatedAt: new Date(NOW),
    });
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.markOeisAcceptedAndEnqueue(
      locked.id,
      acceptedArtifact(locked),
      { shipmentId: locked.shipmentId, documentNumber: locked.documentNumber },
      locked.version,
    )).rejects.toEqual(safeError(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('maps natural-key duplicates to fixed version conflict and rolls back counter/parent/audit', async () => {
    for (const target of ['artifact', 'outbox']) {
      const fixture = await readyFixture();
      const locked = await makeLocked(fixture, `duplicate-${target}`);
      if (target === 'artifact') {
        fixture.harness.seed('invoice_artifacts', [{
          jobId: Long.fromNumber(locked.id),
          invoiceNumber: locked.documentNumber,
          transactionNumber: 'existing',
          uuid: 'existing',
          invoiceCounter: '1',
          matchingKey: 'existing',
          responseStatus: 'OEIS_ACCEPTED_REPORTING_PENDING',
          signedXmlBase64: XML_BASE64,
          signedXmlSha256: XML_SHA256,
          qrCodeData: null,
          createdAt: new Date(NOW),
        }]);
      } else {
        fixture.harness.seed('invoice_outbox', [{
          outboxId: Long.fromNumber(99),
          jobId: Long.fromNumber(locked.id),
          action: OUTBOX_ACTIONS.FYND_TRANSITION,
          payloadJson: `{"shipmentId":"${locked.shipmentId}","documentNumber":"${locked.documentNumber}"}`,
          status: OUTBOX_STATUSES.PENDING,
          attemptCount: 0,
          dueAt: new Date(NOW),
          nextAttemptAt: new Date(NOW),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          version: 0,
          createdAt: new Date(NOW),
          completedAt: null,
          parentState: JOB_STATES.FYND_TRANSITION_PENDING,
          parentVersion: locked.version + 1,
          pendingOperation: null,
        }]);
      }
      const before = mutationState(fixture.harness);
      await expect(fixture.repository.markOeisAcceptedAndEnqueue(
        locked.id,
        acceptedArtifact(locked),
        { shipmentId: locked.shipmentId, documentNumber: locked.documentNumber },
        locked.version,
      )).rejects.toEqual(safeError(
        'REPOSITORY_VERSION_CONFLICT',
        'Invoice repository record changed concurrently',
      ));
      expect(mutationState(fixture.harness)).toEqual(before);
    }
  });

  test.each([
    [Long.fromString(String(Number.MAX_SAFE_INTEGER)), 'REPOSITORY_ID_EXHAUSTED'],
    ['bad-counter', 'REPOSITORY_DATA_INVALID'],
  ])('fails closed for outbox counter %p and rolls back all writes', async (value, code) => {
    const fixture = await readyFixture();
    const locked = await makeLocked(fixture, code);
    fixture.harness.replaceDocuments('counters', fixture.harness.documents('counters').map(row => (
      row._id === 'invoice_outbox' ? { ...row, value } : row
    )));
    const before = mutationState(fixture.harness);
    await expect(fixture.repository.markOeisAcceptedAndEnqueue(
      locked.id,
      acceptedArtifact(locked),
      { shipmentId: locked.shipmentId, documentNumber: locked.documentNumber },
      locked.version,
    )).rejects.toEqual(expect.objectContaining({ code }));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('callback replay commits one ID, and unknown commit remains terminally unknown', async () => {
    const replay = await readyFixture();
    const replayLocked = await makeLocked(replay, 'callback-replay');
    replay.harness.replayNextTransaction(1);
    await expect(replay.repository.markOeisAcceptedAndEnqueue(
      replayLocked.id,
      acceptedArtifact(replayLocked),
      { shipmentId: replayLocked.shipmentId, documentNumber: replayLocked.documentNumber },
      replayLocked.version,
    )).resolves.toEqual(expect.objectContaining({
      outbox: expect.objectContaining({ id: 1 }),
    }));
    expect(replay.harness.documents('invoice_outbox')).toHaveLength(1);
    expect(replay.harness.documents('counters').find(row => row._id === 'invoice_outbox').value)
      .toEqual(Long.ONE);

    const unknown = await readyFixture();
    const unknownLocked = await makeLocked(unknown, 'unknown-commit');
    unknown.harness.makeNextCommitUnknown();
    await expect(unknown.repository.markOeisAcceptedAndEnqueue(
      unknownLocked.id,
      acceptedArtifact(unknownLocked),
      { shipmentId: unknownLocked.shipmentId, documentNumber: unknownLocked.documentNumber },
      unknownLocked.version,
    )).rejects.toEqual(safeError(
      'REPOSITORY_TRANSACTION_UNKNOWN',
      'Invoice repository transaction result is unknown',
    ));
  });

  test('getArtifact validates ID and fails closed on malformed BSON without raw XML leakage', async () => {
    const fixture = await readyFixture();
    for (const value of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
      await expect(fixture.repository.getArtifact(value)).rejects.toEqual(safeError(
        'REPOSITORY_INPUT_INVALID',
        'Invoice repository read input is invalid',
      ));
    }
    await expect(fixture.repository.getArtifact(1)).resolves.toBeNull();
    fixture.harness.seed('invoice_artifacts', [{
      jobId: Long.ONE,
      invoiceNumber: 'VR-shipment-1-1',
      transactionNumber: 't',
      uuid: 'u',
      invoiceCounter: '1',
      matchingKey: 'm',
      responseStatus: 'OEIS_ACCEPTED_REPORTING_PENDING',
      signedXmlBase64: XML_BASE64,
      signedXmlSha256: 'PRIVATE_BAD_HASH',
      qrCodeData: null,
      createdAt: new Date(NOW),
      signedXml: 'must-not-leak',
    }]);
    const error = await fixture.repository.getArtifact(1).catch(value => value);
    expect(error).toEqual(safeError(
      'REPOSITORY_DATA_INVALID',
      'Invoice repository data is invalid',
    ));
    expect(`${error.message} ${error.stack}`).not.toContain('must-not-leak');
  });

  test('getArtifact fails closed when immutable invoice identity diverges from its live parent', async () => {
    const fixture = await readyFixture();
    const created = await enqueue(fixture, 'artifact-parent-drift');
    replaceLong(fixture.harness, 'invoice_artifacts', 'jobId', created.job.id, {
      invoiceNumber: 'VR-other-shipment-1',
    });

    await expect(fixture.repository.getArtifact(created.job.id)).rejects.toEqual(safeError(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
  });
});

describe('Mongo outbox claim and mutation contract', () => {
  test('claims an imported two-field payload while preserving its exact reordered JSON bytes', async () => {
    const fixture = await readyFixture();
    const created = await enqueue(fixture, 'imported-exact-bytes');
    const payloadJson = [
      '{',
      `  "documentNumber": "${created.job.documentNumber}",`,
      `  "shipmentId": "${created.job.shipmentId}"`,
      '}',
    ].join('\n');
    replaceLong(fixture.harness, 'invoice_outbox', 'outboxId', created.outbox.id, {
      payloadJson,
    });

    const claimed = await claimOutbox(fixture, 'imported-payload-worker');

    expect(claimed).toEqual(expect.objectContaining({
      id: created.outbox.id,
      jobId: created.job.id,
      payloadJson,
      payload: {
        shipmentId: created.job.shipmentId,
        documentNumber: created.job.documentNumber,
      },
      leaseOwner: 'imported-payload-worker',
    }));
    expect(findLong(
      fixture.harness, 'invoice_outbox', 'outboxId', created.outbox.id,
    ).payloadJson).toBe(payloadJson);
  });

  test.each([
    ['an extra key', created => JSON.stringify({
      shipmentId: created.job.shipmentId,
      documentNumber: created.job.documentNumber,
      signedXml: 'must-not-be-accepted',
    }), 'REPOSITORY_DATA_INVALID'],
    ['a missing key', created => JSON.stringify({
      shipmentId: created.job.shipmentId,
    }), 'REPOSITORY_DATA_INVALID'],
    ['a non-string value', created => JSON.stringify({
      shipmentId: created.job.shipmentId,
      documentNumber: 1,
    }), 'REPOSITORY_DATA_INVALID'],
    ['a blank value', created => JSON.stringify({
      shipmentId: ' ',
      documentNumber: created.job.documentNumber,
    }), 'REPOSITORY_DATA_INVALID'],
    ['a different shipment identity', created => JSON.stringify({
      shipmentId: 'shipment-other',
      documentNumber: created.job.documentNumber,
    }), 'REPOSITORY_VERSION_CONFLICT'],
    ['a different document identity', created => JSON.stringify({
      shipmentId: created.job.shipmentId,
      documentNumber: 'VR-shipment-other-1',
    }), 'REPOSITORY_VERSION_CONFLICT'],
  ])('rejects an imported payload with %s and rolls back its claim', async (
    _label,
    buildPayload,
    code,
  ) => {
    const fixture = await readyFixture();
    const created = await enqueue(fixture, `imported-invalid-${code}`);
    replaceLong(fixture.harness, 'invoice_outbox', 'outboxId', created.outbox.id, {
      payloadJson: buildPayload(created),
    });
    const before = mutationState(fixture.harness);

    await expect(claimOutbox(fixture, 'invalid-import-worker')).rejects.toEqual(
      expect.objectContaining({ code }),
    );
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test.each([
    ['accessor', 'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid', false],
    ['Proxy', 'REPOSITORY_UNAVAILABLE', 'Invoice repository is unavailable', true],
  ])(
    'rejects a hostile outbox %s post-image with a fixed error and no mutation',
    async (kind, code, message, retryable) => {
      const harness = createMongoRepositoryHarness();
      const collection = harness.db.collection('invoice_outbox');
      let postImage;
      Object.defineProperty(collection, 'findOneAndUpdate', {
        configurable: true,
        value: async () => postImage,
      });
      const fixture = await readyFixture({ harness });
      const created = await enqueue(fixture, `hostile-${kind}`);
      const raw = findLong(harness, 'invoice_outbox', 'outboxId', created.outbox.id);
      const updated = {
        ...raw,
        attemptCount: raw.attemptCount + 1,
        leaseOwner: 'hostile-import-worker',
        leaseExpiresAt: new Date(OUTBOX_LEASE),
        version: raw.version + 1,
      };
      let calls = 0;
      if (kind === 'accessor') {
        Object.defineProperty(updated, 'payloadJson', {
          enumerable: true,
          get() {
            calls += 1;
            return raw.payloadJson;
          },
        });
        postImage = updated;
      } else {
        postImage = new Proxy(updated, {
          get() { calls += 1; throw new Error('hostile get trap'); },
          getOwnPropertyDescriptor() {
            calls += 1;
            throw new Error('hostile descriptor trap');
          },
          getPrototypeOf() {
            calls += 1;
            throw new Error('hostile prototype trap');
          },
          ownKeys() {
            calls += 1;
            throw new Error('hostile ownKeys trap');
          },
        });
      }
      const before = mutationState(harness);

      const error = await fixture.repository.claimNextOutbox(
        'hostile-import-worker', OUTBOX_LEASE,
      ).catch(value => value);
      expect(error).toEqual(safeError(code, message, retryable));
      expect(`${error.message} ${error.stack}`).not.toContain('hostile get trap');
      if (kind === 'accessor') expect(calls).toBe(0);
      else expect(calls).toBeGreaterThan(0);
      expect(mutationState(harness)).toEqual(before);
    },
  );

  test.each([
    ['', OUTBOX_LEASE],
    [' ', OUTBOX_LEASE],
    [null, OUTBOX_LEASE],
    ['worker', 'not-a-date'],
    ['worker', NOW.toISOString()],
  ])('rejects invalid claim input %# before mutation', async (worker, leaseUntil) => {
    const fixture = await readyFixture();
    await enqueue(fixture);
    fixture.clock.reset();
    const before = mutationState(fixture.harness);
    await expect(fixture.repository.claimNextOutbox(worker, leaseUntil)).rejects.toEqual(safeError(
      'REPOSITORY_CLAIM_INVALID',
      'Invoice repository claim is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
    expect(fixture.clock.calls()).toBe(1);
  });

  test('claims by dueAt/outboxId with direct post-image, exact parent authority, and internal audit/head', async () => {
    const fixture = await readyFixture();
    const first = await enqueue(fixture, 'a');
    const second = await enqueue(fixture, 'b');
    replaceLong(fixture.harness, 'invoice_outbox', 'outboxId', first.outbox.id, {
      dueAt: new Date(RECEIVED_AT),
      nextAttemptAt: new Date(RECEIVED_AT),
    });
    replaceLong(fixture.harness, 'invoice_outbox', 'outboxId', second.outbox.id, {
      dueAt: new Date(RECEIVED_AT),
      nextAttemptAt: new Date(RECEIVED_AT),
    });
    const beforeTrace = fixture.harness.trace.operations.length;

    const claimed = await fixture.repository.claimNextOutbox('winner', OUTBOX_LEASE);

    expect(claimed).toEqual(expect.objectContaining({
      id: first.outbox.id,
      attemptCount: 1,
      version: 1,
      leaseOwner: 'winner',
      leaseExpiresAt: OUTBOX_LEASE,
    }));
    const operations = fixture.harness.trace.operations.slice(beforeTrace);
    const mutationIndex = operations.findIndex(row => (
      row.collection === 'invoice_outbox' && row.method === 'findOneAndUpdate'
    ));
    expect(operations[mutationIndex].options).toEqual(expect.objectContaining({
      returnDocument: 'after',
      includeResultMetadata: false,
      session: true,
      sort: { dueAt: 1, outboxId: 1 },
    }));
    expect(operations.slice(mutationIndex + 1).filter(row => (
      row.collection === 'invoice_outbox' && row.method === 'findOne'
    ))).toEqual([]);
    expect(fixture.harness.documents('shipment_audit_events')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'OUTBOX_CLAIMED',
        jobId: Long.fromNumber(first.locked.id),
        attemptNumber: 1,
        queueDelayMs: 60_000,
      }),
    ]));
  });

  test('returns null when none are due but selected-parent divergence conflicts and rolls back', async () => {
    const fixture = await readyFixture();
    const created = await enqueue(fixture);
    replaceLong(fixture.harness, 'invoice_outbox', 'outboxId', created.outbox.id, {
      dueAt: new Date('2026-08-17T11:00:00.000Z'),
      nextAttemptAt: new Date('2026-08-17T11:00:00.000Z'),
    });
    await expect(claimOutbox(fixture)).resolves.toBeNull();
    replaceLong(fixture.harness, 'invoice_outbox', 'outboxId', created.outbox.id, {
      dueAt: new Date(NOW),
      nextAttemptAt: new Date(NOW),
    });
    replaceLong(fixture.harness, 'invoice_jobs', 'jobId', created.locked.id, {
      version: created.job.version + 1,
    });
    const before = mutationState(fixture.harness);
    await expect(claimOutbox(fixture)).rejects.toEqual(safeError(
      'REPOSITORY_VERSION_CONFLICT',
      'Invoice repository record changed concurrently',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('allows only one two-instance claim winner', async () => {
    const harness = createMongoRepositoryHarness();
    const first = await readyFixture({ harness });
    const second = await readyFixture({ harness });
    const created = await enqueue(first);
    const claims = await Promise.all([
      first.repository.claimNextOutbox('worker-a', OUTBOX_LEASE),
      second.repository.claimNextOutbox('worker-b', OUTBOX_LEASE),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toEqual(expect.objectContaining({
      id: created.outbox.id,
      attemptCount: 1,
      version: 1,
    }));
  });

  test('reports a selected claim candidate that loses its exact CAS as version conflict', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture, 'claim-cas-loss');
    fixture.harness.returnNext('invoice_outbox', 'findOneAndUpdate', null);
    const before = mutationState(fixture.harness);

    await expect(claimOutbox(fixture)).rejects.toEqual(safeError(
      'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('atomically retains compatible supplied audit before the internal claim head', async () => {
    const fixture = await readyFixture();
    const created = await enqueue(fixture, 'claim-companion');
    const companion = claimCompanionEvent(created.job);
    fixture.clock.set('2026-08-17T10:00:01.000Z');

    const claimed = await fixture.repository.claimNextOutbox(
      'companion-worker', OUTBOX_LEASE, [companion],
    );

    expect(claimed).toEqual(expect.objectContaining({ id: created.outbox.id }));
    expect(fixture.harness.documents('shipment_audit_events')).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventKey: companion.eventKey, action: 'VALIDATION_PASSED' }),
      expect.objectContaining({ action: 'OUTBOX_CLAIMED', attemptNumber: 1 }),
    ]));
    expect(fixture.harness.documents('shipment_audit_heads')).toContainEqual(
      expect.objectContaining({
        companyId: created.job.companyId,
        shipmentId: created.job.shipmentId,
        lastAction: 'OUTBOX_CLAIMED',
      }),
    );
  });

  test.each([
    ['state-transition action', created => outboxMutationEvent(
      created.job,
      created.outbox,
      created.outbox.version,
      {
        stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS',
        occurredAt: '2026-08-17T09:59:59.000Z',
      },
    )],
    ['noncanonical entity key', created => ({
      ...claimCompanionEvent(created.job),
      eventKey: createEventKey({
        kind: 'ENTITY',
        companyId: created.job.companyId,
        shipmentId: created.job.shipmentId,
        scopeKind: 'JOB',
        scopeId: String(created.job.id),
        parentVersion: created.job.version + 1,
        attemptNumber: created.job.attemptCount,
        stage: 'VALIDATION',
        action: 'VALIDATION_PASSED',
        outcome: 'SUCCESS',
      }),
    })],
  ])('rejects supplied claim audit with %s and rolls back the lease', async (
    _label,
    buildEvent,
  ) => {
    const fixture = await readyFixture();
    const created = await enqueue(fixture, `claim-audit-${_label}`);
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.claimNextOutbox(
      'companion-worker', OUTBOX_LEASE, [buildEvent(created)],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test.each(['missing owner', 'wrong companion type'])(
    'claim fails closed on a raw %s lease instead of repairing it',
    async scenario => {
      const fixture = await readyFixture();
      const created = await enqueue(fixture, `raw-lease-${scenario.replaceAll(' ', '-')}`);
      fixture.harness.replaceDocuments('invoice_outbox', fixture.harness.documents('invoice_outbox')
        .map(row => {
          if (!Long.isLong(row.outboxId)
              || !row.outboxId.equals(Long.fromNumber(created.outbox.id))) return row;
          if (scenario === 'wrong companion type') {
            return { ...row, leaseOwner: null, leaseExpiresAt: 'raw-driver-date' };
          }
          const missingOwner = { ...row };
          delete missingOwner.leaseOwner;
          return missingOwner;
        }));
      const before = mutationState(fixture.harness);

      await expect(claimOutbox(fixture)).rejects.toEqual(safeError(
        'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
      ));
      expect(mutationState(fixture.harness)).toEqual(before);
    },
  );

  test('retry requires exact live lease and parent/cache, sets due exactly, and preserves attempts', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture);
    const claimed = await claimOutbox(fixture);
    const retryAt = '2026-08-17T10:30:00.000Z';

    const retried = await fixture.repository.scheduleOutboxRetry(claimed.id, {
      errorCode: 'FYND_TIMEOUT',
      safeMessage: 'Fynd transition will be retried',
      nextAttemptAt: retryAt,
    }, claimed.version);

    expect(retried).toEqual(expect.objectContaining({
      status: OUTBOX_STATUSES.RETRY_WAIT,
      attemptCount: claimed.attemptCount,
      nextAttemptAt: retryAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: 'FYND_TIMEOUT',
      version: claimed.version + 1,
    }));
    expect(findLong(fixture.harness, 'invoice_outbox', 'outboxId', claimed.id).dueAt)
      .toEqual(new Date(retryAt));

    for (const [index, patch] of [
      { leaseExpiresAt: new Date(NOW) },
      { leaseOwner: null },
      { parentVersion: 99 },
    ].entries()) {
      const guarded = await readyFixture();
      await enqueue(guarded, `retry-${index}`);
      const guardedClaim = await claimOutbox(guarded);
      replaceLong(guarded.harness, 'invoice_outbox', 'outboxId', guardedClaim.id, patch);
      const before = mutationState(guarded.harness);
      await expect(guarded.repository.scheduleOutboxRetry(guardedClaim.id, {
        errorCode: 'FYND_TIMEOUT',
        safeMessage: 'safe',
        nextAttemptAt: retryAt,
      }, guardedClaim.version)).rejects.toEqual(expect.objectContaining({
        code: 'REPOSITORY_VERSION_CONFLICT',
      }));
      expect(mutationState(guarded.harness)).toEqual(before);
    }
  });

  test('rolls back retry when its valid-shaped outbox post-image drifts', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture, 'retry-post-image');
    const claimed = await claimOutbox(fixture);
    const raw = findLong(fixture.harness, 'invoice_outbox', 'outboxId', claimed.id);
    const retryAt = '2026-08-17T10:30:00.000Z';
    fixture.harness.returnNext('invoice_outbox', 'findOneAndUpdate', {
      ...raw,
      status: OUTBOX_STATUSES.RETRY_WAIT,
      dueAt: new Date(retryAt),
      nextAttemptAt: new Date(retryAt),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: 'DRIVER_DRIFT',
      lastErrorMessage: 'Valid but unexpected driver post-image',
      pendingOperation: null,
      version: claimed.version + 1,
    });
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.scheduleOutboxRetry(claimed.id, {
      errorCode: 'FYND_TIMEOUT',
      safeMessage: 'Fynd transition will be retried',
      nextAttemptAt: retryAt,
    }, claimed.version)).rejects.toEqual(safeError(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test.each([
    [
      'completeOutboxAndJob',
      (fixture, claimed) => fixture.repository.completeOutboxAndJob(
        claimed.id, claimed.version,
      ),
      OUTBOX_STATUSES.COMPLETED,
      JOB_STATES.COMPLETED,
      null,
    ],
    [
      'markOutboxIndeterminate',
      (fixture, claimed) => fixture.repository.markOutboxIndeterminate(
        claimed.id,
        'FYND_UNKNOWN',
        'Fynd transition state is unknown',
        claimed.version,
      ),
      OUTBOX_STATUSES.INDETERMINATE,
      JOB_STATES.INDETERMINATE,
      'FYND_UNKNOWN',
    ],
  ])('%s atomically transitions outbox/parent and updates cached post-version', async (
    _method,
    invoke,
    outboxStatus,
    jobState,
    errorCode,
  ) => {
    const fixture = await readyFixture();
    const created = await enqueue(fixture);
    const claimed = await claimOutbox(fixture);

    const result = await invoke(fixture, claimed);

    expect(result.outbox).toEqual(expect.objectContaining({
      status: outboxStatus,
      version: claimed.version + 1,
      nextAttemptAt: null,
      leaseOwner: null,
      lastErrorCode: errorCode,
      completedAt: outboxStatus === OUTBOX_STATUSES.COMPLETED ? NOW.toISOString() : null,
    }));
    expect(result.job).toEqual(expect.objectContaining({
      state: jobState,
      version: created.job.version + 1,
      lastErrorCode: errorCode,
    }));
    const raw = findLong(fixture.harness, 'invoice_outbox', 'outboxId', claimed.id);
    expect(raw).toEqual(expect.objectContaining({
      parentState: jobState,
      parentVersion: created.job.version + 1,
      dueAt: new Date(created.outbox.createdAt),
      pendingOperation: null,
    }));
    await expect(claimOutbox(fixture, 'late-worker')).resolves.toBeNull();
  });

  test('rolls back completion when its valid-shaped parent post-image drifts', async () => {
    const fixture = await readyFixture();
    const created = await enqueue(fixture, 'terminal-parent-post-image');
    const claimed = await claimOutbox(fixture);
    const raw = findLong(fixture.harness, 'invoice_jobs', 'jobId', created.job.id);
    fixture.harness.returnNext('invoice_jobs', 'findOneAndUpdate', {
      ...raw,
      documentNumber: 'VR-driver-parent-drift-1',
      state: JOB_STATES.COMPLETED,
      dueAt: raw.createdAt,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      pendingOperation: null,
      version: created.job.version + 1,
      updatedAt: new Date(NOW),
    });
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.completeOutboxAndJob(
      claimed.id, claimed.version,
    )).rejects.toEqual(safeError(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('rolls back completion when its valid-shaped outbox post-image drifts', async () => {
    const fixture = await readyFixture();
    const created = await enqueue(fixture, 'terminal-outbox-post-image');
    const claimed = await claimOutbox(fixture);
    const raw = findLong(fixture.harness, 'invoice_outbox', 'outboxId', claimed.id);
    fixture.harness.returnNext('invoice_outbox', 'findOneAndUpdate', {
      ...raw,
      payloadJson: JSON.stringify({
        shipmentId: 'shipment-driver-drift',
        documentNumber: 'VR-driver-drift-1',
      }),
      status: OUTBOX_STATUSES.COMPLETED,
      dueAt: raw.createdAt,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      completedAt: new Date(NOW),
      parentState: JOB_STATES.COMPLETED,
      parentVersion: created.job.version + 1,
      pendingOperation: null,
      version: claimed.version + 1,
    });
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.completeOutboxAndJob(
      claimed.id, claimed.version,
    )).rejects.toEqual(safeError(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('malformed payload and cross-document parent failure roll back the entire mutation', async () => {
    const malformed = await readyFixture();
    await enqueue(malformed);
    const badClaim = await claimOutbox(malformed);
    replaceLong(malformed.harness, 'invoice_outbox', 'outboxId', badClaim.id, {
      payloadJson: '{',
    });
    const badBefore = mutationState(malformed.harness);
    await expect(malformed.repository.scheduleOutboxRetry(badClaim.id, {
      errorCode: 'BAD',
      safeMessage: 'safe',
      nextAttemptAt: NOW.toISOString(),
    }, badClaim.version)).rejects.toEqual(safeError(
      'REPOSITORY_DATA_INVALID',
      'Invoice repository data is invalid',
    ));
    expect(mutationState(malformed.harness)).toEqual(badBefore);

    const failedParent = await readyFixture();
    const created = await enqueue(failedParent);
    const claimed = await claimOutbox(failedParent);
    replaceLong(failedParent.harness, 'invoice_jobs', 'jobId', created.job.id, {
      version: created.job.version + 1,
    });
    const before = mutationState(failedParent.harness);
    await expect(failedParent.repository.completeOutboxAndJob(
      claimed.id, claimed.version,
    )).rejects.toEqual(expect.objectContaining({ code: 'REPOSITORY_VERSION_CONFLICT' }));
    expect(mutationState(failedParent.harness)).toEqual(before);
  });

  test.each([
    ['control characters', 'safe\u0000raw-driver-secret'],
    ['oversized text', 'x'.repeat(1_025)],
  ])('claim rejects stored outbox error message with %s without exposing it', async (
    _label,
    unsafeMessage,
  ) => {
    const fixture = await readyFixture();
    await enqueue(fixture, `unsafe-message-${_label}`);
    const claimed = await claimOutbox(fixture);
    const retried = await fixture.repository.scheduleOutboxRetry(claimed.id, {
      errorCode: 'FYND_TIMEOUT',
      safeMessage: 'safe retry message',
      nextAttemptAt: NOW.toISOString(),
    }, claimed.version);
    replaceLong(fixture.harness, 'invoice_outbox', 'outboxId', retried.id, {
      lastErrorMessage: unsafeMessage,
    });
    const before = mutationState(fixture.harness);

    const error = await fixture.repository.claimNextOutbox(
      'message-worker', OUTBOX_LEASE,
    ).catch(value => value);
    expect(error).toEqual(safeError(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    expect(JSON.stringify({ message: error.message, stack: error.stack }))
      .not.toContain('raw-driver-secret');
    expect(mutationState(fixture.harness)).toEqual(before);
  });
});

describe('Mongo OUTBOX pending-operation and recovery contract', () => {
  test('begins with outbox CAS version, validates live parent, stores strict marker, and replays idempotently', async () => {
    const fixture = await readyFixture();
    const created = await enqueue(fixture);
    const claimed = await claimOutbox(fixture);
    const job = await fixture.repository.getJob(claimed.jobId);
    const started = transitionStarted(job, claimed);

    const first = await fixture.repository.beginExternalOperation({
      targetKind: 'OUTBOX',
      targetId: claimed.id,
      expectedVersion: claimed.version,
      event: started.event,
    });
    const replayed = await fixture.repository.beginExternalOperation({
      targetKind: 'OUTBOX',
      targetId: claimed.id,
      expectedVersion: claimed.version,
      event: started.event,
    });

    expect(first).toEqual({
      targetKind: 'OUTBOX',
      targetId: String(claimed.id),
      operationKey: started.operationKey,
      eventKey: started.event.eventKey,
      stage: 'FYND_TRANSITION',
      action: 'FYND_TRANSITION_REQUESTED',
      attemptNumber: claimed.attemptCount,
      startedAt: started.event.startedAt,
      targetVersion: claimed.version + 1,
    });
    expect(replayed).toEqual(first);
    const raw = findLong(fixture.harness, 'invoice_outbox', 'outboxId', claimed.id);
    expect(raw.parentVersion).toBe(created.job.version);
    expect(raw.version).toBe(claimed.version + 1);
    expect(raw.pendingOperation).toEqual(expect.objectContaining({
      expectedParentVersion: claimed.version,
      targetKind: 'OUTBOX',
      targetId: Long.fromNumber(claimed.id),
    }));
    expect(fixture.harness.documents('shipment_audit_events').filter(
      event => event.eventKey === started.event.eventKey,
    )).toHaveLength(1);
  });

  test('rolls back OUTBOX begin when its valid-shaped post-image drifts', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture, 'begin-post-image');
    const claimed = await claimOutbox(fixture);
    const job = await fixture.repository.getJob(claimed.jobId);
    const started = transitionStarted(job, claimed);
    const raw = findLong(fixture.harness, 'invoice_outbox', 'outboxId', claimed.id);
    fixture.harness.returnNext('invoice_outbox', 'findOneAndUpdate', {
      ...raw,
      payloadJson: JSON.stringify({
        shipmentId: 'shipment-driver-drift',
        documentNumber: 'VR-driver-drift-1',
      }),
      pendingOperation: {
        operationKey: started.operationKey,
        eventKey: started.event.eventKey,
        stage: 'FYND_TRANSITION',
        action: 'FYND_TRANSITION_REQUESTED',
        attemptNumber: claimed.attemptCount,
        expectedParentVersion: claimed.version,
        startedAt: new Date(started.event.startedAt),
        targetKind: 'OUTBOX',
        targetId: Long.fromNumber(claimed.id),
      },
      version: claimed.version + 1,
    });
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.beginExternalOperation({
      targetKind: 'OUTBOX',
      targetId: claimed.id,
      expectedVersion: claimed.version,
      event: started.event,
    })).rejects.toEqual(safeError(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('rejects an OUTBOX STARTED intent with a contradictory success code', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture, 'begin-success-code');
    const claimed = await claimOutbox(fixture);
    const job = await fixture.repository.getJob(claimed.jobId);
    const started = transitionStarted(job, claimed);
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.beginExternalOperation({
      targetKind: 'OUTBOX',
      targetId: claimed.id,
      expectedVersion: claimed.version,
      event: { ...started.event, safeCode: 'UNEXPECTED_START' },
    })).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('replays the original pending begin after lease recovery and a later reclaim', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture, 'begin-after-reclaim');
    const claimed = await claimOutbox(fixture);
    const job = await fixture.repository.getJob(claimed.jobId);
    const started = transitionStarted(job, claimed);
    const original = await fixture.repository.beginExternalOperation({
      targetKind: 'OUTBOX', targetId: claimed.id, expectedVersion: claimed.version,
      event: started.event,
    });
    await fixture.repository.releaseExpiredLeases(new Date(OUTBOX_LEASE));
    fixture.clock.set(new Date(OUTBOX_LEASE));
    const reclaimed = await fixture.repository.claimNextOutbox(
      'later-worker', '2026-08-17T10:12:00.000Z',
    );

    await expect(fixture.repository.beginExternalOperation({
      targetKind: 'OUTBOX', targetId: claimed.id, expectedVersion: claimed.version,
      event: started.event,
    })).resolves.toEqual({
      ...original,
      targetVersion: reclaimed.version,
    });
    expect(reclaimed.attemptCount).toBe(claimed.attemptCount + 1);
    expect(findLong(fixture.harness, 'invoice_outbox', 'outboxId', claimed.id).pendingOperation)
      .toEqual(expect.objectContaining({
        attemptNumber: claimed.attemptCount,
        expectedParentVersion: claimed.version,
      }));
  });

  test('rejects different intent, expired/incomplete lease, stale version, or divergent cached parent', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture);
    const claimed = await claimOutbox(fixture);
    const { job } = await beginTransition(fixture, claimed);
    const before = mutationState(fixture.harness);
    const different = transitionStarted(job, { ...claimed, version: claimed.version + 1 });
    await expect(fixture.repository.beginExternalOperation({
      targetKind: 'OUTBOX',
      targetId: claimed.id,
      expectedVersion: claimed.version + 1,
      event: different.event,
    })).rejects.toEqual(expect.objectContaining({ code: 'REPOSITORY_VERSION_CONFLICT' }));
    expect(mutationState(fixture.harness)).toEqual(before);

    for (const [index, patch] of [
      { leaseExpiresAt: new Date(NOW) },
      { leaseOwner: null },
      { parentVersion: 99 },
    ].entries()) {
      const guarded = await readyFixture();
      const created = await enqueue(guarded, `begin-${index}`);
      const guardedClaim = await claimOutbox(guarded);
      const guardedJob = await guarded.repository.getJob(created.job.id);
      const guardedStart = transitionStarted(guardedJob, guardedClaim);
      replaceLong(guarded.harness, 'invoice_outbox', 'outboxId', guardedClaim.id, patch);
      const guardedBefore = mutationState(guarded.harness);
      await expect(guarded.repository.beginExternalOperation({
        targetKind: 'OUTBOX',
        targetId: guardedClaim.id,
        expectedVersion: guardedClaim.version,
        event: guardedStart.event,
      })).rejects.toEqual(expect.objectContaining({ code: 'REPOSITORY_VERSION_CONFLICT' }));
      expect(mutationState(guarded.harness)).toEqual(guardedBefore);
    }
  });

  test('recovers the unique unresolved transition by parent job ID with current outbox version', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture);
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);

    await expect(fixture.repository.findUnresolvedAuditOperation({
      companyId: begun.job.companyId,
      jobId: begun.job.id,
      stage: 'FYND_TRANSITION',
    })).resolves.toEqual(begun.recovery);
    await expect(fixture.repository.findUnresolvedAuditOperation({
      companyId: begun.job.companyId,
      jobId: begun.job.id + 100,
      stage: 'FYND_TRANSITION',
    })).resolves.toBeNull();
  });

  test.each([
    ['live parent only', { parent: JOB_STATES.COMPLETED, cached: null }],
    ['cached parent only', { parent: null, cached: JOB_STATES.COMPLETED }],
    ['live and cached parent', {
      parent: JOB_STATES.COMPLETED,
      cached: JOB_STATES.COMPLETED,
    }],
  ])('fails transition recovery closed when %s is not pending', async (
    _label,
    states,
  ) => {
    const fixture = await readyFixture();
    await enqueue(fixture, `recovery-parent-${_label.replaceAll(' ', '-')}`);
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    if (states.parent !== null) {
      replaceLong(fixture.harness, 'invoice_jobs', 'jobId', begun.job.id, {
        state: states.parent,
      });
    }
    if (states.cached !== null) {
      replaceLong(fixture.harness, 'invoice_outbox', 'outboxId', claimed.id, {
        parentState: states.cached,
      });
    }
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.findUnresolvedAuditOperation({
      companyId: begun.job.companyId,
      jobId: begun.job.id,
      stage: 'FYND_TRANSITION',
    })).rejects.toEqual(safeError(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('returns null for a resolved terminal outbox but fails closed on a terminal pending marker', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture);
    const claimed = await claimOutbox(fixture);
    const result = await fixture.repository.completeOutboxAndJob(
      claimed.id, claimed.version,
    );
    const query = {
      companyId: result.job.companyId,
      jobId: result.job.id,
      stage: 'FYND_TRANSITION',
    };

    await expect(fixture.repository.findUnresolvedAuditOperation(query)).resolves.toBeNull();

    replaceLong(fixture.harness, 'invoice_outbox', 'outboxId', claimed.id, {
      pendingOperation: {
        operationKey: createOperationKey({
          targetKind: 'OUTBOX',
          targetId: String(claimed.id),
          expectedParentVersion: claimed.version,
          attemptNumber: claimed.attemptCount,
          stage: 'FYND_TRANSITION',
          action: 'FYND_TRANSITION_REQUESTED',
        }),
        eventKey: createEventKey({
          kind: 'OPERATION',
          operationKey: createOperationKey({
            targetKind: 'OUTBOX',
            targetId: String(claimed.id),
            expectedParentVersion: claimed.version,
            attemptNumber: claimed.attemptCount,
            stage: 'FYND_TRANSITION',
            action: 'FYND_TRANSITION_REQUESTED',
          }),
          stage: 'FYND_TRANSITION',
          action: 'FYND_TRANSITION_REQUESTED',
          outcome: 'STARTED',
        }),
        stage: 'FYND_TRANSITION',
        action: 'FYND_TRANSITION_REQUESTED',
        attemptNumber: claimed.attemptCount,
        expectedParentVersion: claimed.version,
        startedAt: new Date(NOW),
        targetKind: 'OUTBOX',
        targetId: Long.fromNumber(claimed.id),
      },
    });
    await expect(fixture.repository.findUnresolvedAuditOperation(query)).rejects.toEqual(
      safeError('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
  });

  test('requires matching distinct terminal evidence to clear pending on retry and completion', async () => {
    const retryFixture = await readyFixture();
    await enqueue(retryFixture);
    const retryClaim = await claimOutbox(retryFixture);
    const retryBegin = await beginTransition(retryFixture, retryClaim);
    const retryTerminal = transitionOutcome(
      retryBegin.job,
      retryClaim,
      retryBegin.started,
      {
        action: 'FYND_TRANSITION_FAILED',
        outcome: 'TIMEOUT',
        safeCode: 'FYND_TIMEOUT',
        retryable: true,
        finalStateClassification: 'UNKNOWN',
      },
    );
    await expect(retryFixture.repository.scheduleOutboxRetry(retryClaim.id, {
      errorCode: 'FYND_TIMEOUT',
      safeMessage: 'safe',
      nextAttemptAt: '2026-08-17T10:30:00.041Z',
    }, retryBegin.recovery.targetVersion, [])).rejects.toEqual(expect.objectContaining({
      code: 'REPOSITORY_VERSION_CONFLICT',
    }));
    const retryEvent = outboxMutationEvent(
      retryBegin.job,
      retryClaim,
      retryBegin.recovery.targetVersion,
      {
        stage: 'RETRY',
        action: 'RETRY_SCHEDULED',
        outcome: 'RETRY_SCHEDULED',
        safeCode: 'FYND_TIMEOUT',
        retryDelayMs: 1_800_000,
        occurredAt: '2026-08-17T10:00:00.041Z',
      },
    );
    await expect(retryFixture.repository.scheduleOutboxRetry(retryClaim.id, {
      errorCode: 'FYND_TIMEOUT',
      safeMessage: 'safe',
      nextAttemptAt: '2026-08-17T10:30:00.041Z',
    }, retryBegin.recovery.targetVersion, [retryTerminal])).rejects.toEqual(
      safeError('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid'),
    );
    await expect(retryFixture.repository.scheduleOutboxRetry(retryClaim.id, {
      errorCode: 'FYND_TIMEOUT',
      safeMessage: 'safe',
      nextAttemptAt: '2026-08-17T10:30:00.041Z',
    }, retryBegin.recovery.targetVersion, [retryTerminal, retryEvent])).rejects.toEqual(
      safeError('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid'),
    );
    const retryReadback = transitionReadbackPair(
      retryBegin.job,
      retryClaim,
      retryBegin.recovery.targetVersion,
      {
        locked: true,
        shipmentState: 'bag_confirmed',
        finalStateClassification: 'UNCHANGED',
      },
    );
    const retried = await retryFixture.repository.scheduleOutboxRetry(retryClaim.id, {
      errorCode: 'FYND_TIMEOUT',
      safeMessage: 'safe',
      nextAttemptAt: '2026-08-17T10:30:00.041Z',
    }, retryBegin.recovery.targetVersion, [...retryReadback, retryTerminal, retryEvent]);
    expect(retried.version).toBe(retryBegin.recovery.targetVersion + 1);
    expect(findLong(
      retryFixture.harness, 'invoice_outbox', 'outboxId', retryClaim.id,
    ).pendingOperation).toBeNull();
    expect(retryTerminal.eventKey).not.toBe(retryBegin.started.event.eventKey);

    const completeFixture = await readyFixture();
    await enqueue(completeFixture);
    const completeClaim = await claimOutbox(completeFixture);
    const completeBegin = await beginTransition(completeFixture, completeClaim);
    const completeTerminal = transitionOutcome(
      completeBegin.job, completeClaim, completeBegin.started,
    );
    const completedEvent = outboxMutationEvent(
      completeBegin.job,
      completeClaim,
      completeBegin.recovery.targetVersion,
      { stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS' },
    );
    await expect(completeFixture.repository.completeOutboxAndJob(
      completeClaim.id,
      completeBegin.recovery.targetVersion,
      [completeTerminal, completedEvent],
    )).resolves.toEqual(expect.objectContaining({
      outbox: expect.objectContaining({ status: OUTBOX_STATUSES.COMPLETED }),
      job: expect.objectContaining({ state: JOB_STATES.COMPLETED }),
    }));
  });

  test.each([
    ['retry', 'FYND_TIMEOUT', {
      action: 'FYND_TRANSITION_FAILED',
      outcome: 'TIMEOUT',
      safeCode: 'OTHER_CODE',
      retryable: true,
      finalStateClassification: 'UNKNOWN',
    }],
    ['indeterminate', 'FYND_UNKNOWN', {
      action: 'FYND_TRANSITION_FAILED',
      outcome: 'INDETERMINATE',
      safeCode: 'OTHER_CODE',
      retryable: false,
      finalStateClassification: 'UNKNOWN',
    }],
  ])('rejects %s transition evidence whose safe code contradicts the stored outcome', async (
    kind,
    storedCode,
    outcomeOptions,
  ) => {
    const fixture = await readyFixture();
    await enqueue(fixture, `terminal-code-${kind}`);
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    const terminal = transitionOutcome(
      begun.job, claimed, begun.started, outcomeOptions,
    );
    const local = kind === 'retry'
      ? outboxMutationEvent(begun.job, claimed, begun.recovery.targetVersion, {
        stage: 'RETRY', action: 'RETRY_SCHEDULED', outcome: 'RETRY_SCHEDULED',
        safeCode: storedCode, retryDelayMs: 1_800_000,
        occurredAt: '2026-08-17T10:00:00.041Z',
      })
      : outboxMutationEvent(begun.job, claimed, begun.recovery.targetVersion, {
        stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
        safeCode: storedCode,
      });
    const evidence = kind === 'retry'
      ? [
        ...transitionReadbackPair(begun.job, claimed, begun.recovery.targetVersion, {
          locked: true,
          shipmentState: 'bag_confirmed',
          finalStateClassification: 'UNCHANGED',
        }),
        terminal,
        local,
      ]
      : [terminal, local];
    const before = mutationState(fixture.harness);
    const operation = kind === 'retry'
      ? fixture.repository.scheduleOutboxRetry(claimed.id, {
        errorCode: storedCode,
        safeMessage: 'safe',
        nextAttemptAt: '2026-08-17T10:30:00.041Z',
      }, begun.recovery.targetVersion, evidence)
      : fixture.repository.markOutboxIndeterminate(
        claimed.id,
        storedCode,
        'safe',
        begun.recovery.targetVersion,
        evidence,
      );

    await expect(operation).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test.each([
    ['response status', { responseStatus: 200 }],
    ['locked flag', { locked: false }],
    ['shipment state', { shipmentState: 'bag_invoiced' }],
  ])('rejects a contradictory retry tuple with timeout %s', async (
    _label,
    terminalPatch,
  ) => {
    const fixture = await readyFixture();
    await enqueue(fixture, `retry-tuple-${_label.replaceAll(' ', '-')}`);
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    const terminal = transitionOutcome(begun.job, claimed, begun.started, {
      action: 'FYND_TRANSITION_FAILED',
      outcome: 'TIMEOUT',
      safeCode: 'FYND_TIMEOUT',
      retryable: true,
      finalStateClassification: 'UNKNOWN',
      ...terminalPatch,
    });
    const readback = transitionReadbackPair(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      {
        locked: true,
        shipmentState: 'bag_confirmed',
        finalStateClassification: 'UNCHANGED',
      },
    );
    const retry = outboxMutationEvent(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      {
        stage: 'RETRY', action: 'RETRY_SCHEDULED', outcome: 'RETRY_SCHEDULED',
        safeCode: 'FYND_TIMEOUT', retryDelayMs: 1_800_000,
        occurredAt: '2026-08-17T10:00:00.041Z',
      },
    );
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.scheduleOutboxRetry(claimed.id, {
      errorCode: 'FYND_TIMEOUT',
      safeMessage: 'safe',
      nextAttemptAt: '2026-08-17T10:30:00.041Z',
    }, begun.recovery.targetVersion, [...readback, terminal, retry])).rejects.toEqual(
      safeError('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid'),
    );
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test.each([
    ['response status', { responseStatus: 200 }],
    ['locked flag', { locked: false }],
    ['shipment state', { shipmentState: 'bag_invoiced' }],
  ])('rejects a contradictory direct indeterminate tuple with %s', async (
    _label,
    terminalPatch,
  ) => {
    const fixture = await readyFixture();
    await enqueue(fixture, `indeterminate-tuple-${_label.replaceAll(' ', '-')}`);
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    const terminal = transitionOutcome(begun.job, claimed, begun.started, {
      action: 'FYND_TRANSITION_FAILED',
      outcome: 'INDETERMINATE',
      safeCode: 'FYND_UNKNOWN',
      retryable: false,
      finalStateClassification: 'UNKNOWN',
      ...terminalPatch,
    });
    const local = outboxMutationEvent(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      {
        stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
        safeCode: 'FYND_UNKNOWN',
      },
    );
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.markOutboxIndeterminate(
      claimed.id,
      'FYND_UNKNOWN',
      'safe',
      begun.recovery.targetVersion,
      [terminal, local],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test.each([
    ['conflicting exact-final fields', {
      locked: false,
      shipmentState: 'bag_invoiced',
      finalStateClassification: 'CONFLICTING',
    }],
    ['conflicting exact-prestate fields', {
      locked: true,
      shipmentState: 'bag_confirmed',
      finalStateClassification: 'CONFLICTING',
    }],
    ['unreadable exact-final fields', {
      terminalOutcome: 'FAILURE',
      terminalSafeCode: 'FYND_NETWORK',
      locked: false,
      shipmentState: 'bag_invoiced',
      finalStateClassification: 'UNREADABLE',
    }],
    ['unreadable exact-prestate fields', {
      terminalOutcome: 'FAILURE',
      terminalSafeCode: 'FYND_NETWORK',
      locked: true,
      shipmentState: 'bag_confirmed',
      finalStateClassification: 'UNREADABLE',
    }],
    ['unreadable response status', {
      terminalOutcome: 'TIMEOUT',
      terminalSafeCode: 'FYND_TIMEOUT',
      responseStatus: 200,
      locked: null,
      shipmentState: null,
      finalStateClassification: 'UNREADABLE',
    }],
  ])('rejects a contradictory indeterminate readback tuple with %s', async (
    _label,
    readbackOptions,
  ) => {
    const fixture = await readyFixture();
    await enqueue(fixture, `indeterminate-readback-${_label.replaceAll(' ', '-')}`);
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    const original = transitionOutcome(begun.job, claimed, begun.started, {
      action: 'FYND_TRANSITION_FAILED',
      outcome: 'INDETERMINATE',
      safeCode: 'FYND_UNKNOWN',
      retryable: false,
      finalStateClassification: 'UNKNOWN',
    });
    const readback = transitionReadbackPair(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      readbackOptions,
    );
    const local = outboxMutationEvent(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      {
        stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
        safeCode: 'FYND_UNKNOWN', occurredAt: '2026-08-17T10:00:00.041Z',
      },
    );
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.markOutboxIndeterminate(
      claimed.id,
      'FYND_UNKNOWN',
      'safe',
      begun.recovery.targetVersion,
      [...readback, original, local],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test.each([
    ['deterministic rejection', {
      outcome: 'FAILURE',
      safeCode: 'FYND_HTTP_4XX',
      retryable: false,
      finalStateClassification: 'REJECTED',
    }],
    ['terminal uncertainty', {
      outcome: 'INDETERMINATE',
      safeCode: 'FYND_UNKNOWN',
      retryable: false,
      finalStateClassification: 'UNKNOWN',
    }],
  ])('accepts the canonical direct indeterminate tuple for %s', async (
    _label,
    terminalOptions,
  ) => {
    const fixture = await readyFixture();
    await enqueue(fixture, `direct-indeterminate-${_label.replaceAll(' ', '-')}`);
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    const terminal = transitionOutcome(begun.job, claimed, begun.started, {
      action: 'FYND_TRANSITION_FAILED',
      ...terminalOptions,
    });
    const local = outboxMutationEvent(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      {
        stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
        safeCode: terminalOptions.safeCode,
      },
    );

    await expect(fixture.repository.markOutboxIndeterminate(
      claimed.id,
      terminalOptions.safeCode,
      'safe',
      begun.recovery.targetVersion,
      [terminal, local],
    )).resolves.toEqual({
      outbox: expect.objectContaining({ status: OUTBOX_STATUSES.INDETERMINATE }),
      job: expect.objectContaining({ state: JOB_STATES.INDETERMINATE }),
    });
  });

  test.each([
    ['conflicting state', {
      locked: null,
      shipmentState: null,
      finalStateClassification: 'CONFLICTING',
    }],
    ['unreadable state', {
      terminalOutcome: 'FAILURE',
      terminalSafeCode: 'FYND_NETWORK',
      locked: null,
      shipmentState: null,
      finalStateClassification: 'UNREADABLE',
    }],
  ])('accepts the canonical indeterminate readback tuple for %s', async (
    _label,
    readbackOptions,
  ) => {
    const fixture = await readyFixture();
    await enqueue(fixture, `canonical-indeterminate-${_label.replaceAll(' ', '-')}`);
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    const original = transitionOutcome(begun.job, claimed, begun.started, {
      action: 'FYND_TRANSITION_FAILED',
      outcome: 'INDETERMINATE',
      safeCode: 'FYND_UNKNOWN',
      retryable: false,
      finalStateClassification: 'UNKNOWN',
    });
    const readback = transitionReadbackPair(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      readbackOptions,
    );
    const local = outboxMutationEvent(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      {
        stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
        safeCode: 'FYND_UNKNOWN', occurredAt: '2026-08-17T10:00:00.041Z',
      },
    );

    await expect(fixture.repository.markOutboxIndeterminate(
      claimed.id,
      'FYND_UNKNOWN',
      'safe',
      begun.recovery.targetVersion,
      [...readback, original, local],
    )).resolves.toEqual({
      outbox: expect.objectContaining({ status: OUTBOX_STATUSES.INDETERMINATE }),
      job: expect.objectContaining({ state: JOB_STATES.INDETERMINATE }),
    });
  });

  test('accepts exact inferred 429 evidence before a confirmed-prestate retry', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture, 'retry-exact-429');
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    const terminal = transitionOutcome(begun.job, claimed, begun.started, {
      action: 'FYND_TRANSITION_FAILED',
      outcome: 'FAILURE',
      safeCode: 'FYND_HTTP_429',
      responseStatus: 429,
      retryable: true,
      finalStateClassification: 'REJECTED',
    });
    const readback = transitionReadbackPair(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      {
        locked: true,
        shipmentState: 'bag_confirmed',
        finalStateClassification: 'UNCHANGED',
      },
    );
    const retry = outboxMutationEvent(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      {
        stage: 'RETRY', action: 'RETRY_SCHEDULED', outcome: 'RETRY_SCHEDULED',
        safeCode: 'FYND_HTTP_429', retryDelayMs: 1_800_000,
        occurredAt: '2026-08-17T10:00:00.041Z',
      },
    );

    await expect(fixture.repository.scheduleOutboxRetry(claimed.id, {
      errorCode: 'FYND_HTTP_429',
      safeMessage: 'safe',
      nextAttemptAt: '2026-08-17T10:30:00.041Z',
    }, begun.recovery.targetVersion, [...readback, terminal, retry])).resolves.toEqual(
      expect.objectContaining({ status: OUTBOX_STATUSES.RETRY_WAIT }),
    );
  });

  test('commits readback-first exact-final evidence with the original confirmed outcome', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture, 'transition-readback');
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    const original = transitionOutcome(begun.job, claimed, begun.started);
    const readback = transitionReadbackPair(
      begun.job, claimed, begun.recovery.targetVersion,
    );
    const completed = outboxMutationEvent(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      {
        stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS',
        occurredAt: '2026-08-17T10:00:00.041Z',
      },
    );

    await expect(fixture.repository.completeOutboxAndJob(
      claimed.id,
      begun.recovery.targetVersion,
      [...readback, original, completed],
    )).resolves.toEqual(expect.objectContaining({
      outbox: expect.objectContaining({ status: OUTBOX_STATUSES.COMPLETED }),
      job: expect.objectContaining({ state: JOB_STATES.COMPLETED }),
    }));
    expect(fixture.harness.documents('shipment_audit_heads')).toContainEqual(
      expect.objectContaining({
        lastAction: 'JOB_COMPLETED',
        lastOutcome: 'SUCCESS',
        lastEventKey: completed.eventKey,
      }),
    );
  });

  test('rejects completion when an invoiced readback is paired with an original failed outcome', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture, 'transition-failed-final');
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    const failed = transitionOutcome(begun.job, claimed, begun.started, {
      action: 'FYND_TRANSITION_FAILED',
      outcome: 'TIMEOUT',
      safeCode: 'FYND_TIMEOUT',
      retryable: true,
      finalStateClassification: 'UNKNOWN',
    });
    const readback = transitionReadbackPair(
      begun.job, claimed, begun.recovery.targetVersion,
    );
    const completed = outboxMutationEvent(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      {
        stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS',
        occurredAt: '2026-08-17T10:00:00.041Z',
      },
    );
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.completeOutboxAndJob(
      claimed.id,
      begun.recovery.targetVersion,
      [...readback, failed, completed],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('accepts transition recovery evidence built from one occurrence clock', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture, 'transition-one-clock');
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    const original = transitionOutcome(begun.job, claimed, begun.started);
    const readback = transitionReadbackPair(
      begun.job, claimed, begun.recovery.targetVersion,
    );
    const completed = outboxMutationEvent(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      { stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS' },
    );
    const bundleAt = new Date('2026-08-17T10:00:00.041Z');
    const bundle = createAuditBundle([
      auditInput(readback[0]),
      auditInput(readback[1]),
      auditInput(original),
      auditInput(completed, { startedAt: null, completedAt: null }),
    ], { now: () => bundleAt });

    await expect(fixture.repository.completeOutboxAndJob(
      claimed.id,
      begun.recovery.targetVersion,
      bundle,
    )).resolves.toEqual({
      outbox: expect.objectContaining({ status: OUTBOX_STATUSES.COMPLETED }),
      job: expect.objectContaining({ state: JOB_STATES.COMPLETED }),
    });
    const expectedHead = [...bundle].sort((left, right) => (
      left.eventKey < right.eventKey ? -1 : left.eventKey > right.eventKey ? 1 : 0
    )).at(-1);
    expect(fixture.harness.documents('shipment_audit_heads')).toContainEqual(
      expect.objectContaining({
        lastEventKey: expectedHead.eventKey,
        lastAction: expectedHead.action,
      }),
    );
  });

  test.each([
    ['direct success code', { safeCode: 'UNEXPECTED_SUCCESS' }, null],
    ['direct locked flag', { locked: true }, null],
    ['direct response status', { responseStatus: 200 }, null],
    ['terminal artifact identity', { artifactJobId: 'other' }, null],
    ['completed local success code', {}, 'UNEXPECTED_SUCCESS'],
  ])('rejects completed transition evidence with contradictory %s', async (
    _label,
    terminalOptions,
    completedSafeCode,
  ) => {
    const fixture = await readyFixture();
    await enqueue(fixture, `complete-nullable-${_label.replaceAll(' ', '-')}`);
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    const options = terminalOptions.artifactJobId === 'other'
      ? { ...terminalOptions, artifactJobId: begun.job.id + 1 }
      : terminalOptions;
    const terminal = transitionOutcome(
      begun.job, claimed, begun.started, options,
    );
    const completed = outboxMutationEvent(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      {
        stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS',
        safeCode: completedSafeCode,
      },
    );
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.completeOutboxAndJob(
      claimed.id,
      begun.recovery.targetVersion,
      [terminal, completed],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test.each([
    ['readback start success code', { startedSafeCode: 'UNEXPECTED_START' }],
    ['readback terminal success code', { terminalSafeCode: 'UNEXPECTED_SUCCESS' }],
    ['readback locked flag', { locked: true }],
    ['readback response status', { responseStatus: 200 }],
  ])('rejects transition completion with contradictory %s', async (
    _label,
    readbackOptions,
  ) => {
    const fixture = await readyFixture();
    await enqueue(fixture, `readback-nullable-${_label.replaceAll(' ', '-')}`);
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    const original = transitionOutcome(begun.job, claimed, begun.started);
    const readback = transitionReadbackPair(
      begun.job, claimed, begun.recovery.targetVersion, readbackOptions,
    );
    const completed = outboxMutationEvent(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      {
        stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS',
        occurredAt: '2026-08-17T10:00:00.041Z',
      },
    );
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.completeOutboxAndJob(
      claimed.id,
      begun.recovery.targetVersion,
      [...readback, original, completed],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test.each(['summary identity', 'local head chronology'])(
    'rejects completed transition evidence with contradictory %s',
    async scenario => {
      const fixture = await readyFixture();
      await enqueue(fixture, `bad-complete-${scenario.replaceAll(' ', '-')}`);
      const claimed = await claimOutbox(fixture);
      const begun = await beginTransition(fixture, claimed);
      const terminal = transitionOutcome(begun.job, claimed, begun.started, {
        summaryShipmentId: scenario === 'summary identity'
          ? 'other-shipment' : begun.job.shipmentId,
      });
      const completed = outboxMutationEvent(
        begun.job,
        claimed,
        begun.recovery.targetVersion,
        {
          stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS',
          occurredAt: scenario === 'local head chronology'
            ? '2026-08-17T10:00:00.024Z' : '2026-08-17T10:00:00.026Z',
        },
      );
      const before = mutationState(fixture.harness);

      await expect(fixture.repository.completeOutboxAndJob(
        claimed.id,
        begun.recovery.targetVersion,
        [terminal, completed],
      )).rejects.toEqual(safeError(
        'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
      ));
      expect(mutationState(fixture.harness)).toEqual(before);
    },
  );

  test.each(['missing readback after timeout', 'readback proves invoiced'])(
    'rejects indeterminate evidence when %s',
    async scenario => {
      const fixture = await readyFixture();
      await enqueue(fixture, `bad-indeterminate-${scenario.replaceAll(' ', '-')}`);
      const claimed = await claimOutbox(fixture);
      const begun = await beginTransition(fixture, claimed);
      const terminal = transitionOutcome(begun.job, claimed, begun.started, {
        action: 'FYND_TRANSITION_FAILED',
        outcome: 'TIMEOUT',
        safeCode: 'FYND_TIMEOUT',
        retryable: true,
        finalStateClassification: 'UNKNOWN',
      });
      const readback = scenario === 'readback proves invoiced'
        ? transitionReadbackPair(begun.job, claimed, begun.recovery.targetVersion)
        : [];
      const local = outboxMutationEvent(
        begun.job,
        claimed,
        begun.recovery.targetVersion,
        {
          stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
          safeCode: 'FYND_TIMEOUT',
          occurredAt: readback.length === 0
            ? '2026-08-17T10:00:00.026Z' : '2026-08-17T10:00:00.041Z',
        },
      );
      const before = mutationState(fixture.harness);

      await expect(fixture.repository.markOutboxIndeterminate(
        claimed.id,
        'FYND_TIMEOUT',
        'safe',
        begun.recovery.targetVersion,
        readback.length === 0 ? [terminal, local] : [...readback, terminal, local],
      )).rejects.toEqual(safeError(
        'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
      ));
      expect(mutationState(fixture.harness)).toEqual(before);
    },
  );

  test('never schedules a retry from an indeterminate original transition outcome', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture, 'no-retry-after-indeterminate');
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    const terminal = transitionOutcome(begun.job, claimed, begun.started, {
      action: 'FYND_TRANSITION_FAILED',
      outcome: 'INDETERMINATE',
      safeCode: 'FYND_UNKNOWN',
      retryable: true,
      finalStateClassification: 'UNKNOWN',
    });
    const readback = transitionReadbackPair(
      begun.job, claimed, begun.recovery.targetVersion,
      {
        locked: true,
        shipmentState: 'bag_confirmed',
        finalStateClassification: 'UNCHANGED',
      },
    );
    const retry = outboxMutationEvent(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      {
        stage: 'RETRY', action: 'RETRY_SCHEDULED', outcome: 'RETRY_SCHEDULED',
        safeCode: 'FYND_UNKNOWN', retryDelayMs: 1_800_000,
        occurredAt: '2026-08-17T10:00:00.041Z',
      },
    );
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.scheduleOutboxRetry(claimed.id, {
      errorCode: 'FYND_UNKNOWN',
      safeMessage: 'safe',
      nextAttemptAt: '2026-08-17T10:30:00.041Z',
    }, begun.recovery.targetVersion, [...readback, terminal, retry])).rejects.toEqual(
      safeError('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid'),
    );
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('marks retry-exhausted confirmed prestate indeterminate with complete evidence', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture, 'retry-exhausted-indeterminate');
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    const terminal = transitionOutcome(begun.job, claimed, begun.started, {
      action: 'FYND_TRANSITION_FAILED',
      outcome: 'TIMEOUT',
      safeCode: 'FYND_TIMEOUT',
      retryable: true,
      finalStateClassification: 'UNKNOWN',
    });
    const readback = transitionReadbackPair(
      begun.job, claimed, begun.recovery.targetVersion,
      {
        locked: true,
        shipmentState: 'bag_confirmed',
        finalStateClassification: 'UNCHANGED',
      },
    );
    const local = outboxMutationEvent(
      begun.job,
      claimed,
      begun.recovery.targetVersion,
      {
        stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
        safeCode: 'FYND_TIMEOUT', occurredAt: '2026-08-17T10:00:00.041Z',
      },
    );

    await expect(fixture.repository.markOutboxIndeterminate(
      claimed.id,
      'FYND_TIMEOUT',
      'Retry attempts are exhausted',
      begun.recovery.targetVersion,
      [...readback, terminal, local],
    )).resolves.toEqual({
      outbox: expect.objectContaining({ status: OUTBOX_STATUSES.INDETERMINATE }),
      job: expect.objectContaining({ state: JOB_STATES.INDETERMINATE }),
    });
  });

  test('fails closed for multiple transition outboxes', async () => {
    const fixture = await readyFixture();
    const created = await enqueue(fixture);
    const claimed = await claimOutbox(fixture);
    const begun = await beginTransition(fixture, claimed);
    const raw = findLong(fixture.harness, 'invoice_outbox', 'outboxId', claimed.id);
    fixture.harness.seed('invoice_outbox', [{
      ...raw,
      _id: fixture.harness.nextObjectId(),
      outboxId: Long.fromNumber(99),
      action: 'CORRUPT_ACTION',
    }]);
    await expect(fixture.repository.findUnresolvedAuditOperation({
      companyId: begun.job.companyId,
      jobId: created.job.id,
      stage: 'FYND_TRANSITION',
    })).rejects.toEqual(safeError(
      'REPOSITORY_DATA_INVALID',
      'Invoice repository data is invalid',
    ));
  });
});

describe('Mongo combined lease recovery contract', () => {
  test('releases up to 100 jobs plus 100 outboxes in one transaction with independent ordering', async () => {
    const fixture = await readyFixture();
    const jobTemplate = await makeLocked(fixture, 'template-job');
    const outboxCreated = await enqueue(fixture, 'template-outbox');
    const outboxClaim = await claimOutbox(fixture);
    const expiredAt = new Date('2026-08-17T09:59:00.000Z');
    replaceLong(fixture.harness, 'invoice_jobs', 'jobId', jobTemplate.id, {
      leaseExpiresAt: expiredAt,
    });
    replaceLong(fixture.harness, 'invoice_outbox', 'outboxId', outboxClaim.id, {
      leaseExpiresAt: expiredAt,
    });
    const jobRaw = findLong(fixture.harness, 'invoice_jobs', 'jobId', jobTemplate.id);
    const outboxRaw = findLong(
      fixture.harness, 'invoice_outbox', 'outboxId', outboxClaim.id,
    );
    const parentRaw = findLong(
      fixture.harness, 'invoice_jobs', 'jobId', outboxCreated.job.id,
    );
    const jobs = fixture.harness.documents('invoice_jobs');
    const outboxes = fixture.harness.documents('invoice_outbox');
    for (let index = 0; index < 101; index += 1) {
      const jobId = 1000 + index;
      jobs.push({
        ...jobRaw,
        _id: fixture.harness.nextObjectId(),
        jobId: Long.fromNumber(jobId),
        shipmentId: `bulk-job-${index}`,
        documentNumber: `VR-bulk-job-${index}-1`,
      });
      const parentId = 2000 + index;
      jobs.push({
        ...parentRaw,
        _id: fixture.harness.nextObjectId(),
        jobId: Long.fromNumber(parentId),
        shipmentId: `bulk-outbox-${index}`,
        documentNumber: `VR-bulk-outbox-${index}-1`,
      });
      outboxes.push({
        ...outboxRaw,
        _id: fixture.harness.nextObjectId(),
        outboxId: Long.fromNumber(3000 + index),
        jobId: Long.fromNumber(parentId),
        payloadJson: JSON.stringify({
          shipmentId: `bulk-outbox-${index}`,
          documentNumber: `VR-bulk-outbox-${index}-1`,
        }),
      });
    }
    fixture.harness.replaceDocuments('invoice_jobs', jobs);
    fixture.harness.replaceDocuments('invoice_outbox', outboxes);

    const result = await fixture.repository.releaseExpiredLeases(NOW);

    expect(result).toEqual({ jobs: 100, outbox: 100 });
    expect(fixture.harness.documents('invoice_jobs').filter(row => row.leaseOwner !== null))
      .toHaveLength(2);
    expect(fixture.harness.documents('invoice_outbox').filter(row => row.leaseOwner !== null))
      .toHaveLength(2);
    expect(fixture.harness.trace.transactionOptions.at(-1)).toEqual({
      readPreference: 'primary',
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      timeoutMS: MONGO_TRANSACTION_TIMEOUT_MS,
    });
  });

  test('divergent outbox parent aborts and rolls back the whole combined batch', async () => {
    const fixture = await readyFixture();
    const job = await makeLocked(fixture, 'recover-job');
    const created = await enqueue(fixture, 'recover-outbox');
    const claimed = await claimOutbox(fixture);
    const expiredAt = new Date('2026-08-17T09:59:00.000Z');
    replaceLong(fixture.harness, 'invoice_jobs', 'jobId', job.id, {
      leaseExpiresAt: expiredAt,
    });
    replaceLong(fixture.harness, 'invoice_outbox', 'outboxId', claimed.id, {
      leaseExpiresAt: expiredAt,
    });
    replaceLong(fixture.harness, 'invoice_jobs', 'jobId', created.job.id, {
      version: created.job.version + 1,
    });
    const before = mutationState(fixture.harness);
    await expect(fixture.repository.releaseExpiredLeases(NOW)).rejects.toEqual(safeError(
      'REPOSITORY_VERSION_CONFLICT',
      'Invoice repository record changed concurrently',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('skips missing-field partial leases while retaining fail-closed complete lease decoding', async () => {
    const fixture = await readyFixture();
    const job = await makeLocked(fixture, 'partial-job-lease');
    await enqueue(fixture, 'partial-outbox-lease');
    const claimed = await claimOutbox(fixture);
    const expiredAt = new Date('2026-08-17T09:59:00.000Z');
    replaceLong(fixture.harness, 'invoice_jobs', 'jobId', job.id, {
      leaseExpiresAt: expiredAt,
    });
    replaceLong(fixture.harness, 'invoice_outbox', 'outboxId', claimed.id, {
      leaseExpiresAt: expiredAt,
    });
    fixture.harness.replaceDocuments('invoice_jobs', fixture.harness.documents('invoice_jobs')
      .map(row => {
        if (!Long.isLong(row.jobId) || !row.jobId.equals(Long.fromNumber(job.id))) return row;
        const partial = { ...row };
        delete partial.leaseOwner;
        return partial;
      }));
    fixture.harness.replaceDocuments('invoice_outbox', fixture.harness.documents('invoice_outbox')
      .map(row => {
        if (!Long.isLong(row.outboxId) || !row.outboxId.equals(Long.fromNumber(claimed.id))) return row;
        const partial = { ...row };
        delete partial.leaseOwner;
        return partial;
      }));
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.releaseExpiredLeases(NOW)).resolves.toEqual({
      jobs: 0,
      outbox: 0,
    });
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('rolls back recovery when a valid-shaped job post-image drifts', async () => {
    const fixture = await readyFixture();
    const job = await makeLocked(fixture, 'recover-job-post-image');
    const expiredAt = new Date('2026-08-17T09:59:00.000Z');
    replaceLong(fixture.harness, 'invoice_jobs', 'jobId', job.id, {
      leaseExpiresAt: expiredAt,
    });
    const raw = findLong(fixture.harness, 'invoice_jobs', 'jobId', job.id);
    fixture.harness.returnNext('invoice_jobs', 'findOneAndUpdate', {
      ...raw,
      documentNumber: 'VR-driver-recovery-drift-1',
      leaseOwner: null,
      leaseExpiresAt: null,
      version: job.version + 1,
      updatedAt: new Date(NOW),
    });
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.releaseExpiredLeases(NOW)).rejects.toEqual(safeError(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('rolls back recovery when a valid-shaped outbox post-image drifts', async () => {
    const fixture = await readyFixture();
    await enqueue(fixture, 'recover-outbox-post-image');
    const claimed = await claimOutbox(fixture);
    const expiredAt = new Date('2026-08-17T09:59:00.000Z');
    replaceLong(fixture.harness, 'invoice_outbox', 'outboxId', claimed.id, {
      leaseExpiresAt: expiredAt,
    });
    const raw = findLong(fixture.harness, 'invoice_outbox', 'outboxId', claimed.id);
    fixture.harness.returnNext('invoice_outbox', 'findOneAndUpdate', {
      ...raw,
      payloadJson: JSON.stringify({
        shipmentId: 'shipment-driver-recovery-drift',
        documentNumber: 'VR-driver-recovery-drift-1',
      }),
      leaseOwner: null,
      leaseExpiresAt: null,
      version: claimed.version + 1,
    });
    const before = mutationState(fixture.harness);

    await expect(fixture.repository.releaseExpiredLeases(NOW)).rejects.toEqual(safeError(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('outbox CAS or audit failure rolls back both recovery classes', async () => {
    for (const failure of ['cas', 'audit']) {
      const fixture = await readyFixture();
      const job = await makeLocked(fixture, `rollback-job-${failure}`);
      await enqueue(fixture, `rollback-outbox-${failure}`);
      const claimed = await claimOutbox(fixture);
      const expiredAt = new Date('2026-08-17T09:59:00.000Z');
      replaceLong(fixture.harness, 'invoice_jobs', 'jobId', job.id, {
        leaseExpiresAt: expiredAt,
      });
      replaceLong(fixture.harness, 'invoice_outbox', 'outboxId', claimed.id, {
        leaseExpiresAt: expiredAt,
      });
      if (failure === 'cas') {
        fixture.harness.returnNext('invoice_outbox', 'findOneAndUpdate', null);
      } else {
        fixture.harness.returnNext('shipment_audit_events', 'insertOne', {
          acknowledged: false,
          insertedId: null,
        });
      }
      const before = mutationState(fixture.harness);
      await expect(fixture.repository.releaseExpiredLeases(NOW)).rejects.toEqual(
        expect.objectContaining({
          code: failure === 'cas' ? 'REPOSITORY_VERSION_CONFLICT' : 'REPOSITORY_DATA_INVALID',
        }),
      );
      expect(mutationState(fixture.harness)).toEqual(before);
    }
  });
});
