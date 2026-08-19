'use strict';

const crypto = require('crypto');
const { types } = require('util');

const {
  buildFyndLockRequest,
  buildFyndTransitionTemplate,
} = require('./clients/fynd-shipment-client');
const { OEIS_UPDATE_PATH } = require('./clients/oeis-client');
const { EinvoiceError } = require('./errors');
const { normalizeSnapshot } = require('./repositories/invoice-repository-validation');

const HELD_STATE = 'SUBMISSION_HELD';
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const OEIS_API_KEY_PATTERN = /^[\x20-\x7e]{1,1024}$/;
const FINANCIAL_FIELDS = Object.freeze([
  'price_effective',
  'promotion_effective_discount',
  'coupon_effective_discount',
  'value_of_good',
  'gst_tax_percentage',
  'gst_fee',
  'amount_paid',
]);
const PRICE_FIELDS = Object.freeze([
  'promotion_effective_discount',
  'coupon_effective_discount',
]);
const OPTIONAL_FINANCIAL_FIELDS = Object.freeze(['delivery_charge']);
const DELIVERY_CHARGE_FIELDS = Object.freeze([
  'taxCategory',
  'taxRate',
  'netAmount',
  'taxAmount',
  'paidAmount',
]);
const INVALID_BOUNDARY_VALUE = Object.freeze({});
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const GENERIC_FAILURE_MESSAGE = 'Invoice processing failed. Review the failure code.';
const FAILURE_MESSAGES = Object.freeze({
  LOCAL_VALIDATION_FAILED: 'Invoice data failed local validation.',
  OEIS_HTTP_4XX: 'OEIS rejected the invoice request.',
  OEIS_REQUEST_TOO_LARGE: 'Invoice request exceeds the configured OEIS size limit.',
  INVOICE_RETRY_EXHAUSTED: 'Invoice processing exhausted its retry limit.',
  FYND_LOCK_RETRY_EXHAUSTED: 'Shipment locking exhausted its retry limit.',
  OEIS_RETRY_EXHAUSTED: 'OEIS submission exhausted its retry limit.',
  FYND_TRANSITION_RETRY_EXHAUSTED: 'Shipment transition exhausted its retry limit.',
  OEIS_UNKNOWN_RESULT: 'Invoice outcome is indeterminate and requires operator review.',
  FYND_LOCK_STATE_INDETERMINATE: 'Shipment lock state is indeterminate and requires operator review.',
  FYND_TRANSITION_STATE_INDETERMINATE: 'Shipment transition state is indeterminate and requires operator review.',
});

function fail(code, message) {
  throw new EinvoiceError(code, message);
}

function invalidService() {
  fail('DRY_RUN_SERVICE_INVALID', 'Dry-run service configuration is invalid');
}

function invalidRequest() {
  fail('DRY_RUN_REQUEST_INVALID', 'Dry-run request is invalid');
}

function notFound() {
  fail('DRY_RUN_NOT_FOUND', 'Dry-run job was not found');
}

function invalidData() {
  fail('DRY_RUN_DATA_INVALID', 'Dry-run data is invalid');
}

function readFailed() {
  fail('DRY_RUN_READ_FAILED', 'Dry-run data could not be read');
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || types.isProxy(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function ownDataRecord(value, fields, invalid) {
  try {
    if (!isPlainObject(value)) throw INVALID_BOUNDARY_VALUE;
    const result = Object.create(null);
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw INVALID_BOUNDARY_VALUE;
      }
      result[field] = descriptor.value;
    }
    return result;
  } catch {
    invalid();
  }
}

function optionalOwnData(value, field, invalid) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor) return undefined;
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw INVALID_BOUNDARY_VALUE;
    }
    return descriptor.value;
  } catch {
    invalid();
  }
}

function ownDataArray(value, invalid) {
  try {
    if (!Array.isArray(value) || types.isProxy(value)
        || Object.getPrototypeOf(value) !== Array.prototype) {
      throw INVALID_BOUNDARY_VALUE;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
        || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
      throw INVALID_BOUNDARY_VALUE;
    }
    const snapshot = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw INVALID_BOUNDARY_VALUE;
      }
      snapshot.push(descriptor.value);
    }
    return snapshot;
  } catch {
    invalid();
  }
}

function optionalOwnDataRecord(value, fields, invalid) {
  try {
    if (!isPlainObject(value)) throw INVALID_BOUNDARY_VALUE;
    const result = Object.create(null);
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor) continue;
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw INVALID_BOUNDARY_VALUE;
      }
      result[field] = descriptor.value;
    }
    return result;
  } catch {
    invalid();
  }
}

function requireNonemptyString(value, invalid) {
  if (typeof value !== 'string' || value.trim() === '') invalid();
  return value;
}

function requireIdentifier(value, invalid) {
  const identifier = requireNonemptyString(value, invalid);
  if (!IDENTIFIER_PATTERN.test(identifier)) invalid();
  return identifier;
}

function requirePositiveId(value, invalid) {
  if (!Number.isSafeInteger(value) || value <= 0) invalid();
  return value;
}

function requireVersion(value, invalid) {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function requireTimestamp(value, invalid) {
  requireNonemptyString(value, invalid);
  if (Number.isNaN(Date.parse(value))) invalid();
  return value;
}

function snapshotFactoryOptions(options) {
  try {
    if (!isPlainObject(options)) throw INVALID_BOUNDARY_VALUE;
    const allowed = new Set(['repository', 'oeisBaseUrl', 'oeisApiKey', 'maxRequestBytes']);
    if (Reflect.ownKeys(options).some(key => !allowed.has(key))) {
      throw INVALID_BOUNDARY_VALUE;
    }
    return ownDataRecord(options, [...allowed], invalidService);
  } catch {
    invalidService();
  }
}

function validateOeisApiKey(value) {
  if (typeof value !== 'string' || value !== value.trim()
      || !OEIS_API_KEY_PATTERN.test(value)) invalidService();
  return value;
}

function snapshotRepository(repository) {
  const fields = [
    'listDryRunJobsForCompany',
    'listFailedJobsForCompany',
    'getDryRunJobForCompany',
    'getDryRunRequestForCompany',
  ];
  let methods;
  try {
    if (repository === null || typeof repository !== 'object' || Array.isArray(repository)) {
      throw INVALID_BOUNDARY_VALUE;
    }
    methods = ownDataRecord(repository, fields, invalidService);
  } catch {
    invalidService();
  }
  if (fields.some(field => typeof methods[field] !== 'function')) invalidService();
  return methods;
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value === '' || /[\s\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    invalidService();
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalidService();
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username !== '' || parsed.password !== ''
      || parsed.search !== '' || parsed.hash !== '') {
    invalidService();
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

function buildOeisUrl(baseUrl) {
  const parsedBase = new URL(baseUrl);
  const expectedPathname = `${parsedBase.pathname === '/' ? '' : parsedBase.pathname}${OEIS_UPDATE_PATH}`;
  const value = `${baseUrl}${OEIS_UPDATE_PATH}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalidService();
  }
  if (parsed.origin !== parsedBase.origin || parsed.pathname !== expectedPathname
      || parsed.search !== '' || parsed.hash !== '') {
    invalidService();
  }
  return parsed.href;
}

function snapshotListInput(input) {
  const result = ownDataRecord(input, ['companyId', 'limit', 'beforeId'], invalidRequest);
  requireNonemptyString(result.companyId, invalidRequest);
  if (!Number.isSafeInteger(result.limit) || result.limit <= 0 || result.limit > 100) invalidRequest();
  if (result.beforeId !== null && result.beforeId !== undefined) {
    requirePositiveId(result.beforeId, invalidRequest);
  }
  return {
    companyId: result.companyId,
    limit: result.limit,
    beforeId: result.beforeId ?? null,
  };
}

function snapshotJobInput(input) {
  const result = ownDataRecord(input, ['companyId', 'jobId'], invalidRequest);
  requireNonemptyString(result.companyId, invalidRequest);
  requirePositiveId(result.jobId, invalidRequest);
  return { companyId: result.companyId, jobId: result.jobId };
}

function projectListItem(value) {
  const item = ownDataRecord(value, [
    'jobId',
    'shipmentId',
    'documentNumber',
    'state',
    'lockedAt',
    'createdAt',
    'updatedAt',
    'version',
  ], invalidData);
  requirePositiveId(item.jobId, invalidData);
  requireIdentifier(item.shipmentId, invalidData);
  requireIdentifier(item.documentNumber, invalidData);
  if (item.state !== HELD_STATE) invalidData();
  requireTimestamp(item.lockedAt, invalidData);
  requireTimestamp(item.createdAt, invalidData);
  requireTimestamp(item.updatedAt, invalidData);
  requireVersion(item.version, invalidData);
  return {
    jobId: item.jobId,
    shipmentId: item.shipmentId,
    documentNumber: item.documentNumber,
    state: item.state,
    lockedAt: item.lockedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    version: item.version,
  };
}

function projectListPage(value) {
  const page = ownDataRecord(value, ['items', 'nextBeforeId'], invalidData);
  const items = ownDataArray(page.items, invalidData);
  if (page.nextBeforeId !== null) requirePositiveId(page.nextBeforeId, invalidData);
  return {
    items: items.map(projectListItem),
    nextBeforeId: page.nextBeforeId,
  };
}

function exactOwnDataRecord(value, fields, invalid) {
  try {
    if (!isPlainObject(value) || Reflect.ownKeys(value).length !== fields.length) {
      throw INVALID_BOUNDARY_VALUE;
    }
    return ownDataRecord(value, fields, invalid);
  } catch {
    invalid();
  }
}

function strictTimestamp(value) {
  requireTimestamp(value, invalidData);
  if (new Date(value).toISOString() !== value) invalidData();
  return value;
}

function projectFailureItem(value) {
  const item = exactOwnDataRecord(value, [
    'jobId', 'shipmentId', 'documentNumber', 'state', 'attemptCount',
    'lastErrorCode', 'lockedAt', 'createdAt', 'updatedAt', 'version',
  ], invalidData);
  requirePositiveId(item.jobId, invalidData);
  requireIdentifier(item.shipmentId, invalidData);
  requireIdentifier(item.documentNumber, invalidData);
  if (!['DATA_FAILED', 'INDETERMINATE'].includes(item.state)) invalidData();
  if (!Number.isSafeInteger(item.attemptCount) || item.attemptCount < 0) invalidData();
  if (!(item.lastErrorCode === null || (typeof item.lastErrorCode === 'string'
    && FAILURE_CODE_PATTERN.test(item.lastErrorCode)))) invalidData();
  if (item.lockedAt !== null) strictTimestamp(item.lockedAt);
  strictTimestamp(item.createdAt);
  strictTimestamp(item.updatedAt);
  requireVersion(item.version, invalidData);
  return Object.freeze({
    jobId: item.jobId,
    shipmentId: item.shipmentId,
    documentNumber: item.documentNumber,
    state: item.state,
    failureCode: item.lastErrorCode,
    failureMessage: FAILURE_MESSAGES[item.lastErrorCode] || GENERIC_FAILURE_MESSAGE,
    attemptCount: item.attemptCount,
    lockRecordedAt: item.lockedAt,
    createdAt: item.createdAt,
    failedAt: item.updatedAt,
    version: item.version,
  });
}

function projectFailurePage(value) {
  const page = exactOwnDataRecord(value, ['items', 'nextBeforeId'], invalidData);
  const items = ownDataArray(page.items, invalidData).map(projectFailureItem);
  if (page.nextBeforeId !== null) requirePositiveId(page.nextBeforeId, invalidData);
  return Object.freeze({ items: Object.freeze(items), nextBeforeId: page.nextBeforeId });
}

function copyNormalizedSnapshot(value) {
  const source = ownDataRecord(value, [
    'shipmentId',
    'confirmedAt',
    'branchCode',
    'currency',
    'paymentMode',
    'amountPaid',
    'policyVersion',
    'taxEligibility',
    'bags',
  ], invalidData);
  const eligibility = ownDataRecord(source.taxEligibility, [
    'governmentBorneVatEligible', 'reasonCode', 'evidenceReference', 'verifiedAt',
    'buyerName', 'buyerNationalId',
  ], invalidData);
  const bags = ownDataArray(source.bags, invalidData);
  const snapshot = {
    shipmentId: source.shipmentId,
    confirmedAt: source.confirmedAt,
    branchCode: source.branchCode,
    currency: source.currency,
    paymentMode: source.paymentMode,
    amountPaid: source.amountPaid,
    policyVersion: source.policyVersion,
    taxEligibility: { ...eligibility },
    bags: bags.map(valueBag => {
      const bag = ownDataRecord(valueBag, [
        'bagId',
        'lineNumber',
        'productCode',
        'quantity',
        'financialBreakup',
      ], invalidData);
      const financialBreakup = ownDataRecord(bag.financialBreakup, FINANCIAL_FIELDS, invalidData);
      const result = {
        bagId: bag.bagId,
        lineNumber: bag.lineNumber,
        productCode: bag.productCode,
        quantity: bag.quantity,
        financialBreakup: {
          ...financialBreakup,
          ...optionalOwnDataRecord(bag.financialBreakup, OPTIONAL_FINANCIAL_FIELDS, invalidData),
        },
      };
      const pricesValue = optionalOwnData(valueBag, 'prices', invalidData);
      if (pricesValue !== undefined) {
        result.prices = { ...optionalOwnDataRecord(pricesValue, PRICE_FIELDS, invalidData) };
      }
      return result;
    }),
  };
  const deliveryChargeValue = optionalOwnData(value, 'deliveryCharge', invalidData);
  if (deliveryChargeValue !== undefined) {
    snapshot.deliveryCharge = {
      ...ownDataRecord(deliveryChargeValue, DELIVERY_CHARGE_FIELDS, invalidData),
    };
  }
  try {
    const normalized = normalizeSnapshot(snapshot).snapshot;
    return {
      ...normalized,
      taxEligibility: {
        governmentBorneVatEligible: normalized.taxEligibility.governmentBorneVatEligible,
        reasonCode: normalized.taxEligibility.reasonCode,
        evidenceReference: normalized.taxEligibility.evidenceReference,
        verifiedAt: normalized.taxEligibility.verifiedAt,
      },
    };
  } catch {
    invalidData();
  }
}

function snapshotHeldJob(value, query) {
  if (value === null) notFound();
  const identity = ownDataRecord(value, ['id', 'companyId', 'state'], invalidData);
  if (identity.id !== query.jobId || identity.companyId !== query.companyId
      || identity.state !== HELD_STATE) {
    notFound();
  }
  const protectedFields = ownDataRecord(value, [
    'shipmentId',
    'documentNumber',
    'shipmentSnapshot',
    'oeisRequestJson',
    'requestHash',
    'lockedAt',
    'version',
  ], invalidData);
  requireIdentifier(protectedFields.shipmentId, invalidData);
  requireIdentifier(protectedFields.documentNumber, invalidData);
  requireTimestamp(protectedFields.lockedAt, invalidData);
  requireVersion(protectedFields.version, invalidData);
  const normalizedSnapshot = copyNormalizedSnapshot(protectedFields.shipmentSnapshot);
  if (normalizedSnapshot.shipmentId !== protectedFields.shipmentId) invalidData();
  return { ...identity, ...protectedFields, normalizedSnapshot };
}

function validateRequestBytes(requestJson, requestHash, documentNumber, maxRequestBytes) {
  if (typeof requestJson !== 'string' || typeof requestHash !== 'string'
      || !HASH_PATTERN.test(requestHash)) {
    invalidData();
  }
  const requestBytes = Buffer.byteLength(requestJson, 'utf8');
  if (requestBytes > maxRequestBytes) invalidData();
  const actualHash = crypto.createHash('sha256').update(requestJson, 'utf8').digest('hex');
  if (actualHash !== requestHash) invalidData();
  let rows;
  try {
    rows = JSON.parse(requestJson);
  } catch {
    invalidData();
  }
  const requestRows = ownDataArray(rows, invalidData);
  if (requestRows.length === 0) invalidData();
  for (const row of requestRows) {
    const rowData = ownDataRecord(row, ['TRAN_DOC_NO'], invalidData);
    if (rowData.TRAN_DOC_NO !== documentNumber) invalidData();
  }
  return { requestBytes, requestRows };
}

function sanitizedDiagnosticJson(requestRows) {
  try {
    const sanitizedRows = requestRows.map(row => {
      if (!isPlainObject(row)) invalidData();
      const result = Object.create(null);
      for (const key of Reflect.ownKeys(row)) {
        if (typeof key !== 'string') invalidData();
        const descriptor = Object.getOwnPropertyDescriptor(row, key);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalidData();
        if (key === 'CUST_NAME_WALKIN' || key === 'CUST_ADDITIONAL_ID_NO_WALKIN') {
          if (!(descriptor.value === null || typeof descriptor.value === 'string')) invalidData();
          result[key] = descriptor.value === null ? null : '<redacted>';
        } else {
          const scalar = descriptor.value === null
            || typeof descriptor.value === 'string'
            || typeof descriptor.value === 'boolean'
            || (typeof descriptor.value === 'number' && Number.isFinite(descriptor.value));
          if (!scalar) invalidData();
          result[key] = descriptor.value;
        }
      }
      return result;
    });
    return JSON.stringify(sanitizedRows);
  } catch {
    invalidData();
  }
}

function snapshotHeldRequest(value, query, maxRequestBytes) {
  if (value === null) notFound();
  const identity = ownDataRecord(value, ['jobId'], invalidData);
  if (identity.jobId !== query.jobId) notFound();
  const request = ownDataRecord(value, [
    'documentNumber',
    'requestJson',
    'requestHash',
  ], invalidData);
  requireIdentifier(request.documentNumber, invalidData);
  const validation = validateRequestBytes(
    request.requestJson,
    request.requestHash,
    request.documentNumber,
    maxRequestBytes,
  );
  return { ...identity, ...request, ...validation };
}

async function safeRepositoryRead(operation) {
  try {
    return await operation();
  } catch {
    readFailed();
  }
}

function createDryRunService(options) {
  const {
    repository,
    oeisBaseUrl,
    oeisApiKey,
    maxRequestBytes,
  } = snapshotFactoryOptions(options);
  const readPort = snapshotRepository(repository);
  const normalizedBaseUrl = normalizeBaseUrl(oeisBaseUrl);
  const validatedOeisApiKey = validateOeisApiKey(oeisApiKey);
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) invalidService();
  const oeisUrl = buildOeisUrl(normalizedBaseUrl);

  async function readValidatedHeldRequest(query) {
    const returned = await safeRepositoryRead(() => readPort.getDryRunRequestForCompany.call(
      repository,
      query,
    ));
    return snapshotHeldRequest(returned, query, maxRequestBytes);
  }

  return Object.freeze({
    async listDryRuns(input) {
      const query = snapshotListInput(input);
      const page = await safeRepositoryRead(() => readPort.listDryRunJobsForCompany.call(
        repository,
        query,
      ));
      return projectListPage(page);
    },

    async listDryRunFailures(input) {
      const query = snapshotListInput(input);
      const page = await safeRepositoryRead(() => readPort.listFailedJobsForCompany.call(
        repository,
        query,
      ));
      return projectFailurePage(page);
    },

    async getDryRunJourney(input) {
      const query = snapshotJobInput(input);
      const returned = await safeRepositoryRead(() => readPort.getDryRunJobForCompany.call(
        repository,
        query,
      ));
      const job = snapshotHeldJob(returned, query);
      const { requestBytes } = validateRequestBytes(
        job.oeisRequestJson,
        job.requestHash,
        job.documentNumber,
        maxRequestBytes,
      );
      const filename = `${job.documentNumber}-oeis-diagnostic.json`;
      return {
        schemaVersion: 1,
        mode: 'dry-run',
        job: {
          jobId: job.id,
          shipmentId: job.shipmentId,
          documentNumber: job.documentNumber,
          state: job.state,
          lockedAt: job.lockedAt,
          version: job.version,
        },
        normalizedSnapshot: job.normalizedSnapshot,
        steps: {
          webhook: {
            status: 'completed',
            event: 'application/shipment/update/v1',
            triggerStatus: 'bag_confirmed',
          },
          payloadPreparation: {
            status: 'completed',
            requestHash: job.requestHash,
            requestBytes,
            withinLimit: true,
          },
          fyndLock: {
            status: 'completed',
            source: 'derived-with-live-builder',
            operation: 'platform.order.updateShipmentLock',
            request: buildFyndLockRequest({
              shipmentId: job.shipmentId,
              documentNumber: job.documentNumber,
            }),
            result: { locked: true },
          },
          oeisSubmission: {
            status: 'held',
            method: 'POST',
            url: oeisUrl,
            bodyDownloadUrl: `/api/einvoice/dry-runs/${job.id}/oeis-request`,
            bodyFileName: filename,
            sanitized: true,
            warning: 'Sanitized diagnostic only; it is not valid for OEIS submission.',
          },
          fyndTransition: {
            status: 'blocked',
            operation: 'platform.order.updateShipmentStatus',
            executable: false,
            requestTemplate: buildFyndTransitionTemplate({
              shipmentId: job.shipmentId,
              documentNumber: job.documentNumber,
            }),
          },
        },
      };
    },

    async getDryRunRequest(input) {
      const query = snapshotJobInput(input);
      const request = await readValidatedHeldRequest(query);
      return {
        rawJson: sanitizedDiagnosticJson(request.requestRows),
        filename: `${request.documentNumber}-oeis-diagnostic.json`,
        contentType: 'application/json',
        sanitized: true,
      };
    },

    async getDryRunPodCurl(input) {
      const query = snapshotJobInput(input);
      const request = await readValidatedHeldRequest(query);
      return {
        method: 'POST',
        url: oeisUrl,
        requestJson: request.requestJson,
        requestHash: request.requestHash,
        byteCount: request.requestBytes,
        apiKey: validatedOeisApiKey,
      };
    },
  });
}

module.exports = { createDryRunService };
