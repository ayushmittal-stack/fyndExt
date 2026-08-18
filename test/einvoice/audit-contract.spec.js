'use strict';

const { EinvoiceError } = require('../../src/einvoice/errors');
const {
  AUDIT_RETENTION_MS,
  AUDIT_SUMMARY_MAX_BYTES,
  AUDIT_EVENT_MAX_BYTES,
  AUDIT_STAGES,
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  AUDIT_ACTION_OUTCOMES,
  createOperationKey,
  createEventKey,
  createAuditEvent,
  createAuditBundle,
  sanitizeFyndSummary,
  sanitizeOeisSummary,
} = require('../../src/einvoice/audit/audit-contract');

const OPERATION_KEY = 'v1.XNthuU-HTiipWMFupUg_D9Lxp-PSX3nbntb7K27cjk4';
const OPERATION_EVENT_KEY = 'v1.EwovEofzvaliEJd25IoRY8LzxTXl9RXdbdNJKSwuH28';
const RECEIPT_EVENT_KEY = 'v1.L_xNa7qkNHpUPKKCGSN8lZUH_-TNUZfV2oHZxKU6HBI';
const ENTITY_EVENT_KEY = 'v1.c2JmWq609p5YNVamjrYOn-gSMGZPeVS4ZzdyRyAH-eU';

const ERROR_MESSAGES = Object.freeze({
  AUDIT_INPUT_INVALID: 'Shipment audit input is invalid',
  AUDIT_CLOCK_INVALID: 'Shipment audit clock is invalid',
  AUDIT_SUMMARY_INVALID: 'Shipment audit summary is invalid',
  AUDIT_SUMMARY_TOO_LARGE: 'Shipment audit summary exceeds the size limit',
  AUDIT_EVENT_TOO_LARGE: 'Shipment audit event exceeds the size limit',
});

const ACTION_MATRIX = Object.freeze({
  WEBHOOK_RECEIVED: Object.freeze({ stage: 'WEBHOOK', outcomes: Object.freeze(['SUCCESS']) }),
  WEBHOOK_ACCEPTED: Object.freeze({ stage: 'WEBHOOK', outcomes: Object.freeze(['SUCCESS']) }),
  WEBHOOK_DUPLICATE: Object.freeze({ stage: 'WEBHOOK', outcomes: Object.freeze(['SUCCESS']) }),
  WEBHOOK_IGNORED: Object.freeze({ stage: 'WEBHOOK', outcomes: Object.freeze(['SUCCESS']) }),
  WEBHOOK_REJECTED: Object.freeze({ stage: 'WEBHOOK', outcomes: Object.freeze(['FAILURE']) }),
  JOB_CLAIMED: Object.freeze({ stage: 'JOB', outcomes: Object.freeze(['SUCCESS']) }),
  VALIDATION_STARTED: Object.freeze({ stage: 'VALIDATION', outcomes: Object.freeze(['STARTED']) }),
  VALIDATION_PASSED: Object.freeze({ stage: 'VALIDATION', outcomes: Object.freeze(['SUCCESS']) }),
  VALIDATION_FAILED: Object.freeze({ stage: 'VALIDATION', outcomes: Object.freeze(['FAILURE']) }),
  PAYLOAD_PREPARED: Object.freeze({ stage: 'PAYLOAD', outcomes: Object.freeze(['SUCCESS']) }),
  FYND_LOCK_REQUESTED: Object.freeze({ stage: 'FYND_LOCK', outcomes: Object.freeze(['STARTED']) }),
  FYND_LOCK_CONFIRMED: Object.freeze({ stage: 'FYND_LOCK', outcomes: Object.freeze(['SUCCESS']) }),
  FYND_LOCK_FAILED: Object.freeze({
    stage: 'FYND_LOCK', outcomes: Object.freeze(['FAILURE', 'TIMEOUT', 'INDETERMINATE']),
  }),
  FYND_LOCK_READBACK: Object.freeze({
    stage: 'FYND_LOCK', outcomes: Object.freeze(['STARTED', 'SUCCESS', 'FAILURE', 'TIMEOUT', 'INDETERMINATE']),
  }),
  OEIS_SUBMISSION_HELD: Object.freeze({ stage: 'OEIS_SUBMISSION', outcomes: Object.freeze(['HELD']) }),
  OEIS_SUBMISSION_REQUESTED: Object.freeze({ stage: 'OEIS_SUBMISSION', outcomes: Object.freeze(['STARTED']) }),
  OEIS_RESPONSE_RECEIVED: Object.freeze({ stage: 'OEIS_SUBMISSION', outcomes: Object.freeze(['SUCCESS']) }),
  OEIS_SUBMISSION_FAILED: Object.freeze({
    stage: 'OEIS_SUBMISSION', outcomes: Object.freeze(['FAILURE', 'TIMEOUT', 'INDETERMINATE']),
  }),
  OEIS_ARTIFACT_STORED: Object.freeze({ stage: 'OEIS_ARTIFACT', outcomes: Object.freeze(['SUCCESS']) }),
  OUTBOX_CLAIMED: Object.freeze({ stage: 'OUTBOX', outcomes: Object.freeze(['SUCCESS']) }),
  FYND_TRANSITION_REQUESTED: Object.freeze({ stage: 'FYND_TRANSITION', outcomes: Object.freeze(['STARTED']) }),
  FYND_TRANSITION_CONFIRMED: Object.freeze({ stage: 'FYND_TRANSITION', outcomes: Object.freeze(['SUCCESS']) }),
  FYND_TRANSITION_FAILED: Object.freeze({
    stage: 'FYND_TRANSITION', outcomes: Object.freeze(['FAILURE', 'TIMEOUT', 'INDETERMINATE']),
  }),
  FYND_TRANSITION_READBACK: Object.freeze({
    stage: 'FYND_TRANSITION', outcomes: Object.freeze(['STARTED', 'SUCCESS', 'FAILURE', 'TIMEOUT', 'INDETERMINATE']),
  }),
  RETRY_SCHEDULED: Object.freeze({ stage: 'RETRY', outcomes: Object.freeze(['RETRY_SCHEDULED']) }),
  LEASE_RECOVERED: Object.freeze({ stage: 'LEASE', outcomes: Object.freeze(['SUCCESS']) }),
  JOB_DATA_FAILED: Object.freeze({ stage: 'JOB', outcomes: Object.freeze(['FAILURE']) }),
  JOB_INDETERMINATE: Object.freeze({ stage: 'JOB', outcomes: Object.freeze(['INDETERMINATE']) }),
  JOB_COMPLETED: Object.freeze({ stage: 'JOB', outcomes: Object.freeze(['SUCCESS']) }),
  LEGACY_STATE_IMPORTED: Object.freeze({
    stage: 'MIGRATION', outcomes: Object.freeze(['HELD', 'FAILURE', 'INDETERMINATE', 'SUCCESS']),
  }),
});

const EXTERNAL_OPERATION_ACTIONS = Object.freeze([
  'FYND_LOCK_REQUESTED',
  'FYND_LOCK_CONFIRMED',
  'FYND_LOCK_FAILED',
  'FYND_LOCK_READBACK',
  'OEIS_SUBMISSION_REQUESTED',
  'OEIS_RESPONSE_RECEIVED',
  'OEIS_SUBMISSION_FAILED',
  'FYND_TRANSITION_REQUESTED',
  'FYND_TRANSITION_CONFIRMED',
  'FYND_TRANSITION_FAILED',
  'FYND_TRANSITION_READBACK',
]);
const EXTERNAL_ACTION_OUTCOME_CASES = Object.freeze(EXTERNAL_OPERATION_ACTIONS.flatMap(action => (
  ACTION_MATRIX[action].outcomes.map(outcome => Object.freeze([action, outcome]))
)));

const EXPECTED_STAGES = Object.freeze([
  'WEBHOOK',
  'JOB',
  'VALIDATION',
  'PAYLOAD',
  'FYND_LOCK',
  'OEIS_SUBMISSION',
  'OEIS_ARTIFACT',
  'OUTBOX',
  'FYND_TRANSITION',
  'RETRY',
  'LEASE',
  'MIGRATION',
]);

const EXPECTED_OUTCOMES = Object.freeze([
  'STARTED',
  'SUCCESS',
  'FAILURE',
  'TIMEOUT',
  'RETRY_SCHEDULED',
  'HELD',
  'INDETERMINATE',
]);

function captureError(operation) {
  try {
    operation();
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to throw');
}

function expectSafeError(operation, code) {
  const error = captureError(operation);
  expect(error).toBeInstanceOf(EinvoiceError);
  expect(error).toMatchObject({
    name: 'EinvoiceError',
    code,
    message: ERROR_MESSAGES[code],
    retryable: false,
  });
  expect(Object.prototype.hasOwnProperty.call(error, 'cause')).toBe(false);
  return error;
}

function baseOperationInput() {
  return {
    targetKind: 'JOB',
    targetId: '42',
    expectedParentVersion: 7,
    attemptNumber: 3,
    stage: 'FYND_LOCK',
    action: 'FYND_LOCK_REQUESTED',
  };
}

function entityEventKey({
  stage = 'VALIDATION',
  action = 'VALIDATION_PASSED',
  outcome = 'SUCCESS',
  scopeId = '42',
  parentVersion = 7,
  attemptNumber = 3,
} = {}) {
  return createEventKey({
    kind: 'ENTITY',
    companyId: '15862',
    shipmentId: '17869621195841424928',
    scopeKind: 'JOB',
    scopeId,
    parentVersion,
    attemptNumber,
    stage,
    action,
    outcome,
  });
}

function operationEventKey({ operationKey = OPERATION_KEY, stage, action, outcome }) {
  return createEventKey({ kind: 'OPERATION', operationKey, stage, action, outcome });
}

function baseEventInput(overrides = {}) {
  return {
    eventKey: ENTITY_EVENT_KEY,
    operationKey: null,
    companyId: '15862',
    applicationId: 'app-9',
    shipmentId: '17869621195841424928',
    jobId: 42,
    documentNumber: 'VR-17869621195841424928-1',
    stage: 'VALIDATION',
    action: 'VALIDATION_PASSED',
    outcome: 'SUCCESS',
    attemptNumber: 3,
    startedAt: null,
    completedAt: null,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: null,
    requestSummary: null,
    responseSummary: null,
    artifactJobId: null,
    ...overrides,
  };
}

function fixedClock(iso = '2026-08-17T12:34:56.789Z') {
  const value = new Date(iso);
  return jest.fn(() => value);
}

function fyndRequest(operation = 'LOCK') {
  return sanitizeFyndSummary('REQUEST', {
    operation,
    shipmentId: '17869621195841424928',
    documentNumber: 'VR-17869621195841424928-1',
    requestedLock: operation === 'LOCK' ? true : null,
    requestedStatus: operation === 'TRANSITION' ? 'bag_invoiced' : null,
  });
}

function fyndResponse(operation = 'LOCK', latencyMs = 25) {
  return sanitizeFyndSummary('RESPONSE', {
    operation,
    shipmentId: '17869621195841424928',
    documentNumber: 'VR-17869621195841424928-1',
    responseStatus: 200,
    locked: operation.startsWith('LOCK') ? true : null,
    shipmentState: 'bag_confirmed',
    finalStateClassification: 'LOCKED',
    retryable: false,
    latencyMs,
  });
}

function oeisRequestInput() {
  return {
    documentNumber: 'VR-17869621195841424928-1',
    documentType: 'IN',
    lineCount: 2,
    currency: 'SAR',
    netAmount: '100.00',
    taxAmount: '15.00',
    totalAmount: '115.00',
    taxSummaries: [
      { category: 'S', rate: '15.00', reasonCode: null, lineCount: 2 },
    ],
    requestByteCount: 901,
    requestSha256: 'a'.repeat(64),
    endpointPath: '/API/V2/Transaction/UpdateInvoiceData',
    attemptNumber: 3,
    timeoutMs: 15000,
  };
}

function oeisResponseInput(overrides = {}) {
  return {
    httpStatus: 200,
    isSystemException: false,
    validationResult: 'VALID',
    reportingStatus: 'REPORTED',
    clearanceStatus: 'CLEARED',
    invoiceNumber: 'INV-8',
    transactionNumber: 'TX-9',
    uuid: '123e4567-e89b-12d3-a456-426614174000',
    invoiceCounter: '11',
    matchingKey: 'MATCH-12',
    validationCodes: ['VALIDATED', 'REPORTED_OK'],
    responseByteCount: 701,
    responseSha256: 'b'.repeat(64),
    retryable: false,
    latencyMs: 25,
    ...overrides,
  };
}

function oeisArtifactInput(overrides = {}) {
  return {
    signedXmlPresent: true,
    signedXmlByteCount: 2048,
    signedXmlSha256: 'c'.repeat(64),
    qrPresent: false,
    qrByteCount: null,
    qrSha256: null,
    ...overrides,
  };
}

function externalAuditEventInput(action, outcome, jobId) {
  const rule = ACTION_MATRIX[action];
  const input = baseEventInput({
    eventKey: operationEventKey({ stage: rule.stage, action, outcome }),
    operationKey: OPERATION_KEY,
    jobId,
    stage: rule.stage,
    action,
    outcome,
    safeCode: ['FAILURE', 'TIMEOUT', 'INDETERMINATE'].includes(outcome)
      ? 'EXTERNAL_OPERATION_FAILED'
      : null,
  });

  if (action === 'FYND_LOCK_REQUESTED') input.requestSummary = fyndRequest('LOCK');
  if (action === 'FYND_LOCK_CONFIRMED' || action === 'FYND_LOCK_FAILED') {
    input.responseSummary = fyndResponse('LOCK', 0);
  }
  if (action === 'FYND_LOCK_READBACK') {
    if (outcome === 'STARTED') input.requestSummary = fyndRequest('LOCK_READBACK');
    else input.responseSummary = fyndResponse('LOCK_READBACK', 0);
  }
  if (action === 'OEIS_SUBMISSION_REQUESTED') {
    input.requestSummary = sanitizeOeisSummary('REQUEST', oeisRequestInput());
  }
  if (action === 'OEIS_RESPONSE_RECEIVED' || action === 'OEIS_SUBMISSION_FAILED') {
    input.responseSummary = sanitizeOeisSummary('RESPONSE', oeisResponseInput({ latencyMs: 0 }));
  }
  if (action === 'FYND_TRANSITION_REQUESTED') input.requestSummary = fyndRequest('TRANSITION');
  if (action === 'FYND_TRANSITION_CONFIRMED' || action === 'FYND_TRANSITION_FAILED') {
    input.responseSummary = fyndResponse('TRANSITION', 0);
  }
  if (action === 'FYND_TRANSITION_READBACK') {
    if (outcome === 'STARTED') input.requestSummary = fyndRequest('TRANSITION_READBACK');
    else input.responseSummary = fyndResponse('TRANSITION_READBACK', 0);
  }
  return input;
}

function canonicalOeisResponse(input) {
  return {
    kind: 'OEIS_RESPONSE',
    httpStatus: input.httpStatus,
    isSystemException: input.isSystemException,
    validationResult: input.validationResult,
    reportingStatus: input.reportingStatus,
    clearanceStatus: input.clearanceStatus,
    invoiceNumber: input.invoiceNumber,
    transactionNumber: input.transactionNumber,
    uuid: input.uuid,
    invoiceCounter: input.invoiceCounter,
    matchingKey: input.matchingKey,
    validationCodes: input.validationCodes,
    responseByteCount: input.responseByteCount,
    responseSha256: input.responseSha256,
    retryable: input.retryable,
    latencyMs: input.latencyMs,
  };
}

function oeisResponseAtJsonBytes(targetBytes, overrides = {}) {
  const input = oeisResponseInput({
    invoiceNumber: 'A',
    transactionNumber: 'A',
    uuid: null,
    invoiceCounter: 'A',
    matchingKey: 'A',
    validationCodes: [],
    responseByteCount: null,
    responseSha256: null,
    ...overrides,
  });
  const expandable = ['invoiceNumber', 'transactionNumber', 'invoiceCounter', 'matchingKey'];
  const size = () => Buffer.byteLength(JSON.stringify(canonicalOeisResponse(input)), 'utf8');

  for (const field of expandable) {
    while (input[field].length < 512 && size() < targetBytes) {
      const escapedCandidate = `${input[field]}\\`;
      input[field] = escapedCandidate;
      if (size() > targetBytes) {
        input[field] = escapedCandidate.slice(0, -1);
        const plainCandidate = `${input[field]}A`;
        input[field] = plainCandidate;
        if (size() > targetBytes) input[field] = plainCandidate.slice(0, -1);
      }
    }
  }

  if (size() !== targetBytes) {
    throw new Error(`Could not construct independent ${targetBytes}-byte fixture; got ${size()}`);
  }
  return input;
}

function expectDeepFrozen(value, seen = new Set()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) expectDeepFrozen(descriptor.value, seen);
  }
}

describe('audit constants and action contract', () => {
  test('exports the exact retention and byte limits as immutable values', () => {
    expect(AUDIT_RETENTION_MS).toBe(7_776_000_000);
    expect(AUDIT_SUMMARY_MAX_BYTES).toBe(4_096);
    expect(AUDIT_EVENT_MAX_BYTES).toBe(12_288);
  });

  test('exports the exact frozen stage, action, outcome, and action-outcome matrix', () => {
    expect(AUDIT_STAGES).toEqual(EXPECTED_STAGES);
    expect(AUDIT_ACTIONS).toEqual(Object.keys(ACTION_MATRIX));
    expect(AUDIT_OUTCOMES).toEqual(EXPECTED_OUTCOMES);
    expect(AUDIT_ACTION_OUTCOMES).toEqual(Object.fromEntries(
      Object.entries(ACTION_MATRIX).map(([action, rule]) => [action, [...rule.outcomes]]),
    ));
    expectDeepFrozen(AUDIT_STAGES);
    expectDeepFrozen(AUDIT_ACTIONS);
    expectDeepFrozen(AUDIT_OUTCOMES);
    expectDeepFrozen(AUDIT_ACTION_OUTCOMES);
  });

  test('accepts every exact stage/action/outcome combination and rejects every wrong outcome', () => {
    for (const [action, rule] of Object.entries(ACTION_MATRIX)) {
      for (const outcome of rule.outcomes) {
        expect(createEventKey({
          kind: 'ENTITY',
          companyId: '15862',
          shipmentId: 'shipment-2',
          scopeKind: 'JOB',
          scopeId: '42',
          parentVersion: 7,
          attemptNumber: 3,
          stage: rule.stage,
          action,
          outcome,
        })).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);
      }

      const rejectedOutcome = EXPECTED_OUTCOMES.find(outcome => !rule.outcomes.includes(outcome));
      expectSafeError(() => createEventKey({
        kind: 'ENTITY',
        companyId: '15862',
        shipmentId: 'shipment-2',
        scopeKind: 'JOB',
        scopeId: '42',
        parentVersion: 7,
        attemptNumber: 3,
        stage: rule.stage,
        action,
        outcome: rejectedOutcome,
      }), 'AUDIT_INPUT_INVALID');

      const wrongStage = EXPECTED_STAGES.find(stage => stage !== rule.stage);
      expectSafeError(() => createEventKey({
        kind: 'ENTITY',
        companyId: '15862',
        shipmentId: 'shipment-2',
        scopeKind: 'JOB',
        scopeId: '42',
        parentVersion: 7,
        attemptNumber: 3,
        stage: wrongStage,
        action,
        outcome: rule.outcomes[0],
      }), 'AUDIT_INPUT_INVALID');
    }
  });
});

describe('canonical operation and event keys', () => {
  test('matches the hand-derived operation digest fixture', () => {
    expect(createOperationKey(baseOperationInput())).toBe(OPERATION_KEY);
  });

  test.each([
    ['target kind', { targetKind: 'OUTBOX' }],
    ['target id', { targetId: '43' }],
    ['parent version', { expectedParentVersion: 8 }],
    ['attempt number', { attemptNumber: 4 }],
    ['action', { action: 'FYND_LOCK_READBACK' }],
    ['matched stage/action pair', { stage: 'OEIS_SUBMISSION', action: 'OEIS_SUBMISSION_REQUESTED' }],
  ])('changes the operation digest when %s changes', (_description, mutation) => {
    expect(createOperationKey({ ...baseOperationInput(), ...mutation })).not.toBe(OPERATION_KEY);
  });

  test('matches all three hand-derived event digest fixtures', () => {
    expect(createEventKey({
      kind: 'OPERATION',
      operationKey: OPERATION_KEY,
      stage: 'FYND_LOCK',
      action: 'FYND_LOCK_REQUESTED',
      outcome: 'STARTED',
    })).toBe(OPERATION_EVENT_KEY);

    expect(createEventKey({
      kind: 'WEBHOOK_RECEIPT',
      companyId: '15862',
      eventId: 'DZlcvyBgMu/zX1n9knpNNfl7lVPsG/Pgqbpyjt+SbhU=',
    })).toBe(RECEIPT_EVENT_KEY);

    expect(createEventKey({
      kind: 'ENTITY',
      companyId: '15862',
      shipmentId: '17869621195841424928',
      scopeKind: 'JOB',
      scopeId: '42',
      parentVersion: 7,
      attemptNumber: 3,
      stage: 'VALIDATION',
      action: 'VALIDATION_PASSED',
      outcome: 'SUCCESS',
    })).toBe(ENTITY_EVENT_KEY);
  });

  test('changes an operation event digest for outcome while preserving the operation key', () => {
    const failure = createEventKey({
      kind: 'OPERATION', operationKey: OPERATION_KEY, stage: 'FYND_LOCK', action: 'FYND_LOCK_FAILED', outcome: 'FAILURE',
    });
    const timeout = createEventKey({
      kind: 'OPERATION', operationKey: OPERATION_KEY, stage: 'FYND_LOCK', action: 'FYND_LOCK_FAILED', outcome: 'TIMEOUT',
    });
    expect(failure).not.toBe(timeout);
    expect(createOperationKey(baseOperationInput())).toBe(OPERATION_KEY);
  });

  test('accepts exactly the external-operation event actions and rejects every other action', () => {
    for (const action of EXTERNAL_OPERATION_ACTIONS) {
      const rule = ACTION_MATRIX[action];
      for (const outcome of rule.outcomes) {
        expect(createEventKey({
          kind: 'OPERATION',
          operationKey: OPERATION_KEY,
          stage: rule.stage,
          action,
          outcome,
        })).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);
      }
    }

    for (const [action, rule] of Object.entries(ACTION_MATRIX)) {
      if (EXTERNAL_OPERATION_ACTIONS.includes(action)) continue;
      for (const outcome of rule.outcomes) {
        expectSafeError(() => createEventKey({
          kind: 'OPERATION',
          operationKey: OPERATION_KEY,
          stage: rule.stage,
          action,
          outcome,
        }), 'AUDIT_INPUT_INVALID');
      }
    }
  });

  test('uses exact types and canonical positive-safe-integer decimal strings without coercion', () => {
    for (const targetId of [42, '0', '-1', '+1', '01', '1.0', '9007199254740992']) {
      expectSafeError(() => createOperationKey({ ...baseOperationInput(), targetId }), 'AUDIT_INPUT_INVALID');
    }
    for (const expectedParentVersion of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '7']) {
      expectSafeError(
        () => createOperationKey({ ...baseOperationInput(), expectedParentVersion }),
        'AUDIT_INPUT_INVALID',
      );
    }
    for (const attemptNumber of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3']) {
      expectSafeError(() => createOperationKey({ ...baseOperationInput(), attemptNumber }), 'AUDIT_INPUT_INVALID');
    }
  });

  test('restricts operation keys to matching external dependency actions', () => {
    for (const mutation of [
      { stage: 'FYND_LOCK', action: 'FYND_TRANSITION_REQUESTED' },
      { stage: 'VALIDATION', action: 'VALIDATION_STARTED' },
      { stage: 'OEIS_SUBMISSION', action: 'OEIS_SUBMISSION_FAILED' },
    ]) {
      expectSafeError(() => createOperationKey({ ...baseOperationInput(), ...mutation }), 'AUDIT_INPUT_INVALID');
    }
  });

  test.each([
    null,
    [],
    Object.create(null),
    new (class Input {})(),
  ])('rejects non-plain key input %#', input => {
    expectSafeError(() => createOperationKey(input), 'AUDIT_INPUT_INVALID');
  });

  test('rejects missing, inherited, extra, and symbol key properties', () => {
    const missing = baseOperationInput();
    delete missing.action;
    expectSafeError(() => createOperationKey(missing), 'AUDIT_INPUT_INVALID');

    const inherited = Object.create({ action: 'FYND_LOCK_REQUESTED' });
    Object.assign(inherited, baseOperationInput());
    delete inherited.action;
    expectSafeError(() => createOperationKey(inherited), 'AUDIT_INPUT_INVALID');

    expectSafeError(() => createOperationKey({ ...baseOperationInput(), unexpected: true }), 'AUDIT_INPUT_INVALID');
    const symbolInput = baseOperationInput();
    symbolInput[Symbol('secret')] = 'never';
    expectSafeError(() => createOperationKey(symbolInput), 'AUDIT_INPUT_INVALID');
  });

  test('rejects accessors and proxies without executing attacker code', () => {
    const accessorCounter = { calls: 0 };
    const accessor = baseOperationInput();
    delete accessor.targetId;
    Object.defineProperty(accessor, 'targetId', {
      enumerable: true,
      get() {
        accessorCounter.calls += 1;
        return '42';
      },
    });
    expectSafeError(() => createOperationKey(accessor), 'AUDIT_INPUT_INVALID');
    expect(accessorCounter.calls).toBe(0);

    const proxyCounter = { calls: 0 };
    const proxy = new Proxy(baseOperationInput(), {
      get() { proxyCounter.calls += 1; return 'private'; },
      ownKeys() { proxyCounter.calls += 1; return []; },
      getOwnPropertyDescriptor() { proxyCounter.calls += 1; return undefined; },
      getPrototypeOf() { proxyCounter.calls += 1; return Object.prototype; },
    });
    expectSafeError(() => createOperationKey(proxy), 'AUDIT_INPUT_INVALID');
    expect(proxyCounter.calls).toBe(0);
  });

  test('enforces discriminated event-key shapes and bounded scope identifiers', () => {
    expectSafeError(() => createEventKey({
      kind: 'WEBHOOK_RECEIPT', companyId: '15862', eventId: 'evt-1', shipmentId: 'forbidden',
    }), 'AUDIT_INPUT_INVALID');
    expectSafeError(() => createEventKey({
      kind: 'ENTITY',
      companyId: '15862',
      shipmentId: 'shipment-2',
      scopeKind: 'JOB',
      scopeId: '01',
      parentVersion: 0,
      attemptNumber: 0,
      stage: 'JOB',
      action: 'JOB_COMPLETED',
      outcome: 'SUCCESS',
    }), 'AUDIT_INPUT_INVALID');
    expectSafeError(() => createEventKey({
      kind: 'ENTITY',
      companyId: '15862',
      shipmentId: 'shipment-2',
      scopeKind: 'WEBHOOK',
      scopeId: 'x'.repeat(513),
      parentVersion: 0,
      attemptNumber: 0,
      stage: 'WEBHOOK',
      action: 'WEBHOOK_ACCEPTED',
      outcome: 'SUCCESS',
    }), 'AUDIT_INPUT_INVALID');
  });
});

describe('Fynd summary sanitization', () => {
  test.each([
    ['LOCK', true, null],
    ['LOCK_READBACK', null, null],
    ['TRANSITION', null, 'bag_invoiced'],
    ['TRANSITION_READBACK', null, null],
  ])('projects and brands a %s request without retaining caller objects', (operation, requestedLock, requestedStatus) => {
    const input = {
      operation,
      shipmentId: 'shipment-2',
      documentNumber: 'VR-shipment-2-1',
      requestedLock,
      requestedStatus,
    };
    const result = sanitizeFyndSummary('REQUEST', input);
    expect(result).toEqual({
      kind: 'FYND_REQUEST',
      operation,
      shipmentId: 'shipment-2',
      documentNumber: 'VR-shipment-2-1',
      requestedLock,
      requestedStatus,
    });
    expect(result).not.toBe(input);
    expectDeepFrozen(result);
  });

  test('projects every Fynd response field in canonical order', () => {
    const result = sanitizeFyndSummary('RESPONSE', {
      operation: 'TRANSITION_READBACK',
      shipmentId: 'shipment-2',
      documentNumber: 'VR-shipment-2-1',
      responseStatus: null,
      locked: false,
      shipmentState: 'bag_invoiced',
      finalStateClassification: 'INVOICED',
      retryable: true,
      latencyMs: 501,
    });
    expect(result).toEqual({
      kind: 'FYND_RESPONSE',
      operation: 'TRANSITION_READBACK',
      shipmentId: 'shipment-2',
      documentNumber: 'VR-shipment-2-1',
      responseStatus: null,
      locked: false,
      shipmentState: 'bag_invoiced',
      finalStateClassification: 'INVOICED',
      retryable: true,
      latencyMs: 501,
    });
    expect(Object.keys(result)).toEqual([
      'kind', 'operation', 'shipmentId', 'documentNumber', 'responseStatus', 'locked', 'shipmentState',
      'finalStateClassification', 'retryable', 'latencyMs',
    ]);
    expectDeepFrozen(result);
  });

  test.each([
    ['LOCK without requestedLock', 'REQUEST', { operation: 'LOCK', requestedLock: null, requestedStatus: null }],
    ['LOCK with a status', 'REQUEST', { operation: 'LOCK', requestedLock: true, requestedStatus: 'bag_invoiced' }],
    ['TRANSITION with a lock', 'REQUEST', { operation: 'TRANSITION', requestedLock: true, requestedStatus: 'bag_invoiced' }],
    ['readback with a requested lock', 'REQUEST', { operation: 'LOCK_READBACK', requestedLock: false, requestedStatus: null }],
    ['bad status', 'RESPONSE', { responseStatus: 99 }],
    ['fractional status', 'RESPONSE', { responseStatus: 200.5 }],
    ['bad shipment state', 'RESPONSE', { shipmentState: 'Bag Invoiced' }],
    ['bad final classification', 'RESPONSE', { finalStateClassification: 'FINAL' }],
    ['bad retryable', 'RESPONSE', { retryable: 1 }],
    ['bad latency', 'RESPONSE', { latencyMs: -1 }],
  ])('rejects invalid Fynd summary invariant: %s', (_description, kind, mutation) => {
    const input = kind === 'REQUEST'
      ? {
        operation: 'LOCK', shipmentId: 'shipment-2', documentNumber: 'VR-shipment-2-1',
        requestedLock: true, requestedStatus: null, ...mutation,
      }
      : {
        operation: 'LOCK', shipmentId: 'shipment-2', documentNumber: 'VR-shipment-2-1',
        responseStatus: 200, locked: true, shipmentState: 'bag_confirmed',
        finalStateClassification: 'LOCKED', retryable: false, latencyMs: 25, ...mutation,
      };
    expectSafeError(() => sanitizeFyndSummary(kind, input), 'AUDIT_SUMMARY_INVALID');
  });

  test('rejects secret, PII, XML, QR, raw-message, and unknown fields without reflecting sentinels', () => {
    const forbidden = [
      ['access_token', 'token-sentinel'],
      ['nationalId', 'national-id-sentinel'],
      ['buyerName', 'buyer-name-sentinel'],
      ['signedXmlBase64', 'xml-sentinel'],
      ['qrBase64', 'qr-sentinel'],
      ['rawMessage', 'raw-message-sentinel'],
      ['address', 'address-sentinel'],
      ['email', 'email-sentinel'],
      ['cardNumber', 'card-sentinel'],
      ['headers', 'authorization-sentinel'],
    ];
    for (const [field, sentinel] of forbidden) {
      const error = expectSafeError(() => sanitizeFyndSummary('REQUEST', {
        operation: 'LOCK',
        shipmentId: 'shipment-2',
        documentNumber: 'VR-shipment-2-1',
        requestedLock: true,
        requestedStatus: null,
        [field]: sentinel,
      }), 'AUDIT_SUMMARY_INVALID');
      expect(`${error.code} ${error.message}`).not.toContain(sentinel);
    }
  });

  test('returns a fresh fixed error for every invalid call', () => {
    const first = captureError(() => sanitizeFyndSummary('REQUEST', null));
    const second = captureError(() => sanitizeFyndSummary('REQUEST', null));
    expect(first).not.toBe(second);
    expect(first).toMatchObject({ code: 'AUDIT_SUMMARY_INVALID' });
    expect(second).toMatchObject({ code: 'AUDIT_SUMMARY_INVALID' });
    expect(Object.prototype.hasOwnProperty.call(first, 'cause')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(second, 'cause')).toBe(false);
  });
});

describe('OEIS summary sanitization', () => {
  test('projects an exact request and deeply copies its tax summaries', () => {
    const input = oeisRequestInput();
    const result = sanitizeOeisSummary('REQUEST', input);
    expect(result).toEqual({ kind: 'OEIS_REQUEST', ...input });
    expect(Object.keys(result)).toEqual([
      'kind', 'documentNumber', 'documentType', 'lineCount', 'currency', 'netAmount', 'taxAmount',
      'totalAmount', 'taxSummaries', 'requestByteCount', 'requestSha256', 'endpointPath', 'attemptNumber',
      'timeoutMs',
    ]);
    expect(result.taxSummaries).not.toBe(input.taxSummaries);
    expect(result.taxSummaries[0]).not.toBe(input.taxSummaries[0]);
    input.taxSummaries[0].rate = '99.00';
    input.taxSummaries.push({ category: 'E', rate: '0.00', reasonCode: 'EXEMPT', lineCount: 1 });
    expect(result.taxSummaries).toEqual([
      { category: 'S', rate: '15.00', reasonCode: null, lineCount: 2 },
    ]);
    expectDeepFrozen(result);
  });

  test('projects every nullable response field and deeply copies validation codes', () => {
    const input = oeisResponseInput();
    const result = sanitizeOeisSummary('RESPONSE', input);
    expect(result).toEqual({ kind: 'OEIS_RESPONSE', ...input });
    expect(result.validationCodes).not.toBe(input.validationCodes);
    input.validationCodes.push('LATE_MUTATION');
    expect(result.validationCodes).toEqual(['VALIDATED', 'REPORTED_OK']);
    expect(Object.keys(result)).toEqual([
      'kind', 'httpStatus', 'isSystemException', 'validationResult', 'reportingStatus', 'clearanceStatus',
      'invoiceNumber', 'transactionNumber', 'uuid', 'invoiceCounter', 'matchingKey', 'validationCodes',
      'responseByteCount', 'responseSha256', 'retryable', 'latencyMs',
    ]);
    expectDeepFrozen(result);
  });

  test.each([
    [false, null, null, false, null, null],
    [true, 1, 'd'.repeat(64), true, 2, 'e'.repeat(64)],
  ])('projects exact artifact presence metadata', (
    signedXmlPresent,
    signedXmlByteCount,
    signedXmlSha256,
    qrPresent,
    qrByteCount,
    qrSha256,
  ) => {
    expect(sanitizeOeisSummary('ARTIFACT', {
      signedXmlPresent,
      signedXmlByteCount,
      signedXmlSha256,
      qrPresent,
      qrByteCount,
      qrSha256,
    })).toEqual({
      kind: 'OEIS_ARTIFACT',
      signedXmlPresent,
      signedXmlByteCount,
      signedXmlSha256,
      qrPresent,
      qrByteCount,
      qrSha256,
    });
  });

  test.each([
    ['document type', { documentType: 'invoice' }],
    ['zero lines', { lineCount: 0 }],
    ['too many lines', { lineCount: 1001 }],
    ['currency', { currency: 'USD' }],
    ['noncanonical leading zero', { netAmount: '01.00' }],
    ['missing decimals', { taxAmount: '15' }],
    ['too many decimals', { totalAmount: '115.000' }],
    ['too many integer digits', { netAmount: `${'1'.repeat(19)}.00` }],
    ['request byte count', { requestByteCount: 0 }],
    ['uppercase request hash', { requestSha256: 'A'.repeat(64) }],
    ['endpoint', { endpointPath: '/wrong' }],
    ['attempt', { attemptNumber: 0 }],
    ['timeout', { timeoutMs: 0 }],
  ])('rejects invalid OEIS request field: %s', (_description, mutation) => {
    expectSafeError(
      () => sanitizeOeisSummary('REQUEST', { ...oeisRequestInput(), ...mutation }),
      'AUDIT_SUMMARY_INVALID',
    );
  });

  test.each([
    ['tax list too large', { taxSummaries: Array.from({ length: 17 }, (_, i) => ({
      category: 'S', rate: '15.00', reasonCode: `R-${i}`, lineCount: 1,
    })) }],
    ['tax category', { taxSummaries: [{ category: 'X', rate: '15.00', reasonCode: null, lineCount: 1 }] }],
    ['tax rate', { taxSummaries: [{ category: 'S', rate: '15.0', reasonCode: null, lineCount: 1 }] }],
    ['tax reason', { taxSummaries: [{ category: 'Z', rate: '0.00', reasonCode: 'bad reason', lineCount: 1 }] }],
    ['tax line count', { taxSummaries: [{ category: 'S', rate: '15.00', reasonCode: null, lineCount: 0 }] }],
    ['tax unknown key', { taxSummaries: [{
      category: 'S', rate: '15.00', reasonCode: null, lineCount: 1, raw: 'secret',
    }] }],
  ])('rejects invalid OEIS tax-summary structure: %s', (_description, mutation) => {
    expectSafeError(
      () => sanitizeOeisSummary('REQUEST', { ...oeisRequestInput(), ...mutation }),
      'AUDIT_SUMMARY_INVALID',
    );
  });

  test.each([
    ['HTTP status', { httpStatus: 600 }],
    ['system exception', { isSystemException: 'false' }],
    ['validation result', { validationResult: 'OK' }],
    ['reporting status', { reportingStatus: 'DONE' }],
    ['clearance status', { clearanceStatus: 'DONE' }],
    ['uppercase UUID', { uuid: '123E4567-E89B-12D3-A456-426614174000' }],
    ['invalid UUID', { uuid: 'uuid-1' }],
    ['duplicate validation code', { validationCodes: ['DUPLICATE', 'DUPLICATE'] }],
    ['invalid validation code', { validationCodes: ['bad-code'] }],
    ['too many validation codes', { validationCodes: Array.from({ length: 21 }, (_, i) => `CODE_${i}`) }],
    ['byte count without hash', { responseByteCount: 3, responseSha256: null }],
    ['hash without byte count', { responseByteCount: null, responseSha256: 'a'.repeat(64) }],
    ['uppercase response hash', { responseSha256: 'B'.repeat(64) }],
    ['retryable', { retryable: 0 }],
    ['latency', { latencyMs: -1 }],
  ])('rejects invalid OEIS response field: %s', (_description, mutation) => {
    expectSafeError(
      () => sanitizeOeisSummary('RESPONSE', oeisResponseInput(mutation)),
      'AUDIT_SUMMARY_INVALID',
    );
  });

  test.each([
    ['XML absent with bytes', { signedXmlPresent: false, signedXmlByteCount: 1, signedXmlSha256: null }],
    ['XML present without bytes', { signedXmlPresent: true, signedXmlByteCount: null, signedXmlSha256: 'a'.repeat(64) }],
    ['XML present with zero bytes', { signedXmlPresent: true, signedXmlByteCount: 0, signedXmlSha256: 'a'.repeat(64) }],
    ['QR absent with hash', { qrPresent: false, qrByteCount: null, qrSha256: 'a'.repeat(64) }],
    ['QR present without hash', { qrPresent: true, qrByteCount: 5, qrSha256: null }],
  ])('rejects invalid OEIS artifact metadata: %s', (_description, mutation) => {
    expectSafeError(
      () => sanitizeOeisSummary('ARTIFACT', oeisArtifactInput(mutation)),
      'AUDIT_SUMMARY_INVALID',
    );
  });

  test('accepts exactly 4096 UTF-8 JSON bytes and rejects 4097 after JSON escaping', () => {
    const acceptedInput = oeisResponseAtJsonBytes(4_096);
    const rejectedInput = oeisResponseAtJsonBytes(4_097);
    expect(Buffer.byteLength(JSON.stringify(canonicalOeisResponse(acceptedInput)), 'utf8')).toBe(4_096);
    expect(Buffer.byteLength(JSON.stringify(canonicalOeisResponse(rejectedInput)), 'utf8')).toBe(4_097);
    const accepted = sanitizeOeisSummary('RESPONSE', acceptedInput);
    expect(Buffer.byteLength(JSON.stringify(accepted), 'utf8')).toBe(4_096);
    expect(JSON.stringify(accepted)).toContain('\\\\');
    expectSafeError(
      () => sanitizeOeisSummary('RESPONSE', rejectedInput),
      'AUDIT_SUMMARY_TOO_LARGE',
    );
  });

  test('rejects multibyte identifier data instead of miscounting JavaScript code units', () => {
    expectSafeError(
      () => sanitizeOeisSummary('RESPONSE', oeisResponseInput({ invoiceNumber: 'é'.repeat(256) })),
      'AUDIT_SUMMARY_INVALID',
    );
  });

  test('rejects outer and nested proxies without executing traps', () => {
    for (const makeOperation of [
      counter => () => sanitizeOeisSummary('REQUEST', new Proxy(oeisRequestInput(), {
        get() { counter.calls += 1; return 'secret'; },
        ownKeys() { counter.calls += 1; return []; },
        getOwnPropertyDescriptor() { counter.calls += 1; return undefined; },
        getPrototypeOf() { counter.calls += 1; return Object.prototype; },
      })),
      counter => () => sanitizeOeisSummary('REQUEST', {
        ...oeisRequestInput(),
        taxSummaries: new Proxy(oeisRequestInput().taxSummaries, {
          get() { counter.calls += 1; return 'secret'; },
          ownKeys() { counter.calls += 1; return []; },
          getOwnPropertyDescriptor() { counter.calls += 1; return undefined; },
          getPrototypeOf() { counter.calls += 1; return Array.prototype; },
        }),
      }),
      counter => () => sanitizeOeisSummary('RESPONSE', oeisResponseInput({
        validationCodes: new Proxy(['VALID'], {
          get() { counter.calls += 1; return 'secret'; },
          ownKeys() { counter.calls += 1; return []; },
          getOwnPropertyDescriptor() { counter.calls += 1; return undefined; },
          getPrototypeOf() { counter.calls += 1; return Array.prototype; },
        }),
      })),
    ]) {
      const counter = { calls: 0 };
      expectSafeError(makeOperation(counter), 'AUDIT_SUMMARY_INVALID');
      expect(counter.calls).toBe(0);
    }
  });

  test('rejects nested accessors without invoking them', () => {
    const counter = { calls: 0 };
    const tax = { category: 'S', rate: '15.00', reasonCode: null };
    Object.defineProperty(tax, 'lineCount', {
      enumerable: true,
      get() { counter.calls += 1; return 1; },
    });
    expectSafeError(
      () => sanitizeOeisSummary('REQUEST', { ...oeisRequestInput(), taxSummaries: [tax] }),
      'AUDIT_SUMMARY_INVALID',
    );
    expect(counter.calls).toBe(0);
  });

  test('rejects null-prototype, class, sparse, extra-key, and symbol-key nested values', () => {
    const classTax = new (class Tax {})();
    Object.assign(classTax, { category: 'S', rate: '15.00', reasonCode: null, lineCount: 1 });
    const nullTax = Object.assign(Object.create(null), {
      category: 'S', rate: '15.00', reasonCode: null, lineCount: 1,
    });
    for (const taxSummaries of [[classTax], [nullTax], new Array(1)]) {
      expectSafeError(
        () => sanitizeOeisSummary('REQUEST', { ...oeisRequestInput(), taxSummaries }),
        'AUDIT_SUMMARY_INVALID',
      );
    }
    const extraArray = [{ category: 'S', rate: '15.00', reasonCode: null, lineCount: 1 }];
    extraArray.extra = true;
    expectSafeError(
      () => sanitizeOeisSummary('REQUEST', { ...oeisRequestInput(), taxSummaries: extraArray }),
      'AUDIT_SUMMARY_INVALID',
    );
    const symbolArray = ['VALIDATED'];
    symbolArray[Symbol('hidden')] = 'secret';
    expectSafeError(
      () => sanitizeOeisSummary('RESPONSE', oeisResponseInput({ validationCodes: symbolArray })),
      'AUDIT_SUMMARY_INVALID',
    );
  });

  test('rejects unknown sanitizer kinds and arbitrary branded-lookalike kind properties', () => {
    expectSafeError(() => sanitizeOeisSummary('RAW', oeisRequestInput()), 'AUDIT_SUMMARY_INVALID');
    expectSafeError(
      () => sanitizeOeisSummary('REQUEST', { kind: 'OEIS_REQUEST', ...oeisRequestInput() }),
      'AUDIT_SUMMARY_INVALID',
    );
  });

  test('rejects OEIS secret, identity, raw-body, XML, and QR content fields without reflection', () => {
    const cases = [
      ['REQUEST', oeisRequestInput(), 'authorization', 'private-oeis-token'],
      ['REQUEST', oeisRequestInput(), 'buyerName', 'private-buyer-name'],
      ['RESPONSE', oeisResponseInput(), 'rawResponse', 'private-raw-response'],
      ['RESPONSE', oeisResponseInput(), 'nationalId', 'private-national-id'],
      ['ARTIFACT', oeisArtifactInput(), 'signedXmlBase64', 'private-signed-xml'],
      ['ARTIFACT', oeisArtifactInput(), 'qrBase64', 'private-qr'],
    ];
    for (const [kind, input, field, sentinel] of cases) {
      const error = expectSafeError(
        () => sanitizeOeisSummary(kind, { ...input, [field]: sentinel }),
        'AUDIT_SUMMARY_INVALID',
      );
      expect(`${error.code} ${error.message}`).not.toContain(sentinel);
    }
  });
});

describe('audit event construction, timing, placement, and retention', () => {
  test('creates the exact canonical output with one trusted clock call and 90-day retention', () => {
    const now = fixedClock();
    const sourceNow = now();
    now.mockClear();
    const event = createAuditEvent(baseEventInput(), { now });
    expect(now).toHaveBeenCalledTimes(1);
    expect(event).toEqual({
      eventKey: ENTITY_EVENT_KEY,
      operationKey: null,
      companyId: '15862',
      applicationId: 'app-9',
      shipmentId: '17869621195841424928',
      jobId: 42,
      documentNumber: 'VR-17869621195841424928-1',
      stage: 'VALIDATION',
      action: 'VALIDATION_PASSED',
      outcome: 'SUCCESS',
      attemptNumber: 3,
      startedAt: '2026-08-17T12:34:56.789Z',
      completedAt: '2026-08-17T12:34:56.789Z',
      durationMs: 0,
      queueDelayMs: null,
      retryDelayMs: null,
      nextAttemptAt: null,
      safeCode: null,
      requestSummary: null,
      responseSummary: null,
      artifactJobId: null,
      occurredAt: '2026-08-17T12:34:56.789Z',
      expiresAt: '2026-11-15T12:34:56.789Z',
    });
    expect(Object.keys(event)).toEqual([
      'eventKey', 'operationKey', 'companyId', 'applicationId', 'shipmentId', 'jobId', 'documentNumber',
      'stage', 'action', 'outcome', 'attemptNumber', 'startedAt', 'completedAt', 'durationMs', 'queueDelayMs',
      'retryDelayMs', 'nextAttemptAt', 'safeCode', 'requestSummary', 'responseSummary', 'artifactJobId',
      'occurredAt', 'expiresAt',
    ]);
    expect(event.occurredAt).not.toBe(sourceNow);
    expect(Date.parse(event.expiresAt) - Date.parse(event.occurredAt)).toBe(7_776_000_000);
    for (const field of ['startedAt', 'completedAt', 'occurredAt', 'expiresAt']) {
      expect(typeof event[field]).toBe('string');
      expect(new Date(event[field]).toISOString()).toBe(event[field]);
      expect(event[field].setUTCFullYear).toBeUndefined();
    }
    expect(Object.getPrototypeOf(event)).toBe(Object.prototype);
    expect(() => { event.occurredAt = '2000-01-01T00:00:00.000Z'; }).toThrow(TypeError);
    expectDeepFrozen(event);
  });

  test('derives STARTED and completed timing without accepting caller duration', () => {
    const start = createAuditEvent(baseEventInput({
      eventKey: entityEventKey({ stage: 'VALIDATION', action: 'VALIDATION_STARTED', outcome: 'STARTED' }),
      stage: 'VALIDATION',
      action: 'VALIDATION_STARTED',
      outcome: 'STARTED',
    }), { now: fixedClock() });
    expect(start.startedAt).toBe('2026-08-17T12:34:56.789Z');
    expect(start.completedAt).toBeNull();
    expect(start.durationMs).toBeNull();

    const sourceStart = new Date('2026-08-17T12:00:00.000Z');
    const sourceCompletion = new Date('2026-08-17T12:00:01.234Z');
    const completedInput = baseEventInput({ startedAt: sourceStart, completedAt: sourceCompletion });
    const completed = createAuditEvent(completedInput, { now: fixedClock() });
    expect(completed.startedAt).toBe('2026-08-17T12:00:00.000Z');
    expect(completed.completedAt).toBe('2026-08-17T12:00:01.234Z');
    expect(completed.durationMs).toBe(1_234);
    expect(completed.startedAt).not.toBe(sourceStart);
    expect(completed.completedAt).not.toBe(sourceCompletion);
    expect(Object.isFrozen(completedInput)).toBe(false);
    expect(Object.isFrozen(sourceStart)).toBe(false);

    expectSafeError(
      () => createAuditEvent({ ...baseEventInput(), durationMs: 1 }, { now: fixedClock() }),
      'AUDIT_INPUT_INVALID',
    );
  });

  test('derives queue delay and retry next-attempt evidence only on their exact actions', () => {
    const claimed = createAuditEvent(baseEventInput({
      eventKey: entityEventKey({ stage: 'JOB', action: 'JOB_CLAIMED', outcome: 'SUCCESS' }),
      stage: 'JOB', action: 'JOB_CLAIMED', outcome: 'SUCCESS', queueDelayMs: 900,
    }), { now: fixedClock() });
    expect(claimed.queueDelayMs).toBe(900);
    expect(claimed.retryDelayMs).toBeNull();
    expect(claimed.nextAttemptAt).toBeNull();

    const retry = createAuditEvent(baseEventInput({
      eventKey: entityEventKey({ stage: 'RETRY', action: 'RETRY_SCHEDULED', outcome: 'RETRY_SCHEDULED' }),
      stage: 'RETRY', action: 'RETRY_SCHEDULED', outcome: 'RETRY_SCHEDULED', retryDelayMs: 60_001,
    }), { now: fixedClock() });
    expect(retry.retryDelayMs).toBe(60_001);
    expect(retry.nextAttemptAt).toBe('2026-08-17T12:35:56.790Z');
    expect(new Date(retry.nextAttemptAt).toISOString()).toBe(retry.nextAttemptAt);
    expect(retry.nextAttemptAt.setUTCMinutes).toBeUndefined();

    expectSafeError(
      () => createAuditEvent(baseEventInput({ queueDelayMs: 1 }), { now: fixedClock() }),
      'AUDIT_INPUT_INVALID',
    );
    expectSafeError(
      () => createAuditEvent(baseEventInput({ retryDelayMs: 1 }), { now: fixedClock() }),
      'AUDIT_INPUT_INVALID',
    );
    expectSafeError(() => createAuditEvent(baseEventInput({
      eventKey: entityEventKey({ stage: 'JOB', action: 'JOB_CLAIMED', outcome: 'SUCCESS' }),
      stage: 'JOB', action: 'JOB_CLAIMED', outcome: 'SUCCESS', queueDelayMs: null,
    }), { now: fixedClock() }), 'AUDIT_INPUT_INVALID');
    expectSafeError(() => createAuditEvent(baseEventInput({
      eventKey: entityEventKey({ stage: 'RETRY', action: 'RETRY_SCHEDULED', outcome: 'RETRY_SCHEDULED' }),
      stage: 'RETRY', action: 'RETRY_SCHEDULED', outcome: 'RETRY_SCHEDULED', retryDelayMs: null,
    }), { now: fixedClock() }), 'AUDIT_INPUT_INVALID');
  });

  test.each(['FAILURE', 'TIMEOUT', 'INDETERMINATE'])('%s requires a fixed safe code', outcome => {
    expectSafeError(() => createAuditEvent(baseEventInput({
      eventKey: operationEventKey({ stage: 'FYND_LOCK', action: 'FYND_LOCK_FAILED', outcome }),
      operationKey: OPERATION_KEY,
      stage: 'FYND_LOCK',
      action: 'FYND_LOCK_FAILED',
      outcome,
      startedAt: new Date('2026-08-17T12:00:00.000Z'),
      completedAt: new Date('2026-08-17T12:00:00.025Z'),
      responseSummary: fyndResponse('LOCK', 25),
      safeCode: null,
    }), { now: fixedClock() }), 'AUDIT_INPUT_INVALID');
  });

  test('accepts only nonnegative/positive safe identifiers and fixed safe-code syntax', () => {
    for (const mutation of [
      { attemptNumber: -1 },
      { attemptNumber: 1.5 },
      { jobId: 0 },
      { jobId: Number.MAX_SAFE_INTEGER + 1 },
      { artifactJobId: -1 },
      { safeCode: 'lowercase' },
      { safeCode: `A${'B'.repeat(64)}` },
      { companyId: '' },
      { shipmentId: 'contains\ncontrol' },
      { documentNumber: 'é' },
      { applicationId: 'x'.repeat(257) },
    ]) {
      expectSafeError(
        () => createAuditEvent(baseEventInput(mutation), { now: fixedClock() }),
        'AUDIT_INPUT_INVALID',
      );
    }
  });

  test('rejects caller-supplied upstream occurrence/expiry timestamps before calling the clock', () => {
    for (const extra of [
      { occurredAt: new Date('2000-01-01T00:00:00.000Z') },
      { expiresAt: new Date('2099-01-01T00:00:00.000Z') },
      { webhookTimestamp: '2000-01-01T00:00:00.000Z' },
    ]) {
      const now = fixedClock();
      expectSafeError(() => createAuditEvent({ ...baseEventInput(), ...extra }, { now }), 'AUDIT_INPUT_INVALID');
      expect(now).toHaveBeenCalledTimes(0);
    }
  });

  test('rejects invalid timestamp combinations, Date subclasses, Date proxies, and Date extras', () => {
    class SubDate extends Date {}
    const proxyCounter = { calls: 0 };
    const dateProxy = new Proxy(new Date('2026-08-17T12:00:00.000Z'), {
      get() { proxyCounter.calls += 1; return 'secret'; },
      getPrototypeOf() { proxyCounter.calls += 1; return Date.prototype; },
      ownKeys() { proxyCounter.calls += 1; return []; },
      getOwnPropertyDescriptor() { proxyCounter.calls += 1; return undefined; },
    });
    const dateWithExtra = new Date('2026-08-17T12:00:00.000Z');
    dateWithExtra.extra = true;
    for (const mutation of [
      { startedAt: new Date('invalid'), completedAt: null, outcome: 'STARTED', action: 'VALIDATION_STARTED' },
      { startedAt: null, completedAt: new Date('2026-08-17T12:00:00.000Z') },
      { startedAt: new Date('2026-08-17T12:00:01.000Z'), completedAt: new Date('2026-08-17T12:00:00.000Z') },
      { startedAt: new Date('2026-08-17T12:00:00.000Z'), completedAt: null },
      { startedAt: new Date('2026-08-17T12:00:00.000Z'), completedAt: new Date('2026-08-17T12:00:01.000Z'), outcome: 'STARTED', action: 'VALIDATION_STARTED' },
      { startedAt: new SubDate('2026-08-17T12:00:00.000Z'), completedAt: null, outcome: 'STARTED', action: 'VALIDATION_STARTED' },
      { startedAt: dateProxy, completedAt: null, outcome: 'STARTED', action: 'VALIDATION_STARTED' },
      { startedAt: dateWithExtra, completedAt: null, outcome: 'STARTED', action: 'VALIDATION_STARTED' },
    ]) {
      const input = baseEventInput({
        ...mutation,
        eventKey: mutation.outcome === 'STARTED'
          ? entityEventKey({ stage: 'VALIDATION', action: 'VALIDATION_STARTED', outcome: 'STARTED' })
          : ENTITY_EVENT_KEY,
      });
      expectSafeError(() => createAuditEvent(input, { now: fixedClock() }), 'AUDIT_INPUT_INVALID');
    }
    expect(proxyCounter.calls).toBe(0);
  });

  test('rejects missing/accessor/proxy/throwing/invalid clocks with fixed safe errors', () => {
    expectSafeError(() => createAuditEvent(baseEventInput(), {}), 'AUDIT_CLOCK_INVALID');

    const accessorCounter = { calls: 0 };
    const accessorOptions = {};
    Object.defineProperty(accessorOptions, 'now', {
      enumerable: true,
      get() { accessorCounter.calls += 1; return fixedClock(); },
    });
    expectSafeError(() => createAuditEvent(baseEventInput(), accessorOptions), 'AUDIT_CLOCK_INVALID');
    expect(accessorCounter.calls).toBe(0);

    const proxyCounter = { calls: 0 };
    const proxyOptions = new Proxy({ now: fixedClock() }, {
      get() { proxyCounter.calls += 1; return 'secret'; },
      ownKeys() { proxyCounter.calls += 1; return []; },
      getOwnPropertyDescriptor() { proxyCounter.calls += 1; return undefined; },
      getPrototypeOf() { proxyCounter.calls += 1; return Object.prototype; },
    });
    expectSafeError(() => createAuditEvent(baseEventInput(), proxyOptions), 'AUDIT_CLOCK_INVALID');
    expect(proxyCounter.calls).toBe(0);

    const functionProxyCounter = { calls: 0 };
    const functionProxy = new Proxy(() => new Date(), {
      apply() { functionProxyCounter.calls += 1; return new Date(); },
    });
    expectSafeError(() => createAuditEvent(baseEventInput(), { now: functionProxy }), 'AUDIT_CLOCK_INVALID');
    expect(functionProxyCounter.calls).toBe(0);

    for (const now of [
      () => '2026-08-17T12:34:56.789Z',
      () => new Date('invalid'),
      () => new (class ClockDate extends Date {})('2026-08-17T12:34:56.789Z'),
      () => { throw new Error('clock secret'); },
    ]) {
      const error = expectSafeError(() => createAuditEvent(baseEventInput(), { now }), 'AUDIT_CLOCK_INVALID');
      expect(`${error.code} ${error.message}`).not.toContain('clock secret');
    }
  });

  test('rejects retention and retry Date overflow after exactly one clock call', () => {
    for (const mutation of [
      {},
      {
        eventKey: entityEventKey({ stage: 'RETRY', action: 'RETRY_SCHEDULED', outcome: 'RETRY_SCHEDULED' }),
        stage: 'RETRY', action: 'RETRY_SCHEDULED', outcome: 'RETRY_SCHEDULED', retryDelayMs: 10,
      },
    ]) {
      const now = jest.fn(() => new Date(8_640_000_000_000_000 - 5));
      expectSafeError(() => createAuditEvent(baseEventInput(mutation), { now }), 'AUDIT_CLOCK_INVALID');
      expect(now).toHaveBeenCalledTimes(1);
    }
  });

  test.each([
    ['requested', 'FYND_LOCK_REQUESTED', 'STARTED', 'requestSummary', () => fyndRequest('LOCK'), null],
    ['confirmed', 'FYND_LOCK_CONFIRMED', 'SUCCESS', 'responseSummary', () => fyndResponse('LOCK', 0), null],
    ['failed', 'FYND_LOCK_FAILED', 'FAILURE', 'responseSummary', () => fyndResponse('LOCK', 0), 'FYND_LOCK_FAILED'],
    ['readback', 'FYND_LOCK_READBACK', 'SUCCESS', 'responseSummary', () => fyndResponse('LOCK_READBACK', 0), null],
  ])('accepts an exactly bound Fynd lock %s operation event', (
    _description,
    action,
    outcome,
    summarySlot,
    makeSummary,
    safeCode,
  ) => {
    const eventKey = operationEventKey({ stage: 'FYND_LOCK', action, outcome });
    const event = createAuditEvent(baseEventInput({
      eventKey,
      operationKey: OPERATION_KEY,
      stage: 'FYND_LOCK',
      action,
      outcome,
      safeCode,
      [summarySlot]: makeSummary(),
    }), { now: fixedClock() });
    expect(event.eventKey).toBe(eventKey);
    expect(event.operationKey).toBe(OPERATION_KEY);
  });

  test.each(EXTERNAL_ACTION_OUTCOME_CASES)(
    'rejects %s/%s with a null jobId before calling the clock',
    (action, outcome) => {
      const now = fixedClock();
      expectSafeError(
        () => createAuditEvent(externalAuditEventInput(action, outcome, null), { now }),
        'AUDIT_INPUT_INVALID',
      );
      expect(now).toHaveBeenCalledTimes(0);
    },
  );

  test.each(EXTERNAL_ACTION_OUTCOME_CASES)(
    'accepts %s/%s with a positive safe jobId',
    (action, outcome) => {
      const now = fixedClock();
      const event = createAuditEvent(externalAuditEventInput(action, outcome, 42), { now });
      expect(event.jobId).toBe(42);
      expect(now).toHaveBeenCalledTimes(1);
    },
  );

  test('rejects null, entity, unrelated, and tuple-mismatched external operation identities before clock use', () => {
    const unrelatedOperationKey = createOperationKey({ ...baseOperationInput(), targetId: '43' });
    const requestSummary = fyndRequest('LOCK');
    const cases = [
      baseEventInput({
        eventKey: OPERATION_EVENT_KEY,
        operationKey: null,
        stage: 'FYND_LOCK',
        action: 'FYND_LOCK_REQUESTED',
        outcome: 'STARTED',
        requestSummary,
      }),
      baseEventInput({
        eventKey: entityEventKey({
          stage: 'FYND_LOCK', action: 'FYND_LOCK_REQUESTED', outcome: 'STARTED',
        }),
        operationKey: OPERATION_KEY,
        stage: 'FYND_LOCK',
        action: 'FYND_LOCK_REQUESTED',
        outcome: 'STARTED',
        requestSummary,
      }),
      baseEventInput({
        eventKey: operationEventKey({
          operationKey: unrelatedOperationKey,
          stage: 'FYND_LOCK',
          action: 'FYND_LOCK_REQUESTED',
          outcome: 'STARTED',
        }),
        operationKey: OPERATION_KEY,
        stage: 'FYND_LOCK',
        action: 'FYND_LOCK_REQUESTED',
        outcome: 'STARTED',
        requestSummary,
      }),
      baseEventInput({
        eventKey: OPERATION_EVENT_KEY,
        operationKey: OPERATION_KEY,
        stage: 'FYND_LOCK',
        action: 'FYND_LOCK_CONFIRMED',
        outcome: 'SUCCESS',
        responseSummary: fyndResponse('LOCK', 0),
      }),
    ];

    for (const input of cases) {
      const now = fixedClock();
      expectSafeError(() => createAuditEvent(input, { now }), 'AUDIT_INPUT_INVALID');
      expect(now).toHaveBeenCalledTimes(0);
    }
  });

  test('rejects a valid operation key on every nonexternal action before clock use', () => {
    for (const [action, rule] of Object.entries(ACTION_MATRIX)) {
      if (EXTERNAL_OPERATION_ACTIONS.includes(action)) continue;
      const now = fixedClock();
      const input = baseEventInput({
        eventKey: entityEventKey({ stage: rule.stage, action, outcome: rule.outcomes[0] }),
        operationKey: OPERATION_KEY,
        stage: rule.stage,
        action,
        outcome: rule.outcomes[0],
        safeCode: ['FAILURE', 'TIMEOUT', 'INDETERMINATE'].includes(rule.outcomes[0]) ? 'NONEXTERNAL_FAILED' : null,
        queueDelayMs: action === 'JOB_CLAIMED' || action === 'OUTBOX_CLAIMED' ? 0 : null,
        retryDelayMs: action === 'RETRY_SCHEDULED' ? 0 : null,
        responseSummary: action === 'OEIS_ARTIFACT_STORED'
          ? sanitizeOeisSummary('ARTIFACT', oeisArtifactInput())
          : null,
      });
      expectSafeError(() => createAuditEvent(input, { now }), 'AUDIT_INPUT_INVALID');
      expect(now).toHaveBeenCalledTimes(0);
    }
  });

  test('requires sanitizer branding and deep-copies a matching summary into the event', () => {
    const summary = fyndRequest('LOCK');
    const event = createAuditEvent(baseEventInput({
      eventKey: OPERATION_EVENT_KEY,
      operationKey: OPERATION_KEY,
      stage: 'FYND_LOCK',
      action: 'FYND_LOCK_REQUESTED',
      outcome: 'STARTED',
      requestSummary: summary,
    }), { now: fixedClock() });
    expect(event.requestSummary).toEqual(summary);
    expect(event.requestSummary).not.toBe(summary);
    expectDeepFrozen(event.requestSummary);

    const lookalike = { ...summary };
    expectSafeError(() => createAuditEvent(baseEventInput({
      eventKey: OPERATION_EVENT_KEY,
      operationKey: OPERATION_KEY,
      stage: 'FYND_LOCK',
      action: 'FYND_LOCK_REQUESTED',
      outcome: 'STARTED',
      requestSummary: lookalike,
    }), { now: fixedClock() }), 'AUDIT_INPUT_INVALID');

    const counter = { calls: 0 };
    const accessorLookalike = {};
    Object.defineProperty(accessorLookalike, 'kind', {
      enumerable: true,
      get() { counter.calls += 1; return 'FYND_REQUEST'; },
    });
    const now = fixedClock();
    expectSafeError(() => createAuditEvent(baseEventInput({
      eventKey: OPERATION_EVENT_KEY,
      operationKey: OPERATION_KEY,
      stage: 'FYND_LOCK',
      action: 'FYND_LOCK_REQUESTED',
      outcome: 'STARTED',
      requestSummary: accessorLookalike,
    }), { now }), 'AUDIT_INPUT_INVALID');
    expect(counter.calls).toBe(0);
    expect(now).toHaveBeenCalledTimes(0);
  });

  test.each([
    ['Fynd lock request', 'FYND_LOCK', 'FYND_LOCK_REQUESTED', 'STARTED', 'requestSummary', () => fyndRequest('LOCK')],
    ['Fynd lock readback request', 'FYND_LOCK', 'FYND_LOCK_READBACK', 'STARTED', 'requestSummary', () => fyndRequest('LOCK_READBACK')],
    ['Fynd transition request', 'FYND_TRANSITION', 'FYND_TRANSITION_REQUESTED', 'STARTED', 'requestSummary', () => fyndRequest('TRANSITION')],
    ['Fynd transition readback request', 'FYND_TRANSITION', 'FYND_TRANSITION_READBACK', 'STARTED', 'requestSummary', () => fyndRequest('TRANSITION_READBACK')],
    ['OEIS request', 'OEIS_SUBMISSION', 'OEIS_SUBMISSION_REQUESTED', 'STARTED', 'requestSummary', () => sanitizeOeisSummary('REQUEST', oeisRequestInput())],
    ['Fynd lock response', 'FYND_LOCK', 'FYND_LOCK_CONFIRMED', 'SUCCESS', 'responseSummary', () => fyndResponse('LOCK', 25)],
    ['Fynd lock readback response', 'FYND_LOCK', 'FYND_LOCK_READBACK', 'SUCCESS', 'responseSummary', () => fyndResponse('LOCK_READBACK', 25)],
    ['Fynd transition response', 'FYND_TRANSITION', 'FYND_TRANSITION_CONFIRMED', 'SUCCESS', 'responseSummary', () => fyndResponse('TRANSITION', 25)],
    ['Fynd transition readback response', 'FYND_TRANSITION', 'FYND_TRANSITION_READBACK', 'SUCCESS', 'responseSummary', () => fyndResponse('TRANSITION_READBACK', 25)],
    ['OEIS response', 'OEIS_SUBMISSION', 'OEIS_RESPONSE_RECEIVED', 'SUCCESS', 'responseSummary', () => sanitizeOeisSummary('RESPONSE', oeisResponseInput())],
    ['OEIS artifact', 'OEIS_ARTIFACT', 'OEIS_ARTIFACT_STORED', 'SUCCESS', 'responseSummary', () => sanitizeOeisSummary('ARTIFACT', oeisArtifactInput())],
  ])('accepts exact branded summary placement for %s', (_description, stage, action, outcome, slot, makeSummary) => {
    const isStarted = outcome === 'STARTED';
    const isExternalOperation = EXTERNAL_OPERATION_ACTIONS.includes(action);
    const event = createAuditEvent(baseEventInput({
      eventKey: isExternalOperation
        ? operationEventKey({ stage, action, outcome })
        : entityEventKey({ stage, action, outcome }),
      operationKey: isExternalOperation ? OPERATION_KEY : null,
      stage,
      action,
      outcome,
      startedAt: isStarted ? null : new Date('2026-08-17T12:00:00.000Z'),
      completedAt: isStarted ? null : new Date('2026-08-17T12:00:00.025Z'),
      [slot]: makeSummary(),
    }), { now: fixedClock() });
    expect(event[slot]).not.toBeNull();
  });

  test('rejects missing, wrong-slot, wrong-family, and wrong-operation branded summaries before clock use', () => {
    const cases = [
      baseEventInput({
        eventKey: OPERATION_EVENT_KEY, operationKey: OPERATION_KEY, stage: 'FYND_LOCK',
        action: 'FYND_LOCK_REQUESTED', outcome: 'STARTED', requestSummary: null,
      }),
      baseEventInput({
        eventKey: OPERATION_EVENT_KEY, operationKey: OPERATION_KEY, stage: 'FYND_LOCK',
        action: 'FYND_LOCK_REQUESTED', outcome: 'STARTED', responseSummary: fyndRequest('LOCK'),
      }),
      baseEventInput({
        eventKey: OPERATION_EVENT_KEY, operationKey: OPERATION_KEY, stage: 'FYND_LOCK',
        action: 'FYND_LOCK_REQUESTED', outcome: 'STARTED', requestSummary: sanitizeOeisSummary('REQUEST', oeisRequestInput()),
      }),
      baseEventInput({
        eventKey: OPERATION_EVENT_KEY, operationKey: OPERATION_KEY, stage: 'FYND_LOCK',
        action: 'FYND_LOCK_REQUESTED', outcome: 'STARTED', requestSummary: fyndRequest('LOCK_READBACK'),
      }),
      baseEventInput({ requestSummary: fyndRequest('LOCK') }),
      baseEventInput({ responseSummary: fyndResponse('LOCK', 0) }),
    ];
    for (const input of cases) {
      const now = fixedClock();
      expectSafeError(() => createAuditEvent(input, { now }), 'AUDIT_INPUT_INVALID');
      expect(now).toHaveBeenCalledTimes(0);
    }
  });

  test('requires response-summary latency to equal the derived duration', () => {
    expectSafeError(() => createAuditEvent(baseEventInput({
      eventKey: operationEventKey({ stage: 'OEIS_SUBMISSION', action: 'OEIS_RESPONSE_RECEIVED', outcome: 'SUCCESS' }),
      operationKey: OPERATION_KEY,
      stage: 'OEIS_SUBMISSION',
      action: 'OEIS_RESPONSE_RECEIVED',
      outcome: 'SUCCESS',
      startedAt: new Date('2026-08-17T12:00:00.000Z'),
      completedAt: new Date('2026-08-17T12:00:00.025Z'),
      responseSummary: sanitizeOeisSummary('RESPONSE', oeisResponseInput({ latencyMs: 24 })),
    }), { now: fixedClock() }), 'AUDIT_INPUT_INVALID');
  });

  test('rejects event accessors and proxies without executing attacker code or the clock', () => {
    const accessorCounter = { calls: 0 };
    const accessor = baseEventInput();
    delete accessor.safeCode;
    Object.defineProperty(accessor, 'safeCode', {
      enumerable: true,
      get() { accessorCounter.calls += 1; return null; },
    });
    const accessorNow = fixedClock();
    expectSafeError(() => createAuditEvent(accessor, { now: accessorNow }), 'AUDIT_INPUT_INVALID');
    expect(accessorCounter.calls).toBe(0);
    expect(accessorNow).toHaveBeenCalledTimes(0);

    const proxyCounter = { calls: 0 };
    const proxy = new Proxy(baseEventInput(), {
      get() { proxyCounter.calls += 1; return 'secret'; },
      ownKeys() { proxyCounter.calls += 1; return []; },
      getOwnPropertyDescriptor() { proxyCounter.calls += 1; return undefined; },
      getPrototypeOf() { proxyCounter.calls += 1; return Object.prototype; },
    });
    const proxyNow = fixedClock();
    expectSafeError(() => createAuditEvent(proxy, { now: proxyNow }), 'AUDIT_INPUT_INVALID');
    expect(proxyCounter.calls).toBe(0);
    expect(proxyNow).toHaveBeenCalledTimes(0);
  });

  test('keeps a maximized constructible valid one-summary event below the defensive 12 KiB cap', () => {
    const maximumDurationMs = 8_640_000_000_000_000;
    const responseSummary = sanitizeOeisSummary('RESPONSE', oeisResponseAtJsonBytes(4_096, {
      latencyMs: maximumDurationMs,
    }));
    const event = createAuditEvent(baseEventInput({
      eventKey: operationEventKey({ stage: 'OEIS_SUBMISSION', action: 'OEIS_SUBMISSION_FAILED', outcome: 'FAILURE' }),
      operationKey: OPERATION_KEY,
      companyId: '\\'.repeat(512),
      applicationId: '\\'.repeat(256),
      shipmentId: '\\'.repeat(512),
      jobId: Number.MAX_SAFE_INTEGER,
      documentNumber: '\\'.repeat(512),
      stage: 'OEIS_SUBMISSION',
      action: 'OEIS_SUBMISSION_FAILED',
      outcome: 'FAILURE',
      attemptNumber: Number.MAX_SAFE_INTEGER,
      startedAt: new Date(0),
      completedAt: new Date(maximumDurationMs),
      safeCode: `A${'B'.repeat(63)}`,
      responseSummary,
      artifactJobId: Number.MAX_SAFE_INTEGER,
    }), { now: fixedClock() });
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
    expect(size).toBeLessThanOrEqual(AUDIT_EVENT_MAX_BYTES);
    expect(JSON.stringify(event)).toContain('\\\\');
    expectSafeError(() => createAuditEvent(baseEventInput({ companyId: '\\'.repeat(513) }), {
      now: fixedClock(),
    }), 'AUDIT_INPUT_INVALID');
  });
});

describe('audit bundles', () => {
  test('validates all inputs first, calls one clock once, preserves order, and returns fresh deep-frozen events', () => {
    const first = baseEventInput();
    const second = baseEventInput({
      eventKey: entityEventKey({ stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS' }),
      stage: 'JOB',
      action: 'JOB_COMPLETED',
      outcome: 'SUCCESS',
    });
    const now = fixedClock();
    const bundle = createAuditBundle([first, second], { now });
    expect(now).toHaveBeenCalledTimes(1);
    expect(bundle.map(event => event.action)).toEqual(['VALIDATION_PASSED', 'JOB_COMPLETED']);
    expect(bundle[0].occurredAt).toBe('2026-08-17T12:34:56.789Z');
    expect(bundle[1].occurredAt).toBe('2026-08-17T12:34:56.789Z');
    expect(new Date(bundle[0].occurredAt).toISOString()).toBe(bundle[0].occurredAt);
    expect(bundle[0]).not.toBe(first);
    expect(bundle[1]).not.toBe(second);
    expectDeepFrozen(bundle);
  });

  test('rejects duplicate event keys atomically before calling the clock', () => {
    const now = fixedClock();
    expectSafeError(
      () => createAuditBundle([baseEventInput(), baseEventInput()], { now }),
      'AUDIT_INPUT_INVALID',
    );
    expect(now).toHaveBeenCalledTimes(0);
  });

  test('rejects sparse, extra-key, symbol-key, and proxied bundles before clock use', () => {
    const sparse = new Array(1);
    const extra = [baseEventInput()];
    extra.extra = true;
    const symbol = [baseEventInput()];
    symbol[Symbol('secret')] = 'never';
    for (const input of [sparse, extra, symbol, {}, null]) {
      const now = fixedClock();
      expectSafeError(() => createAuditBundle(input, { now }), 'AUDIT_INPUT_INVALID');
      expect(now).toHaveBeenCalledTimes(0);
    }

    const counter = { calls: 0 };
    const proxy = new Proxy([baseEventInput()], {
      get() { counter.calls += 1; return 'secret'; },
      ownKeys() { counter.calls += 1; return []; },
      getOwnPropertyDescriptor() { counter.calls += 1; return undefined; },
      getPrototypeOf() { counter.calls += 1; return Array.prototype; },
    });
    const now = fixedClock();
    expectSafeError(() => createAuditBundle(proxy, { now }), 'AUDIT_INPUT_INVALID');
    expect(counter.calls).toBe(0);
    expect(now).toHaveBeenCalledTimes(0);
  });

  test('returns a fresh frozen empty bundle after one trusted clock call', () => {
    const now = fixedClock();
    const bundle = createAuditBundle([], { now });
    expect(bundle).toEqual([]);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(now).toHaveBeenCalledTimes(1);
  });

  test('does not call the clock when a later event contains an accessor', () => {
    const hostile = baseEventInput({
      eventKey: entityEventKey({ stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS' }),
      stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS',
    });
    const counter = { calls: 0 };
    delete hostile.safeCode;
    Object.defineProperty(hostile, 'safeCode', {
      enumerable: true,
      get() { counter.calls += 1; return null; },
    });
    const now = fixedClock();
    expectSafeError(() => createAuditBundle([baseEventInput(), hostile], { now }), 'AUDIT_INPUT_INVALID');
    expect(counter.calls).toBe(0);
    expect(now).toHaveBeenCalledTimes(0);
  });
});
