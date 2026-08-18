'use strict';

const { createHash } = require('crypto');
const { Long, MongoServerError } = require('mongodb');

const {
  AUDIT_RETENTION_MS,
  createAuditEvent,
  createEventKey,
  createOperationKey,
  sanitizeFyndSummary,
} = require('../../src/einvoice/audit/audit-contract');
const { JOB_STATES } = require('../../src/einvoice/repositories/invoice-repository');
const {
  MONGO_TRANSACTION_TIMEOUT_MS,
  createMongoInvoiceRepository,
} = require('../../src/einvoice/repositories/mongo-invoice-repository');
const { createMongoRepositoryHarness } = require('../utils/mongo-repository-harness');

const NOW = new Date('2026-08-17T10:00:00.000Z');
const RECEIVED_AT = '2026-08-17T09:59:00.000Z';
const LEASE_UNTIL = '2026-08-17T10:05:00.000Z';
const REQUEST_JSON = '[{"TRAN_DOC_NO":"VR-shipment-1-1"}]';
const REQUEST_HASH = createHash('sha256').update(REQUEST_JSON, 'utf8').digest('hex');
const ACTIVE_STATES = [
  JOB_STATES.RECEIVED,
  JOB_STATES.LOCK_PENDING,
  JOB_STATES.LOCKED,
  JOB_STATES.RETRY_WAIT,
  JOB_STATES.DRY_RUN_RECEIVED,
  JOB_STATES.DRY_RUN_LOCK_PENDING,
  JOB_STATES.DRY_RUN_RETRY_WAIT,
];

function safeError(code, message, retryable = false) {
  return expect.objectContaining({ name: 'EinvoiceError', code, message, retryable });
}

function eventRecord(suffix = '1', companyId = 'company-1') {
  return {
    eventId: `event-${suffix}`,
    companyId,
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
      set(value) { currentNow = new Date(value); },
      reset() { clockCalls = 0; },
    },
  };
}

async function readyFixture(options = {}) {
  const fixture = createFixture(options);
  await fixture.repository.initialize();
  fixture.clock.reset();
  return fixture;
}

function findJob(harness, jobId) {
  const encoded = Long.fromNumber(jobId);
  return harness.documents('invoice_jobs').find(job => job.jobId.equals(encoded));
}

function mutationState(harness) {
  return {
    jobs: harness.documents('invoice_jobs'),
    events: harness.documents('shipment_audit_events'),
    heads: harness.documents('shipment_audit_heads'),
  };
}

function replaceJob(harness, jobId, patch) {
  const encoded = Long.fromNumber(jobId);
  harness.replaceDocuments('invoice_jobs', harness.documents('invoice_jobs').map(job => (
    job.jobId.equals(encoded) ? { ...job, ...patch } : job
  )));
}

async function accept(repository, suffix = '1', dryRun = false) {
  return repository.acceptWebhook(eventRecord(suffix), normalizedShipment(suffix), dryRun);
}

async function claim(repository, workerId = 'worker-1', leaseUntil = LEASE_UNTIL) {
  return repository.claimNextJob(workerId, leaseUntil);
}

async function prepare(repository, claimed, suffix = '1') {
  const requestJson = `[{"TRAN_DOC_NO":"VR-shipment-${suffix}-1"}]`;
  const requestHash = createHash('sha256').update(requestJson, 'utf8').digest('hex');
  return repository.savePreparedRequest(
    claimed.id, requestJson, requestHash, claimed.version,
  );
}

function entityEvent(job, {
  parentVersion = job.version,
  stage = 'PAYLOAD',
  action = 'PAYLOAD_PREPARED',
  outcome = 'SUCCESS',
  occurredAt = NOW,
  safeCode = null,
  retryDelayMs = null,
  queueDelayMs = null,
} = {}) {
  const eventKey = createEventKey({
    kind: 'ENTITY',
    companyId: job.companyId,
    shipmentId: job.shipmentId,
    scopeKind: 'JOB',
    scopeId: String(job.id),
    parentVersion,
    attemptNumber: job.attemptCount,
    stage,
    action,
    outcome,
  });
  return createAuditEvent({
    eventKey,
    operationKey: null,
    companyId: job.companyId,
    applicationId: job.applicationId,
    shipmentId: job.shipmentId,
    jobId: job.id,
    documentNumber: job.documentNumber,
    stage,
    action,
    outcome,
    attemptNumber: job.attemptCount,
    startedAt: null,
    completedAt: null,
    queueDelayMs,
    retryDelayMs,
    safeCode,
    requestSummary: null,
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(occurredAt) });
}

function lockStarted(job) {
  const operationKey = createOperationKey({
    targetKind: 'JOB',
    targetId: String(job.id),
    expectedParentVersion: job.version,
    attemptNumber: job.attemptCount,
    stage: 'FYND_LOCK',
    action: 'FYND_LOCK_REQUESTED',
  });
  const eventKey = createEventKey({
    kind: 'OPERATION', operationKey, stage: 'FYND_LOCK',
    action: 'FYND_LOCK_REQUESTED', outcome: 'STARTED',
  });
  const event = createAuditEvent({
    eventKey,
    operationKey,
    companyId: job.companyId,
    applicationId: job.applicationId,
    shipmentId: job.shipmentId,
    jobId: job.id,
    documentNumber: job.documentNumber,
    stage: 'FYND_LOCK',
    action: 'FYND_LOCK_REQUESTED',
    outcome: 'STARTED',
    attemptNumber: job.attemptCount,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: sanitizeFyndSummary('REQUEST', {
      operation: 'LOCK',
      shipmentId: job.shipmentId,
      documentNumber: job.documentNumber,
      requestedLock: true,
      requestedStatus: null,
    }),
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(NOW) });
  return { operationKey, eventKey, event };
}

function lockOutcome(job, started, {
  action = 'FYND_LOCK_CONFIRMED',
  outcome = 'SUCCESS',
  operationKey = started.operationKey,
  eventKey,
  safeCode = null,
  attemptNumber = started.event.attemptNumber,
  completedAt = '2026-08-17T10:00:00.025Z',
  occurredAt = completedAt,
  locked = outcome === 'SUCCESS',
  finalStateClassification = outcome === 'SUCCESS' ? 'LOCKED' : 'UNKNOWN',
  retryable = outcome !== 'SUCCESS',
} = {}) {
  const canonicalEventKey = createEventKey({
    kind: 'OPERATION', operationKey, stage: 'FYND_LOCK', action, outcome,
  });
  return createAuditEvent({
    eventKey: eventKey || canonicalEventKey,
    operationKey,
    companyId: job.companyId,
    applicationId: job.applicationId,
    shipmentId: job.shipmentId,
    jobId: job.id,
    documentNumber: job.documentNumber,
    stage: 'FYND_LOCK',
    action,
    outcome,
    attemptNumber,
    startedAt: new Date(started.event.startedAt),
    completedAt: new Date(completedAt),
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode,
    requestSummary: null,
    responseSummary: sanitizeFyndSummary('RESPONSE', {
      operation: 'LOCK',
      shipmentId: job.shipmentId,
      documentNumber: job.documentNumber,
      responseStatus: 200,
      locked,
      shipmentState: 'bag_confirmed',
      finalStateClassification,
      retryable,
      latencyMs: Date.parse(completedAt) - Date.parse(started.event.startedAt),
    }),
    artifactJobId: null,
  }, { now: () => new Date(occurredAt) });
}

function lockReadbackPair(job, {
  expectedVersion = job.version,
  locked = true,
  finalStateClassification = locked ? 'LOCKED' : 'UNLOCKED',
  retryable = false,
  startedAt = '2026-08-17T10:00:00.030Z',
  completedAt = '2026-08-17T10:00:00.040Z',
  startedOccurredAt = startedAt,
  completedOccurredAt = completedAt,
} = {}) {
  const operationKey = createOperationKey({
    targetKind: 'JOB', targetId: String(job.id), expectedParentVersion: expectedVersion,
    attemptNumber: job.attemptCount, stage: 'FYND_LOCK', action: 'FYND_LOCK_READBACK',
  });
  const started = createAuditEvent({
    eventKey: createEventKey({
      kind: 'OPERATION', operationKey, stage: 'FYND_LOCK',
      action: 'FYND_LOCK_READBACK', outcome: 'STARTED',
    }),
    operationKey,
    companyId: job.companyId,
    applicationId: job.applicationId,
    shipmentId: job.shipmentId,
    jobId: job.id,
    documentNumber: job.documentNumber,
    stage: 'FYND_LOCK',
    action: 'FYND_LOCK_READBACK',
    outcome: 'STARTED',
    attemptNumber: job.attemptCount,
    startedAt: new Date(startedAt),
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: sanitizeFyndSummary('REQUEST', {
      operation: 'LOCK_READBACK', shipmentId: job.shipmentId,
      documentNumber: job.documentNumber, requestedLock: null, requestedStatus: null,
    }),
    responseSummary: null,
    artifactJobId: null,
  }, { now: () => new Date(startedOccurredAt) });
  const terminal = createAuditEvent({
    eventKey: createEventKey({
      kind: 'OPERATION', operationKey, stage: 'FYND_LOCK',
      action: 'FYND_LOCK_READBACK', outcome: 'SUCCESS',
    }),
    operationKey,
    companyId: job.companyId,
    applicationId: job.applicationId,
    shipmentId: job.shipmentId,
    jobId: job.id,
    documentNumber: job.documentNumber,
    stage: 'FYND_LOCK',
    action: 'FYND_LOCK_READBACK',
    outcome: 'SUCCESS',
    attemptNumber: job.attemptCount,
    startedAt: new Date(startedAt),
    completedAt: new Date(completedAt),
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: null,
    responseSummary: sanitizeFyndSummary('RESPONSE', {
      operation: 'LOCK_READBACK', shipmentId: job.shipmentId,
      documentNumber: job.documentNumber, responseStatus: 200, locked,
      shipmentState: 'bag_confirmed', finalStateClassification,
      retryable, latencyMs: Date.parse(completedAt) - Date.parse(startedAt),
    }),
    artifactJobId: null,
  }, { now: () => new Date(completedOccurredAt) });
  return [started, terminal];
}

async function beginPendingLock(fixture, suffix = '1', dryRun = false) {
  await accept(fixture.repository, suffix, dryRun);
  const claimed = await claim(fixture.repository);
  const prepared = await prepare(fixture.repository, claimed, suffix);
  const started = lockStarted(prepared);
  await fixture.repository.beginExternalOperation({
    targetKind: 'JOB', targetId: prepared.id, expectedVersion: prepared.version,
    event: started.event,
  });
  return { started, job: await fixture.repository.getJob(prepared.id) };
}

describe('Mongo job claim contract', () => {
  test.each([
    ['', LEASE_UNTIL],
    [' ', LEASE_UNTIL],
    [null, LEASE_UNTIL],
    ['worker', '2026-08-17'],
    ['worker', 'not-a-date'],
    ['worker', NOW.toISOString()],
    ['worker', '2026-08-17T09:59:59.999Z'],
  ])('rejects invalid identity/lease %# before mutation', async (workerId, leaseUntil) => {
    const { harness, repository, clock } = await readyFixture();
    await accept(repository);
    clock.reset();
    const before = harness.documents('invoice_jobs');
    await expect(repository.claimNextJob(workerId, leaseUntil)).rejects.toEqual(
      safeError('REPOSITORY_CLAIM_INVALID', 'Invoice repository claim is invalid'),
    );
    expect(harness.documents('invoice_jobs')).toEqual(before);
    expect(clock.calls()).toBe(1);
  });

  test('claims direct driver 7.5 post-image by (dueAt,jobId), increments once, and appends canonical audit/head', async () => {
    const { harness, repository, clock } = await readyFixture();
    const first = await accept(repository, 'a');
    const second = await accept(repository, 'b');
    replaceJob(harness, first.jobId, { dueAt: new Date(RECEIVED_AT), nextAttemptAt: null });
    replaceJob(harness, second.jobId, { dueAt: new Date(RECEIVED_AT), nextAttemptAt: null });
    const beforeTrace = harness.trace.operations.length;
    clock.reset();

    const result = await claim(repository, 'winner');

    expect(result).toEqual(expect.objectContaining({
      id: first.jobId, leaseOwner: 'winner', leaseExpiresAt: LEASE_UNTIL,
      attemptCount: 1, version: 1,
    }));
    expect(result).not.toHaveProperty('pendingOperation');
    expect(clock.calls()).toBe(1);
    const operations = harness.trace.operations.slice(beforeTrace);
    const mutationIndex = operations.findIndex(operation => (
      operation.collection === 'invoice_jobs' && operation.method === 'findOneAndUpdate'
    ));
    expect(mutationIndex).toBeGreaterThanOrEqual(0);
    expect(operations[mutationIndex].options).toEqual(expect.objectContaining({
      returnDocument: 'after', includeResultMetadata: false, session: true,
      sort: { dueAt: 1, jobId: 1 },
    }));
    expect(operations.slice(mutationIndex + 1).filter(operation => (
      operation.collection === 'invoice_jobs' && operation.method === 'findOne'
    ))).toEqual([]);
    expect(harness.documents('shipment_audit_events')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        jobId: Long.fromNumber(first.jobId), action: 'JOB_CLAIMED', outcome: 'SUCCESS',
        attemptNumber: 1, queueDelayMs: 60_000, occurredAt: new Date(NOW),
      }),
    ]));
    expect(harness.documents('shipment_audit_heads')).toEqual(expect.arrayContaining([
      expect.objectContaining({ shipmentId: 'shipment-a', lastAction: 'JOB_CLAIMED' }),
    ]));
  });

  test('uses exact due and lease-expiry boundaries, repairs explicit-null pairs, and skips nonactionable states', async () => {
    const { harness, repository, clock } = await readyFixture();
    const due = await accept(repository, 'due');
    const future = await accept(repository, 'future');
    const expired = await accept(repository, 'expired');
    const partial = await accept(repository, 'partial');
    const held = await accept(repository, 'held', true);
    replaceJob(harness, due.jobId, { dueAt: new Date(NOW), nextAttemptAt: NOW });
    replaceJob(harness, future.jobId, {
      dueAt: new Date(NOW.getTime() + 1), nextAttemptAt: new Date(NOW.getTime() + 1),
    });
    replaceJob(harness, expired.jobId, {
      dueAt: new Date(NOW), nextAttemptAt: NOW,
      leaseOwner: 'old', leaseExpiresAt: new Date(NOW),
    });
    replaceJob(harness, partial.jobId, {
      dueAt: new Date(NOW), nextAttemptAt: NOW,
      leaseOwner: 'old', leaseExpiresAt: null,
    });
    replaceJob(harness, held.jobId, {
      state: JOB_STATES.SUBMISSION_HELD, nextAttemptAt: null,
      dueAt: new Date(RECEIVED_AT), leaseOwner: null, leaseExpiresAt: null,
    });

    const ids = [];
    for (let index = 0; index < 3; index += 1) {
      const claimed = await claim(repository, `worker-${index}`);
      ids.push(claimed.id);
      replaceJob(harness, claimed.id, { state: JOB_STATES.DATA_FAILED });
    }
    expect(ids).toEqual([due.jobId, expired.jobId, partial.jobId]);
    await expect(claim(repository, 'none')).resolves.toBeNull();
    clock.set(new Date(NOW.getTime() + 1));
    await expect(claim(repository, 'future-worker')).resolves.toEqual(
      expect.objectContaining({ id: future.jobId }),
    );
  });

  test('claims every live/dry active state and excludes held, transition-pending, and terminal families', async () => {
    const { harness, repository } = await readyFixture();
    const accepted = [];
    for (let index = 0; index < ACTIVE_STATES.length; index += 1) {
      accepted.push(await accept(repository, `state-${index}`, ACTIVE_STATES[index].startsWith('DRY_RUN')));
    }
    accepted.forEach((entry, index) => {
      const state = ACTIVE_STATES[index];
      const preparedState = ![JOB_STATES.RECEIVED, JOB_STATES.DRY_RUN_RECEIVED].includes(state);
      replaceJob(harness, entry.jobId, {
        state,
        ...(preparedState ? {
          oeisRequestJson: `[{"TRAN_DOC_NO":"VR-shipment-state-${index}-1"}]`,
          requestHash: createHash('sha256')
            .update(`[{"TRAN_DOC_NO":"VR-shipment-state-${index}-1"}]`)
            .digest('hex'),
        } : {}),
        ...(state === JOB_STATES.LOCKED ? { lockedAt: new Date(RECEIVED_AT) } : {}),
      });
    });
    for (const state of [
      JOB_STATES.SUBMISSION_HELD,
      JOB_STATES.FYND_TRANSITION_PENDING,
      JOB_STATES.COMPLETED,
      JOB_STATES.DATA_FAILED,
      JOB_STATES.INDETERMINATE,
    ]) {
      const entry = await accept(repository, `excluded-${state}`, state === JOB_STATES.SUBMISSION_HELD);
      replaceJob(harness, entry.jobId, { state });
    }

    const states = [];
    for (let index = 0; index < ACTIVE_STATES.length; index += 1) {
      const claimed = await claim(repository, `state-worker-${index}`);
      states.push(claimed.state);
      replaceJob(harness, claimed.id, { state: JOB_STATES.COMPLETED });
    }
    expect(states).toEqual(ACTIVE_STATES);
    await expect(claim(repository, 'excluded-worker')).resolves.toBeNull();
  });

  test('fails closed on missing/wrong raw lease BSON instead of silently repairing corruption', async () => {
    for (const [suffix, patch] of [
      ['missing', { leaseExpiresAt: undefined }],
      ['wrong', { leaseOwner: 17, leaseExpiresAt: new Date(NOW) }],
    ]) {
      const { harness, repository } = await readyFixture();
      const accepted = await accept(repository, suffix);
      const raw = findJob(harness, accepted.jobId);
      if (patch.leaseExpiresAt === undefined) {
        delete raw.leaseExpiresAt;
        harness.replaceDocuments('invoice_jobs', [raw]);
      } else replaceJob(harness, accepted.jobId, patch);
      const before = harness.documents('invoice_jobs');
      await expect(claim(repository)).rejects.toEqual(
        safeError('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
      );
      expect(harness.documents('invoice_jobs')).toEqual(before);
    }
  });

  test('allows only one winner across same-instance and two-instance claim races', async () => {
    for (const twoInstances of [false, true]) {
      const harness = createMongoRepositoryHarness();
      const first = await readyFixture({ harness });
      const second = twoInstances ? await readyFixture({ harness }) : first;
      await accept(first.repository, twoInstances ? 'two' : 'same');
      const results = await Promise.all([
        claim(first.repository, 'worker-a'),
        claim(second.repository, 'worker-b'),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(results.filter(value => value === null)).toHaveLength(1);
      expect(findJob(harness, results.find(Boolean).id)).toEqual(expect.objectContaining({
        attemptCount: 1, version: 1,
      }));
    }
  });

  test('replays the transaction callback without double increment/event and rolls back a corrupt post-image', async () => {
    const replayed = await readyFixture();
    await accept(replayed.repository, 'replay');
    replayed.harness.replayNextTransaction(1);
    const beforeCallbacks = replayed.harness.trace.transactionCallbacks;
    const result = await claim(replayed.repository);
    expect(replayed.harness.trace.transactionCallbacks - beforeCallbacks).toBe(2);
    expect(findJob(replayed.harness, result.id)).toEqual(expect.objectContaining({
      attemptCount: 1, version: 1,
    }));
    expect(replayed.harness.documents('shipment_audit_events').filter(
      event => event.action === 'JOB_CLAIMED',
    )).toHaveLength(1);

    const corrupt = await readyFixture();
    const accepted = await accept(corrupt.repository, 'corrupt');
    replaceJob(corrupt.harness, accepted.jobId, { shipmentSnapshotJson: '{' });
    const before = corrupt.harness.documents('invoice_jobs');
    const beforeEvents = corrupt.harness.documents('shipment_audit_events');
    await expect(claim(corrupt.repository)).rejects.toEqual(
      safeError('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
    expect(corrupt.harness.documents('invoice_jobs')).toEqual(before);
    expect(corrupt.harness.documents('shipment_audit_events')).toEqual(beforeEvents);
  });

  test('rolls a claim back when its event/head write fails and rejects attempt/version overflow', async () => {
    const auditFailure = await readyFixture();
    const accepted = await accept(auditFailure.repository, 'audit-rollback');
    const before = {
      job: findJob(auditFailure.harness, accepted.jobId),
      events: auditFailure.harness.documents('shipment_audit_events'),
      heads: auditFailure.harness.documents('shipment_audit_heads'),
    };
    auditFailure.harness.returnNext('shipment_audit_heads', 'updateOne', {
      acknowledged: false,
      matchedCount: 1,
      modifiedCount: 1,
      upsertedCount: 0,
      upsertedId: null,
    });
    await expect(claim(auditFailure.repository)).rejects.toEqual(
      safeError('REPOSITORY_UNAVAILABLE', 'Invoice repository is unavailable', true),
    );
    expect(findJob(auditFailure.harness, accepted.jobId)).toEqual(before.job);
    expect(auditFailure.harness.documents('shipment_audit_events')).toEqual(before.events);
    expect(auditFailure.harness.documents('shipment_audit_heads')).toEqual(before.heads);

    const overflow = await readyFixture();
    const maximum = await accept(overflow.repository, 'overflow');
    replaceJob(overflow.harness, maximum.jobId, {
      attemptCount: Number.MAX_SAFE_INTEGER,
      version: Number.MAX_SAFE_INTEGER,
    });
    const maximumBefore = findJob(overflow.harness, maximum.jobId);
    await expect(claim(overflow.repository)).rejects.toEqual(
      safeError('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid'),
    );
    expect(findJob(overflow.harness, maximum.jobId)).toEqual(maximumBefore);
    await expect(overflow.repository.markJobFailed(
      maximum.jobId, 'FAILED', 'Failed', Number.MAX_SAFE_INTEGER,
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
  });

  test('maps exhausted contention and unknown commit without raw detail or logical retry', async () => {
    const busy = await readyFixture();
    await accept(busy.repository, 'busy');
    const contention = new MongoServerError({ message: 'private contention namespace' });
    contention.addErrorLabel('TransientTransactionError');
    busy.harness.maximumTransactionAttempts = 1;
    busy.harness.throwNext('invoice_jobs', 'findOne', contention);
    const busyError = await claim(busy.repository).catch(error => error);
    expect(busyError).toEqual(safeError(
      'REPOSITORY_BUSY', 'Invoice repository is busy', true,
    ));
    expect(`${busyError.message} ${busyError.stack}`).not.toContain('private contention namespace');

    const unknown = await readyFixture();
    await accept(unknown.repository, 'unknown');
    unknown.harness.makeNextCommitUnknown();
    const beforeCallbacks = unknown.harness.trace.transactionCallbacks;
    await expect(claim(unknown.repository)).rejects.toEqual(safeError(
      'REPOSITORY_TRANSACTION_UNKNOWN', 'Invoice repository transaction result is unknown',
    ));
    expect(unknown.harness.trace.transactionCallbacks - beforeCallbacks).toBe(1);
    expect(unknown.harness.documents('invoice_jobs')).toHaveLength(1);
  });
});

describe('Mongo job CAS transitions', () => {
  test('prepares exact immutable bytes with live lease, canonical audit, and drift/error priority', async () => {
    const { harness, repository } = await readyFixture();
    await accept(repository);
    const claimed = await claim(repository);
    const audit = entityEvent(claimed);
    const prepared = await repository.savePreparedRequest(
      claimed.id, REQUEST_JSON, REQUEST_HASH, claimed.version, [audit],
    );
    expect(prepared).toEqual(expect.objectContaining({
      state: JOB_STATES.LOCK_PENDING, oeisRequestJson: REQUEST_JSON,
      requestHash: REQUEST_HASH, leaseOwner: claimed.leaseOwner,
      leaseExpiresAt: claimed.leaseExpiresAt, version: claimed.version + 1,
    }));
    expect(harness.documents('shipment_audit_events')).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventKey: audit.eventKey }),
    ]));
    await expect(repository.savePreparedRequest(
      claimed.id, REQUEST_JSON, REQUEST_HASH, prepared.version,
    )).rejects.toEqual(safeError(
      'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
    ));
    await expect(repository.savePreparedRequest(
      claimed.id, '[]', createHash('sha256').update('[]').digest('hex'), 0,
    )).rejects.toEqual(safeError(
      'PAYLOAD_DRIFT', 'Stored invoice request differs from the prepared request',
    ));
    await expect(repository.savePreparedRequest(
      999, '{', '', 0,
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
  });

  test('rejects a canonical but mutation-inconsistent local audit action atomically', async () => {
    const { harness, repository } = await readyFixture();
    await accept(repository, 'wrong-audit');
    const claimed = await claim(repository);
    const wrong = entityEvent(claimed, {
      stage: 'JOB', action: 'JOB_DATA_FAILED', outcome: 'FAILURE', safeCode: 'WRONG_ACTION',
    });
    const before = {
      jobs: harness.documents('invoice_jobs'),
      events: harness.documents('shipment_audit_events'),
      heads: harness.documents('shipment_audit_heads'),
    };

    await expect(repository.savePreparedRequest(
      claimed.id, REQUEST_JSON, REQUEST_HASH, claimed.version, [wrong],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(harness.documents('invoice_jobs')).toEqual(before.jobs);
    expect(harness.documents('shipment_audit_events')).toEqual(before.events);
    expect(harness.documents('shipment_audit_heads')).toEqual(before.heads);
  });

  test('accepts each mutation\'s fixed local lifecycle action family', async () => {
    const preparedFixture = await readyFixture();
    await accept(preparedFixture.repository, 'allowed-prepare');
    const claimed = await claim(preparedFixture.repository);
    const prepared = await preparedFixture.repository.savePreparedRequest(
      claimed.id,
      REQUEST_JSON,
      REQUEST_HASH,
      claimed.version,
      [
        entityEvent(claimed, {
          stage: 'VALIDATION', action: 'VALIDATION_PASSED', outcome: 'SUCCESS',
        }),
        entityEvent(claimed),
      ],
    );
    expect(prepared.version).toBe(claimed.version + 1);

    const heldFixture = await readyFixture();
    const heldPending = await beginPendingLock(heldFixture, 'allowed-held', true);
    await expect(heldFixture.repository.markShipmentLocked(
      heldPending.job.id,
      heldPending.job.version,
      [
        lockOutcome(heldPending.job, heldPending.started),
        entityEvent(heldPending.job, {
          stage: 'OEIS_SUBMISSION', action: 'OEIS_SUBMISSION_HELD', outcome: 'HELD',
        }),
      ],
    )).resolves.toEqual(expect.objectContaining({ state: JOB_STATES.SUBMISSION_HELD }));

    const retryFixture = await readyFixture();
    await accept(retryFixture.repository, 'allowed-retry');
    const retryClaim = await claim(retryFixture.repository);
    await expect(retryFixture.repository.scheduleJobRetry(
      retryClaim.id,
      { errorCode: 'RETRY', safeMessage: 'Retry', nextAttemptAt: LEASE_UNTIL },
      retryClaim.version,
      [entityEvent(retryClaim, {
        stage: 'RETRY', action: 'RETRY_SCHEDULED', outcome: 'RETRY_SCHEDULED',
        safeCode: 'RETRY', retryDelayMs: 300_000,
      })],
    )).resolves.toEqual(expect.objectContaining({ state: JOB_STATES.RETRY_WAIT }));

    const failedFixture = await readyFixture();
    await accept(failedFixture.repository, 'allowed-failed');
    const failedClaim = await claim(failedFixture.repository);
    await expect(failedFixture.repository.markJobFailed(
      failedClaim.id,
      'INVALID',
      'Invalid',
      failedClaim.version,
      [
        entityEvent(failedClaim, {
          stage: 'VALIDATION', action: 'VALIDATION_FAILED', outcome: 'FAILURE',
          safeCode: 'INVALID',
        }),
        entityEvent(failedClaim, {
          stage: 'JOB', action: 'JOB_DATA_FAILED', outcome: 'FAILURE', safeCode: 'INVALID',
        }),
      ],
    )).resolves.toEqual(expect.objectContaining({ state: JOB_STATES.DATA_FAILED }));

    const indeterminateFixture = await readyFixture();
    await accept(indeterminateFixture.repository, 'allowed-indeterminate');
    const indeterminateClaim = await claim(indeterminateFixture.repository);
    await expect(indeterminateFixture.repository.markJobIndeterminate(
      indeterminateClaim.id,
      'UNKNOWN',
      'Unknown',
      indeterminateClaim.version,
      [entityEvent(indeterminateClaim, {
        stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
        safeCode: 'UNKNOWN',
      })],
    )).resolves.toEqual(expect.objectContaining({ state: JOB_STATES.INDETERMINATE }));
  });

  test.each([
    ['code and time', 'AUDIT_CODE', 600_000],
    ['code', 'AUDIT_CODE', 300_000],
    ['time', 'ROW_CODE', 600_000],
  ])('rejects RETRY_SCHEDULED %s metadata drift and rolls back atomically', async (
    _label,
    auditCode,
    retryDelayMs,
  ) => {
    const { harness, repository } = await readyFixture();
    await accept(repository, `retry-drift-${_label.replaceAll(' ', '-')}`);
    const claimed = await claim(repository);
    const before = mutationState(harness);
    const event = entityEvent(claimed, {
      stage: 'RETRY',
      action: 'RETRY_SCHEDULED',
      outcome: 'RETRY_SCHEDULED',
      safeCode: auditCode,
      retryDelayMs,
    });

    await expect(repository.scheduleJobRetry(
      claimed.id,
      { errorCode: 'ROW_CODE', safeMessage: 'Retry', nextAttemptAt: LEASE_UNTIL },
      claimed.version,
      [event],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(harness)).toEqual(before);
  });

  test.each([
    ['markJobFailed', 'VALIDATION', 'VALIDATION_FAILED', 'FAILURE'],
    ['markJobFailed', 'JOB', 'JOB_DATA_FAILED', 'FAILURE'],
    ['markJobIndeterminate', 'JOB', 'JOB_INDETERMINATE', 'INDETERMINATE'],
  ])('%s rejects %s local safeCode drift and rolls back atomically', async (
    method,
    stage,
    action,
    outcome,
  ) => {
    const { harness, repository } = await readyFixture();
    await accept(repository, `terminal-drift-${action}`);
    const claimed = await claim(repository);
    const before = mutationState(harness);
    const event = entityEvent(claimed, {
      stage, action, outcome, safeCode: 'AUDIT_CODE',
    });

    await expect(repository[method](
      claimed.id, 'ROW_CODE', 'Terminal', claimed.version, [event],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(harness)).toEqual(before);
  });

  test('rejects OEIS_SUBMISSION_HELD on a live lock result without changing its head', async () => {
    const { harness, repository } = await readyFixture();
    await accept(repository, 'live-held-drift');
    const claimed = await claim(repository);
    const prepared = await prepare(repository, claimed, 'live-held-drift');
    const before = mutationState(harness);

    await expect(repository.markShipmentLocked(
      prepared.id,
      prepared.version,
      [entityEvent(prepared, {
        stage: 'OEIS_SUBMISSION', action: 'OEIS_SUBMISSION_HELD', outcome: 'HELD',
      })],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(harness)).toEqual(before);
  });

  test('rejects a lone failed lock timeout instead of committing LOCKED', async () => {
    const fixture = await readyFixture();
    const pending = await beginPendingLock(fixture, 'failed-lock-alone');
    const before = mutationState(fixture.harness);
    const failed = lockOutcome(pending.job, pending.started, {
      action: 'FYND_LOCK_FAILED',
      outcome: 'TIMEOUT',
      safeCode: 'FYND_TIMEOUT',
      locked: false,
      finalStateClassification: 'UNKNOWN',
      retryable: true,
    });

    await expect(fixture.repository.markShipmentLocked(
      pending.job.id, pending.job.version, [failed],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('rejects direct lock confirmation metadata that does not prove locked', async () => {
    const fixture = await readyFixture();
    const pending = await beginPendingLock(fixture, 'confirmation-unlocked');
    const before = mutationState(fixture.harness);
    const confirmation = lockOutcome(pending.job, pending.started, {
      locked: false,
      finalStateClassification: 'UNLOCKED',
      retryable: false,
    });

    await expect(fixture.repository.markShipmentLocked(
      pending.job.id, pending.job.version, [confirmation],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('rejects a failed lock whose successful readback does not prove locked', async () => {
    const fixture = await readyFixture();
    const pending = await beginPendingLock(fixture, 'readback-unlocked');
    const before = mutationState(fixture.harness);
    const bundleOccurredAt = '2026-08-17T10:00:00.050Z';
    const failed = lockOutcome(pending.job, pending.started, {
      action: 'FYND_LOCK_FAILED', outcome: 'TIMEOUT', safeCode: 'FYND_TIMEOUT',
      occurredAt: bundleOccurredAt,
    });
    const readback = lockReadbackPair(pending.job, {
      locked: false, finalStateClassification: 'UNLOCKED', retryable: false,
      startedOccurredAt: bundleOccurredAt,
      completedOccurredAt: bundleOccurredAt,
    });

    await expect(fixture.repository.markShipmentLocked(
      pending.job.id, pending.job.version, [...readback, failed],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test.each([
    [
      'predates the original outcome',
      { startedAt: '2026-08-17T10:00:00.010Z', completedAt: '2026-08-17T10:00:00.020Z' },
      (failed, readback) => [...readback, failed],
    ],
    [
      'overlaps the original outcome',
      { startedAt: '2026-08-17T10:00:00.020Z', completedAt: '2026-08-17T10:00:00.030Z' },
      (failed, readback) => [...readback, failed],
    ],
    [
      'starts when the original outcome completes',
      { startedAt: '2026-08-17T10:00:00.025Z', completedAt: '2026-08-17T10:00:00.035Z' },
      (failed, readback) => [...readback, failed],
    ],
    [
      'is ordered before the original outcome in the bundle',
      {},
      (failed, readback) => [readback[0], failed, readback[1]],
    ],
    [
      'completes when the readback starts',
      { startedAt: '2026-08-17T10:00:00.030Z', completedAt: '2026-08-17T10:00:00.030Z' },
      (failed, readback) => [...readback, failed],
    ],
  ])('rejects locked readback evidence that %s and rolls back atomically', async (
    _label,
    readbackTimes,
    bundle,
  ) => {
    const fixture = await readyFixture();
    const pending = await beginPendingLock(
      fixture,
      `readback-time-${_label.replaceAll(' ', '-')}`,
    );
    const before = mutationState(fixture.harness);
    const bundleOccurredAt = '2026-08-17T10:00:00.050Z';
    const failed = lockOutcome(pending.job, pending.started, {
      action: 'FYND_LOCK_FAILED', outcome: 'TIMEOUT', safeCode: 'FYND_TIMEOUT',
      occurredAt: bundleOccurredAt,
    });
    const readback = lockReadbackPair(pending.job, {
      ...readbackTimes,
      startedOccurredAt: bundleOccurredAt,
      completedOccurredAt: bundleOccurredAt,
    });

    await expect(fixture.repository.markShipmentLocked(
      pending.job.id,
      pending.job.version,
      bundle(failed, readback),
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('rejects a delayed original outcome whose occurredAt would leave a contradictory head', async () => {
    const fixture = await readyFixture();
    const pending = await beginPendingLock(fixture, 'readback-occurred-delayed-original');
    const before = mutationState(fixture.harness);
    const failed = lockOutcome(pending.job, pending.started, {
      action: 'FYND_LOCK_FAILED',
      outcome: 'TIMEOUT',
      safeCode: 'FYND_TIMEOUT',
      occurredAt: '2026-08-17T10:00:00.100Z',
    });
    const readback = lockReadbackPair(pending.job, {
      startedOccurredAt: '2026-08-17T10:00:00.050Z',
      completedOccurredAt: '2026-08-17T10:00:00.050Z',
    });

    const result = await fixture.repository.markShipmentLocked(
      pending.job.id,
      pending.job.version,
      [...readback, failed],
    ).then(
      job => {
        const head = fixture.harness.documents('shipment_audit_heads').find(candidate => (
          candidate.companyId === pending.job.companyId
            && candidate.shipmentId === pending.job.shipmentId
        ));
        return {
          status: 'resolved',
          jobState: job.state,
          lastAction: head.lastAction,
          lastOutcome: head.lastOutcome,
          lastEventKey: head.lastEventKey,
        };
      },
      error => ({ status: 'rejected', error }),
    );

    expect(result).toEqual({
      status: 'rejected',
      error: safeError('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid'),
    });
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test.each([
    [
      'original terminal differs from the atomic bundle clock',
      '2026-08-17T10:00:00.051Z',
      '2026-08-17T10:00:00.050Z',
      '2026-08-17T10:00:00.050Z',
    ],
    [
      'readback STARTED differs from the atomic bundle clock',
      '2026-08-17T10:00:00.050Z',
      '2026-08-17T10:00:00.051Z',
      '2026-08-17T10:00:00.050Z',
    ],
    [
      'readback terminal differs from the atomic bundle clock',
      '2026-08-17T10:00:00.050Z',
      '2026-08-17T10:00:00.050Z',
      '2026-08-17T10:00:00.051Z',
    ],
  ])('rejects locked readback evidence when occurredAt %s and rolls back atomically', async (
    _label,
    outcomeOccurredAt,
    readbackStartedOccurredAt,
    readbackTerminalOccurredAt,
  ) => {
    const fixture = await readyFixture();
    const pending = await beginPendingLock(
      fixture,
      `readback-occurred-${_label.replaceAll(' ', '-')}`,
    );
    const before = mutationState(fixture.harness);
    const failed = lockOutcome(pending.job, pending.started, {
      action: 'FYND_LOCK_FAILED',
      outcome: 'TIMEOUT',
      safeCode: 'FYND_TIMEOUT',
      occurredAt: outcomeOccurredAt,
    });
    const readback = lockReadbackPair(pending.job, {
      startedOccurredAt: readbackStartedOccurredAt,
      completedOccurredAt: readbackTerminalOccurredAt,
    });

    await expect(fixture.repository.markShipmentLocked(
      pending.job.id,
      pending.job.version,
      [...readback, failed],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('accepts a recovered lock confirmation with successful locked readback evidence', async () => {
    const fixture = await readyFixture();
    const pending = await beginPendingLock(fixture, 'confirmation-readback');
    const bundleOccurredAt = '2026-08-17T10:00:00.050Z';
    const confirmation = lockOutcome(pending.job, pending.started, {
      occurredAt: bundleOccurredAt,
    });
    const readback = lockReadbackPair(pending.job, {
      startedOccurredAt: bundleOccurredAt,
      completedOccurredAt: bundleOccurredAt,
    });

    await expect(fixture.repository.markShipmentLocked(
      pending.job.id, pending.job.version, [...readback, confirmation],
    )).resolves.toEqual(expect.objectContaining({ state: JOB_STATES.LOCKED }));
    expect(findJob(fixture.harness, pending.job.id).pendingOperation).toBeNull();
    expect(fixture.harness.documents('shipment_audit_events').filter(event => (
      [confirmation.eventKey, readback[0].eventKey, readback[1].eventKey].includes(event.eventKey)
    ))).toHaveLength(3);
  });

  test('accepts Task 8 readback-first evidence with one atomic occurredAt clock', async () => {
    const fixture = await readyFixture();
    const pending = await beginPendingLock(fixture, 'task-8-one-clock');
    const bundleOccurredAt = '2026-08-17T10:00:00.050Z';
    const failed = lockOutcome(pending.job, pending.started, {
      action: 'FYND_LOCK_FAILED',
      outcome: 'TIMEOUT',
      safeCode: 'FYND_TIMEOUT',
      occurredAt: bundleOccurredAt,
    });
    const readback = lockReadbackPair(pending.job, {
      startedOccurredAt: bundleOccurredAt,
      completedOccurredAt: bundleOccurredAt,
    });

    await expect(fixture.repository.markShipmentLocked(
      pending.job.id,
      pending.job.version,
      [...readback, failed],
    )).resolves.toEqual(expect.objectContaining({ state: JOB_STATES.LOCKED }));

    const stored = fixture.harness.documents('shipment_audit_events').filter(event => (
      [failed.eventKey, readback[0].eventKey, readback[1].eventKey].includes(event.eventKey)
    ));
    expect(stored).toHaveLength(3);
    expect(new Set(stored.map(event => event.occurredAt.toISOString()))).toEqual(
      new Set([bundleOccurredAt]),
    );
  });

  test.each([
    ['malformed JSON', '{', 'a'.repeat(64)],
    ['non-string bytes', {}, 'a'.repeat(64)],
    ['empty hash', '[]', ''],
    ['noncanonical hash', '[]', 'A'.repeat(64)],
    ['hash mismatch', '[]', 'a'.repeat(64)],
  ])('rejects invalid prepared input: %s', async (_label, bytes, hash) => {
    const { harness, repository, clock } = await readyFixture();
    await accept(repository);
    const claimed = await claim(repository);
    clock.reset();
    const before = harness.documents('invoice_jobs');
    await expect(repository.savePreparedRequest(
      claimed.id, bytes, hash, claimed.version,
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(clock.calls()).toBe(0);
    expect(harness.documents('invoice_jobs')).toEqual(before);
  });

  test('locks live jobs without clearing due/lease/errors and holds dry jobs with exact due reset', async () => {
    const live = await readyFixture();
    await accept(live.repository, 'live');
    const liveClaim = await claim(live.repository);
    const livePrepared = await prepare(live.repository, liveClaim, 'live');
    replaceJob(live.harness, livePrepared.id, {
      lastErrorCode: 'STALE', lastErrorMessage: 'retained',
    });
    const liveLocked = await live.repository.markShipmentLocked(
      livePrepared.id, livePrepared.version,
    );
    expect(liveLocked).toEqual(expect.objectContaining({
      state: JOB_STATES.LOCKED, lockedAt: NOW.toISOString(),
      nextAttemptAt: RECEIVED_AT, leaseOwner: 'worker-1',
      lastErrorCode: 'STALE', lastErrorMessage: 'retained',
      version: livePrepared.version + 1,
    }));
    expect(findJob(live.harness, livePrepared.id).dueAt).toEqual(new Date(RECEIVED_AT));

    const dry = await readyFixture();
    await accept(dry.repository, 'dry', true);
    const dryClaim = await claim(dry.repository);
    const dryPrepared = await prepare(dry.repository, dryClaim, 'dry');
    replaceJob(dry.harness, dryPrepared.id, {
      lastErrorCode: 'STALE', lastErrorMessage: 'clear me',
    });
    const held = await dry.repository.markShipmentLocked(dryPrepared.id, dryPrepared.version);
    expect(held).toEqual(expect.objectContaining({
      state: JOB_STATES.SUBMISSION_HELD, nextAttemptAt: null,
      leaseOwner: null, leaseExpiresAt: null,
      lastErrorCode: null, lastErrorMessage: null,
      version: dryPrepared.version + 1,
    }));
    expect(findJob(dry.harness, held.id).dueAt).toEqual(new Date(RECEIVED_AT));
  });

  test('preserves live/dry retry family, locked stage, due schedule, and clears only the lease', async () => {
    for (const [suffix, dryRun, lockedFirst, expectedState] of [
      ['live-lock', false, false, JOB_STATES.RETRY_WAIT],
      ['dry-lock', true, false, JOB_STATES.DRY_RUN_RETRY_WAIT],
      ['live-oeis', false, true, JOB_STATES.RETRY_WAIT],
    ]) {
      const fixture = await readyFixture();
      await accept(fixture.repository, suffix, dryRun);
      const claimed = await claim(fixture.repository);
      const prepared = await prepare(fixture.repository, claimed, suffix);
      const current = lockedFirst
        ? await fixture.repository.markShipmentLocked(prepared.id, prepared.version)
        : prepared;
      const nextAttemptAt = '2026-08-17T10:30:00.000Z';
      const retried = await fixture.repository.scheduleJobRetry(current.id, {
        errorCode: 'SAFE_RETRY', safeMessage: 'Retry later', nextAttemptAt,
      }, current.version);
      expect(retried).toEqual(expect.objectContaining({
        state: expectedState, nextAttemptAt, leaseOwner: null, leaseExpiresAt: null,
        lastErrorCode: 'SAFE_RETRY', lastErrorMessage: 'Retry later',
        lockedAt: current.lockedAt, attemptCount: current.attemptCount,
        version: current.version + 1,
      }));
      expect(findJob(fixture.harness, current.id).dueAt).toEqual(new Date(nextAttemptAt));
      fixture.clock.set(new Date(nextAttemptAt));
      await expect(claim(
        fixture.repository, 'boundary', '2026-08-17T11:00:00.000Z',
      )).resolves.toEqual(
        expect.objectContaining({ id: current.id }),
      );
    }
  });

  test.each([
    ['markJobFailed', JOB_STATES.DATA_FAILED],
    ['markJobIndeterminate', JOB_STATES.INDETERMINATE],
  ])('%s clears retry/lease, resets due, and makes the row terminal', async (method, state) => {
    const { harness, repository } = await readyFixture();
    await accept(repository, method);
    const claimed = await claim(repository);
    const terminal = await repository[method](
      claimed.id, 'SAFE_TERMINAL', 'Safe terminal message', claimed.version,
    );
    expect(terminal).toEqual(expect.objectContaining({
      state, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null,
      lastErrorCode: 'SAFE_TERMINAL', lastErrorMessage: 'Safe terminal message',
      version: claimed.version + 1,
    }));
    expect(findJob(harness, terminal.id).dueAt).toEqual(new Date(RECEIVED_AT));
    await expect(claim(repository, 'never')).resolves.toBeNull();
  });

  test('requires exact live lease on every mutation and rejects held/outbox-phase/locked-stage corruption', async () => {
    const invocations = [
      ['savePreparedRequest', (repo, job) => repo.savePreparedRequest(
        job.id, REQUEST_JSON, REQUEST_HASH, job.version,
      )],
      ['markShipmentLocked', async (repo, job) => {
        const prepared = await prepare(repo, job);
        return repo.markShipmentLocked(prepared.id, prepared.version);
      }],
      ['scheduleJobRetry', (repo, job) => repo.scheduleJobRetry(job.id, {
        errorCode: 'RETRY', safeMessage: 'Retry', nextAttemptAt: LEASE_UNTIL,
      }, job.version)],
      ['markJobFailed', (repo, job) => repo.markJobFailed(
        job.id, 'FAILED', 'Failed', job.version,
      )],
      ['markJobIndeterminate', (repo, job) => repo.markJobIndeterminate(
        job.id, 'UNKNOWN', 'Unknown', job.version,
      )],
    ];
    for (const [name, invoke] of invocations) {
      const fixture = await readyFixture();
      await accept(fixture.repository, name);
      const claimed = await claim(fixture.repository);
      replaceJob(fixture.harness, claimed.id, { leaseExpiresAt: new Date(NOW) });
      const before = fixture.harness.documents('invoice_jobs');
      await expect(invoke(fixture.repository, claimed)).rejects.toEqual(safeError(
        'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
      ));
      expect(fixture.harness.documents('invoice_jobs')).toEqual(before);
    }

    const corrupt = await readyFixture();
    await accept(corrupt.repository, 'locked-corrupt');
    const claimed = await claim(corrupt.repository);
    const prepared = await prepare(corrupt.repository, claimed, 'locked-corrupt');
    replaceJob(corrupt.harness, prepared.id, { lockedAt: new Date(RECEIVED_AT) });
    await expect(corrupt.repository.markShipmentLocked(
      prepared.id, prepared.version,
    )).rejects.toEqual(safeError(
      'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
    ));
    replaceJob(corrupt.harness, prepared.id, {
      state: JOB_STATES.FYND_TRANSITION_PENDING,
      lockedAt: new Date(RECEIVED_AT),
    });
    for (const invoke of [
      () => corrupt.repository.scheduleJobRetry(prepared.id, {
        errorCode: 'LATE', safeMessage: 'Late', nextAttemptAt: LEASE_UNTIL,
      }, prepared.version),
      () => corrupt.repository.markJobFailed(prepared.id, 'LATE', 'Late', prepared.version),
      () => corrupt.repository.markJobIndeterminate(prepared.id, 'LATE', 'Late', prepared.version),
    ]) {
      await expect(invoke()).rejects.toEqual(safeError(
        'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
      ));
    }
  });

  test('decodes mutation post-images before commit and rolls back job/audit/head together', async () => {
    const { harness, repository } = await readyFixture();
    await accept(repository, 'rollback');
    const claimed = await claim(repository);
    replaceJob(harness, claimed.id, { shipmentSnapshotJson: '{' });
    const audit = entityEvent(claimed, {
      stage: 'JOB', action: 'JOB_DATA_FAILED', outcome: 'FAILURE', safeCode: 'BROKEN',
    });
    const before = {
      jobs: harness.documents('invoice_jobs'),
      events: harness.documents('shipment_audit_events'),
      heads: harness.documents('shipment_audit_heads'),
    };
    await expect(repository.markJobFailed(
      claimed.id, 'BROKEN', 'Broken', claimed.version, [audit],
    )).rejects.toEqual(safeError(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    expect(harness.documents('invoice_jobs')).toEqual(before.jobs);
    expect(harness.documents('shipment_audit_events')).toEqual(before.events);
    expect(harness.documents('shipment_audit_heads')).toEqual(before.heads);
  });
});

describe('Mongo pending-operation guard and mutation audit bundles', () => {
  test('blocks legacy empty bundles after reclaim, survives audit TTL, and clears a matching distinct terminal key once', async () => {
    const fixture = await readyFixture();
    const pending = await beginPendingLock(fixture, 'pending');
    const storedBefore = findJob(fixture.harness, pending.job.id).pendingOperation;
    replaceJob(fixture.harness, pending.job.id, { leaseExpiresAt: new Date(NOW) });
    await fixture.repository.releaseExpiredLeases(NOW);
    expect(findJob(fixture.harness, pending.job.id).pendingOperation).toEqual(storedBefore);
    const reclaimed = await claim(
      fixture.repository, 'reclaimer', '2026-11-15T10:05:00.000Z',
    );
    expect(findJob(fixture.harness, reclaimed.id).pendingOperation).toEqual(storedBefore);
    await expect(fixture.repository.markShipmentLocked(
      reclaimed.id, reclaimed.version,
    )).rejects.toEqual(safeError(
      'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
    ));

    fixture.harness.replaceDocuments('shipment_audit_events', fixture.harness.documents(
      'shipment_audit_events',
    ).filter(event => event.eventKey !== pending.started.eventKey));
    fixture.clock.set(new Date(Date.parse(pending.started.event.expiresAt)));
    const outcome = lockOutcome(reclaimed, pending.started);
    expect(outcome.eventKey).not.toBe(pending.started.eventKey);
    const locked = await fixture.repository.markShipmentLocked(
      reclaimed.id, reclaimed.version, [outcome],
    );
    expect(locked.state).toBe(JOB_STATES.LOCKED);
    expect(findJob(fixture.harness, locked.id).pendingOperation).toBeNull();
    await expect(fixture.repository.markShipmentLocked(
      locked.id, locked.version, [outcome],
    )).rejects.toEqual(safeError(
      'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
    ));
  });

  test('accepts one complete canonical Fynd readback pair and transaction replay remains idempotent', async () => {
    const fixture = await readyFixture();
    const pending = await beginPendingLock(fixture, 'readback');
    const current = pending.job;
    const bundleOccurredAt = '2026-08-17T10:00:00.050Z';
    const outcome = lockOutcome(current, pending.started, {
      action: 'FYND_LOCK_FAILED', outcome: 'TIMEOUT', safeCode: 'FYND_TIMEOUT',
      occurredAt: bundleOccurredAt,
    });
    const readback = lockReadbackPair(current, {
      startedOccurredAt: bundleOccurredAt,
      completedOccurredAt: bundleOccurredAt,
    });
    fixture.harness.replayNextTransaction(1);
    const locked = await fixture.repository.markShipmentLocked(
      current.id, current.version, [...readback, outcome],
    );
    expect(locked.state).toBe(JOB_STATES.LOCKED);
    expect(fixture.harness.documents('shipment_audit_events').filter(event => (
      [outcome.eventKey, readback[0].eventKey, readback[1].eventKey].includes(event.eventKey)
    ))).toHaveLength(3);
    const expectedLatest = [outcome, ...readback].sort((left, right) => (
      left.eventKey < right.eventKey ? 1 : -1
    ))[0];
    expect(fixture.harness.documents('shipment_audit_heads')).toContainEqual(
      expect.objectContaining({
        companyId: current.companyId,
        shipmentId: current.shipmentId,
        lastAction: expectedLatest.action,
        lastOutcome: expectedLatest.outcome,
        lastEventKey: expectedLatest.eventKey,
      }),
    );
    expect(findJob(fixture.harness, locked.id).pendingOperation).toBeNull();
  });

  test.each(['scheduleJobRetry', 'markJobFailed', 'markJobIndeterminate'])(
    '%s cannot cross a pending external boundary without its matching outcome',
    async method => {
      const fixture = await readyFixture();
      const pending = await beginPendingLock(fixture, `guard-${method}`);
      const args = method === 'scheduleJobRetry'
        ? [pending.job.id, {
          errorCode: 'FYND_TIMEOUT', safeMessage: 'Retry', nextAttemptAt: LEASE_UNTIL,
        }, pending.job.version]
        : [pending.job.id, 'FYND_TIMEOUT', 'Terminal', pending.job.version];
      await expect(fixture.repository[method](...args)).rejects.toEqual(safeError(
        'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
      ));
      expect(findJob(fixture.harness, pending.job.id).pendingOperation).not.toBeNull();
    },
  );

  test('retry resolves one matching failed outcome and a terminal event cannot reuse the STARTED key', async () => {
    const fixture = await readyFixture();
    const pending = await beginPendingLock(fixture, 'retry-outcome');
    const failed = lockOutcome(pending.job, pending.started, {
      action: 'FYND_LOCK_FAILED', outcome: 'TIMEOUT', safeCode: 'FYND_TIMEOUT',
    });
    const retry = await fixture.repository.scheduleJobRetry(pending.job.id, {
      errorCode: 'FYND_TIMEOUT', safeMessage: 'Retry', nextAttemptAt: LEASE_UNTIL,
    }, pending.job.version, [failed]);
    expect(retry.state).toBe(JOB_STATES.RETRY_WAIT);
    expect(findJob(fixture.harness, retry.id).pendingOperation).toBeNull();

    const second = await readyFixture();
    const secondPending = await beginPendingLock(second, 'reuse-key');
    const terminal = lockOutcome(secondPending.job, secondPending.started);
    await expect(second.repository.markShipmentLocked(
      secondPending.job.id,
      secondPending.job.version,
      [{ ...terminal, eventKey: secondPending.started.eventKey }],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(findJob(second.harness, secondPending.job.id).pendingOperation).not.toBeNull();
  });

  test.each([
    ['lone start', pair => [pair[0]]],
    ['lone terminal', pair => [pair[1]]],
    ['reversed', pair => [pair[1], pair[0]]],
    ['duplicate start', pair => [pair[0], pair[0], pair[1]]],
    ['mixed key', (pair, job) => [
      pair[0],
      ...lockReadbackPair(job, {
        expectedVersion: job.version + 1,
        startedOccurredAt: '2026-08-17T10:00:00.050Z',
        completedOccurredAt: '2026-08-17T10:00:00.050Z',
      }).slice(1),
    ]],
  ])('rejects malformed readback bundle (%s) and rolls back pending/job/audit', async (_label, mutate) => {
    const fixture = await readyFixture();
    const pending = await beginPendingLock(fixture, `bad-${_label.replaceAll(' ', '-')}`);
    const bundleOccurredAt = '2026-08-17T10:00:00.050Z';
    const outcome = lockOutcome(pending.job, pending.started, {
      occurredAt: bundleOccurredAt,
    });
    const pair = lockReadbackPair(pending.job, {
      startedOccurredAt: bundleOccurredAt,
      completedOccurredAt: bundleOccurredAt,
    });
    const bundle = [...mutate(pair, pending.job), outcome];
    const before = {
      jobs: fixture.harness.documents('invoice_jobs'),
      events: fixture.harness.documents('shipment_audit_events'),
      heads: fixture.harness.documents('shipment_audit_heads'),
    };
    await expect(fixture.repository.markShipmentLocked(
      pending.job.id, pending.job.version, bundle,
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));
    expect(fixture.harness.documents('invoice_jobs')).toEqual(before.jobs);
    expect(fixture.harness.documents('shipment_audit_events')).toEqual(before.events);
    expect(fixture.harness.documents('shipment_audit_heads')).toEqual(before.heads);
  });

  test('uses the fixed DATA_INVALID / INPUT_INVALID / VERSION_CONFLICT provenance split', async () => {
    const corrupt = await readyFixture();
    const pending = await beginPendingLock(corrupt, 'stored-corrupt');
    replaceJob(corrupt.harness, pending.job.id, {
      pendingOperation: { ...findJob(corrupt.harness, pending.job.id).pendingOperation, eventKey: 'v1.bad' },
    });
    await expect(corrupt.repository.markShipmentLocked(
      pending.job.id, pending.job.version, [lockOutcome(pending.job, pending.started)],
    )).rejects.toEqual(safeError(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));

    const malformed = await readyFixture();
    await accept(malformed.repository, 'caller-malformed');
    const claimed = await claim(malformed.repository);
    await expect(malformed.repository.markJobFailed(
      claimed.id, 'FAILED', 'Failed', claimed.version, [{}],
    )).rejects.toEqual(safeError(
      'REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid',
    ));

    const absent = await readyFixture();
    await accept(absent.repository, 'absent');
    const absentClaim = await claim(absent.repository);
    const syntheticStarted = lockStarted(absentClaim);
    const terminal = lockOutcome(absentClaim, syntheticStarted);
    await expect(absent.repository.markJobFailed(
      absentClaim.id, 'FAILED', 'Failed', absentClaim.version, [terminal],
    )).rejects.toEqual(safeError(
      'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
    ));
  });
});

describe('Mongo job lease recovery', () => {
  test('releases at most 100 exact active leases in expiry/job order with canonical atomic events', async () => {
    const { harness, repository, clock } = await readyFixture();
    for (let index = 0; index < 102; index += 1) {
      const accepted = await accept(repository, `batch-${index}`);
      replaceJob(harness, accepted.jobId, {
        leaseOwner: `worker-${index}`,
        leaseExpiresAt: new Date(NOW.getTime() - (index < 2 ? 0 : 1)),
        attemptCount: 1,
        version: 1,
      });
    }
    const partial = await accept(repository, 'partial-recovery');
    replaceJob(harness, partial.jobId, { leaseOwner: 'partial', leaseExpiresAt: null });
    const terminal = await accept(repository, 'terminal-recovery');
    replaceJob(harness, terminal.jobId, {
      state: JOB_STATES.SUBMISSION_HELD,
      leaseOwner: 'terminal', leaseExpiresAt: new Date(NOW),
    });
    clock.reset();
    const operationStart = harness.trace.operations.length;

    await expect(repository.releaseExpiredLeases(NOW)).resolves.toEqual({ jobs: 100, outbox: 0 });
    expect(clock.calls()).toBe(0);
    const expectedFirstIds = Array.from({ length: 100 }, (_value, index) => index + 3);
    const firstRecoveryCasIds = harness.trace.operations.slice(operationStart).filter(operation => (
      operation.collection === 'invoice_jobs' && operation.method === 'findOneAndUpdate'
    )).map(operation => operation.filter.jobId.toNumber());
    expect(firstRecoveryCasIds).toEqual(expectedFirstIds);
    expect(harness.documents('shipment_audit_events').filter(
      event => event.action === 'LEASE_RECOVERED',
    ).map(event => event.jobId.toNumber())).toEqual(expectedFirstIds);
    expect(harness.documents('invoice_jobs').filter(job => (
      job.jobId.toNumber() <= 102 && job.leaseOwner !== null
    )).map(job => job.jobId.toNumber())).toEqual([1, 2]);
    expect(harness.documents('invoice_jobs').filter(job => job.leaseOwner === null)).toHaveLength(100);
    expect(harness.documents('shipment_audit_events').filter(
      event => event.action === 'LEASE_RECOVERED',
    )).toHaveLength(100);
    await expect(repository.releaseExpiredLeases(NOW)).resolves.toEqual({ jobs: 2, outbox: 0 });
    expect(harness.documents('shipment_audit_events').filter(
      event => event.action === 'LEASE_RECOVERED',
    ).map(event => event.jobId.toNumber())).toEqual([...expectedFirstIds, 1, 2]);
    expect(findJob(harness, partial.jobId)).toEqual(expect.objectContaining({
      leaseOwner: 'partial', leaseExpiresAt: null,
    }));
    expect(findJob(harness, terminal.jobId)).toEqual(expect.objectContaining({
      leaseOwner: 'terminal', state: JOB_STATES.SUBMISSION_HELD,
    }));
    const recoveryFind = harness.trace.operations.filter(operation => (
      operation.collection === 'invoice_jobs' && operation.method === 'find'
    )).at(-1);
    expect(recoveryFind.session).toBe(true);
  });

  test('preserves pending bytes, skips nonexpired and partial-null pairs, and treats expiry equality as expired', async () => {
    const fixture = await readyFixture();
    const pending = await beginPendingLock(fixture, 'recovery-pending');
    const marker = findJob(fixture.harness, pending.job.id).pendingOperation;
    replaceJob(fixture.harness, pending.job.id, { leaseExpiresAt: new Date(NOW) });
    const future = await accept(fixture.repository, 'recovery-future');
    replaceJob(fixture.harness, future.jobId, {
      leaseOwner: 'future', leaseExpiresAt: new Date(NOW.getTime() + 1),
    });
    const partial = await accept(fixture.repository, 'recovery-partial');
    replaceJob(fixture.harness, partial.jobId, { leaseOwner: null, leaseExpiresAt: new Date(NOW) });

    await expect(fixture.repository.releaseExpiredLeases(NOW)).resolves.toEqual({ jobs: 1, outbox: 0 });
    expect(findJob(fixture.harness, pending.job.id).pendingOperation).toEqual(marker);
    expect(findJob(fixture.harness, future.jobId).leaseOwner).toBe('future');
    expect(findJob(fixture.harness, partial.jobId).leaseExpiresAt).toEqual(new Date(NOW));
  });

  test('rolls back the whole batch when the second CAS loses after the first row mutation', async () => {
    const fixture = await readyFixture();
    for (const suffix of ['rollback-a', 'rollback-b']) {
      const accepted = await accept(fixture.repository, suffix);
      replaceJob(fixture.harness, accepted.jobId, {
        leaseOwner: suffix, leaseExpiresAt: new Date(NOW), attemptCount: 1, version: 1,
      });
    }
    const before = mutationState(fixture.harness);
    const operationStart = fixture.harness.trace.operations.length;
    fixture.harness.returnOnCall('invoice_jobs', 'findOneAndUpdate', 2, null);
    await expect(fixture.repository.releaseExpiredLeases(NOW)).rejects.toEqual(safeError(
      'REPOSITORY_VERSION_CONFLICT', 'Invoice repository record changed concurrently',
    ));
    expect(fixture.harness.trace.operations.slice(operationStart).filter(operation => (
      operation.collection === 'invoice_jobs' && operation.method === 'findOneAndUpdate'
    )).map(operation => operation.filter.jobId.toNumber())).toEqual([1, 2]);
    expect(mutationState(fixture.harness)).toEqual(before);

    fixture.harness.replayNextTransaction(1);
    await expect(fixture.repository.releaseExpiredLeases(NOW)).resolves.toEqual({ jobs: 2, outbox: 0 });
    expect(fixture.harness.documents('shipment_audit_events').filter(
      event => event.action === 'LEASE_RECOVERED',
    )).toHaveLength(2);
  });

  test.each([
    ['second audit event insert', harness => harness.returnOnCall(
      'shipment_audit_events',
      'insertOne',
      2,
      { acknowledged: false, insertedId: null },
    )],
    ['second audit head update', harness => harness.returnOnCall(
      'shipment_audit_heads',
      'updateOne',
      2,
      {
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 0,
        upsertedId: null,
      },
    )],
  ])('rolls back every row when the %s fails after an earlier row mutation', async (
    _label,
    intercept,
  ) => {
    const fixture = await readyFixture();
    for (const suffix of ['later-audit-a', 'later-audit-b']) {
      const accepted = await accept(fixture.repository, suffix);
      replaceJob(fixture.harness, accepted.jobId, {
        leaseOwner: suffix, leaseExpiresAt: new Date(NOW), attemptCount: 1, version: 1,
      });
    }
    const before = mutationState(fixture.harness);
    const operationStart = fixture.harness.trace.operations.length;
    intercept(fixture.harness);

    await expect(fixture.repository.releaseExpiredLeases(NOW)).rejects.toEqual(safeError(
      'REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid',
    ));
    expect(fixture.harness.trace.operations.slice(operationStart).filter(operation => (
      operation.collection === 'invoice_jobs' && operation.method === 'findOneAndUpdate'
    )).map(operation => operation.filter.jobId.toNumber())).toEqual([1, 2]);
    expect(mutationState(fixture.harness)).toEqual(before);
  });

  test('uses the exported five-second transaction contract for every job operation', async () => {
    const fixture = await readyFixture();
    await accept(fixture.repository, 'options');
    const claimed = await claim(fixture.repository);
    await fixture.repository.markJobFailed(claimed.id, 'FAILED', 'Failed', claimed.version);
    await fixture.repository.releaseExpiredLeases(NOW);
    expect(MONGO_TRANSACTION_TIMEOUT_MS).toBe(5_000);
    for (const options of fixture.harness.trace.transactionOptions.slice(1)) {
      expect(options).toEqual({
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        timeoutMS: 5_000,
      });
    }
  });
});
