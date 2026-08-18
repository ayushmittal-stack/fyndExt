'use strict';

const { types } = require('node:util');
const { EinvoiceError } = require('./errors');
const {
  AUDIT_RETENTION_MS,
  AUDIT_ACTION_OUTCOMES,
  createAuditEvent,
  sanitizeFyndSummary,
  sanitizeOeisSummary,
} = require('./audit/audit-contract');
const {
  decodeHeadCursor,
  encodeHeadCursor,
  decodeTimelineCursor,
  encodeTimelineCursor,
} = require('./audit/audit-cursor');

const RESPONSE_MAX_BYTES = 524_288;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;
const COMPANY_PATTERN = /^[1-9][0-9]{0,63}$/;
const EVENT_KEY_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/;
const FAILURE_OUTCOMES = new Set(['FAILURE', 'TIMEOUT', 'INDETERMINATE']);
const SAFE_ACTIVITY_ERRORS = new WeakSet();

const ERROR_MESSAGES = Object.freeze({
  SHIPMENT_ACTIVITY_SERVICE_INVALID: 'Shipment activity service configuration is invalid',
  SHIPMENT_ACTIVITY_REQUEST_INVALID: 'Shipment activity request is invalid',
  SHIPMENT_ACTIVITY_NOT_FOUND: 'Shipment activity was not found',
  SHIPMENT_ACTIVITY_DATA_INVALID: 'Shipment activity data is invalid',
  SHIPMENT_ACTIVITY_READ_FAILED: 'Shipment activity could not be read',
  SHIPMENT_ACTIVITY_RESPONSE_TOO_LARGE: 'Shipment activity response exceeds the size limit',
});

const HEAD_FIELDS = Object.freeze([
  'companyId', 'shipmentId', 'jobId', 'documentNumber',
  'lastStage', 'lastAction', 'lastOutcome', 'lastSafeCode',
  'firstOccurredAt', 'lastOccurredAt', 'lastEventKey', 'expiresAt', 'version',
]);
const EVENT_FIELDS = Object.freeze([
  'eventKey', 'operationKey', 'companyId', 'applicationId', 'shipmentId', 'jobId',
  'documentNumber', 'stage', 'action', 'outcome', 'attemptNumber', 'startedAt',
  'completedAt', 'durationMs', 'queueDelayMs', 'retryDelayMs', 'nextAttemptAt',
  'safeCode', 'requestSummary', 'responseSummary', 'artifactJobId', 'occurredAt',
  'expiresAt',
]);
const HEAD_OUTPUT_FIELDS = Object.freeze([
  'shipmentId', 'jobId', 'documentNumber', 'lastStage', 'lastAction',
  'lastOutcome', 'lastSafeCode', 'firstOccurredAt', 'lastOccurredAt', 'version',
]);
const EVENT_OUTPUT_FIELDS = Object.freeze([
  'jobId', 'documentNumber', 'stage', 'action', 'outcome', 'attemptNumber',
  'startedAt', 'completedAt', 'durationMs', 'queueDelayMs', 'retryDelayMs',
  'nextAttemptAt', 'safeCode', 'requestSummary', 'responseSummary',
  'artifactJobId', 'occurredAt',
]);
const FYND_REQUEST_FIELDS = Object.freeze([
  'operation', 'shipmentId', 'documentNumber', 'requestedLock', 'requestedStatus',
]);
const FYND_RESPONSE_FIELDS = Object.freeze([
  'operation', 'shipmentId', 'documentNumber', 'responseStatus', 'locked',
  'shipmentState', 'finalStateClassification', 'retryable', 'latencyMs',
]);
const OEIS_REQUEST_FIELDS = Object.freeze([
  'documentNumber', 'documentType', 'lineCount', 'currency', 'netAmount',
  'taxAmount', 'totalAmount', 'taxSummaries', 'requestByteCount', 'requestSha256',
  'endpointPath', 'attemptNumber', 'timeoutMs',
]);
const OEIS_RESPONSE_FIELDS = Object.freeze([
  'httpStatus', 'isSystemException', 'validationResult', 'reportingStatus',
  'clearanceStatus', 'invoiceNumber', 'transactionNumber', 'uuid', 'invoiceCounter',
  'matchingKey', 'validationCodes', 'responseByteCount', 'responseSha256',
  'retryable', 'latencyMs',
]);
const OEIS_ARTIFACT_FIELDS = Object.freeze([
  'signedXmlPresent', 'signedXmlByteCount', 'signedXmlSha256',
  'qrPresent', 'qrByteCount', 'qrSha256',
]);
const ACTION_STAGES = Object.freeze({
  WEBHOOK_RECEIVED: 'WEBHOOK',
  WEBHOOK_ACCEPTED: 'WEBHOOK',
  WEBHOOK_DUPLICATE: 'WEBHOOK',
  WEBHOOK_IGNORED: 'WEBHOOK',
  WEBHOOK_REJECTED: 'WEBHOOK',
  JOB_CLAIMED: 'JOB',
  VALIDATION_STARTED: 'VALIDATION',
  VALIDATION_PASSED: 'VALIDATION',
  VALIDATION_FAILED: 'VALIDATION',
  PAYLOAD_PREPARED: 'PAYLOAD',
  FYND_LOCK_REQUESTED: 'FYND_LOCK',
  FYND_LOCK_CONFIRMED: 'FYND_LOCK',
  FYND_LOCK_FAILED: 'FYND_LOCK',
  FYND_LOCK_READBACK: 'FYND_LOCK',
  OEIS_SUBMISSION_HELD: 'OEIS_SUBMISSION',
  OEIS_SUBMISSION_REQUESTED: 'OEIS_SUBMISSION',
  OEIS_RESPONSE_RECEIVED: 'OEIS_SUBMISSION',
  OEIS_SUBMISSION_FAILED: 'OEIS_SUBMISSION',
  OEIS_ARTIFACT_STORED: 'OEIS_ARTIFACT',
  OUTBOX_CLAIMED: 'OUTBOX',
  FYND_TRANSITION_REQUESTED: 'FYND_TRANSITION',
  FYND_TRANSITION_CONFIRMED: 'FYND_TRANSITION',
  FYND_TRANSITION_FAILED: 'FYND_TRANSITION',
  FYND_TRANSITION_READBACK: 'FYND_TRANSITION',
  RETRY_SCHEDULED: 'RETRY',
  LEASE_RECOVERED: 'LEASE',
  JOB_DATA_FAILED: 'JOB',
  JOB_INDETERMINATE: 'JOB',
  JOB_COMPLETED: 'JOB',
  LEGACY_STATE_IMPORTED: 'MIGRATION',
});

function activityError(code) {
  const error = new EinvoiceError(code, ERROR_MESSAGES[code]);
  SAFE_ACTIVITY_ERRORS.add(error);
  return error;
}

function fail(code) {
  throw activityError(code);
}

function isObjectLike(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function isProxy(value) {
  return isObjectLike(value) && types.isProxy(value);
}

function isKnownActivityError(error) {
  return error !== null && typeof error === 'object'
    && !isProxy(error) && SAFE_ACTIVITY_ERRORS.has(error);
}

function inspectPlainObject(value, code) {
  try {
    if (value === null || typeof value !== 'object' || isProxy(value)
        || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string')) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.enumerable !== true) fail(code);
    }
    return { keys, descriptors };
  } catch (error) {
    if (isKnownActivityError(error)) throw error;
    fail(code);
  }
}

function exactObject(value, fields, code) {
  const { keys, descriptors } = inspectPlainObject(value, code);
  if (keys.length !== fields.length || keys.some((key, index) => key !== fields[index])) fail(code);
  const result = {};
  for (const field of fields) result[field] = descriptors[field].value;
  return result;
}

function exactOptions(value) {
  const inspected = inspectPlainObject(value, 'SHIPMENT_ACTIVITY_SERVICE_INVALID');
  const allowed = new Set(['repository', 'now']);
  if (!inspected.descriptors.repository
      || inspected.keys.some(key => !allowed.has(key))) {
    fail('SHIPMENT_ACTIVITY_SERVICE_INVALID');
  }
  return {
    repository: inspected.descriptors.repository.value,
    now: inspected.descriptors.now ? inspected.descriptors.now.value : () => new Date(),
  };
}

function snapshotRepository(repository) {
  try {
    if (repository === null || typeof repository !== 'object' || Array.isArray(repository)
        || isProxy(repository) || Object.getPrototypeOf(repository) !== Object.prototype) {
      fail('SHIPMENT_ACTIVITY_SERVICE_INVALID');
    }
    const result = {};
    for (const field of [
      'listShipmentAuditHeadsForCompany', 'listPreJobFailureHeadsForCompany',
      'listShipmentAuditEventsForCompany',
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(repository, field);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || typeof descriptor.value !== 'function' || isProxy(descriptor.value)) {
        fail('SHIPMENT_ACTIVITY_SERVICE_INVALID');
      }
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (isKnownActivityError(error)) throw error;
    fail('SHIPMENT_ACTIVITY_SERVICE_INVALID');
  }
}

function snapshotFunction(value) {
  if (typeof value !== 'function' || isProxy(value)) fail('SHIPMENT_ACTIVITY_SERVICE_INVALID');
  return value;
}

function denseArray(value, code) {
  try {
    if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      fail(code);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length && descriptors.length.value;
    if (!Number.isSafeInteger(length) || length < 0
        || Reflect.ownKeys(value).length !== length + 1) fail(code);
    const result = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.enumerable !== true) fail(code);
      result.push(descriptor.value);
    }
    return result;
  } catch (error) {
    if (isKnownActivityError(error)) throw error;
    fail(code);
  }
}

function deepFreeze(value, seen = new Set()) {
  if (!isObjectLike(value) || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      deepFreeze(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

function canonicalTimestamp(value, code) {
  if (typeof value !== 'string') fail(code);
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch (_error) {
    fail(code);
  }
  if (canonical !== value) fail(code);
  return Date.parse(value);
}

function printable(value, maximumBytes, nullable, code) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || value.length === 0
      || !PRINTABLE_ASCII_PATTERN.test(value)
      || !/[!-~]/.test(value)
      || Buffer.byteLength(value, 'utf8') > maximumBytes) fail(code);
  return value;
}

function positiveId(value, nullable, code) {
  if (nullable && value === null) return value;
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return value;
}

function nonnegative(value, nullable, code) {
  if (nullable && value === null) return value;
  if (!Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function validateShipmentId(value, code) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)
      || Buffer.byteLength(value, 'utf8') > 512) fail(code);
  return value;
}

function validateCompanyId(value, code) {
  if (typeof value !== 'string' || !COMPANY_PATTERN.test(value)
      || Buffer.byteLength(value, 'utf8') > 64) fail(code);
  return value;
}

function validateSafeCode(value, outcome, code) {
  if (value !== null && (typeof value !== 'string' || !SAFE_CODE_PATTERN.test(value))) fail(code);
  if (FAILURE_OUTCOMES.has(outcome) && value === null) fail(code);
  return value;
}

function validateAction(stage, action, outcome, code) {
  const outcomes = typeof action === 'string' ? AUDIT_ACTION_OUTCOMES[action] : undefined;
  if (!outcomes || ACTION_STAGES[action] !== stage || !outcomes.includes(outcome)) fail(code);
}

function readClock(now) {
  let value;
  try {
    value = now();
    if (value === null || typeof value !== 'object' || isProxy(value)
        || Object.getPrototypeOf(value) !== Date.prototype
        || Reflect.ownKeys(value).length !== 0) fail('SHIPMENT_ACTIVITY_SERVICE_INVALID');
    const milliseconds = Date.prototype.getTime.call(value);
    if (!Number.isFinite(milliseconds)) fail('SHIPMENT_ACTIVITY_SERVICE_INVALID');
    return milliseconds;
  } catch (error) {
    if (isKnownActivityError(error)) throw error;
    fail('SHIPMENT_ACTIVITY_SERVICE_INVALID');
  }
}

function snapshotInput(value, fields) {
  return exactObject(value, fields, 'SHIPMENT_ACTIVITY_REQUEST_INVALID');
}

function validateBefore(value, decode) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0) fail('SHIPMENT_ACTIVITY_REQUEST_INVALID');
  try {
    return decode(value);
  } catch (_error) {
    fail('SHIPMENT_ACTIVITY_REQUEST_INVALID');
  }
}

function validateLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    fail('SHIPMENT_ACTIVITY_REQUEST_INVALID');
  }
  return value;
}

function copySummary(value) {
  if (value === null) return null;
  let inspected;
  try {
    inspected = inspectPlainObject(value, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  } catch (_error) {
    fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  }
  const kindDescriptor = inspected.descriptors.kind;
  if (!kindDescriptor || typeof kindDescriptor.value !== 'string') {
    fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  }
  const kind = kindDescriptor.value;
  let fields;
  let sanitize;
  if (kind === 'FYND_REQUEST') {
    fields = FYND_REQUEST_FIELDS;
    sanitize = input => sanitizeFyndSummary('REQUEST', input);
  } else if (kind === 'FYND_RESPONSE') {
    fields = FYND_RESPONSE_FIELDS;
    sanitize = input => sanitizeFyndSummary('RESPONSE', input);
  } else if (kind === 'OEIS_REQUEST') {
    fields = OEIS_REQUEST_FIELDS;
    sanitize = input => sanitizeOeisSummary('REQUEST', input);
  } else if (kind === 'OEIS_RESPONSE') {
    fields = OEIS_RESPONSE_FIELDS;
    sanitize = input => sanitizeOeisSummary('RESPONSE', input);
  } else if (kind === 'OEIS_ARTIFACT') {
    fields = OEIS_ARTIFACT_FIELDS;
    sanitize = input => sanitizeOeisSummary('ARTIFACT', input);
  } else {
    fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  }
  const raw = exactObject(
    value,
    ['kind', ...fields],
    'SHIPMENT_ACTIVITY_DATA_INVALID',
  );
  const input = {};
  for (const field of fields) input[field] = raw[field];
  try {
    return sanitize(input);
  } catch (_error) {
    fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  }
}

function validateHead(value, companyId, nowMs) {
  const raw = exactObject(value, HEAD_FIELDS, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  if (raw.companyId !== companyId) fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  validateShipmentId(raw.shipmentId, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  positiveId(raw.jobId, true, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  printable(raw.documentNumber, 512, true, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  if ((raw.jobId === null) !== (raw.documentNumber === null)) {
    fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  }
  validateAction(raw.lastStage, raw.lastAction, raw.lastOutcome, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  validateSafeCode(raw.lastSafeCode, raw.lastOutcome, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  const firstMs = canonicalTimestamp(raw.firstOccurredAt, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  const lastMs = canonicalTimestamp(raw.lastOccurredAt, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  const expiresMs = canonicalTimestamp(raw.expiresAt, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  if (firstMs > lastMs || expiresMs - lastMs !== AUDIT_RETENTION_MS || expiresMs <= nowMs) {
    fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  }
  if (typeof raw.lastEventKey !== 'string' || !EVENT_KEY_PATTERN.test(raw.lastEventKey)) {
    fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  }
  nonnegative(raw.version, false, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  return raw;
}

function validatePreJobFailureHead(value, companyId, nowMs) {
  const raw = validateHead(value, companyId, nowMs);
  if (raw.jobId !== null || raw.documentNumber !== null || raw.lastOutcome !== 'FAILURE'
      || !['WEBHOOK_REJECTED', 'VALIDATION_FAILED'].includes(raw.lastAction)) {
    fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  }
  return raw;
}

function validateEvent(value, companyId, shipmentId, nowMs) {
  const raw = exactObject(value, EVENT_FIELDS, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  if (raw.companyId !== companyId || raw.shipmentId !== shipmentId) {
    fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  }
  printable(raw.applicationId, 256, true, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  positiveId(raw.jobId, true, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  printable(raw.documentNumber, 512, true, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  const occurredMs = canonicalTimestamp(raw.occurredAt, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  const expiresMs = canonicalTimestamp(raw.expiresAt, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  if (expiresMs - occurredMs !== AUDIT_RETENTION_MS || expiresMs <= nowMs) {
    fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  }
  const requestSummary = copySummary(raw.requestSummary);
  const responseSummary = copySummary(raw.responseSummary);
  for (const summary of [requestSummary, responseSummary]) {
    if (summary === null) continue;
    if ((summary.kind === 'FYND_REQUEST' || summary.kind === 'FYND_RESPONSE')
        && (summary.shipmentId !== raw.shipmentId
          || summary.documentNumber !== raw.documentNumber)) {
      fail('SHIPMENT_ACTIVITY_DATA_INVALID');
    }
    if (summary.kind === 'OEIS_REQUEST'
        && (summary.documentNumber !== raw.documentNumber
          || summary.attemptNumber !== raw.attemptNumber)) {
      fail('SHIPMENT_ACTIVITY_DATA_INVALID');
    }
  }
  let rebuilt;
  try {
    rebuilt = createAuditEvent({
      eventKey: raw.eventKey,
      operationKey: raw.operationKey,
      companyId: raw.companyId,
      applicationId: raw.applicationId,
      shipmentId: raw.shipmentId,
      jobId: raw.jobId,
      documentNumber: raw.documentNumber,
      stage: raw.stage,
      action: raw.action,
      outcome: raw.outcome,
      attemptNumber: raw.attemptNumber,
      startedAt: raw.startedAt === null
        ? null
        : new Date(canonicalTimestamp(raw.startedAt, 'SHIPMENT_ACTIVITY_DATA_INVALID')),
      completedAt: raw.completedAt === null
        ? null
        : new Date(canonicalTimestamp(raw.completedAt, 'SHIPMENT_ACTIVITY_DATA_INVALID')),
      queueDelayMs: raw.queueDelayMs,
      retryDelayMs: raw.retryDelayMs,
      safeCode: raw.safeCode,
      requestSummary,
      responseSummary,
      artifactJobId: raw.artifactJobId,
    }, { now: () => new Date(occurredMs) });
  } catch (_error) {
    fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  }
  if (JSON.stringify(rebuilt) !== JSON.stringify(raw)) fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  return rebuilt;
}

function validatePage(value) {
  const raw = exactObject(value, ['items', 'nextBefore'], 'SHIPMENT_ACTIVITY_DATA_INVALID');
  return { items: denseArray(raw.items, 'SHIPMENT_ACTIVITY_DATA_INVALID'), nextBefore: raw.nextBefore };
}

function validateHeadNext(value, items) {
  if (value === null) return null;
  const next = exactObject(
    value, ['lastOccurredAt', 'shipmentId'], 'SHIPMENT_ACTIVITY_DATA_INVALID',
  );
  canonicalTimestamp(next.lastOccurredAt, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  validateShipmentId(next.shipmentId, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  const last = items[items.length - 1];
  if (!last || next.lastOccurredAt !== last.lastOccurredAt || next.shipmentId !== last.shipmentId) {
    fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  }
  return next;
}

function validateTimelineNext(value, items) {
  if (value === null) return null;
  const next = exactObject(value, ['occurredAt', 'eventKey'], 'SHIPMENT_ACTIVITY_DATA_INVALID');
  canonicalTimestamp(next.occurredAt, 'SHIPMENT_ACTIVITY_DATA_INVALID');
  if (typeof next.eventKey !== 'string' || !EVENT_KEY_PATTERN.test(next.eventKey)) {
    fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  }
  const last = items[items.length - 1];
  if (!last || next.occurredAt !== last.occurredAt || next.eventKey !== last.eventKey) {
    fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  }
  return next;
}

function assertDescending(items, timeField, tieField) {
  const seen = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const tuple = `${item[timeField]}\u0000${item[tieField]}`;
    if (seen.has(tuple)) fail('SHIPMENT_ACTIVITY_DATA_INVALID');
    seen.add(tuple);
    if (index === 0) continue;
    const previous = items[index - 1];
    const previousTime = Date.parse(previous[timeField]);
    const itemTime = Date.parse(item[timeField]);
    if (previousTime < itemTime
        || (previousTime === itemTime
          && previous[tieField] <= item[tieField])) {
      fail('SHIPMENT_ACTIVITY_DATA_INVALID');
    }
  }
}

function assertStrictlyBefore(items, before, timeField, tieField) {
  if (before === null) return;
  const beforeTime = Date.parse(before[timeField]);
  for (const item of items) {
    const itemTime = Date.parse(item[timeField]);
    if (item[tieField] === before[tieField]
        || itemTime > beforeTime
        || (itemTime === beforeTime && item[tieField] >= before[tieField])) {
      fail('SHIPMENT_ACTIVITY_DATA_INVALID');
    }
  }
}

function ensureResponseSize(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (_error) {
    fail('SHIPMENT_ACTIVITY_DATA_INVALID');
  }
  if (Buffer.byteLength(serialized, 'utf8') > RESPONSE_MAX_BYTES) {
    fail('SHIPMENT_ACTIVITY_RESPONSE_TOO_LARGE');
  }
}

function safeRepositoryCode(error) {
  try {
    if (error === null || typeof error !== 'object' || isProxy(error)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : null;
  } catch (_error) {
    return null;
  }
}

async function repositoryRead(operation, anchored) {
  try {
    return await operation();
  } catch (error) {
    if (anchored && safeRepositoryCode(error) === 'REPOSITORY_INPUT_INVALID') {
      fail('SHIPMENT_ACTIVITY_NOT_FOUND');
    }
    fail('SHIPMENT_ACTIVITY_READ_FAILED');
  }
}

function projectHead(raw) {
  const output = {};
  for (const field of HEAD_OUTPUT_FIELDS) output[field] = raw[field];
  return output;
}

function projectEvent(raw) {
  const output = {};
  for (const field of EVENT_OUTPUT_FIELDS) output[field] = raw[field];
  return output;
}

function createShipmentActivityService(options) {
  const { repository, now } = exactOptions(options);
  const readPort = snapshotRepository(repository);
  const trustedNow = snapshotFunction(now);

  return Object.freeze({
    async listShipments(input) {
      const query = snapshotInput(input, ['companyId', 'limit', 'before']);
      validateCompanyId(query.companyId, 'SHIPMENT_ACTIVITY_REQUEST_INVALID');
      validateLimit(query.limit);
      const before = validateBefore(query.before, decodeHeadCursor);
      const nowMs = readClock(trustedNow);
      const returned = await repositoryRead(() => (
        readPort.listShipmentAuditHeadsForCompany.call(repository, {
          companyId: query.companyId,
          limit: query.limit,
          before,
        })
      ), before !== null);
      const page = validatePage(returned);
      if (page.items.length > query.limit) fail('SHIPMENT_ACTIVITY_DATA_INVALID');
      const items = page.items.map(item => validateHead(item, query.companyId, nowMs));
      assertDescending(items, 'lastOccurredAt', 'shipmentId');
      assertStrictlyBefore(items, before, 'lastOccurredAt', 'shipmentId');
      if (new Set(items.map(item => item.shipmentId)).size !== items.length) {
        fail('SHIPMENT_ACTIVITY_DATA_INVALID');
      }
      const next = validateHeadNext(page.nextBefore, items);
      const response = {
        items: items.map(projectHead),
        nextBefore: next === null ? null : encodeHeadCursor(next),
      };
      ensureResponseSize(response);
      return deepFreeze(response);
    },

    async listPreJobFailures(input) {
      const query = snapshotInput(input, ['companyId', 'limit', 'before']);
      validateCompanyId(query.companyId, 'SHIPMENT_ACTIVITY_REQUEST_INVALID');
      validateLimit(query.limit);
      const before = validateBefore(query.before, decodeHeadCursor);
      const nowMs = readClock(trustedNow);
      const returned = await repositoryRead(() => (
        readPort.listPreJobFailureHeadsForCompany.call(repository, {
          companyId: query.companyId,
          limit: query.limit,
          before,
        })
      ), before !== null);
      const page = validatePage(returned);
      if (page.items.length > query.limit) fail('SHIPMENT_ACTIVITY_DATA_INVALID');
      const items = page.items.map(item => validatePreJobFailureHead(
        item, query.companyId, nowMs,
      ));
      assertDescending(items, 'lastOccurredAt', 'shipmentId');
      assertStrictlyBefore(items, before, 'lastOccurredAt', 'shipmentId');
      if (new Set(items.map(item => item.shipmentId)).size !== items.length) {
        fail('SHIPMENT_ACTIVITY_DATA_INVALID');
      }
      const next = validateHeadNext(page.nextBefore, items);
      const response = {
        items: items.map(projectHead),
        nextBefore: next === null ? null : encodeHeadCursor(next),
      };
      ensureResponseSize(response);
      return deepFreeze(response);
    },

    async getTimeline(input) {
      const query = snapshotInput(input, ['companyId', 'shipmentId', 'limit', 'before']);
      validateCompanyId(query.companyId, 'SHIPMENT_ACTIVITY_REQUEST_INVALID');
      validateShipmentId(query.shipmentId, 'SHIPMENT_ACTIVITY_REQUEST_INVALID');
      validateLimit(query.limit);
      const before = validateBefore(query.before, decodeTimelineCursor);
      const nowMs = readClock(trustedNow);
      const returned = await repositoryRead(() => (
        readPort.listShipmentAuditEventsForCompany.call(repository, {
          companyId: query.companyId,
          shipmentId: query.shipmentId,
          limit: query.limit,
          before,
        })
      ), before !== null);
      const page = validatePage(returned);
      if (page.items.length > query.limit) fail('SHIPMENT_ACTIVITY_DATA_INVALID');
      const items = page.items.map(item => validateEvent(
        item, query.companyId, query.shipmentId, nowMs,
      ));
      assertDescending(items, 'occurredAt', 'eventKey');
      assertStrictlyBefore(items, before, 'occurredAt', 'eventKey');
      if (new Set(items.map(item => item.eventKey)).size !== items.length) {
        fail('SHIPMENT_ACTIVITY_DATA_INVALID');
      }
      const next = validateTimelineNext(page.nextBefore, items);
      if (before === null && items.length === 0) fail('SHIPMENT_ACTIVITY_NOT_FOUND');
      const response = {
        shipmentId: query.shipmentId,
        items: [...items].reverse().map(projectEvent),
        nextBefore: next === null ? null : encodeTimelineCursor(next),
      };
      ensureResponseSize(response);
      return deepFreeze(response);
    },
  });
}

module.exports = {
  SHIPMENT_ACTIVITY_RESPONSE_MAX_BYTES: RESPONSE_MAX_BYTES,
  createShipmentActivityService,
};
