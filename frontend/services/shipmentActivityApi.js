import axios from 'axios';

const BASE_URL = '/api/einvoice/shipment-activity';
const PRE_JOB_FAILURES_URL = `${BASE_URL}/pre-job-failures`;
const RESPONSE_MAX_BYTES = 524288;
const SUMMARY_MAX_BYTES = 4096;
const SANITIZED_ERRORS = new WeakSet();

const ERROR_COPY = Object.freeze({
  unauthorized: 'Your session has expired. Reauthenticate in Fynd to view shipment activity.',
  'not-found': 'This shipment activity is no longer available.',
  'request-failed': 'Shipment activity could not be loaded.',
});

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

const RECENT_ITEM_FIELDS = Object.freeze([
  'shipmentId', 'jobId', 'documentNumber', 'lastStage', 'lastAction', 'lastOutcome',
  'lastSafeCode', 'firstOccurredAt', 'lastOccurredAt', 'version',
]);
const TIMELINE_ITEM_FIELDS = Object.freeze([
  'jobId', 'documentNumber', 'stage', 'action', 'outcome', 'attemptNumber',
  'startedAt', 'completedAt', 'durationMs', 'queueDelayMs', 'retryDelayMs',
  'nextAttemptAt', 'safeCode', 'requestSummary', 'responseSummary', 'artifactJobId',
  'occurredAt',
]);
const FYND_REQUEST_FIELDS = Object.freeze([
  'kind', 'operation', 'shipmentId', 'documentNumber', 'requestedLock', 'requestedStatus',
]);
const FYND_RESPONSE_FIELDS = Object.freeze([
  'kind', 'operation', 'shipmentId', 'documentNumber', 'responseStatus', 'locked',
  'shipmentState', 'finalStateClassification', 'retryable', 'latencyMs',
]);
const OEIS_REQUEST_FIELDS = Object.freeze([
  'kind', 'documentNumber', 'documentType', 'lineCount', 'currency', 'netAmount',
  'taxAmount', 'totalAmount', 'taxSummaries', 'requestByteCount', 'requestSha256',
  'endpointPath', 'attemptNumber', 'timeoutMs',
]);
const OEIS_TAX_FIELDS = Object.freeze(['category', 'rate', 'reasonCode', 'lineCount']);
const OEIS_RESPONSE_FIELDS = Object.freeze([
  'kind', 'httpStatus', 'isSystemException', 'validationResult', 'reportingStatus',
  'clearanceStatus', 'invoiceNumber', 'transactionNumber', 'uuid', 'invoiceCounter',
  'matchingKey', 'validationCodes', 'responseByteCount', 'responseSha256',
  'retryable', 'latencyMs',
]);
const OEIS_ARTIFACT_FIELDS = Object.freeze([
  'kind', 'signedXmlPresent', 'signedXmlByteCount', 'signedXmlSha256',
  'qrPresent', 'qrByteCount', 'qrSha256',
]);

const SHIPMENT_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const SAFE_STATE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REASON_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,63}$/;
const VALIDATION_CODE_PATTERN = /^[A-Z][A-Z0-9_-]{0,63}$/;
const FIXED_DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]{0,17})\.[0-9]{2}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/;
const FYND_OPERATIONS = new Set(['LOCK', 'LOCK_READBACK', 'TRANSITION', 'TRANSITION_READBACK']);
const FYND_CLASSIFICATIONS = new Set([
  'LOCKED', 'UNLOCKED', 'INVOICED', 'UNCHANGED', 'CONFLICTING', 'UNREADABLE', 'REJECTED', 'UNKNOWN',
]);
const VALIDATION_RESULTS = new Set(['VALID', 'INVALID', 'UNKNOWN']);
const REPORTING_STATUSES = new Set(['PENDING', 'REPORTED', 'REJECTED', 'WARNINGS', 'UNKNOWN']);
const CLEARANCE_STATUSES = new Set(['PENDING', 'CLEARED', 'NOT_CLEARED', 'WARNINGS', 'UNKNOWN']);
const TAX_CATEGORIES = new Set(['S', 'Z', 'E']);

function sanitizedError(kind) {
  const error = new Error(ERROR_COPY[kind]);
  error.kind = kind;
  SANITIZED_ERRORS.add(error);
  return error;
}

function invalid() {
  throw new Error('invalid shipment activity data');
}

function utf8Bytes(value) {
  return new Blob([value]).size;
}

function inspectPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string')) invalid();
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value') || descriptor.enumerable !== true) {
      invalid();
    }
  }
  return { descriptors, keys };
}

function exactValues(value, fields) {
  const inspected = inspectPlainObject(value);
  if (inspected.keys.length !== fields.length) invalid();
  const allowed = new Set(fields);
  for (const key of inspected.keys) if (!allowed.has(key)) invalid();
  const result = Object.create(null);
  for (const field of fields) {
    const descriptor = inspected.descriptors[field];
    if (!descriptor) invalid();
    result[field] = descriptor.value;
  }
  return result;
}

function inputValues(value, allowedFields, requiredFields) {
  const inspected = inspectPlainObject(value);
  const allowed = new Set(allowedFields);
  for (const key of inspected.keys) if (!allowed.has(key)) invalid();
  for (const field of requiredFields) if (!inspected.descriptors[field]) invalid();
  const result = Object.create(null);
  for (const field of allowedFields) {
    if (inspected.descriptors[field]) result[field] = inspected.descriptors[field].value;
  }
  return result;
}

function denseArray(value, maximumLength = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0
      || lengthDescriptor.value > maximumLength) invalid();
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some(key => typeof key !== 'string') || ownKeys.length !== length + 1) invalid();
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.enumerable !== true) invalid();
    result.push(descriptor.value);
  }
  for (const key of ownKeys) {
    if (key === 'length') continue;
    if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) invalid();
  }
  return result;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function positiveSafeInteger(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) invalid();
  return value;
}

function nonnegativeSafeInteger(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function printableAscii(value, maximumBytes, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !PRINTABLE_ASCII_PATTERN.test(value) || !/[!-~]/.test(value)
      || utf8Bytes(value) > maximumBytes) invalid();
  return value;
}

function shipmentId(value) {
  if (typeof value !== 'string' || !SHIPMENT_ID_PATTERN.test(value)
      || utf8Bytes(value) < 1 || utf8Bytes(value) > 512) invalid();
  return value;
}

function companyId(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || value.length > 64) invalid();
  return value;
}

function limit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) invalid();
  return value;
}

function cursor(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024
      || !CURSOR_PATTERN.test(value) || value.length % 4 === 1) invalid();
  const remainder = value.length % 4;
  const finalIndex = BASE64URL_ALPHABET.indexOf(value[value.length - 1]);
  if ((remainder === 2 && finalIndex % 16 !== 0)
      || (remainder === 3 && finalIndex % 4 !== 0)) invalid();
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || value.length > 64) invalid();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) invalid();
  return value;
}

function validateAction(stage, action, outcome) {
  const rule = typeof action === 'string' ? ACTION_RULES[action] : undefined;
  if (!rule || rule.stage !== stage || !rule.outcomes.includes(outcome)) invalid();
}

function safeCode(value, outcome) {
  if (value !== null && (typeof value !== 'string' || !SAFE_CODE_PATTERN.test(value))) invalid();
  if (['FAILURE', 'TIMEOUT', 'INDETERMINATE'].includes(outcome) && value === null) invalid();
  return value;
}

function fixedDecimal(value) {
  if (typeof value !== 'string' || !FIXED_DECIMAL_PATTERN.test(value) || value === '-0.00') invalid();
  return value;
}

function hash(value) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) invalid();
  return value;
}

function projectFyndRequest(value) {
  const summary = exactValues(value, FYND_REQUEST_FIELDS);
  if (summary.kind !== 'FYND_REQUEST' || !FYND_OPERATIONS.has(summary.operation)) invalid();
  const projected = {
    kind: 'FYND_REQUEST',
    operation: summary.operation,
    shipmentId: shipmentId(summary.shipmentId),
    documentNumber: printableAscii(summary.documentNumber, 512),
    requestedLock: summary.requestedLock,
    requestedStatus: summary.requestedStatus,
  };
  const expectedLock = summary.operation === 'LOCK' ? true : null;
  const expectedStatus = summary.operation === 'TRANSITION' ? 'bag_invoiced' : null;
  if (projected.requestedLock !== expectedLock || projected.requestedStatus !== expectedStatus) invalid();
  return projected;
}

function projectFyndResponse(value) {
  const summary = exactValues(value, FYND_RESPONSE_FIELDS);
  if (summary.kind !== 'FYND_RESPONSE' || !FYND_OPERATIONS.has(summary.operation)) invalid();
  if (summary.responseStatus !== null
      && (!Number.isInteger(summary.responseStatus) || summary.responseStatus < 100 || summary.responseStatus > 599)) invalid();
  if (summary.locked !== null && typeof summary.locked !== 'boolean') invalid();
  if (summary.shipmentState !== null
      && (typeof summary.shipmentState !== 'string' || !SAFE_STATE_PATTERN.test(summary.shipmentState))) invalid();
  if (!FYND_CLASSIFICATIONS.has(summary.finalStateClassification)
      || typeof summary.retryable !== 'boolean') invalid();
  return {
    kind: 'FYND_RESPONSE',
    operation: summary.operation,
    shipmentId: shipmentId(summary.shipmentId),
    documentNumber: printableAscii(summary.documentNumber, 512),
    responseStatus: summary.responseStatus,
    locked: summary.locked,
    shipmentState: summary.shipmentState,
    finalStateClassification: summary.finalStateClassification,
    retryable: summary.retryable,
    latencyMs: nonnegativeSafeInteger(summary.latencyMs),
  };
}

function projectTaxSummary(value) {
  const tax = exactValues(value, OEIS_TAX_FIELDS);
  if (!TAX_CATEGORIES.has(tax.category)) invalid();
  if (tax.reasonCode !== null
      && (typeof tax.reasonCode !== 'string' || !REASON_CODE_PATTERN.test(tax.reasonCode))) invalid();
  const lineCount = positiveSafeInteger(tax.lineCount);
  if (lineCount > 1000) invalid();
  return {
    category: tax.category,
    rate: fixedDecimal(tax.rate),
    reasonCode: tax.reasonCode,
    lineCount,
  };
}

function projectOeisRequest(value) {
  const summary = exactValues(value, OEIS_REQUEST_FIELDS);
  const lineCount = positiveSafeInteger(summary.lineCount);
  if ((summary.documentType !== 'IN' && summary.documentType !== 'CN')
      || lineCount > 1000 || summary.currency !== 'SAR') invalid();
  if (summary.endpointPath !== '/API/V2/Transaction/UpdateInvoiceData') invalid();
  return {
    kind: summary.kind === 'OEIS_REQUEST' ? summary.kind : invalid(),
    documentNumber: printableAscii(summary.documentNumber, 512),
    documentType: summary.documentType,
    lineCount,
    currency: 'SAR',
    netAmount: fixedDecimal(summary.netAmount),
    taxAmount: fixedDecimal(summary.taxAmount),
    totalAmount: fixedDecimal(summary.totalAmount),
    taxSummaries: denseArray(summary.taxSummaries, 16).map(projectTaxSummary),
    requestByteCount: positiveSafeInteger(summary.requestByteCount),
    requestSha256: hash(summary.requestSha256),
    endpointPath: summary.endpointPath,
    attemptNumber: positiveSafeInteger(summary.attemptNumber),
    timeoutMs: positiveSafeInteger(summary.timeoutMs),
  };
}

function nullableEnum(value, allowed) {
  if (value !== null && !allowed.has(value)) invalid();
  return value;
}

function validationCodes(value) {
  const codes = denseArray(value, 20);
  const seen = new Set();
  return codes.map(code => {
    if (typeof code !== 'string' || !VALIDATION_CODE_PATTERN.test(code) || seen.has(code)) invalid();
    seen.add(code);
    return code;
  });
}

function projectOeisResponse(value) {
  const summary = exactValues(value, OEIS_RESPONSE_FIELDS);
  if (summary.kind !== 'OEIS_RESPONSE') invalid();
  if (summary.httpStatus !== null
      && (!Number.isInteger(summary.httpStatus) || summary.httpStatus < 100 || summary.httpStatus > 599)) invalid();
  if (summary.isSystemException !== null && typeof summary.isSystemException !== 'boolean') invalid();
  if (!VALIDATION_RESULTS.has(summary.validationResult) || typeof summary.retryable !== 'boolean') invalid();
  const responseByteCount = nonnegativeSafeInteger(summary.responseByteCount, { nullable: true });
  if ((responseByteCount === null) !== (summary.responseSha256 === null)) invalid();
  const projectedHash = summary.responseSha256 === null ? null : hash(summary.responseSha256);
  const uuid = printableAscii(summary.uuid, 512, { nullable: true });
  if (uuid !== null && !UUID_PATTERN.test(uuid)) invalid();
  return {
    kind: 'OEIS_RESPONSE',
    httpStatus: summary.httpStatus,
    isSystemException: summary.isSystemException,
    validationResult: summary.validationResult,
    reportingStatus: nullableEnum(summary.reportingStatus, REPORTING_STATUSES),
    clearanceStatus: nullableEnum(summary.clearanceStatus, CLEARANCE_STATUSES),
    invoiceNumber: printableAscii(summary.invoiceNumber, 512, { nullable: true }),
    transactionNumber: printableAscii(summary.transactionNumber, 512, { nullable: true }),
    uuid,
    invoiceCounter: printableAscii(summary.invoiceCounter, 512, { nullable: true }),
    matchingKey: printableAscii(summary.matchingKey, 512, { nullable: true }),
    validationCodes: validationCodes(summary.validationCodes),
    responseByteCount,
    responseSha256: projectedHash,
    retryable: summary.retryable,
    latencyMs: nonnegativeSafeInteger(summary.latencyMs),
  };
}

function projectArtifactPair(summary, prefix) {
  const present = summary[`${prefix}Present`];
  const byteCount = summary[`${prefix}ByteCount`];
  const sha256 = summary[`${prefix}Sha256`];
  if (typeof present !== 'boolean') invalid();
  if (!present) {
    if (byteCount !== null || sha256 !== null) invalid();
    return;
  }
  positiveSafeInteger(byteCount);
  hash(sha256);
}

function projectOeisArtifact(value) {
  const summary = exactValues(value, OEIS_ARTIFACT_FIELDS);
  if (summary.kind !== 'OEIS_ARTIFACT') invalid();
  projectArtifactPair(summary, 'signedXml');
  projectArtifactPair(summary, 'qr');
  return {
    kind: 'OEIS_ARTIFACT',
    signedXmlPresent: summary.signedXmlPresent,
    signedXmlByteCount: summary.signedXmlByteCount,
    signedXmlSha256: summary.signedXmlSha256,
    qrPresent: summary.qrPresent,
    qrByteCount: summary.qrByteCount,
    qrSha256: summary.qrSha256,
  };
}

function projectSummary(value) {
  const inspected = inspectPlainObject(value);
  const kindDescriptor = inspected.descriptors.kind;
  if (!kindDescriptor) invalid();
  let projected;
  if (kindDescriptor.value === 'FYND_REQUEST') projected = projectFyndRequest(value);
  else if (kindDescriptor.value === 'FYND_RESPONSE') projected = projectFyndResponse(value);
  else if (kindDescriptor.value === 'OEIS_REQUEST') projected = projectOeisRequest(value);
  else if (kindDescriptor.value === 'OEIS_RESPONSE') projected = projectOeisResponse(value);
  else if (kindDescriptor.value === 'OEIS_ARTIFACT') projected = projectOeisArtifact(value);
  else invalid();
  if (utf8Bytes(JSON.stringify(projected)) > SUMMARY_MAX_BYTES) invalid();
  return projected;
}

function expectedSummary(action, outcome) {
  if (action === 'FYND_LOCK_REQUESTED') return ['requestSummary', 'FYND_REQUEST', 'LOCK'];
  if (action === 'FYND_LOCK_CONFIRMED' || action === 'FYND_LOCK_FAILED') {
    return ['responseSummary', 'FYND_RESPONSE', 'LOCK'];
  }
  if (action === 'FYND_LOCK_READBACK') {
    return outcome === 'STARTED'
      ? ['requestSummary', 'FYND_REQUEST', 'LOCK_READBACK']
      : ['responseSummary', 'FYND_RESPONSE', 'LOCK_READBACK'];
  }
  if (action === 'FYND_TRANSITION_REQUESTED') return ['requestSummary', 'FYND_REQUEST', 'TRANSITION'];
  if (action === 'FYND_TRANSITION_CONFIRMED' || action === 'FYND_TRANSITION_FAILED') {
    return ['responseSummary', 'FYND_RESPONSE', 'TRANSITION'];
  }
  if (action === 'FYND_TRANSITION_READBACK') {
    return outcome === 'STARTED'
      ? ['requestSummary', 'FYND_REQUEST', 'TRANSITION_READBACK']
      : ['responseSummary', 'FYND_RESPONSE', 'TRANSITION_READBACK'];
  }
  if (action === 'OEIS_SUBMISSION_REQUESTED') return ['requestSummary', 'OEIS_REQUEST', null];
  if (action === 'OEIS_RESPONSE_RECEIVED' || action === 'OEIS_SUBMISSION_FAILED') {
    return ['responseSummary', 'OEIS_RESPONSE', null];
  }
  if (action === 'OEIS_ARTIFACT_STORED') return ['responseSummary', 'OEIS_ARTIFACT', null];
  return null;
}

function projectSummaries(item, durationMs) {
  const placement = expectedSummary(item.action, item.outcome);
  if (placement === null) {
    if (item.requestSummary !== null || item.responseSummary !== null) invalid();
    return { requestSummary: null, responseSummary: null };
  }
  const [slot, kind, operation] = placement;
  const other = slot === 'requestSummary' ? 'responseSummary' : 'requestSummary';
  if (item[slot] === null || item[other] !== null) invalid();
  const projected = projectSummary(item[slot]);
  if (projected.kind !== kind || (operation !== null && projected.operation !== operation)) invalid();
  if ((kind === 'FYND_RESPONSE' || kind === 'OEIS_RESPONSE') && projected.latencyMs !== durationMs) invalid();
  return {
    requestSummary: slot === 'requestSummary' ? projected : null,
    responseSummary: slot === 'responseSummary' ? projected : null,
  };
}

function projectRecentItem(value) {
  const item = exactValues(value, RECENT_ITEM_FIELDS);
  validateAction(item.lastStage, item.lastAction, item.lastOutcome);
  const firstOccurredAt = timestamp(item.firstOccurredAt);
  const lastOccurredAt = timestamp(item.lastOccurredAt);
  if (Date.parse(firstOccurredAt) > Date.parse(lastOccurredAt)) invalid();
  return {
    shipmentId: shipmentId(item.shipmentId),
    jobId: positiveSafeInteger(item.jobId, { nullable: true }),
    documentNumber: printableAscii(item.documentNumber, 512, { nullable: true }),
    lastStage: item.lastStage,
    lastAction: item.lastAction,
    lastOutcome: item.lastOutcome,
    lastSafeCode: safeCode(item.lastSafeCode, item.lastOutcome),
    firstOccurredAt,
    lastOccurredAt,
    version: nonnegativeSafeInteger(item.version),
  };
}

function projectTimelineItem(value) {
  const item = exactValues(value, TIMELINE_ITEM_FIELDS);
  validateAction(item.stage, item.action, item.outcome);
  const startedAt = timestamp(item.startedAt);
  const occurredAt = timestamp(item.occurredAt);
  let completedAt;
  let durationMs;
  if (item.outcome === 'STARTED') {
    if (item.completedAt !== null || item.durationMs !== null) invalid();
    completedAt = null;
    durationMs = null;
  } else {
    completedAt = timestamp(item.completedAt);
    durationMs = nonnegativeSafeInteger(item.durationMs);
    if (Date.parse(completedAt) - Date.parse(startedAt) !== durationMs) invalid();
  }

  const isClaim = item.action === 'JOB_CLAIMED' || item.action === 'OUTBOX_CLAIMED';
  const queueDelayMs = isClaim
    ? nonnegativeSafeInteger(item.queueDelayMs)
    : item.queueDelayMs;
  if (!isClaim && queueDelayMs !== null) invalid();

  let retryDelayMs = item.retryDelayMs;
  let nextAttemptAt = item.nextAttemptAt;
  if (item.action === 'RETRY_SCHEDULED') {
    retryDelayMs = nonnegativeSafeInteger(retryDelayMs);
    nextAttemptAt = timestamp(nextAttemptAt);
    if (Date.parse(nextAttemptAt) !== Date.parse(occurredAt) + retryDelayMs) invalid();
  } else if (retryDelayMs !== null || nextAttemptAt !== null) invalid();

  const summaries = projectSummaries(item, durationMs);
  return {
    jobId: positiveSafeInteger(item.jobId, { nullable: true }),
    documentNumber: printableAscii(item.documentNumber, 512, { nullable: true }),
    stage: item.stage,
    action: item.action,
    outcome: item.outcome,
    attemptNumber: nonnegativeSafeInteger(item.attemptNumber),
    startedAt,
    completedAt,
    durationMs,
    queueDelayMs,
    retryDelayMs,
    nextAttemptAt,
    safeCode: safeCode(item.safeCode, item.outcome),
    requestSummary: summaries.requestSummary,
    responseSummary: summaries.responseSummary,
    artifactJobId: positiveSafeInteger(item.artifactJobId, { nullable: true }),
    occurredAt,
  };
}

function validateRecentOrder(items) {
  const seen = new Set();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (seen.has(item.shipmentId)) invalid();
    seen.add(item.shipmentId);
    if (index === 0) continue;
    const previous = items[index - 1];
    if (previous.lastOccurredAt < item.lastOccurredAt
        || (previous.lastOccurredAt === item.lastOccurredAt
          && previous.shipmentId <= item.shipmentId)) invalid();
  }
}

function validateTimelineOrder(items) {
  for (let index = 1; index < items.length; index += 1) {
    if (items[index - 1].occurredAt > items[index].occurredAt) invalid();
  }
}

function projectRecentPage(value, maximumItems) {
  const page = exactValues(value, ['items', 'nextBefore']);
  const rawItems = denseArray(page.items, maximumItems);
  const items = rawItems.map(projectRecentItem);
  validateRecentOrder(items);
  return deepFreeze({ items, nextBefore: cursor(page.nextBefore) });
}

function projectPreJobFailurePage(value, maximumItems) {
  const page = projectRecentPage(value, maximumItems);
  for (const item of page.items) {
    const isRejectedHead = (item.lastStage === 'WEBHOOK' && item.lastAction === 'WEBHOOK_REJECTED')
      || (item.lastStage === 'VALIDATION' && item.lastAction === 'VALIDATION_FAILED');
    if (item.jobId !== null || item.documentNumber !== null
        || !isRejectedHead || item.lastOutcome !== 'FAILURE') invalid();
  }
  return page;
}

function projectTimelinePage(value, requestedShipmentId, maximumItems) {
  const page = exactValues(value, ['shipmentId', 'items', 'nextBefore']);
  if (shipmentId(page.shipmentId) !== requestedShipmentId) invalid();
  const items = denseArray(page.items, maximumItems).map(projectTimelineItem);
  validateTimelineOrder(items);
  return deepFreeze({
    shipmentId: requestedShipmentId,
    items,
    nextBefore: cursor(page.nextBefore),
  });
}

function responseStatus(response) {
  if (response === null || typeof response !== 'object' || Array.isArray(response)
      || Object.getPrototypeOf(response) !== Object.prototype) invalid();
  const descriptor = Object.getOwnPropertyDescriptor(response, 'status');
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalid();
  return descriptor.value;
}

function responseText(response) {
  const descriptor = Object.getOwnPropertyDescriptor(response, 'data');
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || typeof descriptor.value !== 'string') invalid();
  return descriptor.value;
}

function preserveText(value) {
  return value;
}

function acceptStatus() {
  return true;
}

async function requestPage(url, config, project) {
  let response;
  try {
    response = await axios.get(url, config);
  } catch {
    throw sanitizedError('request-failed');
  }

  let status;
  try {
    status = responseStatus(response);
  } catch {
    throw sanitizedError('request-failed');
  }
  if (status === 401) throw sanitizedError('unauthorized');
  if (status === 404) throw sanitizedError('not-found');
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    throw sanitizedError('request-failed');
  }

  try {
    const text = responseText(response);
    const byteCount = utf8Bytes(text);
    if (byteCount < 1 || byteCount > RESPONSE_MAX_BYTES) invalid();
    return project(JSON.parse(text));
  } catch {
    throw sanitizedError('request-failed');
  }
}

function requestConfig(normalizedCompanyId, pageLimit, before) {
  const params = { limit: pageLimit };
  if (before !== null) params.before = before;
  return {
    headers: { 'x-company-id': normalizedCompanyId },
    params,
    responseType: 'text',
    transformResponse: [preserveText],
    validateStatus: acceptStatus,
  };
}

export async function listShipmentActivity(input) {
  try {
    const values = inputValues(input, ['companyId', 'limit', 'before'], ['companyId']);
    const normalizedCompanyId = companyId(values.companyId);
    const pageLimit = limit(values.limit === undefined ? 20 : values.limit);
    const before = cursor(values.before === undefined ? null : values.before);
    return requestPage(
      BASE_URL,
      requestConfig(normalizedCompanyId, pageLimit, before),
      page => projectRecentPage(page, pageLimit),
    );
  } catch (error) {
    if ((typeof error === 'object' || typeof error === 'function')
        && error !== null && SANITIZED_ERRORS.has(error)) throw error;
    throw sanitizedError('request-failed');
  }
}

export async function listPreJobFailures(input) {
  try {
    const values = inputValues(input, ['companyId', 'limit', 'before'], ['companyId']);
    const normalizedCompanyId = companyId(values.companyId);
    const pageLimit = limit(values.limit === undefined ? 20 : values.limit);
    const before = cursor(values.before === undefined ? null : values.before);
    return requestPage(
      PRE_JOB_FAILURES_URL,
      requestConfig(normalizedCompanyId, pageLimit, before),
      page => projectPreJobFailurePage(page, pageLimit),
    );
  } catch (error) {
    if ((typeof error === 'object' || typeof error === 'function')
        && error !== null && SANITIZED_ERRORS.has(error)) throw error;
    throw sanitizedError('request-failed');
  }
}

export async function getShipmentTimeline(input) {
  try {
    const values = inputValues(
      input,
      ['companyId', 'shipmentId', 'limit', 'before'],
      ['companyId', 'shipmentId'],
    );
    const normalizedCompanyId = companyId(values.companyId);
    const normalizedShipmentId = shipmentId(values.shipmentId);
    const pageLimit = limit(values.limit === undefined ? 50 : values.limit);
    const before = cursor(values.before === undefined ? null : values.before);
    return requestPage(
      `${BASE_URL}/${encodeURIComponent(normalizedShipmentId)}`,
      requestConfig(normalizedCompanyId, pageLimit, before),
      page => projectTimelinePage(page, normalizedShipmentId, pageLimit),
    );
  } catch (error) {
    if ((typeof error === 'object' || typeof error === 'function')
        && error !== null && SANITIZED_ERRORS.has(error)) throw error;
    throw sanitizedError('request-failed');
  }
}
