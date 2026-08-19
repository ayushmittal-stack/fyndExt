'use strict';

const { createHash } = require('crypto');

const { EinvoiceError } = require('../../src/einvoice/errors');
const { createInvoiceWorkflow } = require('../../src/einvoice/invoice-workflow');
const { parseOeisB2cResponse } = require('../../src/einvoice/response-parser');
const {
  createAuditEvent,
  createEventKey,
  createOperationKey,
  sanitizeOeisSummary,
} = require('../../src/einvoice/audit/audit-contract');
const {
  JOB_STATES,
  OUTBOX_STATUSES,
} = require('../../src/einvoice/repositories/invoice-repository');
const {
  createMongoInvoiceRepository,
} = require('../../src/einvoice/repositories/mongo-invoice-repository');
const { createMongoRepositoryHarness } = require('../utils/mongo-repository-harness');
const {
  SIGNED_XML,
  SIGNED_XML_BASE64,
  makeOeisB2cSuccess,
} = require('../fixtures/einvoice/oeis');

const NOW = new Date('2026-08-17T10:00:00.000Z');
const JOB_LEASE = '2026-08-17T10:05:00.000Z';
const OUTBOX_LEASE = '2026-08-17T10:06:00.000Z';
const XML_SHA256 = createHash('sha256').update(Buffer.from(SIGNED_XML, 'utf8')).digest('hex');

function eventRecord(suffix) {
  return {
    eventId: `event-${suffix}`,
    companyId: 'company-1',
    applicationId: 'application-1',
    shipmentId: `shipment-${suffix}`,
    eventType: 'application/shipment/update/v1',
    status: 'bag_confirmed',
    receivedAt: '2026-08-17T09:59:00.000Z',
  };
}

function normalizedShipment(suffix) {
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

function oeisRequestJson(documentNumber) {
  return JSON.stringify([{
    TRAN_DOC_NO: documentNumber,
    TRAN_DOC_TYPE: 'IN',
    TRAN_LINE_NO: 1,
    INV_CURRENCY_CODE: 'SAR',
    INV_NET_AMOUNT: '100.00',
    INV_TOTAL_TAX_AMOUNT: '15.00',
    INV_TOTAL_AMOUNT: '115.00',
    TRAN_TAX_CODE_CATEGORY: 'S',
    TRAN_TAX_RATE: '15.00',
  }]);
}

function acceptedArtifact(job) {
  return {
    invoiceNumber: job.documentNumber,
    transactionNumber: 'transaction-1',
    uuid: '123e4567-e89b-12d3-a456-426614174000',
    invoiceCounter: '1',
    matchingKey: 'matching-key-1',
    responseStatus: 'OEIS_ACCEPTED_REPORTING_PENDING',
    signedXmlBase64: SIGNED_XML_BASE64,
    signedXml: SIGNED_XML,
    signedXmlSha256: XML_SHA256,
    qrCodeData: 'oeis-qr-code-data',
  };
}

async function createFixture() {
  const harness = createMongoRepositoryHarness();
  const repository = createMongoInvoiceRepository({
    db: harness.db,
    client: harness.client,
    now: () => new Date(NOW),
  });
  await repository.initialize();
  return { harness, repository };
}

async function makeLocked(fixture, suffix) {
  const accepted = await fixture.repository.acceptWebhook(
    eventRecord(suffix), normalizedShipment(suffix), false,
  );
  const claimed = await fixture.repository.claimNextJob('job-worker', JOB_LEASE);
  const requestJson = oeisRequestJson(claimed.documentNumber);
  const requestHash = createHash('sha256').update(requestJson, 'utf8').digest('hex');
  const prepared = await fixture.repository.savePreparedRequest(
    accepted.jobId, requestJson, requestHash, claimed.version,
  );
  return fixture.repository.markShipmentLocked(prepared.id, prepared.version);
}

async function makeClaimedOutbox(fixture, suffix) {
  const locked = await makeLocked(fixture, suffix);
  const artifact = acceptedArtifact(locked);
  await fixture.repository.markOeisAcceptedAndEnqueue(
    locked.id,
    artifact,
    { shipmentId: locked.shipmentId, documentNumber: locked.documentNumber },
    locked.version,
  );
  const outbox = await fixture.repository.claimNextOutbox('outbox-worker', OUTBOX_LEASE);
  return { locked, artifact, outbox };
}

async function beginPendingOeis(fixture, locked) {
  const operationKey = createOperationKey({
    targetKind: 'JOB',
    targetId: String(locked.id),
    expectedParentVersion: locked.version,
    attemptNumber: locked.attemptCount,
    stage: 'OEIS_SUBMISSION',
    action: 'OEIS_SUBMISSION_REQUESTED',
  });
  const event = createAuditEvent({
    eventKey: createEventKey({
      kind: 'OPERATION', operationKey, stage: 'OEIS_SUBMISSION',
      action: 'OEIS_SUBMISSION_REQUESTED', outcome: 'STARTED',
    }),
    operationKey,
    companyId: locked.companyId,
    applicationId: locked.applicationId,
    shipmentId: locked.shipmentId,
    jobId: locked.id,
    documentNumber: locked.documentNumber,
    stage: 'OEIS_SUBMISSION',
    action: 'OEIS_SUBMISSION_REQUESTED',
    outcome: 'STARTED',
    attemptNumber: locked.attemptCount,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: sanitizeOeisSummary('REQUEST', {
      documentNumber: locked.documentNumber,
      documentType: 'IN',
      lineCount: 1,
      currency: 'SAR',
      netAmount: '100.00',
      taxAmount: '15.00',
      totalAmount: '115.00',
      taxSummaries: [{ category: 'S', rate: '15.00', reasonCode: null, lineCount: 1 }],
      requestByteCount: Buffer.byteLength(locked.oeisRequestJson, 'utf8'),
      requestSha256: locked.requestHash,
      endpointPath: '/API/V2/Transaction/UpdateInvoiceData',
      attemptNumber: locked.attemptCount,
      timeoutMs: 30_000,
    }),
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(NOW) });
  const recovery = await fixture.repository.beginExternalOperation({
    targetKind: 'JOB',
    targetId: locked.id,
    expectedVersion: locked.version,
    event,
  });
  return {
    operationKey,
    recovery,
    job: await fixture.repository.getJob(locked.id),
  };
}

function clock() {
  let tick = 0;
  return () => new Date(NOW.getTime() + (tick++ * 10));
}

function retryPlan({ exhausted = false, overLimit = false } = {}) {
  return {
    exhausted,
    overLimit,
    retryDelayMs: jest.fn(() => 1_000),
  };
}

function workflowFor(repository, {
  transitionError = new EinvoiceError(
    'FYND_TIMEOUT', 'private transition timeout', { retryable: true },
  ),
  shipmentRead,
} = {}) {
  return createInvoiceWorkflow({
    repository,
    buildPayload: jest.fn(),
    oeisClient: { submit: jest.fn() },
    parseResponse: jest.fn(),
    fyndClient: {
      lockShipment: jest.fn(),
      getShipment: jest.fn(async () => {
        if (shipmentRead instanceof Error) throw shipmentRead;
        return shipmentRead;
      }),
      transitionToInvoiced: jest.fn(async () => { throw transitionError; }),
    },
    now: clock(),
    oeisAudit: {
      endpointPath: '/API/V2/Transaction/UpdateInvoiceData',
      timeoutMs: 30_000,
    },
  });
}

function oeisWorkflowFor(repository, body) {
  const submit = jest.fn(async () => ({
    httpStatus: 200,
    body,
    responseByteCount: null,
    responseSha256: null,
  }));
  return {
    submit,
    workflow: createInvoiceWorkflow({
      repository,
      buildPayload: jest.fn(),
      oeisClient: { submit },
      parseResponse: parseOeisB2cResponse,
      fyndClient: {
        lockShipment: jest.fn(),
        getShipment: jest.fn(),
        transitionToInvoiced: jest.fn(),
      },
      now: clock(),
      oeisAudit: {
        endpointPath: '/API/V2/Transaction/UpdateInvoiceData',
        timeoutMs: 30_000,
      },
    }),
  };
}

function shipmentEvents(harness, shipmentId) {
  return harness.documents('shipment_audit_events')
    .filter(event => event.shipmentId === shipmentId);
}

describe('invoice workflow across the real Mongo repository boundary', () => {
  test.each([
    {
      name: 'retryable confirmed prestate',
      suffix: 'transition-retry',
      plan: { exhausted: false, overLimit: false },
      shipmentRead: {
        shipmentId: 'shipment-transition-retry',
        status: 'bag_confirmed',
        locked: true,
        invoiceId: undefined,
        meta: undefined,
        responseStatus: null,
      },
      expectedOutbox: OUTBOX_STATUSES.RETRY_WAIT,
      expectedJob: JOB_STATES.FYND_TRANSITION_PENDING,
      expectedOriginal: {
        outcome: 'TIMEOUT',
        safeCode: 'FYND_TIMEOUT',
        finalStateClassification: 'UNKNOWN',
        retryable: true,
      },
      expectedReadback: {
        outcome: 'SUCCESS',
        finalStateClassification: 'UNCHANGED',
        locked: true,
        shipmentState: 'bag_confirmed',
      },
    },
    {
      name: 'exhausted confirmed prestate',
      suffix: 'transition-exhausted',
      plan: { exhausted: true, overLimit: false },
      shipmentRead: {
        shipmentId: 'shipment-transition-exhausted',
        status: 'bag_confirmed',
        locked: true,
        invoiceId: undefined,
        meta: undefined,
        responseStatus: null,
      },
      expectedOutbox: OUTBOX_STATUSES.INDETERMINATE,
      expectedJob: JOB_STATES.INDETERMINATE,
      expectedOriginal: {
        outcome: 'TIMEOUT',
        safeCode: 'FYND_TRANSITION_RETRY_EXHAUSTED',
        finalStateClassification: 'UNKNOWN',
        retryable: true,
      },
      expectedReadback: {
        outcome: 'SUCCESS',
        finalStateClassification: 'UNCHANGED',
        locked: true,
        shipmentState: 'bag_confirmed',
      },
    },
    {
      name: 'conflicting readback',
      suffix: 'transition-conflict',
      plan: { exhausted: false, overLimit: false },
      shipmentRead: {
        shipmentId: 'shipment-transition-conflict',
        status: 'bag_cancelled',
        locked: false,
        invoiceId: null,
        meta: null,
        responseStatus: null,
      },
      expectedOutbox: OUTBOX_STATUSES.INDETERMINATE,
      expectedJob: JOB_STATES.INDETERMINATE,
      expectedOriginal: {
        outcome: 'INDETERMINATE',
        safeCode: 'FYND_TRANSITION_STATE_INDETERMINATE',
        finalStateClassification: 'UNKNOWN',
        retryable: false,
      },
      expectedReadback: {
        outcome: 'SUCCESS',
        finalStateClassification: 'CONFLICTING',
        locked: null,
        shipmentState: null,
      },
    },
    {
      name: 'unreadable readback',
      suffix: 'transition-unreadable',
      plan: { exhausted: false, overLimit: false },
      shipmentRead: new EinvoiceError(
        'FYND_TIMEOUT', 'private readback timeout', { retryable: true },
      ),
      expectedOutbox: OUTBOX_STATUSES.INDETERMINATE,
      expectedJob: JOB_STATES.INDETERMINATE,
      expectedOriginal: {
        outcome: 'INDETERMINATE',
        safeCode: 'FYND_TRANSITION_STATE_INDETERMINATE',
        finalStateClassification: 'UNKNOWN',
        retryable: false,
      },
      expectedReadback: {
        outcome: 'TIMEOUT',
        finalStateClassification: 'UNREADABLE',
        locked: null,
        shipmentState: null,
      },
    },
  ])('persists separate direct-failure and GET evidence for $name', async scenario => {
    const fixture = await createFixture();
    const { outbox } = await makeClaimedOutbox(fixture, scenario.suffix);
    const workflow = workflowFor(fixture.repository, {
      shipmentRead: scenario.shipmentRead,
    });

    const result = await workflow.processOutbox(outbox, retryPlan(scenario.plan));

    const persistedOutbox = result.outbox || result;
    const persistedJob = result.job
      || await fixture.repository.getJob(outbox.jobId);
    expect(persistedOutbox.status).toBe(scenario.expectedOutbox);
    expect(persistedJob.state).toBe(scenario.expectedJob);

    const events = shipmentEvents(fixture.harness, `shipment-${scenario.suffix}`);
    const original = events.find(event => event.action === 'FYND_TRANSITION_FAILED');
    const readback = events.find(event => (
      event.action === 'FYND_TRANSITION_READBACK' && event.outcome !== 'STARTED'
    ));
    expect(original).toEqual(expect.objectContaining({
      outcome: scenario.expectedOriginal.outcome,
      safeCode: scenario.expectedOriginal.safeCode,
      responseSummary: expect.objectContaining({
        operation: 'TRANSITION',
        locked: null,
        shipmentState: null,
        finalStateClassification: scenario.expectedOriginal.finalStateClassification,
        retryable: scenario.expectedOriginal.retryable,
      }),
    }));
    expect(readback).toEqual(expect.objectContaining({
      outcome: scenario.expectedReadback.outcome,
      responseSummary: expect.objectContaining({
        operation: 'TRANSITION_READBACK',
        locked: scenario.expectedReadback.locked,
        shipmentState: scenario.expectedReadback.shipmentState,
        finalStateClassification: scenario.expectedReadback.finalStateClassification,
        retryable: false,
      }),
    }));
  });

  test('normalizes the real parser absent QR value before atomic Mongo artifact storage', async () => {
    const fixture = await createFixture();
    const locked = await makeLocked(fixture, 'parser-no-qr');
    const body = makeOeisB2cSuccess();
    body.InvoiceNumber = locked.documentNumber;
    const parsed = parseOeisB2cResponse(body);
    expect(Object.prototype.hasOwnProperty.call(parsed, 'qrCodeData')).toBe(true);
    expect(parsed.qrCodeData).toBeUndefined();
    const { workflow, submit } = oeisWorkflowFor(fixture.repository, body);

    const result = await workflow.processJob(locked, retryPlan());

    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.job.state).toBe(JOB_STATES.FYND_TRANSITION_PENDING);
    const stored = await fixture.repository.getArtifact(locked.id);
    expect(stored.qrCodeData).toBeNull();
    const artifactEvent = shipmentEvents(fixture.harness, locked.shipmentId)
      .find(event => event.action === 'OEIS_ARTIFACT_STORED');
    expect(artifactEvent.responseSummary).toEqual(expect.objectContaining({
      qrPresent: false,
      qrByteCount: null,
      qrSha256: null,
    }));
  });

  test('closes a non-TTL pending OEIS operation before over-limit terminalization', async () => {
    const fixture = await createFixture();
    const locked = await makeLocked(fixture, 'pending-oeis-over-limit');
    const pending = await beginPendingOeis(fixture, locked);
    const { workflow, submit } = oeisWorkflowFor(
      fixture.repository,
      makeOeisB2cSuccess(),
    );
    const plan = retryPlan({ exhausted: true, overLimit: true });

    const result = await workflow.processJob(pending.job, plan);

    expect(result.state).toBe(JOB_STATES.INDETERMINATE);
    expect(result.lastErrorCode).toBe('OEIS_PENDING_OPERATION_INDETERMINATE');
    expect(submit).not.toHaveBeenCalled();
    expect(plan.retryDelayMs).not.toHaveBeenCalled();
    await expect(fixture.repository.findUnresolvedAuditOperation({
      companyId: pending.job.companyId,
      jobId: pending.job.id,
      stage: 'OEIS_SUBMISSION',
    })).resolves.toBeNull();

    const terminal = shipmentEvents(fixture.harness, pending.job.shipmentId)
      .filter(event => ['OEIS_SUBMISSION_FAILED', 'JOB_INDETERMINATE'].includes(event.action));
    expect(terminal.map(event => [event.action, event.outcome, event.safeCode])).toEqual([
      [
        'OEIS_SUBMISSION_FAILED',
        'INDETERMINATE',
        'OEIS_PENDING_OPERATION_INDETERMINATE',
      ],
      ['JOB_INDETERMINATE', 'INDETERMINATE', 'OEIS_PENDING_OPERATION_INDETERMINATE'],
    ]);
    expect(terminal[0].operationKey).toBe(pending.operationKey);
    expect(terminal[1].operationKey).toBeNull();
  });
});
