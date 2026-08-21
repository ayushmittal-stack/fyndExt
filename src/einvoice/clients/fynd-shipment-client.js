'use strict';

const { EinvoiceError } = require('../errors');

const FYND_STORE_INVOICE_ID_MAX_CHARACTERS = 25;
const OEIS_INVOICE_NUMBER_TEMPLATE = '$OEIS_RESPONSE.InvoiceNumber';
const OEIS_STORE_INVOICE_ID_TEMPLATE = '$OEIS_RESPONSE.InvoiceNumber[0:25]';

function fail(code, message, retryable = false) {
  throw new EinvoiceError(code, message, { retryable });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainObject(value) {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function ownDataInput(input, fields, code) {
  try {
    if (!isPlainObject(input)) fail(code, 'Fynd shipment request is invalid');
    const snapshot = Object.create(null);
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field);
      if (!descriptor || !hasOwn(descriptor, 'value')) {
        fail(code, 'Fynd shipment request is invalid');
      }
      snapshot[field] = descriptor.value;
    }
    return snapshot;
  } catch (error) {
    if (error instanceof EinvoiceError && error.code === code) throw error;
    fail(code, 'Fynd shipment request is invalid');
  }
}

function sameIdentifier(left, right) {
  return String(left) === String(right);
}

function requireIdentifier(value, code) {
  if ((typeof value !== 'string' && !Number.isSafeInteger(value)) || String(value).trim() === '') {
    fail(code, 'Fynd shipment request is invalid');
  }
  return value;
}

function requireNonemptyString(value, code) {
  if (typeof value !== 'string' || value.trim() === '') fail(code, 'Fynd shipment request is invalid');
  return value;
}

function requireInput(input, code) {
  if (!isObject(input)) fail(code, 'Fynd shipment request is invalid');
  return input;
}

function toFyndStoreInvoiceId(invoiceNumber) {
  return Array.from(String(invoiceNumber))
    .slice(0, FYND_STORE_INVOICE_ID_MAX_CHARACTERS)
    .join('');
}

function buildFyndLockRequest(input) {
  const { shipmentId, documentNumber } = ownDataInput(
    input,
    ['shipmentId', 'documentNumber'],
    'FYND_LOCK_REQUEST_INVALID',
  );
  requireIdentifier(shipmentId, 'FYND_LOCK_REQUEST_INVALID');
  requireIdentifier(documentNumber, 'FYND_LOCK_REQUEST_INVALID');
  return {
    body: {
      entity_type: 'shipments',
      action: 'lock',
      action_type: 'complete',
      entities: [{ id: shipmentId, reason_text: `OEIS invoice ${documentNumber}` }],
    },
  };
}

function buildFyndTransitionBody({ shipmentId, invoiceNumber, storeInvoiceId }, qrCodeData, signedXml) {
  return {
    body: {
      task: false,
      force_transition: false,
      unlock_before_transition: true,
      lock_after_transition: false,
      statuses: [{
        status: 'bag_invoiced',
        shipments: [{
          identifier: shipmentId,
          products: [],
          data_updates: {
            products: [{ data: { store_invoice_id: storeInvoiceId } }],
            entities: [{
              data: {
                store_invoice_id: storeInvoiceId,
                meta: {
                  einvoice_info: {
                    invoice: { InvoiceNumber: invoiceNumber, SignedQRCode: qrCodeData },
                  },
                  xml: { content: signedXml, filename: `${invoiceNumber}.xml` },
                },
              },
            }],
          },
        }],
      }],
    },
  };
}

function buildFyndTransitionRequest(input, qrCodeData, signedXml) {
  const { shipmentId, documentNumber, invoiceNumber } = ownDataInput(
    input,
    ['shipmentId', 'documentNumber', 'invoiceNumber'],
    'FYND_TRANSITION_REQUEST_INVALID',
  );
  requireIdentifier(shipmentId, 'FYND_TRANSITION_REQUEST_INVALID');
  requireIdentifier(documentNumber, 'FYND_TRANSITION_REQUEST_INVALID');
  requireIdentifier(invoiceNumber, 'FYND_TRANSITION_REQUEST_INVALID');
  return buildFyndTransitionBody({
    shipmentId,
    invoiceNumber,
    storeInvoiceId: toFyndStoreInvoiceId(invoiceNumber),
  }, qrCodeData, signedXml);
}

function buildFyndTransitionTemplate(input) {
  const { shipmentId, documentNumber } = ownDataInput(
    input,
    ['shipmentId', 'documentNumber'],
    'FYND_TRANSITION_REQUEST_INVALID',
  );
  requireIdentifier(shipmentId, 'FYND_TRANSITION_REQUEST_INVALID');
  requireIdentifier(documentNumber, 'FYND_TRANSITION_REQUEST_INVALID');
  return buildFyndTransitionBody(
    {
      shipmentId,
      invoiceNumber: OEIS_INVOICE_NUMBER_TEMPLATE,
      storeInvoiceId: OEIS_STORE_INVOICE_ID_TEMPLATE,
    },
    { $deferred: 'QRCodeData' },
    { $deferred: 'decoded ReportingApiResponse.SignedXmlEncoded' },
  );
}

function numericHttpStatus(value, allowString) {
  if (Number.isInteger(value)) return value;
  if (allowString && typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  return undefined;
}

function normalizeThrown(error) {
  const responseStatus = numericHttpStatus(error && error.response && error.response.status, true);
  const errorStatus = numericHttpStatus(error && error.status, false);
  const errorCode = numericHttpStatus(error && error.code, true);
  const status = responseStatus ?? errorStatus ?? errorCode;
  if (status === 429) fail('FYND_HTTP_429', 'Fynd request was rate limited', true);
  if (Number.isInteger(status) && status >= 500 && status <= 599) {
    fail('FYND_HTTP_5XX', 'Fynd service request failed', true);
  }
  if (Number.isInteger(status) && status >= 400 && status <= 499) {
    fail('FYND_HTTP_4XX', 'Fynd request was rejected');
  }

  const code = error && error.code;
  if (['ETIMEDOUT', 'ECONNABORTED'].includes(code)) {
    fail('FYND_TIMEOUT', 'Fynd request timed out', true);
  }
  if (['ERR_NETWORK', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code)) {
    fail('FYND_NETWORK', 'Fynd network request failed', true);
  }
  fail('FYND_REQUEST_FAILED', 'Fynd request failed');
}

async function runFynd(operation) {
  try {
    return await operation();
  } catch (error) {
    normalizeThrown(error);
  }
}

function matchingCheckEntries(checkResponse, shipmentId) {
  if (Array.isArray(checkResponse)) return checkResponse.filter(entry => isObject(entry) && sameIdentifier(entry.id ?? entry.identifier ?? entry.shipment_id, shipmentId));
  if (!isObject(checkResponse)) return [];

  const entries = [checkResponse];
  for (const key of ['entities', 'shipments', 'statuses']) {
    if (Array.isArray(checkResponse[key])) entries.push(...checkResponse[key]);
  }
  return entries.filter(entry => isObject(entry) && sameIdentifier(entry.id ?? entry.identifier ?? entry.shipment_id, shipmentId));
}

function collectTransitionNodes(result) {
  if (!isObject(result)) return { candidates: [], nodes: [] };

  const candidates = [];
  const nodes = [result];
  if (Array.isArray(result.shipments)) {
    candidates.push(...result.shipments);
    nodes.push(...result.shipments);
  }
  if (Array.isArray(result.statuses)) {
    for (const status of result.statuses) {
      if (!isObject(status)) continue;
      nodes.push(status);
      if (Array.isArray(status.shipments)) {
        candidates.push(...status.shipments);
        nodes.push(...status.shipments);
      } else candidates.push(status);
    }
  }
  if (hasOwn(result, 'identifier') || hasOwn(result, 'shipment_id') || hasOwn(result, 'id')) candidates.push(result);
  return { candidates: candidates.filter(isObject), nodes: nodes.filter(isObject) };
}

function is2xxStatus(status) {
  if (Number.isSafeInteger(status)) return status >= 200 && status < 300;
  return typeof status === 'string' && /^2\d\d$/.test(status);
}

function isNonempty(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return true;
}

function hasFailure(node, candidate) {
  if (node.success === false) return true;
  if (['code', 'exception', 'error', 'errors', 'failure_message', 'failure', 'error_message', 'error_description']
    .some(key => isNonempty(node[key]))) return true;
  return candidate && isNonempty(node.message);
}

function assertTransitionSucceeded(result, shipmentId) {
  const { candidates, nodes } = collectTransitionNodes(result);
  if (nodes.some(node => hasFailure(node, candidates.includes(node)))) {
    fail('FYND_TRANSITION_RESPONSE_INVALID', 'Fynd transition response is invalid');
  }
  const matches = candidates
    .filter(candidate => sameIdentifier(candidate.identifier ?? candidate.shipment_id ?? candidate.id, shipmentId));
  if (matches.length !== 1) fail('FYND_TRANSITION_RESPONSE_INVALID', 'Fynd transition response is invalid');

  const shipment = matches[0];
  if (!is2xxStatus(shipment.status) || hasFailure(shipment, true) || !isObject(shipment.final_state)
    || !['bag_invoiced', 'dp_assigned'].includes(shipment.final_state.bag_invoiced)) {
    fail('FYND_TRANSITION_RESPONSE_INVALID', 'Fynd transition response is invalid');
  }
  if (hasOwn(shipment.final_state, 'shipment_id')
    && !sameIdentifier(shipment.final_state.shipment_id, shipmentId)) {
    fail('FYND_TRANSITION_RESPONSE_INVALID', 'Fynd transition response is invalid');
  }
}

function collectShipments(result) {
  const shipments = [];
  for (const key of ['shipments', 'items']) {
    const collection = hasOwn(result, key) ? result[key] : undefined;
    if (collection === undefined) continue;
    if (!Array.isArray(collection) || collection.some(entry => !isPlainObject(entry))) {
      invalidShipmentResponse();
    }
    shipments.push(...collection);
  }
  const singular = hasOwn(result, 'shipment') ? result.shipment : undefined;
  if (singular !== undefined) {
    if (!isPlainObject(singular)) invalidShipmentResponse();
    shipments.push(singular);
  }
  if (['shipment_id', 'id', 'identifier'].some(key => hasOwn(result, key))) shipments.push(result);
  return shipments;
}

function invalidShipmentResponse() {
  fail('FYND_SHIPMENT_RESPONSE_INVALID', 'Fynd shipment response is invalid');
}

function optionalPlainContainer(object, key) {
  const value = hasOwn(object, key) ? object[key] : undefined;
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) invalidShipmentResponse();
  return value;
}

function resolveRedundant(values, equivalent = (left, right) => left === right) {
  if (values.length === 0) return undefined;
  if (values.some(value => !equivalent(value, values[0]))) invalidShipmentResponse();
  return values[0];
}

function addNonemptyString(values, value) {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.trim() === '') invalidShipmentResponse();
  values.push(value);
}

function addBoolean(values, value) {
  if (value === undefined) return;
  if (typeof value !== 'boolean') invalidShipmentResponse();
  values.push(value);
}

function addIdentifier(values, value) {
  if (value === undefined || value === null) return;
  if ((typeof value !== 'string' && !Number.isSafeInteger(value)) || String(value).trim() === '') {
    invalidShipmentResponse();
  }
  values.push(value);
}

function normalizeStatus(shipment) {
  const status = optionalPlainContainer(shipment, 'status');
  const values = [];
  addNonemptyString(values, hasOwn(shipment, 'shipment_status') ? shipment.shipment_status : undefined);
  if (status) {
    addNonemptyString(values, hasOwn(status, 'status') ? status.status : undefined);
    addNonemptyString(values, hasOwn(status, 'current_shipment_status') ? status.current_shipment_status : undefined);
  }
  return resolveRedundant(values);
}

function normalizeLocked(shipment) {
  const lockDetails = optionalPlainContainer(shipment, 'lock_details');
  const shipmentDetails = optionalPlainContainer(shipment, 'shipment_details');
  const values = [];
  addBoolean(values, hasOwn(shipment, 'lock_status') ? shipment.lock_status : undefined);
  if (lockDetails) addBoolean(values, hasOwn(lockDetails, 'lock_status') ? lockDetails.lock_status : undefined);
  if (shipmentDetails) addBoolean(values, hasOwn(shipmentDetails, 'lock_status') ? shipmentDetails.lock_status : undefined);
  return resolveRedundant(values);
}

function normalizeInvoiceId(shipment) {
  const invoice = optionalPlainContainer(shipment, 'invoice');
  const gstDetails = optionalPlainContainer(shipment, 'gst_details');
  const values = [];
  addIdentifier(values, hasOwn(shipment, 'store_invoice_id') ? shipment.store_invoice_id : undefined);
  if (invoice) addIdentifier(values, hasOwn(invoice, 'store_invoice_id') ? invoice.store_invoice_id : undefined);
  addIdentifier(values, hasOwn(shipment, 'invoice_id') ? shipment.invoice_id : undefined);
  if (gstDetails) addIdentifier(values, hasOwn(gstDetails, 'store_invoice_id') ? gstDetails.store_invoice_id : undefined);
  return resolveRedundant(values, sameIdentifier);
}

function normalizeMeta(shipment) {
  const meta = hasOwn(shipment, 'meta') ? shipment.meta : undefined;
  if (meta === undefined) return undefined;
  if (!isPlainObject(meta)) invalidShipmentResponse();
  return meta;
}

function normalizeShipmentIdentifier(shipment) {
  const values = [];
  for (const key of ['shipment_id', 'id', 'identifier']) {
    addIdentifier(values, hasOwn(shipment, key) ? shipment[key] : undefined);
  }
  const identifier = resolveRedundant(values, sameIdentifier);
  if (identifier === undefined) invalidShipmentResponse();
  return identifier;
}

function normalizeShipment(result, shipmentId) {
  if (!isPlainObject(result) || !hasOwn(result, 'success') || result.success !== true) invalidShipmentResponse();
  const matches = collectShipments(result)
    .map(shipment => ({ shipment, identifier: normalizeShipmentIdentifier(shipment) }))
    .filter(candidate => sameIdentifier(candidate.identifier, shipmentId));
  if (matches.length !== 1) invalidShipmentResponse();

  const { shipment, identifier } = matches[0];
  if (!isPlainObject(shipment)) invalidShipmentResponse();
  return {
    shipmentId: identifier,
    status: normalizeStatus(shipment),
    locked: normalizeLocked(shipment),
    invoiceId: normalizeInvoiceId(shipment),
    meta: normalizeMeta(shipment),
    responseStatus: null,
  };
}

function safelyNormalizeShipment(result, shipmentId) {
  try {
    return normalizeShipment(result, shipmentId);
  } catch {
    invalidShipmentResponse();
  }
}

function createFyndShipmentClient(options = {}) {
  if (!isObject(options)) fail('FYND_CLIENT_INVALID', 'Fynd client configuration is invalid');
  const { getPlatformClient } = options;
  if (typeof getPlatformClient !== 'function') fail('FYND_CLIENT_INVALID', 'Fynd client configuration is invalid');

  async function platformFor(companyId) {
    const platform = await runFynd(() => getPlatformClient(companyId));
    if (!isObject(platform) || !isObject(platform.order)) {
      fail('FYND_CLIENT_UNAVAILABLE', 'Fynd platform client is unavailable');
    }
    return platform;
  }

  return {
    async lockShipment(input = {}) {
      const { companyId, shipmentId, documentNumber } = requireInput(input, 'FYND_LOCK_REQUEST_INVALID');
      requireIdentifier(companyId, 'FYND_LOCK_REQUEST_INVALID');
      requireIdentifier(shipmentId, 'FYND_LOCK_REQUEST_INVALID');
      requireIdentifier(documentNumber, 'FYND_LOCK_REQUEST_INVALID');
      const platform = await platformFor(companyId);
      if (typeof platform.order.updateShipmentLock !== 'function') {
        fail('FYND_CLIENT_UNAVAILABLE', 'Fynd platform client is unavailable');
      }
      const result = await runFynd(() => platform.order.updateShipmentLock(
        buildFyndLockRequest({ shipmentId, documentNumber }),
      ));
      if (!isObject(result) || result.success !== true
        || matchingCheckEntries(result.check_response, shipmentId).some(entry => entry.is_shipment_locked === false)) {
        fail('FYND_LOCK_RESPONSE_INVALID', 'Fynd lock response is invalid');
      }
      return { shipmentId, locked: true, responseStatus: null };
    },

    async transitionToInvoiced(input = {}) {
      const {
        companyId, shipmentId, documentNumber, invoiceNumber, qrCodeData, signedXml,
      } = requireInput(input, 'FYND_TRANSITION_REQUEST_INVALID');
      requireIdentifier(companyId, 'FYND_TRANSITION_REQUEST_INVALID');
      requireIdentifier(shipmentId, 'FYND_TRANSITION_REQUEST_INVALID');
      requireIdentifier(documentNumber, 'FYND_TRANSITION_REQUEST_INVALID');
      requireIdentifier(invoiceNumber, 'FYND_TRANSITION_REQUEST_INVALID');
      requireNonemptyString(qrCodeData, 'FYND_TRANSITION_REQUEST_INVALID');
      requireNonemptyString(signedXml, 'FYND_TRANSITION_REQUEST_INVALID');
      const platform = await platformFor(companyId);
      if (typeof platform.order.updateShipmentStatus !== 'function') {
        fail('FYND_CLIENT_UNAVAILABLE', 'Fynd platform client is unavailable');
      }
      const result = await runFynd(() => platform.order.updateShipmentStatus(
        buildFyndTransitionRequest(
          { shipmentId, documentNumber, invoiceNumber },
          qrCodeData,
          signedXml,
        ),
      ));
      assertTransitionSucceeded(result, shipmentId);
      return { shipmentId, status: 'bag_invoiced', responseStatus: null };
    },

    async getShipment(input = {}) {
      const { companyId, shipmentId } = requireInput(input, 'FYND_SHIPMENT_REQUEST_INVALID');
      requireIdentifier(companyId, 'FYND_SHIPMENT_REQUEST_INVALID');
      requireIdentifier(shipmentId, 'FYND_SHIPMENT_REQUEST_INVALID');
      const platform = await platformFor(companyId);
      if (typeof platform.order.getShipmentById !== 'function') {
        fail('FYND_CLIENT_UNAVAILABLE', 'Fynd platform client is unavailable');
      }
      const result = await runFynd(() => platform.order.getShipmentById({ shipmentId, allowInactive: true }));
      return safelyNormalizeShipment(result, shipmentId);
    },
  };
}

module.exports = {
  buildFyndLockRequest,
  buildFyndTransitionTemplate,
  createFyndShipmentClient,
  toFyndStoreInvoiceId,
};
