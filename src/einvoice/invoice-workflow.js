'use strict';

const crypto = require('crypto');
const { TextDecoder, types } = require('util');

const { EinvoiceError } = require('./errors');
const {
  createAuditBundle,
  createEventKey,
  createOperationKey,
  sanitizeFyndSummary,
  sanitizeOeisSummary,
} = require('./audit/audit-contract');
const {
  JOB_STATES,
  OUTBOX_ACTIONS,
  OUTBOX_STATUSES,
  REQUIRED_REPOSITORY_METHODS,
} = require('./repositories/invoice-repository');

const WORKFLOW_DEPENDENCY_FIELDS = Object.freeze([
  'repository', 'buildPayload', 'oeisClient', 'parseResponse', 'fyndClient',
  'now', 'oeisAudit',
]);
const WORKFLOW_REPOSITORY_METHODS = Object.freeze([
  ...REQUIRED_REPOSITORY_METHODS,
  'appendAuditEvents',
  'beginExternalOperation',
  'findUnresolvedAuditOperation',
]);

const INITIAL_JOB_STATES = new Set([
  JOB_STATES.RECEIVED,
  JOB_STATES.DRY_RUN_RECEIVED,
]);
const LOCK_PENDING_JOB_STATES = new Set([
  JOB_STATES.LOCK_PENDING,
  JOB_STATES.DRY_RUN_LOCK_PENDING,
]);
const RETRY_JOB_STATES = new Set([
  JOB_STATES.RETRY_WAIT,
  JOB_STATES.DRY_RUN_RETRY_WAIT,
]);
const DRY_RUN_JOB_STATES = new Set([
  JOB_STATES.DRY_RUN_RECEIVED,
  JOB_STATES.DRY_RUN_LOCK_PENDING,
  JOB_STATES.DRY_RUN_RETRY_WAIT,
]);
const LOCK_STAGE_JOB_STATES = new Set([
  ...LOCK_PENDING_JOB_STATES,
  ...RETRY_JOB_STATES,
]);
const OEIS_STAGE_JOB_STATES = new Set([
  JOB_STATES.LOCKED,
  JOB_STATES.RETRY_WAIT,
]);
const JOB_PROCESSABLE_STATES = new Set([
  ...INITIAL_JOB_STATES,
  ...LOCK_STAGE_JOB_STATES,
  JOB_STATES.LOCKED,
]);
const RETURNED_JOB_IMMUTABLE_FIELDS = Object.freeze([
  'id', 'companyId', 'applicationId', 'shipmentId', 'documentType',
  'documentNumber', 'attemptCount',
]);
const RETURNED_JOB_FIELDS = Object.freeze([
  ...RETURNED_JOB_IMMUTABLE_FIELDS,
  'shipmentSnapshot', 'state', 'oeisRequestJson', 'requestHash', 'lockedAt',
  'leaseOwner', 'leaseExpiresAt', 'nextAttemptAt', 'version',
]);
const OUTBOX_PROCESSABLE_STATUSES = new Set([
  OUTBOX_STATUSES.PENDING,
  OUTBOX_STATUSES.RETRY_WAIT,
]);
const LOCK_AMBIGUOUS_CODES = new Set([
  'FYND_TIMEOUT',
  'FYND_NETWORK',
  'FYND_HTTP_429',
  'FYND_HTTP_5XX',
  'FYND_LOCK_RESPONSE_INVALID',
  'FYND_REQUEST_FAILED',
]);
const OEIS_DETERMINISTIC_CODES = new Set([
  'OEIS_HTTP_4XX',
  'OEIS_REQUEST_TOO_LARGE',
]);
const OEIS_INDETERMINATE_CODES = new Set([
  'OEIS_RESPONSE_TOO_LARGE',
  'OEIS_MALFORMED_RESPONSE',
]);
const TRANSITION_AMBIGUOUS_CODES = new Set([
  'FYND_TIMEOUT',
  'FYND_NETWORK',
  'FYND_HTTP_429',
  'FYND_HTTP_5XX',
  'FYND_TRANSITION_RESPONSE_INVALID',
  'FYND_REQUEST_FAILED',
]);

function fail(code, message) {
  throw new EinvoiceError(code, message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainRecord(value) {
  if (!isObject(value)) return false;
  try {
    return !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function hasOwn(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
      && Object.prototype.hasOwnProperty.call(descriptor, 'value');
  } catch {
    return false;
  }
}

function hasOwnFields(value, fields) {
  return fields.every(field => hasOwn(value, field));
}

function ownDataSnapshot(value, fields, { exact = false } = {}) {
  try {
    if (value === null || typeof value !== 'object' || types.isProxy(value)
        || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    if (exact) {
      const keys = Reflect.ownKeys(value);
      if (keys.length !== fields.length
          || keys.some(key => typeof key !== 'string' || !fields.includes(key))) return null;
    }
    const snapshot = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (descriptor === undefined
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      snapshot[field] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function callablePortSnapshot(value, methods) {
  const values = ownDataSnapshot(value, methods);
  if (values === null) return null;
  const snapshot = {};
  for (const method of methods) {
    if (typeof values[method] !== 'function' || types.isProxy(values[method])) return null;
    snapshot[method] = values[method].bind(value);
  }
  return Object.freeze(snapshot);
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function hasIdentityValue(value) {
  return value !== undefined && value !== null && value !== '';
}

function isIsoInstant(value) {
  if (!isNonemptyString(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNullableIsoInstant(value) {
  return value === null || isIsoInstant(value);
}

function hasSaneLease(record, claimed) {
  if (!hasOwnFields(record, ['leaseOwner', 'leaseExpiresAt'])) return false;
  if (claimed) return isNonemptyString(record.leaseOwner) && isIsoInstant(record.leaseExpiresAt);
  return (record.leaseOwner === null && record.leaseExpiresAt === null)
    || (isNonemptyString(record.leaseOwner) && isIsoInstant(record.leaseExpiresAt));
}

function safeCode(error, fallback) {
  try {
    if (error === null || typeof error !== 'object' || types.isProxy(error)
        || Object.getPrototypeOf(error) !== EinvoiceError.prototype) return fallback;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    if (descriptor === undefined
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return fallback;
    return typeof descriptor.value === 'string'
      && /^[A-Z][A-Z0-9_]{1,63}$/.test(descriptor.value)
      ? descriptor.value
      : fallback;
  } catch {
    return fallback;
  }
}

function validateRetryPlan(retryPlan) {
  let valid = false;
  try {
    valid = isPlainRecord(retryPlan)
      && !types.isProxy(retryPlan)
      && Reflect.ownKeys(retryPlan).length === 3
      && Reflect.ownKeys(retryPlan).every(
        key => key === 'exhausted' || key === 'overLimit' || key === 'retryDelayMs',
      )
      && hasOwnFields(retryPlan, ['exhausted', 'overLimit', 'retryDelayMs'])
      && typeof retryPlan.exhausted === 'boolean'
      && typeof retryPlan.overLimit === 'boolean'
      && (!retryPlan.overLimit || retryPlan.exhausted)
      && typeof retryPlan.retryDelayMs === 'function'
      && !types.isProxy(retryPlan.retryDelayMs);
  } catch {
    valid = false;
  }
  if (!valid) {
    fail('WORKFLOW_INPUT_INVALID', 'Invoice workflow input is invalid');
  }
  return retryPlan;
}

function validateJob(job) {
  let valid = false;
  try {
    valid = isPlainRecord(job)
      && hasOwnFields(job, [
        'id', 'companyId', 'applicationId', 'shipmentId', 'documentType',
        'documentNumber', 'shipmentSnapshot', 'state', 'oeisRequestJson',
        'requestHash', 'lockedAt', 'attemptCount', 'leaseOwner',
        'leaseExpiresAt', 'version',
      ])
      && Number.isSafeInteger(job.id) && job.id > 0
      && Number.isSafeInteger(job.version) && job.version >= 0
      && Number.isSafeInteger(job.attemptCount) && job.attemptCount > 0
      && isNonemptyString(job.companyId)
      && (job.applicationId === null || isNonemptyString(job.applicationId))
      && isNonemptyString(job.shipmentId)
      && isNonemptyString(job.documentType)
      && isNonemptyString(job.documentNumber)
      && isPlainRecord(job.shipmentSnapshot)
      && (job.oeisRequestJson === null || typeof job.oeisRequestJson === 'string')
      && (job.requestHash === null || typeof job.requestHash === 'string')
      && (job.lockedAt === null || isIsoInstant(job.lockedAt))
      && hasSaneLease(job, true)
      && JOB_PROCESSABLE_STATES.has(job.state);
  } catch {
    valid = false;
  }
  if (!valid) {
    fail('WORKFLOW_INPUT_INVALID', 'Invoice workflow input is invalid');
  }
  return job;
}

function validateOutbox(outbox) {
  let valid = false;
  try {
    valid = isPlainRecord(outbox)
      && hasOwnFields(outbox, [
        'id', 'jobId', 'action', 'payload', 'status', 'attemptCount',
        'leaseOwner', 'leaseExpiresAt', 'version',
      ])
      && Number.isSafeInteger(outbox.id) && outbox.id > 0
      && Number.isSafeInteger(outbox.jobId) && outbox.jobId > 0
      && Number.isSafeInteger(outbox.version) && outbox.version >= 0
      && Number.isSafeInteger(outbox.attemptCount) && outbox.attemptCount > 0
      && hasSaneLease(outbox, true)
      && OUTBOX_PROCESSABLE_STATUSES.has(outbox.status);
  } catch {
    valid = false;
  }
  if (!valid) {
    fail('WORKFLOW_INPUT_INVALID', 'Invoice workflow input is invalid');
  }
  return outbox;
}

function sha256Utf8(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function validateRequestBytes(requestJson, storedHash, documentNumber) {
  if (!isNonemptyString(requestJson) || !isNonemptyString(storedHash)
      || sha256Utf8(requestJson) !== storedHash) return false;
  let rows;
  try {
    rows = JSON.parse(requestJson);
  } catch {
    return false;
  }
  return Array.isArray(rows) && rows.length > 0
    && rows.every(row => {
      try {
        return isPlainRecord(row)
          && hasOwn(row, 'TRAN_DOC_NO')
          && isNonemptyString(row.TRAN_DOC_NO)
          && row.TRAN_DOC_NO === documentNumber;
      } catch {
        return false;
      }
    });
}

function validatePreparedPayload(prepared, job) {
  let valid = false;
  let identityMismatch = false;
  try {
    identityMismatch = isPlainRecord(prepared)
      && hasOwn(prepared, 'documentNumber')
      && prepared.documentNumber !== job.documentNumber;
    valid = isPlainRecord(prepared)
      && hasOwnFields(prepared, ['documentNumber', 'rows', 'requestJson', 'requestHash'])
      && prepared.documentNumber === job.documentNumber
      && Array.isArray(prepared.rows) && prepared.rows.length > 0
      && isNonemptyString(prepared.requestJson) && isNonemptyString(prepared.requestHash)
      && validateRequestBytes(prepared.requestJson, prepared.requestHash, job.documentNumber);
  } catch {
    valid = false;
  }
  if (!valid) {
    const code = identityMismatch
      ? 'DOCUMENT_IDENTITY_MISMATCH'
      : 'PREPARED_REQUEST_INVALID';
    throw new EinvoiceError(code, 'Prepared invoice request is invalid');
  }
}

function inheritedField(record, key) {
  return !hasOwn(record, key) && key in record;
}

function pristineMetadata(record) {
  if (inheritedField(record, 'meta')) return false;
  if (!hasOwn(record, 'meta') || record.meta === undefined || record.meta === null) return true;
  if (!isPlainRecord(record.meta)) return false;
  if (inheritedField(record.meta, 'einvoice_info')
      || inheritedField(record.meta, 'shipment_meta')) return false;
  return !hasOwn(record.meta, 'einvoice_info') && !hasOwn(record.meta, 'shipment_meta');
}

function pristineLockState(shipment, job, locked) {
  try {
    return isPlainRecord(shipment)
      && hasOwnFields(shipment, ['shipmentId', 'status', 'locked'])
      && shipment.shipmentId === job.shipmentId
      && shipment.status === 'bag_confirmed'
      && shipment.locked === locked
      && !inheritedField(shipment, 'invoiceId')
      && (!hasOwn(shipment, 'invoiceId') || !hasIdentityValue(shipment.invoiceId))
      && pristineMetadata(shipment);
  } catch {
    return false;
  }
}

function transitionCompleteState(shipment, job, artifact, signedXml) {
  try {
    if (!isPlainRecord(shipment)
        || !hasOwnFields(shipment, ['shipmentId', 'status', 'locked', 'invoiceId', 'meta'])
        || !isPlainRecord(shipment.meta)
        || !hasOwnFields(shipment.meta, ['einvoice_info', 'shipment_meta'])
        || !isPlainRecord(shipment.meta.einvoice_info)
        || !hasOwn(shipment.meta.einvoice_info, 'SignedQRCode')
        || !isPlainRecord(shipment.meta.shipment_meta)
        || !hasOwn(shipment.meta.shipment_meta, 'xml')
        || !isPlainRecord(shipment.meta.shipment_meta.xml)
        || !hasOwnFields(shipment.meta.shipment_meta.xml, ['content', 'filename'])) return false;
    return shipment.shipmentId === job.shipmentId
      && shipment.status === 'bag_invoiced'
      && shipment.locked === false
      && shipment.invoiceId === job.documentNumber
      && shipment.meta.einvoice_info.SignedQRCode === artifact.signedXmlBase64
      && shipment.meta.shipment_meta.xml.content === signedXml
      && shipment.meta.shipment_meta.xml.filename === `${job.documentNumber}.xml`;
  } catch {
    return false;
  }
}

function classifyTransitionReadback(shipment, job, artifact, signedXml) {
  if (transitionCompleteState(shipment, job, artifact, signedXml)) return 'complete';
  if (pristineLockState(shipment, job, true)) return 'pre';
  return 'indeterminate';
}

function decodeArtifact(artifact, job, { stored }) {
  try {
    if (!isPlainRecord(artifact)
        || !hasOwnFields(artifact, [
          'invoiceNumber', 'transactionNumber', 'uuid', 'invoiceCounter',
          'matchingKey', 'responseStatus', 'signedXmlBase64', 'signedXmlSha256',
        ])
        || (stored && (!hasOwn(artifact, 'jobId')
          || !Number.isSafeInteger(artifact.jobId) || artifact.jobId !== job.id))
        || artifact.invoiceNumber !== job.documentNumber
        || !isNonemptyString(artifact.transactionNumber)
        || !isNonemptyString(artifact.uuid)
        || !isNonemptyString(artifact.invoiceCounter)
        || !isNonemptyString(artifact.matchingKey)
        || artifact.responseStatus !== 'OEIS_ACCEPTED_REPORTING_PENDING'
        || !isNonemptyString(artifact.signedXmlBase64)
        || !isNonemptyString(artifact.signedXmlSha256)
        || artifact.signedXmlBase64.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(artifact.signedXmlBase64)) {
      return null;
    }
    const bytes = Buffer.from(artifact.signedXmlBase64, 'base64');
    if (bytes.toString('base64') !== artifact.signedXmlBase64
        || crypto.createHash('sha256').update(bytes).digest('hex') !== artifact.signedXmlSha256) {
      return null;
    }
    const signedXml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!isNonemptyString(signedXml) || signedXml.includes('\0') || signedXml.includes('\uFFFD')) return null;
    return signedXml;
  } catch {
    return null;
  }
}

function validateFreshArtifact(artifact, job) {
  try {
    if (!isPlainRecord(artifact) || !hasOwn(artifact, 'invoiceNumber')) {
      return { code: 'OEIS_ARTIFACT_INVALID', signedXml: null, artifactForStorage: null };
    }
    if (artifact.invoiceNumber !== job.documentNumber) {
      return { code: 'OEIS_IDENTITY_MISMATCH', signedXml: null, artifactForStorage: null };
    }
    const signedXml = decodeArtifact(artifact, job, { stored: false });
    if (signedXml === null || !hasOwn(artifact, 'signedXml') || artifact.signedXml !== signedXml) {
      return { code: 'OEIS_ARTIFACT_INVALID', signedXml: null, artifactForStorage: null };
    }
    const artifactForStorage = normalizeFreshArtifactForStorage(artifact);
    if (artifactForStorage === null) {
      return { code: 'OEIS_ARTIFACT_INVALID', signedXml: null, artifactForStorage: null };
    }
    return { code: null, signedXml, artifactForStorage };
  } catch {
    return { code: 'OEIS_ARTIFACT_INVALID', signedXml: null, artifactForStorage: null };
  }
}

function normalizeFreshArtifactForStorage(artifact) {
  const fields = snapshotOwnDataRecord(artifact, [
    'invoiceNumber', 'transactionNumber', 'uuid', 'invoiceCounter',
    'matchingKey', 'responseStatus', 'signedXmlBase64', 'signedXml',
    'signedXmlSha256',
  ]);
  if (fields === null) return null;
  let qrCodeData = null;
  try {
    const qr = ownValue(artifact, 'qrCodeData');
    if (qr.found && typeof qr.value === 'string' && qr.value.length > 0) {
      qrCodeData = qr.value;
    }
  } catch {
    qrCodeData = null;
  }
  return { ...fields, qrCodeData };
}

function validStoredJobForOutbox(job, outbox) {
  try {
    return isPlainRecord(job)
      && hasOwnFields(job, [
        'id', 'companyId', 'applicationId', 'shipmentId', 'documentType',
        'documentNumber', 'shipmentSnapshot', 'state', 'oeisRequestJson',
        'requestHash', 'lockedAt', 'attemptCount', 'leaseOwner',
        'leaseExpiresAt', 'version',
      ])
      && Number.isSafeInteger(job.id) && job.id === outbox.jobId
      && Number.isSafeInteger(job.version) && job.version >= 0
      && Number.isSafeInteger(job.attemptCount) && job.attemptCount > 0
      && isNonemptyString(job.companyId)
      && (job.applicationId === null || isNonemptyString(job.applicationId))
      && isNonemptyString(job.shipmentId)
      && isNonemptyString(job.documentType)
      && isNonemptyString(job.documentNumber)
      && isPlainRecord(job.shipmentSnapshot)
      && validateRequestBytes(job.oeisRequestJson, job.requestHash, job.documentNumber)
      && isIsoInstant(job.lockedAt)
      && hasSaneLease(job, false)
      && job.state === JOB_STATES.FYND_TRANSITION_PENDING
      && job.shipmentId === outbox.payload.shipmentId
      && job.documentNumber === outbox.payload.documentNumber;
  } catch {
    return false;
  }
}

function validAuditParentForOutbox(job, outbox) {
  try {
    return isPlainRecord(job)
      && hasOwnFields(job, [
        'id', 'companyId', 'applicationId', 'shipmentId', 'documentNumber',
      ])
      && Number.isSafeInteger(job.id) && job.id === outbox.jobId
      && isNonemptyString(job.companyId)
      && (job.applicationId === null || isNonemptyString(job.applicationId))
      && isNonemptyString(job.shipmentId)
      && isNonemptyString(job.documentNumber);
  } catch {
    return false;
  }
}

function validOutboxPayload(outbox) {
  try {
    return outbox.action === OUTBOX_ACTIONS.FYND_TRANSITION
      && isPlainRecord(outbox.payload)
      && Object.keys(outbox.payload).length === 2
      && hasOwnFields(outbox.payload, ['shipmentId', 'documentNumber'])
      && isNonemptyString(outbox.payload.shipmentId)
      && isNonemptyString(outbox.payload.documentNumber);
  } catch {
    return false;
  }
}

function repositoryDataError() {
  return new EinvoiceError(
    'WORKFLOW_REPOSITORY_DATA_INVALID',
    'Invoice repository returned invalid data',
  );
}

function readWorkflowClock(now) {
  let value;
  try {
    value = now();
  } catch {
    fail('AUDIT_CLOCK_INVALID', 'Shipment audit clock is invalid');
  }
  try {
    if (value === null || typeof value !== 'object' || types.isProxy(value)
        || Object.getPrototypeOf(value) !== Date.prototype
        || Reflect.ownKeys(value).length !== 0
        || !Number.isFinite(Date.prototype.getTime.call(value))) {
      fail('AUDIT_CLOCK_INVALID', 'Shipment audit clock is invalid');
    }
    return new Date(Date.prototype.getTime.call(value));
  } catch (error) {
    if (error instanceof EinvoiceError) throw error;
    fail('AUDIT_CLOCK_INVALID', 'Shipment audit clock is invalid');
  }
}

function auditBundleAt(inputs, occurredAt) {
  return createAuditBundle(inputs, {
    now: () => new Date(Date.prototype.getTime.call(occurredAt)),
  });
}

function entityAuditInput(job, target, {
  stage,
  action,
  outcome,
  startedAt = null,
  completedAt = null,
  retryDelayMs = null,
  safeCode: eventSafeCode = null,
  requestSummary = null,
  responseSummary = null,
  artifactJobId = null,
}) {
  const outboxTarget = target !== job;
  const scopeKind = outboxTarget ? 'OUTBOX' : 'JOB';
  const scopeId = String(target.id);
  return {
    eventKey: createEventKey({
      kind: 'ENTITY',
      companyId: job.companyId,
      shipmentId: job.shipmentId,
      scopeKind,
      scopeId,
      parentVersion: target.version,
      attemptNumber: target.attemptCount,
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
    attemptNumber: target.attemptCount,
    startedAt,
    completedAt,
    queueDelayMs: null,
    retryDelayMs,
    safeCode: eventSafeCode,
    requestSummary,
    responseSummary,
    artifactJobId,
  };
}

function operationAuditInput(job, {
  operationKey,
  stage,
  action,
  outcome,
  attemptNumber,
  startedAt,
  completedAt = null,
  safeCode: eventSafeCode = null,
  requestSummary = null,
  responseSummary = null,
  artifactJobId = null,
}) {
  return {
    eventKey: createEventKey({ kind: 'OPERATION', operationKey, stage, action, outcome }),
    operationKey,
    companyId: job.companyId,
    applicationId: job.applicationId,
    shipmentId: job.shipmentId,
    jobId: job.id,
    documentNumber: job.documentNumber,
    stage,
    action,
    outcome,
    attemptNumber,
    startedAt,
    completedAt,
    queueDelayMs: null,
    retryDelayMs: null,
    safeCode: eventSafeCode,
    requestSummary,
    responseSummary,
    artifactJobId,
  };
}

function exactRecoveryValue(value, expected) {
  let fields;
  try {
    if (!isPlainRecord(value) || Reflect.ownKeys(value).length !== 9) throw repositoryDataError();
    fields = snapshotOwnDataRecord(value, [
      'targetKind', 'targetId', 'operationKey', 'eventKey', 'stage', 'action',
      'attemptNumber', 'startedAt', 'targetVersion',
    ]);
    if (fields === null
        || fields.targetKind !== expected.targetKind
        || fields.targetId !== String(expected.targetId)
        || fields.stage !== expected.stage
        || fields.action !== expected.action
        || !Number.isSafeInteger(fields.attemptNumber) || fields.attemptNumber < 1
        || !isIsoInstant(fields.startedAt)
        || !Number.isSafeInteger(fields.targetVersion) || fields.targetVersion < 0
        || (expected.targetVersion !== undefined && fields.targetVersion !== expected.targetVersion)
        || (expected.attemptNumber !== undefined && fields.attemptNumber !== expected.attemptNumber)
        || (expected.operationKey !== undefined && fields.operationKey !== expected.operationKey)
        || fields.eventKey !== createEventKey({
          kind: 'OPERATION', operationKey: fields.operationKey,
          stage: fields.stage, action: fields.action, outcome: 'STARTED',
        })) throw repositoryDataError();
  } catch (error) {
    if (error instanceof EinvoiceError && error.code === 'WORKFLOW_REPOSITORY_DATA_INVALID') throw error;
    throw repositoryDataError();
  }
  return Object.freeze({ ...fields });
}

function jobAtVersion(job, version) {
  return { ...job, version };
}

function ownValue(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? { found: true, value: descriptor.value }
    : { found: false, value: undefined };
}

function deriveOeisRequestSummary(job, oeisAudit) {
  let rows;
  try {
    rows = JSON.parse(job.oeisRequestJson);
  } catch {
    throw repositoryDataError();
  }
  if (!Array.isArray(rows) || types.isProxy(rows) || rows.length < 1 || rows.length > 1_000) {
    throw repositoryDataError();
  }
  let invoice;
  const taxGroups = new Map();
  for (const row of rows) {
    if (!isPlainRecord(row)) throw repositoryDataError();
    const values = {};
    for (const key of [
      'TRAN_DOC_NO', 'TRAN_DOC_TYPE', 'INV_CURRENCY_CODE', 'INV_NET_AMOUNT',
      'INV_TOTAL_TAX_AMOUNT', 'INV_TOTAL_AMOUNT', 'TRAN_TAX_CODE_CATEGORY',
      'TRAN_TAX_RATE',
    ]) {
      const field = ownValue(row, key);
      if (!field.found) throw repositoryDataError();
      values[key] = field.value;
    }
    const reason = ownValue(row, 'TRAN_VAT_EXEMPT_REASON_CODE');
    values.reasonCode = reason.found ? reason.value : null;
    if (values.reasonCode === undefined) throw repositoryDataError();
    const current = {
      documentNumber: values.TRAN_DOC_NO,
      documentType: values.TRAN_DOC_TYPE,
      currency: values.INV_CURRENCY_CODE,
      netAmount: values.INV_NET_AMOUNT,
      taxAmount: values.INV_TOTAL_TAX_AMOUNT,
      totalAmount: values.INV_TOTAL_AMOUNT,
    };
    if (current.documentNumber !== job.documentNumber
        || current.documentType !== job.documentType
        || current.currency !== 'SAR') throw repositoryDataError();
    if (invoice === undefined) invoice = current;
    else if (Object.keys(current).some(key => current[key] !== invoice[key])) {
      throw repositoryDataError();
    }
    const group = {
      category: values.TRAN_TAX_CODE_CATEGORY,
      rate: values.TRAN_TAX_RATE,
      reasonCode: values.reasonCode,
    };
    const key = `${group.category}\u0000${group.rate}\u0000${group.reasonCode ?? ''}`;
    const existing = taxGroups.get(key);
    taxGroups.set(key, existing ? { ...existing, lineCount: existing.lineCount + 1 }
      : { ...group, lineCount: 1 });
  }
  const taxSummaries = [...taxGroups.values()].sort((left, right) => (
    left.category.localeCompare(right.category)
      || left.rate.localeCompare(right.rate)
      || (left.reasonCode ?? '').localeCompare(right.reasonCode ?? '')
  ));
  return sanitizeOeisSummary('REQUEST', {
    ...invoice,
    lineCount: rows.length,
    taxSummaries,
    requestByteCount: Buffer.byteLength(job.oeisRequestJson, 'utf8'),
    requestSha256: job.requestHash,
    endpointPath: oeisAudit.endpointPath,
    attemptNumber: job.attemptCount,
    timeoutMs: oeisAudit.timeoutMs,
  });
}

function safePrintable(value, maximumBytes = 512) {
  return typeof value === 'string' && /^[\x20-\x7e]+$/.test(value)
    && /[!-~]/.test(value) && Buffer.byteLength(value, 'utf8') <= maximumBytes
    ? value
    : null;
}

function acceptedOeisSummaries(response, accepted, latencyMs, job) {
  const uuid = safePrintable(accepted.uuid);
  const canonicalUuid = uuid !== null
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)
    ? uuid
    : null;
  const responseSummary = sanitizeOeisSummary('RESPONSE', {
    httpStatus: response.httpStatus,
    isSystemException: false,
    validationResult: 'VALID',
    reportingStatus: 'PENDING',
    clearanceStatus: null,
    invoiceNumber: safePrintable(accepted.invoiceNumber),
    transactionNumber: safePrintable(accepted.transactionNumber),
    uuid: canonicalUuid,
    invoiceCounter: safePrintable(accepted.invoiceCounter),
    matchingKey: safePrintable(accepted.matchingKey),
    validationCodes: [],
    responseByteCount: response.responseByteCount,
    responseSha256: response.responseSha256,
    retryable: false,
    latencyMs,
  });
  let qr = null;
  try {
    const qrCodeData = ownValue(accepted, 'qrCodeData');
    if (qrCodeData.found
        && typeof qrCodeData.value === 'string' && qrCodeData.value.length > 0) {
      qr = Buffer.from(qrCodeData.value, 'utf8');
    }
  } catch {
    qr = null;
  }
  const artifactSummary = sanitizeOeisSummary('ARTIFACT', {
    signedXmlPresent: true,
    signedXmlByteCount: Buffer.from(accepted.signedXmlBase64, 'base64').length,
    signedXmlSha256: accepted.signedXmlSha256,
    qrPresent: qr !== null,
    qrByteCount: qr === null ? null : qr.length,
    qrSha256: qr === null ? null : crypto.createHash('sha256').update(qr).digest('hex'),
  });
  return { responseSummary, artifactSummary, artifactJobId: job.id };
}

function oeisFailureSummary(code, latencyMs, response = null) {
  const result = ownDataSnapshot(response, ['httpStatus']);
  const httpStatus = code === 'OEIS_HTTP_429'
    ? 429
    : (result !== null && Number.isInteger(result.httpStatus)
      && result.httpStatus >= 100 && result.httpStatus <= 599
      ? result.httpStatus : null);
  return sanitizeOeisSummary('RESPONSE', {
    httpStatus,
    isSystemException: null,
    validationResult: 'UNKNOWN',
    reportingStatus: null,
    clearanceStatus: null,
    invoiceNumber: null,
    transactionNumber: null,
    uuid: null,
    invoiceCounter: null,
    matchingKey: null,
    validationCodes: [],
    responseByteCount: null,
    responseSha256: null,
    retryable: ['OEIS_HTTP_429', 'OEIS_TIMEOUT', 'OEIS_NETWORK', 'OEIS_HTTP_5XX'].includes(code),
    latencyMs,
  });
}

function retrySchedule(plan, schedulingAt) {
  let delay;
  try {
    delay = plan.retryDelayMs();
  } catch {
    fail('WORKFLOW_INPUT_INVALID', 'Invoice workflow input is invalid');
  }
  const base = schedulingAt.getTime();
  const next = base + delay;
  if (!Number.isSafeInteger(delay) || delay < 0 || !Number.isSafeInteger(next)
      || !Number.isFinite(new Date(next).getTime())) {
    fail('WORKFLOW_INPUT_INVALID', 'Invoice workflow input is invalid');
  }
  return { delay, nextAttemptAt: new Date(next).toISOString() };
}

function fyndResponseStatus(code, result = null) {
  if (code === 'FYND_HTTP_429') return 429;
  if (result !== null) {
    try {
      const field = ownValue(result, 'responseStatus');
      if (field.found && (field.value === null
          || (Number.isInteger(field.value) && field.value >= 100 && field.value <= 599))) {
        return field.value;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function fyndState(result) {
  try {
    const field = ownValue(result, 'status');
    return field.found && typeof field.value === 'string'
      && /^[a-z][a-z0-9_]{0,63}$/.test(field.value) ? field.value : null;
  } catch {
    return null;
  }
}

function fyndResponseSummary({
  operation, job, result = null, code = null, locked = null,
  shipmentState = null, classification, retryable, latencyMs,
}) {
  return sanitizeFyndSummary('RESPONSE', {
    operation,
    shipmentId: job.shipmentId,
    documentNumber: job.documentNumber,
    responseStatus: fyndResponseStatus(code, result),
    locked,
    shipmentState,
    finalStateClassification: classification,
    retryable,
    latencyMs,
  });
}

function snapshotOwnDataRecord(record, fields) {
  try {
    if (record === null || typeof record !== 'object' || types.isProxy(record)
        || !isObject(record) || Array.isArray(record)
        || Object.getPrototypeOf(record) !== Object.prototype) return null;
    const snapshot = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(record, field);
      if (descriptor === undefined || !hasOwn(descriptor, 'value')) return null;
      snapshot[field] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function hasExpectedLease(previous, returned, expectation, previousNextAttemptAt) {
  if (!hasOwnFields(returned, ['leaseOwner', 'leaseExpiresAt', 'nextAttemptAt'])
      || !isNullableIsoInstant(returned.nextAttemptAt)) return false;
  if (expectation === 'retained') {
    return hasSaneLease(returned, true)
      && returned.leaseOwner === previous.leaseOwner
      && returned.leaseExpiresAt === previous.leaseExpiresAt
      && returned.nextAttemptAt === previousNextAttemptAt;
  }
  if (expectation === 'cleared') {
    return returned.leaseOwner === null
      && returned.leaseExpiresAt === null
      && returned.nextAttemptAt === null;
  }
  return false;
}

function validateReturnedJob(previous, returned, expected) {
  let valid = false;
  let snapshot = null;
  try {
    snapshot = snapshotOwnDataRecord(returned, RETURNED_JOB_FIELDS);
    const previousNextAttemptAt = hasOwn(previous, 'nextAttemptAt')
      ? previous.nextAttemptAt
      : null;
    valid = snapshot !== null
      && isNullableIsoInstant(previousNextAttemptAt)
      && RETURNED_JOB_IMMUTABLE_FIELDS.every(
        field => snapshot[field] === previous[field],
      )
      && isPlainRecord(snapshot.shipmentSnapshot)
      && hasExpectedLease(
        previous, snapshot, expected.leaseExpectation, previousNextAttemptAt,
      )
      && snapshot.state === expected.state
      && snapshot.oeisRequestJson === expected.oeisRequestJson
      && snapshot.requestHash === expected.requestHash
      && (expected.lockedAtRequired
        ? isIsoInstant(snapshot.lockedAt)
        : snapshot.lockedAt === expected.lockedAt)
      && Number.isSafeInteger(snapshot.version)
      && snapshot.version === previous.version + 1;
  } catch {
    valid = false;
  }
  if (!valid) throw repositoryDataError();
  return snapshot;
}

function createInvoiceWorkflow(deps = {}) {
  let repository;
  let buildPayload;
  let oeisClient;
  let parseResponse;
  let fyndClient;
  let now;
  let oeisAudit;
  let valid = false;
  try {
    const values = ownDataSnapshot(deps, WORKFLOW_DEPENDENCY_FIELDS, { exact: true });
    if (values === null) throw new Error('invalid workflow configuration');
    repository = callablePortSnapshot(values.repository, WORKFLOW_REPOSITORY_METHODS);
    const oeisPort = callablePortSnapshot(values.oeisClient, ['submit']);
    const fyndPort = callablePortSnapshot(values.fyndClient, [
      'lockShipment', 'getShipment', 'transitionToInvoiced',
    ]);
    const auditValues = ownDataSnapshot(values.oeisAudit, ['endpointPath', 'timeoutMs'], {
      exact: true,
    });
    buildPayload = values.buildPayload;
    parseResponse = values.parseResponse;
    now = values.now;
    oeisClient = oeisPort;
    fyndClient = fyndPort;
    oeisAudit = auditValues === null ? null : Object.freeze({ ...auditValues });
    valid = repository !== null
      && typeof buildPayload === 'function' && !types.isProxy(buildPayload)
      && typeof parseResponse === 'function' && !types.isProxy(parseResponse)
      && oeisClient !== null && fyndClient !== null
      && typeof now === 'function' && !types.isProxy(now)
      && oeisAudit !== null
      && oeisAudit.endpointPath === '/API/V2/Transaction/UpdateInvoiceData'
      && Number.isSafeInteger(oeisAudit.timeoutMs) && oeisAudit.timeoutMs > 0;
  } catch {
    valid = false;
  }
  if (!valid) {
    fail('WORKFLOW_CONFIG_INVALID', 'Invoice workflow configuration is invalid');
  }

  async function markJobInvalid(job, code) {
    const completedAt = readWorkflowClock(now);
    const auditEvents = auditBundleAt([entityAuditInput(job, job, {
      stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
      safeCode: code,
    })], completedAt);
    return repository.markJobIndeterminate(
      job.id,
      code,
      'Stored invoice workflow data is invalid',
      job.version,
      auditEvents,
    );
  }

  async function markOutboxInvalid(outbox, job = null, code = 'OUTBOX_DATA_INVALID') {
    const auditEvents = job === null ? undefined : auditBundleAt([
      entityAuditInput(job, outbox, {
        stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
        safeCode: code,
      }),
    ], readWorkflowClock(now));
    return repository.markOutboxIndeterminate(
      outbox.id,
      code,
      'Stored invoice outbox data is invalid',
      outbox.version,
      auditEvents,
    );
  }

  async function beginJobOperation(job, { stage, action, requestSummary }) {
    const query = { companyId: job.companyId, jobId: job.id, stage };
    const unresolved = await repository.findUnresolvedAuditOperation(query);
    if (unresolved !== null) {
      return {
        isNew: false,
        recovery: exactRecoveryValue(unresolved, {
          targetKind: 'JOB', targetId: job.id, stage, action,
          targetVersion: job.version,
        }),
      };
    }
    const operationKey = createOperationKey({
      targetKind: 'JOB', targetId: String(job.id),
      expectedParentVersion: job.version, attemptNumber: job.attemptCount,
      stage, action,
    });
    const startedAt = readWorkflowClock(now);
    const started = auditBundleAt([operationAuditInput(job, {
      operationKey, stage, action, outcome: 'STARTED',
      attemptNumber: job.attemptCount, startedAt: null, requestSummary,
    })], startedAt)[0];
    const returned = await repository.beginExternalOperation({
      targetKind: 'JOB', targetId: job.id, expectedVersion: job.version, event: started,
    });
    return {
      isNew: true,
      recovery: exactRecoveryValue(returned, {
        targetKind: 'JOB', targetId: job.id, stage, action,
        targetVersion: job.version + 1,
        attemptNumber: job.attemptCount,
        operationKey,
      }),
    };
  }

  async function beginOutboxOperation(outbox, job, requestSummary) {
    const stage = 'FYND_TRANSITION';
    const action = 'FYND_TRANSITION_REQUESTED';
    const unresolved = await repository.findUnresolvedAuditOperation({
      companyId: job.companyId, jobId: job.id, stage,
    });
    if (unresolved !== null) {
      return {
        isNew: false,
        recovery: exactRecoveryValue(unresolved, {
          targetKind: 'OUTBOX', targetId: outbox.id, stage, action,
          targetVersion: outbox.version,
        }),
      };
    }
    const operationKey = createOperationKey({
      targetKind: 'OUTBOX', targetId: String(outbox.id),
      expectedParentVersion: outbox.version, attemptNumber: outbox.attemptCount,
      stage, action,
    });
    const startedAt = readWorkflowClock(now);
    const started = auditBundleAt([operationAuditInput(job, {
      operationKey, stage, action, outcome: 'STARTED',
      attemptNumber: outbox.attemptCount, startedAt: null,
      requestSummary, artifactJobId: job.id,
    })], startedAt)[0];
    const returned = await repository.beginExternalOperation({
      targetKind: 'OUTBOX', targetId: outbox.id,
      expectedVersion: outbox.version, event: started,
    });
    return {
      isNew: true,
      recovery: exactRecoveryValue(returned, {
        targetKind: 'OUTBOX', targetId: outbox.id, stage, action,
        targetVersion: outbox.version + 1,
        attemptNumber: outbox.attemptCount,
        operationKey,
      }),
    };
  }

  async function scheduleJob(job, plan, code, exhaustedCode, {
    auditInputs = [],
    occurredAt = null,
  } = {}) {
    const schedulingAt = occurredAt === null ? readWorkflowClock(now) : occurredAt;
    if (plan.exhausted) {
      const auditEvents = auditBundleAt([
        ...auditInputs,
        entityAuditInput(job, job, {
          stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
          safeCode: exhaustedCode,
        }),
      ], schedulingAt);
      return repository.markJobIndeterminate(
        job.id,
        exhaustedCode,
        'Invoice retry attempts are exhausted',
        job.version,
        auditEvents,
      );
    }
    const scheduled = retrySchedule(plan, schedulingAt);
    const auditEvents = auditBundleAt([
      ...auditInputs,
      entityAuditInput(job, job, {
        stage: 'RETRY', action: 'RETRY_SCHEDULED', outcome: 'RETRY_SCHEDULED',
        retryDelayMs: scheduled.delay, safeCode: code,
      }),
    ], schedulingAt);
    return repository.scheduleJobRetry(job.id, {
      errorCode: code,
      safeMessage: 'Invoice operation will be retried',
      nextAttemptAt: scheduled.nextAttemptAt,
    }, job.version, auditEvents);
  }

  async function scheduleOutbox(outbox, job, plan, code, {
    auditInputs = [], occurredAt = null,
  } = {}) {
    const schedulingAt = occurredAt === null ? readWorkflowClock(now) : occurredAt;
    if (plan.exhausted) {
      const auditEvents = auditBundleAt([
        ...auditInputs,
        entityAuditInput(job, outbox, {
          stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
          safeCode: 'FYND_TRANSITION_RETRY_EXHAUSTED',
        }),
      ], schedulingAt);
      return repository.markOutboxIndeterminate(
        outbox.id,
        'FYND_TRANSITION_RETRY_EXHAUSTED',
        'Fynd transition retry attempts are exhausted',
        outbox.version,
        auditEvents,
      );
    }
    const scheduled = retrySchedule(plan, schedulingAt);
    const auditEvents = auditBundleAt([
      ...auditInputs,
      entityAuditInput(job, outbox, {
        stage: 'RETRY', action: 'RETRY_SCHEDULED', outcome: 'RETRY_SCHEDULED',
        retryDelayMs: scheduled.delay, safeCode: code,
      }),
    ], schedulingAt);
    return repository.scheduleOutboxRetry(outbox.id, {
      errorCode: code,
      safeMessage: 'Fynd transition will be retried',
      nextAttemptAt: scheduled.nextAttemptAt,
    }, outbox.version, auditEvents);
  }

  async function persistLockedJob(job, auditEvents) {
    const returned = await repository.markShipmentLocked(job.id, job.version, auditEvents);
    const dryRun = DRY_RUN_JOB_STATES.has(job.state);
    return validateReturnedJob(job, returned, {
      state: dryRun ? JOB_STATES.SUBMISSION_HELD : JOB_STATES.LOCKED,
      oeisRequestJson: job.oeisRequestJson,
      requestHash: job.requestHash,
      lockedAtRequired: true,
      leaseExpectation: dryRun ? 'cleared' : 'retained',
    });
  }

  async function reconcileLock(job, plan, recovery, originalCompletedAt, originalCode) {
    const readbackOperationKey = createOperationKey({
      targetKind: 'JOB', targetId: String(job.id),
      expectedParentVersion: job.version, attemptNumber: job.attemptCount,
      stage: 'FYND_LOCK', action: 'FYND_LOCK_READBACK',
    });
    const readbackStartedAt = readWorkflowClock(now);
    if (readbackStartedAt.getTime() <= originalCompletedAt.getTime()) {
      fail('AUDIT_CLOCK_INVALID', 'Shipment audit clock is invalid');
    }
    const readbackRequest = sanitizeFyndSummary('REQUEST', {
      operation: 'LOCK_READBACK', shipmentId: job.shipmentId,
      documentNumber: job.documentNumber, requestedLock: null, requestedStatus: null,
    });
    const readbackStarted = operationAuditInput(job, {
      operationKey: readbackOperationKey,
      stage: 'FYND_LOCK', action: 'FYND_LOCK_READBACK', outcome: 'STARTED',
      attemptNumber: job.attemptCount, startedAt: readbackStartedAt,
      requestSummary: readbackRequest,
    });
    let shipment = null;
    let readbackCode = null;
    try {
      shipment = await fyndClient.getShipment({
        companyId: job.companyId, shipmentId: job.shipmentId,
      });
    } catch (error) {
      readbackCode = safeCode(error, 'FYND_REQUEST_FAILED');
    }
    const completedAt = readWorkflowClock(now);
    if (completedAt.getTime() <= readbackStartedAt.getTime()) {
      fail('AUDIT_CLOCK_INVALID', 'Shipment audit clock is invalid');
    }
    let classification = 'UNREADABLE';
    let locked = null;
    let shipmentState = null;
    let readable = false;
    if (readbackCode === null && isPlainRecord(shipment)
        && hasOwnFields(shipment, ['shipmentId', 'status', 'locked', 'responseStatus'])
        && shipment.shipmentId === job.shipmentId
        && fyndResponseStatus(null, shipment) === shipment.responseStatus) {
      readable = true;
      locked = typeof shipment.locked === 'boolean' ? shipment.locked : null;
      shipmentState = fyndState(shipment);
      if (pristineLockState(shipment, job, true)) classification = 'LOCKED';
      else if (pristineLockState(shipment, job, false)) classification = 'UNLOCKED';
      else classification = 'CONFLICTING';
    }
    if (!readable && readbackCode === null) readbackCode = 'FYND_LOCK_READBACK_INVALID';
    const readbackOutcome = readable
      ? 'SUCCESS'
      : (readbackCode === 'FYND_TIMEOUT' ? 'TIMEOUT' : 'INDETERMINATE');
    const readbackSummary = fyndResponseSummary({
      operation: 'LOCK_READBACK', job, result: shipment, code: readbackCode,
      locked, shipmentState, classification, retryable: false,
      latencyMs: completedAt.getTime() - readbackStartedAt.getTime(),
    });
    const readbackTerminal = operationAuditInput(job, {
      operationKey: readbackOperationKey,
      stage: 'FYND_LOCK', action: 'FYND_LOCK_READBACK', outcome: readbackOutcome,
      attemptNumber: job.attemptCount, startedAt: readbackStartedAt, completedAt,
      safeCode: readbackOutcome === 'SUCCESS' ? null : readbackCode,
      responseSummary: readbackSummary,
    });
    const originalLatency = originalCompletedAt.getTime() - Date.parse(recovery.startedAt);
    if (!Number.isSafeInteger(originalLatency) || originalLatency < 0) {
      fail('AUDIT_CLOCK_INVALID', 'Shipment audit clock is invalid');
    }
    const originalSummary = fyndResponseSummary({
      operation: 'LOCK', job, result: shipment, code: originalCode,
      locked, shipmentState, classification,
      retryable: classification === 'UNLOCKED' || classification === 'UNREADABLE',
      latencyMs: originalLatency,
    });
    if (classification === 'LOCKED') {
      const inputs = [
        readbackStarted,
        readbackTerminal,
        operationAuditInput(job, {
          operationKey: recovery.operationKey,
          stage: 'FYND_LOCK', action: 'FYND_LOCK_CONFIRMED', outcome: 'SUCCESS',
          attemptNumber: recovery.attemptNumber,
          startedAt: new Date(recovery.startedAt), completedAt: originalCompletedAt,
          responseSummary: originalSummary,
        }),
      ];
      if (DRY_RUN_JOB_STATES.has(job.state)) {
        inputs.push(entityAuditInput(job, job, {
          stage: 'OEIS_SUBMISSION', action: 'OEIS_SUBMISSION_HELD', outcome: 'HELD',
        }));
      }
      const auditEvents = auditBundleAt(inputs, completedAt);
      return { outcome: 'locked', job: await persistLockedJob(job, auditEvents) };
    }
    const originalOutcome = originalCode === 'FYND_TIMEOUT' ? 'TIMEOUT'
      : (classification === 'UNLOCKED' ? 'FAILURE' : 'INDETERMINATE');
    const terminalCode = classification === 'UNLOCKED'
      ? (originalCode || 'FYND_LOCK_NOT_CONFIRMED')
      : 'FYND_LOCK_STATE_INDETERMINATE';
    const originalFailure = operationAuditInput(job, {
      operationKey: recovery.operationKey,
      stage: 'FYND_LOCK', action: 'FYND_LOCK_FAILED', outcome: originalOutcome,
      attemptNumber: recovery.attemptNumber,
      startedAt: new Date(recovery.startedAt), completedAt: originalCompletedAt,
      safeCode: terminalCode, responseSummary: originalSummary,
    });
    const evidence = [readbackStarted, readbackTerminal, originalFailure];
    if (classification === 'UNLOCKED') {
      return {
        outcome: 'terminal',
        result: await scheduleJob(job, plan, terminalCode, 'FYND_LOCK_RETRY_EXHAUSTED', {
          auditInputs: evidence, occurredAt: completedAt,
        }),
      };
    }
    const auditEvents = auditBundleAt([
      ...evidence,
      entityAuditInput(job, job, {
        stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
        safeCode: terminalCode,
      }),
    ], completedAt);
    return {
      outcome: 'terminal',
      result: await repository.markJobIndeterminate(
        job.id, terminalCode, 'Fynd shipment lock state is indeterminate',
        job.version, auditEvents,
      ),
    };
  }

  async function performLock(job, plan) {
    const requestSummary = sanitizeFyndSummary('REQUEST', {
      operation: 'LOCK',
      shipmentId: job.shipmentId,
      documentNumber: job.documentNumber,
      requestedLock: true,
      requestedStatus: null,
    });
    const operation = await beginJobOperation(job, {
      stage: 'FYND_LOCK', action: 'FYND_LOCK_REQUESTED', requestSummary,
    });
    const operationJob = jobAtVersion(job, operation.recovery.targetVersion);
    if (!operation.isNew) {
      const originalCompletedAt = readWorkflowClock(now);
      return reconcileLock(
        operationJob, plan, operation.recovery, originalCompletedAt,
        'FYND_LOCK_PENDING_RECOVERY',
      );
    }
    let result;
    try {
      result = await fyndClient.lockShipment({
        companyId: job.companyId,
        shipmentId: job.shipmentId,
        documentNumber: job.documentNumber,
      });
      if (!isPlainRecord(result)
          || !hasOwnFields(result, ['shipmentId', 'locked', 'responseStatus'])
          || result.shipmentId !== job.shipmentId || result.locked !== true
          || result.responseStatus !== null) {
        throw new EinvoiceError('FYND_LOCK_RESPONSE_INVALID', 'Fynd lock response is invalid');
      }
    } catch (error) {
      const code = safeCode(error, 'FYND_REQUEST_FAILED');
      const originalCompletedAt = readWorkflowClock(now);
      if (LOCK_AMBIGUOUS_CODES.has(code)) {
        return reconcileLock(
          operationJob, plan, operation.recovery, originalCompletedAt, code,
        );
      }
      const responseSummary = fyndResponseSummary({
        operation: 'LOCK', job: operationJob, code,
        classification: 'REJECTED', retryable: false,
        latencyMs: originalCompletedAt.getTime() - Date.parse(operation.recovery.startedAt),
      });
      const auditEvents = auditBundleAt([
        operationAuditInput(operationJob, {
          operationKey: operation.recovery.operationKey,
          stage: 'FYND_LOCK', action: 'FYND_LOCK_FAILED', outcome: 'FAILURE',
          attemptNumber: operation.recovery.attemptNumber,
          startedAt: new Date(operation.recovery.startedAt), completedAt: originalCompletedAt,
          safeCode: code, responseSummary,
        }),
        entityAuditInput(operationJob, operationJob, {
          stage: 'JOB', action: 'JOB_DATA_FAILED', outcome: 'FAILURE', safeCode: code,
        }),
      ], originalCompletedAt);
      return {
        outcome: 'terminal',
        result: await repository.markJobFailed(
          operationJob.id,
          code,
          'Fynd shipment lock was rejected',
          operationJob.version,
          auditEvents,
        ),
      };
    }
    const completedAt = readWorkflowClock(now);
    const latencyMs = completedAt.getTime() - Date.parse(operation.recovery.startedAt);
    const responseSummary = sanitizeFyndSummary('RESPONSE', {
      operation: 'LOCK', shipmentId: operationJob.shipmentId,
      documentNumber: operationJob.documentNumber, responseStatus: null,
      locked: true, shipmentState: null, finalStateClassification: 'LOCKED',
      retryable: false, latencyMs,
    });
    const auditInputs = [operationAuditInput(operationJob, {
      operationKey: operation.recovery.operationKey,
      stage: 'FYND_LOCK', action: 'FYND_LOCK_CONFIRMED', outcome: 'SUCCESS',
      attemptNumber: operation.recovery.attemptNumber,
      startedAt: new Date(operation.recovery.startedAt), completedAt, responseSummary,
    })];
    if (DRY_RUN_JOB_STATES.has(operationJob.state)) {
      auditInputs.push(entityAuditInput(operationJob, operationJob, {
        stage: 'OEIS_SUBMISSION', action: 'OEIS_SUBMISSION_HELD', outcome: 'HELD',
      }));
    }
    const auditEvents = auditBundleAt(auditInputs, completedAt);
    return {
      outcome: 'locked',
      job: await persistLockedJob(operationJob, auditEvents),
    };
  }

  async function prepare(job) {
    const validationStartedAt = readWorkflowClock(now);
    const validationStarted = auditBundleAt([entityAuditInput(job, job, {
      stage: 'VALIDATION', action: 'VALIDATION_STARTED', outcome: 'STARTED',
    })], validationStartedAt);
    await repository.appendAuditEvents(validationStarted);
    let prepared;
    try {
      prepared = await buildPayload(job.shipmentSnapshot);
      validatePreparedPayload(prepared, job);
    } catch (error) {
      const code = safeCode(error, 'LOCAL_VALIDATION_FAILED');
      const completedAt = readWorkflowClock(now);
      const auditEvents = auditBundleAt([
        entityAuditInput(job, job, {
          stage: 'VALIDATION', action: 'VALIDATION_FAILED', outcome: 'FAILURE',
          startedAt: new Date(validationStarted[0].startedAt), completedAt, safeCode: code,
        }),
        entityAuditInput(job, job, {
          stage: 'JOB', action: 'JOB_DATA_FAILED', outcome: 'FAILURE', safeCode: code,
        }),
      ], completedAt);
      return {
        terminal: true,
        result: await repository.markJobFailed(
          job.id,
          code,
          'Invoice data validation failed',
          job.version,
          auditEvents,
        ),
      };
    }
    const completedAt = readWorkflowClock(now);
    const auditEvents = auditBundleAt([
      entityAuditInput(job, job, {
        stage: 'VALIDATION', action: 'VALIDATION_PASSED', outcome: 'SUCCESS',
        startedAt: new Date(validationStarted[0].startedAt), completedAt,
      }),
      entityAuditInput(job, job, {
        stage: 'PAYLOAD', action: 'PAYLOAD_PREPARED', outcome: 'SUCCESS',
      }),
    ], completedAt);
    const saved = await repository.savePreparedRequest(
      job.id,
      prepared.requestJson,
      prepared.requestHash,
      job.version,
      auditEvents,
    );
    return {
      terminal: false,
      job: validateReturnedJob(job, saved, {
        state: job.state === JOB_STATES.DRY_RUN_RECEIVED
          ? JOB_STATES.DRY_RUN_LOCK_PENDING
          : JOB_STATES.LOCK_PENDING,
        oeisRequestJson: prepared.requestJson,
        requestHash: prepared.requestHash,
        lockedAt: null,
        leaseExpectation: 'retained',
      }),
    };
  }

  async function closePendingOeisOperation(operationJob, recovery) {
    const completedAt = readWorkflowClock(now);
    const latencyMs = completedAt.getTime() - Date.parse(recovery.startedAt);
    const responseSummary = sanitizeOeisSummary('RESPONSE', {
      httpStatus: null, isSystemException: null, validationResult: 'UNKNOWN',
      reportingStatus: null, clearanceStatus: null, invoiceNumber: null,
      transactionNumber: null, uuid: null, invoiceCounter: null, matchingKey: null,
      validationCodes: [], responseByteCount: null, responseSha256: null,
      retryable: false, latencyMs,
    });
    const auditEvents = auditBundleAt([
      operationAuditInput(operationJob, {
        operationKey: recovery.operationKey,
        stage: 'OEIS_SUBMISSION', action: 'OEIS_SUBMISSION_FAILED',
        outcome: 'INDETERMINATE', attemptNumber: recovery.attemptNumber,
        startedAt: new Date(recovery.startedAt), completedAt,
        safeCode: 'OEIS_PENDING_OPERATION_INDETERMINATE', responseSummary,
      }),
      entityAuditInput(operationJob, operationJob, {
        stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
        safeCode: 'OEIS_PENDING_OPERATION_INDETERMINATE',
      }),
    ], completedAt);
    return repository.markJobIndeterminate(
      operationJob.id,
      'OEIS_PENDING_OPERATION_INDETERMINATE',
      'OEIS result is indeterminate',
      operationJob.version,
      auditEvents,
    );
  }

  async function submitOeis(job, plan) {
    let requestSummary;
    try {
      requestSummary = deriveOeisRequestSummary(job, oeisAudit);
    } catch {
      return markJobInvalid(job, 'STORED_REQUEST_INVALID');
    }
    const operation = await beginJobOperation(job, {
      stage: 'OEIS_SUBMISSION',
      action: 'OEIS_SUBMISSION_REQUESTED',
      requestSummary,
    });
    const operationJob = jobAtVersion(job, operation.recovery.targetVersion);
    if (!operation.isNew) {
      return closePendingOeisOperation(operationJob, operation.recovery);
    }
    let response;
    let completedAt;
    try {
      response = await oeisClient.submit(operationJob.oeisRequestJson);
      completedAt = readWorkflowClock(now);
    } catch (error) {
      completedAt = readWorkflowClock(now);
      const code = safeCode(error, 'OEIS_UNKNOWN_RESULT');
      const latencyMs = completedAt.getTime() - Date.parse(operation.recovery.startedAt);
      const responseSummary = oeisFailureSummary(code, latencyMs);
      const outcome = code === 'OEIS_TIMEOUT'
        ? 'TIMEOUT'
        : (code === 'OEIS_HTTP_429' || OEIS_DETERMINISTIC_CODES.has(code)
          ? 'FAILURE' : 'INDETERMINATE');
      const operationFailure = operationAuditInput(operationJob, {
        operationKey: operation.recovery.operationKey,
        stage: 'OEIS_SUBMISSION', action: 'OEIS_SUBMISSION_FAILED', outcome,
        attemptNumber: operation.recovery.attemptNumber,
        startedAt: new Date(operation.recovery.startedAt), completedAt,
        safeCode: code, responseSummary,
      });
      if (code === 'OEIS_HTTP_429') {
        return scheduleJob(operationJob, plan, code, 'OEIS_RETRY_EXHAUSTED', {
          auditInputs: [operationFailure], occurredAt: completedAt,
        });
      }
      if (OEIS_DETERMINISTIC_CODES.has(code)) {
        const auditEvents = auditBundleAt([
          operationFailure,
          entityAuditInput(operationJob, operationJob, {
            stage: 'JOB', action: 'JOB_DATA_FAILED', outcome: 'FAILURE', safeCode: code,
          }),
        ], completedAt);
        return repository.markJobFailed(
          operationJob.id, code, 'OEIS request was rejected', operationJob.version,
          auditEvents,
        );
      }
      const terminalCode = OEIS_INDETERMINATE_CODES.has(code) || code === 'OEIS_TIMEOUT'
        || ['OEIS_NETWORK', 'OEIS_HTTP_5XX'].includes(code)
        ? code
        : 'OEIS_UNKNOWN_RESULT';
      const auditEvents = auditBundleAt([
        operationFailure,
        entityAuditInput(operationJob, operationJob, {
          stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
          safeCode: terminalCode,
        }),
      ], completedAt);
      return repository.markJobIndeterminate(
        operationJob.id,
        terminalCode,
        'OEIS result is indeterminate',
        operationJob.version,
        auditEvents,
      );
    }

    let accepted;
    try {
      if (!isPlainRecord(response)
          || !hasOwnFields(response, [
            'httpStatus', 'body', 'responseByteCount', 'responseSha256',
          ])
          || !Number.isInteger(response.httpStatus)
          || response.httpStatus < 200 || response.httpStatus >= 300
          || response.responseByteCount !== null || response.responseSha256 !== null) {
        throw new EinvoiceError('OEIS_UNKNOWN_RESULT', 'OEIS result is invalid');
      }
      accepted = await parseResponse(response.body);
    } catch (error) {
      const code = safeCode(error, 'OEIS_UNKNOWN_RESULT');
      const latencyMs = completedAt.getTime() - Date.parse(operation.recovery.startedAt);
      const responseSummary = oeisFailureSummary(code, latencyMs, response);
      const auditEvents = auditBundleAt([
        operationAuditInput(operationJob, {
          operationKey: operation.recovery.operationKey,
          stage: 'OEIS_SUBMISSION', action: 'OEIS_SUBMISSION_FAILED',
          outcome: 'INDETERMINATE', attemptNumber: operation.recovery.attemptNumber,
          startedAt: new Date(operation.recovery.startedAt), completedAt,
          safeCode: code, responseSummary,
        }),
        entityAuditInput(operationJob, operationJob, {
          stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
          safeCode: code,
        }),
      ], completedAt);
      return repository.markJobIndeterminate(
        operationJob.id, code, 'OEIS result is indeterminate', operationJob.version,
        auditEvents,
      );
    }
    const freshArtifact = validateFreshArtifact(accepted, operationJob);
    if (freshArtifact.code !== null) {
      const code = freshArtifact.code;
      const latencyMs = completedAt.getTime() - Date.parse(operation.recovery.startedAt);
      const responseSummary = oeisFailureSummary(code, latencyMs, response);
      const auditEvents = auditBundleAt([
        operationAuditInput(operationJob, {
          operationKey: operation.recovery.operationKey,
          stage: 'OEIS_SUBMISSION', action: 'OEIS_SUBMISSION_FAILED',
          outcome: 'INDETERMINATE', attemptNumber: operation.recovery.attemptNumber,
          startedAt: new Date(operation.recovery.startedAt), completedAt,
          safeCode: code, responseSummary,
        }),
        entityAuditInput(operationJob, operationJob, {
          stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
          safeCode: code,
        }),
      ], completedAt);
      return repository.markJobIndeterminate(
        operationJob.id,
        code,
        'OEIS result is indeterminate',
        operationJob.version,
        auditEvents,
      );
    }
    const artifactForStorage = freshArtifact.artifactForStorage;
    const latencyMs = completedAt.getTime() - Date.parse(operation.recovery.startedAt);
    const summaries = acceptedOeisSummaries(
      response, artifactForStorage, latencyMs, operationJob,
    );
    const auditEvents = auditBundleAt([
      operationAuditInput(operationJob, {
        operationKey: operation.recovery.operationKey,
        stage: 'OEIS_SUBMISSION', action: 'OEIS_RESPONSE_RECEIVED', outcome: 'SUCCESS',
        attemptNumber: operation.recovery.attemptNumber,
        startedAt: new Date(operation.recovery.startedAt), completedAt,
        responseSummary: summaries.responseSummary,
      }),
      entityAuditInput(operationJob, operationJob, {
        stage: 'OEIS_ARTIFACT', action: 'OEIS_ARTIFACT_STORED', outcome: 'SUCCESS',
        responseSummary: summaries.artifactSummary, artifactJobId: operationJob.id,
      }),
    ], completedAt);
    return repository.markOeisAcceptedAndEnqueue(
      operationJob.id,
      artifactForStorage,
      { shipmentId: operationJob.shipmentId, documentNumber: operationJob.documentNumber },
      operationJob.version,
      auditEvents,
    );
  }

  async function processJob(claimedJob, retryPlan) {
    let current = validateJob(claimedJob);
    const plan = validateRetryPlan(retryPlan);

    if (INITIAL_JOB_STATES.has(current.state)) {
      if (plan.overLimit) {
        return scheduleJob(
          current, plan, 'INVOICE_RETRY_EXHAUSTED', 'INVOICE_RETRY_EXHAUSTED',
        );
      }
      const prepared = await prepare(current);
      if (prepared.terminal) return prepared.result;
      current = prepared.job;
    }

    if (!validateRequestBytes(current.oeisRequestJson, current.requestHash, current.documentNumber)) {
      return markJobInvalid(current, 'STORED_REQUEST_INVALID');
    }

    const lockStage = current.lockedAt === null && LOCK_STAGE_JOB_STATES.has(current.state);
    if (lockStage) {
      if (plan.overLimit) {
        const unresolved = await repository.findUnresolvedAuditOperation({
          companyId: current.companyId, jobId: current.id, stage: 'FYND_LOCK',
        });
        if (unresolved !== null) {
          const recovery = exactRecoveryValue(unresolved, {
            targetKind: 'JOB', targetId: current.id, stage: 'FYND_LOCK',
            action: 'FYND_LOCK_REQUESTED', targetVersion: current.version,
          });
          const reconciled = await reconcileLock(
            current, plan, recovery, readWorkflowClock(now), 'FYND_LOCK_PENDING_RECOVERY',
          );
          if (reconciled.outcome === 'terminal') return reconciled.result;
          current = reconciled.job;
        } else {
          return scheduleJob(
            current, plan, 'FYND_LOCK_RETRY', 'FYND_LOCK_RETRY_EXHAUSTED',
          );
        }
      } else {
        if (current.lockedAt === null) {
          const locked = await performLock(current, plan);
          if (locked.outcome === 'terminal') return locked.result;
          current = locked.job;
        }
      }
    } else if (current.lockedAt === null || !OEIS_STAGE_JOB_STATES.has(current.state)) {
      return markJobInvalid(current, 'JOB_STAGE_INVALID');
    }

    if (current.state === JOB_STATES.SUBMISSION_HELD) return current;

    if (current.lockedAt === null || !OEIS_STAGE_JOB_STATES.has(current.state)) {
      return markJobInvalid(current, 'JOB_STAGE_INVALID');
    }

    if (!validateRequestBytes(current.oeisRequestJson, current.requestHash, current.documentNumber)) {
      return markJobInvalid(current, 'STORED_REQUEST_INVALID');
    }
    if (plan.overLimit) {
      const unresolved = await repository.findUnresolvedAuditOperation({
        companyId: current.companyId, jobId: current.id, stage: 'OEIS_SUBMISSION',
      });
      if (unresolved !== null) {
        const recovery = exactRecoveryValue(unresolved, {
          targetKind: 'JOB', targetId: current.id, stage: 'OEIS_SUBMISSION',
          action: 'OEIS_SUBMISSION_REQUESTED', targetVersion: current.version,
        });
        return closePendingOeisOperation(current, recovery);
      }
      return scheduleJob(
        current, plan, 'OEIS_RETRY_EXHAUSTED', 'OEIS_RETRY_EXHAUSTED',
      );
    }
    return submitOeis(current, plan);
  }

  async function reconcileTransition(
    outbox, job, artifact, signedXml, plan, recovery, originalCompletedAt, originalCode,
  ) {
    const readbackOperationKey = createOperationKey({
      targetKind: 'OUTBOX', targetId: String(outbox.id),
      expectedParentVersion: outbox.version, attemptNumber: outbox.attemptCount,
      stage: 'FYND_TRANSITION', action: 'FYND_TRANSITION_READBACK',
    });
    const readbackStartedAt = readWorkflowClock(now);
    if (readbackStartedAt.getTime() <= originalCompletedAt.getTime()) {
      fail('AUDIT_CLOCK_INVALID', 'Shipment audit clock is invalid');
    }
    const readbackRequest = sanitizeFyndSummary('REQUEST', {
      operation: 'TRANSITION_READBACK', shipmentId: job.shipmentId,
      documentNumber: job.documentNumber, requestedLock: null, requestedStatus: null,
    });
    const readbackStarted = operationAuditInput(job, {
      operationKey: readbackOperationKey,
      stage: 'FYND_TRANSITION', action: 'FYND_TRANSITION_READBACK', outcome: 'STARTED',
      attemptNumber: outbox.attemptCount, startedAt: readbackStartedAt,
      requestSummary: readbackRequest, artifactJobId: job.id,
    });
    let shipment = null;
    let readbackCode = null;
    try {
      shipment = await fyndClient.getShipment({
        companyId: job.companyId, shipmentId: job.shipmentId,
      });
    } catch (error) {
      readbackCode = safeCode(error, 'FYND_REQUEST_FAILED');
    }
    const completedAt = readWorkflowClock(now);
    if (completedAt.getTime() <= readbackStartedAt.getTime()) {
      fail('AUDIT_CLOCK_INVALID', 'Shipment audit clock is invalid');
    }
    let classification = 'UNREADABLE';
    let locked = null;
    let shipmentState = null;
    let readable = false;
    if (readbackCode === null && isPlainRecord(shipment)
        && hasOwnFields(shipment, ['shipmentId', 'status', 'locked', 'responseStatus'])
        && shipment.shipmentId === job.shipmentId
        && fyndResponseStatus(null, shipment) === shipment.responseStatus) {
      readable = true;
      locked = typeof shipment.locked === 'boolean' ? shipment.locked : null;
      shipmentState = fyndState(shipment);
      const state = classifyTransitionReadback(shipment, job, artifact, signedXml);
      classification = state === 'complete' ? 'INVOICED'
        : (state === 'pre' ? 'UNCHANGED' : 'CONFLICTING');
    }
    if (!readable && readbackCode === null) readbackCode = 'FYND_TRANSITION_READBACK_INVALID';
    const readbackOutcome = readable
      ? 'SUCCESS'
      : (readbackCode === 'FYND_TIMEOUT' ? 'TIMEOUT' : 'INDETERMINATE');
    const readbackLocked = ['INVOICED', 'UNCHANGED'].includes(classification)
      ? locked
      : null;
    const readbackShipmentState = ['INVOICED', 'UNCHANGED'].includes(classification)
      ? shipmentState
      : null;
    const readbackSummary = fyndResponseSummary({
      operation: 'TRANSITION_READBACK', job, result: shipment, code: readbackCode,
      locked: readbackLocked, shipmentState: readbackShipmentState,
      classification, retryable: false,
      latencyMs: completedAt.getTime() - readbackStartedAt.getTime(),
    });
    const readbackTerminal = operationAuditInput(job, {
      operationKey: readbackOperationKey,
      stage: 'FYND_TRANSITION', action: 'FYND_TRANSITION_READBACK',
      outcome: readbackOutcome, attemptNumber: outbox.attemptCount,
      startedAt: readbackStartedAt, completedAt,
      safeCode: readbackOutcome === 'SUCCESS' ? null : readbackCode,
      responseSummary: readbackSummary, artifactJobId: job.id,
    });
    const originalLatency = originalCompletedAt.getTime() - Date.parse(recovery.startedAt);
    if (!Number.isSafeInteger(originalLatency) || originalLatency < 0) {
      fail('AUDIT_CLOCK_INVALID', 'Shipment audit clock is invalid');
    }
    const evidence = [readbackStarted, readbackTerminal];
    if (classification === 'INVOICED') {
      const confirmedSummary = fyndResponseSummary({
        operation: 'TRANSITION', job, result: shipment, code: null,
        locked: null, shipmentState: 'bag_invoiced', classification: 'INVOICED',
        retryable: false, latencyMs: originalLatency,
      });
      evidence.push(operationAuditInput(job, {
        operationKey: recovery.operationKey,
        stage: 'FYND_TRANSITION', action: 'FYND_TRANSITION_CONFIRMED', outcome: 'SUCCESS',
        attemptNumber: recovery.attemptNumber,
        startedAt: new Date(recovery.startedAt), completedAt: originalCompletedAt,
        responseSummary: confirmedSummary, artifactJobId: job.id,
      }));
      evidence.push(entityAuditInput(job, outbox, {
        stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS',
      }));
      return repository.completeOutboxAndJob(
        outbox.id, outbox.version, auditBundleAt(evidence, completedAt),
      );
    }
    const terminalCode = classification === 'UNCHANGED'
      ? (originalCode || 'FYND_TRANSITION_NOT_CONFIRMED')
      : 'FYND_TRANSITION_STATE_INDETERMINATE';
    const retryableOriginal = classification === 'UNCHANGED';
    const operationSafeCode = retryableOriginal && plan.exhausted
      ? 'FYND_TRANSITION_RETRY_EXHAUSTED'
      : terminalCode;
    const originalOutcome = retryableOriginal
      ? (originalCode === 'FYND_TIMEOUT' ? 'TIMEOUT' : 'FAILURE')
      : 'INDETERMINATE';
    const originalSummary = fyndResponseSummary({
      operation: 'TRANSITION', job,
      code: operationSafeCode,
      locked: null, shipmentState: null,
      classification: retryableOriginal && originalCode !== 'FYND_TIMEOUT'
        ? 'REJECTED'
        : 'UNKNOWN',
      retryable: retryableOriginal,
      latencyMs: originalLatency,
    });
    evidence.push(operationAuditInput(job, {
      operationKey: recovery.operationKey,
      stage: 'FYND_TRANSITION', action: 'FYND_TRANSITION_FAILED',
      outcome: originalOutcome, attemptNumber: recovery.attemptNumber,
      startedAt: new Date(recovery.startedAt), completedAt: originalCompletedAt,
      safeCode: operationSafeCode, responseSummary: originalSummary, artifactJobId: job.id,
    }));
    if (classification === 'UNCHANGED') {
      return scheduleOutbox(outbox, job, plan, terminalCode, {
        auditInputs: evidence, occurredAt: completedAt,
      });
    }
    evidence.push(entityAuditInput(job, outbox, {
      stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE',
      safeCode: terminalCode,
    }));
    return repository.markOutboxIndeterminate(
      outbox.id, terminalCode, 'Fynd transition state is indeterminate',
      outbox.version, auditBundleAt(evidence, completedAt),
    );
  }

  async function processOutbox(claimedOutbox, retryPlan) {
    let current = validateOutbox(claimedOutbox);
    const plan = validateRetryPlan(retryPlan);
    const job = await repository.getJob(current.jobId);
    const auditParent = validAuditParentForOutbox(job, current) ? job : null;
    if (!validOutboxPayload(current)) return markOutboxInvalid(current, auditParent);
    if (!validStoredJobForOutbox(job, current)) return markOutboxInvalid(current, auditParent);
    const storedArtifact = await repository.getArtifact(current.jobId);
    const signedXml = decodeArtifact(storedArtifact, job, { stored: true });
    if (signedXml === null) return markOutboxInvalid(current, job);

    const requestSummary = sanitizeFyndSummary('REQUEST', {
      operation: 'TRANSITION', shipmentId: job.shipmentId,
      documentNumber: job.documentNumber, requestedLock: null,
      requestedStatus: 'bag_invoiced',
    });
    let operation;
    if (plan.overLimit) {
      const unresolved = await repository.findUnresolvedAuditOperation({
        companyId: job.companyId, jobId: job.id, stage: 'FYND_TRANSITION',
      });
      if (unresolved === null) {
        return scheduleOutbox(
          current, job, plan, 'FYND_TRANSITION_RETRY',
        );
      }
      operation = {
        isNew: false,
        recovery: exactRecoveryValue(unresolved, {
          targetKind: 'OUTBOX', targetId: current.id, stage: 'FYND_TRANSITION',
          action: 'FYND_TRANSITION_REQUESTED', targetVersion: current.version,
        }),
      };
    } else {
      operation = await beginOutboxOperation(current, job, requestSummary);
    }
    current = { ...current, version: operation.recovery.targetVersion };
    if (!operation.isNew) {
      return reconcileTransition(
        current, job, storedArtifact, signedXml, plan, operation.recovery,
        readWorkflowClock(now), 'FYND_TRANSITION_PENDING_RECOVERY',
      );
    }

    let transitionResult;
    try {
      transitionResult = await fyndClient.transitionToInvoiced({
        companyId: job.companyId,
        shipmentId: job.shipmentId,
        documentNumber: job.documentNumber,
        signedXmlBase64: storedArtifact.signedXmlBase64,
        signedXml,
      });
      if (!isPlainRecord(transitionResult)
          || !hasOwnFields(transitionResult, ['shipmentId', 'status', 'responseStatus'])
          || transitionResult.shipmentId !== job.shipmentId
          || transitionResult.status !== 'bag_invoiced'
          || transitionResult.responseStatus !== null) {
        throw new EinvoiceError(
          'FYND_TRANSITION_RESPONSE_INVALID', 'Fynd transition response is invalid',
        );
      }
    } catch (error) {
      const code = safeCode(error, 'FYND_REQUEST_FAILED');
      const originalCompletedAt = readWorkflowClock(now);
      if (TRANSITION_AMBIGUOUS_CODES.has(code)) {
        return reconcileTransition(
          current, job, storedArtifact, signedXml, plan, operation.recovery,
          originalCompletedAt, code,
        );
      }
      const responseSummary = fyndResponseSummary({
        operation: 'TRANSITION', job, code, classification: 'REJECTED',
        retryable: false,
        latencyMs: originalCompletedAt.getTime() - Date.parse(operation.recovery.startedAt),
      });
      const auditEvents = auditBundleAt([
        operationAuditInput(job, {
          operationKey: operation.recovery.operationKey,
          stage: 'FYND_TRANSITION', action: 'FYND_TRANSITION_FAILED', outcome: 'FAILURE',
          attemptNumber: operation.recovery.attemptNumber,
          startedAt: new Date(operation.recovery.startedAt), completedAt: originalCompletedAt,
          safeCode: code, responseSummary, artifactJobId: job.id,
        }),
        entityAuditInput(job, current, {
          stage: 'JOB', action: 'JOB_INDETERMINATE', outcome: 'INDETERMINATE', safeCode: code,
        }),
      ], originalCompletedAt);
      return repository.markOutboxIndeterminate(
        current.id, code, 'Fynd transition was rejected', current.version, auditEvents,
      );
    }
    const completedAt = readWorkflowClock(now);
    const responseSummary = fyndResponseSummary({
      operation: 'TRANSITION', job, result: transitionResult,
      locked: null, shipmentState: 'bag_invoiced', classification: 'INVOICED',
      retryable: false,
      latencyMs: completedAt.getTime() - Date.parse(operation.recovery.startedAt),
    });
    const auditEvents = auditBundleAt([
      operationAuditInput(job, {
        operationKey: operation.recovery.operationKey,
        stage: 'FYND_TRANSITION', action: 'FYND_TRANSITION_CONFIRMED', outcome: 'SUCCESS',
        attemptNumber: operation.recovery.attemptNumber,
        startedAt: new Date(operation.recovery.startedAt), completedAt,
        responseSummary, artifactJobId: job.id,
      }),
      entityAuditInput(job, current, {
        stage: 'JOB', action: 'JOB_COMPLETED', outcome: 'SUCCESS',
      }),
    ], completedAt);
    return repository.completeOutboxAndJob(current.id, current.version, auditEvents);
  }

  return Object.freeze({ processJob, processOutbox });
}

module.exports = { createInvoiceWorkflow };
