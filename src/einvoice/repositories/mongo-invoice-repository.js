'use strict';

const { createHash } = require('crypto');
const { types } = require('util');
const { Long, MongoError } = require('mongodb');

const { EinvoiceError } = require('../errors');
const {
  JOB_STATES,
  OUTBOX_ACTIONS,
  OUTBOX_STATUSES,
  assertMongoInvoiceRepository,
} = require('./invoice-repository');
const {
  AUDIT_ACTIONS,
  AUDIT_ACTION_OUTCOMES,
  AUDIT_EVENT_MAX_BYTES,
  AUDIT_OUTCOMES,
  AUDIT_RETENTION_MS,
  AUDIT_STAGES,
  AUDIT_SUMMARY_MAX_BYTES,
  createAuditEvent,
  createEventKey,
  createOperationKey,
  sanitizeFyndSummary,
  sanitizeOeisSummary,
} = require('../audit/audit-contract');
const {
  normalizeSnapshot,
  timestamp,
} = require('./invoice-repository-validation');
const {
  decodeDate,
  decodeNonnegativeLong,
  decodeNullableDate,
  decodeNullablePositiveLong,
  decodePositiveLong,
  encodeDate,
  encodeNullableDate,
  encodeNullablePositiveLong,
  encodePositiveLong,
} = require('./mongo-repository-codec');
const {
  MONGO_COLLECTION_NAMES,
  MONGO_INDEX_CATALOG,
  creationOptions,
} = require('./mongo-indexes');

const SAFE_ERRORS = new WeakSet();
const DUPLICATE_RACES = new WeakSet();
const PROBE_ID = '__repository_transaction_probe__';
const PRE_JOB_FAILURE_HEAD_REPAIR_MARKER_ID = (
  'shipment_audit_heads_pre_job_failure_precedence_v1'
);
const PRE_JOB_FAILURE_HEAD_REPAIR_MARKER = Object.freeze({
  _id: PRE_JOB_FAILURE_HEAD_REPAIR_MARKER_ID,
  migration: 'PRE_JOB_FAILURE_HEAD_PRECEDENCE',
  version: 1,
});
const MONGO_TRANSACTION_TIMEOUT_MS = 5_000;
const MAX_SAFE_LONG = Long.fromString(String(Number.MAX_SAFE_INTEGER));
const EVENT_FIELDS = Object.freeze([
  'eventKey', 'operationKey', 'companyId', 'applicationId', 'shipmentId', 'jobId',
  'documentNumber', 'stage', 'action', 'outcome', 'attemptNumber', 'startedAt',
  'completedAt', 'durationMs', 'queueDelayMs', 'retryDelayMs', 'nextAttemptAt',
  'safeCode', 'requestSummary', 'responseSummary', 'artifactJobId', 'occurredAt',
  'expiresAt',
]);
const HEAD_FIELDS = Object.freeze([
  'companyId', 'shipmentId', 'jobId', 'documentNumber', 'lastStage', 'lastAction',
  'lastOutcome', 'lastSafeCode', 'firstOccurredAt', 'lastOccurredAt', 'lastEventKey',
  'expiresAt', 'version',
]);
const PENDING_OPERATION_FIELDS = Object.freeze([
  'operationKey', 'eventKey', 'stage', 'action', 'attemptNumber',
  'expectedParentVersion', 'startedAt', 'targetKind', 'targetId',
]);
const KEY_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const AUDIT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const EXTERNAL_ACTIONS = new Set([
  'FYND_LOCK_REQUESTED', 'FYND_LOCK_CONFIRMED', 'FYND_LOCK_FAILED',
  'FYND_LOCK_READBACK', 'OEIS_SUBMISSION_REQUESTED', 'OEIS_RESPONSE_RECEIVED',
  'OEIS_SUBMISSION_FAILED', 'FYND_TRANSITION_REQUESTED',
  'FYND_TRANSITION_CONFIRMED', 'FYND_TRANSITION_FAILED', 'FYND_TRANSITION_READBACK',
]);
const PENDING_OPERATION_ACTIONS = new Set([
  'FYND_LOCK_REQUESTED', 'OEIS_SUBMISSION_REQUESTED', 'FYND_TRANSITION_REQUESTED',
]);
const JOB_BEGIN_ACTIONS = new Set([
  'FYND_LOCK_REQUESTED', 'OEIS_SUBMISSION_REQUESTED',
]);
const EXTERNAL_STAGES = new Set(['FYND_LOCK', 'OEIS_SUBMISSION', 'FYND_TRANSITION']);
const WEBHOOK_REPLAY_CLOCK_FIELDS = new Set([
  'startedAt', 'completedAt', 'durationMs', 'occurredAt', 'expiresAt',
]);
const WEBHOOK_SCOPE_ACTIONS = new Set([
  'WEBHOOK_RECEIVED', 'WEBHOOK_ACCEPTED', 'WEBHOOK_DUPLICATE', 'WEBHOOK_IGNORED',
  'WEBHOOK_REJECTED',
]);
const WEBHOOK_SCOPE_VALIDATION_ACTIONS = new Set([
  'VALIDATION_STARTED', 'VALIDATION_PASSED', 'VALIDATION_FAILED',
]);
const PRE_JOB_FAILURE_ACTIONS = Object.freeze([
  'WEBHOOK_REJECTED', 'VALIDATION_FAILED',
]);
const PRE_JOB_FAILURE_REPAIR_BATCH_SIZE = 100;
const PRE_JOB_FAILURE_REPAIR_SAME_CLOCK_MAX_ROWS = 1_000;
const AUDIT_ACTION_STAGES = Object.freeze({
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
const JOB_EXTERNAL_STATES = Object.freeze({
  FYND_LOCK: Object.freeze([
    JOB_STATES.LOCK_PENDING,
    JOB_STATES.DRY_RUN_LOCK_PENDING,
    JOB_STATES.RETRY_WAIT,
    JOB_STATES.DRY_RUN_RETRY_WAIT,
  ]),
  OEIS_SUBMISSION: Object.freeze([JOB_STATES.LOCKED, JOB_STATES.RETRY_WAIT]),
});
const ACTIVE_JOB_STATES = Object.freeze([
  JOB_STATES.RECEIVED,
  JOB_STATES.LOCK_PENDING,
  JOB_STATES.LOCKED,
  JOB_STATES.RETRY_WAIT,
  JOB_STATES.DRY_RUN_RECEIVED,
  JOB_STATES.DRY_RUN_LOCK_PENDING,
  JOB_STATES.DRY_RUN_RETRY_WAIT,
]);
const INITIAL_JOB_STATES = Object.freeze([
  JOB_STATES.RECEIVED,
  JOB_STATES.DRY_RUN_RECEIVED,
]);
const LOCK_STAGE_JOB_STATES = Object.freeze([
  JOB_STATES.LOCK_PENDING,
  JOB_STATES.RETRY_WAIT,
  JOB_STATES.DRY_RUN_LOCK_PENDING,
  JOB_STATES.DRY_RUN_RETRY_WAIT,
]);
const DRY_RUN_JOB_STATES = new Set([
  JOB_STATES.DRY_RUN_RECEIVED,
  JOB_STATES.DRY_RUN_LOCK_PENDING,
  JOB_STATES.DRY_RUN_RETRY_WAIT,
]);
const JOB_TERMINAL_OUTCOME_ACTIONS = Object.freeze({
  FYND_LOCK_REQUESTED: Object.freeze(['FYND_LOCK_CONFIRMED', 'FYND_LOCK_FAILED']),
  OEIS_SUBMISSION_REQUESTED: Object.freeze([
    'OEIS_RESPONSE_RECEIVED', 'OEIS_SUBMISSION_FAILED',
  ]),
});
const JOB_EXTERNAL_TERMINAL_ACTIONS = new Set([
  'FYND_LOCK_CONFIRMED', 'FYND_LOCK_FAILED',
  'OEIS_RESPONSE_RECEIVED', 'OEIS_SUBMISSION_FAILED',
]);
const SAVE_PREPARED_LOCAL_ACTIONS = Object.freeze([
  'VALIDATION_PASSED', 'PAYLOAD_PREPARED',
]);
const NO_LOCAL_ACTIONS = Object.freeze([]);
const MARK_LOCKED_LOCAL_ACTIONS = Object.freeze(['OEIS_SUBMISSION_HELD']);
const SCHEDULE_RETRY_LOCAL_ACTIONS = Object.freeze(['RETRY_SCHEDULED']);
const TERMINAL_LOCAL_ACTIONS = Object.freeze({
  [JOB_STATES.DATA_FAILED]: Object.freeze(['VALIDATION_FAILED', 'JOB_DATA_FAILED']),
  [JOB_STATES.INDETERMINATE]: Object.freeze(['JOB_INDETERMINATE']),
});
const JOB_DOCUMENT_FIELDS = Object.freeze([
  'jobId', 'companyId', 'applicationId', 'shipmentId', 'documentType', 'documentNumber',
  'state', 'shipmentSnapshotJson', 'oeisRequestJson', 'requestHash', 'attemptCount',
  'dueAt', 'nextAttemptAt', 'leaseOwner', 'leaseExpiresAt', 'lastErrorCode',
  'lastErrorMessage', 'lockedAt', 'pendingOperation', 'version', 'createdAt', 'updatedAt',
]);
const ARTIFACT_DOCUMENT_FIELDS = Object.freeze([
  'jobId', 'invoiceNumber', 'transactionNumber', 'uuid', 'invoiceCounter',
  'matchingKey', 'responseStatus', 'signedXmlBase64', 'signedXmlSha256',
  'qrCodeData', 'createdAt',
]);
const OUTBOX_DOCUMENT_FIELDS = Object.freeze([
  'outboxId', 'jobId', 'action', 'payloadJson', 'status', 'attemptCount',
  'dueAt', 'nextAttemptAt', 'leaseOwner', 'leaseExpiresAt', 'lastErrorCode',
  'lastErrorMessage', 'version', 'createdAt', 'completedAt', 'parentState',
  'parentVersion', 'pendingOperation',
]);
const ACTIVE_OUTBOX_STATUSES = Object.freeze([
  OUTBOX_STATUSES.PENDING,
  OUTBOX_STATUSES.RETRY_WAIT,
]);
const OUTBOX_TERMINAL_OUTCOME_ACTIONS = Object.freeze([
  'FYND_TRANSITION_CONFIRMED',
  'FYND_TRANSITION_FAILED',
]);
const OUTBOX_LOCAL_ACTIONS = Object.freeze({
  RETRY: Object.freeze(['RETRY_SCHEDULED']),
  COMPLETED: Object.freeze(['JOB_COMPLETED']),
  INDETERMINATE: Object.freeze(['JOB_INDETERMINATE']),
});
const OUTBOX_CLAIM_COMPANION_ACTIONS = Object.freeze([
  'VALIDATION_STARTED', 'VALIDATION_PASSED', 'PAYLOAD_PREPARED',
]);
const TRANSACTION_OPTIONS = Object.freeze({
  readPreference: 'primary',
  readConcern: Object.freeze({ level: 'snapshot' }),
  writeConcern: Object.freeze({ w: 'majority' }),
  timeoutMS: MONGO_TRANSACTION_TIMEOUT_MS,
});

function repositoryError(code, message, retryable = false) {
  const error = new EinvoiceError(code, message, { retryable });
  SAFE_ERRORS.add(error);
  return error;
}

function configError() {
  return repositoryError(
    'REPOSITORY_CONFIG_INVALID',
    'Invoice repository configuration is invalid',
  );
}

function initializationError() {
  return repositoryError(
    'REPOSITORY_INITIALIZATION_FAILED',
    'Invoice repository initialization failed',
  );
}

function unavailableError() {
  return repositoryError(
    'REPOSITORY_UNAVAILABLE',
    'Invoice repository is unavailable',
    true,
  );
}

function inputError() {
  return repositoryError('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid');
}

function claimError() {
  return repositoryError(
    'REPOSITORY_CLAIM_INVALID',
    'Invoice repository claim is invalid',
  );
}

function readInputError() {
  return repositoryError(
    'REPOSITORY_INPUT_INVALID',
    'Invoice repository read input is invalid',
  );
}

function dataError() {
  return repositoryError('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid');
}

function idempotencyError(kind) {
  return repositoryError(
    'IDEMPOTENCY_CONFLICT',
    kind === 'event'
      ? 'Webhook event identity conflicts with an existing event'
      : 'Webhook shipment data conflicts with an existing invoice job',
  );
}

function exhaustedError() {
  return repositoryError(
    'REPOSITORY_ID_EXHAUSTED',
    'Invoice repository identifier space is exhausted',
  );
}

function busyError() {
  return repositoryError('REPOSITORY_BUSY', 'Invoice repository is busy', true);
}

function versionConflictError() {
  return repositoryError(
    'REPOSITORY_VERSION_CONFLICT',
    'Invoice repository record changed concurrently',
  );
}

function payloadDriftError() {
  return repositoryError(
    'PAYLOAD_DRIFT',
    'Stored invoice request differs from the prepared request',
  );
}

function duplicateRaceError() {
  const error = new Error('repository duplicate race');
  DUPLICATE_RACES.add(error);
  return error;
}

function transactionUnknownError() {
  return repositoryError(
    'REPOSITORY_TRANSACTION_UNKNOWN',
    'Invoice repository transaction result is unknown',
  );
}

function closedError() {
  return repositoryError('REPOSITORY_CLOSED', 'Invoice repository is closed');
}

function notInitializedError() {
  return repositoryError(
    'REPOSITORY_NOT_INITIALIZED',
    'Invoice repository is not initialized',
  );
}

function notImplementedError() {
  return repositoryError(
    'REPOSITORY_NOT_IMPLEMENTED',
    'Invoice repository operation is not implemented',
  );
}

function isPlainOwnDataObject(value, allowedKeys) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !allowedKeys.includes(key))) return false;
    return keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value');
    });
  } catch {
    return false;
  }
}

function ownDataValue(value, key, required = true) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) return required ? undefined : null;
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function resolveCallable(target, name) {
  if ((typeof target !== 'object' && typeof target !== 'function')
      || target === null || types.isProxy(target)) throw configError();
  let current = target;
  try {
    while (current !== null) {
      if (types.isProxy(current)) throw configError();
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor) {
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')
            || typeof descriptor.value !== 'function' || types.isProxy(descriptor.value)) {
          throw configError();
        }
        return descriptor.value;
      }
      current = Object.getPrototypeOf(current);
    }
  } catch (error) {
    if (SAFE_ERRORS.has(error)) throw error;
    throw configError();
  }
  throw configError();
}

function invokeSync(target, method, args) {
  let result;
  try {
    result = Reflect.apply(method, target, args);
  } catch (error) {
    throw error;
  }
  if (types.isProxy(result)) throw unavailableError();
  return result;
}

function invokePromise(target, method, args) {
  let result;
  try {
    result = Reflect.apply(method, target, args);
  } catch (error) {
    return Promise.reject(error);
  }
  if (types.isProxy(result) || !(result instanceof Promise)) {
    return Promise.reject(unavailableError());
  }
  return Promise.prototype.then.call(result, value => value);
}

function snapshotPlainObject(value, allowedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    throw unavailableError();
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw unavailableError();
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !allowedKeys.includes(key))) {
      throw unavailableError();
    }
    const snapshot = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw unavailableError();
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (SAFE_ERRORS.has(error)) throw error;
    throw unavailableError();
  }
}

function sameOrderedKey(actual, expected) {
  const actualSnapshot = snapshotPlainObject(actual, Object.keys(expected));
  const actualEntries = Object.entries(actualSnapshot);
  const expectedEntries = Object.entries(expected);
  return actualEntries.length === expectedEntries.length
    && actualEntries.every(([key, value], index) => (
      key === expectedEntries[index][0] && value === expectedEntries[index][1]
    ));
}

function normalizeCollation(value) {
  if (value === undefined) return null;
  const snapshot = snapshotPlainObject(value, ['locale']);
  return Reflect.ownKeys(snapshot).length === 1 && snapshot.locale === 'simple'
    ? 'simple'
    : 'invalid';
}

function matchesIndex(actual, expected) {
  const allowed = [
    'v', 'ns', 'name', 'key', 'unique', 'expireAfterSeconds', 'collation',
    'sparse', 'partialFilterExpression', 'hidden',
  ];
  const snapshot = snapshotPlainObject(actual, allowed);
  if (snapshot.name !== expected.name || !sameOrderedKey(snapshot.key, expected.key)) return false;
  if ((snapshot.unique === true) !== (expected.unique === true)) return false;
  if (snapshot.expireAfterSeconds !== expected.expireAfterSeconds) return false;
  const actualCollation = normalizeCollation(snapshot.collation);
  if (expected.collation) {
    if (actualCollation !== null && actualCollation !== 'simple') return false;
  } else if (actualCollation !== null) return false;
  if (Object.prototype.hasOwnProperty.call(snapshot, 'sparse')
      || Object.prototype.hasOwnProperty.call(snapshot, 'hidden')
      || Object.prototype.hasOwnProperty.call(snapshot, 'partialFilterExpression')) return false;
  return true;
}

function isPermittedIdIndex(index) {
  const allowed = ['v', 'ns', 'name', 'key', 'unique'];
  const snapshot = snapshotPlainObject(index, allowed);
  return snapshot.name === '_id_' && sameOrderedKey(snapshot.key, { _id: 1 });
}

function validateIndexList(indexes, expected) {
  if (!Array.isArray(indexes) || types.isProxy(indexes)
      || Object.getPrototypeOf(indexes) !== Array.prototype) throw unavailableError();
  const descriptors = Object.getOwnPropertyDescriptors(indexes);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => key !== 'length'
      && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)))) throw unavailableError();
  const values = [];
  for (let index = 0; index < indexes.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw unavailableError();
    }
    values.push(descriptor.value);
  }
  const idIndexes = values.filter(index => {
    try {
      const name = snapshotPlainObject(index, [
        'v', 'ns', 'name', 'key', 'unique', 'expireAfterSeconds', 'collation',
        'sparse', 'partialFilterExpression', 'hidden',
      ]).name;
      return name === '_id_';
    } catch {
      return false;
    }
  });
  if (idIndexes.length !== 1 || !isPermittedIdIndex(idIndexes[0])) throw unavailableError();
  const secondary = values.filter(index => index !== idIndexes[0]);
  if (secondary.length !== expected.length) throw unavailableError();
  for (const definition of expected) {
    if (secondary.filter(index => matchesIndex(index, definition)).length !== 1) {
      throw unavailableError();
    }
  }
}

function validateUpdateResult(value) {
  const result = snapshotPlainObject(value, [
    'acknowledged', 'matchedCount', 'modifiedCount', 'upsertedCount', 'upsertedId',
  ]);
  if (result.acknowledged !== true
      || !Number.isSafeInteger(result.matchedCount) || result.matchedCount < 0
      || !Number.isSafeInteger(result.modifiedCount) || result.modifiedCount < 0
      || !Number.isSafeInteger(result.upsertedCount) || ![0, 1].includes(result.upsertedCount)
      || (result.upsertedCount === 0 && result.upsertedId !== null)
      || (result.upsertedCount === 1 && result.upsertedId === null)) {
    throw unavailableError();
  }
}

function validateInsertResult(value, expectedId) {
  const result = snapshotPlainObject(value, ['acknowledged', 'insertedId']);
  if (result.acknowledged !== true || result.insertedId !== expectedId) throw unavailableError();
}

function validateGeneratedInsertResult(value) {
  const result = snapshotPlainObject(value, ['acknowledged', 'insertedId']);
  if (result.acknowledged !== true || result.insertedId === null
      || result.insertedId === undefined || types.isProxy(result.insertedId)) {
    throw dataError();
  }
}

function readOwnInput(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    throw inputError();
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw inputError();
    const snapshot = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw inputError();
      }
      snapshot[field] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (SAFE_ERRORS.has(error)) throw error;
    throw inputError();
  }
}

function readOptionalOwnInput(value, field) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor) return undefined;
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw inputError();
    return descriptor.value;
  } catch (error) {
    if (SAFE_ERRORS.has(error)) throw error;
    throw inputError();
  }
}

function readRequiredOwnDataInput(value, requiredFields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    throw inputError();
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw inputError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string'
        || !Object.prototype.hasOwnProperty.call(descriptors[key], 'value'))) {
      throw inputError();
    }
    const snapshot = {};
    for (const field of requiredFields) {
      if (!descriptors[field]) throw inputError();
      snapshot[field] = descriptors[field].value;
    }
    return { snapshot, descriptors };
  } catch (error) {
    if (SAFE_ERRORS.has(error)) throw error;
    throw inputError();
  }
}

function requireIdentifier(value, maximumBytes = 512) {
  if (typeof value !== 'string' || value.trim() === ''
      || Buffer.byteLength(value, 'utf8') > maximumBytes
      || /[\u0000-\u001F\u007F-\u009F]/.test(value)) throw inputError();
  return value;
}

function normalizeWebhookInput(eventRecord, normalizedShipment, dryRunEnabled) {
  if (typeof dryRunEnabled !== 'boolean') throw inputError();
  const event = readOwnInput(eventRecord, [
    'eventId', 'companyId', 'applicationId', 'shipmentId', 'eventType', 'status', 'receivedAt',
  ]);
  event.eventId = requireIdentifier(event.eventId);
  event.companyId = requireIdentifier(event.companyId);
  event.shipmentId = requireIdentifier(event.shipmentId);
  event.eventType = requireIdentifier(event.eventType);
  event.status = requireIdentifier(event.status);
  if (event.applicationId !== null && event.applicationId !== undefined) {
    event.applicationId = requireIdentifier(event.applicationId, 256);
  } else {
    event.applicationId = null;
  }
  let normalized;
  try {
    normalized = normalizeSnapshot(normalizedShipment);
  } catch {
    throw inputError();
  }
  if (normalized.snapshot.shipmentId !== event.shipmentId) throw inputError();
  let receivedAt;
  try {
    receivedAt = timestamp(event.receivedAt);
  } catch {
    throw inputError();
  }
  return { event, normalized, receivedAt, dryRunEnabled };
}

function readClock(now) {
  let value;
  try {
    value = Reflect.apply(now, undefined, []);
  } catch {
    throw inputError();
  }
  if (value === null || typeof value !== 'object' || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Date.prototype) throw inputError();
  const milliseconds = Date.prototype.getTime.call(value);
  if (!Number.isFinite(milliseconds)) throw inputError();
  return new Date(milliseconds);
}

function readClaimClock(now) {
  try {
    return readClock(now);
  } catch {
    throw claimError();
  }
}

function readReleaseTime(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) throw inputError();
  try {
    if (Object.getPrototypeOf(value) !== Date.prototype) throw inputError();
    const milliseconds = Date.prototype.getTime.call(value);
    if (!Number.isFinite(milliseconds)) throw inputError();
    const canonical = new Date(milliseconds).toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(canonical)) throw inputError();
    return new Date(milliseconds);
  } catch (error) {
    if (SAFE_ERRORS.has(error)) throw error;
    throw inputError();
  }
}

function validateJobIdAndVersion(jobId, expectedVersion) {
  if (!Number.isSafeInteger(jobId) || jobId < 1
      || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0
      || expectedVersion >= Number.MAX_SAFE_INTEGER) throw inputError();
  return { jobId, expectedVersion, encodedJobId: encodePositiveLong(jobId) };
}

function validatePreparedRequestInput(requestJson, requestHash) {
  if (typeof requestJson !== 'string' || typeof requestHash !== 'string'
      || !SHA256_PATTERN.test(requestHash)
      || createHash('sha256').update(requestJson, 'utf8').digest('hex') !== requestHash) {
    throw inputError();
  }
  try {
    JSON.parse(requestJson);
  } catch {
    throw inputError();
  }
  return { requestJson, requestHash };
}

function validateHeldRequestCorrection(previousJson, correctedJson, documentNumber) {
  let previous;
  let corrected;
  try {
    previous = JSON.parse(previousJson);
    corrected = JSON.parse(correctedJson);
  } catch {
    throw inputError();
  }
  if (!Array.isArray(previous) || !Array.isArray(corrected) || previous.length === 0
      || previous.length !== corrected.length) throw inputError();
  for (let index = 0; index < previous.length; index += 1) {
    const before = previous[index];
    const after = corrected[index];
    if (!isPlainOwnDataRecord(before) || !isPlainOwnDataRecord(after)) throw inputError();
    const beforeKeys = Reflect.ownKeys(before);
    const afterKeys = Reflect.ownKeys(after);
    if (beforeKeys.length !== afterKeys.length
        || beforeKeys.some((key, keyIndex) => key !== afterKeys[keyIndex])
        || after.TRAN_DOC_NO !== documentNumber
        || after.INV_CUSTOMER_PAID_AMOUNT !== '0.00'
        || after.INV_CUSTOMER_AMOUNT_DUE !== after.INV_TOTAL_AMOUNT) throw inputError();
    for (const key of beforeKeys) {
      if (!['INV_CUSTOMER_PAID_AMOUNT', 'INV_CUSTOMER_AMOUNT_DUE'].includes(key)
          && !sameStoredValue(before[key], after[key])) throw inputError();
    }
  }
}

function isPlainOwnDataRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    return false;
  }
  try {
    return Object.getPrototypeOf(value) === Object.prototype
      && Reflect.ownKeys(value).every(key => typeof key === 'string'
        && Object.prototype.hasOwnProperty.call(
          Object.getOwnPropertyDescriptor(value, key) || {}, 'value',
        ));
  } catch {
    return false;
  }
}

function prepareResponseEvidence(value) {
  const input = readRequiredOwnDataInput(value, [
    'attemptNumber', 'httpStatus', 'responseJson', 'responseByteCount',
    'responseSha256', 'oeisInvoiceNumber',
  ]).snapshot;
  if (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1
      || input.httpStatus < 200 || input.httpStatus > 299
      || typeof input.responseJson !== 'string'
      || !Number.isSafeInteger(input.responseByteCount) || input.responseByteCount < 2
      || input.responseByteCount > 2_097_152
      || Buffer.byteLength(input.responseJson, 'utf8') !== input.responseByteCount
      || typeof input.responseSha256 !== 'string' || !SHA256_PATTERN.test(input.responseSha256)
      || createHash('sha256').update(input.responseJson, 'utf8').digest('hex') !== input.responseSha256
      || !isPrintableIdentifier(input.oeisInvoiceNumber, 512)) throw inputError();
  try {
    if (!isPlainOwnDataRecord(JSON.parse(input.responseJson))) throw inputError();
  } catch (error) {
    if (SAFE_ERRORS.has(error)) throw error;
    throw inputError();
  }
  return input;
}

function validateSafeErrorInput(errorCode, safeMessage) {
  if (typeof errorCode !== 'string' || !SAFE_CODE_PATTERN.test(errorCode)
      || typeof safeMessage !== 'string' || safeMessage.trim() === ''
      || Buffer.byteLength(safeMessage, 'utf8') > 1_024
      || /[\u0000-\u001F\u007F-\u009F]/.test(safeMessage)) throw inputError();
  return { errorCode, safeMessage };
}

function validateRetryInput(value) {
  const retry = readOwnInput(value, ['errorCode', 'safeMessage', 'nextAttemptAt']);
  validateSafeErrorInput(retry.errorCode, retry.safeMessage);
  try {
    retry.nextAttemptAt = encodeDate(retry.nextAttemptAt);
  } catch {
    throw inputError();
  }
  return retry;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function clonePlainData(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value) && !types.isProxy(value)
      && Object.getPrototypeOf(value) === Array.prototype) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const clone = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw inputError();
      clone.push(clonePlainData(descriptor.value));
    }
    return clone;
  }
  if (value === null || typeof value !== 'object' || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw inputError();
  const clone = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw inputError();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw inputError();
    clone[key] = clonePlainData(descriptor.value);
  }
  return clone;
}

function encodeAuditEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event) || types.isProxy(event)) {
    throw inputError();
  }
  let values;
  try {
    if (Object.getPrototypeOf(event) !== Object.prototype
        || Reflect.ownKeys(event).length !== EVENT_FIELDS.length) throw inputError();
    values = {};
    for (const field of EVENT_FIELDS) {
      const descriptor = Object.getOwnPropertyDescriptor(event, field);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw inputError();
      values[field] = descriptor.value;
    }
  } catch (error) {
    if (SAFE_ERRORS.has(error)) throw error;
    throw inputError();
  }
  if (typeof values.eventKey !== 'string' || !/^v1\.[A-Za-z0-9_-]{43}$/.test(values.eventKey)
      || !(values.operationKey === null
        || (typeof values.operationKey === 'string'
          && /^v1\.[A-Za-z0-9_-]{43}$/.test(values.operationKey)))
      || typeof values.companyId !== 'string' || typeof values.shipmentId !== 'string'
      || !(values.applicationId === null || typeof values.applicationId === 'string')
      || !(values.documentNumber === null || typeof values.documentNumber === 'string')
      || typeof values.stage !== 'string' || typeof values.action !== 'string'
      || typeof values.outcome !== 'string'
      || !Number.isSafeInteger(values.attemptNumber) || values.attemptNumber < 0
      || !(values.durationMs === null
        || (Number.isSafeInteger(values.durationMs) && values.durationMs >= 0))
      || !(values.queueDelayMs === null
        || (Number.isSafeInteger(values.queueDelayMs) && values.queueDelayMs >= 0))
      || !(values.retryDelayMs === null
        || (Number.isSafeInteger(values.retryDelayMs) && values.retryDelayMs >= 0))
      || !(values.safeCode === null || typeof values.safeCode === 'string')) throw inputError();
  const encoded = {
    eventKey: values.eventKey,
    operationKey: values.operationKey,
    companyId: values.companyId,
    applicationId: values.applicationId,
    shipmentId: values.shipmentId,
    jobId: encodeNullablePositiveLong(values.jobId),
    documentNumber: values.documentNumber,
    stage: values.stage,
    action: values.action,
    outcome: values.outcome,
    attemptNumber: values.attemptNumber,
    startedAt: encodeNullableDate(values.startedAt),
    completedAt: encodeNullableDate(values.completedAt),
    durationMs: values.durationMs,
    queueDelayMs: values.queueDelayMs,
    retryDelayMs: values.retryDelayMs,
    nextAttemptAt: encodeNullableDate(values.nextAttemptAt),
    safeCode: values.safeCode,
    requestSummary: values.requestSummary === null ? null : clonePlainData(values.requestSummary),
    responseSummary: values.responseSummary === null ? null : clonePlainData(values.responseSummary),
    artifactJobId: encodeNullablePositiveLong(values.artifactJobId),
    occurredAt: encodeDate(values.occurredAt),
    expiresAt: encodeDate(values.expiresAt),
  };
  decodeAuditEvent(encoded);
  return encoded;
}

function decodeStoredPositiveLong(value) {
  try {
    return decodePositiveLong(value);
  } catch {
    throw dataError();
  }
}

function decodeStoredNonnegativeLong(value) {
  try {
    return decodeNonnegativeLong(value);
  } catch {
    throw dataError();
  }
}

function decodeStoredNullablePositiveLong(value) {
  try {
    return decodeNullablePositiveLong(value);
  } catch {
    throw dataError();
  }
}

function decodeStoredDate(value) {
  try {
    return decodeDate(value);
  } catch {
    throw dataError();
  }
}

function decodeStoredNullableDate(value) {
  try {
    return decodeNullableDate(value);
  } catch {
    throw dataError();
  }
}

function parseStoredJson(value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw dataError();
  try {
    return deepFreeze(JSON.parse(value));
  } catch {
    throw dataError();
  }
}

function dataDocument(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    throw dataError();
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw dataError();
    const allowed = new Set(['_id', ...fields]);
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.has(key))) {
      throw dataError();
    }
    const snapshot = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw dataError();
      snapshot[field] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (SAFE_ERRORS.has(error)) throw error;
    throw dataError();
  }
}

function storedSubdocument(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    throw dataError();
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw dataError();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length
        || keys.some(key => typeof key !== 'string' || !fields.includes(key))) throw dataError();
    const snapshot = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw dataError();
      }
      snapshot[field] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (SAFE_ERRORS.has(error)) throw error;
    throw dataError();
  }
}

function cloneStoredData(value) {
  try {
    return clonePlainData(value);
  } catch {
    throw dataError();
  }
}

function isPrintableIdentifier(value, maximumBytes) {
  return typeof value === 'string' && value.trim() !== ''
    && Buffer.byteLength(value, 'utf8') <= maximumBytes
    && !/[\u0000-\u001F\u007F-\u009F]/.test(value);
}

function projectAuditIdentifier(value) {
  return typeof value === 'string' && /^[\x20-\x7e]+$/.test(value) && /[!-~]/.test(value)
    && Buffer.byteLength(value, 'utf8') <= 512 ? value : null;
}

function projectAuditUuid(value) {
  const projected = projectAuditIdentifier(value);
  return projected !== null && AUDIT_UUID_PATTERN.test(projected) ? projected : null;
}

function sameStructuredValue(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameStructuredValue(value, right[index]));
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key)
      && sameStructuredValue(left[key], right[key]));
}

function isClockInsensitiveWebhookScopeEvent(event) {
  if (event.attemptNumber !== 0) return false;
  if (event.stage === 'WEBHOOK' && WEBHOOK_SCOPE_ACTIONS.has(event.action)) return true;
  return event.stage === 'VALIDATION' && WEBHOOK_SCOPE_VALIDATION_ACTIONS.has(event.action)
    && event.jobId === null && event.documentNumber === null;
}

function expectedSummaryPlacement(action, outcome) {
  if (action === 'FYND_LOCK_REQUESTED') return ['requestSummary', 'FYND', 'REQUEST', 'LOCK'];
  if (action === 'FYND_LOCK_CONFIRMED' || action === 'FYND_LOCK_FAILED') {
    return ['responseSummary', 'FYND', 'RESPONSE', 'LOCK'];
  }
  if (action === 'FYND_LOCK_READBACK') {
    return [outcome === 'STARTED' ? 'requestSummary' : 'responseSummary', 'FYND',
      outcome === 'STARTED' ? 'REQUEST' : 'RESPONSE', 'LOCK_READBACK'];
  }
  if (action === 'FYND_TRANSITION_REQUESTED') {
    return ['requestSummary', 'FYND', 'REQUEST', 'TRANSITION'];
  }
  if (action === 'FYND_TRANSITION_CONFIRMED' || action === 'FYND_TRANSITION_FAILED') {
    return ['responseSummary', 'FYND', 'RESPONSE', 'TRANSITION'];
  }
  if (action === 'FYND_TRANSITION_READBACK') {
    return [outcome === 'STARTED' ? 'requestSummary' : 'responseSummary', 'FYND',
      outcome === 'STARTED' ? 'REQUEST' : 'RESPONSE', 'TRANSITION_READBACK'];
  }
  if (action === 'OEIS_SUBMISSION_REQUESTED') return ['requestSummary', 'OEIS', 'REQUEST'];
  if (action === 'OEIS_RESPONSE_RECEIVED' || action === 'OEIS_SUBMISSION_FAILED') {
    return ['responseSummary', 'OEIS', 'RESPONSE'];
  }
  if (action === 'OEIS_ARTIFACT_STORED') return ['responseSummary', 'OEIS', 'ARTIFACT'];
  return null;
}

function validateStoredAuditSummaries(mapped) {
  const placement = expectedSummaryPlacement(mapped.action, mapped.outcome);
  if (placement === null) {
    if (mapped.requestSummary !== null || mapped.responseSummary !== null) throw dataError();
    return;
  }
  const [slot, family, kind, operation] = placement;
  const otherSlot = slot === 'requestSummary' ? 'responseSummary' : 'requestSummary';
  const summary = mapped[slot];
  if (summary === null || mapped[otherSlot] !== null || summary.kind !== `${family}_${kind}`) {
    throw dataError();
  }
  const input = {};
  for (const [key, value] of Object.entries(summary)) {
    if (key !== 'kind') input[key] = value;
  }
  let sanitized;
  try {
    sanitized = family === 'FYND'
      ? sanitizeFyndSummary(kind, input)
      : sanitizeOeisSummary(kind, input);
  } catch {
    throw dataError();
  }
  if (!sameStructuredValue(summary, sanitized)
      || (operation !== undefined && summary.operation !== operation)
      || ((kind === 'RESPONSE') && summary.latencyMs !== mapped.durationMs)) throw dataError();
  if (family === 'FYND'
      && (summary.shipmentId !== mapped.shipmentId
        || summary.documentNumber !== mapped.documentNumber)) throw dataError();
  if (mapped.action === 'OEIS_SUBMISSION_REQUESTED'
      && (summary.documentNumber !== mapped.documentNumber
        || summary.attemptNumber !== mapped.attemptNumber)) throw dataError();
}

function decodeAuditEvent(document) {
  const row = dataDocument(document, EVENT_FIELDS);
  const mapped = {
    eventKey: row.eventKey,
    operationKey: row.operationKey,
    companyId: row.companyId,
    applicationId: row.applicationId,
    shipmentId: row.shipmentId,
    jobId: decodeStoredNullablePositiveLong(row.jobId),
    documentNumber: row.documentNumber,
    stage: row.stage,
    action: row.action,
    outcome: row.outcome,
    attemptNumber: row.attemptNumber,
    startedAt: decodeStoredNullableDate(row.startedAt),
    completedAt: decodeStoredNullableDate(row.completedAt),
    durationMs: row.durationMs,
    queueDelayMs: row.queueDelayMs,
    retryDelayMs: row.retryDelayMs,
    nextAttemptAt: decodeStoredNullableDate(row.nextAttemptAt),
    safeCode: row.safeCode,
    requestSummary: row.requestSummary === null ? null : cloneStoredData(row.requestSummary),
    responseSummary: row.responseSummary === null ? null : cloneStoredData(row.responseSummary),
    artifactJobId: decodeStoredNullablePositiveLong(row.artifactJobId),
    occurredAt: decodeStoredDate(row.occurredAt),
    expiresAt: decodeStoredDate(row.expiresAt),
  };
  const allowedOutcomes = AUDIT_ACTION_OUTCOMES[mapped.action];
  if (!KEY_PATTERN.test(mapped.eventKey)
      || !(mapped.operationKey === null
        || (typeof mapped.operationKey === 'string' && KEY_PATTERN.test(mapped.operationKey)))
      || !isPrintableIdentifier(mapped.companyId, 512)
      || !(mapped.applicationId === null || isPrintableIdentifier(mapped.applicationId, 256))
      || !isPrintableIdentifier(mapped.shipmentId, 512)
      || !(mapped.documentNumber === null || isPrintableIdentifier(mapped.documentNumber, 512))
      || !AUDIT_STAGES.includes(mapped.stage)
      || !AUDIT_ACTIONS.includes(mapped.action)
      || AUDIT_ACTION_STAGES[mapped.action] !== mapped.stage
      || !AUDIT_OUTCOMES.includes(mapped.outcome)
      || !allowedOutcomes || !allowedOutcomes.includes(mapped.outcome)
      || !Number.isSafeInteger(mapped.attemptNumber) || mapped.attemptNumber < 0
      || mapped.startedAt === null
      || !(mapped.durationMs === null
        || (Number.isSafeInteger(mapped.durationMs) && mapped.durationMs >= 0))
      || !(mapped.queueDelayMs === null
        || (Number.isSafeInteger(mapped.queueDelayMs) && mapped.queueDelayMs >= 0))
      || !(mapped.retryDelayMs === null
        || (Number.isSafeInteger(mapped.retryDelayMs) && mapped.retryDelayMs >= 0))
      || !(mapped.safeCode === null
        || (typeof mapped.safeCode === 'string' && SAFE_CODE_PATTERN.test(mapped.safeCode)))) {
    throw dataError();
  }
  if (EXTERNAL_ACTIONS.has(mapped.action)) {
    let expectedEventKey;
    try {
      expectedEventKey = createEventKey({
        kind: 'OPERATION',
        operationKey: mapped.operationKey,
        stage: mapped.stage,
        action: mapped.action,
        outcome: mapped.outcome,
      });
    } catch {
      throw dataError();
    }
    if (mapped.operationKey === null || mapped.jobId === null || mapped.attemptNumber < 1
        || mapped.eventKey !== expectedEventKey) throw dataError();
  } else if (mapped.operationKey !== null) {
    throw dataError();
  }
  const isClaim = mapped.action === 'JOB_CLAIMED' || mapped.action === 'OUTBOX_CLAIMED';
  if ((isClaim && mapped.queueDelayMs === null) || (!isClaim && mapped.queueDelayMs !== null)) {
    throw dataError();
  }
  if (mapped.action === 'RETRY_SCHEDULED') {
    if (mapped.retryDelayMs === null || mapped.nextAttemptAt === null
        || Date.parse(mapped.nextAttemptAt) !== Date.parse(mapped.occurredAt) + mapped.retryDelayMs) {
      throw dataError();
    }
  } else if (mapped.retryDelayMs !== null || mapped.nextAttemptAt !== null) {
    throw dataError();
  }
  if (mapped.outcome === 'STARTED') {
    if (mapped.completedAt !== null || mapped.durationMs !== null) throw dataError();
  } else if (mapped.completedAt === null || mapped.durationMs === null
      || Date.parse(mapped.completedAt) - Date.parse(mapped.startedAt) !== mapped.durationMs) {
    throw dataError();
  }
  if (['FAILURE', 'TIMEOUT', 'INDETERMINATE'].includes(mapped.outcome)
      && mapped.safeCode === null) throw dataError();
  if (Date.parse(mapped.expiresAt) - Date.parse(mapped.occurredAt) !== AUDIT_RETENTION_MS) {
    throw dataError();
  }
  for (const summary of [mapped.requestSummary, mapped.responseSummary]) {
    if (summary !== null && (typeof summary !== 'object' || Array.isArray(summary)
        || Buffer.byteLength(JSON.stringify(summary), 'utf8') > AUDIT_SUMMARY_MAX_BYTES)) {
      throw dataError();
    }
  }
  validateStoredAuditSummaries(mapped);
  if (Buffer.byteLength(JSON.stringify(mapped), 'utf8') > AUDIT_EVENT_MAX_BYTES) throw dataError();
  return deepFreeze(mapped);
}

function decodePendingOperation(value) {
  if (value === null) return null;
  const row = storedSubdocument(value, PENDING_OPERATION_FIELDS);
  const mapped = {
    operationKey: row.operationKey,
    eventKey: row.eventKey,
    stage: row.stage,
    action: row.action,
    attemptNumber: row.attemptNumber,
    expectedParentVersion: row.expectedParentVersion,
    startedAt: decodeStoredDate(row.startedAt),
    targetKind: row.targetKind,
    targetId: decodeStoredPositiveLong(row.targetId),
  };
  let expectedEventKey;
  let expectedOperationKey;
  try {
    expectedOperationKey = createOperationKey({
      targetKind: mapped.targetKind,
      targetId: String(mapped.targetId),
      expectedParentVersion: mapped.expectedParentVersion,
      attemptNumber: mapped.attemptNumber,
      stage: mapped.stage,
      action: mapped.action,
    });
    expectedEventKey = createEventKey({
      kind: 'OPERATION',
      operationKey: mapped.operationKey,
      stage: mapped.stage,
      action: mapped.action,
      outcome: 'STARTED',
    });
  } catch {
    throw dataError();
  }
  if (!Number.isSafeInteger(mapped.expectedParentVersion) || mapped.expectedParentVersion < 0
      || mapped.expectedParentVersion >= Number.MAX_SAFE_INTEGER
      || !KEY_PATTERN.test(mapped.operationKey) || mapped.operationKey !== expectedOperationKey
      || mapped.eventKey !== expectedEventKey
      || !EXTERNAL_STAGES.has(mapped.stage) || !PENDING_OPERATION_ACTIONS.has(mapped.action)
      || AUDIT_ACTION_STAGES[mapped.action] !== mapped.stage
      || !AUDIT_ACTION_OUTCOMES[mapped.action].includes('STARTED')
      || !Number.isSafeInteger(mapped.attemptNumber) || mapped.attemptNumber < 1
      || !['JOB', 'OUTBOX'].includes(mapped.targetKind)
      || (mapped.action === 'FYND_TRANSITION_REQUESTED') !== (mapped.targetKind === 'OUTBOX')) {
    throw dataError();
  }
  return deepFreeze(mapped);
}

function mapAuditHead(document) {
  const row = readStoredHead(document);
  const mapped = {
    companyId: row.companyId,
    shipmentId: row.shipmentId,
    jobId: decodeStoredNullablePositiveLong(row.jobId),
    documentNumber: row.documentNumber,
    lastStage: row.lastStage,
    lastAction: row.lastAction,
    lastOutcome: row.lastOutcome,
    lastSafeCode: row.lastSafeCode,
    firstOccurredAt: decodeStoredDate(row.firstOccurredAt),
    lastOccurredAt: decodeStoredDate(row.lastOccurredAt),
    lastEventKey: row.lastEventKey,
    expiresAt: decodeStoredDate(row.expiresAt),
    version: row.version,
  };
  if (Date.parse(mapped.expiresAt) - Date.parse(mapped.lastOccurredAt) !== AUDIT_RETENTION_MS) {
    throw dataError();
  }
  return deepFreeze(mapped);
}

function mapJob(document) {
  if (document === null) return null;
  const row = dataDocument(document, JOB_DOCUMENT_FIELDS);
  const id = decodeStoredPositiveLong(row.jobId);
  if (!isPrintableIdentifier(row.companyId, 512)
      || !(row.applicationId === null || isPrintableIdentifier(row.applicationId, 256))
      || !isPrintableIdentifier(row.shipmentId, 512)
      || row.documentType !== 'IN'
      || !isPrintableIdentifier(row.documentNumber, 512)
      || !Object.values(JOB_STATES).includes(row.state)
      || !Number.isSafeInteger(row.attemptCount) || row.attemptCount < 0
      || !Number.isSafeInteger(row.version) || row.version < 0
      || !(row.oeisRequestJson === null || typeof row.oeisRequestJson === 'string')
      || !(row.requestHash === null || typeof row.requestHash === 'string')
      || !(row.leaseOwner === null || typeof row.leaseOwner === 'string')
      || !(row.lastErrorCode === null || typeof row.lastErrorCode === 'string')
      || !(row.lastErrorMessage === null || typeof row.lastErrorMessage === 'string')) throw dataError();
  const pendingOperation = decodePendingOperation(row.pendingOperation);
  if (pendingOperation !== null
      && (pendingOperation.targetKind !== 'JOB' || pendingOperation.targetId !== id
        || row.version <= pendingOperation.expectedParentVersion
        || row.attemptCount < pendingOperation.attemptNumber)) throw dataError();
  const shipmentSnapshot = parseStoredJson(row.shipmentSnapshotJson);
  const oeisRequest = parseStoredJson(row.oeisRequestJson);
  const mapped = {
    id,
    companyId: row.companyId,
    applicationId: row.applicationId,
    shipmentId: row.shipmentId,
    documentType: row.documentType,
    documentNumber: row.documentNumber,
    state: row.state,
    shipmentSnapshot,
    oeisRequestJson: row.oeisRequestJson,
    oeisRequest,
    requestHash: row.requestHash,
    attemptCount: row.attemptCount,
    nextAttemptAt: decodeStoredNullableDate(row.nextAttemptAt),
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: decodeStoredNullableDate(row.leaseExpiresAt),
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    lockedAt: decodeStoredNullableDate(row.lockedAt),
    version: row.version,
    createdAt: decodeStoredDate(row.createdAt),
    updatedAt: decodeStoredDate(row.updatedAt),
  };
  const dueAt = decodeStoredDate(row.dueAt);
  if (dueAt !== (mapped.nextAttemptAt ?? mapped.createdAt)) throw dataError();
  return deepFreeze(mapped);
}

function decodeJobRecord(document) {
  if (document === null) return null;
  const row = dataDocument(document, JOB_DOCUMENT_FIELDS);
  const job = mapJob(document);
  const pendingOperation = decodePendingOperation(row.pendingOperation);
  return { row, job, pendingOperation };
}

function decodeCanonicalBase64(value, makeError) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw makeError();
  }
  let bytes;
  try {
    bytes = Buffer.from(value, 'base64');
  } catch {
    throw makeError();
  }
  if (bytes.length === 0 || bytes.toString('base64') !== value) throw makeError();
  return bytes;
}

function decodeFatalUtf8(bytes, makeError) {
  let value;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw makeError();
  }
  if (value.length === 0 || value.includes('\u0000') || value.includes('\uFFFD')) throw makeError();
  return value;
}

function prepareArtifactInput(value, reference) {
  const artifactInput = readRequiredOwnDataInput(value, [
    'invoiceNumber', 'transactionNumber', 'uuid', 'invoiceCounter', 'matchingKey',
    'responseStatus', 'signedXmlBase64', 'signedXml', 'signedXmlSha256',
  ]);
  const referenceInput = readRequiredOwnDataInput(reference, ['shipmentId', 'documentNumber']);
  const artifact = artifactInput.snapshot;
  const outboxReference = referenceInput.snapshot;
  const qrDescriptor = artifactInput.descriptors.qrCodeData;
  artifact.qrCodeData = qrDescriptor === undefined ? null : qrDescriptor.value;
  for (const field of [
    'invoiceNumber', 'transactionNumber', 'uuid', 'invoiceCounter', 'matchingKey',
  ]) requireIdentifier(artifact[field]);
  requireIdentifier(outboxReference.shipmentId);
  requireIdentifier(outboxReference.documentNumber);
  if (artifact.invoiceNumber !== outboxReference.documentNumber
      || artifact.responseStatus !== 'OEIS_ACCEPTED_REPORTING_PENDING'
      || typeof artifact.signedXml !== 'string'
      || (artifact.qrCodeData !== null
        && (typeof artifact.qrCodeData !== 'string'
          || artifact.qrCodeData.trim() === ''
          || Buffer.byteLength(artifact.qrCodeData, 'utf8') > 4_096
          || /[\u0000-\u001F\u007F-\u009F]/.test(artifact.qrCodeData)))) {
    throw inputError();
  }
  const bytes = decodeCanonicalBase64(artifact.signedXmlBase64, inputError);
  const decoded = decodeFatalUtf8(bytes, inputError);
  if (decoded !== artifact.signedXml
      || typeof artifact.signedXmlSha256 !== 'string'
      || !SHA256_PATTERN.test(artifact.signedXmlSha256)
      || createHash('sha256').update(bytes).digest('hex') !== artifact.signedXmlSha256) {
    throw inputError();
  }
  return {
    artifact: {
      invoiceNumber: artifact.invoiceNumber,
      transactionNumber: artifact.transactionNumber,
      uuid: artifact.uuid,
      invoiceCounter: artifact.invoiceCounter,
      matchingKey: artifact.matchingKey,
      responseStatus: artifact.responseStatus,
      signedXmlBase64: artifact.signedXmlBase64,
      signedXmlSha256: artifact.signedXmlSha256,
      qrCodeData: artifact.qrCodeData,
    },
    signedXmlByteCount: bytes.length,
    reference: outboxReference,
  };
}

function mapArtifact(document) {
  if (document === null) return null;
  const row = dataDocument(document, ARTIFACT_DOCUMENT_FIELDS);
  const mapped = {
    jobId: decodeStoredPositiveLong(row.jobId),
    invoiceNumber: row.invoiceNumber,
    transactionNumber: row.transactionNumber,
    uuid: row.uuid,
    invoiceCounter: row.invoiceCounter,
    matchingKey: row.matchingKey,
    responseStatus: row.responseStatus,
    signedXmlBase64: row.signedXmlBase64,
    signedXmlSha256: row.signedXmlSha256,
    qrCodeData: row.qrCodeData,
    createdAt: decodeStoredDate(row.createdAt),
  };
  for (const field of [
    'invoiceNumber', 'transactionNumber', 'uuid', 'invoiceCounter', 'matchingKey',
  ]) {
    if (!isPrintableIdentifier(mapped[field], 512)) throw dataError();
  }
  if (mapped.responseStatus !== 'OEIS_ACCEPTED_REPORTING_PENDING'
      || !(mapped.qrCodeData === null
        || (typeof mapped.qrCodeData === 'string' && mapped.qrCodeData.trim() !== ''
          && Buffer.byteLength(mapped.qrCodeData, 'utf8') <= 4_096
          && !/[\u0000-\u001F\u007F-\u009F]/.test(mapped.qrCodeData)))
      || typeof mapped.signedXmlSha256 !== 'string'
      || !SHA256_PATTERN.test(mapped.signedXmlSha256)) throw dataError();
  const bytes = decodeCanonicalBase64(mapped.signedXmlBase64, dataError);
  decodeFatalUtf8(bytes, dataError);
  if (createHash('sha256').update(bytes).digest('hex') !== mapped.signedXmlSha256) {
    throw dataError();
  }
  return deepFreeze(mapped);
}

function parseStoredOutboxPayload(value) {
  if (typeof value !== 'string') throw dataError();
  let payload;
  try {
    payload = JSON.parse(value);
  } catch {
    throw dataError();
  }
  const hasOeisInvoiceNumber = Object.prototype.hasOwnProperty.call(
    payload, 'oeisInvoiceNumber',
  );
  const row = storedSubdocument(payload, hasOeisInvoiceNumber
    ? ['shipmentId', 'documentNumber', 'oeisInvoiceNumber']
    : ['shipmentId', 'documentNumber']);
  if (!isPrintableIdentifier(row.shipmentId, 512)
      || !isPrintableIdentifier(row.documentNumber, 512)
      || (hasOeisInvoiceNumber && !isPrintableIdentifier(row.oeisInvoiceNumber, 512))) {
    throw dataError();
  }
  return deepFreeze(hasOeisInvoiceNumber
    ? {
      shipmentId: row.shipmentId,
      documentNumber: row.documentNumber,
      oeisInvoiceNumber: row.oeisInvoiceNumber,
    }
    : { shipmentId: row.shipmentId, documentNumber: row.documentNumber });
}

function mapOutbox(document) {
  if (document === null) return null;
  const row = dataDocument(document, OUTBOX_DOCUMENT_FIELDS);
  const id = decodeStoredPositiveLong(row.outboxId);
  const jobId = decodeStoredPositiveLong(row.jobId);
  const payload = parseStoredOutboxPayload(row.payloadJson);
  const nextAttemptAt = decodeStoredNullableDate(row.nextAttemptAt);
  const leaseExpiresAt = decodeStoredNullableDate(row.leaseExpiresAt);
  const createdAt = decodeStoredDate(row.createdAt);
  const completedAt = decodeStoredNullableDate(row.completedAt);
  const dueAt = decodeStoredDate(row.dueAt);
  const pendingOperation = decodePendingOperation(row.pendingOperation);
  if (row.action !== OUTBOX_ACTIONS.FYND_TRANSITION
      || !Object.values(OUTBOX_STATUSES).includes(row.status)
      || !Object.values(JOB_STATES).includes(row.parentState)
      || !Number.isSafeInteger(row.attemptCount) || row.attemptCount < 0
      || !Number.isSafeInteger(row.version) || row.version < 0
      || !Number.isSafeInteger(row.parentVersion) || row.parentVersion < 0
      || !(row.leaseOwner === null
        || isPrintableIdentifier(row.leaseOwner, 512))
      || !(row.lastErrorCode === null
        || (typeof row.lastErrorCode === 'string' && SAFE_CODE_PATTERN.test(row.lastErrorCode)))
      || !(row.lastErrorMessage === null
        || isPrintableIdentifier(row.lastErrorMessage, 1_024))
      || dueAt !== (nextAttemptAt ?? createdAt)
      || (ACTIVE_OUTBOX_STATUSES.includes(row.status)
        && completedAt !== null)
      || (row.status === OUTBOX_STATUSES.COMPLETED
        && (row.parentState !== JOB_STATES.COMPLETED || nextAttemptAt !== null
          || completedAt === null || row.lastErrorCode !== null || row.lastErrorMessage !== null))
      || (row.status === OUTBOX_STATUSES.INDETERMINATE
        && (row.parentState !== JOB_STATES.INDETERMINATE || nextAttemptAt !== null
          || completedAt !== null || row.lastErrorCode === null || row.lastErrorMessage === null))
      || ([OUTBOX_STATUSES.COMPLETED, OUTBOX_STATUSES.INDETERMINATE].includes(row.status)
        && (row.leaseOwner !== null || leaseExpiresAt !== null || pendingOperation !== null))
      || (row.status === OUTBOX_STATUSES.PENDING
        && (nextAttemptAt === null || row.lastErrorCode !== null || row.lastErrorMessage !== null))
      || (row.status === OUTBOX_STATUSES.RETRY_WAIT
        && (nextAttemptAt === null || row.lastErrorCode === null || row.lastErrorMessage === null))
      || (pendingOperation !== null
        && (pendingOperation.targetKind !== 'OUTBOX' || pendingOperation.targetId !== id
          || pendingOperation.stage !== 'FYND_TRANSITION'
          || row.version <= pendingOperation.expectedParentVersion
          || row.attemptCount < pendingOperation.attemptNumber))) throw dataError();
  const mapped = {
    id,
    jobId,
    action: row.action,
    payloadJson: row.payloadJson,
    payload,
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt,
    lastErrorCode: row.lastErrorCode,
    lastErrorMessage: row.lastErrorMessage,
    version: row.version,
    createdAt,
    completedAt,
  };
  return deepFreeze(mapped);
}

function decodeOutboxRecord(document) {
  if (document === null) return null;
  const row = dataDocument(document, OUTBOX_DOCUMENT_FIELDS);
  return {
    row,
    outbox: mapOutbox(document),
    pendingOperation: decodePendingOperation(row.pendingOperation),
  };
}

function matchesOutboxParent(record, parentRecord, requirePending = true) {
  return record.outbox.jobId === parentRecord.job.id
    && record.row.parentVersion === parentRecord.job.version
    && record.row.parentState === parentRecord.job.state
    && record.outbox.payload.shipmentId === parentRecord.job.shipmentId
    && record.outbox.payload.documentNumber === parentRecord.job.documentNumber
    && (!requirePending || parentRecord.job.state === JOB_STATES.FYND_TRANSITION_PENDING);
}

function assertOutboxParent(record, parentRecord, requirePending = true) {
  if (!matchesOutboxParent(record, parentRecord, requirePending)) throw versionConflictError();
}

function assertStoredPreparedRequest(row) {
  if (typeof row.oeisRequestJson !== 'string'
      || typeof row.requestHash !== 'string' || !SHA256_PATTERN.test(row.requestHash)
      || createHash('sha256').update(row.oeisRequestJson, 'utf8').digest('hex') !== row.requestHash) {
    throw dataError();
  }
}

function assertLiveJobMutation(record, expectedVersion, allowedStates, capturedNow) {
  const { row, job } = record;
  if (job.version !== expectedVersion || !allowedStates.includes(job.state)
      || typeof row.leaseOwner !== 'string' || row.leaseOwner.trim() === ''
      || !(row.leaseExpiresAt instanceof Date)
      || row.leaseExpiresAt.getTime() <= capturedNow.getTime()) throw versionConflictError();
}

function buildInternalJobAudit(job, parentVersion, capturedNow, {
  stage,
  action,
  outcome,
  queueDelayMs = null,
}) {
  try {
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
    return encodeAuditEvent(createAuditEvent({
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
      retryDelayMs: null,
      safeCode: null,
      requestSummary: null,
      responseSummary: null,
      artifactJobId: null,
    }, { now: () => new Date(capturedNow) }));
  } catch (error) {
    if (SAFE_ERRORS.has(error)) throw error;
    throw dataError();
  }
}

function buildInternalOutboxAudit(outbox, parent, parentVersion, capturedNow, {
  stage,
  action,
  outcome,
  queueDelayMs = null,
}) {
  try {
    const eventKey = createEventKey({
      kind: 'ENTITY',
      companyId: parent.companyId,
      shipmentId: parent.shipmentId,
      scopeKind: 'OUTBOX',
      scopeId: String(outbox.id),
      parentVersion,
      attemptNumber: outbox.attemptCount,
      stage,
      action,
      outcome,
    });
    return encodeAuditEvent(createAuditEvent({
      eventKey,
      operationKey: null,
      companyId: parent.companyId,
      applicationId: parent.applicationId,
      shipmentId: parent.shipmentId,
      jobId: parent.id,
      documentNumber: parent.documentNumber,
      stage,
      action,
      outcome,
      attemptNumber: outbox.attemptCount,
      startedAt: null,
      completedAt: null,
      queueDelayMs,
      retryDelayMs: null,
      safeCode: null,
      requestSummary: null,
      responseSummary: null,
      artifactJobId: null,
    }, { now: () => new Date(capturedNow) }));
  } catch (error) {
    if (SAFE_ERRORS.has(error)) throw error;
    throw dataError();
  }
}

function encodeMutationAuditArray(events) {
  if (!Array.isArray(events) || types.isProxy(events)
      || Object.getPrototypeOf(events) !== Array.prototype) throw inputError();
  const descriptors = Object.getOwnPropertyDescriptors(events);
  if (Reflect.ownKeys(descriptors).some(key => key !== 'length'
      && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)))) throw inputError();
  const encoded = [];
  const eventKeys = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw inputError();
    let event;
    try {
      event = encodeAuditEvent(descriptor.value);
    } catch {
      throw inputError();
    }
    if (eventKeys.has(event.eventKey)) throw inputError();
    eventKeys.add(event.eventKey);
    encoded.push(event);
  }
  for (const readbackAction of ['FYND_LOCK_READBACK', 'FYND_TRANSITION_READBACK']) {
    const readbacks = encoded.map((event, index) => ({ event, index })).filter(
      entry => entry.event.action === readbackAction,
    );
    if (readbacks.length !== 0
        && (readbacks.length !== 2
          || readbacks[0].event.outcome !== 'STARTED'
          || readbacks[1].event.outcome === 'STARTED'
          || readbacks[0].index >= readbacks[1].index
          || readbacks[0].event.operationKey !== readbacks[1].event.operationKey)) {
      throw inputError();
    }
  }
  const startedIntents = encoded.filter(event => (
    PENDING_OPERATION_ACTIONS.has(event.action) && event.outcome === 'STARTED'
  ));
  if (startedIntents.length !== 0) throw inputError();
  return encoded;
}

function provesLocked(event) {
  const summary = event.responseSummary;
  return event.outcome === 'SUCCESS' && summary !== null
    && summary.locked === true
    && summary.finalStateClassification === 'LOCKED'
    && summary.retryable === false;
}

function validateLockedMutationEvidence(terminal, readbacks, events) {
  if (readbacks.length !== 0) {
    const terminalIndex = events.indexOf(terminal);
    const readbackStartedIndex = events.indexOf(readbacks[0]);
    const readbackTerminalIndex = events.indexOf(readbacks[1]);
    if (readbacks.length !== 2
        || readbackStartedIndex >= readbackTerminalIndex
        || readbackTerminalIndex >= terminalIndex
        || readbacks[0].startedAt.getTime() <= terminal.completedAt.getTime()
        || readbacks[1].completedAt.getTime() <= readbacks[0].startedAt.getTime()
        || readbacks[0].occurredAt.getTime() !== terminal.occurredAt.getTime()
        || readbacks[1].occurredAt.getTime() !== terminal.occurredAt.getTime()) {
      throw inputError();
    }
  }
  if (terminal.action === 'FYND_LOCK_CONFIRMED') {
    if (!provesLocked(terminal)
        || (readbacks.length !== 0 && !provesLocked(readbacks[1]))) throw inputError();
    return;
  }
  if (terminal.action === 'FYND_LOCK_FAILED') {
    if (readbacks.length !== 2 || !provesLocked(readbacks[1])) throw inputError();
    return;
  }
  throw inputError();
}

function validateMutationAuditBundle(events, record, expectedVersion, {
  allowedLocalActions,
  retry = null,
  terminalCode = null,
  lockTargetState = null,
}) {
  const { job, pendingOperation } = record;
  const encodedJobId = encodePositiveLong(job.id);
  for (const event of events) {
    if (event.companyId !== job.companyId || event.applicationId !== job.applicationId
        || event.shipmentId !== job.shipmentId
        || !sameStoredValue(event.jobId, encodedJobId)
        || event.documentNumber !== job.documentNumber) throw inputError();
  }

  const readbacks = events.filter(event => event.action === 'FYND_LOCK_READBACK');
  if (readbacks.length !== 0) {
    let expectedOperationKey;
    try {
      expectedOperationKey = createOperationKey({
        targetKind: 'JOB',
        targetId: String(job.id),
        expectedParentVersion: expectedVersion,
        attemptNumber: job.attemptCount,
        stage: 'FYND_LOCK',
        action: 'FYND_LOCK_READBACK',
      });
    } catch {
      throw inputError();
    }
    if (readbacks.some(event => event.operationKey !== expectedOperationKey
        || event.attemptNumber !== job.attemptCount)
        || readbacks[1].startedAt.getTime() !== readbacks[0].startedAt.getTime()) {
      throw inputError();
    }
  }

  const terminals = events.filter(event => JOB_EXTERNAL_TERMINAL_ACTIONS.has(event.action));
  for (const event of events) {
    if (event.operationKey === null) {
      if (!allowedLocalActions.includes(event.action)) throw inputError();
      if (event.action === 'RETRY_SCHEDULED'
          && (retry === null || event.safeCode !== retry.errorCode
            || event.nextAttemptAt.getTime() !== retry.nextAttemptAt.getTime())) throw inputError();
      if (terminalCode !== null && event.safeCode !== terminalCode) throw inputError();
      if (event.action === 'OEIS_SUBMISSION_HELD'
          && lockTargetState !== JOB_STATES.SUBMISSION_HELD) throw inputError();
      let expectedEventKey;
      try {
        expectedEventKey = createEventKey({
          kind: 'ENTITY',
          companyId: job.companyId,
          shipmentId: job.shipmentId,
          scopeKind: 'JOB',
          scopeId: String(job.id),
          parentVersion: expectedVersion,
          attemptNumber: job.attemptCount,
          stage: event.stage,
          action: event.action,
          outcome: event.outcome,
        });
      } catch {
        throw inputError();
      }
      if (event.eventKey !== expectedEventKey || event.attemptNumber !== job.attemptCount) {
        throw inputError();
      }
    } else if (!JOB_EXTERNAL_TERMINAL_ACTIONS.has(event.action)
        && event.action !== 'FYND_LOCK_READBACK') throw inputError();
  }

  if (pendingOperation === null) {
    if (terminals.length !== 0) throw versionConflictError();
    if (readbacks.length !== 0) throw inputError();
    if (lockTargetState !== null && events.length !== 0) throw inputError();
    return false;
  }
  if (events.length === 0) throw versionConflictError();
  if (terminals.length !== 1) throw inputError();
  const terminal = terminals[0];
  const allowedActions = JOB_TERMINAL_OUTCOME_ACTIONS[pendingOperation.action] || [];
  if (terminal.operationKey !== pendingOperation.operationKey
      || terminal.stage !== pendingOperation.stage
      || !allowedActions.includes(terminal.action)
      || terminal.attemptNumber !== pendingOperation.attemptNumber
      || terminal.startedAt.getTime() !== Date.parse(pendingOperation.startedAt)
      || terminal.eventKey === pendingOperation.eventKey) throw versionConflictError();
  if (readbacks.length !== 0 && pendingOperation.stage !== 'FYND_LOCK') throw inputError();
  if (lockTargetState !== null) validateLockedMutationEvidence(terminal, readbacks, events);
  return true;
}

function validateArtifactAuditEvent(event, job, expectedVersion, artifact, signedXmlByteCount) {
  let expectedEventKey;
  try {
    expectedEventKey = createEventKey({
      kind: 'ENTITY',
      companyId: job.companyId,
      shipmentId: job.shipmentId,
      scopeKind: 'JOB',
      scopeId: String(job.id),
      parentVersion: expectedVersion,
      attemptNumber: job.attemptCount,
      stage: 'OEIS_ARTIFACT',
      action: 'OEIS_ARTIFACT_STORED',
      outcome: 'SUCCESS',
    });
  } catch {
    throw inputError();
  }
  const summary = event.responseSummary;
  const qrByteCount = artifact.qrCodeData === null
    ? null
    : Buffer.byteLength(artifact.qrCodeData, 'utf8');
  const qrSha256 = artifact.qrCodeData === null
    ? null
    : createHash('sha256').update(artifact.qrCodeData, 'utf8').digest('hex');
  if (event.eventKey !== expectedEventKey || event.operationKey !== null
      || event.stage !== 'OEIS_ARTIFACT' || event.action !== 'OEIS_ARTIFACT_STORED'
      || event.outcome !== 'SUCCESS' || event.attemptNumber !== job.attemptCount
      || event.safeCode !== null
      || !sameStoredValue(event.artifactJobId, encodePositiveLong(job.id))
      || summary === null || summary.signedXmlPresent !== true
      || summary.signedXmlByteCount !== signedXmlByteCount
      || summary.signedXmlSha256 !== artifact.signedXmlSha256
      || summary.qrPresent !== (artifact.qrCodeData !== null)
      || summary.qrByteCount !== qrByteCount || summary.qrSha256 !== qrSha256) throw inputError();
}

function validateEnqueueAuditBundle(events, record, expectedVersion, preparedArtifact) {
  const { job, pendingOperation } = record;
  const encodedJobId = encodePositiveLong(job.id);
  for (const event of events) {
    if (event.companyId !== job.companyId || event.applicationId !== job.applicationId
        || event.shipmentId !== job.shipmentId
        || !sameStoredValue(event.jobId, encodedJobId)
        || event.documentNumber !== job.documentNumber) throw inputError();
  }
  const artifacts = events.filter(event => event.action === 'OEIS_ARTIFACT_STORED');
  const terminals = events.filter(event => (
    ['OEIS_RESPONSE_RECEIVED', 'OEIS_SUBMISSION_FAILED'].includes(event.action)
  ));
  if (artifacts.length > 1 || terminals.length > 1
      || events.some(event => !artifacts.includes(event) && !terminals.includes(event))) {
    throw inputError();
  }
  if (artifacts.length === 1) {
    validateArtifactAuditEvent(
      artifacts[0],
      job,
      expectedVersion,
      preparedArtifact.artifact,
      preparedArtifact.signedXmlByteCount,
    );
  }
  if (pendingOperation === null) {
    if (terminals.length !== 0) throw versionConflictError();
    if (events.length !== 0) throw inputError();
    return false;
  }
  if (events.length === 0) throw versionConflictError();
  if (terminals.length !== 1 || artifacts.length !== 1) throw inputError();
  const terminal = terminals[0];
  if (terminal.operationKey !== pendingOperation.operationKey
      || terminal.stage !== pendingOperation.stage
      || terminal.action !== 'OEIS_RESPONSE_RECEIVED'
      || terminal.outcome !== 'SUCCESS'
      || terminal.attemptNumber !== pendingOperation.attemptNumber
      || terminal.startedAt.getTime() !== Date.parse(pendingOperation.startedAt)
      || terminal.eventKey === pendingOperation.eventKey) throw versionConflictError();
  const summary = terminal.responseSummary;
  if (terminal.safeCode !== null || terminal.artifactJobId !== null
      || summary === null || !Number.isSafeInteger(summary.httpStatus)
      || summary.httpStatus < 200 || summary.httpStatus > 299
      || summary.isSystemException !== false
      || summary.validationResult !== 'VALID'
      || summary.reportingStatus !== 'PENDING'
      || summary.clearanceStatus !== null
      || !Array.isArray(summary.validationCodes) || summary.validationCodes.length !== 0
      || summary.responseByteCount !== null || summary.responseSha256 !== null
      || summary.invoiceNumber !== projectAuditIdentifier(preparedArtifact.artifact.invoiceNumber)
      || summary.transactionNumber !== projectAuditIdentifier(
        preparedArtifact.artifact.transactionNumber,
      )
      || summary.uuid !== projectAuditUuid(preparedArtifact.artifact.uuid)
      || summary.invoiceCounter !== projectAuditIdentifier(preparedArtifact.artifact.invoiceCounter)
      || summary.matchingKey !== projectAuditIdentifier(preparedArtifact.artifact.matchingKey)
      || summary.retryable !== false
      || events.indexOf(terminal) >= events.indexOf(artifacts[0])
      || terminal.completedAt.getTime() > artifacts[0].occurredAt.getTime()
      || artifacts[0].occurredAt.getTime() < terminal.occurredAt.getTime()) throw inputError();
  return true;
}

function provesTransitionComplete(event) {
  const summary = event.responseSummary;
  return event.outcome === 'SUCCESS' && event.safeCode === null && summary !== null
    && summary.responseStatus === null
    && summary.finalStateClassification === 'INVOICED'
    && summary.shipmentState === 'bag_invoiced'
    && summary.retryable === false;
}

function provesTransitionReadbackComplete(event) {
  return provesTransitionComplete(event) && event.responseSummary.locked === false;
}

function provesDirectTransitionComplete(event) {
  return provesTransitionComplete(event)
    && event.responseSummary.locked === null;
}

function provesTransitionUnchanged(event) {
  const summary = event.responseSummary;
  return event.outcome === 'SUCCESS' && event.safeCode === null && summary !== null
    && summary.locked === true
    && summary.responseStatus === null
    && summary.shipmentState === 'bag_confirmed'
    && summary.finalStateClassification === 'UNCHANGED'
    && summary.retryable === false;
}

function provesTransitionIndeterminate(event) {
  const summary = event.responseSummary;
  if (summary === null || summary.retryable !== false) return false;
  if (summary.finalStateClassification === 'CONFLICTING') {
    return event.outcome === 'SUCCESS' && event.safeCode === null
      && summary.responseStatus === null
      && summary.locked === null
      && summary.shipmentState === null;
  }
  return summary.finalStateClassification === 'UNREADABLE'
    && ['FAILURE', 'TIMEOUT', 'INDETERMINATE'].includes(event.outcome)
    && summary.locked === null
    && summary.shipmentState === null
    && summary.responseStatus === (
      event.outcome === 'FAILURE' && event.safeCode === 'FYND_HTTP_429' ? 429 : null
    );
}

function hasDirectTransitionFailureShape(event) {
  const summary = event.responseSummary;
  return summary !== null
    && summary.locked === null
    && summary.shipmentState === null
    && summary.responseStatus === (
      event.outcome === 'FAILURE' && event.safeCode === 'FYND_HTTP_429' ? 429 : null
    );
}

function provesRetryableTransitionFailure(event) {
  const summary = event.responseSummary;
  return hasDirectTransitionFailureShape(event) && summary.retryable === true && (
    (event.outcome === 'FAILURE' && summary.finalStateClassification === 'REJECTED')
    || (event.outcome === 'TIMEOUT' && summary.finalStateClassification === 'UNKNOWN')
  );
}

function provesNonretryableTransitionFailure(event) {
  const summary = event.responseSummary;
  return hasDirectTransitionFailureShape(event) && summary.retryable === false && (
    (event.outcome === 'FAILURE' && summary.finalStateClassification === 'REJECTED')
    || (event.outcome === 'INDETERMINATE'
      && summary.finalStateClassification === 'UNKNOWN')
  );
}

function validateOutboxMutationAuditBundle(events, record, parent, expectedVersion, {
  kind,
  retry = null,
  terminalCode = null,
}) {
  const { outbox, pendingOperation } = record;
  const encodedJobId = encodePositiveLong(parent.id);
  for (const event of events) {
    if (event.companyId !== parent.companyId || event.applicationId !== parent.applicationId
        || event.shipmentId !== parent.shipmentId
        || !sameStoredValue(event.jobId, encodedJobId)
        || event.documentNumber !== parent.documentNumber) throw inputError();
  }
  const readbacks = events.filter(event => event.action === 'FYND_TRANSITION_READBACK');
  const terminals = events.filter(event => OUTBOX_TERMINAL_OUTCOME_ACTIONS.includes(event.action));
  const allowedLocalActions = OUTBOX_LOCAL_ACTIONS[kind] || [];
  const localEvents = events.filter(event => event.operationKey === null);
  for (const event of events) {
    if (event.operationKey === null) {
      if (!allowedLocalActions.includes(event.action)) throw inputError();
      let expectedEventKey;
      try {
        expectedEventKey = createEventKey({
          kind: 'ENTITY',
          companyId: parent.companyId,
          shipmentId: parent.shipmentId,
          scopeKind: 'OUTBOX',
          scopeId: String(outbox.id),
          parentVersion: expectedVersion,
          attemptNumber: outbox.attemptCount,
          stage: event.stage,
          action: event.action,
          outcome: event.outcome,
        });
      } catch {
        throw inputError();
      }
      if (event.eventKey !== expectedEventKey
          || event.attemptNumber !== outbox.attemptCount
          || event.artifactJobId !== null) throw inputError();
      if (event.action === 'RETRY_SCHEDULED'
          && (retry === null || event.safeCode !== retry.errorCode
            || event.nextAttemptAt.getTime() !== retry.nextAttemptAt.getTime())) throw inputError();
      if (terminalCode !== null && event.safeCode !== terminalCode) throw inputError();
      if (kind === 'COMPLETED' && event.safeCode !== null) throw inputError();
    } else if (!OUTBOX_TERMINAL_OUTCOME_ACTIONS.includes(event.action)
        && event.action !== 'FYND_TRANSITION_READBACK') throw inputError();
  }
  if (readbacks.length !== 0) {
    let expectedOperationKey;
    try {
      expectedOperationKey = createOperationKey({
        targetKind: 'OUTBOX',
        targetId: String(outbox.id),
        expectedParentVersion: expectedVersion,
        attemptNumber: outbox.attemptCount,
        stage: 'FYND_TRANSITION',
        action: 'FYND_TRANSITION_READBACK',
      });
    } catch {
      throw inputError();
    }
    if (readbacks.length !== 2
        || readbacks.some(event => event.operationKey !== expectedOperationKey
          || event.attemptNumber !== outbox.attemptCount
          || !sameStoredValue(event.artifactJobId, encodedJobId))
        || readbacks[0].outcome !== 'STARTED' || readbacks[0].safeCode !== null
        || readbacks[1].outcome === 'STARTED'
        || (readbacks[1].outcome === 'SUCCESS' && readbacks[1].safeCode !== null)
        || readbacks[1].startedAt.getTime() !== readbacks[0].startedAt.getTime()) {
      throw inputError();
    }
  }
  if (pendingOperation === null) {
    if (terminals.length !== 0) throw versionConflictError();
    if (readbacks.length !== 0) throw inputError();
    return false;
  }
  if (events.length === 0) throw versionConflictError();
  if (terminals.length !== 1) throw inputError();
  if (localEvents.length !== 1) throw inputError();
  const terminal = terminals[0];
  if (!sameStoredValue(terminal.artifactJobId, encodedJobId)) throw inputError();
  if (terminal.operationKey !== pendingOperation.operationKey
      || terminal.stage !== pendingOperation.stage
      || !OUTBOX_TERMINAL_OUTCOME_ACTIONS.includes(terminal.action)
      || terminal.attemptNumber !== pendingOperation.attemptNumber
      || terminal.startedAt.getTime() !== Date.parse(pendingOperation.startedAt)
      || terminal.eventKey === pendingOperation.eventKey) {
    throw versionConflictError();
  }
  const latestExternalTime = readbacks.length === 0
    ? terminal.occurredAt.getTime()
    : Math.max(terminal.occurredAt.getTime(), readbacks[1].occurredAt.getTime());
  if (events.indexOf(localEvents[0]) <= events.indexOf(terminal)
      || localEvents[0].occurredAt.getTime() < latestExternalTime) {
    throw inputError();
  }
  if (readbacks.length !== 0) {
    const terminalIndex = events.indexOf(terminal);
    const startIndex = events.indexOf(readbacks[0]);
    const readbackIndex = events.indexOf(readbacks[1]);
    if (startIndex >= readbackIndex || readbackIndex >= terminalIndex
        || readbacks[0].startedAt.getTime() <= terminal.completedAt.getTime()
        || readbacks[1].completedAt.getTime() <= readbacks[0].startedAt.getTime()) {
      throw inputError();
    }
  }
  if (kind === 'RETRY') {
    if (terminal.action !== 'FYND_TRANSITION_FAILED'
        || !provesRetryableTransitionFailure(terminal)
        || retry === null || terminal.safeCode !== retry.errorCode
        || terminal.responseSummary === null
        || terminal.responseSummary.retryable !== true
        || readbacks.length !== 2
        || !provesTransitionUnchanged(readbacks[1])) throw inputError();
  } else if (kind === 'INDETERMINATE') {
    if (terminal.action !== 'FYND_TRANSITION_FAILED'
        || terminalCode === null || terminal.safeCode !== terminalCode) throw inputError();
    if (readbacks.length === 0) {
      if (!provesNonretryableTransitionFailure(terminal)) throw inputError();
    } else {
      const retryExhausted = provesRetryableTransitionFailure(terminal)
        && provesTransitionUnchanged(readbacks[1]);
      const unresolved = terminal.outcome === 'INDETERMINATE'
        && provesNonretryableTransitionFailure(terminal)
        && provesTransitionIndeterminate(readbacks[1]);
      if (!retryExhausted && !unresolved) throw inputError();
    }
  } else if (kind === 'COMPLETED') {
    if (terminal.action !== 'FYND_TRANSITION_CONFIRMED'
        || !provesDirectTransitionComplete(terminal)
        || (readbacks.length !== 0
          && !provesTransitionReadbackComplete(readbacks[1]))) {
      throw inputError();
    }
  }
  return true;
}

function sameStoredValue(left, right) {
  if (Long.isLong(left) || Long.isLong(right)) {
    return Long.isLong(left) && Long.isLong(right) && left.equals(right);
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameStoredValue(value, right[index]));
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, index) => key === rightKeys[index]
        && sameStoredValue(left[key], right[key]));
  }
  return left === right;
}

function assertExpectedPostImage(actualRow, previousRow, changes) {
  for (const field of Object.keys(previousRow)) {
    const expected = Object.prototype.hasOwnProperty.call(changes, field)
      ? changes[field]
      : previousRow[field];
    if (!sameStoredValue(actualRow[field], expected)) throw dataError();
  }
}

function compareEventTuple(leftOccurredAt, leftEventKey, rightOccurredAt, rightEventKey) {
  const timeDifference = leftOccurredAt.getTime() - rightOccurredAt.getTime();
  if (timeDifference !== 0) return timeDifference < 0 ? -1 : 1;
  if (leftEventKey === rightEventKey) return 0;
  return leftEventKey < rightEventKey ? -1 : 1;
}

function compareAuditEventToHead(event, head) {
  const tupleComparison = compareEventTuple(
    event.occurredAt,
    event.eventKey,
    head.lastOccurredAt,
    head.lastEventKey,
  );
  if (event.occurredAt.getTime() !== head.lastOccurredAt.getTime()
      || event.eventKey === head.lastEventKey) return tupleComparison;

  const eventIsPreJob = event.jobId === null && event.documentNumber === null;
  const headIsPreJob = head.jobId === null && head.documentNumber === null;
  if (eventIsPreJob !== headIsPreJob) return eventIsPreJob ? -1 : 1;
  if (eventIsPreJob) {
    const eventIsFailure = PRE_JOB_FAILURE_ACTIONS.includes(event.action);
    const headIsFailure = PRE_JOB_FAILURE_ACTIONS.includes(head.lastAction);
    if (eventIsFailure !== headIsFailure) return eventIsFailure ? 1 : -1;
  }
  return tupleComparison;
}

function compareAuditEvents(left, right) {
  return compareAuditEventToHead(left, {
    jobId: right.jobId,
    documentNumber: right.documentNumber,
    lastAction: right.action,
    lastOccurredAt: right.occurredAt,
    lastEventKey: right.eventKey,
  });
}

function readPreJobFailureRepairCandidate(document) {
  const event = dataDocument(document, EVENT_FIELDS);
  decodeAuditEvent(event);
  try {
    const descriptor = Object.getOwnPropertyDescriptor(document, '_id');
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.value === null || descriptor.value === undefined
        || types.isProxy(descriptor.value)) throw dataError();
    return { id: descriptor.value, event };
  } catch (error) {
    if (SAFE_ERRORS.has(error)) throw error;
    throw dataError();
  }
}

function readStoredHead(document) {
  const head = dataDocument(document, HEAD_FIELDS);
  if (!isPrintableIdentifier(head.companyId, 512)
      || !isPrintableIdentifier(head.shipmentId, 512)
      || !(head.documentNumber === null || isPrintableIdentifier(head.documentNumber, 512))
      || !AUDIT_STAGES.includes(head.lastStage) || !AUDIT_ACTIONS.includes(head.lastAction)
      || AUDIT_ACTION_STAGES[head.lastAction] !== head.lastStage
      || !AUDIT_OUTCOMES.includes(head.lastOutcome)
      || !AUDIT_ACTION_OUTCOMES[head.lastAction].includes(head.lastOutcome)
      || !(head.lastSafeCode === null
        || (typeof head.lastSafeCode === 'string' && SAFE_CODE_PATTERN.test(head.lastSafeCode)))
      || typeof head.lastEventKey !== 'string' || !KEY_PATTERN.test(head.lastEventKey)
      || !Number.isSafeInteger(head.version) || head.version < 0) throw dataError();
  decodeStoredNullablePositiveLong(head.jobId);
  decodeStoredDate(head.firstOccurredAt);
  decodeStoredDate(head.lastOccurredAt);
  decodeStoredDate(head.expiresAt);
  if (head.firstOccurredAt.getTime() > head.lastOccurredAt.getTime()
      || head.expiresAt.getTime() - head.lastOccurredAt.getTime() !== AUDIT_RETENTION_MS) {
    throw dataError();
  }
  return head;
}

function readStoredWebhook(document) {
  const event = dataDocument(document, [
    'eventId', 'companyId', 'applicationId', 'shipmentId', 'eventType', 'status',
    'receivedAt', 'processedAt', 'jobId',
  ]);
  if (typeof event.eventId !== 'string' || typeof event.companyId !== 'string'
      || !(event.applicationId === null || typeof event.applicationId === 'string')
      || typeof event.shipmentId !== 'string' || typeof event.eventType !== 'string'
      || typeof event.status !== 'string') throw dataError();
  decodeStoredDate(event.receivedAt);
  decodeStoredNullableDate(event.processedAt);
  decodeStoredPositiveLong(event.jobId);
  return event;
}

function readQuery(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) {
    throw readInputError();
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw readInputError();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length
        || keys.some(key => typeof key !== 'string' || !fields.includes(key))) throw readInputError();
    const snapshot = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw readInputError();
      }
      snapshot[field] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (SAFE_ERRORS.has(error)) throw error;
    throw readInputError();
  }
}

function validateListQuery(query) {
  const snapshot = readQuery(query, ['companyId', 'limit', 'beforeId']);
  if (typeof snapshot.companyId !== 'string' || snapshot.companyId.trim() === ''
      || !Number.isSafeInteger(snapshot.limit) || snapshot.limit < 1 || snapshot.limit > 100
      || !(snapshot.beforeId === null
        || (Number.isSafeInteger(snapshot.beforeId) && snapshot.beforeId > 0))) {
    throw readInputError();
  }
  return snapshot;
}

function validateJobReadQuery(query) {
  const snapshot = readQuery(query, ['companyId', 'jobId']);
  if (typeof snapshot.companyId !== 'string' || snapshot.companyId.trim() === ''
      || !Number.isSafeInteger(snapshot.jobId) || snapshot.jobId < 1) throw readInputError();
  return snapshot;
}

function encodeReadInstant(value) {
  try {
    return encodeDate(value);
  } catch {
    throw readInputError();
  }
}

function validateAuditHeadQuery(query) {
  const snapshot = readQuery(query, ['companyId', 'limit', 'before']);
  if (!isPrintableIdentifier(snapshot.companyId, 512)
      || !Number.isSafeInteger(snapshot.limit) || snapshot.limit < 1 || snapshot.limit > 50) {
    throw readInputError();
  }
  if (snapshot.before === null) return { ...snapshot, before: null };
  const before = readQuery(snapshot.before, ['lastOccurredAt', 'shipmentId']);
  if (!isPrintableIdentifier(before.shipmentId, 512)) throw readInputError();
  return {
    ...snapshot,
    before: {
      lastOccurredAt: encodeReadInstant(before.lastOccurredAt),
      shipmentId: before.shipmentId,
    },
  };
}

function validateAuditTimelineQuery(query) {
  const snapshot = readQuery(query, ['companyId', 'shipmentId', 'limit', 'before']);
  if (!isPrintableIdentifier(snapshot.companyId, 512)
      || !isPrintableIdentifier(snapshot.shipmentId, 512)
      || !Number.isSafeInteger(snapshot.limit) || snapshot.limit < 1 || snapshot.limit > 50) {
    throw readInputError();
  }
  if (snapshot.before === null) return { ...snapshot, before: null };
  const before = readQuery(snapshot.before, ['occurredAt', 'eventKey']);
  if (typeof before.eventKey !== 'string' || !KEY_PATTERN.test(before.eventKey)) {
    throw readInputError();
  }
  return {
    ...snapshot,
    before: {
      occurredAt: encodeReadInstant(before.occurredAt),
      eventKey: before.eventKey,
    },
  };
}

function validateUnresolvedQuery(query) {
  const snapshot = readQuery(query, ['companyId', 'jobId', 'stage']);
  if (!isPrintableIdentifier(snapshot.companyId, 512)
      || !Number.isSafeInteger(snapshot.jobId) || snapshot.jobId < 1
      || !EXTERNAL_STAGES.has(snapshot.stage)) throw readInputError();
  return snapshot;
}

function prepareExternalOperationInput(input) {
  let snapshot;
  try {
    snapshot = readQuery(input, ['targetKind', 'targetId', 'expectedVersion', 'event']);
  } catch {
    throw inputError();
  }
  if (!['JOB', 'OUTBOX'].includes(snapshot.targetKind)
      || !Number.isSafeInteger(snapshot.targetId) || snapshot.targetId < 1
      || !Number.isSafeInteger(snapshot.expectedVersion) || snapshot.expectedVersion < 0
      || snapshot.expectedVersion >= Number.MAX_SAFE_INTEGER) {
    throw inputError();
  }
  let event;
  try {
    event = encodeAuditEvent(snapshot.event);
  } catch {
    throw inputError();
  }
  if (snapshot.targetKind === 'OUTBOX') {
    if (event.stage !== 'FYND_TRANSITION'
        || event.action !== 'FYND_TRANSITION_REQUESTED'
        || event.outcome !== 'STARTED'
        || event.safeCode !== null
        || event.startedAt === null || event.completedAt !== null || event.durationMs !== null
        || event.startedAt.getTime() !== event.occurredAt.getTime()) throw inputError();
    const pendingOperation = {
      operationKey: event.operationKey,
      eventKey: event.eventKey,
      stage: event.stage,
      action: event.action,
      attemptNumber: event.attemptNumber,
      expectedParentVersion: snapshot.expectedVersion,
      startedAt: new Date(event.startedAt.getTime()),
      targetKind: 'OUTBOX',
      targetId: encodePositiveLong(snapshot.targetId),
    };
    try {
      decodePendingOperation(pendingOperation);
    } catch {
      throw inputError();
    }
    return { ...snapshot, event, pendingOperation };
  }
  if (!JOB_EXTERNAL_STATES[event.stage]
      || !JOB_BEGIN_ACTIONS.has(event.action)
      || event.outcome !== 'STARTED'
      || decodeStoredNullablePositiveLong(event.jobId) !== snapshot.targetId
      || event.startedAt === null || event.completedAt !== null || event.durationMs !== null
      || event.startedAt.getTime() !== event.occurredAt.getTime()) throw inputError();
  const pendingOperation = {
    operationKey: event.operationKey,
    eventKey: event.eventKey,
    stage: event.stage,
    action: event.action,
    attemptNumber: event.attemptNumber,
    expectedParentVersion: snapshot.expectedVersion,
    startedAt: new Date(event.startedAt.getTime()),
    targetKind: 'JOB',
    targetId: encodePositiveLong(snapshot.targetId),
  };
  try {
    decodePendingOperation(pendingOperation);
  } catch {
    throw inputError();
  }
  return { ...snapshot, event, pendingOperation };
}

function assertPreparedOperationKey(prepared) {
  let expectedOperationKey;
  try {
    expectedOperationKey = createOperationKey({
      targetKind: prepared.targetKind,
      targetId: String(prepared.targetId),
      expectedParentVersion: prepared.expectedVersion,
      attemptNumber: prepared.event.attemptNumber,
      stage: prepared.event.stage,
      action: prepared.event.action,
    });
  } catch {
    throw inputError();
  }
  if (prepared.event.operationKey !== expectedOperationKey) throw inputError();
}

function assertExternalEventMatchesJob(event, job) {
  if (event.companyId !== job.companyId || event.applicationId !== job.applicationId
      || event.shipmentId !== job.shipmentId
      || decodeStoredNullablePositiveLong(event.jobId) !== job.id
      || event.documentNumber !== job.documentNumber) throw inputError();
  if (event.action === 'OEIS_SUBMISSION_REQUESTED'
      && (event.requestSummary.documentNumber !== job.documentNumber
        || event.requestSummary.documentType !== job.documentType
        || event.requestSummary.requestSha256 !== job.requestHash
        || typeof job.oeisRequestJson !== 'string'
        || event.requestSummary.requestByteCount
          !== Buffer.byteLength(job.oeisRequestJson, 'utf8'))) throw inputError();
}

function assertExternalEventMatchesOutbox(event, outbox, parent, requireCurrentAttempt = true) {
  if (event.companyId !== parent.companyId || event.applicationId !== parent.applicationId
      || event.shipmentId !== parent.shipmentId
      || decodeStoredNullablePositiveLong(event.jobId) !== parent.id
      || event.documentNumber !== parent.documentNumber
      || (requireCurrentAttempt && event.attemptNumber !== outbox.attemptCount)
      || decodeStoredNullablePositiveLong(event.artifactJobId) !== parent.id
      || event.requestSummary.shipmentId !== parent.shipmentId
      || event.requestSummary.documentNumber !== parent.documentNumber) throw inputError();
}

function jobAllowsExternalBegin(job, event, capturedNow) {
  const liveLease = typeof job.leaseOwner === 'string' && job.leaseOwner.trim() !== ''
    && job.leaseExpiresAt !== null
    && Date.parse(job.leaseExpiresAt) > capturedNow.getTime();
  let requestByteCount;
  let requestSha256;
  if (typeof job.oeisRequestJson === 'string'
      && typeof job.requestHash === 'string' && SHA256_PATTERN.test(job.requestHash)) {
    requestByteCount = Buffer.byteLength(job.oeisRequestJson, 'utf8');
    requestSha256 = createHash('sha256').update(job.oeisRequestJson, 'utf8').digest('hex');
  }
  const prepared = requestSha256 !== undefined && requestSha256 === job.requestHash;
  const stateAllowed = JOB_EXTERNAL_STATES[event.stage]?.includes(job.state) === true;
  const lockClassification = event.action === 'FYND_LOCK_REQUESTED'
    && job.lockedAt === null;
  const oeisClassification = event.action === 'OEIS_SUBMISSION_REQUESTED'
    && job.lockedAt !== null;
  if (!liveLease || !prepared || !stateAllowed
      || event.attemptNumber !== job.attemptCount
      || (!lockClassification && !oeisClassification)) return false;
  if (event.action === 'OEIS_SUBMISSION_REQUESTED') {
    return event.requestSummary.requestByteCount === requestByteCount
      && event.requestSummary.requestSha256 === requestSha256
      && event.requestSummary.attemptNumber === job.attemptCount;
  }
  return true;
}

function pendingResult(job, pendingOperation) {
  return deepFreeze({
    targetKind: pendingOperation.targetKind,
    targetId: String(pendingOperation.targetId),
    operationKey: pendingOperation.operationKey,
    eventKey: pendingOperation.eventKey,
    stage: pendingOperation.stage,
    action: pendingOperation.action,
    attemptNumber: pendingOperation.attemptNumber,
    startedAt: pendingOperation.startedAt,
    targetVersion: job.version,
  });
}

function assertMissingPendingEventExpired(pendingOperation, capturedNow) {
  const expiresAt = Date.parse(pendingOperation.startedAt) + AUDIT_RETENTION_MS;
  if (!Number.isFinite(expiresAt) || expiresAt > capturedNow.getTime()) throw dataError();
}

function readDocumentArray(value) {
  if (!Array.isArray(value) || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Array.prototype) throw dataError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const rows = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw dataError();
    rows.push(descriptor.value);
  }
  return rows;
}

function mapDryRunSummary(document) {
  const row = dataDocument(document, [
    'jobId', 'shipmentId', 'documentNumber', 'state', 'lockedAt', 'createdAt',
    'updatedAt', 'version',
  ]);
  const mapped = {
    jobId: decodeStoredPositiveLong(row.jobId),
    shipmentId: row.shipmentId,
    documentNumber: row.documentNumber,
    state: row.state,
    lockedAt: decodeStoredNullableDate(row.lockedAt),
    createdAt: decodeStoredDate(row.createdAt),
    updatedAt: decodeStoredDate(row.updatedAt),
    version: row.version,
  };
  if (typeof mapped.shipmentId !== 'string' || mapped.shipmentId.trim() === ''
      || typeof mapped.documentNumber !== 'string' || mapped.documentNumber.trim() === ''
      || mapped.state !== JOB_STATES.SUBMISSION_HELD
      || !Number.isSafeInteger(mapped.version) || mapped.version < 0) throw dataError();
  return deepFreeze(mapped);
}

function mapFailureSummary(document) {
  const row = dataDocument(document, [
    'jobId', 'shipmentId', 'documentNumber', 'state', 'attemptCount', 'lastErrorCode',
    'lockedAt', 'createdAt', 'updatedAt', 'version',
  ]);
  const mapped = {
    jobId: decodeStoredPositiveLong(row.jobId),
    shipmentId: row.shipmentId,
    documentNumber: row.documentNumber,
    state: row.state,
    attemptCount: row.attemptCount,
    lastErrorCode: row.lastErrorCode,
    lockedAt: decodeStoredNullableDate(row.lockedAt),
    createdAt: decodeStoredDate(row.createdAt),
    updatedAt: decodeStoredDate(row.updatedAt),
    version: row.version,
  };
  if (typeof mapped.shipmentId !== 'string' || mapped.shipmentId.trim() === ''
      || typeof mapped.documentNumber !== 'string' || mapped.documentNumber.trim() === ''
      || ![JOB_STATES.DATA_FAILED, JOB_STATES.INDETERMINATE].includes(mapped.state)
      || !Number.isSafeInteger(mapped.attemptCount) || mapped.attemptCount < 0
      || !(mapped.lastErrorCode === null
        || (typeof mapped.lastErrorCode === 'string' && mapped.lastErrorCode.trim() !== ''))
      || !Number.isSafeInteger(mapped.version) || mapped.version < 0) throw dataError();
  return deepFreeze(mapped);
}

function hasErrorLabel(error, label) {
  return error instanceof MongoError && !types.isProxy(error) && error.hasErrorLabel(label);
}

function hasMongoCode(error, code) {
  return error instanceof MongoError && !types.isProxy(error) && error.code === code;
}

function createMongoInvoiceRepository(options = {}) {
  if (!isPlainOwnDataObject(options, ['db', 'client', 'now'])) throw configError();
  const db = ownDataValue(options, 'db');
  const client = ownDataValue(options, 'client');
  const suppliedNow = ownDataValue(options, 'now', false);
  const now = suppliedNow === null ? () => new Date() : suppliedNow;
  if (!db || typeof db !== 'object' || types.isProxy(db)
      || !client || typeof client !== 'object' || types.isProxy(client)
      || typeof now !== 'function' || types.isProxy(now)) throw configError();

  let collections = null;
  let collectionMethods = null;
  let ready = false;
  let closed = false;
  let initializePromise;
  let closePromise;
  const inFlight = new Set();

  function track(promise) {
    inFlight.add(promise);
    promise.then(
      () => inFlight.delete(promise),
      () => inFlight.delete(promise),
    );
    return promise;
  }

  function register(operation) {
    if (closed) throw closedError();
    if (!ready) throw notInitializedError();
    const pending = Promise.resolve().then(operation).catch(error => {
      if (SAFE_ERRORS.has(error)) throw error;
      if (hasErrorLabel(error, 'UnknownTransactionCommitResult')) throw transactionUnknownError();
      throw unavailableError();
    });
    return track(pending);
  }

  function collectionCall(name, method, args) {
    return invokePromise(
      collections[name],
      collectionMethods[name][method],
      args,
    );
  }

  async function insertDocument(name, document, session) {
    const result = await collectionCall(name, 'insertOne', [document, { session }]);
    validateGeneratedInsertResult(result);
  }

  async function updateExisting(name, filter, update, session) {
    const result = await collectionCall(name, 'updateOne', [filter, update, { session }]);
    validateUpdateResult(result);
    const snapshot = snapshotPlainObject(result, [
      'acknowledged', 'matchedCount', 'modifiedCount', 'upsertedCount', 'upsertedId',
    ]);
    if (snapshot.matchedCount !== 1 || snapshot.upsertedCount !== 0) throw dataError();
  }

  function assertHeadLatestMatchesEvent(head, storedEvent) {
    if (head.companyId !== storedEvent.companyId
        || head.shipmentId !== storedEvent.shipmentId
        || head.lastOccurredAt.getTime() !== storedEvent.occurredAt.getTime()
        || head.lastEventKey !== storedEvent.eventKey
        || head.lastStage !== storedEvent.stage
        || head.lastAction !== storedEvent.action
        || head.lastOutcome !== storedEvent.outcome
        || head.lastSafeCode !== storedEvent.safeCode
        || !sameStoredValue(head.jobId, storedEvent.jobId)
        || head.documentNumber !== storedEvent.documentNumber
        || head.expiresAt.getTime() !== storedEvent.expiresAt.getTime()) throw dataError();
  }

  async function assertLiveHeadBackingEvent(session, head, capturedNow) {
    if (head.expiresAt.getTime() <= capturedNow.getTime()) return;
    const eventDocument = await collectionCall('shipment_audit_events', 'findOne', [
      { eventKey: head.lastEventKey },
      { session },
    ]);
    if (eventDocument === null) throw dataError();
    const storedEvent = dataDocument(eventDocument, EVENT_FIELDS);
    decodeAuditEvent(storedEvent);
    assertHeadLatestMatchesEvent(head, storedEvent);
  }

  async function assertDuplicateHeadConsistency(session, storedEvent, capturedNow) {
    const headDocument = await collectionCall('shipment_audit_heads', 'findOne', [
      { companyId: storedEvent.companyId, shipmentId: storedEvent.shipmentId },
      { session },
    ]);
    if (headDocument === null) throw dataError();
    const head = readStoredHead(headDocument);
    await assertLiveHeadBackingEvent(session, head, capturedNow);
    if (head.firstOccurredAt.getTime() > storedEvent.occurredAt.getTime()) throw dataError();
    const comparison = compareAuditEventToHead(storedEvent, head);
    if (comparison > 0) throw dataError();
    if (comparison === 0) assertHeadLatestMatchesEvent(head, storedEvent);
  }

  async function applyAuditHead(session, event, capturedNow) {
    const filter = { companyId: event.companyId, shipmentId: event.shipmentId };
    const currentDocument = await collectionCall('shipment_audit_heads', 'findOne', [
      filter,
      { session },
    ]);
    if (currentDocument === null) {
      await insertDocument('shipment_audit_heads', {
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
      }, session);
      return;
    }
    const current = readStoredHead(currentDocument);
    await assertLiveHeadBackingEvent(session, current, capturedNow);
    const comparison = compareAuditEventToHead(event, current);
    const update = { $min: { firstOccurredAt: event.occurredAt } };
    if (comparison > 0) {
      if (current.version === Number.MAX_SAFE_INTEGER) throw dataError();
      update.$set = {
        jobId: event.jobId,
        documentNumber: event.documentNumber,
        lastStage: event.stage,
        lastAction: event.action,
        lastOutcome: event.outcome,
        lastSafeCode: event.safeCode,
        lastOccurredAt: event.occurredAt,
        lastEventKey: event.eventKey,
        expiresAt: event.expiresAt,
      };
      update.$inc = { version: 1 };
    } else if (comparison === 0) {
      assertHeadLatestMatchesEvent(current, event);
    }
    await updateExisting('shipment_audit_heads', filter, update, session);
  }

  async function persistAuditEvents(session, encodedEvents, capturedNow) {
    for (const event of encodedEvents) {
      const existing = await collectionCall('shipment_audit_events', 'findOne', [
        { eventKey: event.eventKey },
        { session },
      ]);
      if (existing !== null) {
        const stored = dataDocument(existing, Object.keys(event));
        decodeAuditEvent(stored);
        if (!sameStoredValue(stored, event)) {
          const webhookReplayMatches = isClockInsensitiveWebhookScopeEvent(stored)
            && isClockInsensitiveWebhookScopeEvent(event)
            && EVENT_FIELDS.every(field => WEBHOOK_REPLAY_CLOCK_FIELDS.has(field)
              || sameStoredValue(stored[field], event[field]));
          if (!webhookReplayMatches) throw dataError();
        }
        await assertDuplicateHeadConsistency(session, stored, capturedNow);
        continue;
      }
      await insertDocument('shipment_audit_events', event, session);
      await applyAuditHead(session, event, capturedNow);
    }
  }

  async function assertPendingResolutionEvidence(session, record, capturedNow) {
    const pending = record.pendingOperation;
    if (pending === null) return;
    const startDocument = await collectionCall('shipment_audit_events', 'findOne', [
      { eventKey: pending.eventKey },
      { session },
    ]);
    if (startDocument === null) {
      assertMissingPendingEventExpired(pending, capturedNow);
    } else {
      const stored = dataDocument(startDocument, EVENT_FIELDS);
      const decoded = decodeAuditEvent(stored);
      if (decoded.eventKey !== pending.eventKey
          || decoded.operationKey !== pending.operationKey
          || decoded.stage !== pending.stage || decoded.action !== pending.action
          || decoded.outcome !== 'STARTED'
          || decoded.attemptNumber !== pending.attemptNumber
          || decoded.startedAt !== pending.startedAt || decoded.occurredAt !== pending.startedAt
          || decoded.companyId !== record.job.companyId
          || decoded.applicationId !== record.job.applicationId
          || decoded.shipmentId !== record.job.shipmentId
          || decoded.jobId !== record.job.id
          || decoded.documentNumber !== record.job.documentNumber) throw dataError();
      if (stored.expiresAt.getTime() > capturedNow.getTime()) {
        await assertDuplicateHeadConsistency(session, stored, capturedNow);
      }
    }
    const terminalDocument = await collectionCall('shipment_audit_events', 'findOne', [
      { operationKey: pending.operationKey, outcome: { $ne: 'STARTED' } },
      { session },
    ]);
    if (terminalDocument !== null) {
      decodeAuditEvent(terminalDocument);
      throw dataError();
    }
  }

  async function assertOutboxPendingResolutionEvidence(
    session,
    record,
    parent,
    capturedNow,
  ) {
    const pending = record.pendingOperation;
    if (pending === null) return;
    const startDocument = await collectionCall('shipment_audit_events', 'findOne', [
      { eventKey: pending.eventKey },
      { session },
    ]);
    if (startDocument === null) {
      assertMissingPendingEventExpired(pending, capturedNow);
    } else {
      const stored = dataDocument(startDocument, EVENT_FIELDS);
      const decoded = decodeAuditEvent(stored);
      if (decoded.eventKey !== pending.eventKey
          || decoded.operationKey !== pending.operationKey
          || decoded.stage !== 'FYND_TRANSITION'
          || decoded.action !== 'FYND_TRANSITION_REQUESTED'
          || decoded.outcome !== 'STARTED'
          || decoded.attemptNumber !== pending.attemptNumber
          || decoded.startedAt !== pending.startedAt
          || decoded.occurredAt !== pending.startedAt
          || decoded.companyId !== parent.companyId
          || decoded.applicationId !== parent.applicationId
          || decoded.shipmentId !== parent.shipmentId
          || decoded.jobId !== parent.id
          || decoded.documentNumber !== parent.documentNumber
          || decoded.artifactJobId !== parent.id) throw dataError();
      if (stored.expiresAt.getTime() > capturedNow.getTime()) {
        await assertDuplicateHeadConsistency(session, stored, capturedNow);
      }
    }
    const terminalDocument = await collectionCall('shipment_audit_events', 'findOne', [
      { operationKey: pending.operationKey, outcome: { $ne: 'STARTED' } },
      { session },
    ]);
    if (terminalDocument !== null) {
      decodeAuditEvent(terminalDocument);
      throw dataError();
    }
  }

  async function runMutationTransaction(callback) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await transaction(callback);
      } catch (error) {
        if (!DUPLICATE_RACES.has(error)) throw error;
        if (attempt === 2) throw busyError();
      }
    }
    throw busyError();
  }

  async function resolveWebhookBranch(session, candidate) {
    const existing = await collectionCall('shipment_audit_events', 'findOne', [
      { eventKey: candidate.eventKey },
      { session },
    ]);
    if (existing === null) return candidate;
    const stored = dataDocument(existing, Object.keys(candidate));
    decodeAuditEvent(stored);
    if (!isClockInsensitiveWebhookScopeEvent(stored)
        || !isClockInsensitiveWebhookScopeEvent(candidate)) throw dataError();
    for (const field of Object.keys(candidate)) {
      if (!WEBHOOK_REPLAY_CLOCK_FIELDS.has(field)
          && !sameStoredValue(stored[field], candidate[field])) {
        throw dataError();
      }
    }
    return stored;
  }

  async function persistAcceptanceAudit(session, commonEvents, branchCandidate, capturedNow) {
    const branch = await resolveWebhookBranch(session, branchCandidate);
    await persistAuditEvents(session, [...commonEvents, branch], capturedNow);
  }

  async function resolveWebhookConflictCommon(
    session,
    prepared,
    commonEvents,
    conflictingJob,
  ) {
    if (commonEvents.length !== 1) throw inputError();
    const incoming = commonEvents[0];
    let expectedEventKey;
    try {
      expectedEventKey = createEventKey({
        kind: 'ENTITY',
        companyId: prepared.event.companyId,
        shipmentId: prepared.event.shipmentId,
        scopeKind: 'WEBHOOK',
        scopeId: prepared.event.eventId,
        parentVersion: 0,
        attemptNumber: 0,
        stage: 'VALIDATION',
        action: 'VALIDATION_PASSED',
        outcome: 'SUCCESS',
      });
    } catch {
      throw inputError();
    }
    if (incoming.eventKey !== expectedEventKey || incoming.operationKey !== null
        || incoming.companyId !== prepared.event.companyId
        || incoming.applicationId !== prepared.event.applicationId
        || incoming.shipmentId !== prepared.event.shipmentId
        || incoming.jobId !== null || incoming.documentNumber !== null
        || incoming.stage !== 'VALIDATION' || incoming.action !== 'VALIDATION_PASSED'
        || incoming.outcome !== 'SUCCESS' || incoming.attemptNumber !== 0
        || incoming.completedAt.getTime() > incoming.occurredAt.getTime()
        || incoming.queueDelayMs !== null || incoming.retryDelayMs !== null
        || incoming.nextAttemptAt !== null || incoming.safeCode !== null
        || incoming.requestSummary !== null || incoming.responseSummary !== null
        || incoming.artifactJobId !== null) throw inputError();

    const existingDocument = await collectionCall('shipment_audit_events', 'findOne', [
      { eventKey: incoming.eventKey },
      { session },
    ]);
    if (existingDocument === null) return [incoming];
    const stored = dataDocument(existingDocument, EVENT_FIELDS);
    decodeAuditEvent(stored);
    if (sameStoredValue(stored, incoming)) return [stored];
    const differsOnlyByReplayClocksOrApplication = EVENT_FIELDS.every(field => (
      field === 'applicationId' || WEBHOOK_REPLAY_CLOCK_FIELDS.has(field)
        || sameStoredValue(stored[field], incoming[field])
    ));
    if (!differsOnlyByReplayClocksOrApplication
        || stored.applicationId !== conflictingJob.applicationId) throw dataError();
    return [stored];
  }

  async function allocateId(session, counterId) {
    const result = await collectionCall('counters', 'findOneAndUpdate', [
      { _id: counterId, value: { $lt: MAX_SAFE_LONG } },
      { $inc: { value: Long.ONE } },
      { returnDocument: 'after', session },
    ]);
    if (result !== null) {
      const counter = dataDocument(result, ['_id', 'value']);
      if (counter._id !== counterId) throw dataError();
      return decodeStoredPositiveLong(counter.value);
    }
    const current = await collectionCall('counters', 'findOne', [
      { _id: counterId },
      { session },
    ]);
    if (current === null) throw dataError();
    const counter = dataDocument(current, ['_id', 'value']);
    if (counter._id !== counterId) throw dataError();
    const value = decodeStoredNonnegativeLong(counter.value);
    if (value === Number.MAX_SAFE_INTEGER) throw exhaustedError();
    throw dataError();
  }

  function allocateJobId(session) {
    return allocateId(session, 'invoice_job');
  }

  function allocateOutboxId(session) {
    return allocateId(session, 'invoice_outbox');
  }

  async function transaction(callback) {
    let session;
    let failure;
    try {
      const startSession = resolveCallable(client, 'startSession');
      session = invokeSync(client, startSession, []);
      if (!session || typeof session !== 'object' || types.isProxy(session)) throw unavailableError();
      const withTransaction = resolveCallable(session, 'withTransaction');
      return await invokePromise(session, withTransaction, [callback.bind(null, session), TRANSACTION_OPTIONS]);
    } catch (error) {
      failure = error;
      if (hasErrorLabel(error, 'UnknownTransactionCommitResult')) throw transactionUnknownError();
      if (error instanceof MongoError && !types.isProxy(error) && error.code === 11000) {
        throw duplicateRaceError();
      }
      if (hasErrorLabel(error, 'TransientTransactionError')) throw busyError();
      if (SAFE_ERRORS.has(error)) throw error;
      throw unavailableError();
    } finally {
      if (session) {
        try {
          const endSession = resolveCallable(session, 'endSession');
          await invokePromise(session, endSession, []);
        } catch (error) {
          if (failure === undefined) throw unavailableError();
        }
      }
    }
  }

  async function initializeIndexes() {
    for (const collectionName of MONGO_COLLECTION_NAMES) {
      if (collectionName === 'fdk_sessions') continue;
      for (const definition of MONGO_INDEX_CATALOG[collectionName]) {
        const result = await collectionCall(collectionName, 'createIndex', [
          definition.key,
          creationOptions(definition),
        ]);
        if (result !== definition.name) throw unavailableError();
      }
    }
    for (const collectionName of MONGO_COLLECTION_NAMES) {
      const cursor = invokeSync(
        collections[collectionName],
        collectionMethods[collectionName].listIndexes,
        [],
      );
      if (!cursor || typeof cursor !== 'object' || types.isProxy(cursor)) throw unavailableError();
      const toArray = resolveCallable(cursor, 'toArray');
      const indexes = await invokePromise(cursor, toArray, []);
      validateIndexList(indexes, MONGO_INDEX_CATALOG[collectionName]);
    }
  }

  async function establishCollections(createCollection, listCollections) {
    for (const name of MONGO_COLLECTION_NAMES) {
      try {
        const created = await invokePromise(db, createCollection, [name, {}]);
        if (!created || typeof created !== 'object' || types.isProxy(created)) {
          throw unavailableError();
        }
      } catch (error) {
        if (!hasMongoCode(error, 48)) throw error;
      }
    }
    const cursor = invokeSync(db, listCollections, [
      {},
      { nameOnly: false },
    ]);
    if (!cursor || typeof cursor !== 'object' || types.isProxy(cursor)) throw unavailableError();
    const toArray = resolveCallable(cursor, 'toArray');
    const documents = readDocumentArray(await invokePromise(cursor, toArray, []));
    if (documents.length !== MONGO_COLLECTION_NAMES.length) throw unavailableError();
    const seen = new Set();
    for (const document of documents) {
      const row = snapshotPlainObject(document, ['name', 'type', 'options', 'info', 'idIndex']);
      if (!MONGO_COLLECTION_NAMES.includes(row.name) || seen.has(row.name)
          || row.type !== 'collection') throw unavailableError();
      const options = snapshotPlainObject(row.options, []);
      if (Reflect.ownKeys(options).length !== 0) throw unavailableError();
      seen.add(row.name);
    }
  }

  async function seedCounters() {
    const counterIds = ['invoice_job', 'invoice_outbox'];
    for (const counterId of counterIds) {
      const result = await collectionCall('counters', 'updateOne', [
        { _id: counterId },
        { $setOnInsert: { value: Long.ZERO } },
        { upsert: true },
      ]);
      validateUpdateResult(result);
    }
    for (const counterId of counterIds) {
      const document = await collectionCall('counters', 'findOne', [{ _id: counterId }]);
      if (document === null) throw dataError();
      const counter = dataDocument(document, ['_id', 'value']);
      if (counter._id !== counterId) throw dataError();
      decodeStoredNonnegativeLong(counter.value);
    }
  }

  async function probeTransactions() {
    await transaction(async session => {
      const inserted = await collectionCall('migration_markers', 'insertOne', [
        { _id: PROBE_ID },
        { session },
      ]);
      validateInsertResult(inserted, PROBE_ID);
      const inside = await collectionCall('migration_markers', 'findOne', [
        { _id: PROBE_ID },
        { session },
      ]);
      const snapshot = snapshotPlainObject(inside, ['_id']);
      if (snapshot._id !== PROBE_ID) throw unavailableError();
      const abortTransaction = resolveCallable(session, 'abortTransaction');
      await invokePromise(session, abortTransaction, []);
    });
    const outside = await collectionCall('migration_markers', 'findOne', [{ _id: PROBE_ID }]);
    if (outside !== null) throw unavailableError();
  }

  function validatePreJobFailureHeadRepairMarker(document) {
    const marker = dataDocument(document, ['_id', 'migration', 'version']);
    if (marker._id !== PRE_JOB_FAILURE_HEAD_REPAIR_MARKER._id
        || marker.migration !== PRE_JOB_FAILURE_HEAD_REPAIR_MARKER.migration
        || marker.version !== PRE_JOB_FAILURE_HEAD_REPAIR_MARKER.version) throw dataError();
  }

  function validatePreJobFailureHeadRepairMarkerWrite(value) {
    validateUpdateResult(value);
    const result = snapshotPlainObject(value, [
      'acknowledged', 'matchedCount', 'modifiedCount', 'upsertedCount', 'upsertedId',
    ]);
    const inserted = result.matchedCount === 0
      && result.modifiedCount === 0
      && result.upsertedCount === 1
      && result.upsertedId === PRE_JOB_FAILURE_HEAD_REPAIR_MARKER_ID;
    const matched = result.matchedCount === 1
      && [0, 1].includes(result.modifiedCount)
      && result.upsertedCount === 0
      && result.upsertedId === null;
    if (!inserted && !matched) throw unavailableError();
  }

  function validateRepairFailureEvent(event, capturedNow) {
    if (event.jobId !== null || event.documentNumber !== null
        || event.outcome !== 'FAILURE'
        || !PRE_JOB_FAILURE_ACTIONS.includes(event.action)
        || event.expiresAt.getTime() <= capturedNow.getTime()) throw dataError();
  }

  async function readHeadForRepair(event, capturedNow, session) {
    validateRepairFailureEvent(event, capturedNow);
    const document = await collectionCall('shipment_audit_heads', 'findOne', [
      { companyId: event.companyId, shipmentId: event.shipmentId },
      session === undefined ? {} : { session },
    ]);
    if (document === null) throw dataError();
    const head = readStoredHead(document);
    const comparison = compareAuditEventToHead(event, head);
    if (comparison <= 0) return null;
    if (event.occurredAt.getTime() !== head.lastOccurredAt.getTime()
        || head.jobId !== null || head.documentNumber !== null
        || PRE_JOB_FAILURE_ACTIONS.includes(head.lastAction)) throw dataError();
    return head;
  }

  async function readCanonicalRepairEvent(session, candidate, capturedNow) {
    const projection = Object.fromEntries([['_id', 0], ...EVENT_FIELDS.map(field => [field, 1])]);
    let afterEventKey;
    let previousEventKey;
    let canonical = null;
    let candidateSeen = false;
    let rowCount = 0;
    while (true) {
      const filter = {
        companyId: candidate.companyId,
        shipmentId: candidate.shipmentId,
        occurredAt: candidate.occurredAt,
        expiresAt: { $gt: capturedNow },
      };
      if (afterEventKey !== undefined) filter.eventKey = { $gt: afterEventKey };
      const documents = await findMany(
        'shipment_audit_events',
        filter,
        projection,
        { eventKey: 1 },
        PRE_JOB_FAILURE_REPAIR_BATCH_SIZE,
        session,
      );
      if (documents.length > PRE_JOB_FAILURE_REPAIR_BATCH_SIZE) throw dataError();
      rowCount += documents.length;
      if (rowCount > PRE_JOB_FAILURE_REPAIR_SAME_CLOCK_MAX_ROWS) throw dataError();
      for (const document of documents) {
        const event = dataDocument(document, EVENT_FIELDS);
        decodeAuditEvent(event);
        if (event.companyId !== candidate.companyId
            || event.shipmentId !== candidate.shipmentId
            || event.occurredAt.getTime() !== candidate.occurredAt.getTime()
            || event.expiresAt.getTime() <= capturedNow.getTime()
            || (previousEventKey !== undefined && event.eventKey <= previousEventKey)) {
          throw dataError();
        }
        previousEventKey = event.eventKey;
        if (event.eventKey === candidate.eventKey) {
          if (!sameStoredValue(event, candidate)) throw dataError();
          candidateSeen = true;
        }
        if (canonical === null || compareAuditEvents(event, canonical) > 0) canonical = event;
      }
      if (documents.length < PRE_JOB_FAILURE_REPAIR_BATCH_SIZE) break;
      afterEventKey = previousEventKey;
    }
    if (canonical === null || !candidateSeen) throw dataError();
    return canonical;
  }

  async function repairLegacyPreJobFailureHead(candidate, capturedNow) {
    if (await readHeadForRepair(candidate, capturedNow) === null) return;
    await transaction(async session => {
      const current = await readHeadForRepair(candidate, capturedNow, session);
      if (current === null) return;
      await assertLiveHeadBackingEvent(session, current, capturedNow);
      const event = await readCanonicalRepairEvent(session, candidate, capturedNow);
      if (compareAuditEventToHead(event, current) <= 0) throw dataError();
      const firstOccurredAt = new Date(current.firstOccurredAt);
      const version = current.version;
      await updateExisting(
        'shipment_audit_heads',
        { ...current },
        {
          $set: {
            jobId: event.jobId,
            documentNumber: event.documentNumber,
            lastStage: event.stage,
            lastAction: event.action,
            lastOutcome: event.outcome,
            lastSafeCode: event.safeCode,
            lastOccurredAt: event.occurredAt,
            lastEventKey: event.eventKey,
            expiresAt: event.expiresAt,
          },
        },
        session,
      );
      const repairedDocument = await collectionCall('shipment_audit_heads', 'findOne', [
        { companyId: event.companyId, shipmentId: event.shipmentId },
        { session },
      ]);
      if (repairedDocument === null) throw dataError();
      const repaired = readStoredHead(repairedDocument);
      assertHeadLatestMatchesEvent(repaired, event);
      if (repaired.firstOccurredAt.getTime() !== firstOccurredAt.getTime()
          || repaired.version !== version) throw dataError();
    });
  }

  async function repairLegacyPreJobFailureHeads(capturedNow) {
    const projection = Object.fromEntries([['_id', 1], ...EVENT_FIELDS.map(field => [field, 1])]);
    for (const action of PRE_JOB_FAILURE_ACTIONS) {
      let afterId;
      while (true) {
        const filter = {
          jobId: null,
          documentNumber: null,
          outcome: 'FAILURE',
          action,
          expiresAt: { $gt: capturedNow },
        };
        if (afterId !== undefined) filter._id = { $gt: afterId };
        const documents = await findMany(
          'shipment_audit_events',
          filter,
          projection,
          { _id: 1 },
          PRE_JOB_FAILURE_REPAIR_BATCH_SIZE,
        );
        const candidates = documents.map(readPreJobFailureRepairCandidate);
        for (const candidate of candidates) {
          validateRepairFailureEvent(candidate.event, capturedNow);
          await repairLegacyPreJobFailureHead(candidate.event, capturedNow);
        }
        if (candidates.length < PRE_JOB_FAILURE_REPAIR_BATCH_SIZE) break;
        afterId = candidates[candidates.length - 1].id;
      }
    }
  }

  async function ensurePreJobFailureHeadRepair() {
    const existing = await collectionCall('migration_markers', 'findOne', [
      { _id: PRE_JOB_FAILURE_HEAD_REPAIR_MARKER_ID },
    ]);
    if (existing !== null) {
      validatePreJobFailureHeadRepairMarker(existing);
      return;
    }

    await repairLegacyPreJobFailureHeads(readClock(now));
    const result = await collectionCall('migration_markers', 'updateOne', [
      { ...PRE_JOB_FAILURE_HEAD_REPAIR_MARKER },
      { $setOnInsert: { ...PRE_JOB_FAILURE_HEAD_REPAIR_MARKER } },
      { upsert: true },
    ]);
    validatePreJobFailureHeadRepairMarkerWrite(result);
    const completed = await collectionCall('migration_markers', 'findOne', [
      { _id: PRE_JOB_FAILURE_HEAD_REPAIR_MARKER_ID },
    ]);
    if (completed === null) throw dataError();
    validatePreJobFailureHeadRepairMarker(completed);
  }

  async function initializeInternal() {
    try {
      const collection = resolveCallable(db, 'collection');
      const createCollection = resolveCallable(db, 'createCollection');
      const listCollections = resolveCallable(db, 'listCollections');
      await establishCollections(createCollection, listCollections);
      const resolvedCollections = {};
      const resolvedMethods = {};
      const methods = [
        'createIndex', 'listIndexes', 'updateOne', 'findOne', 'find', 'insertOne',
        'insertMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'countDocuments',
      ];
      for (const name of MONGO_COLLECTION_NAMES) {
        const value = invokeSync(db, collection, [name]);
        if (!value || typeof value !== 'object' || types.isProxy(value)) throw configError();
        resolvedCollections[name] = value;
        resolvedMethods[name] = {};
        for (const method of methods) resolvedMethods[name][method] = resolveCallable(value, method);
      }
      collections = resolvedCollections;
      collectionMethods = resolvedMethods;
      await initializeIndexes();
      await seedCounters();
      await probeTransactions();
      await ensurePreJobFailureHeadRepair();
      ready = true;
    } catch {
      ready = false;
      throw initializationError();
    }
  }

  function initialize() {
    if (closed) throw closedError();
    if (ready) return Promise.resolve();
    if (initializePromise) return initializePromise;
    const pending = Promise.resolve().then(initializeInternal);
    initializePromise = track(pending);
    pending.then(
      () => {},
      () => { initializePromise = undefined; },
    );
    return initializePromise;
  }

  function encodeAuditArray(events, companyId, shipmentId) {
    if (!Array.isArray(events) || types.isProxy(events)
        || Object.getPrototypeOf(events) !== Array.prototype) throw inputError();
    const descriptors = Object.getOwnPropertyDescriptors(events);
    if (Reflect.ownKeys(descriptors).some(key => key !== 'length'
        && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)))) throw inputError();
    const encoded = [];
    const keys = new Set();
    for (let index = 0; index < events.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) throw inputError();
      let event;
      try {
        event = encodeAuditEvent(descriptor.value);
      } catch {
        throw inputError();
      }
      if (event.operationKey !== null || EXTERNAL_ACTIONS.has(event.action)
          || (companyId !== undefined && event.companyId !== companyId)
          || (shipmentId !== undefined && event.shipmentId !== shipmentId)
          || keys.has(event.eventKey)) throw inputError();
      keys.add(event.eventKey);
      encoded.push(event);
    }
    return encoded;
  }

  function buildWebhookBranch(prepared, jobId, action, capturedNow) {
    let event;
    try {
      const eventKey = createEventKey({
        kind: 'ENTITY',
        companyId: prepared.event.companyId,
        shipmentId: prepared.event.shipmentId,
        scopeKind: 'WEBHOOK',
        scopeId: prepared.event.eventId,
        parentVersion: 0,
        attemptNumber: 0,
        stage: 'WEBHOOK',
        action,
        outcome: 'SUCCESS',
      });
      event = createAuditEvent({
        eventKey,
        operationKey: null,
        companyId: prepared.event.companyId,
        applicationId: prepared.event.applicationId,
        shipmentId: prepared.event.shipmentId,
        jobId,
        documentNumber: prepared.documentNumber,
        stage: 'WEBHOOK',
        action,
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
      }, { now: () => new Date(capturedNow) });
      return encodeAuditEvent(event);
    } catch {
      throw inputError();
    }
  }

  function buildWebhookRejection(prepared, conflictingJob, capturedNow) {
    let event;
    try {
      const eventKey = createEventKey({
        kind: 'ENTITY',
        companyId: prepared.event.companyId,
        shipmentId: prepared.event.shipmentId,
        scopeKind: 'WEBHOOK',
        scopeId: prepared.event.eventId,
        parentVersion: 0,
        attemptNumber: 0,
        stage: 'WEBHOOK',
        action: 'WEBHOOK_REJECTED',
        outcome: 'FAILURE',
      });
      event = createAuditEvent({
        eventKey,
        operationKey: null,
        companyId: prepared.event.companyId,
        applicationId: prepared.event.applicationId,
        shipmentId: prepared.event.shipmentId,
        jobId: conflictingJob === null ? null : conflictingJob.id,
        documentNumber: conflictingJob === null ? null : conflictingJob.documentNumber,
        stage: 'WEBHOOK',
        action: 'WEBHOOK_REJECTED',
        outcome: 'FAILURE',
        attemptNumber: 0,
        startedAt: null,
        completedAt: null,
        queueDelayMs: null,
        retryDelayMs: null,
        safeCode: 'IDEMPOTENCY_CONFLICT',
        requestSummary: null,
        responseSummary: null,
        artifactJobId: null,
      }, { now: () => new Date(capturedNow) });
      return encodeAuditEvent(event);
    } catch {
      throw inputError();
    }
  }

  async function insertWebhook(session, prepared, jobId) {
    const receivedAt = encodeDate(prepared.receivedAt);
    await insertDocument('webhook_events', {
      eventId: prepared.event.eventId,
      companyId: prepared.event.companyId,
      applicationId: prepared.event.applicationId,
      shipmentId: prepared.event.shipmentId,
      eventType: prepared.event.eventType,
      status: prepared.event.status,
      receivedAt,
      processedAt: receivedAt,
      jobId: encodePositiveLong(jobId),
    }, session);
  }

  function ensureMatchingJob(document, prepared) {
    const row = dataDocument(document, JOB_DOCUMENT_FIELDS);
    const mapped = mapJob(document);
    if (mapped.companyId !== prepared.event.companyId
        || mapped.applicationId !== prepared.event.applicationId
        || mapped.shipmentId !== prepared.event.shipmentId
        || mapped.documentType !== 'IN'
        || mapped.documentNumber !== prepared.documentNumber
        || row.shipmentSnapshotJson !== prepared.normalized.json) throw idempotencyError('job');
    return mapped;
  }

  async function acceptWebhookTransaction(
    session,
    prepared,
    commonEvents,
    branches,
    capturedNow,
  ) {
    async function rejectConflict(kind, conflictingJob) {
      const conflictCommonEvents = await resolveWebhookConflictCommon(
        session, prepared, commonEvents, conflictingJob,
      );
      const rejection = await resolveWebhookBranch(
        session, branches.rejected(conflictingJob),
      );
      if (rejection.occurredAt.getTime()
          < conflictCommonEvents[0].occurredAt.getTime()) throw inputError();
      await persistAuditEvents(
        session, [...conflictCommonEvents, rejection], capturedNow,
      );
      return Object.freeze({ idempotencyConflict: kind });
    }

    const existingEventDocument = await collectionCall('webhook_events', 'findOne', [
      { companyId: prepared.event.companyId, eventId: prepared.event.eventId },
      { session },
    ]);
    if (existingEventDocument !== null) {
      const existingEvent = readStoredWebhook(existingEventDocument);
      const jobId = decodeStoredPositiveLong(existingEvent.jobId);
      const jobDocument = await collectionCall('invoice_jobs', 'findOne', [
        { jobId: existingEvent.jobId },
        { session },
      ]);
      if (jobDocument === null) throw dataError();
      const existingJob = mapJob(jobDocument);
      if (existingJob.id !== jobId
          || existingJob.companyId !== existingEvent.companyId
          || existingJob.applicationId !== existingEvent.applicationId
          || existingJob.shipmentId !== existingEvent.shipmentId
          || existingJob.documentType !== 'IN'
          || existingJob.documentNumber !== `VR-${existingEvent.shipmentId}-1`) {
        throw dataError();
      }
      if (existingEvent.companyId !== prepared.event.companyId
          || existingEvent.shipmentId !== prepared.event.shipmentId
          || existingEvent.status !== prepared.event.status
          || existingEvent.applicationId !== prepared.event.applicationId
          || existingEvent.eventType !== prepared.event.eventType) {
        return rejectConflict('event', existingJob);
      }
      try {
        ensureMatchingJob(jobDocument, prepared);
      } catch (error) {
        if (SAFE_ERRORS.has(error) && error.code === 'IDEMPOTENCY_CONFLICT') {
          return rejectConflict('event', existingJob);
        }
        throw error;
      }
      await persistAcceptanceAudit(
        session, commonEvents, branches.duplicate(jobId), capturedNow,
      );
      return Object.freeze({ created: false, jobId });
    }

    const existingJobDocument = await collectionCall('invoice_jobs', 'findOne', [
      {
        companyId: prepared.event.companyId,
        shipmentId: prepared.event.shipmentId,
        documentType: 'IN',
      },
      { session },
    ]);
    if (existingJobDocument !== null) {
      let existingJob;
      try {
        existingJob = ensureMatchingJob(existingJobDocument, prepared);
      } catch (error) {
        if (SAFE_ERRORS.has(error) && error.code === 'IDEMPOTENCY_CONFLICT') {
          return rejectConflict('job', mapJob(existingJobDocument));
        }
        throw error;
      }
      await insertWebhook(session, prepared, existingJob.id);
      await persistAcceptanceAudit(
        session, commonEvents, branches.duplicate(existingJob.id), capturedNow,
      );
      return Object.freeze({ created: false, jobId: existingJob.id });
    }

    const documentConflict = await collectionCall('invoice_jobs', 'findOne', [
      { companyId: prepared.event.companyId, documentNumber: prepared.documentNumber },
      { session },
    ]);
    if (documentConflict !== null) {
      return rejectConflict('job', mapJob(documentConflict));
    }

    const jobId = await allocateJobId(session);
    const receivedAt = encodeDate(prepared.receivedAt);
    const jobDocument = {
      jobId: encodePositiveLong(jobId),
      companyId: prepared.event.companyId,
      applicationId: prepared.event.applicationId,
      shipmentId: prepared.event.shipmentId,
      documentType: 'IN',
      documentNumber: prepared.documentNumber,
      state: prepared.dryRunEnabled ? JOB_STATES.DRY_RUN_RECEIVED : JOB_STATES.RECEIVED,
      shipmentSnapshotJson: prepared.normalized.json,
      oeisRequestJson: null,
      requestHash: null,
      attemptCount: 0,
      dueAt: receivedAt,
      nextAttemptAt: receivedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      lockedAt: null,
      pendingOperation: null,
      version: 0,
      createdAt: receivedAt,
      updatedAt: receivedAt,
    };
    await insertDocument('invoice_jobs', jobDocument, session);
    await insertWebhook(session, prepared, jobId);
    await persistAcceptanceAudit(session, commonEvents, branches.accepted(jobId), capturedNow);
    const decoded = mapJob(jobDocument);
    if (decoded.id !== jobId) throw dataError();
    return Object.freeze({ created: true, jobId: decoded.id });
  }

  function acceptWebhook(eventRecord, normalizedShipment, dryRunEnabled = false, auditEvents = []) {
    let input;
    try {
      input = normalizeWebhookInput(eventRecord, normalizedShipment, dryRunEnabled);
      input.documentNumber = `VR-${input.event.shipmentId}-1`;
      input.commonEvents = encodeAuditArray(
        auditEvents,
        input.event.companyId,
        input.event.shipmentId,
      );
    } catch (error) {
      const safe = SAFE_ERRORS.has(error) ? error : inputError();
      return register(async () => { throw safe; });
    }
    return register(async () => {
      const capturedNow = readClock(now);
      const branches = {
        accepted: jobId => buildWebhookBranch(input, jobId, 'WEBHOOK_ACCEPTED', capturedNow),
        duplicate: jobId => buildWebhookBranch(input, jobId, 'WEBHOOK_DUPLICATE', capturedNow),
        rejected: conflictingJob => buildWebhookRejection(
          input, conflictingJob, capturedNow,
        ),
      };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await transaction(session => acceptWebhookTransaction(
            session,
            input,
            input.commonEvents,
            branches,
            capturedNow,
          ));
          if (result && result.idempotencyConflict) {
            throw idempotencyError(result.idempotencyConflict);
          }
          return result;
        } catch (error) {
          if (!DUPLICATE_RACES.has(error)) throw error;
          if (attempt === 2) throw busyError();
        }
      }
      throw busyError();
    });
  }

  async function findMany(name, filter, projection, sort, limit, session) {
    let cursor = invokeSync(collections[name], collectionMethods[name].find, [
      filter,
      session === undefined ? { projection } : { projection, session },
    ]);
    if (!cursor || typeof cursor !== 'object' || types.isProxy(cursor)) throw unavailableError();
    const sortMethod = resolveCallable(cursor, 'sort');
    cursor = invokeSync(cursor, sortMethod, [sort]);
    if (!cursor || typeof cursor !== 'object' || types.isProxy(cursor)) throw unavailableError();
    if (limit !== null) {
      const limitMethod = resolveCallable(cursor, 'limit');
      cursor = invokeSync(cursor, limitMethod, [limit]);
      if (!cursor || typeof cursor !== 'object' || types.isProxy(cursor)) throw unavailableError();
    }
    const toArray = resolveCallable(cursor, 'toArray');
    return readDocumentArray(await invokePromise(cursor, toArray, []));
  }

  function listDryRunJobsForCompany(query) {
    return register(async () => {
      const { companyId, limit, beforeId } = validateListQuery(query);
      const filter = { companyId, state: JOB_STATES.SUBMISSION_HELD };
      if (beforeId !== null) filter.jobId = { $lt: encodePositiveLong(beforeId) };
      const documents = await findMany(
        'invoice_jobs',
        filter,
        {
          _id: 0,
          jobId: 1,
          shipmentId: 1,
          documentNumber: 1,
          state: 1,
          lockedAt: 1,
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        },
        { jobId: -1 },
        limit + 1,
      );
      const mapped = documents.map(mapDryRunSummary);
      const items = mapped.slice(0, limit);
      return deepFreeze({
        items,
        nextBeforeId: mapped.length > limit ? items[items.length - 1].jobId : null,
      });
    });
  }

  function listFailedJobsForCompany(query) {
    return register(async () => {
      const { companyId, limit, beforeId } = validateListQuery(query);
      const filter = {
        companyId,
        state: { $in: [JOB_STATES.DATA_FAILED, JOB_STATES.INDETERMINATE] },
      };
      if (beforeId !== null) filter.jobId = { $lt: encodePositiveLong(beforeId) };
      const documents = await findMany(
        'invoice_jobs',
        filter,
        {
          _id: 0,
          jobId: 1,
          shipmentId: 1,
          documentNumber: 1,
          state: 1,
          attemptCount: 1,
          lastErrorCode: 1,
          lockedAt: 1,
          createdAt: 1,
          updatedAt: 1,
          version: 1,
        },
        { jobId: -1 },
        limit + 1,
      );
      const mapped = documents.map(mapFailureSummary);
      const items = mapped.slice(0, limit);
      return deepFreeze({
        items,
        nextBeforeId: mapped.length > limit ? items[items.length - 1].jobId : null,
      });
    });
  }

  function getDryRunJobForCompany(query) {
    return register(async () => {
      const { companyId, jobId } = validateJobReadQuery(query);
      const document = await collectionCall('invoice_jobs', 'findOne', [{
        companyId,
        jobId: encodePositiveLong(jobId),
        state: JOB_STATES.SUBMISSION_HELD,
      }]);
      return mapJob(document);
    });
  }

  function getDryRunRequestForCompany(query) {
    return register(async () => {
      const { companyId, jobId } = validateJobReadQuery(query);
      const document = await collectionCall('invoice_jobs', 'findOne', [
        {
          companyId,
          jobId: encodePositiveLong(jobId),
          state: JOB_STATES.SUBMISSION_HELD,
        },
        {
          projection: {
            _id: 0,
            jobId: 1,
            documentNumber: 1,
            oeisRequestJson: 1,
            requestHash: 1,
          },
        },
      ]);
      if (document === null) return null;
      const row = dataDocument(document, [
        'jobId', 'documentNumber', 'oeisRequestJson', 'requestHash',
      ]);
      const mapped = {
        jobId: decodeStoredPositiveLong(row.jobId),
        documentNumber: row.documentNumber,
        requestJson: row.oeisRequestJson,
        requestHash: row.requestHash,
      };
      if (typeof mapped.documentNumber !== 'string' || mapped.documentNumber.trim() === ''
          || typeof mapped.requestJson !== 'string'
          || typeof mapped.requestHash !== 'string' || mapped.requestHash.trim() === '') {
        throw dataError();
      }
      return deepFreeze(mapped);
    });
  }

  function getJob(jobId) {
    return register(async () => {
      let encoded;
      try {
        encoded = encodePositiveLong(jobId);
      } catch {
        throw readInputError();
      }
      const document = await collectionCall('invoice_jobs', 'findOne', [{ jobId: encoded }]);
      return mapJob(document);
    });
  }

  function getArtifact(jobId) {
    return register(async () => {
      let encodedJobId;
      try {
        encodedJobId = encodePositiveLong(jobId);
      } catch {
        throw readInputError();
      }
      const document = await collectionCall('invoice_artifacts', 'findOne', [
        { jobId: encodedJobId },
      ]);
      const artifact = mapArtifact(document);
      if (artifact === null) return null;
      const parentDocument = await collectionCall('invoice_jobs', 'findOne', [
        { jobId: encodedJobId },
      ]);
      if (parentDocument === null) throw dataError();
      const parent = decodeJobRecord(parentDocument);
      if (artifact.jobId !== parent.job.id
          || artifact.invoiceNumber !== parent.job.documentNumber) throw dataError();
      return artifact;
    });
  }

  function claimNextJob(workerId, leaseUntil) {
    return register(async () => {
      const capturedNow = readClaimClock(now);
      let leaseDate;
      try {
        if (!isPrintableIdentifier(workerId, 512)) throw claimError();
        leaseDate = encodeDate(leaseUntil);
        if (leaseDate.getTime() <= capturedNow.getTime()) throw claimError();
      } catch (error) {
        if (SAFE_ERRORS.has(error) && error.code === 'REPOSITORY_CLAIM_INVALID') throw error;
        throw claimError();
      }
      return runMutationTransaction(async session => {
        const candidateDocument = await collectionCall('invoice_jobs', 'findOne', [
          {
            state: { $in: ACTIVE_JOB_STATES },
            dueAt: { $lte: capturedNow },
            $or: [
              { leaseOwner: null },
              { leaseExpiresAt: null },
              { leaseOwner: { $exists: false } },
              { leaseExpiresAt: { $exists: false } },
              { leaseExpiresAt: { $lte: capturedNow } },
            ],
          },
          { sort: { dueAt: 1, jobId: 1 }, session },
        ]);
        if (candidateDocument === null) return null;
        const candidate = decodeJobRecord(candidateDocument);
        const owner = candidate.row.leaseOwner;
        const expiry = candidate.row.leaseExpiresAt;
        const explicitNull = owner === null || expiry === null;
        if (!(explicitNull || (typeof owner === 'string' && owner.trim() !== ''
          && expiry instanceof Date && expiry.getTime() <= capturedNow.getTime()))) {
          throw dataError();
        }
        const updatedDocument = await collectionCall('invoice_jobs', 'findOneAndUpdate', [
          {
            jobId: candidate.row.jobId,
            version: candidate.job.version,
            state: candidate.job.state,
            dueAt: candidate.row.dueAt,
            leaseOwner: owner,
            leaseExpiresAt: expiry,
            pendingOperation: candidate.row.pendingOperation,
          },
          {
            $set: {
              leaseOwner: workerId,
              leaseExpiresAt: leaseDate,
              updatedAt: capturedNow,
            },
            $inc: { attemptCount: 1, version: 1 },
          },
          {
            returnDocument: 'after',
            includeResultMetadata: false,
            sort: { dueAt: 1, jobId: 1 },
            session,
          },
        ]);
        if (updatedDocument === null) throw versionConflictError();
        const updated = decodeJobRecord(updatedDocument);
        if (updated.job.version !== candidate.job.version + 1
            || updated.job.attemptCount !== candidate.job.attemptCount + 1
            || updated.job.leaseOwner !== workerId
            || updated.job.leaseExpiresAt !== leaseUntil
            || !sameStoredValue(updated.row.pendingOperation, candidate.row.pendingOperation)) {
          throw dataError();
        }
        const queueDelayMs = capturedNow.getTime() - candidate.row.dueAt.getTime();
        const event = buildInternalJobAudit(updated.job, candidate.job.version, capturedNow, {
          stage: 'JOB', action: 'JOB_CLAIMED', outcome: 'SUCCESS', queueDelayMs,
        });
        await persistAuditEvents(session, [event], capturedNow);
        return updated.job;
      });
    });
  }

  async function loadJobForMutation(session, encodedJobId) {
    const document = await collectionCall('invoice_jobs', 'findOne', [
      { jobId: encodedJobId },
      { session },
    ]);
    if (document === null) throw versionConflictError();
    return decodeJobRecord(document);
  }

  async function loadOutboxForMutation(session, encodedOutboxId) {
    const document = await collectionCall('invoice_outbox', 'findOne', [
      { outboxId: encodedOutboxId },
      { session },
    ]);
    if (document === null) throw versionConflictError();
    return decodeOutboxRecord(document);
  }

  async function loadOutboxParent(session, record) {
    const document = await collectionCall('invoice_jobs', 'findOne', [
      { jobId: record.row.jobId },
      { session },
    ]);
    if (document === null) throw versionConflictError();
    const parent = decodeJobRecord(document);
    assertOutboxParent(record, parent);
    if (parent.pendingOperation !== null) throw dataError();
    return parent;
  }

  function assertLiveOutboxMutation(record, expectedVersion, capturedNow) {
    if (record.outbox.version !== expectedVersion
        || !ACTIVE_OUTBOX_STATUSES.includes(record.outbox.status)
        || record.row.parentState !== JOB_STATES.FYND_TRANSITION_PENDING
        || typeof record.row.leaseOwner !== 'string' || record.row.leaseOwner.trim() === ''
        || !(record.row.leaseExpiresAt instanceof Date)
        || record.row.leaseExpiresAt.getTime() <= capturedNow.getTime()) {
      throw versionConflictError();
    }
  }

  async function updateJobAndAudit({
    session,
    record,
    expectedVersion,
    capturedNow,
    filter = {},
    update,
    events,
  }) {
    const updatedDocument = await collectionCall('invoice_jobs', 'findOneAndUpdate', [
      {
        jobId: record.row.jobId,
        version: expectedVersion,
        state: record.job.state,
        leaseOwner: record.row.leaseOwner,
        leaseExpiresAt: record.row.leaseExpiresAt,
        pendingOperation: record.row.pendingOperation,
        ...filter,
      },
      update,
      { returnDocument: 'after', includeResultMetadata: false, session },
    ]);
    if (updatedDocument === null) throw versionConflictError();
    const updated = decodeJobRecord(updatedDocument);
    if (updated.job.version !== expectedVersion + 1) throw dataError();
    await persistAuditEvents(session, events, capturedNow);
    return updated;
  }

  function savePreparedRequest(
    jobId,
    requestJson,
    requestHash,
    expectedVersion,
    auditEvents = [],
  ) {
    return register(async () => {
      const validated = validateJobIdAndVersion(jobId, expectedVersion);
      validatePreparedRequestInput(requestJson, requestHash);
      const events = encodeMutationAuditArray(auditEvents);
      const capturedNow = readClock(now);
      return runMutationTransaction(async session => {
        const record = await loadJobForMutation(session, validated.encodedJobId);
        if ((record.row.oeisRequestJson !== null || record.row.requestHash !== null)
            && (record.row.oeisRequestJson !== requestJson
              || record.row.requestHash !== requestHash)) throw payloadDriftError();
        assertLiveJobMutation(record, expectedVersion, INITIAL_JOB_STATES, capturedNow);
        if (record.pendingOperation !== null) throw versionConflictError();
        if (record.row.oeisRequestJson !== null || record.row.requestHash !== null) {
          throw versionConflictError();
        }
        validateMutationAuditBundle(
          events,
          record,
          expectedVersion,
          { allowedLocalActions: SAVE_PREPARED_LOCAL_ACTIONS },
        );
        const targetState = record.job.state === JOB_STATES.RECEIVED
          ? JOB_STATES.LOCK_PENDING
          : JOB_STATES.DRY_RUN_LOCK_PENDING;
        const updated = await updateJobAndAudit({
          session,
          record,
          expectedVersion,
          capturedNow,
          filter: { oeisRequestJson: null, requestHash: null },
          update: {
            $set: {
              oeisRequestJson: requestJson,
              requestHash,
              state: targetState,
              updatedAt: capturedNow,
            },
            $inc: { version: 1 },
          },
          events,
        });
        if (updated.job.state !== targetState || updated.row.oeisRequestJson !== requestJson
            || updated.row.requestHash !== requestHash) throw dataError();
        return updated.job;
      });
    });
  }

  function markShipmentLocked(jobId, expectedVersion, auditEvents = []) {
    return register(async () => {
      const validated = validateJobIdAndVersion(jobId, expectedVersion);
      const events = encodeMutationAuditArray(auditEvents);
      const capturedNow = readClock(now);
      return runMutationTransaction(async session => {
        const record = await loadJobForMutation(session, validated.encodedJobId);
        assertLiveJobMutation(record, expectedVersion, LOCK_STAGE_JOB_STATES, capturedNow);
        if (record.row.lockedAt !== null || record.row.oeisRequestJson === null
            || record.row.requestHash === null) throw versionConflictError();
        assertStoredPreparedRequest(record.row);
        const dryRun = DRY_RUN_JOB_STATES.has(record.job.state);
        const targetState = dryRun ? JOB_STATES.SUBMISSION_HELD : JOB_STATES.LOCKED;
        const clearsPending = validateMutationAuditBundle(
          events,
          record,
          expectedVersion,
          {
            allowedLocalActions: dryRun ? MARK_LOCKED_LOCAL_ACTIONS : NO_LOCAL_ACTIONS,
            lockTargetState: targetState,
          },
        );
        if (clearsPending) await assertPendingResolutionEvidence(session, record, capturedNow);
        const set = {
          state: targetState,
          lockedAt: capturedNow,
          pendingOperation: null,
          updatedAt: capturedNow,
        };
        if (dryRun) Object.assign(set, {
          nextAttemptAt: null,
          dueAt: record.row.createdAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        });
        const updated = await updateJobAndAudit({
          session,
          record,
          expectedVersion,
          capturedNow,
          filter: {
            lockedAt: null,
            oeisRequestJson: record.row.oeisRequestJson,
            requestHash: record.row.requestHash,
          },
          update: { $set: set, $inc: { version: 1 } },
          events,
        });
        if (updated.job.state !== targetState || updated.job.lockedAt !== capturedNow.toISOString()
            || updated.pendingOperation !== null) throw dataError();
        return updated.job;
      });
    });
  }

  function scheduleJobRetry(jobId, retryState, expectedVersion, auditEvents = []) {
    return register(async () => {
      const validated = validateJobIdAndVersion(jobId, expectedVersion);
      const retry = validateRetryInput(retryState);
      const events = encodeMutationAuditArray(auditEvents);
      const capturedNow = readClock(now);
      return runMutationTransaction(async session => {
        const record = await loadJobForMutation(session, validated.encodedJobId);
        assertLiveJobMutation(record, expectedVersion, ACTIVE_JOB_STATES, capturedNow);
        const clearsPending = validateMutationAuditBundle(
          events,
          record,
          expectedVersion,
          { allowedLocalActions: SCHEDULE_RETRY_LOCAL_ACTIONS, retry },
        );
        if (clearsPending) await assertPendingResolutionEvidence(session, record, capturedNow);
        const targetState = DRY_RUN_JOB_STATES.has(record.job.state)
          ? JOB_STATES.DRY_RUN_RETRY_WAIT
          : JOB_STATES.RETRY_WAIT;
        const updated = await updateJobAndAudit({
          session,
          record,
          expectedVersion,
          capturedNow,
          update: {
            $set: {
              state: targetState,
              nextAttemptAt: retry.nextAttemptAt,
              dueAt: retry.nextAttemptAt,
              lastErrorCode: retry.errorCode,
              lastErrorMessage: retry.safeMessage,
              leaseOwner: null,
              leaseExpiresAt: null,
              pendingOperation: null,
              updatedAt: capturedNow,
            },
            $inc: { version: 1 },
          },
          events,
        });
        if (updated.job.state !== targetState
            || updated.job.nextAttemptAt !== retry.nextAttemptAt.toISOString()
            || updated.pendingOperation !== null) throw dataError();
        return updated.job;
      });
    });
  }

  function markJobTerminal(
    state,
    jobId,
    errorCode,
    safeMessage,
    expectedVersion,
    auditEvents,
  ) {
    return register(async () => {
      const validated = validateJobIdAndVersion(jobId, expectedVersion);
      validateSafeErrorInput(errorCode, safeMessage);
      const events = encodeMutationAuditArray(auditEvents);
      const capturedNow = readClock(now);
      return runMutationTransaction(async session => {
        const record = await loadJobForMutation(session, validated.encodedJobId);
        assertLiveJobMutation(record, expectedVersion, ACTIVE_JOB_STATES, capturedNow);
        const clearsPending = validateMutationAuditBundle(
          events,
          record,
          expectedVersion,
          { allowedLocalActions: TERMINAL_LOCAL_ACTIONS[state], terminalCode: errorCode },
        );
        if (clearsPending) await assertPendingResolutionEvidence(session, record, capturedNow);
        const updated = await updateJobAndAudit({
          session,
          record,
          expectedVersion,
          capturedNow,
          update: {
            $set: {
              state,
              nextAttemptAt: null,
              dueAt: record.row.createdAt,
              lastErrorCode: errorCode,
              lastErrorMessage: safeMessage,
              leaseOwner: null,
              leaseExpiresAt: null,
              pendingOperation: null,
              updatedAt: capturedNow,
            },
            $inc: { version: 1 },
          },
          events,
        });
        if (updated.job.state !== state || updated.job.nextAttemptAt !== null
            || updated.pendingOperation !== null) throw dataError();
        return updated.job;
      });
    });
  }

  function markJobFailed(
    jobId,
    errorCode,
    safeMessage,
    expectedVersion,
    auditEvents = [],
  ) {
    return markJobTerminal(
      JOB_STATES.DATA_FAILED,
      jobId,
      errorCode,
      safeMessage,
      expectedVersion,
      auditEvents,
    );
  }

  function markJobIndeterminate(
    jobId,
    errorCode,
    safeMessage,
    expectedVersion,
    auditEvents = [],
  ) {
    return markJobTerminal(
      JOB_STATES.INDETERMINATE,
      jobId,
      errorCode,
      safeMessage,
      expectedVersion,
      auditEvents,
    );
  }

  function markOeisAcceptedAndEnqueue(
    jobId,
    artifact,
    outboxReference,
    expectedVersion,
    auditEvents = [],
    responseEvidence = null,
  ) {
    return register(async () => {
      const validated = validateJobIdAndVersion(jobId, expectedVersion);
      const preparedArtifact = prepareArtifactInput(artifact, outboxReference);
      const events = encodeMutationAuditArray(auditEvents);
      const evidence = responseEvidence === null ? null : prepareResponseEvidence(responseEvidence);
      const capturedNow = readClock(now);
      return runMutationTransaction(async session => {
        const record = await loadJobForMutation(session, validated.encodedJobId);
        if (preparedArtifact.reference.shipmentId !== record.job.shipmentId
            || preparedArtifact.reference.documentNumber !== record.job.documentNumber
            || preparedArtifact.artifact.invoiceNumber !== record.job.documentNumber) {
          throw inputError();
        }
        assertLiveJobMutation(
          record,
          expectedVersion,
          [JOB_STATES.LOCKED, JOB_STATES.RETRY_WAIT],
          capturedNow,
        );
        if (!(record.row.lockedAt instanceof Date)) throw versionConflictError();
        if (evidence !== null && evidence.attemptNumber !== record.job.attemptCount) {
          throw versionConflictError();
        }
        assertStoredPreparedRequest(record.row);
        const clearsPending = validateEnqueueAuditBundle(
          events,
          record,
          expectedVersion,
          preparedArtifact,
        );
        if (clearsPending) await assertPendingResolutionEvidence(session, record, capturedNow);

        const outboxId = await allocateOutboxId(session);
        const artifactDocument = {
          jobId: validated.encodedJobId,
          ...preparedArtifact.artifact,
          createdAt: capturedNow,
        };
        const payloadJson = JSON.stringify({
          shipmentId: record.job.shipmentId,
          documentNumber: record.job.documentNumber,
          oeisInvoiceNumber: evidence === null
            ? preparedArtifact.artifact.invoiceNumber
            : evidence.oeisInvoiceNumber,
        });
        const parentVersion = expectedVersion + 1;
        const outboxDocument = {
          outboxId: encodePositiveLong(outboxId),
          jobId: validated.encodedJobId,
          action: OUTBOX_ACTIONS.FYND_TRANSITION,
          payloadJson,
          status: OUTBOX_STATUSES.PENDING,
          attemptCount: 0,
          dueAt: capturedNow,
          nextAttemptAt: capturedNow,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          version: 0,
          createdAt: capturedNow,
          completedAt: null,
          parentState: JOB_STATES.FYND_TRANSITION_PENDING,
          parentVersion,
          pendingOperation: null,
        };
        const responseDocument = evidence === null ? null : {
          jobId: validated.encodedJobId,
          attemptNumber: evidence.attemptNumber,
          outcome: 'SUCCESS',
          httpStatus: evidence.httpStatus,
          responseJson: evidence.responseJson,
          responseByteCount: evidence.responseByteCount,
          responseSha256: evidence.responseSha256,
          oeisInvoiceNumber: evidence.oeisInvoiceNumber,
          responseIdentity: `SUCCESS:${evidence.oeisInvoiceNumber}`,
          receivedAt: capturedNow,
          expiresAt: new Date(capturedNow.getTime() + AUDIT_RETENTION_MS),
        };
        try {
          await insertDocument('invoice_artifacts', artifactDocument, session);
          if (responseDocument !== null) {
            await insertDocument('oeis_response_attempts', responseDocument, session);
          }
          await insertDocument('invoice_outbox', outboxDocument, session);
        } catch (error) {
          if (hasMongoCode(error, 11000)) throw versionConflictError();
          throw error;
        }
        const updatedDocument = await collectionCall('invoice_jobs', 'findOneAndUpdate', [
          {
            jobId: record.row.jobId,
            version: expectedVersion,
            state: record.job.state,
            oeisRequestJson: record.row.oeisRequestJson,
            requestHash: record.row.requestHash,
            lockedAt: record.row.lockedAt,
            leaseOwner: record.row.leaseOwner,
            leaseExpiresAt: record.row.leaseExpiresAt,
            pendingOperation: record.row.pendingOperation,
          },
          {
            $set: {
              state: JOB_STATES.FYND_TRANSITION_PENDING,
              dueAt: record.row.createdAt,
              nextAttemptAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorCode: null,
              lastErrorMessage: null,
              pendingOperation: null,
              updatedAt: capturedNow,
            },
            $inc: { version: 1 },
          },
          { returnDocument: 'after', includeResultMetadata: false, session },
        ]);
        if (updatedDocument === null) throw versionConflictError();
        const updated = decodeJobRecord(updatedDocument);
        assertExpectedPostImage(updated.row, record.row, {
          state: JOB_STATES.FYND_TRANSITION_PENDING,
          dueAt: record.row.createdAt,
          nextAttemptAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          pendingOperation: null,
          version: parentVersion,
          updatedAt: capturedNow,
        });
        if (updated.job.version !== parentVersion
            || updated.job.state !== JOB_STATES.FYND_TRANSITION_PENDING
            || updated.job.nextAttemptAt !== null
            || updated.job.leaseOwner !== null || updated.job.leaseExpiresAt !== null
            || updated.pendingOperation !== null) throw dataError();
        const storedArtifact = mapArtifact(artifactDocument);
        const storedOutbox = mapOutbox(outboxDocument);
        if (storedArtifact.jobId !== updated.job.id
            || storedOutbox.jobId !== updated.job.id
            || storedOutbox.id !== outboxId) throw dataError();
        await persistAuditEvents(session, events, capturedNow);
        return deepFreeze({ job: updated.job, outbox: storedOutbox });
      });
    });
  }

  function importHeldOeisResponseAndEnqueue(input) {
    return register(async () => {
      const values = readRequiredOwnDataInput(input, [
        'companyId', 'shipmentId', 'jobId', 'expectedVersion', 'previousRequestHash',
        'correctedRequestJson', 'correctedRequestHash', 'artifact', 'responseEvidence',
      ]).snapshot;
      if (!isPrintableIdentifier(values.companyId, 512)
          || !isPrintableIdentifier(values.shipmentId, 512)
          || typeof values.previousRequestHash !== 'string'
          || !SHA256_PATTERN.test(values.previousRequestHash)) throw inputError();
      const validated = validateJobIdAndVersion(values.jobId, values.expectedVersion);
      const corrected = validatePreparedRequestInput(
        values.correctedRequestJson, values.correctedRequestHash,
      );
      const evidence = prepareResponseEvidence(values.responseEvidence);
      const artifactInvoiceNumber = ownDataValue(values.artifact, 'invoiceNumber');
      const preparedArtifact = prepareArtifactInput(values.artifact, {
        shipmentId: values.shipmentId,
        documentNumber: artifactInvoiceNumber,
      });
      const capturedNow = readClock(now);
      return runMutationTransaction(async session => {
        const record = await loadJobForMutation(session, validated.encodedJobId);
        if (record.job.companyId !== values.companyId
            || record.job.shipmentId !== values.shipmentId
            || record.job.version !== values.expectedVersion
            || record.job.state !== JOB_STATES.SUBMISSION_HELD
            || record.row.requestHash !== values.previousRequestHash
            || record.row.leaseOwner !== null || record.row.leaseExpiresAt !== null
            || record.pendingOperation !== null || !(record.row.lockedAt instanceof Date)
            || preparedArtifact.reference.documentNumber !== record.job.documentNumber
            || preparedArtifact.artifact.invoiceNumber !== record.job.documentNumber
            || evidence.attemptNumber !== record.job.attemptCount) throw versionConflictError();
        assertStoredPreparedRequest(record.row);
        validateHeldRequestCorrection(
          record.row.oeisRequestJson, corrected.requestJson, record.job.documentNumber,
        );

        const outboxId = await allocateOutboxId(session);
        const parentVersion = values.expectedVersion + 1;
        const artifactDocument = {
          jobId: validated.encodedJobId,
          ...preparedArtifact.artifact,
          createdAt: capturedNow,
        };
        const responseDocument = {
          jobId: validated.encodedJobId,
          attemptNumber: evidence.attemptNumber,
          outcome: 'SUCCESS',
          httpStatus: evidence.httpStatus,
          responseJson: evidence.responseJson,
          responseByteCount: evidence.responseByteCount,
          responseSha256: evidence.responseSha256,
          oeisInvoiceNumber: evidence.oeisInvoiceNumber,
          responseIdentity: `SUCCESS:${evidence.oeisInvoiceNumber}`,
          receivedAt: capturedNow,
          expiresAt: new Date(capturedNow.getTime() + AUDIT_RETENTION_MS),
        };
        const payloadJson = JSON.stringify({
          shipmentId: record.job.shipmentId,
          documentNumber: record.job.documentNumber,
          oeisInvoiceNumber: evidence.oeisInvoiceNumber,
        });
        const outboxDocument = {
          outboxId: encodePositiveLong(outboxId),
          jobId: validated.encodedJobId,
          action: OUTBOX_ACTIONS.FYND_TRANSITION,
          payloadJson,
          status: OUTBOX_STATUSES.PENDING,
          attemptCount: 0,
          dueAt: capturedNow,
          nextAttemptAt: capturedNow,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          version: 0,
          createdAt: capturedNow,
          completedAt: null,
          parentState: JOB_STATES.FYND_TRANSITION_PENDING,
          parentVersion,
          pendingOperation: null,
        };
        try {
          await insertDocument('invoice_artifacts', artifactDocument, session);
          await insertDocument('oeis_response_attempts', responseDocument, session);
          await insertDocument('invoice_outbox', outboxDocument, session);
        } catch (error) {
          if (hasMongoCode(error, 11000)) throw versionConflictError();
          throw error;
        }
        const updatedDocument = await collectionCall('invoice_jobs', 'findOneAndUpdate', [
          {
            jobId: record.row.jobId,
            companyId: values.companyId,
            shipmentId: values.shipmentId,
            version: values.expectedVersion,
            state: JOB_STATES.SUBMISSION_HELD,
            oeisRequestJson: record.row.oeisRequestJson,
            requestHash: values.previousRequestHash,
            lockedAt: record.row.lockedAt,
            leaseOwner: null,
            leaseExpiresAt: null,
            pendingOperation: null,
          },
          {
            $set: {
              oeisRequestJson: corrected.requestJson,
              requestHash: corrected.requestHash,
              state: JOB_STATES.FYND_TRANSITION_PENDING,
              dueAt: record.row.createdAt,
              nextAttemptAt: null,
              lastErrorCode: null,
              lastErrorMessage: null,
              updatedAt: capturedNow,
            },
            $inc: { version: 1 },
          },
          { returnDocument: 'after', includeResultMetadata: false, session },
        ]);
        if (updatedDocument === null) throw versionConflictError();
        const updated = decodeJobRecord(updatedDocument);
        assertExpectedPostImage(updated.row, record.row, {
          oeisRequestJson: corrected.requestJson,
          requestHash: corrected.requestHash,
          state: JOB_STATES.FYND_TRANSITION_PENDING,
          dueAt: record.row.createdAt,
          nextAttemptAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          version: parentVersion,
          updatedAt: capturedNow,
        });
        const event = buildInternalJobAudit(record.job, values.expectedVersion, capturedNow, {
          stage: 'MIGRATION', action: 'LEGACY_STATE_IMPORTED', outcome: 'SUCCESS',
        });
        await persistAuditEvents(session, [event], capturedNow);
        const storedArtifact = mapArtifact(artifactDocument);
        const storedOutbox = mapOutbox(outboxDocument);
        if (storedArtifact.jobId !== updated.job.id || storedOutbox.jobId !== updated.job.id) {
          throw dataError();
        }
        return deepFreeze({ job: updated.job, outbox: storedOutbox });
      });
    });
  }

  function claimNextOutbox(workerId, leaseUntil, auditEvents = []) {
    return register(async () => {
      const suppliedEvents = encodeMutationAuditArray(auditEvents);
      const capturedNow = readClaimClock(now);
      let leaseDate;
      try {
        if (!isPrintableIdentifier(workerId, 512)) throw claimError();
        leaseDate = encodeDate(leaseUntil);
        if (leaseDate.getTime() <= capturedNow.getTime()) throw claimError();
      } catch (error) {
        if (SAFE_ERRORS.has(error) && error.code === 'REPOSITORY_CLAIM_INVALID') throw error;
        throw claimError();
      }
      return runMutationTransaction(async session => {
        const candidateDocument = await collectionCall('invoice_outbox', 'findOne', [
          {
            parentState: JOB_STATES.FYND_TRANSITION_PENDING,
            status: { $in: ACTIVE_OUTBOX_STATUSES },
            dueAt: { $lte: capturedNow },
            $or: [
              { leaseOwner: null },
              { leaseExpiresAt: null },
              { leaseOwner: { $exists: false } },
              { leaseExpiresAt: { $exists: false } },
              { leaseExpiresAt: { $lte: capturedNow } },
            ],
          },
          { sort: { dueAt: 1, outboxId: 1 }, session },
        ]);
        if (candidateDocument === null) return null;
        const candidate = decodeOutboxRecord(candidateDocument);
        const owner = candidate.row.leaseOwner;
        const expiry = candidate.row.leaseExpiresAt;
        const explicitNull = owner === null || expiry === null;
        if (!(explicitNull || (isPrintableIdentifier(owner, 512)
          && expiry instanceof Date && expiry.getTime() <= capturedNow.getTime()))) {
          throw dataError();
        }
        const updatedDocument = await collectionCall('invoice_outbox', 'findOneAndUpdate', [
          {
            outboxId: candidate.row.outboxId,
            jobId: candidate.row.jobId,
            version: candidate.outbox.version,
            status: candidate.outbox.status,
            attemptCount: candidate.outbox.attemptCount,
            dueAt: candidate.row.dueAt,
            leaseOwner: owner,
            leaseExpiresAt: expiry,
            parentState: candidate.row.parentState,
            parentVersion: candidate.row.parentVersion,
            pendingOperation: candidate.row.pendingOperation,
          },
          {
            $set: { leaseOwner: workerId, leaseExpiresAt: leaseDate },
            $inc: { attemptCount: 1, version: 1 },
          },
          {
            returnDocument: 'after',
            includeResultMetadata: false,
            sort: { dueAt: 1, outboxId: 1 },
            session,
          },
        ]);
        if (updatedDocument === null) throw versionConflictError();
        const updated = decodeOutboxRecord(updatedDocument);
        if (updated.outbox.version !== candidate.outbox.version + 1
            || updated.outbox.attemptCount !== candidate.outbox.attemptCount + 1
            || updated.outbox.leaseOwner !== workerId
            || updated.outbox.leaseExpiresAt !== leaseUntil
            || updated.row.leaseExpiresAt.getTime() !== leaseDate.getTime()
            || OUTBOX_DOCUMENT_FIELDS.some(field => (
              !['attemptCount', 'version', 'leaseOwner', 'leaseExpiresAt'].includes(field)
              && !sameStoredValue(updated.row[field], candidate.row[field])
            ))) throw dataError();
        const parent = await loadOutboxParent(session, updated);
        const queueDelayMs = capturedNow.getTime() - candidate.row.dueAt.getTime();
        if (!Number.isSafeInteger(queueDelayMs) || queueDelayMs < 0) throw dataError();
        const event = buildInternalOutboxAudit(
          updated.outbox,
          parent.job,
          candidate.outbox.version,
          capturedNow,
          {
            stage: 'OUTBOX',
            action: 'OUTBOX_CLAIMED',
            outcome: 'SUCCESS',
            queueDelayMs,
          },
        );
        for (const supplied of suppliedEvents) {
          let expectedEventKey;
          try {
            expectedEventKey = createEventKey({
              kind: 'ENTITY',
              companyId: parent.job.companyId,
              shipmentId: parent.job.shipmentId,
              scopeKind: 'JOB',
              scopeId: String(parent.job.id),
              parentVersion: parent.job.version,
              attemptNumber: parent.job.attemptCount,
              stage: supplied.stage,
              action: supplied.action,
              outcome: supplied.outcome,
            });
          } catch {
            throw inputError();
          }
          const started = supplied.outcome === 'STARTED';
          if (supplied.operationKey !== null || EXTERNAL_ACTIONS.has(supplied.action)
              || !OUTBOX_CLAIM_COMPANION_ACTIONS.includes(supplied.action)
              || supplied.eventKey !== expectedEventKey
              || supplied.companyId !== parent.job.companyId
              || supplied.applicationId !== parent.job.applicationId
              || supplied.shipmentId !== parent.job.shipmentId
              || !sameStoredValue(supplied.jobId, encodePositiveLong(parent.job.id))
              || supplied.documentNumber !== parent.job.documentNumber
              || supplied.artifactJobId !== null
              || supplied.attemptNumber !== parent.job.attemptCount
              || supplied.startedAt.getTime() !== supplied.occurredAt.getTime()
              || (started ? supplied.completedAt !== null
                : supplied.completedAt.getTime() !== supplied.occurredAt.getTime())
              || supplied.durationMs !== (started ? null : 0)
              || supplied.queueDelayMs !== null || supplied.retryDelayMs !== null
              || supplied.nextAttemptAt !== null || supplied.safeCode !== null
              || supplied.requestSummary !== null || supplied.responseSummary !== null
              || compareEventTuple(
                supplied.occurredAt,
                supplied.eventKey,
                event.occurredAt,
                event.eventKey,
              ) >= 0) throw inputError();
        }
        await persistAuditEvents(session, [...suppliedEvents, event], capturedNow);
        return updated.outbox;
      });
    });
  }

  function scheduleOutboxRetry(
    outboxId,
    retryState,
    expectedVersion,
    auditEvents = [],
  ) {
    return register(async () => {
      const validated = validateJobIdAndVersion(outboxId, expectedVersion);
      const retry = validateRetryInput(retryState);
      const events = encodeMutationAuditArray(auditEvents);
      const capturedNow = readClock(now);
      return runMutationTransaction(async session => {
        const record = await loadOutboxForMutation(session, validated.encodedJobId);
        assertLiveOutboxMutation(record, expectedVersion, capturedNow);
        const parent = await loadOutboxParent(session, record);
        const clearsPending = validateOutboxMutationAuditBundle(
          events,
          record,
          parent.job,
          expectedVersion,
          { kind: 'RETRY', retry },
        );
        if (clearsPending) {
          await assertOutboxPendingResolutionEvidence(
            session, record, parent.job, capturedNow,
          );
        }
        const updatedDocument = await collectionCall('invoice_outbox', 'findOneAndUpdate', [
          {
            outboxId: record.row.outboxId,
            jobId: record.row.jobId,
            version: expectedVersion,
            status: record.outbox.status,
            attemptCount: record.outbox.attemptCount,
            dueAt: record.row.dueAt,
            leaseOwner: record.row.leaseOwner,
            leaseExpiresAt: record.row.leaseExpiresAt,
            parentState: record.row.parentState,
            parentVersion: record.row.parentVersion,
            pendingOperation: record.row.pendingOperation,
          },
          {
            $set: {
              status: OUTBOX_STATUSES.RETRY_WAIT,
              dueAt: retry.nextAttemptAt,
              nextAttemptAt: retry.nextAttemptAt,
              lastErrorCode: retry.errorCode,
              lastErrorMessage: retry.safeMessage,
              leaseOwner: null,
              leaseExpiresAt: null,
              pendingOperation: null,
            },
            $inc: { version: 1 },
          },
          { returnDocument: 'after', includeResultMetadata: false, session },
        ]);
        if (updatedDocument === null) throw versionConflictError();
        const updated = decodeOutboxRecord(updatedDocument);
        assertExpectedPostImage(updated.row, record.row, {
          status: OUTBOX_STATUSES.RETRY_WAIT,
          dueAt: retry.nextAttemptAt,
          nextAttemptAt: retry.nextAttemptAt,
          lastErrorCode: retry.errorCode,
          lastErrorMessage: retry.safeMessage,
          leaseOwner: null,
          leaseExpiresAt: null,
          pendingOperation: null,
          version: expectedVersion + 1,
        });
        if (updated.outbox.version !== expectedVersion + 1
            || updated.outbox.attemptCount !== record.outbox.attemptCount
            || updated.outbox.status !== OUTBOX_STATUSES.RETRY_WAIT
            || updated.outbox.nextAttemptAt !== retry.nextAttemptAt.toISOString()
            || updated.outbox.leaseOwner !== null || updated.outbox.leaseExpiresAt !== null
            || updated.pendingOperation !== null
            || updated.row.parentVersion !== record.row.parentVersion) throw dataError();
        await persistAuditEvents(session, events, capturedNow);
        return updated.outbox;
      });
    });
  }

  function transitionOutboxAndParent({
    outboxId,
    expectedVersion,
    outboxStatus,
    jobState,
    errorCode,
    safeMessage,
    auditEvents,
    kind,
  }) {
    return register(async () => {
      const validated = validateJobIdAndVersion(outboxId, expectedVersion);
      if (outboxStatus === OUTBOX_STATUSES.INDETERMINATE) {
        validateSafeErrorInput(errorCode, safeMessage);
      }
      const events = encodeMutationAuditArray(auditEvents);
      const capturedNow = readClock(now);
      return runMutationTransaction(async session => {
        const record = await loadOutboxForMutation(session, validated.encodedJobId);
        assertLiveOutboxMutation(record, expectedVersion, capturedNow);
        const parent = await loadOutboxParent(session, record);
        const clearsPending = validateOutboxMutationAuditBundle(
          events,
          record,
          parent.job,
          expectedVersion,
          { kind, terminalCode: errorCode },
        );
        if (clearsPending) {
          await assertOutboxPendingResolutionEvidence(
            session, record, parent.job, capturedNow,
          );
        }
        const updatedParentDocument = await collectionCall('invoice_jobs', 'findOneAndUpdate', [
          {
            jobId: parent.row.jobId,
            companyId: parent.job.companyId,
            version: record.row.parentVersion,
            state: JOB_STATES.FYND_TRANSITION_PENDING,
            pendingOperation: parent.row.pendingOperation,
          },
          {
            $set: {
              state: jobState,
              dueAt: parent.row.createdAt,
              nextAttemptAt: null,
              leaseOwner: null,
              leaseExpiresAt: null,
              lastErrorCode: errorCode,
              lastErrorMessage: safeMessage,
              pendingOperation: null,
              updatedAt: capturedNow,
            },
            $inc: { version: 1 },
          },
          { returnDocument: 'after', includeResultMetadata: false, session },
        ]);
        if (updatedParentDocument === null) throw versionConflictError();
        const updatedParent = decodeJobRecord(updatedParentDocument);
        const parentPostVersion = record.row.parentVersion + 1;
        assertExpectedPostImage(updatedParent.row, parent.row, {
          state: jobState,
          dueAt: parent.row.createdAt,
          nextAttemptAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: errorCode,
          lastErrorMessage: safeMessage,
          pendingOperation: null,
          version: parentPostVersion,
          updatedAt: capturedNow,
        });
        if (updatedParent.job.version !== parentPostVersion
            || updatedParent.job.state !== jobState
            || updatedParent.pendingOperation !== null) throw dataError();

        const updatedOutboxDocument = await collectionCall(
          'invoice_outbox',
          'findOneAndUpdate',
          [
            {
              outboxId: record.row.outboxId,
              jobId: record.row.jobId,
              version: expectedVersion,
              status: record.outbox.status,
              attemptCount: record.outbox.attemptCount,
              dueAt: record.row.dueAt,
              leaseOwner: record.row.leaseOwner,
              leaseExpiresAt: record.row.leaseExpiresAt,
              parentState: JOB_STATES.FYND_TRANSITION_PENDING,
              parentVersion: record.row.parentVersion,
              pendingOperation: record.row.pendingOperation,
            },
            {
              $set: {
                status: outboxStatus,
                dueAt: record.row.createdAt,
                nextAttemptAt: null,
                leaseOwner: null,
                leaseExpiresAt: null,
                lastErrorCode: errorCode,
                lastErrorMessage: safeMessage,
                completedAt: outboxStatus === OUTBOX_STATUSES.COMPLETED
                  ? capturedNow
                  : null,
                parentState: jobState,
                parentVersion: parentPostVersion,
                pendingOperation: null,
              },
              $inc: { version: 1 },
            },
            { returnDocument: 'after', includeResultMetadata: false, session },
          ],
        );
        if (updatedOutboxDocument === null) throw versionConflictError();
        const updatedOutbox = decodeOutboxRecord(updatedOutboxDocument);
        assertExpectedPostImage(updatedOutbox.row, record.row, {
          status: outboxStatus,
          dueAt: record.row.createdAt,
          nextAttemptAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: errorCode,
          lastErrorMessage: safeMessage,
          completedAt: outboxStatus === OUTBOX_STATUSES.COMPLETED ? capturedNow : null,
          parentState: jobState,
          parentVersion: parentPostVersion,
          pendingOperation: null,
          version: expectedVersion + 1,
        });
        if (updatedOutbox.outbox.version !== expectedVersion + 1
            || updatedOutbox.outbox.status !== outboxStatus
            || updatedOutbox.outbox.attemptCount !== record.outbox.attemptCount
            || updatedOutbox.outbox.leaseOwner !== null
            || updatedOutbox.outbox.leaseExpiresAt !== null
            || updatedOutbox.pendingOperation !== null
            || updatedOutbox.row.parentState !== jobState
            || updatedOutbox.row.parentVersion !== parentPostVersion) throw dataError();
        await persistAuditEvents(session, events, capturedNow);
        return deepFreeze({
          outbox: updatedOutbox.outbox,
          job: updatedParent.job,
        });
      });
    });
  }

  function markOutboxIndeterminate(
    outboxId,
    errorCode,
    safeMessage,
    expectedVersion,
    auditEvents = [],
  ) {
    return transitionOutboxAndParent({
      outboxId,
      expectedVersion,
      outboxStatus: OUTBOX_STATUSES.INDETERMINATE,
      jobState: JOB_STATES.INDETERMINATE,
      errorCode,
      safeMessage,
      auditEvents,
      kind: 'INDETERMINATE',
    });
  }

  function completeOutboxAndJob(outboxId, expectedVersion, auditEvents = []) {
    return transitionOutboxAndParent({
      outboxId,
      expectedVersion,
      outboxStatus: OUTBOX_STATUSES.COMPLETED,
      jobState: JOB_STATES.COMPLETED,
      errorCode: null,
      safeMessage: null,
      auditEvents,
      kind: 'COMPLETED',
    });
  }

  function releaseExpiredLeases(releaseTime) {
    return register(async () => {
      const capturedNow = readReleaseTime(releaseTime);
      return runMutationTransaction(async session => {
        const jobProjection = Object.fromEntries([
          ['_id', 0], ...JOB_DOCUMENT_FIELDS.map(field => [field, 1]),
        ]);
        const jobDocuments = await findMany(
          'invoice_jobs',
          {
            state: { $in: ACTIVE_JOB_STATES },
            $and: [
              { leaseOwner: { $exists: true } },
              { leaseExpiresAt: { $exists: true } },
            ],
            leaseOwner: { $ne: null },
            leaseExpiresAt: { $ne: null, $lte: capturedNow },
          },
          jobProjection,
          { leaseExpiresAt: 1, jobId: 1 },
          100,
          session,
        );
        const jobCandidates = jobDocuments.map(decodeJobRecord);
        for (const record of jobCandidates) {
          if (typeof record.row.leaseOwner !== 'string' || record.row.leaseOwner.trim() === ''
              || !(record.row.leaseExpiresAt instanceof Date)
              || record.row.leaseExpiresAt.getTime() > capturedNow.getTime()) throw dataError();
        }

        const outboxProjection = Object.fromEntries([
          ['_id', 0], ...OUTBOX_DOCUMENT_FIELDS.map(field => [field, 1]),
        ]);
        const outboxDocuments = await findMany(
          'invoice_outbox',
          {
            parentState: JOB_STATES.FYND_TRANSITION_PENDING,
            status: { $in: ACTIVE_OUTBOX_STATUSES },
            $and: [
              { leaseOwner: { $exists: true } },
              { leaseExpiresAt: { $exists: true } },
            ],
            leaseOwner: { $ne: null },
            leaseExpiresAt: { $ne: null, $lte: capturedNow },
          },
          outboxProjection,
          { leaseExpiresAt: 1, outboxId: 1 },
          100,
          session,
        );
        const outboxCandidates = outboxDocuments.map(decodeOutboxRecord);
        const outboxWithParents = [];
        for (const record of outboxCandidates) {
          if (typeof record.row.leaseOwner !== 'string' || record.row.leaseOwner.trim() === ''
              || !(record.row.leaseExpiresAt instanceof Date)
              || record.row.leaseExpiresAt.getTime() > capturedNow.getTime()
              || !ACTIVE_OUTBOX_STATUSES.includes(record.outbox.status)) throw dataError();
          const parent = await loadOutboxParent(session, record);
          outboxWithParents.push({ record, parent });
        }

        for (const record of jobCandidates) {
          const updatedDocument = await collectionCall('invoice_jobs', 'findOneAndUpdate', [
            {
              jobId: record.row.jobId,
              version: record.job.version,
              state: record.job.state,
              leaseOwner: record.row.leaseOwner,
              leaseExpiresAt: record.row.leaseExpiresAt,
              pendingOperation: record.row.pendingOperation,
            },
            {
              $set: {
                leaseOwner: null,
                leaseExpiresAt: null,
                updatedAt: capturedNow,
              },
              $inc: { version: 1 },
            },
            { returnDocument: 'after', includeResultMetadata: false, session },
          ]);
          if (updatedDocument === null) throw versionConflictError();
          const updated = decodeJobRecord(updatedDocument);
          assertExpectedPostImage(updated.row, record.row, {
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: capturedNow,
            version: record.job.version + 1,
          });
          if (updated.job.version !== record.job.version + 1
              || updated.job.leaseOwner !== null || updated.job.leaseExpiresAt !== null
              || !sameStoredValue(updated.row.pendingOperation, record.row.pendingOperation)) {
            throw dataError();
          }
          const event = buildInternalJobAudit(updated.job, record.job.version, capturedNow, {
            stage: 'LEASE', action: 'LEASE_RECOVERED', outcome: 'SUCCESS',
          });
          await persistAuditEvents(session, [event], capturedNow);
        }

        for (const { record, parent } of outboxWithParents) {
          const updatedDocument = await collectionCall('invoice_outbox', 'findOneAndUpdate', [
            {
              outboxId: record.row.outboxId,
              jobId: record.row.jobId,
              version: record.outbox.version,
              status: record.outbox.status,
              attemptCount: record.outbox.attemptCount,
              dueAt: record.row.dueAt,
              leaseOwner: record.row.leaseOwner,
              leaseExpiresAt: record.row.leaseExpiresAt,
              parentState: record.row.parentState,
              parentVersion: record.row.parentVersion,
              pendingOperation: record.row.pendingOperation,
            },
            {
              $set: { leaseOwner: null, leaseExpiresAt: null },
              $inc: { version: 1 },
            },
            { returnDocument: 'after', includeResultMetadata: false, session },
          ]);
          if (updatedDocument === null) throw versionConflictError();
          const updated = decodeOutboxRecord(updatedDocument);
          assertExpectedPostImage(updated.row, record.row, {
            leaseOwner: null,
            leaseExpiresAt: null,
            version: record.outbox.version + 1,
          });
          if (updated.outbox.version !== record.outbox.version + 1
              || updated.outbox.attemptCount !== record.outbox.attemptCount
              || updated.outbox.status !== record.outbox.status
              || updated.outbox.leaseOwner !== null || updated.outbox.leaseExpiresAt !== null
              || updated.row.parentVersion !== record.row.parentVersion
              || updated.row.parentState !== record.row.parentState
              || updated.row.dueAt.getTime() !== record.row.dueAt.getTime()
              || !sameStoredValue(updated.row.pendingOperation, record.row.pendingOperation)) {
            throw dataError();
          }
          const event = buildInternalOutboxAudit(
            updated.outbox,
            parent.job,
            record.outbox.version,
            capturedNow,
            { stage: 'LEASE', action: 'LEASE_RECOVERED', outcome: 'SUCCESS' },
          );
          await persistAuditEvents(session, [event], capturedNow);
        }
        return Object.freeze({
          jobs: jobCandidates.length,
          outbox: outboxCandidates.length,
        });
      });
    });
  }

  async function beginJobExternalOperationTransaction(session, prepared, capturedNow) {
    const encodedTargetId = encodePositiveLong(prepared.targetId);
    const currentDocument = await collectionCall('invoice_jobs', 'findOne', [
      { jobId: encodedTargetId },
      { session },
    ]);
    if (currentDocument === null) throw versionConflictError();
    const current = mapJob(currentDocument);
    assertExternalEventMatchesJob(prepared.event, current);
    const currentRow = dataDocument(currentDocument, JOB_DOCUMENT_FIELDS);
    const existingPending = decodePendingOperation(currentRow.pendingOperation);
    if (existingPending !== null) {
      if (!sameStoredValue(currentRow.pendingOperation, prepared.pendingOperation)) {
        throw versionConflictError();
      }
      assertPreparedOperationKey(prepared);
      const storedEvent = await collectionCall('shipment_audit_events', 'findOne', [
        { eventKey: existingPending.eventKey },
        { session },
      ]);
      if (storedEvent !== null) {
        const stored = dataDocument(storedEvent, EVENT_FIELDS);
        decodeAuditEvent(stored);
        if (!sameStoredValue(stored, prepared.event)) throw dataError();
        if (stored.expiresAt.getTime() > capturedNow.getTime()) {
          await assertDuplicateHeadConsistency(session, stored, capturedNow);
        }
      } else {
        assertMissingPendingEventExpired(existingPending, capturedNow);
      }
      return pendingResult(current, existingPending);
    }
    if (current.version !== prepared.expectedVersion
        || !jobAllowsExternalBegin(current, prepared.event, capturedNow)) {
      throw versionConflictError();
    }
    assertPreparedOperationKey(prepared);
    if (prepared.event.expiresAt.getTime() <= capturedNow.getTime()) throw inputError();
    const updatedDocument = await collectionCall('invoice_jobs', 'findOneAndUpdate', [
      {
        jobId: encodedTargetId,
        companyId: current.companyId,
        version: prepared.expectedVersion,
        state: current.state,
        attemptCount: current.attemptCount,
        oeisRequestJson: currentRow.oeisRequestJson,
        requestHash: currentRow.requestHash,
        leaseOwner: currentRow.leaseOwner,
        leaseExpiresAt: currentRow.leaseExpiresAt,
        lockedAt: currentRow.lockedAt,
        pendingOperation: null,
      },
      {
        $set: {
          pendingOperation: prepared.pendingOperation,
          updatedAt: new Date(prepared.event.occurredAt.getTime()),
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session },
    ]);
    if (updatedDocument === null) throw versionConflictError();
    const updated = mapJob(updatedDocument);
    const updatedRow = dataDocument(updatedDocument, JOB_DOCUMENT_FIELDS);
    const storedPending = decodePendingOperation(updatedRow.pendingOperation);
    if (!sameStoredValue(updatedRow.pendingOperation, prepared.pendingOperation)
        || storedPending === null || updated.version !== prepared.expectedVersion + 1) {
      throw dataError();
    }
    await persistAuditEvents(session, [prepared.event], capturedNow);
    decodeAuditEvent(prepared.event);
    return pendingResult(updated, storedPending);
  }

  async function beginOutboxExternalOperationTransaction(session, prepared, capturedNow) {
    const encodedTargetId = encodePositiveLong(prepared.targetId);
    const currentDocument = await collectionCall('invoice_outbox', 'findOne', [
      { outboxId: encodedTargetId },
      { session },
    ]);
    if (currentDocument === null) throw versionConflictError();
    const current = decodeOutboxRecord(currentDocument);
    const parent = await loadOutboxParent(session, current);
    assertExternalEventMatchesOutbox(prepared.event, current.outbox, parent.job, false);
    const existingPending = current.pendingOperation;
    if (existingPending !== null) {
      if (!sameStoredValue(current.row.pendingOperation, prepared.pendingOperation)) {
        throw versionConflictError();
      }
      assertPreparedOperationKey(prepared);
      const storedEvent = await collectionCall('shipment_audit_events', 'findOne', [
        { eventKey: existingPending.eventKey },
        { session },
      ]);
      if (storedEvent !== null) {
        const stored = dataDocument(storedEvent, EVENT_FIELDS);
        decodeAuditEvent(stored);
        if (!sameStoredValue(stored, prepared.event)) throw dataError();
        if (stored.expiresAt.getTime() > capturedNow.getTime()) {
          await assertDuplicateHeadConsistency(session, stored, capturedNow);
        }
      } else {
        assertMissingPendingEventExpired(existingPending, capturedNow);
      }
      return pendingResult(current.outbox, existingPending);
    }
    const liveLease = typeof current.row.leaseOwner === 'string'
      && current.row.leaseOwner.trim() !== ''
      && current.row.leaseExpiresAt instanceof Date
      && current.row.leaseExpiresAt.getTime() > capturedNow.getTime();
    if (current.outbox.version !== prepared.expectedVersion
        || !ACTIVE_OUTBOX_STATUSES.includes(current.outbox.status)
        || !liveLease
        || current.row.parentState !== JOB_STATES.FYND_TRANSITION_PENDING
        || prepared.event.attemptNumber !== current.outbox.attemptCount) {
      throw versionConflictError();
    }
    assertPreparedOperationKey(prepared);
    if (prepared.event.expiresAt.getTime() <= capturedNow.getTime()) throw inputError();
    const updatedDocument = await collectionCall('invoice_outbox', 'findOneAndUpdate', [
      {
        outboxId: current.row.outboxId,
        jobId: current.row.jobId,
        version: prepared.expectedVersion,
        status: current.outbox.status,
        attemptCount: current.outbox.attemptCount,
        dueAt: current.row.dueAt,
        leaseOwner: current.row.leaseOwner,
        leaseExpiresAt: current.row.leaseExpiresAt,
        parentState: current.row.parentState,
        parentVersion: current.row.parentVersion,
        pendingOperation: null,
      },
      {
        $set: { pendingOperation: prepared.pendingOperation },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', includeResultMetadata: false, session },
    ]);
    if (updatedDocument === null) throw versionConflictError();
    const updated = decodeOutboxRecord(updatedDocument);
    assertExpectedPostImage(updated.row, current.row, {
      pendingOperation: prepared.pendingOperation,
      version: prepared.expectedVersion + 1,
    });
    if (!sameStoredValue(updated.row.pendingOperation, prepared.pendingOperation)
        || updated.pendingOperation === null
        || updated.outbox.version !== prepared.expectedVersion + 1
        || updated.row.parentVersion !== current.row.parentVersion) throw dataError();
    await persistAuditEvents(session, [prepared.event], capturedNow);
    decodeAuditEvent(prepared.event);
    return pendingResult(updated.outbox, updated.pendingOperation);
  }

  function beginExternalOperation(input) {
    return register(async () => {
      const prepared = prepareExternalOperationInput(input);
      const capturedNow = readClock(now);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await transaction(session => (
            prepared.targetKind === 'OUTBOX'
              ? beginOutboxExternalOperationTransaction(session, prepared, capturedNow)
              : beginJobExternalOperationTransaction(session, prepared, capturedNow)
          ));
        } catch (error) {
          if (!DUPLICATE_RACES.has(error)) throw error;
          if (attempt === 2) throw busyError();
        }
      }
      throw busyError();
    });
  }

  async function findUnresolvedAuditOperationTransaction(session, query, capturedNow) {
    const jobDocument = await collectionCall('invoice_jobs', 'findOne', [
      { companyId: query.companyId, jobId: encodePositiveLong(query.jobId) },
      { session },
    ]);
    if (jobDocument === null) return null;
    const job = mapJob(jobDocument);
    const jobRow = dataDocument(jobDocument, JOB_DOCUMENT_FIELDS);
    const pending = decodePendingOperation(jobRow.pendingOperation);
    if (pending === null || pending.stage !== query.stage) return null;

    const projection = Object.fromEntries([['_id', 0], ...EVENT_FIELDS.map(field => [field, 1])]);
    const commonFilter = {
      companyId: query.companyId,
      jobId: encodePositiveLong(query.jobId),
      stage: query.stage,
      expiresAt: { $gt: capturedNow },
    };
    const startedDocuments = await findMany(
      'shipment_audit_events',
      { ...commonFilter, outcome: 'STARTED' },
      projection,
      { occurredAt: -1, eventKey: -1 },
      null,
      session,
    );
    const outcomeDocuments = await findMany(
      'shipment_audit_events',
      { ...commonFilter, outcome: { $ne: 'STARTED' } },
      projection,
      { occurredAt: -1, eventKey: -1 },
      null,
      session,
    );
    const starts = startedDocuments.map(document => ({
      stored: dataDocument(document, EVENT_FIELDS),
      decoded: decodeAuditEvent(document),
    }));
    const outcomes = outcomeDocuments.map(decodeAuditEvent);
    const outcomesByOperation = new Set(outcomes.map(event => event.operationKey));
    const startsByOperation = new Map();
    for (const start of starts) {
      const entries = startsByOperation.get(start.decoded.operationKey) || [];
      entries.push(start);
      startsByOperation.set(start.decoded.operationKey, entries);
    }
    if ([...startsByOperation.values()].some(entries => entries.length !== 1)) throw dataError();
    const unresolved = [...startsByOperation.entries()]
      .filter(([operationKey]) => !outcomesByOperation.has(operationKey))
      .map(([, entries]) => entries[0]);
    if (outcomesByOperation.has(pending.operationKey) || unresolved.length > 1
        || (unresolved.length === 1
          && unresolved[0].decoded.operationKey !== pending.operationKey)) throw dataError();

    if (unresolved.length === 1) {
      const match = unresolved[0];
      if (match.decoded.eventKey !== pending.eventKey
          || match.decoded.stage !== pending.stage || match.decoded.action !== pending.action
          || match.decoded.outcome !== 'STARTED'
          || match.decoded.attemptNumber !== pending.attemptNumber
          || match.decoded.startedAt !== pending.startedAt
          || match.decoded.occurredAt !== pending.startedAt
          || match.decoded.companyId !== job.companyId
          || match.decoded.applicationId !== job.applicationId
          || match.decoded.shipmentId !== job.shipmentId
          || match.decoded.jobId !== job.id
          || match.decoded.documentNumber !== job.documentNumber) throw dataError();
      await assertDuplicateHeadConsistency(session, match.stored, capturedNow);
    } else {
      assertMissingPendingEventExpired(pending, capturedNow);
    }
    return pendingResult(job, pending);
  }

  async function findUnresolvedOutboxOperationTransaction(session, query, capturedNow) {
    const parentDocument = await collectionCall('invoice_jobs', 'findOne', [
      { companyId: query.companyId, jobId: encodePositiveLong(query.jobId) },
      { session },
    ]);
    if (parentDocument === null) return null;
    const parent = decodeJobRecord(parentDocument);
    if (parent.pendingOperation !== null) throw dataError();
    const projection = Object.fromEntries([
      ['_id', 0], ...OUTBOX_DOCUMENT_FIELDS.map(field => [field, 1]),
    ]);
    const outboxDocuments = await findMany(
      'invoice_outbox',
      { jobId: encodePositiveLong(query.jobId) },
      projection,
      { outboxId: 1 },
      null,
      session,
    );
    if (outboxDocuments.length === 0) return null;
    if (outboxDocuments.length !== 1) throw dataError();
    const record = decodeOutboxRecord(outboxDocuments[0]);
    const pending = record.pendingOperation;
    if (pending === null) {
      assertOutboxParent(record, parent, false);
      return null;
    }
    if (!ACTIVE_OUTBOX_STATUSES.includes(record.outbox.status)
        || !matchesOutboxParent(record, parent)) throw dataError();
    if (pending.stage !== 'FYND_TRANSITION'
        || pending.targetKind !== 'OUTBOX'
        || pending.targetId !== record.outbox.id) throw dataError();

    const eventProjection = Object.fromEntries([
      ['_id', 0], ...EVENT_FIELDS.map(field => [field, 1]),
    ]);
    const commonFilter = {
      companyId: query.companyId,
      jobId: encodePositiveLong(query.jobId),
      stage: 'FYND_TRANSITION',
      expiresAt: { $gt: capturedNow },
    };
    const startedDocuments = await findMany(
      'shipment_audit_events',
      { ...commonFilter, outcome: 'STARTED' },
      eventProjection,
      { occurredAt: -1, eventKey: -1 },
      null,
      session,
    );
    const outcomeDocuments = await findMany(
      'shipment_audit_events',
      { ...commonFilter, outcome: { $ne: 'STARTED' } },
      eventProjection,
      { occurredAt: -1, eventKey: -1 },
      null,
      session,
    );
    const starts = startedDocuments.map(document => ({
      stored: dataDocument(document, EVENT_FIELDS),
      decoded: decodeAuditEvent(document),
    }));
    const outcomes = outcomeDocuments.map(decodeAuditEvent);
    const outcomesByOperation = new Set(outcomes.map(event => event.operationKey));
    const startsByOperation = new Map();
    for (const start of starts) {
      const entries = startsByOperation.get(start.decoded.operationKey) || [];
      entries.push(start);
      startsByOperation.set(start.decoded.operationKey, entries);
    }
    if ([...startsByOperation.values()].some(entries => entries.length !== 1)) throw dataError();
    const unresolved = [...startsByOperation.entries()]
      .filter(([operationKey]) => !outcomesByOperation.has(operationKey))
      .map(([, entries]) => entries[0]);
    if (outcomesByOperation.has(pending.operationKey) || unresolved.length > 1
        || (unresolved.length === 1
          && unresolved[0].decoded.operationKey !== pending.operationKey)) throw dataError();
    if (unresolved.length === 1) {
      const match = unresolved[0];
      if (match.decoded.eventKey !== pending.eventKey
          || match.decoded.stage !== pending.stage
          || match.decoded.action !== pending.action
          || match.decoded.outcome !== 'STARTED'
          || match.decoded.attemptNumber !== pending.attemptNumber
          || match.decoded.startedAt !== pending.startedAt
          || match.decoded.occurredAt !== pending.startedAt
          || match.decoded.companyId !== parent.job.companyId
          || match.decoded.applicationId !== parent.job.applicationId
          || match.decoded.shipmentId !== parent.job.shipmentId
          || match.decoded.jobId !== parent.job.id
          || match.decoded.documentNumber !== parent.job.documentNumber
          || match.decoded.artifactJobId !== parent.job.id) throw dataError();
      await assertDuplicateHeadConsistency(session, match.stored, capturedNow);
    } else {
      assertMissingPendingEventExpired(pending, capturedNow);
    }
    return pendingResult(record.outbox, pending);
  }

  function findUnresolvedAuditOperation(query) {
    return register(async () => {
      const validated = validateUnresolvedQuery(query);
      const capturedNow = readClock(now);
      return transaction(session => (
        validated.stage === 'FYND_TRANSITION'
          ? findUnresolvedOutboxOperationTransaction(session, validated, capturedNow)
          : findUnresolvedAuditOperationTransaction(session, validated, capturedNow)
      ));
    });
  }

  function listShipmentAuditHeadsForCompany(query) {
    return register(async () => {
      const { companyId, limit, before } = validateAuditHeadQuery(query);
      const capturedNow = readClock(now);
      const projection = Object.fromEntries([['_id', 0], ...HEAD_FIELDS.map(field => [field, 1])]);
      if (before !== null) {
        const anchor = await collectionCall('shipment_audit_heads', 'findOne', [
          {
            companyId,
            lastOccurredAt: before.lastOccurredAt,
            shipmentId: before.shipmentId,
            expiresAt: { $gt: capturedNow },
          },
          { projection },
        ]);
        if (anchor === null) throw readInputError();
        mapAuditHead(anchor);
      }
      const filter = { companyId, expiresAt: { $gt: capturedNow } };
      if (before !== null) {
        filter.$or = [
          { lastOccurredAt: { $lt: before.lastOccurredAt } },
          {
            lastOccurredAt: before.lastOccurredAt,
            shipmentId: { $lt: before.shipmentId },
          },
        ];
      }
      const mapped = (await findMany(
        'shipment_audit_heads',
        filter,
        projection,
        { lastOccurredAt: -1, shipmentId: -1 },
        limit + 1,
      )).map(mapAuditHead);
      const items = mapped.slice(0, limit);
      const last = items[items.length - 1];
      return deepFreeze({
        items,
        nextBefore: mapped.length > limit
          ? { lastOccurredAt: last.lastOccurredAt, shipmentId: last.shipmentId }
          : null,
      });
    });
  }

  function listPreJobFailureHeadsForCompany(query) {
    return register(async () => {
      const { companyId, limit, before } = validateAuditHeadQuery(query);
      const capturedNow = readClock(now);
      const projection = Object.fromEntries([['_id', 0], ...HEAD_FIELDS.map(field => [field, 1])]);
      const feedFilter = {
        companyId,
        jobId: null,
        documentNumber: null,
        lastOutcome: 'FAILURE',
        lastAction: { $in: [...PRE_JOB_FAILURE_ACTIONS] },
        expiresAt: { $gt: capturedNow },
      };
      const mapFailureHead = document => {
        const head = mapAuditHead(document);
        if (head.companyId !== companyId || head.jobId !== null || head.documentNumber !== null
            || head.lastOutcome !== 'FAILURE'
            || !PRE_JOB_FAILURE_ACTIONS.includes(head.lastAction)
            || Date.parse(head.expiresAt) <= capturedNow.getTime()) throw dataError();
        return head;
      };
      if (before !== null) {
        const anchor = await collectionCall('shipment_audit_heads', 'findOne', [
          {
            ...feedFilter,
            lastOccurredAt: before.lastOccurredAt,
            shipmentId: before.shipmentId,
          },
          { projection },
        ]);
        if (anchor === null) throw readInputError();
        mapFailureHead(anchor);
      }
      const filter = { ...feedFilter };
      if (before !== null) {
        filter.$or = [
          { lastOccurredAt: { $lt: before.lastOccurredAt } },
          {
            lastOccurredAt: before.lastOccurredAt,
            shipmentId: { $lt: before.shipmentId },
          },
        ];
      }
      const mapped = (await findMany(
        'shipment_audit_heads',
        filter,
        projection,
        { lastOccurredAt: -1, shipmentId: -1 },
        limit + 1,
      )).map(mapFailureHead);
      const items = mapped.slice(0, limit);
      const last = items[items.length - 1];
      return deepFreeze({
        items,
        nextBefore: mapped.length > limit
          ? { lastOccurredAt: last.lastOccurredAt, shipmentId: last.shipmentId }
          : null,
      });
    });
  }

  function listShipmentAuditEventsForCompany(query) {
    return register(async () => {
      const {
        companyId, shipmentId, limit, before,
      } = validateAuditTimelineQuery(query);
      const capturedNow = readClock(now);
      const projection = Object.fromEntries([['_id', 0], ...EVENT_FIELDS.map(field => [field, 1])]);
      if (before !== null) {
        const anchor = await collectionCall('shipment_audit_events', 'findOne', [
          {
            companyId,
            shipmentId,
            occurredAt: before.occurredAt,
            eventKey: before.eventKey,
            expiresAt: { $gt: capturedNow },
          },
          { projection },
        ]);
        if (anchor === null) throw readInputError();
        decodeAuditEvent(anchor);
      }
      const filter = { companyId, shipmentId, expiresAt: { $gt: capturedNow } };
      if (before !== null) {
        filter.$or = [
          { occurredAt: { $lt: before.occurredAt } },
          { occurredAt: before.occurredAt, eventKey: { $lt: before.eventKey } },
        ];
      }
      const mapped = (await findMany(
        'shipment_audit_events',
        filter,
        projection,
        { occurredAt: -1, eventKey: -1 },
        limit + 1,
      )).map(decodeAuditEvent);
      const items = mapped.slice(0, limit);
      const last = items[items.length - 1];
      return deepFreeze({
        items,
        nextBefore: mapped.length > limit
          ? { occurredAt: last.occurredAt, eventKey: last.eventKey }
          : null,
      });
    });
  }

  function appendAuditEvents(events) {
    return register(async () => {
      let encoded;
      try {
        encoded = encodeAuditArray(events);
      } catch {
        throw inputError();
      }
      const capturedNow = readClock(now);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await transaction(async session => {
            await persistAuditEvents(session, encoded, capturedNow);
          });
          return undefined;
        } catch (error) {
          if (!DUPLICATE_RACES.has(error)) throw error;
          if (attempt === 2) throw busyError();
        }
      }
      throw busyError();
    });
  }

  function futureOperation() {
    return register(async () => { throw notImplementedError(); });
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = Promise.allSettled([...inFlight]).then(() => undefined);
    return closePromise;
  }

  const repository = {
    initialize,
    acceptWebhook,
    claimNextJob,
    savePreparedRequest,
    markShipmentLocked,
    markOeisAcceptedAndEnqueue,
    importHeldOeisResponseAndEnqueue,
    scheduleJobRetry,
    markJobFailed,
    markJobIndeterminate,
    claimNextOutbox,
    scheduleOutboxRetry,
    markOutboxIndeterminate,
    completeOutboxAndJob,
    releaseExpiredLeases,
    getJob,
    getArtifact,
    listDryRunJobsForCompany,
    listFailedJobsForCompany,
    getDryRunJobForCompany,
    getDryRunRequestForCompany,
    appendAuditEvents,
    beginExternalOperation,
    findUnresolvedAuditOperation,
    listShipmentAuditHeadsForCompany,
    listPreJobFailureHeadsForCompany,
    listShipmentAuditEventsForCompany,
    close,
  };
  return Object.freeze(assertMongoInvoiceRepository(repository));
}

module.exports = {
  MONGO_TRANSACTION_TIMEOUT_MS,
  createMongoInvoiceRepository,
};
