'use strict';

const crypto = require('crypto');

const { EinvoiceError } = require('../../src/einvoice/errors');
const {
  createEventKey,
  createOperationKey,
} = require('../../src/einvoice/audit/audit-contract');
const { createTaxPolicyResolver } = require('../../src/einvoice/tax-policy-resolver');
const {
  JOB_STATES,
  OUTBOX_ACTIONS,
  OUTBOX_STATUSES,
} = require('../../src/einvoice/repositories/invoice-repository');
const { createInvoiceWorkflow } = require('../../src/einvoice/invoice-workflow');

const DOCUMENT = 'VR-shipment-1-1';
const OEIS_INVOICE = 'U_IN-119/2026/0000000001';
const LONG_OEIS_INVOICE = 'OEIS/2026/12345678901234567890';
const LONG_OEIS_INVOICE_CODE = 'OEIS-2026-123456789012345';
const WORKFLOW_NOW = new Date('2026-08-10T04:30:00.000Z');
const LOCKED_AT = '2026-08-10T04:35:00.000Z';
const LEASE_EXPIRES_AT = '2026-08-10T05:00:00.000Z';
const XML = '<?xml version="1.0"?><Invoice>synthetic</Invoice>';
const XML_BASE64 = Buffer.from(XML, 'utf8').toString('base64');
const XML_HASH = crypto.createHash('sha256').update(Buffer.from(XML, 'utf8')).digest('hex');
const QR_CODE_DATA = 'oeis-qr-code-data';

function requestBytes(documentNumber = DOCUMENT) {
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

function requestHash(bytes) {
  return crypto.createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function artifact(overrides = {}) {
  return {
    invoiceNumber: DOCUMENT,
    transactionNumber: 'txn-1',
    uuid: 'uuid-1',
    invoiceCounter: '1',
    matchingKey: 'matching-1',
    responseStatus: 'OEIS_ACCEPTED_REPORTING_PENDING',
    signedXmlBase64: XML_BASE64,
    signedXml: XML,
    signedXmlSha256: XML_HASH,
    ...overrides,
  };
}

function storedArtifactRecord(overrides = {}) {
  const stored = artifact({ jobId: 1, qrCodeData: QR_CODE_DATA, ...overrides });
  delete stored.signedXml;
  return stored;
}

function job(overrides = {}) {
  const bytes = requestBytes();
  return {
    id: 1,
    companyId: 'company-1',
    applicationId: 'application-1',
    shipmentId: 'shipment-1',
    documentType: 'IN',
    documentNumber: DOCUMENT,
    shipmentSnapshot: { shipmentId: 'shipment-1' },
    state: JOB_STATES.RECEIVED,
    oeisRequestJson: null,
    requestHash: null,
    lockedAt: null,
    attemptCount: 1,
    leaseOwner: 'worker-a',
    leaseExpiresAt: LEASE_EXPIRES_AT,
    version: 4,
    ...overrides,
  };
}

function transitionPendingJob(overrides = {}) {
  const bytes = requestBytes();
  return job({
    state: JOB_STATES.FYND_TRANSITION_PENDING,
    oeisRequestJson: bytes,
    requestHash: requestHash(bytes),
    lockedAt: LOCKED_AT,
    ...overrides,
  });
}

function outbox(overrides = {}) {
  return {
    id: 8,
    jobId: 1,
    action: OUTBOX_ACTIONS.FYND_TRANSITION,
    payload: {
      shipmentId: 'shipment-1', documentNumber: DOCUMENT,
      oeisInvoiceNumber: OEIS_INVOICE,
    },
    status: OUTBOX_STATUSES.PENDING,
    attemptCount: 1,
    leaseOwner: 'worker-a',
    leaseExpiresAt: LEASE_EXPIRES_AT,
    version: 2,
    ...overrides,
  };
}

function retryPlan({ exhausted = false, overLimit = false } = {}) {
  return {
    exhausted,
    overLimit,
    retryDelayMs: jest.fn(() => 1_800_000),
  };
}

function pendingRecovery(target, {
  targetKind = 'JOB',
  stage = 'FYND_LOCK',
  action = 'FYND_LOCK_REQUESTED',
  startedAt = '2026-08-10T04:29:00.000Z',
} = {}) {
  const operationKey = createOperationKey({
    targetKind,
    targetId: String(target.id),
    expectedParentVersion: Math.max(0, target.version - 1),
    attemptNumber: target.attemptCount,
    stage,
    action,
  });
  return Object.freeze({
    targetKind,
    targetId: String(target.id),
    operationKey,
    eventKey: createEventKey({
      kind: 'OPERATION', operationKey, stage, action, outcome: 'STARTED',
    }),
    stage,
    action,
    attemptNumber: target.attemptCount,
    startedAt,
    targetVersion: target.version,
  });
}

function preparedJobRecord(claimed, overrides = {}) {
  const bytes = requestBytes();
  return {
    ...claimed,
    state: JOB_STATES.LOCK_PENDING,
    oeisRequestJson: bytes,
    requestHash: requestHash(bytes),
    lockedAt: null,
    nextAttemptAt: claimed.nextAttemptAt ?? null,
    version: claimed.version + 1,
    ...overrides,
  };
}

function lockedJobRecord(claimed, overrides = {}) {
  return {
    ...claimed,
    state: JOB_STATES.LOCKED,
    lockedAt: LOCKED_AT,
    nextAttemptAt: claimed.nextAttemptAt ?? null,
    version: claimed.version + 2,
    ...overrides,
  };
}

function heldJobRecord(claimed, overrides = {}) {
  return {
    ...claimed,
    state: JOB_STATES.SUBMISSION_HELD,
    lockedAt: LOCKED_AT,
    nextAttemptAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    version: claimed.version + 2,
    ...overrides,
  };
}

function withNonPlainPrototype(value) {
  return Object.assign(Object.create({ inherited: true }), value);
}

function createRepository({ trace = [], initialJob = job(), storedArtifact = storedArtifactRecord() } = {}) {
  let currentJob = { ...initialJob };
  let currentArtifact = storedArtifact;
  let pendingOperation = null;
  const auditEvents = [];
  const calls = [];

  function persistAudit(events) {
    if (Array.isArray(events)) auditEvents.push(...events);
  }

  function recoveryFromEvent(targetKind, targetId, targetVersion, event) {
    return Object.freeze({
      targetKind,
      targetId: String(targetId),
      operationKey: event.operationKey,
      eventKey: event.eventKey,
      stage: event.stage,
      action: event.action,
      attemptNumber: event.attemptNumber,
      startedAt: event.startedAt,
      targetVersion,
    });
  }

  function updateJob(expectedVersion, changes) {
    expect(expectedVersion).toBe(currentJob.version);
    currentJob = { ...currentJob, ...changes, version: currentJob.version + 1 };
    return { ...currentJob };
  }

  const repository = {
    initialize: jest.fn(),
    acceptWebhook: jest.fn(),
    claimNextJob: jest.fn(),
    getJob: jest.fn(async id => {
      calls.push(['getJob', id]);
      return id === currentJob.id ? { ...currentJob } : null;
    }),
    appendAuditEvents: jest.fn(async events => {
      calls.push(['appendAuditEvents', events]);
      persistAudit(events);
    }),
    findUnresolvedAuditOperation: jest.fn(async ({ companyId, jobId, stage }) => {
      calls.push(['findUnresolvedAuditOperation', { companyId, jobId, stage }]);
      return pendingOperation && pendingOperation.stage === stage ? pendingOperation : null;
    }),
    beginExternalOperation: jest.fn(async ({ targetKind, targetId, expectedVersion, event }) => {
      calls.push(['beginExternalOperation', { targetKind, targetId, expectedVersion, event }]);
      if (pendingOperation) return pendingOperation;
      persistAudit([event]);
      const targetVersion = expectedVersion + 1;
      if (targetKind === 'JOB') {
        expect(Number(targetId)).toBe(currentJob.id);
        expect(expectedVersion).toBe(currentJob.version);
        currentJob = { ...currentJob, version: targetVersion };
      }
      pendingOperation = recoveryFromEvent(targetKind, targetId, targetVersion, event);
      return pendingOperation;
    }),
    savePreparedRequest: jest.fn(async (id, bytes, hash, version, events) => {
      trace.push('save-request');
      calls.push(['savePreparedRequest', id, bytes, hash, version, events]);
      persistAudit(events);
      return updateJob(version, {
        state: currentJob.state === JOB_STATES.DRY_RUN_RECEIVED
          ? JOB_STATES.DRY_RUN_LOCK_PENDING
          : JOB_STATES.LOCK_PENDING,
        oeisRequestJson: bytes,
        requestHash: hash,
        nextAttemptAt: currentJob.nextAttemptAt ?? null,
      });
    }),
    markShipmentLocked: jest.fn(async (id, version, events) => {
      trace.push('mark-locked');
      calls.push(['markShipmentLocked', id, version, events]);
      persistAudit(events);
      pendingOperation = null;
      const dryRun = [
        JOB_STATES.DRY_RUN_LOCK_PENDING,
        JOB_STATES.DRY_RUN_RETRY_WAIT,
      ].includes(currentJob.state);
      return updateJob(version, {
        state: dryRun ? JOB_STATES.SUBMISSION_HELD : JOB_STATES.LOCKED,
        lockedAt: LOCKED_AT,
        nextAttemptAt: currentJob.nextAttemptAt ?? null,
        ...(dryRun ? {
          nextAttemptAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        } : {}),
      });
    }),
    markOeisAcceptedAndEnqueue: jest.fn(async (id, value, reference, version, events) => {
      trace.push('artifact-and-outbox');
      calls.push(['markOeisAcceptedAndEnqueue', id, value, reference, version, events]);
      persistAudit(events);
      pendingOperation = null;
      currentArtifact = { ...value, jobId: id };
      delete currentArtifact.signedXml;
      currentJob = updateJob(version, { state: JOB_STATES.FYND_TRANSITION_PENDING });
      return { job: { ...currentJob }, outbox: outbox() };
    }),
    scheduleJobRetry: jest.fn(async (id, value, version, events) => {
      calls.push(['scheduleJobRetry', id, value, version, events]);
      persistAudit(events);
      pendingOperation = null;
      const dryRun = [
        JOB_STATES.DRY_RUN_RECEIVED,
        JOB_STATES.DRY_RUN_LOCK_PENDING,
        JOB_STATES.DRY_RUN_RETRY_WAIT,
      ].includes(currentJob.state);
      return updateJob(version, {
        state: dryRun ? JOB_STATES.DRY_RUN_RETRY_WAIT : JOB_STATES.RETRY_WAIT,
        ...value,
      });
    }),
    markJobFailed: jest.fn(async (id, code, message, version, events) => {
      calls.push(['markJobFailed', id, code, message, version, events]);
      persistAudit(events);
      pendingOperation = null;
      return updateJob(version, { state: JOB_STATES.DATA_FAILED, lastErrorCode: code });
    }),
    markJobIndeterminate: jest.fn(async (id, code, message, version, events) => {
      calls.push(['markJobIndeterminate', id, code, message, version, events]);
      persistAudit(events);
      pendingOperation = null;
      return updateJob(version, { state: JOB_STATES.INDETERMINATE, lastErrorCode: code });
    }),
    claimNextOutbox: jest.fn(),
    getArtifact: jest.fn(async id => {
      calls.push(['getArtifact', id]);
      return id === currentJob.id ? currentArtifact : null;
    }),
    scheduleOutboxRetry: jest.fn(async (id, value, version, events) => {
      calls.push(['scheduleOutboxRetry', id, value, version, events]);
      persistAudit(events);
      pendingOperation = null;
      return { ...outbox({ status: OUTBOX_STATUSES.RETRY_WAIT, version: version + 1 }), ...value };
    }),
    markOutboxIndeterminate: jest.fn(async (id, code, message, version, events) => {
      calls.push(['markOutboxIndeterminate', id, code, message, version, events]);
      persistAudit(events);
      pendingOperation = null;
      return { outbox: outbox({ status: OUTBOX_STATUSES.INDETERMINATE, version: version + 1 }) };
    }),
    completeOutboxAndJob: jest.fn(async (id, version, events) => {
      trace.push('complete');
      calls.push(['completeOutboxAndJob', id, version, events]);
      persistAudit(events);
      pendingOperation = null;
      return { outbox: outbox({ status: OUTBOX_STATUSES.COMPLETED, version: version + 1 }) };
    }),
    releaseExpiredLeases: jest.fn(),
    close: jest.fn(),
  };

  return {
    repository,
    calls,
    auditEvents,
    getJob: () => currentJob,
    getPending: () => pendingOperation,
  };
}

function createDeps({
  trace = [],
  initialJob,
  storedArtifact,
  buildResult,
  lockResult,
  shipmentRead,
  oeisResult,
  parsedArtifact,
  transitionResult,
  constantNow = false,
} = {}) {
  const repo = createRepository({ trace, initialJob, storedArtifact });
  const bytes = requestBytes();
  const deps = {
    repository: repo.repository,
    buildPayload: jest.fn(async () => {
      trace.push('build');
      if (buildResult instanceof Error) throw buildResult;
      return buildResult || {
        documentNumber: DOCUMENT,
        rows: JSON.parse(bytes),
        requestJson: bytes,
        requestHash: requestHash(bytes),
      };
    }),
    oeisClient: {
      submit: jest.fn(async submitted => {
        trace.push('oeis');
        if (oeisResult instanceof Error) throw oeisResult;
        return oeisResult || {
          httpStatus: 200,
          body: { synthetic: true },
          responseByteCount: null,
          responseSha256: null,
          submitted,
        };
      }),
    },
    parseResponse: jest.fn(async () => {
      trace.push('parse');
      if (parsedArtifact instanceof Error) throw parsedArtifact;
      return parsedArtifact || artifact();
    }),
    fyndClient: {
      lockShipment: jest.fn(async () => {
        trace.push('lock');
        if (lockResult instanceof Error) throw lockResult;
        return lockResult
          ? { responseStatus: null, ...lockResult }
          : { shipmentId: 'shipment-1', locked: true, responseStatus: null };
      }),
      getShipment: jest.fn(async () => {
        trace.push('readback');
        if (shipmentRead instanceof Error) throw shipmentRead;
        return shipmentRead
          ? { responseStatus: null, ...shipmentRead }
          : {
          shipmentId: 'shipment-1', status: 'bag_confirmed', locked: true,
          invoiceId: undefined, meta: undefined, responseStatus: null,
          };
      }),
      transitionToInvoiced: jest.fn(async () => {
        trace.push('fynd-transition');
        if (transitionResult instanceof Error) throw transitionResult;
        return transitionResult
          ? { responseStatus: null, ...transitionResult }
          : {
          shipmentId: 'shipment-1', status: 'bag_invoiced', responseStatus: null,
          };
      }),
    },
    now: constantNow ? jest.fn(() => new Date(WORKFLOW_NOW)) : (() => {
      let tick = 0;
      return jest.fn(() => new Date(WORKFLOW_NOW.getTime() + (tick++ * 10)));
    })(),
    oeisAudit: {
      endpointPath: '/API/V2/Transaction/UpdateInvoiceData',
      timeoutMs: 30_000,
    },
  };
  return { ...repo, deps, trace };
}

describe('invoice workflow job processing', () => {
  test('persists and uses every returned CAS version in the success order', async () => {
    const setup = createDeps();
    const workflow = createInvoiceWorkflow(setup.deps);

    await workflow.processJob(job(), retryPlan());

    expect(setup.trace).toEqual([
      'build', 'save-request', 'lock', 'mark-locked', 'oeis',
      'parse', 'artifact-and-outbox',
    ]);
    expect(setup.calls.filter(([name]) => name === 'savePreparedRequest')[0][4]).toBe(4);
    expect(setup.calls.filter(([name]) => name === 'markShipmentLocked')[0][2]).toBe(6);
    expect(setup.calls.filter(([name]) => name === 'markOeisAcceptedAndEnqueue')[0][4]).toBe(8);
    expect(setup.deps.oeisClient.submit).toHaveBeenCalledWith(requestBytes());
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });

  test('marks deterministic build validation failure before every external call', async () => {
    const error = new EinvoiceError('LINE_TOTAL_MISMATCH', 'sensitive details');
    const setup = createDeps({ buildResult: error });

    await createInvoiceWorkflow(setup.deps).processJob(job(), retryPlan());

    expect(setup.repository.markJobFailed).toHaveBeenCalledWith(
      1, 'LINE_TOTAL_MISMATCH', expect.any(String), 4, expect.any(Array),
    );
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
  });

  test('marks unresolved tax eligibility DATA_FAILED before Fynd lock without persisting identity', async () => {
    const error = new EinvoiceError(
      'TAX_ELIGIBILITY_IDENTITY_REQUIRED',
      'Healthcare buyer identity is required',
    );
    const setup = createDeps({ buildResult: error });

    const result = await createInvoiceWorkflow(setup.deps).processJob(job(), retryPlan());

    expect(result).toEqual(expect.objectContaining({
      state: JOB_STATES.DATA_FAILED,
      lastErrorCode: 'TAX_ELIGIBILITY_IDENTITY_REQUIRED',
    }));
    expect(setup.repository.markJobFailed).toHaveBeenCalledWith(
      1, 'TAX_ELIGIBILITY_IDENTITY_REQUIRED', 'Invoice data validation failed', 4,
      expect.any(Array),
    );
    expect(setup.repository.savePreparedRequest).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
  });

  test('marks ancient eligibility evidence DATA_FAILED before Fynd lock through the real resolver', async () => {
    const resolver = createTaxPolicyResolver({
      policyVersion: '2026-08-17',
      now: () => new Date('2026-08-17T12:00:00.000Z'),
    });
    const setup = createDeps();
    setup.deps.buildPayload.mockImplementationOnce(() => resolver.resolveLineTax({
      product: {
        code: 'SKU-HEALTH-01',
        uqc: 'OTH',
        supplyClass: 'PRIVATE_HEALTHCARE_SERVICE',
        allowedZeroRateReason: 'VATEX-SA-HEA',
      },
      eligibility: {
        governmentBorneVatEligible: true,
        reasonCode: 'VATEX-SA-HEA',
        evidenceReference: 'event-synthetic-hea-1',
        verifiedAt: '2000-01-01T00:00:00.000Z',
        buyerName: 'Synthetic Citizen',
        buyerNationalId: '1000000000',
      },
      financialBreakup: {
        netAmount: '267.00', taxRate: '0.00', taxAmount: '0.00', paidAmount: '267.00',
      },
    }));

    const result = await createInvoiceWorkflow(setup.deps).processJob(job(), retryPlan());

    expect(result).toEqual(expect.objectContaining({
      state: JOB_STATES.DATA_FAILED,
      lastErrorCode: 'TAX_ELIGIBILITY_EVIDENCE_INVALID',
    }));
    expect(setup.repository.markJobFailed).toHaveBeenCalledWith(
      1, 'TAX_ELIGIBILITY_EVIDENCE_INVALID', 'Invoice data validation failed', 4,
      expect.any(Array),
    );
    expect(setup.repository.savePreparedRequest).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
  });

  test('rejects a built document mismatch before saving or locking', async () => {
    const bytes = requestBytes('VR-other-1');
    const setup = createDeps({
      buildResult: {
        documentNumber: 'VR-other-1', rows: JSON.parse(bytes),
        requestJson: bytes, requestHash: requestHash(bytes),
      },
    });

    await createInvoiceWorkflow(setup.deps).processJob(job(), retryPlan());

    expect(setup.repository.markJobFailed).toHaveBeenCalledWith(
      1, 'DOCUMENT_IDENTITY_MISMATCH', expect.any(String), 4, expect.any(Array),
    );
    expect(setup.repository.savePreparedRequest).not.toHaveBeenCalled();
  });

  test('bubbles a repository failure before prepared bytes are saved without scheduling retry', async () => {
    const setup = createDeps();
    const storageError = new EinvoiceError('REPOSITORY_BUSY', 'database internals');
    setup.repository.savePreparedRequest.mockRejectedValueOnce(storageError);

    await expect(createInvoiceWorkflow(setup.deps).processJob(job(), retryPlan()))
      .rejects.toBe(storageError);

    expect(setup.repository.markJobFailed).not.toHaveBeenCalled();
    expect(setup.repository.scheduleJobRetry).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
  });

  test('never rebuilds a stored locked retry and submits the exact stored bytes', async () => {
    const bytes = `${requestBytes()} `;
    const claimed = job({
      state: JOB_STATES.RETRY_WAIT,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
      lockedAt: '2026-08-10T04:35:00.000Z',
      attemptCount: 2,
    });
    const setup = createDeps({ initialJob: claimed });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(setup.deps.buildPayload).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).toHaveBeenCalledWith(bytes);
  });

  test('never reclassifies or changes stored HEA request bytes on retry', async () => {
    const bytes = JSON.stringify([{
      TRAN_DOC_NO: DOCUMENT,
      TRAN_DOC_TYPE: 'IN',
      TRAN_LINE_NO: 1,
      INV_CURRENCY_CODE: 'SAR',
      INV_NET_AMOUNT: '267.00',
      INV_TOTAL_TAX_AMOUNT: '0.00',
      INV_TOTAL_AMOUNT: '267.00',
      TRAN_TAX_CODE_CATEGORY: 'Z',
      TRAN_TAX_RATE: '0.00',
      TRAN_VAT_EXEMPT_REASON_CODE: 'VATEX-SA-HEA',
      CUST_NAME_WALKIN: 'Synthetic Citizen',
      CUST_ADDITIONAL_ID_NO_WALKIN: '1000000000',
      CUST_ADDL_ID_TYP_WALKIN: 'NAT',
    }]);
    const claimed = job({
      state: JOB_STATES.RETRY_WAIT,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
      lockedAt: LOCKED_AT,
      attemptCount: 2,
    });
    const setup = createDeps({ initialJob: claimed });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(setup.deps.buildPayload).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).toHaveBeenCalledWith(bytes);
  });

  test.each([
    ['hash drift', job({ state: JOB_STATES.LOCKED, oeisRequestJson: requestBytes(), requestHash: '0'.repeat(64), lockedAt: LOCKED_AT })],
    ['empty rows', (() => { const bytes = '[]'; return job({ state: JOB_STATES.LOCKED, oeisRequestJson: bytes, requestHash: requestHash(bytes), lockedAt: LOCKED_AT }); })()],
    ['row document drift', (() => { const bytes = requestBytes('VR-other-1'); return job({ state: JOB_STATES.LOCKED, oeisRequestJson: bytes, requestHash: requestHash(bytes), lockedAt: LOCKED_AT }); })()],
  ])('marks stored %s indeterminate without an OEIS call', async (_case, claimed) => {
    const setup = createDeps({ initialJob: claimed });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(setup.repository.markJobIndeterminate).toHaveBeenCalledWith(
      1, 'STORED_REQUEST_INVALID', expect.any(String), claimed.version, expect.any(Array),
    );
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
  });

  test('makes an OEIS timeout terminal even when attempts remain', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCKED, oeisRequestJson: bytes, requestHash: requestHash(bytes),
      lockedAt: '2026-08-10T04:35:00.000Z', attemptCount: 2,
    });
    const plan = retryPlan();
    const setup = createDeps({
      initialJob: claimed,
      oeisResult: new EinvoiceError('OEIS_TIMEOUT', 'raw timeout', { retryable: true }),
    });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, plan);

    expect(setup.repository.markJobIndeterminate).toHaveBeenCalledWith(
      1, 'OEIS_TIMEOUT', expect.any(String), claimed.version + 1, expect.any(Array),
    );
    expect(setup.repository.scheduleJobRetry).not.toHaveBeenCalled();
    expect(plan.retryDelayMs).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).toHaveBeenCalledWith(bytes);
  });

  test('marks an exhausted OEIS 5xx indeterminate without consuming jitter', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCKED, oeisRequestJson: bytes, requestHash: requestHash(bytes),
      lockedAt: '2026-08-10T04:35:00.000Z', attemptCount: 5,
    });
    const plan = retryPlan({ exhausted: true });
    const setup = createDeps({
      initialJob: claimed,
      oeisResult: new EinvoiceError('OEIS_HTTP_5XX', 'raw response', { retryable: true }),
    });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, plan);

    expect(setup.repository.markJobIndeterminate).toHaveBeenCalledWith(
      1, 'OEIS_HTTP_5XX', expect.any(String), claimed.version + 1, expect.any(Array),
    );
    expect(plan.retryDelayMs).not.toHaveBeenCalled();
  });

  test.each([
    ['OEIS_HTTP_4XX', 'DATA_FAILED'],
    ['OEIS_REQUEST_TOO_LARGE', 'DATA_FAILED'],
    ['OEIS_RESPONSE_TOO_LARGE', 'INDETERMINATE'],
    ['OEIS_MALFORMED_RESPONSE', 'INDETERMINATE'],
  ])('classifies %s as %s and never enqueues a Fynd transition', async (code, expected) => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCKED, oeisRequestJson: bytes, requestHash: requestHash(bytes), lockedAt: LOCKED_AT,
    });
    const setup = createDeps({ initialJob: claimed, oeisResult: new EinvoiceError(code, 'raw') });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    const method = expected === 'DATA_FAILED' ? setup.repository.markJobFailed : setup.repository.markJobIndeterminate;
    expect(method).toHaveBeenCalled();
    expect(setup.repository.markOeisAcceptedAndEnqueue).not.toHaveBeenCalled();
  });

  test('marks OEIS semantic response failure indeterminate', async () => {
    const bytes = requestBytes();
    const claimed = job({ state: JOB_STATES.LOCKED, oeisRequestJson: bytes, requestHash: requestHash(bytes), lockedAt: LOCKED_AT });
    const setup = createDeps({
      initialJob: claimed,
      parsedArtifact: new EinvoiceError('OEIS_SIGNED_XML_INVALID', 'raw xml'),
    });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(setup.repository.markJobIndeterminate).toHaveBeenCalledWith(
      1, 'OEIS_SIGNED_XML_INVALID', expect.any(String), claimed.version + 1,
      expect.any(Array),
    );
  });

  test('marks an accepted artifact document mismatch indeterminate', async () => {
    const bytes = requestBytes();
    const claimed = job({ state: JOB_STATES.LOCKED, oeisRequestJson: bytes, requestHash: requestHash(bytes), lockedAt: LOCKED_AT });
    const setup = createDeps({ initialJob: claimed, parsedArtifact: artifact({ invoiceNumber: 'VR-other-1' }) });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(setup.repository.markJobIndeterminate).toHaveBeenCalledWith(
      1, 'OEIS_IDENTITY_MISMATCH', expect.any(String), claimed.version + 1,
      expect.any(Array),
    );
    expect(setup.repository.markOeisAcceptedAndEnqueue).not.toHaveBeenCalled();
  });

  test('marks accepted artifact hash drift indeterminate before persistence', async () => {
    const bytes = requestBytes();
    const claimed = job({ state: JOB_STATES.LOCKED, oeisRequestJson: bytes, requestHash: requestHash(bytes), lockedAt: LOCKED_AT });
    const setup = createDeps({ initialJob: claimed, parsedArtifact: artifact({ signedXmlSha256: '0'.repeat(64) }) });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(setup.repository.markJobIndeterminate).toHaveBeenCalledWith(
      1, 'OEIS_ARTIFACT_INVALID', expect.any(String), claimed.version + 1,
      expect.any(Array),
    );
    expect(setup.repository.markOeisAcceptedAndEnqueue).not.toHaveBeenCalled();
  });

  test.each([
    ['confirmed locked pristine', { shipmentId: 'shipment-1', status: 'bag_confirmed', locked: true }, 'locked'],
    ['confirmed unlocked pristine', { shipmentId: 'shipment-1', status: 'bag_confirmed', locked: false }, 'retry'],
    ['wrong status', { shipmentId: 'shipment-1', status: 'bag_packed', locked: true }, 'indeterminate'],
    ['invoice conflict', { shipmentId: 'shipment-1', status: 'bag_confirmed', locked: true, invoiceId: 'other' }, 'indeterminate'],
    ['metadata conflict', { shipmentId: 'shipment-1', status: 'bag_confirmed', locked: true, meta: { einvoice_info: {} } }, 'indeterminate'],
    ['missing lock', { shipmentId: 'shipment-1', status: 'bag_confirmed' }, 'indeterminate'],
    ['wrong shipment', { shipmentId: 'shipment-2', status: 'bag_confirmed', locked: true }, 'indeterminate'],
    ['failed readback', new EinvoiceError('FYND_NETWORK', 'raw', { retryable: true }), 'indeterminate'],
  ])('reconciles ambiguous lock readback: %s', async (_case, shipmentRead, outcome) => {
    const bytes = requestBytes();
    const claimed = job({ state: JOB_STATES.LOCK_PENDING, oeisRequestJson: bytes, requestHash: requestHash(bytes) });
    const setup = createDeps({
      initialJob: claimed,
      lockResult: new EinvoiceError('FYND_TIMEOUT', 'raw', { retryable: true }),
      shipmentRead,
    });
    const plan = retryPlan();

    await createInvoiceWorkflow(setup.deps).processJob(claimed, plan);

    expect(setup.deps.fyndClient.getShipment).toHaveBeenCalledTimes(1);
    if (outcome === 'locked') {
      expect(setup.repository.markShipmentLocked).toHaveBeenCalledWith(
        1, claimed.version + 1, expect.any(Array),
      );
      expect(setup.deps.oeisClient.submit).toHaveBeenCalled();
    } else if (outcome === 'retry') {
      expect(setup.repository.scheduleJobRetry).toHaveBeenCalled();
      expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    } else {
      expect(setup.repository.markJobIndeterminate).toHaveBeenCalled();
      expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    }
  });

  test('reconciles a reclaimed lock before issuing another mutation', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCK_PENDING, oeisRequestJson: bytes, requestHash: requestHash(bytes), attemptCount: 2,
    });
    const setup = createDeps({ initialJob: claimed });
    setup.repository.findUnresolvedAuditOperation
      .mockResolvedValueOnce(pendingRecovery(claimed));

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(setup.trace.slice(0, 3)).toEqual(['readback', 'mark-locked', 'oeis']);
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
  });

  test('marks an exhausted ambiguous lock indeterminate without consuming jitter', async () => {
    const bytes = requestBytes();
    const claimed = job({ state: JOB_STATES.LOCK_PENDING, oeisRequestJson: bytes, requestHash: requestHash(bytes), attemptCount: 5 });
    const setup = createDeps({
      initialJob: claimed,
      lockResult: new EinvoiceError('FYND_HTTP_429', 'raw', { retryable: true }),
      shipmentRead: { shipmentId: 'shipment-1', status: 'bag_confirmed', locked: false },
    });
    const plan = retryPlan({ exhausted: true });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, plan);

    expect(setup.repository.markJobIndeterminate).toHaveBeenCalledWith(
      1, 'FYND_LOCK_RETRY_EXHAUSTED', expect.any(String), claimed.version + 1,
      expect.any(Array),
    );
    expect(plan.retryDelayMs).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
  });

  test('bubbles the CAS failure after a remotely successful lock', async () => {
    const bytes = requestBytes();
    const claimed = job({ state: JOB_STATES.LOCK_PENDING, oeisRequestJson: bytes, requestHash: requestHash(bytes) });
    const setup = createDeps({ initialJob: claimed });
    const storageError = new EinvoiceError('REPOSITORY_VERSION_CONFLICT', 'database internals');
    setup.repository.markShipmentLocked.mockRejectedValueOnce(storageError);

    await expect(createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan()))
      .rejects.toBe(storageError);

    expect(setup.deps.fyndClient.lockShipment).toHaveBeenCalledTimes(1);
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
  });

  test('throws a safe data error without trusting the version when lock CAS returns an invalid stage', async () => {
    const bytes = requestBytes();
    const claimed = job({ state: JOB_STATES.LOCK_PENDING, oeisRequestJson: bytes, requestHash: requestHash(bytes) });
    const setup = createDeps({ initialJob: claimed });
    setup.repository.markShipmentLocked.mockResolvedValueOnce({
      ...claimed, state: JOB_STATES.LOCK_PENDING, version: claimed.version + 1,
    });
    await expect(createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan()))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_REPOSITORY_DATA_INVALID' }));

    expect(setup.repository.markJobIndeterminate).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
  });

  test('uses separate job and outbox claims to produce the complete success order', async () => {
    const trace = [];
    const setup = createDeps({ trace, parsedArtifact: artifact({ qrCodeData: QR_CODE_DATA }) });
    const workflow = createInvoiceWorkflow(setup.deps);

    await workflow.processJob(job(), retryPlan());
    await workflow.processOutbox(outbox(), retryPlan());

    expect(trace).toEqual([
      'build', 'save-request', 'lock', 'mark-locked', 'oeis',
      'parse', 'artifact-and-outbox', 'fynd-transition', 'complete',
    ]);
  });

  test('a stale duplicate claim cannot produce a second external mutation', async () => {
    const setup = createDeps();
    const workflow = createInvoiceWorkflow(setup.deps);
    const stale = job();

    await workflow.processJob(stale, retryPlan());
    const conflict = new EinvoiceError('REPOSITORY_VERSION_CONFLICT', 'raw');
    setup.repository.savePreparedRequest.mockRejectedValueOnce(conflict);
    await expect(workflow.processJob(stale, retryPlan())).rejects.toBe(conflict);

    expect(setup.deps.fyndClient.lockShipment).toHaveBeenCalledTimes(1);
    expect(setup.deps.oeisClient.submit).toHaveBeenCalledTimes(1);
  });
});

describe('repository-return authorization records', () => {
  test('holds a persisted dry-run job after a toggle change with no workflow flag', async () => {
    const claimed = job({ state: JOB_STATES.DRY_RUN_RECEIVED });
    const setup = createDeps({ initialJob: claimed });
    expect(setup.deps).not.toHaveProperty('dryRunEnabled');

    const result = await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(setup.trace).toEqual(['build', 'save-request', 'lock', 'mark-locked']);
    expect(result).toEqual(expect.objectContaining({
      state: JOB_STATES.SUBMISSION_HELD,
      lockedAt: LOCKED_AT,
      oeisRequestJson: requestBytes(),
      requestHash: requestHash(requestBytes()),
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      version: claimed.version + 3,
    }));
    expect(setup.getJob().state).toBe(JOB_STATES.SUBMISSION_HELD);
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });

  test.each([
    ['prepared', JOB_STATES.DRY_RUN_LOCK_PENDING, 1, ['lock', 'mark-locked']],
    ['retry', JOB_STATES.DRY_RUN_RETRY_WAIT, 2, ['readback', 'mark-locked']],
  ])('holds a claimed dry-run %s lock stage without reaching OEIS', async (
    _case, state, attemptCount, expectedTrace,
  ) => {
    const bytes = requestBytes();
    const claimed = job({
      state,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
      attemptCount,
      ...(state === JOB_STATES.DRY_RUN_RETRY_WAIT
        ? { nextAttemptAt: '2026-08-10T04:55:00.000Z' }
        : {}),
    });
    const setup = createDeps({ initialJob: claimed });
    if (state === JOB_STATES.DRY_RUN_RETRY_WAIT) {
      setup.repository.findUnresolvedAuditOperation
        .mockResolvedValueOnce(pendingRecovery(claimed));
    }

    const result = await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(setup.trace).toEqual(expectedTrace);
    expect(result).toEqual(expect.objectContaining({
      state: JOB_STATES.SUBMISSION_HELD,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    }));
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });

  test('persists a held dry-run record after an ambiguous lock reads back locked', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.DRY_RUN_LOCK_PENDING,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
    });
    const setup = createDeps({
      initialJob: claimed,
      lockResult: new EinvoiceError('FYND_TIMEOUT', 'raw', { retryable: true }),
    });

    const result = await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(setup.trace).toEqual(['lock', 'readback', 'mark-locked']);
    expect(result.state).toBe(JOB_STATES.SUBMISSION_HELD);
    expect(setup.repository.markShipmentLocked).toHaveBeenCalledWith(
      1, claimed.version + 1, expect.any(Array),
    );
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });

  test('rejects a changing dry-run repository Proxy before invoking its traps', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.DRY_RUN_LOCK_PENDING,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
    });
    const setup = createDeps({ initialJob: claimed });
    const target = heldJobRecord(claimed);
    let stateReads = 0;
    const changing = new Proxy(target, {
      get(value, property, receiver) {
        if (property === 'state') {
          stateReads += 1;
          return stateReads === 1 ? JOB_STATES.SUBMISSION_HELD : JOB_STATES.LOCKED;
        }
        return Reflect.get(value, property, receiver);
      },
    });
    setup.repository.markShipmentLocked.mockResolvedValueOnce(changing);
    setup.repository.markOeisAcceptedAndEnqueue.mockResolvedValueOnce({ unexpected: true });

    await expect(createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan()))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_REPOSITORY_DATA_INVALID' }));

    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(setup.repository.markOeisAcceptedAndEnqueue).not.toHaveBeenCalled();
    expect(stateReads).toBe(0);
  });

  test('rejects a repository return Proxy before invoking descriptor traps', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.DRY_RUN_LOCK_PENDING,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
    });
    const setup = createDeps({ initialJob: claimed });
    const descriptorReads = new Map();
    const returned = new Proxy(heldJobRecord(claimed), {
      getOwnPropertyDescriptor(value, property) {
        descriptorReads.set(property, (descriptorReads.get(property) || 0) + 1);
        return Reflect.getOwnPropertyDescriptor(value, property);
      },
    });
    setup.repository.markShipmentLocked.mockResolvedValueOnce(returned);

    await expect(createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan()))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_REPOSITORY_DATA_INVALID' }));

    expect(descriptorReads.size).toBe(0);
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
  });

  test('returns a stable snapshot when the repository-owned record later mutates', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.DRY_RUN_LOCK_PENDING,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
    });
    const setup = createDeps({ initialJob: claimed });
    const repositoryRecord = heldJobRecord(claimed);
    setup.repository.markShipmentLocked.mockResolvedValueOnce(repositoryRecord);

    const result = await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());
    repositoryRecord.state = JOB_STATES.LOCKED;
    repositoryRecord.leaseOwner = 'attacker';

    expect(result).not.toBe(repositoryRecord);
    expect(result.state).toBe(JOB_STATES.SUBMISSION_HELD);
    expect(result.leaseOwner).toBeNull();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
  });

  test.each([
    ['accessor field', claimed => {
      const returned = heldJobRecord(claimed);
      Object.defineProperty(returned, 'state', {
        configurable: true,
        enumerable: true,
        get() { return JOB_STATES.SUBMISSION_HELD; },
      });
      return returned;
    }],
    ['throwing descriptor trap', claimed => new Proxy(heldJobRecord(claimed), {
      getOwnPropertyDescriptor(value, property) {
        if (property === 'state') throw new Error('caller-controlled descriptor details');
        return Reflect.getOwnPropertyDescriptor(value, property);
      },
    })],
  ])('rejects a repository return with a required %s using only a safe error', async (
    _case, returned,
  ) => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.DRY_RUN_LOCK_PENDING,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
    });
    const setup = createDeps({ initialJob: claimed });
    setup.repository.markShipmentLocked.mockResolvedValueOnce(returned(claimed));

    await expect(createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan()))
      .rejects.toEqual(expect.objectContaining({
        code: 'WORKFLOW_REPOSITORY_DATA_INVALID',
        message: 'Invoice repository returned invalid data',
      }));

    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
  });

  test('holds an over-limit dry-run retry when readback confirms the remote lock', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.DRY_RUN_RETRY_WAIT,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
      nextAttemptAt: '2026-08-10T04:55:00.000Z',
      attemptCount: 6,
    });
    const setup = createDeps({
      initialJob: claimed,
      shipmentRead: {
        shipmentId: 'shipment-1', status: 'bag_confirmed', locked: true,
        invoiceId: undefined, meta: undefined,
      },
    });
    const plan = retryPlan({ exhausted: true, overLimit: true });
    setup.repository.findUnresolvedAuditOperation
      .mockResolvedValueOnce(pendingRecovery(claimed));

    const result = await createInvoiceWorkflow(setup.deps).processJob(claimed, plan);

    expect(setup.trace).toEqual(['readback', 'mark-locked']);
    expect(setup.deps.fyndClient.getShipment).toHaveBeenCalledTimes(1);
    expect(setup.repository.markShipmentLocked).toHaveBeenCalledWith(
      1, claimed.version, expect.any(Array),
    );
    expect(result).toEqual(expect.objectContaining({
      state: JOB_STATES.SUBMISSION_HELD,
      lockedAt: LOCKED_AT,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      version: claimed.version + 1,
    }));
    expect(setup.repository.markJobIndeterminate).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
    expect(plan.retryDelayMs).not.toHaveBeenCalled();
  });

  test('rejects an unsafe held CAS return after an over-limit locked readback', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.DRY_RUN_RETRY_WAIT,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
      nextAttemptAt: '2026-08-10T04:55:00.000Z',
      attemptCount: 6,
    });
    const setup = createDeps({
      initialJob: claimed,
      shipmentRead: {
        shipmentId: 'shipment-1', status: 'bag_confirmed', locked: true,
        invoiceId: undefined, meta: undefined,
      },
    });
    const unsafe = heldJobRecord(claimed, { version: claimed.version + 1 });
    Object.defineProperty(unsafe, 'state', {
      configurable: true,
      enumerable: true,
      get() { return JOB_STATES.SUBMISSION_HELD; },
    });
    setup.repository.markShipmentLocked.mockResolvedValueOnce(unsafe);
    setup.repository.findUnresolvedAuditOperation
      .mockResolvedValueOnce(pendingRecovery(claimed));

    await expect(createInvoiceWorkflow(setup.deps).processJob(
      claimed,
      retryPlan({ exhausted: true, overLimit: true }),
    )).rejects.toEqual(expect.objectContaining({
      code: 'WORKFLOW_REPOSITORY_DATA_INVALID',
      message: 'Invoice repository returned invalid data',
    }));

    expect(setup.repository.markShipmentLocked).toHaveBeenCalledWith(
      1, claimed.version, expect.any(Array),
    );
    expect(setup.repository.markJobIndeterminate).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });

  test('rejects a dry-run prepared return with the wrong version before locking', async () => {
    const claimed = job({ state: JOB_STATES.DRY_RUN_RECEIVED });
    const setup = createDeps({ initialJob: claimed });
    setup.repository.savePreparedRequest.mockResolvedValueOnce(preparedJobRecord(claimed, {
      state: JOB_STATES.DRY_RUN_LOCK_PENDING,
      version: claimed.version + 2,
    }));

    await expect(createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan()))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_REPOSITORY_DATA_INVALID' }));

    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });

  test.each([
    ['live state for dry input',
      job({ state: JOB_STATES.DRY_RUN_LOCK_PENDING }),
      claimed => lockedJobRecord(claimed)],
    ['held state for live input',
      job({ state: JOB_STATES.LOCK_PENDING }),
      claimed => heldJobRecord(claimed)],
    ['job identity drift on held return',
      job({ state: JOB_STATES.DRY_RUN_LOCK_PENDING }),
      claimed => heldJobRecord(claimed, { id: claimed.id + 1 })],
    ['version drift on held return',
      job({ state: JOB_STATES.DRY_RUN_LOCK_PENDING }),
      claimed => heldJobRecord(claimed, { version: claimed.version + 3 })],
    ['retained lease on held return',
      job({ state: JOB_STATES.DRY_RUN_LOCK_PENDING }),
      claimed => heldJobRecord(claimed, {
        leaseOwner: claimed.leaseOwner,
        leaseExpiresAt: claimed.leaseExpiresAt,
      })],
    ['retained retry time on held return',
      job({ state: JOB_STATES.DRY_RUN_RETRY_WAIT }),
      claimed => heldJobRecord(claimed, { nextAttemptAt: claimed.nextAttemptAt })],
    ['missing lock timestamp on held return',
      job({ state: JOB_STATES.DRY_RUN_LOCK_PENDING }),
      claimed => heldJobRecord(claimed, { lockedAt: null })],
    ['request bytes drift on held return',
      job({ state: JOB_STATES.DRY_RUN_LOCK_PENDING }),
      claimed => heldJobRecord(claimed, { oeisRequestJson: `${claimed.oeisRequestJson} ` })],
    ['request hash drift on held return',
      job({ state: JOB_STATES.DRY_RUN_LOCK_PENDING }),
      claimed => heldJobRecord(claimed, { requestHash: '0'.repeat(64) })],
  ])('rejects unauthorized lock persistence: %s', async (_case, claimedTemplate, returned) => {
    const bytes = requestBytes();
    const claimed = {
      ...claimedTemplate,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
      ...(claimedTemplate.state === JOB_STATES.DRY_RUN_RETRY_WAIT
        ? { nextAttemptAt: '2026-08-10T04:55:00.000Z', attemptCount: 2 }
        : {}),
    };
    const setup = createDeps({ initialJob: claimed });
    setup.repository.markShipmentLocked.mockResolvedValueOnce(returned(claimed));

    await expect(createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan()))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_REPOSITORY_DATA_INVALID' }));

    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
    expect(setup.repository.markOeisAcceptedAndEnqueue).not.toHaveBeenCalled();
  });

  test('rejects malformed retained nextAttemptAt when the claimed job omitted the field', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCK_PENDING,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
    });
    expect(claimed).not.toHaveProperty('nextAttemptAt');
    const setup = createDeps({ initialJob: claimed });
    setup.repository.markShipmentLocked.mockResolvedValueOnce(lockedJobRecord(claimed, {
      nextAttemptAt: 'not-an-instant',
    }));
    setup.repository.markOeisAcceptedAndEnqueue.mockResolvedValueOnce({ unexpected: true });

    await expect(createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan()))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_REPOSITORY_DATA_INVALID' }));

    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(setup.repository.markOeisAcceptedAndEnqueue).not.toHaveBeenCalled();
  });

  test.each([
    ['state', value => ({ ...value, state: JOB_STATES.LOCKED })],
    ['job id', value => ({ ...value, id: 2 })],
    ['company identity', value => ({ ...value, companyId: 'company-2' })],
    ['application identity', value => ({ ...value, applicationId: 'application-2' })],
    ['shipment identity', value => ({ ...value, shipmentId: 'shipment-2' })],
    ['document type', value => ({ ...value, documentType: 'CN' })],
    ['document number', value => ({ ...value, documentNumber: 'VR-other-1' })],
    ['attempt identity', value => ({ ...value, attemptCount: value.attemptCount + 1 })],
    ['request bytes', value => ({ ...value, oeisRequestJson: `${value.oeisRequestJson} ` })],
    ['request hash', value => ({ ...value, requestHash: '0'.repeat(64) })],
    ['version', value => ({ ...value, version: value.version + 1 })],
    ['locked timestamp', value => ({ ...value, lockedAt: LOCKED_AT })],
    ['lease owner', value => ({ ...value, leaseOwner: 'worker-b' })],
    ['lease expiry', value => ({ ...value, leaseExpiresAt: 'not-an-instant' })],
    ['prototype', value => withNonPlainPrototype(value)],
  ])('rejects malformed savePreparedRequest return: %s', async (_case, mutate) => {
    const claimed = job();
    const setup = createDeps({ initialJob: claimed });
    setup.repository.savePreparedRequest.mockResolvedValueOnce(
      mutate(preparedJobRecord(claimed)),
    );

    await expect(createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan()))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_REPOSITORY_DATA_INVALID' }));

    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(setup.repository.markJobIndeterminate).not.toHaveBeenCalled();
  });

  test.each([
    ['state', value => ({ ...value, state: JOB_STATES.LOCK_PENDING })],
    ['job id', value => ({ ...value, id: 2 })],
    ['company identity', value => ({ ...value, companyId: 'company-2' })],
    ['application identity', value => ({ ...value, applicationId: 'application-2' })],
    ['shipment identity', value => ({ ...value, shipmentId: 'shipment-2' })],
    ['document type', value => ({ ...value, documentType: 'CN' })],
    ['document number', value => ({ ...value, documentNumber: 'VR-other-1' })],
    ['attempt identity', value => ({ ...value, attemptCount: value.attemptCount + 1 })],
    ['request bytes', value => ({ ...value, oeisRequestJson: `${value.oeisRequestJson} ` })],
    ['request hash', value => ({ ...value, requestHash: '0'.repeat(64) })],
    ['version', value => ({ ...value, version: value.version + 1 })],
    ['missing locked timestamp', value => ({ ...value, lockedAt: null })],
    ['invalid locked timestamp', value => ({ ...value, lockedAt: 'not-an-instant' })],
    ['lease owner', value => ({ ...value, leaseOwner: 'worker-b' })],
    ['lease expiry', value => ({ ...value, leaseExpiresAt: 'not-an-instant' })],
    ['prototype', value => withNonPlainPrototype(value)],
  ])('rejects malformed markShipmentLocked return: %s', async (_case, mutate) => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCK_PENDING,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
    });
    const setup = createDeps({ initialJob: claimed });
    setup.repository.markShipmentLocked.mockResolvedValueOnce(
      mutate(lockedJobRecord(claimed)),
    );

    await expect(createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan()))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_REPOSITORY_DATA_INVALID' }));

    expect(setup.deps.fyndClient.lockShipment).toHaveBeenCalledTimes(1);
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(setup.repository.markJobIndeterminate).not.toHaveBeenCalled();
  });
});

describe('invoice workflow outbox processing', () => {
  function pendingJob(overrides = {}) {
    return transitionPendingJob(overrides);
  }

  test('validates the persisted artifact, transitions, and completes in exact order', async () => {
    const trace = [];
    const setup = createDeps({ trace, initialJob: pendingJob() });

    await createInvoiceWorkflow(setup.deps).processOutbox(outbox(), retryPlan());

    expect(trace).toEqual(['fynd-transition', 'complete']);
    expect(setup.deps.fyndClient.transitionToInvoiced).toHaveBeenCalledWith({
      companyId: 'company-1', shipmentId: 'shipment-1', documentNumber: DOCUMENT,
      invoiceNumber: OEIS_INVOICE,
      qrCodeData: QR_CODE_DATA, signedXml: XML,
    });
    expect(setup.repository.completeOutboxAndJob).toHaveBeenCalledWith(
      8, 3, expect.any(Array),
    );
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
  });

  test('accepts fresh parser output without a repository jobId and persists it', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCKED,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
      lockedAt: LOCKED_AT,
    });
    const fresh = artifact();
    expect(Object.prototype.hasOwnProperty.call(fresh, 'jobId')).toBe(false);
    const setup = createDeps({ initialJob: claimed, parsedArtifact: fresh });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(setup.repository.markOeisAcceptedAndEnqueue).toHaveBeenCalledWith(
      1, { ...fresh, qrCodeData: null },
      { shipmentId: 'shipment-1', documentNumber: DOCUMENT },
      claimed.version + 1, expect.any(Array),
    );
  });

  test.each([
    ['action', outbox({ action: 'UNKNOWN' }), storedArtifactRecord()],
    ['payload shipment', outbox({ payload: { shipmentId: 'shipment-2', documentNumber: DOCUMENT } }), storedArtifactRecord()],
    ['payload extras', outbox({ payload: { shipmentId: 'shipment-1', documentNumber: DOCUMENT, signedXml: 'unexpected' } }), storedArtifactRecord()],
    ['missing artifact job identity', outbox(), artifact()],
    ['cross-job artifact identity', outbox(), storedArtifactRecord({ jobId: 2 })],
    ['invoice identity', outbox(), storedArtifactRecord({ invoiceNumber: 'VR-other-1' })],
    ['noncanonical Base64', outbox(), storedArtifactRecord({ signedXmlBase64: `${XML_BASE64}\n` })],
    ['artifact hash', outbox(), storedArtifactRecord({ signedXmlSha256: '0'.repeat(64) })],
    ['artifact status', outbox(), storedArtifactRecord({ responseStatus: 'UNKNOWN' })],
    ['missing QR data', outbox(), storedArtifactRecord({ qrCodeData: null })],
    ['artifact prototype', outbox(), withNonPlainPrototype(storedArtifactRecord())],
    ['inherited artifact job identity', outbox(), Object.assign(Object.create({ jobId: 1 }), artifact())],
  ])('marks stored outbox %s corruption indeterminate without calling Fynd', async (_case, claimed, stored) => {
    const setup = createDeps({ initialJob: pendingJob(), storedArtifact: stored });

    await createInvoiceWorkflow(setup.deps).processOutbox(claimed, retryPlan());

    expect(setup.repository.markOutboxIndeterminate).toHaveBeenCalledWith(
      claimed.id, 'OUTBOX_DATA_INVALID', expect.any(String), claimed.version,
      expect.any(Array),
    );
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });

  test.each([
    ['missing request bytes', { oeisRequestJson: null }],
    ['request hash drift', { requestHash: '0'.repeat(64) }],
    ['missing lock timestamp', { lockedAt: null }],
  ])('rejects stage-inconsistent transition job with %s', async (_case, mutation) => {
    const setup = createDeps({ initialJob: pendingJob(mutation) });

    await createInvoiceWorkflow(setup.deps).processOutbox(outbox(), retryPlan());

    expect(setup.repository.markOutboxIndeterminate).toHaveBeenCalledWith(
      8, 'OUTBOX_DATA_INVALID', expect.any(String), 2, expect.any(Array),
    );
    expect(setup.repository.getArtifact).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });

  test.each([
    ['complete exact state', {
      shipmentId: 'shipment-1', status: 'bag_invoiced', locked: false, invoiceId: DOCUMENT,
      meta: {
        einvoice_info: { invoice: { InvoiceNumber: OEIS_INVOICE, SignedQRCode: QR_CODE_DATA } },
        xml: { content: XML, filename: `${DOCUMENT}.xml` },
      },
    }, 'complete'],
    ['exact invoicing evidence after Fynd advances to DP assigned', {
      shipmentId: 'shipment-1', status: 'dp_assigned', locked: false, invoiceId: OEIS_INVOICE,
      meta: {
        einvoice_info: { invoice: { SignedQRCode: QR_CODE_DATA } },
        xml: { content: XML, filename: `${DOCUMENT}.xml` },
      },
    }, 'complete'],
    ['exact pre-state', { shipmentId: 'shipment-1', status: 'bag_confirmed', locked: true }, 'retry'],
    ['unlocked pre-state', { shipmentId: 'shipment-1', status: 'bag_confirmed', locked: false }, 'indeterminate'],
    ['partial invoice state', { shipmentId: 'shipment-1', status: 'bag_invoiced', locked: false, invoiceId: OEIS_INVOICE }, 'indeterminate'],
    ['wrong invoice', {
      shipmentId: 'shipment-1', status: 'bag_invoiced', locked: false, invoiceId: 'other',
      meta: { einvoice_info: { invoice: { SignedQRCode: QR_CODE_DATA } }, xml: { content: XML, filename: `${DOCUMENT}.xml` } },
    }, 'indeterminate'],
    ['wrong XML', {
      shipmentId: 'shipment-1', status: 'bag_invoiced', locked: false, invoiceId: OEIS_INVOICE,
      meta: { einvoice_info: { invoice: { SignedQRCode: QR_CODE_DATA } }, xml: { content: 'other', filename: `${DOCUMENT}.xml` } },
    }, 'indeterminate'],
    ['wrong QR', {
      shipmentId: 'shipment-1', status: 'bag_invoiced', locked: false, invoiceId: OEIS_INVOICE,
      meta: { einvoice_info: { invoice: { SignedQRCode: 'other' } }, xml: { content: XML, filename: `${DOCUMENT}.xml` } },
    }, 'indeterminate'],
    ['wrong filename', {
      shipmentId: 'shipment-1', status: 'bag_invoiced', locked: false, invoiceId: OEIS_INVOICE,
      meta: { einvoice_info: { invoice: { SignedQRCode: QR_CODE_DATA } }, xml: { content: XML, filename: 'other.xml' } },
    }, 'indeterminate'],
    ['failed readback', new EinvoiceError('FYND_NETWORK', 'raw', { retryable: true }), 'indeterminate'],
  ])('reconciles claimed outbox retry: %s', async (_case, shipmentRead, outcome) => {
    const claimed = outbox({ status: OUTBOX_STATUSES.RETRY_WAIT, attemptCount: 2 });
    const setup = createDeps({ initialJob: pendingJob(), shipmentRead });
    setup.repository.findUnresolvedAuditOperation.mockResolvedValueOnce(
      pendingRecovery(claimed, {
        targetKind: 'OUTBOX', stage: 'FYND_TRANSITION',
        action: 'FYND_TRANSITION_REQUESTED',
      }),
    );

    await createInvoiceWorkflow(setup.deps).processOutbox(claimed, retryPlan());

    expect(setup.deps.fyndClient.getShipment).toHaveBeenCalledTimes(1);
    if (outcome === 'complete') {
      expect(setup.repository.completeOutboxAndJob).toHaveBeenCalled();
      expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
    } else if (outcome === 'retry') {
      expect(setup.repository.scheduleOutboxRetry).toHaveBeenCalled();
      expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
    } else {
      expect(setup.repository.markOutboxIndeterminate).toHaveBeenCalled();
      expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
    }
  });

  test('reconciles the capped OEIS store ID with the full OEIS XML filename', async () => {
    const claimed = outbox({
      status: OUTBOX_STATUSES.RETRY_WAIT,
      attemptCount: 2,
      payload: {
        shipmentId: 'shipment-1',
        documentNumber: DOCUMENT,
        oeisInvoiceNumber: LONG_OEIS_INVOICE,
      },
    });
    const setup = createDeps({
      initialJob: pendingJob(),
      shipmentRead: {
        shipmentId: 'shipment-1',
        status: 'bag_invoiced',
        locked: false,
        invoiceId: LONG_OEIS_INVOICE_CODE,
        meta: {
          einvoice_info: {
            invoice: {
              InvoiceNumber: LONG_OEIS_INVOICE,
              SignedQRCode: QR_CODE_DATA,
            },
          },
          xml: { content: XML, filename: `${LONG_OEIS_INVOICE}.xml` },
        },
        responseStatus: null,
      },
    });
    setup.repository.findUnresolvedAuditOperation.mockResolvedValueOnce(
      pendingRecovery(claimed, {
        targetKind: 'OUTBOX',
        stage: 'FYND_TRANSITION',
        action: 'FYND_TRANSITION_REQUESTED',
      }),
    );

    await createInvoiceWorkflow(setup.deps).processOutbox(claimed, retryPlan());

    expect(setup.repository.completeOutboxAndJob).toHaveBeenCalled();
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', { SignedQRCode: QR_CODE_DATA }],
    ['different', { InvoiceNumber: 'other-oeis-invoice', SignedQRCode: QR_CODE_DATA }],
  ])('does not reconcile the new contract when the full OEIS invoice metadata is %s', async (_case, invoice) => {
    const claimed = outbox({
      status: OUTBOX_STATUSES.RETRY_WAIT,
      attemptCount: 2,
      payload: {
        shipmentId: 'shipment-1',
        documentNumber: DOCUMENT,
        oeisInvoiceNumber: LONG_OEIS_INVOICE,
      },
    });
    const setup = createDeps({
      initialJob: pendingJob(),
      shipmentRead: {
        shipmentId: 'shipment-1',
        status: 'bag_invoiced',
        locked: false,
        invoiceId: LONG_OEIS_INVOICE_CODE,
        meta: {
          einvoice_info: { invoice },
          xml: { content: XML, filename: `${LONG_OEIS_INVOICE}.xml` },
        },
        responseStatus: null,
      },
    });
    setup.repository.findUnresolvedAuditOperation.mockResolvedValueOnce(
      pendingRecovery(claimed, {
        targetKind: 'OUTBOX',
        stage: 'FYND_TRANSITION',
        action: 'FYND_TRANSITION_REQUESTED',
      }),
    );

    await createInvoiceWorkflow(setup.deps).processOutbox(claimed, retryPlan());

    expect(setup.repository.completeOutboxAndJob).not.toHaveBeenCalled();
    expect(setup.repository.markOutboxIndeterminate).toHaveBeenCalled();
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });

  test('reads back once after an ambiguous transition and schedules retry for exact pre-state', async () => {
    const setup = createDeps({
      initialJob: pendingJob(),
      transitionResult: new EinvoiceError('FYND_TRANSITION_RESPONSE_INVALID', 'raw'),
      shipmentRead: { shipmentId: 'shipment-1', status: 'bag_confirmed', locked: true },
    });
    const plan = retryPlan();

    await createInvoiceWorkflow(setup.deps).processOutbox(outbox(), plan);

    expect(setup.deps.fyndClient.getShipment).toHaveBeenCalledTimes(1);
    expect(setup.repository.scheduleOutboxRetry).toHaveBeenCalledWith(8, {
      errorCode: 'FYND_TRANSITION_RESPONSE_INVALID', safeMessage: expect.any(String),
      nextAttemptAt: '2026-08-10T05:00:00.030Z',
    }, 3, expect.any(Array));
    expect(plan.retryDelayMs).toHaveBeenCalledTimes(1);
  });

  test('completes after an ambiguous fresh transition when readback proves exact final state', async () => {
    const setup = createDeps({
      initialJob: pendingJob(),
      transitionResult: new EinvoiceError('FYND_NETWORK', 'raw', { retryable: true }),
      shipmentRead: {
        shipmentId: 'shipment-1', status: 'bag_invoiced', locked: false, invoiceId: OEIS_INVOICE,
        meta: {
          einvoice_info: { invoice: { SignedQRCode: QR_CODE_DATA } },
          xml: { content: XML, filename: `${DOCUMENT}.xml` },
        },
      },
    });

    await createInvoiceWorkflow(setup.deps).processOutbox(outbox(), retryPlan());

    expect(setup.deps.fyndClient.getShipment).toHaveBeenCalledTimes(1);
    expect(setup.repository.completeOutboxAndJob).toHaveBeenCalledWith(
      8, 3, expect.any(Array),
    );
    expect(setup.repository.scheduleOutboxRetry).not.toHaveBeenCalled();
  });

  test('marks an exhausted ambiguous transition indeterminate without consuming jitter', async () => {
    const setup = createDeps({
      initialJob: pendingJob(),
      transitionResult: new EinvoiceError('FYND_TIMEOUT', 'raw', { retryable: true }),
      shipmentRead: { shipmentId: 'shipment-1', status: 'bag_confirmed', locked: true },
    });
    const plan = retryPlan({ exhausted: true });

    await createInvoiceWorkflow(setup.deps).processOutbox(outbox({ attemptCount: 5 }), plan);

    expect(setup.repository.markOutboxIndeterminate).toHaveBeenCalledWith(
      8, 'FYND_TRANSITION_RETRY_EXHAUSTED', expect.any(String), 3,
      expect.any(Array),
    );
    expect(plan.retryDelayMs).not.toHaveBeenCalled();
  });

  test('fails closed on deterministic Fynd rejection without retry or separate unlock', async () => {
    const setup = createDeps({
      initialJob: pendingJob(),
      transitionResult: new EinvoiceError('FYND_HTTP_4XX', 'raw'),
    });

    await createInvoiceWorkflow(setup.deps).processOutbox(outbox(), retryPlan());

    expect(setup.repository.markOutboxIndeterminate).toHaveBeenCalledWith(
      8, 'FYND_HTTP_4XX', expect.any(String), 3, expect.any(Array),
    );
    expect(setup.repository.scheduleOutboxRetry).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.getShipment).not.toHaveBeenCalled();
  });

  test('bubbles repository read and completion failures without a second external call', async () => {
    const setup = createDeps({ initialJob: pendingJob() });
    const readError = new EinvoiceError('REPOSITORY_BUSY', 'raw');
    setup.repository.getArtifact.mockRejectedValueOnce(readError);
    await expect(createInvoiceWorkflow(setup.deps).processOutbox(outbox(), retryPlan()))
      .rejects.toBe(readError);
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();

    setup.repository.getArtifact.mockImplementationOnce(async () => storedArtifactRecord());
    const writeError = new EinvoiceError('REPOSITORY_TRANSACTION_UNKNOWN', 'raw');
    setup.repository.completeOutboxAndJob.mockRejectedValueOnce(writeError);
    await expect(createInvoiceWorkflow(setup.deps).processOutbox(outbox(), retryPlan()))
      .rejects.toBe(writeError);
    expect(setup.deps.fyndClient.transitionToInvoiced).toHaveBeenCalledTimes(1);
  });
});

describe('prototype and own-property hardening', () => {
  test('rejects an inherited claimed job before build or external calls', async () => {
    const inherited = Object.create(job());
    const setup = createDeps();

    await expect(createInvoiceWorkflow(setup.deps).processJob(inherited, retryPlan()))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_INPUT_INVALID' }));

    expect(setup.deps.buildPayload).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
  });

  test('converts a throwing claimed-job getter to a safe input error', async () => {
    const claimed = job();
    Object.defineProperty(claimed, 'id', {
      configurable: true,
      enumerable: true,
      get() { throw new Error('raw claimed-job secret'); },
    });
    const setup = createDeps();

    await expect(createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan()))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_INPUT_INVALID' }));
    expect(setup.deps.buildPayload).not.toHaveBeenCalled();
  });

  test('rejects inherited claimed outbox fields before repository reads', async () => {
    const inherited = Object.create(outbox());
    const setup = createDeps({ initialJob: transitionPendingJob() });

    await expect(createInvoiceWorkflow(setup.deps).processOutbox(inherited, retryPlan()))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_INPUT_INVALID' }));

    expect(setup.repository.getJob).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });

  test.each([
    ['non-plain getJob record', value => withNonPlainPrototype(value)],
    ['inherited getJob record', value => Object.create(value)],
    ['throwing getJob field', value => {
      Object.defineProperty(value, 'state', {
        configurable: true,
        enumerable: true,
        get() { throw new Error('raw getJob secret'); },
      });
      return value;
    }],
  ])('marks %s indeterminate using only the trusted outbox version', async (_case, mutate) => {
    const setup = createDeps({ initialJob: transitionPendingJob() });
    setup.repository.getJob.mockResolvedValueOnce(
      mutate(transitionPendingJob()),
    );

    await createInvoiceWorkflow(setup.deps).processOutbox(outbox(), retryPlan());

    expect(setup.repository.markOutboxIndeterminate.mock.calls[0].slice(0, 4)).toEqual([
      8, 'OUTBOX_DATA_INVALID', 'Stored invoice outbox data is invalid', 2,
    ]);
    expect(setup.repository.getArtifact).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });

  test('does not accept Object.prototype invoice identity for a stored request row', async () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'TRAN_DOC_NO');
    Object.defineProperty(Object.prototype, 'TRAN_DOC_NO', {
      configurable: true,
      enumerable: false,
      value: DOCUMENT,
    });
    const bytes = '[{}]';
    const claimed = job({
      state: JOB_STATES.LOCKED,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
      lockedAt: LOCKED_AT,
    });
    const setup = createDeps({ initialJob: claimed });
    try {
      await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());
    } finally {
      if (previous) Object.defineProperty(Object.prototype, 'TRAN_DOC_NO', previous);
      else delete Object.prototype.TRAN_DOC_NO;
    }

    expect(setup.repository.markJobIndeterminate).toHaveBeenCalledWith(
      1, 'STORED_REQUEST_INVALID', expect.any(String), claimed.version, expect.any(Array),
    );
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
  });

  test('rejects inherited pristine-state metadata instead of retrying a lock', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCK_PENDING,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
    });
    const shipment = Object.assign(Object.create({ meta: {} }), {
      shipmentId: 'shipment-1', status: 'bag_confirmed', locked: false,
    });
    const setup = createDeps({
      initialJob: claimed,
      lockResult: new EinvoiceError('FYND_TIMEOUT', 'raw', { retryable: true }),
      shipmentRead: shipment,
    });
    setup.deps.fyndClient.getShipment.mockResolvedValueOnce(shipment);

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(setup.repository.markJobIndeterminate).toHaveBeenCalledWith(
      1, 'FYND_LOCK_STATE_INDETERMINATE', expect.any(String), claimed.version + 1,
      expect.any(Array),
    );
    expect(setup.repository.scheduleJobRetry).not.toHaveBeenCalled();
  });

  test.each([
    ['meta container', () => Object.create({
      einvoice_info: { invoice: { SignedQRCode: QR_CODE_DATA } },
      xml: { content: XML, filename: `${DOCUMENT}.xml` },
    })],
    ['e-invoice container', () => ({
      einvoice_info: Object.create({ invoice: { SignedQRCode: QR_CODE_DATA } }),
      xml: { content: XML, filename: `${DOCUMENT}.xml` },
    })],
    ['invoice container', () => ({
      einvoice_info: { invoice: Object.create({ SignedQRCode: QR_CODE_DATA }) },
      xml: { content: XML, filename: `${DOCUMENT}.xml` },
    })],
    ['XML container', () => ({
      einvoice_info: { invoice: { SignedQRCode: QR_CODE_DATA } },
      xml: Object.create({ content: XML, filename: `${DOCUMENT}.xml` }),
    })],
  ])('does not complete from inherited transition %s', async (_case, createMeta) => {
    const claimed = outbox({ status: OUTBOX_STATUSES.RETRY_WAIT, attemptCount: 2 });
    const setup = createDeps({
      initialJob: transitionPendingJob(),
      shipmentRead: {
        shipmentId: 'shipment-1',
        status: 'bag_invoiced',
        locked: false,
        invoiceId: OEIS_INVOICE,
        meta: createMeta(),
      },
    });
    setup.repository.findUnresolvedAuditOperation.mockResolvedValueOnce(
      pendingRecovery(claimed, {
        targetKind: 'OUTBOX', stage: 'FYND_TRANSITION',
        action: 'FYND_TRANSITION_REQUESTED',
      }),
    );

    await createInvoiceWorkflow(setup.deps).processOutbox(claimed, retryPlan());

    expect(setup.repository.markOutboxIndeterminate).toHaveBeenCalledWith(
      8, 'FYND_TRANSITION_STATE_INDETERMINATE', expect.any(String), claimed.version,
      expect.any(Array),
    );
    expect(setup.repository.completeOutboxAndJob).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });

  test.each([
    ['SignedQRCode', 'SignedQRCode', QR_CODE_DATA, () => ({
      einvoice_info: { invoice: {} },
      xml: { content: XML, filename: `${DOCUMENT}.xml` },
    })],
    ['XML content', 'content', XML, () => ({
      einvoice_info: { invoice: { SignedQRCode: QR_CODE_DATA } },
      xml: { filename: `${DOCUMENT}.xml` },
    })],
    ['XML filename', 'filename', `${DOCUMENT}.xml`, () => ({
      einvoice_info: { invoice: { SignedQRCode: QR_CODE_DATA } },
      xml: { content: XML },
    })],
  ])('does not complete from inherited transition %s leaf', async (
    _case, property, value, createMeta,
  ) => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, property);
    Object.defineProperty(Object.prototype, property, {
      configurable: true,
      enumerable: false,
      value,
    });
    const claimed = outbox({ status: OUTBOX_STATUSES.RETRY_WAIT, attemptCount: 2 });
    const setup = createDeps({
      initialJob: transitionPendingJob(),
      shipmentRead: {
        shipmentId: 'shipment-1',
        status: 'bag_invoiced',
        locked: false,
        invoiceId: OEIS_INVOICE,
        meta: createMeta(),
      },
    });
    setup.repository.findUnresolvedAuditOperation.mockResolvedValueOnce(
      pendingRecovery(claimed, {
        targetKind: 'OUTBOX', stage: 'FYND_TRANSITION',
        action: 'FYND_TRANSITION_REQUESTED',
      }),
    );
    try {
      await createInvoiceWorkflow(setup.deps).processOutbox(claimed, retryPlan());
    } finally {
      if (previous) Object.defineProperty(Object.prototype, property, previous);
      else delete Object.prototype[property];
    }

    expect(setup.repository.markOutboxIndeterminate).toHaveBeenCalledWith(
      8, 'FYND_TRANSITION_STATE_INDETERMINATE', expect.any(String), claimed.version,
      expect.any(Array),
    );
    expect(setup.repository.completeOutboxAndJob).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });

  test('turns a throwing stored artifact getter into OUTBOX_DATA_INVALID', async () => {
    const stored = storedArtifactRecord();
    Object.defineProperty(stored, 'jobId', {
      configurable: true,
      enumerable: true,
      get() { throw new Error('raw artifact secret'); },
    });
    const setup = createDeps({
      initialJob: transitionPendingJob(),
      storedArtifact: stored,
    });

    await createInvoiceWorkflow(setup.deps).processOutbox(outbox(), retryPlan());

    expect(setup.repository.markOutboxIndeterminate).toHaveBeenCalledWith(
      8, 'OUTBOX_DATA_INVALID', expect.any(String), 2, expect.any(Array),
    );
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });
});

describe('over-limit retry control', () => {
  test('attempt six marks a RECEIVED job exhausted before build', async () => {
    const claimed = job({ attemptCount: 6 });
    const setup = createDeps({ initialJob: claimed });
    const plan = retryPlan({ exhausted: true, overLimit: true });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, plan);

    expect(setup.repository.markJobIndeterminate).toHaveBeenCalledWith(
      1, 'INVOICE_RETRY_EXHAUSTED', expect.any(String), claimed.version,
      expect.any(Array),
    );
    expect(setup.deps.buildPayload).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(plan.retryDelayMs).not.toHaveBeenCalled();
  });

  test('attempt six marks a locked OEIS-stage job exhausted without submitting', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.RETRY_WAIT,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
      lockedAt: LOCKED_AT,
      attemptCount: 6,
    });
    const setup = createDeps({ initialJob: claimed });
    const plan = retryPlan({ exhausted: true, overLimit: true });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, plan);

    expect(setup.repository.markJobIndeterminate).toHaveBeenCalledWith(
      1, 'OEIS_RETRY_EXHAUSTED', expect.any(String), claimed.version,
      expect.any(Array),
    );
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(plan.retryDelayMs).not.toHaveBeenCalled();
  });

  test('attempt six closes a pending OEIS intent before terminalization', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.RETRY_WAIT,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
      lockedAt: LOCKED_AT,
      attemptCount: 6,
    });
    const recovery = pendingRecovery(claimed, {
      stage: 'OEIS_SUBMISSION', action: 'OEIS_SUBMISSION_REQUESTED',
    });
    const setup = createDeps({ initialJob: claimed });
    const plan = retryPlan({ exhausted: true, overLimit: true });
    setup.repository.findUnresolvedAuditOperation.mockResolvedValueOnce(recovery);

    await createInvoiceWorkflow(setup.deps).processJob(claimed, plan);

    expect(setup.repository.findUnresolvedAuditOperation).toHaveBeenCalledWith({
      companyId: claimed.companyId, jobId: claimed.id, stage: 'OEIS_SUBMISSION',
    });
    const call = setup.repository.markJobIndeterminate.mock.calls[0];
    expect(call.slice(0, 4)).toEqual([
      claimed.id,
      'OEIS_PENDING_OPERATION_INDETERMINATE',
      'OEIS result is indeterminate',
      claimed.version,
    ]);
    expect(call[4].map(event => [event.action, event.outcome, event.safeCode])).toEqual([
      [
        'OEIS_SUBMISSION_FAILED',
        'INDETERMINATE',
        'OEIS_PENDING_OPERATION_INDETERMINATE',
      ],
      ['JOB_INDETERMINATE', 'INDETERMINATE', 'OEIS_PENDING_OPERATION_INDETERMINATE'],
    ]);
    expect(call[4][0].operationKey).toBe(recovery.operationKey);
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(plan.retryDelayMs).not.toHaveBeenCalled();
  });

  test('attempt six persists an exact locked readback before applying OEIS exhaustion', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.RETRY_WAIT,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
      lockedAt: null,
      attemptCount: 6,
    });
    const setup = createDeps({
      initialJob: claimed,
      shipmentRead: {
        shipmentId: 'shipment-1', status: 'bag_confirmed', locked: true,
        invoiceId: undefined, meta: undefined,
      },
    });
    const plan = retryPlan({ exhausted: true, overLimit: true });
    setup.repository.findUnresolvedAuditOperation
      .mockResolvedValueOnce(pendingRecovery(claimed));

    await createInvoiceWorkflow(setup.deps).processJob(claimed, plan);

    expect(setup.trace).toEqual(['readback', 'mark-locked']);
    expect(setup.deps.fyndClient.getShipment).toHaveBeenCalledTimes(1);
    expect(setup.repository.markShipmentLocked).toHaveBeenCalledWith(
      1, claimed.version, expect.any(Array),
    );
    expect(setup.repository.markJobIndeterminate).toHaveBeenCalledWith(
      1, 'OEIS_RETRY_EXHAUSTED', expect.any(String), claimed.version + 1,
      expect.any(Array),
    );
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(plan.retryDelayMs).not.toHaveBeenCalled();
  });

  test('attempt six exhausts an exact unlocked readback without an external mutation', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.RETRY_WAIT,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
      lockedAt: null,
      attemptCount: 6,
    });
    const setup = createDeps({
      initialJob: claimed,
      shipmentRead: {
        shipmentId: 'shipment-1', status: 'bag_confirmed', locked: false,
        invoiceId: undefined, meta: undefined,
      },
    });
    const plan = retryPlan({ exhausted: true, overLimit: true });
    setup.repository.findUnresolvedAuditOperation
      .mockResolvedValueOnce(pendingRecovery(claimed));

    await createInvoiceWorkflow(setup.deps).processJob(claimed, plan);

    expect(setup.deps.fyndClient.getShipment).toHaveBeenCalledTimes(1);
    expect(setup.repository.markJobIndeterminate).toHaveBeenCalledWith(
      1, 'FYND_LOCK_RETRY_EXHAUSTED', expect.any(String), claimed.version,
      expect.any(Array),
    );
    expect(setup.repository.markShipmentLocked).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(plan.retryDelayMs).not.toHaveBeenCalled();
  });

  test.each([
    ['conflicting', {
      shipmentId: 'shipment-1', status: 'bag_confirmed', locked: true,
      invoiceId: 'different-invoice', meta: undefined,
    }],
    ['unreadable', new EinvoiceError('FYND_NETWORK', 'raw', { retryable: true })],
  ])('attempt six marks the %s lock readback indeterminate', async (_case, shipmentRead) => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.RETRY_WAIT,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
      lockedAt: null,
      attemptCount: 6,
    });
    const setup = createDeps({ initialJob: claimed, shipmentRead });
    const plan = retryPlan({ exhausted: true, overLimit: true });
    setup.repository.findUnresolvedAuditOperation
      .mockResolvedValueOnce(pendingRecovery(claimed));

    await createInvoiceWorkflow(setup.deps).processJob(claimed, plan);

    expect(setup.deps.fyndClient.getShipment).toHaveBeenCalledTimes(1);
    expect(setup.repository.markJobIndeterminate).toHaveBeenCalledWith(
      1, 'FYND_LOCK_STATE_INDETERMINATE', expect.any(String), claimed.version,
      expect.any(Array),
    );
    expect(setup.repository.markJobIndeterminate.mock.calls.map(call => call[1]))
      .not.toContain('FYND_LOCK_RETRY_EXHAUSTED');
    expect(setup.repository.markShipmentLocked).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(plan.retryDelayMs).not.toHaveBeenCalled();
  });

  test('attempt six outbox readback may complete an already-finished transition', async () => {
    const claimed = outbox({ status: OUTBOX_STATUSES.RETRY_WAIT, attemptCount: 6 });
    const setup = createDeps({
      initialJob: transitionPendingJob(),
      shipmentRead: {
        shipmentId: 'shipment-1', status: 'bag_invoiced', locked: false, invoiceId: OEIS_INVOICE,
        meta: {
          einvoice_info: { invoice: { SignedQRCode: QR_CODE_DATA } },
          xml: { content: XML, filename: `${DOCUMENT}.xml` },
        },
      },
    });
    const plan = retryPlan({ exhausted: true, overLimit: true });
    setup.repository.findUnresolvedAuditOperation.mockResolvedValueOnce(
      pendingRecovery(claimed, {
        targetKind: 'OUTBOX', stage: 'FYND_TRANSITION',
        action: 'FYND_TRANSITION_REQUESTED',
      }),
    );

    await createInvoiceWorkflow(setup.deps).processOutbox(claimed, plan);

    expect(setup.repository.completeOutboxAndJob).toHaveBeenCalledWith(
      8, claimed.version, expect.any(Array),
    );
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
    expect(plan.retryDelayMs).not.toHaveBeenCalled();
  });

  test('attempt six outbox exact pre-state is exhausted without resending', async () => {
    const claimed = outbox({ status: OUTBOX_STATUSES.RETRY_WAIT, attemptCount: 6 });
    const setup = createDeps({
      initialJob: transitionPendingJob(),
      shipmentRead: {
        shipmentId: 'shipment-1', status: 'bag_confirmed', locked: true,
        invoiceId: undefined, meta: undefined,
      },
    });
    const plan = retryPlan({ exhausted: true, overLimit: true });
    setup.repository.findUnresolvedAuditOperation.mockResolvedValueOnce(
      pendingRecovery(claimed, {
        targetKind: 'OUTBOX', stage: 'FYND_TRANSITION',
        action: 'FYND_TRANSITION_REQUESTED',
      }),
    );

    await createInvoiceWorkflow(setup.deps).processOutbox(claimed, plan);

    expect(setup.repository.markOutboxIndeterminate).toHaveBeenCalledWith(
      8, 'FYND_TRANSITION_RETRY_EXHAUSTED', expect.any(String), claimed.version,
      expect.any(Array),
    );
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
    expect(plan.retryDelayMs).not.toHaveBeenCalled();
  });
});

describe('invoice workflow dependency validation', () => {
  test('rejects missing dependencies and malformed retry plans before side effects', async () => {
    expect(() => createInvoiceWorkflow()).toThrow(expect.objectContaining({ code: 'WORKFLOW_CONFIG_INVALID' }));
    const setup = createDeps();
    const workflow = createInvoiceWorkflow(setup.deps);
    await expect(workflow.processJob(job(), { exhausted: false, nextAttemptAt: null }))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_INPUT_INVALID' }));
    await expect(workflow.processJob(job(), {
      exhausted: false, nextAttemptAt: jest.fn(),
    })).rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_INPUT_INVALID' }));
    const inheritedPlan = Object.create({
      exhausted: false, overLimit: false, nextAttemptAt: jest.fn(),
    });
    await expect(workflow.processJob(job(), inheritedPlan))
      .rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_INPUT_INVALID' }));
    expect(setup.deps.buildPayload).not.toHaveBeenCalled();
  });

  test('converts a throwing dependency getter to a safe configuration error', () => {
    const setup = createDeps();
    const getter = jest.fn(() => {
      throw new Error('raw workflow configuration secret');
    });
    Object.defineProperty(setup.deps, 'buildPayload', {
      configurable: true,
      enumerable: true,
      get: getter,
    });

    expect(() => createInvoiceWorkflow(setup.deps))
      .toThrow(expect.objectContaining({ code: 'WORKFLOW_CONFIG_INVALID' }));
    expect(getter).not.toHaveBeenCalled();
  });

  test('rejects dependency and repository Proxies before invoking any trap', () => {
    const setup = createDeps();
    const dependencyTrap = jest.fn(() => {
      throw new Error('dependency proxy secret');
    });
    const repositoryTrap = jest.fn(() => {
      throw new Error('repository proxy secret');
    });

    expect(() => createInvoiceWorkflow(new Proxy(setup.deps, {
      get: dependencyTrap,
      getPrototypeOf: dependencyTrap,
      ownKeys: dependencyTrap,
      getOwnPropertyDescriptor: dependencyTrap,
    }))).toThrow(expect.objectContaining({ code: 'WORKFLOW_CONFIG_INVALID' }));
    expect(dependencyTrap).not.toHaveBeenCalled();

    expect(() => createInvoiceWorkflow({
      ...setup.deps,
      repository: new Proxy(setup.repository, {
        get: repositoryTrap,
        getPrototypeOf: repositoryTrap,
        ownKeys: repositoryTrap,
        getOwnPropertyDescriptor: repositoryTrap,
      }),
    })).toThrow(expect.objectContaining({ code: 'WORKFLOW_CONFIG_INVALID' }));
    expect(repositoryTrap).not.toHaveBeenCalled();
  });

  test('rejects accessor-backed or proxied dependency methods without executing them', () => {
    const setup = createDeps();
    const repositoryGetter = jest.fn(() => {
      throw new Error('repository method secret');
    });
    Object.defineProperty(setup.repository, 'getJob', {
      configurable: true,
      enumerable: true,
      get: repositoryGetter,
    });
    expect(() => createInvoiceWorkflow(setup.deps))
      .toThrow(expect.objectContaining({ code: 'WORKFLOW_CONFIG_INVALID' }));
    expect(repositoryGetter).not.toHaveBeenCalled();

    const second = createDeps();
    const clientTrap = jest.fn(() => {
      throw new Error('client function secret');
    });
    second.deps.oeisClient.submit = new Proxy(second.deps.oeisClient.submit, {
      apply: clientTrap,
      get: clientTrap,
      getPrototypeOf: clientTrap,
      ownKeys: clientTrap,
      getOwnPropertyDescriptor: clientTrap,
    });
    expect(() => createInvoiceWorkflow(second.deps))
      .toThrow(expect.objectContaining({ code: 'WORKFLOW_CONFIG_INVALID' }));
    expect(clientTrap).not.toHaveBeenCalled();
  });
});

describe('Task 8 audit protocol', () => {
  test('accepts the exact delay-based retry decision without sampling it on local failure', async () => {
    const setup = createDeps({
      buildResult: new EinvoiceError('LINE_TOTAL_MISMATCH', 'private validation detail'),
    });
    const plan = retryPlan();

    await createInvoiceWorkflow(setup.deps).processJob(job(), plan);

    expect(setup.deps.buildPayload).toHaveBeenCalledTimes(1);
    expect(plan.retryDelayMs).not.toHaveBeenCalled();
  });

  test('commits JOB validation start before building and atomically records safe local failure', async () => {
    const trace = [];
    const privateDetail = 'patient-national-id-1000000000';
    const setup = createDeps({
      trace,
      buildResult: new EinvoiceError('LINE_TOTAL_MISMATCH', privateDetail),
    });
    setup.repository.appendAuditEvents.mockImplementationOnce(async events => {
      trace.push(`audit:${events.map(event => event.action).join(',')}`);
      setup.auditEvents.push(...events);
    });

    await createInvoiceWorkflow(setup.deps).processJob(job(), retryPlan());

    expect(trace.slice(0, 2)).toEqual(['audit:VALIDATION_STARTED', 'build']);
    expect(setup.repository.appendAuditEvents).toHaveBeenCalledTimes(1);
    expect(setup.repository.appendAuditEvents.mock.calls[0][0].map(event => event.action))
      .toEqual(['VALIDATION_STARTED']);
    const failureBundle = setup.repository.markJobFailed.mock.calls[0][4];
    expect(failureBundle.map(event => event.action))
      .toEqual(['VALIDATION_FAILED', 'JOB_DATA_FAILED']);
    expect(new Set(failureBundle.map(event => event.occurredAt)).size).toBe(1);
    expect(failureBundle[0].startedAt)
      .toBe(setup.repository.appendAuditEvents.mock.calls[0][0][0].startedAt);
    expect(JSON.stringify(failureBundle)).not.toContain(privateDetail);
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
  });

  test('commits a deterministic Fynd lock intent before the client and couples confirmation to lock state', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCK_PENDING,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
    });
    const trace = [];
    const setup = createDeps({ initialJob: claimed, trace });
    const begin = setup.repository.beginExternalOperation.getMockImplementation();
    setup.repository.beginExternalOperation.mockImplementation(async input => {
      trace.push('begin-lock');
      return begin(input);
    });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(trace.indexOf('begin-lock')).toBeGreaterThanOrEqual(0);
    expect(trace.indexOf('begin-lock')).toBeLessThan(trace.indexOf('lock'));
    const lockBegin = setup.repository.beginExternalOperation.mock.calls[0][0];
    expect(lockBegin).toEqual(expect.objectContaining({
      targetKind: 'JOB', targetId: 1, expectedVersion: claimed.version,
    }));
    expect(lockBegin.event).toEqual(expect.objectContaining({
      stage: 'FYND_LOCK', action: 'FYND_LOCK_REQUESTED', outcome: 'STARTED',
      requestSummary: {
        kind: 'FYND_REQUEST', operation: 'LOCK', shipmentId: 'shipment-1',
        documentNumber: DOCUMENT, requestedLock: true, requestedStatus: null,
      },
    }));
    const lockedEvents = setup.repository.markShipmentLocked.mock.calls[0][2];
    expect(lockedEvents.map(event => event.action)).toEqual(['FYND_LOCK_CONFIRMED']);
    expect(lockedEvents[0]).toEqual(expect.objectContaining({
      operationKey: lockBegin.event.operationKey,
      outcome: 'SUCCESS',
      responseSummary: expect.objectContaining({
        operation: 'LOCK', responseStatus: null, locked: true,
        shipmentState: null, finalStateClassification: 'LOCKED', retryable: false,
      }),
    }));
    expect(setup.getPending()).not.toEqual(expect.objectContaining({ stage: 'FYND_LOCK' }));
  });

  test.each([
    ['failed begin', new EinvoiceError('REPOSITORY_UNAVAILABLE', 'database secret')],
    ['unknown begin commit', new EinvoiceError('REPOSITORY_TRANSACTION_UNKNOWN', 'commit secret')],
  ])('performs zero Fynd/OEIS calls after %s', async (_description, failure) => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCK_PENDING,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
    });
    const setup = createDeps({ initialJob: claimed });
    setup.repository.beginExternalOperation.mockRejectedValueOnce(failure);

    await expect(createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan()))
      .rejects.toBe(failure);

    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.getShipment).not.toHaveBeenCalled();
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
  });

  test('atomically holds a directly confirmed dry-run lock and never enters the OEIS protocol', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.DRY_RUN_LOCK_PENDING,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
    });
    const setup = createDeps({ initialJob: claimed });

    const result = await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(result.state).toBe(JOB_STATES.SUBMISSION_HELD);
    expect(setup.repository.markShipmentLocked.mock.calls[0][2].map(event => event.action))
      .toEqual(['FYND_LOCK_CONFIRMED', 'OEIS_SUBMISSION_HELD']);
    expect(setup.repository.findUnresolvedAuditOperation.mock.calls
      .filter(([query]) => query?.stage === 'OEIS_SUBMISSION')).toHaveLength(0);
    expect(setup.repository.beginExternalOperation).toHaveBeenCalledTimes(1);
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    expect(setup.deps.parseResponse).not.toHaveBeenCalled();
    expect(setup.repository.markOeisAcceptedAndEnqueue).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });

  test('submits exact stored bytes only after OEIS intent and stores privacy-safe response/artifact evidence', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCKED,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
      lockedAt: LOCKED_AT,
    });
    const trace = [];
    const accepted = artifact({ uuid: 'uuid-1' });
    const setup = createDeps({ initialJob: claimed, parsedArtifact: accepted, trace });
    const begin = setup.repository.beginExternalOperation.getMockImplementation();
    setup.repository.beginExternalOperation.mockImplementation(async input => {
      trace.push(`begin:${input.event.stage}`);
      return begin(input);
    });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(trace.indexOf('begin:OEIS_SUBMISSION')).toBeLessThan(trace.indexOf('oeis'));
    expect(setup.deps.oeisClient.submit).toHaveBeenCalledWith(bytes);
    const oeisBegin = setup.repository.beginExternalOperation.mock.calls[0][0];
    expect(oeisBegin.event.requestSummary).toEqual({
      kind: 'OEIS_REQUEST',
      documentNumber: DOCUMENT,
      documentType: 'IN',
      lineCount: 1,
      currency: 'SAR',
      netAmount: '100.00',
      taxAmount: '15.00',
      totalAmount: '115.00',
      taxSummaries: [{ category: 'S', rate: '15.00', reasonCode: null, lineCount: 1 }],
      requestByteCount: Buffer.byteLength(bytes, 'utf8'),
      requestSha256: requestHash(bytes),
      endpointPath: '/API/V2/Transaction/UpdateInvoiceData',
      attemptNumber: 1,
      timeoutMs: 30_000,
    });
    const persistence = setup.repository.markOeisAcceptedAndEnqueue.mock.calls[0];
    expect(persistence[1]).toEqual({ ...accepted, qrCodeData: null });
    expect(persistence[1]).not.toBe(accepted);
    expect(Object.prototype.hasOwnProperty.call(accepted, 'qrCodeData')).toBe(false);
    expect(persistence[4].map(event => event.action))
      .toEqual(['OEIS_RESPONSE_RECEIVED', 'OEIS_ARTIFACT_STORED']);
    expect(persistence[4][0].responseSummary).toEqual(expect.objectContaining({
      kind: 'OEIS_RESPONSE', httpStatus: 200, uuid: null,
      responseByteCount: null, responseSha256: null,
    }));
    expect(persistence[4][1].responseSummary).toEqual({
      kind: 'OEIS_ARTIFACT',
      signedXmlPresent: true,
      signedXmlByteCount: Buffer.byteLength(XML, 'utf8'),
      signedXmlSha256: XML_HASH,
      qrPresent: false,
      qrByteCount: null,
      qrSha256: null,
    });
    expect(JSON.stringify(persistence[4])).not.toContain(XML_BASE64);
    expect(JSON.stringify(persistence[4])).not.toContain(XML);
  });

  test('makes an OEIS timeout terminal indeterminate and never samples retry jitter', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCKED, oeisRequestJson: bytes, requestHash: requestHash(bytes),
      lockedAt: LOCKED_AT, attemptCount: 2,
    });
    const plan = retryPlan();
    const setup = createDeps({
      initialJob: claimed,
      oeisResult: new EinvoiceError('OEIS_TIMEOUT', 'socket/customer secret', { retryable: true }),
    });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, plan);

    expect(plan.retryDelayMs).not.toHaveBeenCalled();
    expect(setup.repository.scheduleJobRetry).not.toHaveBeenCalled();
    const call = setup.repository.markJobIndeterminate.mock.calls[0];
    expect(call.slice(0, 4)).toEqual([
      1, 'OEIS_TIMEOUT', 'OEIS result is indeterminate', claimed.version + 1,
    ]);
    expect(call[4].map(event => [event.action, event.outcome]))
      .toEqual([
        ['OEIS_SUBMISSION_FAILED', 'TIMEOUT'],
        ['JOB_INDETERMINATE', 'INDETERMINATE'],
      ]);
    expect(JSON.stringify(call[4])).not.toContain('socket/customer secret');
  });

  test('does not invoke traps on a hostile OEIS result while recording safe uncertainty', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCKED, oeisRequestJson: bytes, requestHash: requestHash(bytes),
      lockedAt: LOCKED_AT,
    });
    let trapCalls = 0;
    const trap = () => {
      trapCalls += 1;
      throw new Error('hostile OEIS result secret');
    };
    const hostileResult = new Proxy({}, {
      get: (target, key, receiver) => (key === 'then'
        ? Reflect.get(target, key, receiver)
        : trap()),
      getPrototypeOf: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
    });
    const setup = createDeps({ initialJob: claimed });
    setup.deps.oeisClient.submit.mockResolvedValueOnce(hostileResult);

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(trapCalls).toBe(0);
    expect(setup.deps.parseResponse).not.toHaveBeenCalled();
    const call = setup.repository.markJobIndeterminate.mock.calls[0];
    expect(call.slice(0, 4)).toEqual([
      1, 'OEIS_UNKNOWN_RESULT', 'OEIS result is indeterminate', claimed.version + 1,
    ]);
    expect(call[4][0].responseSummary).toEqual(expect.objectContaining({
      httpStatus: null, responseByteCount: null, responseSha256: null,
    }));
  });

  test('does not invoke an accessor-backed OEIS status while recording safe uncertainty', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCKED, oeisRequestJson: bytes, requestHash: requestHash(bytes),
      lockedAt: LOCKED_AT,
    });
    let getterCalls = 0;
    const getter = () => {
      getterCalls += 1;
      throw new Error('accessor-backed OEIS status secret');
    };
    const hostileResult = {
      body: { synthetic: true }, responseByteCount: null, responseSha256: null,
    };
    Object.defineProperty(hostileResult, 'httpStatus', {
      configurable: true, enumerable: true, get: getter,
    });
    const setup = createDeps({ initialJob: claimed });
    setup.deps.oeisClient.submit.mockResolvedValueOnce(hostileResult);

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(getterCalls).toBe(0);
    expect(setup.deps.parseResponse).not.toHaveBeenCalled();
    expect(setup.repository.markJobIndeterminate.mock.calls[0][1])
      .toBe('OEIS_UNKNOWN_RESULT');
  });

  test('does not invoke traps on a hostile OEIS rejection while recording safe uncertainty', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCKED, oeisRequestJson: bytes, requestHash: requestHash(bytes),
      lockedAt: LOCKED_AT,
    });
    let trapCalls = 0;
    const trap = () => {
      trapCalls += 1;
      throw new Error('hostile OEIS rejection secret');
    };
    const hostileError = new Proxy({}, {
      get: trap,
      getPrototypeOf: trap,
      ownKeys: trap,
      getOwnPropertyDescriptor: trap,
    });
    const setup = createDeps({ initialJob: claimed });
    setup.deps.oeisClient.submit.mockRejectedValueOnce(hostileError);

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(trapCalls).toBe(0);
    expect(setup.deps.parseResponse).not.toHaveBeenCalled();
    expect(setup.repository.markJobIndeterminate.mock.calls[0][1])
      .toBe('OEIS_UNKNOWN_RESULT');
  });

  test('retries only explicit OEIS 429 with one delay sample and byte-identical due time', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCKED, oeisRequestJson: bytes, requestHash: requestHash(bytes),
      lockedAt: LOCKED_AT, attemptCount: 2,
    });
    const plan = retryPlan();
    const setup = createDeps({
      initialJob: claimed,
      oeisResult: new EinvoiceError('OEIS_HTTP_429', 'throttle detail', { retryable: true }),
    });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, plan);

    expect(plan.retryDelayMs).toHaveBeenCalledTimes(1);
    const call = setup.repository.scheduleJobRetry.mock.calls[0];
    expect(call[1].nextAttemptAt).toBe(call[3][1].nextAttemptAt);
    expect(call[3].map(event => [event.action, event.outcome]))
      .toEqual([
        ['OEIS_SUBMISSION_FAILED', 'FAILURE'],
        ['RETRY_SCHEDULED', 'RETRY_SCHEDULED'],
      ]);
    expect(call[3][0].responseSummary.httpStatus).toBe(429);
    expect(call[3][1].retryDelayMs).toBe(1_800_000);
    expect(new Set(call[3].map(event => event.occurredAt)).size).toBe(1);
  });

  test('records signed-artifact failure as terminal OEIS uncertainty with no retry or private detail', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCKED, oeisRequestJson: bytes, requestHash: requestHash(bytes),
      lockedAt: LOCKED_AT, attemptCount: 2,
    });
    const privateDetail = 'signed-xml-patient-secret';
    const plan = retryPlan();
    const setup = createDeps({
      initialJob: claimed,
      parsedArtifact: new EinvoiceError('OEIS_SIGNED_XML_INVALID', privateDetail),
    });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, plan);

    expect(plan.retryDelayMs).not.toHaveBeenCalled();
    expect(setup.repository.markJobFailed).not.toHaveBeenCalled();
    expect(setup.repository.scheduleJobRetry).not.toHaveBeenCalled();
    const call = setup.repository.markJobIndeterminate.mock.calls[0];
    expect(call.slice(0, 4)).toEqual([
      1, 'OEIS_SIGNED_XML_INVALID', 'OEIS result is indeterminate', claimed.version + 1,
    ]);
    expect(call[4].map(event => [event.action, event.outcome])).toEqual([
      ['OEIS_SUBMISSION_FAILED', 'INDETERMINATE'],
      ['JOB_INDETERMINATE', 'INDETERMINATE'],
    ]);
    expect(new Set(call[4].map(event => event.occurredAt)).size).toBe(1);
    expect(JSON.stringify(call[4])).not.toContain(privateDetail);
  });

  test('does not execute an audit-only QR accessor or let it block valid artifact storage', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.LOCKED, oeisRequestJson: bytes, requestHash: requestHash(bytes),
      lockedAt: LOCKED_AT,
    });
    const accepted = artifact();
    const getter = jest.fn(() => {
      throw new Error('qr patient secret');
    });
    Object.defineProperty(accepted, 'qrCodeData', {
      configurable: true,
      enumerable: true,
      get: getter,
    });
    const setup = createDeps({ initialJob: claimed, parsedArtifact: accepted });
    setup.repository.markOeisAcceptedAndEnqueue.mockResolvedValueOnce({
      job: transitionPendingJob(), outbox: outbox(),
    });

    await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(getter).not.toHaveBeenCalled();
    const call = setup.repository.markOeisAcceptedAndEnqueue.mock.calls[0];
    expect(call[1]).toEqual({ ...artifact(), qrCodeData: null });
    expect(call[1]).not.toBe(accepted);
    expect(call[4][1].responseSummary).toEqual(expect.objectContaining({
      qrPresent: false, qrByteCount: null, qrSha256: null,
    }));
  });

  test('recovers a pending dry-run Fynd lock using GET only and persists the readback-first held bundle', async () => {
    const bytes = requestBytes();
    const claimed = job({
      state: JOB_STATES.DRY_RUN_RETRY_WAIT,
      oeisRequestJson: bytes,
      requestHash: requestHash(bytes),
      attemptCount: 2,
      version: 9,
    });
    const recovery = pendingRecovery(claimed);
    const setup = createDeps({
      initialJob: claimed,
      shipmentRead: {
        shipmentId: claimed.shipmentId, status: 'bag_confirmed', locked: true,
        invoiceId: undefined, meta: undefined,
      },
    });
    setup.repository.findUnresolvedAuditOperation.mockResolvedValueOnce(recovery);

    const result = await createInvoiceWorkflow(setup.deps).processJob(claimed, retryPlan());

    expect(result.state).toBe(JOB_STATES.SUBMISSION_HELD);
    expect(setup.deps.fyndClient.lockShipment).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.getShipment).toHaveBeenCalledTimes(1);
    expect(setup.deps.oeisClient.submit).not.toHaveBeenCalled();
    const events = setup.repository.markShipmentLocked.mock.calls[0][2];
    expect(events.map(event => [event.action, event.outcome])).toEqual([
      ['FYND_LOCK_READBACK', 'STARTED'],
      ['FYND_LOCK_READBACK', 'SUCCESS'],
      ['FYND_LOCK_CONFIRMED', 'SUCCESS'],
      ['OEIS_SUBMISSION_HELD', 'HELD'],
    ]);
    expect(new Set(events.map(event => event.occurredAt)).size).toBe(1);
    expect(Date.parse(events[2].completedAt)).toBeLessThan(Date.parse(events[0].startedAt));
    expect(Date.parse(events[0].startedAt)).toBeLessThan(Date.parse(events[1].completedAt));
    expect(events[2].operationKey).toBe(recovery.operationKey);
    expect(JSON.stringify(events)).not.toContain('invoiceId');
    expect(JSON.stringify(events)).not.toContain('meta');
  });

  test('commits transition intent before Fynd and atomically records completion', async () => {
    const claimed = outbox();
    const trace = [];
    const setup = createDeps({ trace, initialJob: transitionPendingJob() });
    const begin = setup.repository.beginExternalOperation.getMockImplementation();
    setup.repository.beginExternalOperation.mockImplementation(async input => {
      trace.push(`begin:${input.event.stage}`);
      return begin(input);
    });

    await createInvoiceWorkflow(setup.deps).processOutbox(claimed, retryPlan());

    expect(trace.indexOf('begin:FYND_TRANSITION')).toBeLessThan(trace.indexOf('fynd-transition'));
    const started = setup.repository.beginExternalOperation.mock.calls[0][0];
    expect(started).toEqual(expect.objectContaining({
      targetKind: 'OUTBOX', targetId: claimed.id, expectedVersion: claimed.version,
    }));
    expect(started.event).toEqual(expect.objectContaining({
      action: 'FYND_TRANSITION_REQUESTED', outcome: 'STARTED', artifactJobId: 1,
      requestSummary: expect.objectContaining({
        operation: 'TRANSITION', requestedStatus: 'bag_invoiced', requestedLock: null,
      }),
    }));
    const complete = setup.repository.completeOutboxAndJob.mock.calls[0];
    expect(complete[1]).toBe(claimed.version + 1);
    expect(complete[2].map(event => [event.action, event.outcome]))
      .toEqual([
        ['FYND_TRANSITION_CONFIRMED', 'SUCCESS'],
        ['JOB_COMPLETED', 'SUCCESS'],
      ]);
    expect(complete[2][0].responseSummary).toEqual(expect.objectContaining({
      operation: 'TRANSITION', responseStatus: null, locked: null,
      shipmentState: 'bag_invoiced', finalStateClassification: 'INVOICED',
    }));
  });

  test('recovers a pending transition with GET only and reuses the original operation identity', async () => {
    const claimed = outbox({ status: OUTBOX_STATUSES.RETRY_WAIT, attemptCount: 2, version: 6 });
    const recovery = pendingRecovery(claimed, {
      targetKind: 'OUTBOX', stage: 'FYND_TRANSITION', action: 'FYND_TRANSITION_REQUESTED',
    });
    const setup = createDeps({
      initialJob: transitionPendingJob(),
      shipmentRead: {
        shipmentId: 'shipment-1', status: 'bag_invoiced', locked: false,
        invoiceId: OEIS_INVOICE,
        meta: {
          einvoice_info: { invoice: { SignedQRCode: QR_CODE_DATA } },
          xml: { content: XML, filename: `${DOCUMENT}.xml` },
        },
      },
    });
    setup.repository.findUnresolvedAuditOperation.mockResolvedValueOnce(recovery);

    await createInvoiceWorkflow(setup.deps).processOutbox(claimed, retryPlan());

    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
    expect(setup.deps.fyndClient.getShipment).toHaveBeenCalledTimes(1);
    const events = setup.repository.completeOutboxAndJob.mock.calls[0][2];
    expect(events.map(event => [event.action, event.outcome])).toEqual([
      ['FYND_TRANSITION_READBACK', 'STARTED'],
      ['FYND_TRANSITION_READBACK', 'SUCCESS'],
      ['FYND_TRANSITION_CONFIRMED', 'SUCCESS'],
      ['JOB_COMPLETED', 'SUCCESS'],
    ]);
    expect(events[2].operationKey).toBe(recovery.operationKey);
    expect(new Set(events.map(event => event.occurredAt)).size).toBe(1);
    expect(JSON.stringify(events)).not.toContain(XML);
    expect(JSON.stringify(events)).not.toContain(XML_BASE64);
  });

  test('recovers a pending transition when consecutive native clock reads share one millisecond', async () => {
    const claimed = outbox({ status: OUTBOX_STATUSES.RETRY_WAIT, attemptCount: 2, version: 6 });
    const recovery = pendingRecovery(claimed, {
      targetKind: 'OUTBOX', stage: 'FYND_TRANSITION', action: 'FYND_TRANSITION_REQUESTED',
    });
    const setup = createDeps({
      constantNow: true,
      initialJob: transitionPendingJob(),
      shipmentRead: {
        shipmentId: 'shipment-1', status: 'bag_invoiced', locked: false,
        invoiceId: OEIS_INVOICE,
        meta: {
          einvoice_info: { invoice: { SignedQRCode: QR_CODE_DATA } },
          xml: { content: XML, filename: `${DOCUMENT}.xml` },
        },
      },
    });
    setup.repository.findUnresolvedAuditOperation.mockResolvedValueOnce(recovery);

    await expect(createInvoiceWorkflow(setup.deps).processOutbox(claimed, retryPlan()))
      .resolves.toEqual(expect.anything());
    expect(setup.deps.fyndClient.getShipment).toHaveBeenCalledTimes(1);
    expect(setup.repository.completeOutboxAndJob).toHaveBeenCalledTimes(1);
  });

  test('records corrupt artifact/outbox state as one privacy-safe OUTBOX terminal event', async () => {
    const claimed = outbox();
    const setup = createDeps({
      initialJob: transitionPendingJob(),
      storedArtifact: storedArtifactRecord({ signedXmlSha256: '0'.repeat(64) }),
    });

    await createInvoiceWorkflow(setup.deps).processOutbox(claimed, retryPlan());

    const call = setup.repository.markOutboxIndeterminate.mock.calls[0];
    expect(call.slice(0, 4)).toEqual([
      claimed.id, 'OUTBOX_DATA_INVALID', 'Stored invoice outbox data is invalid', claimed.version,
    ]);
    expect(call[4].map(event => [event.stage, event.action, event.outcome]))
      .toEqual([['JOB', 'JOB_INDETERMINATE', 'INDETERMINATE']]);
    expect(call[4][0]).toEqual(expect.objectContaining({
      jobId: 1, shipmentId: 'shipment-1', safeCode: 'OUTBOX_DATA_INVALID',
    }));
    expect(setup.deps.fyndClient.transitionToInvoiced).not.toHaveBeenCalled();
  });
});
