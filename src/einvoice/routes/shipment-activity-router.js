'use strict';

const express = require('express');
const { types } = require('node:util');
const FdkSession = require('@gofynd/fdk-extension-javascript/express/session/session');
const { EinvoiceError } = require('../errors');
const {
  SHIPMENT_ACTIVITY_RESPONSE_MAX_BYTES,
} = require('../shipment-activity-service');

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_TIMELINE_LIMIT = 50;
const MAX_LIMIT = 50;
const FDK_SESSION_PROTOTYPE = FdkSession.prototype;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;
const HEAD_ITEM_FIELDS = Object.freeze([
  'shipmentId', 'jobId', 'documentNumber', 'lastStage', 'lastAction',
  'lastOutcome', 'lastSafeCode', 'firstOccurredAt', 'lastOccurredAt', 'version',
]);
const EVENT_ITEM_FIELDS = Object.freeze([
  'jobId', 'documentNumber', 'stage', 'action', 'outcome', 'attemptNumber',
  'startedAt', 'completedAt', 'durationMs', 'queueDelayMs', 'retryDelayMs',
  'nextAttemptAt', 'safeCode', 'requestSummary', 'responseSummary',
  'artifactJobId', 'occurredAt',
]);
const SUMMARY_FIELDS = Object.freeze({
  FYND_REQUEST: Object.freeze([
    'kind', 'operation', 'shipmentId', 'documentNumber', 'requestedLock', 'requestedStatus',
  ]),
  FYND_RESPONSE: Object.freeze([
    'kind', 'operation', 'shipmentId', 'documentNumber', 'responseStatus', 'locked',
    'shipmentState', 'finalStateClassification', 'retryable', 'latencyMs',
  ]),
  OEIS_REQUEST: Object.freeze([
    'kind', 'documentNumber', 'documentType', 'lineCount', 'currency', 'netAmount',
    'taxAmount', 'totalAmount', 'taxSummaries', 'requestByteCount', 'requestSha256',
    'endpointPath', 'attemptNumber', 'timeoutMs',
  ]),
  OEIS_RESPONSE: Object.freeze([
    'kind', 'httpStatus', 'isSystemException', 'validationResult', 'reportingStatus',
    'clearanceStatus', 'invoiceNumber', 'transactionNumber', 'uuid', 'invoiceCounter',
    'matchingKey', 'validationCodes', 'responseByteCount', 'responseSha256',
    'retryable', 'latencyMs',
  ]),
  OEIS_ARTIFACT: Object.freeze([
    'kind', 'signedXmlPresent', 'signedXmlByteCount', 'signedXmlSha256',
    'qrPresent', 'qrByteCount', 'qrSha256',
  ]),
});

function invalidRouter() {
  const error = new Error('Shipment activity router configuration is invalid');
  error.code = 'SHIPMENT_ACTIVITY_ROUTER_INVALID';
  return error;
}

function isProxy(value) {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && types.isProxy(value);
}

function ownDataValue(value, field) {
  try {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')
        || isProxy(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
    return descriptor.value;
  } catch (_error) {
    return undefined;
  }
}

function plainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype) throw invalidRouter();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string')) throw invalidRouter();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || descriptor.enumerable !== true) throw invalidRouter();
  }
  return { keys, descriptors };
}

function exactRecord(value, fields) {
  const { keys, descriptors } = plainRecord(value);
  if (keys.length !== fields.length || keys.some((key, index) => key !== fields[index])) {
    throw invalidRouter();
  }
  const output = {};
  for (const field of fields) output[field] = descriptors[field].value;
  return output;
}

function snapshotService(value) {
  try {
    const inspected = plainRecord(value);
    if (inspected.keys.length !== 3
        || inspected.keys[0] !== 'listShipments'
        || inspected.keys[1] !== 'listPreJobFailures'
        || inspected.keys[2] !== 'getTimeline') throw invalidRouter();
    const snapshot = {};
    for (const field of ['listShipments', 'listPreJobFailures', 'getTimeline']) {
      const method = inspected.descriptors[field].value;
      if (typeof method !== 'function' || isProxy(method)) throw invalidRouter();
      snapshot[field] = method;
    }
    return Object.freeze(snapshot);
  } catch (_error) {
    throw invalidRouter();
  }
}

function authenticatedCompanyId(req) {
  const session = ownDataValue(req, 'fdkSession');
  try {
    if (session === null || typeof session !== 'object' || Array.isArray(session)
        || isProxy(session)) return null;
    const prototype = Object.getPrototypeOf(session);
    if (prototype !== Object.prototype && prototype !== FDK_SESSION_PROTOTYPE) return null;
  } catch (_error) {
    return null;
  }
  const companyId = ownDataValue(session, 'company_id');
  if (Number.isSafeInteger(companyId) && companyId > 0) return String(companyId);
  if (typeof companyId === 'string' && /^[1-9][0-9]{0,63}$/.test(companyId)) return companyId;
  return null;
}

function parseLimit(value, defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_LIMIT) return null;
  return parsed;
}

function parseQuery(req, defaultLimit) {
  try {
    const query = ownDataValue(req, 'query');
    if (query === null || typeof query !== 'object' || Array.isArray(query) || isProxy(query)) return null;
    const keys = Reflect.ownKeys(query);
    if (keys.some(key => typeof key !== 'string' || (key !== 'limit' && key !== 'before'))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(query);
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(descriptors[key], 'value')) return null;
    }
    const limitValue = descriptors.limit ? descriptors.limit.value : undefined;
    const beforeValue = descriptors.before ? descriptors.before.value : undefined;
    const limit = parseLimit(limitValue, defaultLimit);
    const before = beforeValue === undefined ? null : beforeValue;
    if (limit === null || (before !== null
      && (typeof before !== 'string' || before.length === 0 || before.length > 1_024))) return null;
    return { limit, before };
  } catch (_error) {
    return null;
  }
}

function validShipmentId(value) {
  return typeof value === 'string'
    && IDENTIFIER_PATTERN.test(value)
    && Buffer.byteLength(value, 'utf8') <= 512;
}

function notFound(res) {
  return res.status(404).json({ success: false });
}

function activityNotFound(error) {
  try {
    if (error === null || typeof error !== 'object' || isProxy(error)) return false;
    const code = ownDataValue(error, 'code');
    return Object.getPrototypeOf(error) === EinvoiceError.prototype
      && (code === 'SHIPMENT_ACTIVITY_REQUEST_INVALID'
        || code === 'SHIPMENT_ACTIVITY_NOT_FOUND');
  } catch (_error) {
    return false;
  }
}

function malformedPathError(error) {
  try {
    return error !== null && typeof error === 'object' && !isProxy(error)
      && Object.getPrototypeOf(error) === URIError.prototype
      && ownDataValue(error, 'status') === 400
      && ownDataValue(error, 'statusCode') === 400;
  } catch (_error) {
    return false;
  }
}

function denseArray(value) {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw invalidRouter();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length && descriptors.length.value;
  if (!Number.isSafeInteger(length) || length < 0 || Reflect.ownKeys(value).length !== length + 1) {
    throw invalidRouter();
  }
  const output = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw invalidRouter();
    }
    output.push(descriptor.value);
  }
  return output;
}

function safeScalar(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw invalidRouter();
}

function safeTaxSummaries(value) {
  return denseArray(value).map(entry => {
    const raw = exactRecord(entry, ['category', 'rate', 'reasonCode', 'lineCount']);
    return Object.fromEntries(Object.entries(raw).map(([key, item]) => [key, safeScalar(item)]));
  });
}

function safeValidationCodes(value) {
  return denseArray(value).map(safeScalar);
}

function safeSummary(value) {
  if (value === null) return null;
  const inspected = plainRecord(value);
  const kind = inspected.descriptors.kind
    && Object.prototype.hasOwnProperty.call(inspected.descriptors.kind, 'value')
    ? inspected.descriptors.kind.value
    : null;
  const fields = SUMMARY_FIELDS[kind];
  if (!fields) throw invalidRouter();
  const raw = exactRecord(value, fields);
  const output = {};
  for (const field of fields) {
    if (field === 'taxSummaries') output[field] = safeTaxSummaries(raw[field]);
    else if (field === 'validationCodes') output[field] = safeValidationCodes(raw[field]);
    else output[field] = safeScalar(raw[field]);
  }
  return output;
}

function safeHeadItem(value) {
  const raw = exactRecord(value, HEAD_ITEM_FIELDS);
  return Object.fromEntries(Object.entries(raw).map(([key, item]) => [key, safeScalar(item)]));
}

function safeEventItem(value) {
  const raw = exactRecord(value, EVENT_ITEM_FIELDS);
  const output = {};
  for (const field of EVENT_ITEM_FIELDS) {
    if (field === 'requestSummary' || field === 'responseSummary') {
      output[field] = safeSummary(raw[field]);
    } else {
      output[field] = safeScalar(raw[field]);
    }
  }
  return output;
}

function safeResponse(value, kind, expectedShipmentId) {
  let output;
  if (kind === 'LIST') {
    const raw = exactRecord(value, ['items', 'nextBefore']);
    output = {
      items: denseArray(raw.items).map(safeHeadItem),
      nextBefore: safeScalar(raw.nextBefore),
    };
  } else {
    const raw = exactRecord(value, ['shipmentId', 'items', 'nextBefore']);
    if (raw.shipmentId !== expectedShipmentId) throw invalidRouter();
    output = {
      shipmentId: safeScalar(raw.shipmentId),
      items: denseArray(raw.items).map(safeEventItem),
      nextBefore: safeScalar(raw.nextBefore),
    };
  }
  const serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized, 'utf8') > SHIPMENT_ACTIVITY_RESPONSE_MAX_BYTES) {
    throw invalidRouter();
  }
  return Buffer.from(serialized, 'utf8');
}

function sendJsonBytes(res, bytes) {
  res.status(200);
  res.set('Content-Type', 'application/json; charset=utf-8');
  return res.end(bytes);
}

function route(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (activityNotFound(error)) return notFound(res);
      return next(invalidRouter());
    }
    return undefined;
  };
}

function shipmentActivitySecurityHeaders(req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  res.set('Pragma', 'no-cache');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
}

function shipmentActivityGetOnly(req, res, next) {
  if (req.method !== 'GET') return notFound(res);
  return next();
}

function shipmentActivityDisabled(req, res) {
  return notFound(res);
}

function createShipmentActivityRouter(options = {}) {
  const shipmentActivityService = snapshotService(ownDataValue(options, 'shipmentActivityService'));
  const router = express.Router();

  router.get('/', route(async (req, res) => {
    const companyId = authenticatedCompanyId(req);
    const query = parseQuery(req, DEFAULT_LIST_LIMIT);
    if (companyId === null || query === null) return notFound(res);
    const result = await shipmentActivityService.listShipments({ companyId, ...query });
    return sendJsonBytes(res, safeResponse(result, 'LIST'));
  }));

  router.get('/pre-job-failures', route(async (req, res) => {
    const companyId = authenticatedCompanyId(req);
    const query = parseQuery(req, DEFAULT_LIST_LIMIT);
    if (companyId === null || query === null) return notFound(res);
    const result = await shipmentActivityService.listPreJobFailures({ companyId, ...query });
    return sendJsonBytes(res, safeResponse(result, 'LIST'));
  }));

  router.get('/:shipmentId', route(async (req, res) => {
    const companyId = authenticatedCompanyId(req);
    const query = parseQuery(req, DEFAULT_TIMELINE_LIMIT);
    const shipmentId = ownDataValue(req.params, 'shipmentId');
    if (companyId === null || query === null || !validShipmentId(shipmentId)) return notFound(res);
    const result = await shipmentActivityService.getTimeline({
      companyId, shipmentId, ...query,
    });
    return sendJsonBytes(res, safeResponse(result, 'TIMELINE', shipmentId));
  }));

  router.use((error, req, res, next) => {
    if (malformedPathError(error)) return notFound(res);
    return next(error);
  });

  return router;
}

module.exports = {
  createShipmentActivityRouter,
  shipmentActivitySecurityHeaders,
  shipmentActivityGetOnly,
  shipmentActivityDisabled,
};
