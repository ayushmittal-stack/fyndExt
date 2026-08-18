'use strict';

const { createHash } = require('node:crypto');
const { types } = require('node:util');
const { EinvoiceError } = require('../errors');

const AUDIT_RETENTION_MS = 7_776_000_000;
const AUDIT_SUMMARY_MAX_BYTES = 4_096;
const AUDIT_EVENT_MAX_BYTES = 12_288;

const ERROR_DEFINITIONS = Object.freeze({
  AUDIT_INPUT_INVALID: 'Shipment audit input is invalid',
  AUDIT_CLOCK_INVALID: 'Shipment audit clock is invalid',
  AUDIT_SUMMARY_INVALID: 'Shipment audit summary is invalid',
  AUDIT_SUMMARY_TOO_LARGE: 'Shipment audit summary exceeds the size limit',
  AUDIT_EVENT_TOO_LARGE: 'Shipment audit event exceeds the size limit',
});

function auditError(code) {
  return new EinvoiceError(code, ERROR_DEFINITIONS[code]);
}

const ACTION_RULES = Object.freeze({
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

const AUDIT_STAGES = Object.freeze([
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

const AUDIT_ACTIONS = Object.freeze(Object.keys(ACTION_RULES));
const AUDIT_OUTCOMES = Object.freeze([
  'STARTED',
  'SUCCESS',
  'FAILURE',
  'TIMEOUT',
  'RETRY_SCHEDULED',
  'HELD',
  'INDETERMINATE',
]);
const AUDIT_ACTION_OUTCOMES = Object.freeze(Object.fromEntries(
  Object.entries(ACTION_RULES).map(([action, rule]) => [action, rule.outcomes]),
));

const KEY_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_STATE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REASON_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,63}$/;
const VALIDATION_CODE_PATTERN = /^[A-Z][A-Z0-9_-]{0,63}$/;
const FIXED_DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]{0,17})\.[0-9]{2}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/;
const MAX_SAFE_BIGINT = 9_007_199_254_740_991n;
const DATE_MAX_MS = 8_640_000_000_000_000;

const OPERATION_INPUT_KEYS = Object.freeze([
  'targetKind',
  'targetId',
  'expectedParentVersion',
  'attemptNumber',
  'stage',
  'action',
]);
const OPERATION_EVENT_KEY_INPUT_KEYS = Object.freeze([
  'kind', 'operationKey', 'stage', 'action', 'outcome',
]);
const WEBHOOK_EVENT_KEY_INPUT_KEYS = Object.freeze(['kind', 'companyId', 'eventId']);
const ENTITY_EVENT_KEY_INPUT_KEYS = Object.freeze([
  'kind',
  'companyId',
  'shipmentId',
  'scopeKind',
  'scopeId',
  'parentVersion',
  'attemptNumber',
  'stage',
  'action',
  'outcome',
]);
const EVENT_INPUT_KEYS = Object.freeze([
  'eventKey',
  'operationKey',
  'companyId',
  'applicationId',
  'shipmentId',
  'jobId',
  'documentNumber',
  'stage',
  'action',
  'outcome',
  'attemptNumber',
  'startedAt',
  'completedAt',
  'queueDelayMs',
  'retryDelayMs',
  'safeCode',
  'requestSummary',
  'responseSummary',
  'artifactJobId',
]);

const FYND_REQUEST_KEYS = Object.freeze([
  'operation', 'shipmentId', 'documentNumber', 'requestedLock', 'requestedStatus',
]);
const FYND_RESPONSE_KEYS = Object.freeze([
  'operation',
  'shipmentId',
  'documentNumber',
  'responseStatus',
  'locked',
  'shipmentState',
  'finalStateClassification',
  'retryable',
  'latencyMs',
]);
const OEIS_REQUEST_KEYS = Object.freeze([
  'documentNumber',
  'documentType',
  'lineCount',
  'currency',
  'netAmount',
  'taxAmount',
  'totalAmount',
  'taxSummaries',
  'requestByteCount',
  'requestSha256',
  'endpointPath',
  'attemptNumber',
  'timeoutMs',
]);
const OEIS_TAX_KEYS = Object.freeze(['category', 'rate', 'reasonCode', 'lineCount']);
const OEIS_RESPONSE_KEYS = Object.freeze([
  'httpStatus',
  'isSystemException',
  'validationResult',
  'reportingStatus',
  'clearanceStatus',
  'invoiceNumber',
  'transactionNumber',
  'uuid',
  'invoiceCounter',
  'matchingKey',
  'validationCodes',
  'responseByteCount',
  'responseSha256',
  'retryable',
  'latencyMs',
]);
const OEIS_ARTIFACT_KEYS = Object.freeze([
  'signedXmlPresent',
  'signedXmlByteCount',
  'signedXmlSha256',
  'qrPresent',
  'qrByteCount',
  'qrSha256',
]);

const EXTERNAL_OPERATION_PAIRS = new Set([
  'FYND_LOCK\u0000FYND_LOCK_REQUESTED',
  'FYND_LOCK\u0000FYND_LOCK_READBACK',
  'OEIS_SUBMISSION\u0000OEIS_SUBMISSION_REQUESTED',
  'FYND_TRANSITION\u0000FYND_TRANSITION_REQUESTED',
  'FYND_TRANSITION\u0000FYND_TRANSITION_READBACK',
]);
const EXTERNAL_EVENT_ACTIONS = new Set([
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

const FYND_OPERATIONS = new Set(['LOCK', 'LOCK_READBACK', 'TRANSITION', 'TRANSITION_READBACK']);
const FYND_CLASSIFICATIONS = new Set([
  'LOCKED', 'UNLOCKED', 'INVOICED', 'UNCHANGED', 'CONFLICTING', 'UNREADABLE', 'REJECTED', 'UNKNOWN',
]);
const VALIDATION_RESULTS = new Set(['VALID', 'INVALID', 'UNKNOWN']);
const REPORTING_STATUSES = new Set(['PENDING', 'REPORTED', 'REJECTED', 'WARNINGS', 'UNKNOWN']);
const CLEARANCE_STATUSES = new Set(['PENDING', 'CLEARED', 'NOT_CLEARED', 'WARNINGS', 'UNKNOWN']);
const SCOPE_KINDS = new Set(['WEBHOOK', 'JOB', 'OUTBOX', 'MIGRATION']);
const TARGET_KINDS = new Set(['JOB', 'OUTBOX']);
const TAX_CATEGORIES = new Set(['S', 'Z', 'E']);
const summaryBrands = new WeakMap();

function isObjectLike(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function isProxy(value) {
  return isObjectLike(value) && types.isProxy(value);
}

function inspectPlainObject(value, makeError) {
  if (value === null || typeof value !== 'object' || isProxy(value)) throw makeError();
  if (Object.getPrototypeOf(value) !== Object.prototype) throw makeError();

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key !== 'string')) throw makeError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of ownKeys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.enumerable !== true) {
      throw makeError();
    }
  }
  return { ownKeys, descriptors };
}

function exactObjectValues(value, expectedKeys, makeError) {
  const inspected = inspectPlainObject(value, makeError);
  if (inspected.ownKeys.length !== expectedKeys.length) throw makeError();
  const expected = new Set(expectedKeys);
  for (const key of inspected.ownKeys) {
    if (!expected.has(key)) throw makeError();
  }
  const result = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = inspected.descriptors[key];
    if (!descriptor) throw makeError();
    result[key] = descriptor.value;
  }
  return result;
}

function denseArrayValues(value, makeError, maximumLength = Number.MAX_SAFE_INTEGER) {
  if (value === null || typeof value !== 'object' || isProxy(value) || !Array.isArray(value)) throw makeError();
  if (Object.getPrototypeOf(value) !== Array.prototype) throw makeError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')) throw makeError();
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumLength) throw makeError();

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || ownKeys.some(key => typeof key !== 'string')) throw makeError();
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.enumerable !== true) {
      throw makeError();
    }
    result.push(descriptor.value);
  }
  for (const key of ownKeys) {
    if (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)) throw makeError();
    if (key !== 'length' && Number(key) >= length) throw makeError();
  }
  return result;
}

function isNonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateCanonicalIdString(value, makeError) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw makeError();
  if (BigInt(value) > MAX_SAFE_BIGINT) throw makeError();
  return value;
}

function validatePrintableAscii(value, maximumBytes, makeError) {
  if (typeof value !== 'string' || !PRINTABLE_ASCII_PATTERN.test(value) || !/[!-~]/.test(value)) {
    throw makeError();
  }
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) throw makeError();
  return value;
}

function validateNullablePrintableAscii(value, maximumBytes, makeError) {
  return value === null ? null : validatePrintableAscii(value, maximumBytes, makeError);
}

function validateActionTuple(stage, action, outcome, makeError) {
  const rule = typeof action === 'string' ? ACTION_RULES[action] : undefined;
  if (!rule || stage !== rule.stage || !rule.outcomes.includes(outcome)) throw makeError();
}

function digestCanonical(value) {
  return `v1.${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('base64url')}`;
}

function createOperationKey(input) {
  const makeError = () => auditError('AUDIT_INPUT_INVALID');
  const values = exactObjectValues(input, OPERATION_INPUT_KEYS, makeError);
  if (!TARGET_KINDS.has(values.targetKind)) throw makeError();
  validateCanonicalIdString(values.targetId, makeError);
  if (!isNonnegativeSafeInteger(values.expectedParentVersion)) throw makeError();
  if (!isPositiveSafeInteger(values.attemptNumber)) throw makeError();
  if (!EXTERNAL_OPERATION_PAIRS.has(`${values.stage}\u0000${values.action}`)) throw makeError();

  return digestCanonical({
    v: 1,
    targetKind: values.targetKind,
    targetId: values.targetId,
    expectedParentVersion: values.expectedParentVersion,
    attemptNumber: values.attemptNumber,
    stage: values.stage,
    action: values.action,
  });
}

function createEventKey(input) {
  const makeError = () => auditError('AUDIT_INPUT_INVALID');
  const inspected = inspectPlainObject(input, makeError);
  const kindDescriptor = inspected.descriptors.kind;
  if (!kindDescriptor) throw makeError();
  const kind = kindDescriptor.value;

  if (kind === 'OPERATION') {
    const values = exactObjectValues(input, OPERATION_EVENT_KEY_INPUT_KEYS, makeError);
    if (typeof values.operationKey !== 'string' || !KEY_PATTERN.test(values.operationKey)) throw makeError();
    validateActionTuple(values.stage, values.action, values.outcome, makeError);
    if (!EXTERNAL_EVENT_ACTIONS.has(values.action)) throw makeError();
    return digestCanonical({
      v: 1,
      kind: 'OPERATION',
      operationKey: values.operationKey,
      stage: values.stage,
      action: values.action,
      outcome: values.outcome,
    });
  }

  if (kind === 'WEBHOOK_RECEIPT') {
    const values = exactObjectValues(input, WEBHOOK_EVENT_KEY_INPUT_KEYS, makeError);
    validatePrintableAscii(values.companyId, 512, makeError);
    validatePrintableAscii(values.eventId, 512, makeError);
    return digestCanonical({
      v: 1,
      kind: 'WEBHOOK_RECEIPT',
      companyId: values.companyId,
      eventId: values.eventId,
      action: 'WEBHOOK_RECEIVED',
    });
  }

  if (kind === 'ENTITY') {
    const values = exactObjectValues(input, ENTITY_EVENT_KEY_INPUT_KEYS, makeError);
    validatePrintableAscii(values.companyId, 512, makeError);
    validatePrintableAscii(values.shipmentId, 512, makeError);
    if (!SCOPE_KINDS.has(values.scopeKind)) throw makeError();
    if (values.scopeKind === 'JOB' || values.scopeKind === 'OUTBOX') {
      validateCanonicalIdString(values.scopeId, makeError);
    } else {
      validatePrintableAscii(values.scopeId, 512, makeError);
    }
    if (!isNonnegativeSafeInteger(values.parentVersion)) throw makeError();
    if (!isNonnegativeSafeInteger(values.attemptNumber)) throw makeError();
    validateActionTuple(values.stage, values.action, values.outcome, makeError);
    return digestCanonical({
      v: 1,
      kind: 'ENTITY',
      companyId: values.companyId,
      shipmentId: values.shipmentId,
      scopeKind: values.scopeKind,
      scopeId: values.scopeId,
      parentVersion: values.parentVersion,
      attemptNumber: values.attemptNumber,
      stage: values.stage,
      action: values.action,
      outcome: values.outcome,
    });
  }

  throw makeError();
}

function deepFreeze(value, seen = new Set()) {
  if (!isObjectLike(value) || seen.has(value)) return value;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function cloneInternalValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) === Date.prototype) {
    return new Date(Date.prototype.getTime.call(value));
  }
  if (Array.isArray(value)) return value.map(cloneInternalValue);
  const clone = {};
  for (const key of Object.keys(value)) clone[key] = cloneInternalValue(value[key]);
  return clone;
}

function finishSummary(output, brand) {
  if (Buffer.byteLength(JSON.stringify(output), 'utf8') > AUDIT_SUMMARY_MAX_BYTES) {
    throw auditError('AUDIT_SUMMARY_TOO_LARGE');
  }
  deepFreeze(output);
  summaryBrands.set(output, Object.freeze({ ...brand }));
  return output;
}

function validateFyndOperation(value, makeError) {
  if (!FYND_OPERATIONS.has(value)) throw makeError();
  return value;
}

function sanitizeFyndSummary(kind, input) {
  const makeError = () => auditError('AUDIT_SUMMARY_INVALID');
  if (kind === 'REQUEST') {
    const values = exactObjectValues(input, FYND_REQUEST_KEYS, makeError);
    validateFyndOperation(values.operation, makeError);
    validatePrintableAscii(values.shipmentId, 512, makeError);
    validatePrintableAscii(values.documentNumber, 512, makeError);

    const expectedLock = values.operation === 'LOCK' ? true : null;
    const expectedStatus = values.operation === 'TRANSITION' ? 'bag_invoiced' : null;
    if (values.requestedLock !== expectedLock || values.requestedStatus !== expectedStatus) throw makeError();

    return finishSummary({
      kind: 'FYND_REQUEST',
      operation: values.operation,
      shipmentId: values.shipmentId,
      documentNumber: values.documentNumber,
      requestedLock: values.requestedLock,
      requestedStatus: values.requestedStatus,
    }, { family: 'FYND', kind: 'REQUEST', operation: values.operation, hasLatency: false });
  }

  if (kind === 'RESPONSE') {
    const values = exactObjectValues(input, FYND_RESPONSE_KEYS, makeError);
    validateFyndOperation(values.operation, makeError);
    validatePrintableAscii(values.shipmentId, 512, makeError);
    validatePrintableAscii(values.documentNumber, 512, makeError);
    if (values.responseStatus !== null
      && (!Number.isInteger(values.responseStatus) || values.responseStatus < 100 || values.responseStatus > 599)) {
      throw makeError();
    }
    if (values.locked !== null && typeof values.locked !== 'boolean') throw makeError();
    if (values.shipmentState !== null
      && (typeof values.shipmentState !== 'string' || !SAFE_STATE_PATTERN.test(values.shipmentState))) {
      throw makeError();
    }
    if (!FYND_CLASSIFICATIONS.has(values.finalStateClassification)) throw makeError();
    if (typeof values.retryable !== 'boolean' || !isNonnegativeSafeInteger(values.latencyMs)) throw makeError();

    return finishSummary({
      kind: 'FYND_RESPONSE',
      operation: values.operation,
      shipmentId: values.shipmentId,
      documentNumber: values.documentNumber,
      responseStatus: values.responseStatus,
      locked: values.locked,
      shipmentState: values.shipmentState,
      finalStateClassification: values.finalStateClassification,
      retryable: values.retryable,
      latencyMs: values.latencyMs,
    }, { family: 'FYND', kind: 'RESPONSE', operation: values.operation, hasLatency: true });
  }

  throw makeError();
}

function validateFixedDecimal(value, makeError) {
  if (typeof value !== 'string' || !FIXED_DECIMAL_PATTERN.test(value) || value === '-0.00') throw makeError();
  return value;
}

function sanitizeTaxSummaries(value, makeError) {
  const entries = denseArrayValues(value, makeError, 16);
  return entries.map(entry => {
    const values = exactObjectValues(entry, OEIS_TAX_KEYS, makeError);
    if (!TAX_CATEGORIES.has(values.category)) throw makeError();
    validateFixedDecimal(values.rate, makeError);
    if (values.reasonCode !== null
      && (typeof values.reasonCode !== 'string' || !REASON_CODE_PATTERN.test(values.reasonCode))) {
      throw makeError();
    }
    if (!isPositiveSafeInteger(values.lineCount) || values.lineCount > 1_000) throw makeError();
    return {
      category: values.category,
      rate: values.rate,
      reasonCode: values.reasonCode,
      lineCount: values.lineCount,
    };
  });
}

function sanitizeValidationCodes(value, makeError) {
  const entries = denseArrayValues(value, makeError, 20);
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry !== 'string' || !VALIDATION_CODE_PATTERN.test(entry) || seen.has(entry)) throw makeError();
    seen.add(entry);
  }
  return [...entries];
}

function validateNullableEnum(value, allowed, makeError) {
  if (value !== null && !allowed.has(value)) throw makeError();
  return value;
}

function validateNullableHashPair(byteCount, hash, makeError) {
  if (byteCount === null || hash === null) {
    if (byteCount !== null || hash !== null) throw makeError();
    return;
  }
  if (!isNonnegativeSafeInteger(byteCount) || typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
    throw makeError();
  }
}

function sanitizeOeisSummary(kind, input) {
  const makeError = () => auditError('AUDIT_SUMMARY_INVALID');
  if (kind === 'REQUEST') {
    const values = exactObjectValues(input, OEIS_REQUEST_KEYS, makeError);
    validatePrintableAscii(values.documentNumber, 512, makeError);
    if (values.documentType !== 'IN' && values.documentType !== 'CN') throw makeError();
    if (!isPositiveSafeInteger(values.lineCount) || values.lineCount > 1_000) throw makeError();
    if (values.currency !== 'SAR') throw makeError();
    validateFixedDecimal(values.netAmount, makeError);
    validateFixedDecimal(values.taxAmount, makeError);
    validateFixedDecimal(values.totalAmount, makeError);
    const taxSummaries = sanitizeTaxSummaries(values.taxSummaries, makeError);
    if (!isPositiveSafeInteger(values.requestByteCount)) throw makeError();
    if (typeof values.requestSha256 !== 'string' || !HASH_PATTERN.test(values.requestSha256)) throw makeError();
    if (values.endpointPath !== '/API/V2/Transaction/UpdateInvoiceData') throw makeError();
    if (!isPositiveSafeInteger(values.attemptNumber) || !isPositiveSafeInteger(values.timeoutMs)) throw makeError();

    return finishSummary({
      kind: 'OEIS_REQUEST',
      documentNumber: values.documentNumber,
      documentType: values.documentType,
      lineCount: values.lineCount,
      currency: values.currency,
      netAmount: values.netAmount,
      taxAmount: values.taxAmount,
      totalAmount: values.totalAmount,
      taxSummaries,
      requestByteCount: values.requestByteCount,
      requestSha256: values.requestSha256,
      endpointPath: values.endpointPath,
      attemptNumber: values.attemptNumber,
      timeoutMs: values.timeoutMs,
    }, { family: 'OEIS', kind: 'REQUEST', hasLatency: false });
  }

  if (kind === 'RESPONSE') {
    const values = exactObjectValues(input, OEIS_RESPONSE_KEYS, makeError);
    if (values.httpStatus !== null
      && (!Number.isInteger(values.httpStatus) || values.httpStatus < 100 || values.httpStatus > 599)) {
      throw makeError();
    }
    if (values.isSystemException !== null && typeof values.isSystemException !== 'boolean') throw makeError();
    if (!VALIDATION_RESULTS.has(values.validationResult)) throw makeError();
    validateNullableEnum(values.reportingStatus, REPORTING_STATUSES, makeError);
    validateNullableEnum(values.clearanceStatus, CLEARANCE_STATUSES, makeError);
    validateNullablePrintableAscii(values.invoiceNumber, 512, makeError);
    validateNullablePrintableAscii(values.transactionNumber, 512, makeError);
    validateNullablePrintableAscii(values.uuid, 512, makeError);
    if (values.uuid !== null && !UUID_PATTERN.test(values.uuid)) throw makeError();
    validateNullablePrintableAscii(values.invoiceCounter, 512, makeError);
    validateNullablePrintableAscii(values.matchingKey, 512, makeError);
    const validationCodes = sanitizeValidationCodes(values.validationCodes, makeError);
    validateNullableHashPair(values.responseByteCount, values.responseSha256, makeError);
    if (typeof values.retryable !== 'boolean' || !isNonnegativeSafeInteger(values.latencyMs)) throw makeError();

    return finishSummary({
      kind: 'OEIS_RESPONSE',
      httpStatus: values.httpStatus,
      isSystemException: values.isSystemException,
      validationResult: values.validationResult,
      reportingStatus: values.reportingStatus,
      clearanceStatus: values.clearanceStatus,
      invoiceNumber: values.invoiceNumber,
      transactionNumber: values.transactionNumber,
      uuid: values.uuid,
      invoiceCounter: values.invoiceCounter,
      matchingKey: values.matchingKey,
      validationCodes,
      responseByteCount: values.responseByteCount,
      responseSha256: values.responseSha256,
      retryable: values.retryable,
      latencyMs: values.latencyMs,
    }, { family: 'OEIS', kind: 'RESPONSE', hasLatency: true });
  }

  if (kind === 'ARTIFACT') {
    const values = exactObjectValues(input, OEIS_ARTIFACT_KEYS, makeError);
    for (const prefix of ['signedXml', 'qr']) {
      const present = values[`${prefix}Present`];
      const byteCount = values[`${prefix}ByteCount`];
      const hash = values[`${prefix}Sha256`];
      if (typeof present !== 'boolean') throw makeError();
      if (present) {
        if (!isPositiveSafeInteger(byteCount) || typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
          throw makeError();
        }
      } else if (byteCount !== null || hash !== null) {
        throw makeError();
      }
    }

    return finishSummary({
      kind: 'OEIS_ARTIFACT',
      signedXmlPresent: values.signedXmlPresent,
      signedXmlByteCount: values.signedXmlByteCount,
      signedXmlSha256: values.signedXmlSha256,
      qrPresent: values.qrPresent,
      qrByteCount: values.qrByteCount,
      qrSha256: values.qrSha256,
    }, { family: 'OEIS', kind: 'ARTIFACT', hasLatency: false });
  }

  throw makeError();
}

function exactDateMilliseconds(value, makeError) {
  if (value === null || typeof value !== 'object' || isProxy(value)) throw makeError();
  if (Object.getPrototypeOf(value) !== Date.prototype || Reflect.ownKeys(value).length !== 0) throw makeError();
  const milliseconds = Date.prototype.getTime.call(value);
  if (!Number.isFinite(milliseconds)) throw makeError();
  return milliseconds;
}

function validateClockOptions(options) {
  const makeError = () => auditError('AUDIT_CLOCK_INVALID');
  const values = exactObjectValues(options, ['now'], makeError);
  if (typeof values.now !== 'function' || isProxy(values.now)) throw makeError();
  return values.now;
}

function readClock(now) {
  let value;
  try {
    value = now();
  } catch (_error) {
    throw auditError('AUDIT_CLOCK_INVALID');
  }
  return exactDateMilliseconds(value, () => auditError('AUDIT_CLOCK_INVALID'));
}

function checkedDateMilliseconds(base, delta) {
  const result = base + delta;
  if (!Number.isSafeInteger(result) || result < -DATE_MAX_MS || result > DATE_MAX_MS) {
    throw auditError('AUDIT_CLOCK_INVALID');
  }
  return result;
}

function expectedSummaryPlacement(action, outcome) {
  if (action === 'FYND_LOCK_REQUESTED') {
    return { slot: 'requestSummary', family: 'FYND', kind: 'REQUEST', operation: 'LOCK' };
  }
  if (action === 'FYND_LOCK_CONFIRMED' || action === 'FYND_LOCK_FAILED') {
    return { slot: 'responseSummary', family: 'FYND', kind: 'RESPONSE', operation: 'LOCK' };
  }
  if (action === 'FYND_LOCK_READBACK') {
    return outcome === 'STARTED'
      ? { slot: 'requestSummary', family: 'FYND', kind: 'REQUEST', operation: 'LOCK_READBACK' }
      : { slot: 'responseSummary', family: 'FYND', kind: 'RESPONSE', operation: 'LOCK_READBACK' };
  }
  if (action === 'FYND_TRANSITION_REQUESTED') {
    return { slot: 'requestSummary', family: 'FYND', kind: 'REQUEST', operation: 'TRANSITION' };
  }
  if (action === 'FYND_TRANSITION_CONFIRMED' || action === 'FYND_TRANSITION_FAILED') {
    return { slot: 'responseSummary', family: 'FYND', kind: 'RESPONSE', operation: 'TRANSITION' };
  }
  if (action === 'FYND_TRANSITION_READBACK') {
    return outcome === 'STARTED'
      ? { slot: 'requestSummary', family: 'FYND', kind: 'REQUEST', operation: 'TRANSITION_READBACK' }
      : { slot: 'responseSummary', family: 'FYND', kind: 'RESPONSE', operation: 'TRANSITION_READBACK' };
  }
  if (action === 'OEIS_SUBMISSION_REQUESTED') {
    return { slot: 'requestSummary', family: 'OEIS', kind: 'REQUEST' };
  }
  if (action === 'OEIS_RESPONSE_RECEIVED' || action === 'OEIS_SUBMISSION_FAILED') {
    return { slot: 'responseSummary', family: 'OEIS', kind: 'RESPONSE' };
  }
  if (action === 'OEIS_ARTIFACT_STORED') {
    return { slot: 'responseSummary', family: 'OEIS', kind: 'ARTIFACT' };
  }
  return null;
}

function validateAndBrandSummaryPlacement(values, durationMs, makeError) {
  const placement = expectedSummaryPlacement(values.action, values.outcome);
  if (!placement) {
    if (values.requestSummary !== null || values.responseSummary !== null) throw makeError();
    return { requestSummary: null, responseSummary: null };
  }

  const otherSlot = placement.slot === 'requestSummary' ? 'responseSummary' : 'requestSummary';
  if (values[otherSlot] !== null || values[placement.slot] === null) throw makeError();
  const summary = values[placement.slot];
  if (!isObjectLike(summary)) throw makeError();
  const brand = summaryBrands.get(summary);
  if (!brand || brand.family !== placement.family || brand.kind !== placement.kind) throw makeError();
  if (placement.operation !== undefined && brand.operation !== placement.operation) throw makeError();
  if (brand.hasLatency && summary.latencyMs !== durationMs) throw makeError();

  return {
    requestSummary: placement.slot === 'requestSummary' ? summary : null,
    responseSummary: placement.slot === 'responseSummary' ? summary : null,
  };
}

function validateAuditEventInput(input) {
  const makeError = () => auditError('AUDIT_INPUT_INVALID');
  const values = exactObjectValues(input, EVENT_INPUT_KEYS, makeError);
  if (typeof values.eventKey !== 'string' || !KEY_PATTERN.test(values.eventKey)) throw makeError();
  if (values.operationKey !== null
    && (typeof values.operationKey !== 'string' || !KEY_PATTERN.test(values.operationKey))) {
    throw makeError();
  }
  validatePrintableAscii(values.companyId, 512, makeError);
  validateNullablePrintableAscii(values.applicationId, 256, makeError);
  validatePrintableAscii(values.shipmentId, 512, makeError);
  if (values.jobId !== null && !isPositiveSafeInteger(values.jobId)) throw makeError();
  validateNullablePrintableAscii(values.documentNumber, 512, makeError);
  validateActionTuple(values.stage, values.action, values.outcome, makeError);
  if (EXTERNAL_EVENT_ACTIONS.has(values.action)) {
    if (!isPositiveSafeInteger(values.jobId)) throw makeError();
    if (values.operationKey === null) throw makeError();
    const expectedEventKey = createEventKey({
      kind: 'OPERATION',
      operationKey: values.operationKey,
      stage: values.stage,
      action: values.action,
      outcome: values.outcome,
    });
    if (values.eventKey !== expectedEventKey) throw makeError();
  } else if (values.operationKey !== null) {
    throw makeError();
  }
  if (!isNonnegativeSafeInteger(values.attemptNumber)) throw makeError();
  if (values.artifactJobId !== null && !isPositiveSafeInteger(values.artifactJobId)) throw makeError();
  if (values.safeCode !== null
    && (typeof values.safeCode !== 'string' || !SAFE_CODE_PATTERN.test(values.safeCode))) {
    throw makeError();
  }
  if (['FAILURE', 'TIMEOUT', 'INDETERMINATE'].includes(values.outcome) && values.safeCode === null) {
    throw makeError();
  }

  const startedAtMs = values.startedAt === null ? null : exactDateMilliseconds(values.startedAt, makeError);
  const completedAtMs = values.completedAt === null ? null : exactDateMilliseconds(values.completedAt, makeError);
  let durationMs;
  if (startedAtMs === null && completedAtMs === null) {
    durationMs = values.outcome === 'STARTED' ? null : 0;
  } else if (startedAtMs !== null && completedAtMs === null && values.outcome === 'STARTED') {
    durationMs = null;
  } else if (startedAtMs !== null && completedAtMs !== null && values.outcome !== 'STARTED') {
    durationMs = completedAtMs - startedAtMs;
    if (!isNonnegativeSafeInteger(durationMs)) throw makeError();
  } else {
    throw makeError();
  }

  const isClaim = values.action === 'JOB_CLAIMED' || values.action === 'OUTBOX_CLAIMED';
  if (isClaim) {
    if (!isNonnegativeSafeInteger(values.queueDelayMs)) throw makeError();
  } else if (values.queueDelayMs !== null) {
    throw makeError();
  }
  if (values.action === 'RETRY_SCHEDULED') {
    if (!isNonnegativeSafeInteger(values.retryDelayMs)) throw makeError();
  } else if (values.retryDelayMs !== null) {
    throw makeError();
  }

  const summaries = validateAndBrandSummaryPlacement(values, durationMs, makeError);
  return {
    ...values,
    startedAtMs,
    completedAtMs,
    durationMs,
    requestSummary: summaries.requestSummary,
    responseSummary: summaries.responseSummary,
  };
}

function cloneBrandedSummary(summary) {
  if (summary === null) return null;
  const brand = summaryBrands.get(summary);
  const clone = cloneInternalValue(summary);
  deepFreeze(clone);
  summaryBrands.set(clone, brand);
  return clone;
}

function eventJsonSize(event) {
  const canonical = {
    eventKey: event.eventKey,
    operationKey: event.operationKey,
    companyId: event.companyId,
    applicationId: event.applicationId,
    shipmentId: event.shipmentId,
    jobId: event.jobId,
    documentNumber: event.documentNumber,
    stage: event.stage,
    action: event.action,
    outcome: event.outcome,
    attemptNumber: event.attemptNumber,
    startedAt: event.startedAt,
    completedAt: event.completedAt,
    durationMs: event.durationMs,
    queueDelayMs: event.queueDelayMs,
    retryDelayMs: event.retryDelayMs,
    nextAttemptAt: event.nextAttemptAt,
    safeCode: event.safeCode,
    requestSummary: event.requestSummary,
    responseSummary: event.responseSummary,
    artifactJobId: event.artifactJobId,
    occurredAt: event.occurredAt,
    expiresAt: event.expiresAt,
  };
  return Buffer.byteLength(JSON.stringify(canonical), 'utf8');
}

function buildAuditEvent(values, occurredAtMs) {
  const expiresAtMs = checkedDateMilliseconds(occurredAtMs, AUDIT_RETENTION_MS);
  const nextAttemptAtMs = values.retryDelayMs === null
    ? null
    : checkedDateMilliseconds(occurredAtMs, values.retryDelayMs);
  const startedAtMs = values.startedAtMs === null ? occurredAtMs : values.startedAtMs;
  const completedAtMs = values.startedAtMs === null
    ? (values.outcome === 'STARTED' ? null : occurredAtMs)
    : values.completedAtMs;

  const event = {
    eventKey: values.eventKey,
    operationKey: values.operationKey,
    companyId: values.companyId,
    applicationId: values.applicationId,
    shipmentId: values.shipmentId,
    jobId: values.jobId,
    documentNumber: values.documentNumber,
    stage: values.stage,
    action: values.action,
    outcome: values.outcome,
    attemptNumber: values.attemptNumber,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: completedAtMs === null ? null : new Date(completedAtMs).toISOString(),
    durationMs: values.durationMs,
    queueDelayMs: values.queueDelayMs,
    retryDelayMs: values.retryDelayMs,
    nextAttemptAt: nextAttemptAtMs === null ? null : new Date(nextAttemptAtMs).toISOString(),
    safeCode: values.safeCode,
    requestSummary: cloneBrandedSummary(values.requestSummary),
    responseSummary: cloneBrandedSummary(values.responseSummary),
    artifactJobId: values.artifactJobId,
    occurredAt: new Date(occurredAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  deepFreeze(event);
  if (eventJsonSize(event) > AUDIT_EVENT_MAX_BYTES) throw auditError('AUDIT_EVENT_TOO_LARGE');
  return event;
}

function createAuditEvent(input, options) {
  const values = validateAuditEventInput(input);
  const now = validateClockOptions(options);
  const occurredAtMs = readClock(now);
  return buildAuditEvent(values, occurredAtMs);
}

function createAuditBundle(inputs, options) {
  const makeError = () => auditError('AUDIT_INPUT_INVALID');
  const events = denseArrayValues(inputs, makeError);
  const validated = events.map(validateAuditEventInput);
  const eventKeys = new Set();
  for (const event of validated) {
    if (eventKeys.has(event.eventKey)) throw makeError();
    eventKeys.add(event.eventKey);
  }
  const now = validateClockOptions(options);
  const occurredAtMs = readClock(now);
  const bundle = validated.map(event => buildAuditEvent(event, occurredAtMs));
  return deepFreeze(bundle);
}

module.exports = {
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
};
