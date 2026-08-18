'use strict';

const { types } = require('util');
const { EinvoiceError } = require('./errors');
const { POLICY_VERSION } = require('./tax-policy-resolver');

const EVENT_NAME = 'application/shipment/update/v1';
const SUPPORTED_PAYMENT_MODES = new Set(['CARD', 'APPLE_PAY']);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/;
const OPAQUE_EVENT_ID_PATTERN = /^[\x21-\x7E]+$/;
const MAX_EVENT_ID_BYTES = 512;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_APPLICATION_ID_BYTES = 256;
const trustedIdentityContexts = new WeakMap();
const FINANCIAL_FIELDS = [
  'price_effective',
  'promotion_effective_discount',
  'coupon_effective_discount',
  'value_of_good',
  'gst_tax_percentage',
  'gst_fee',
  'amount_paid',
];
const DISCOUNT_FIELDS = ['promotion_effective_discount', 'coupon_effective_discount'];
const MISSING = Symbol('missing');

function fail(code, message) {
  throw new EinvoiceError(code, message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainObject(value) {
  try {
    return isObject(value) && !types.isProxy(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function ownData(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function semanticOwnData(container, key, code, message) {
  const descriptor = ownDescriptor(container, key);
  if (descriptor === null) fail(code, message);
  return descriptor.present ? descriptor.value : MISSING;
}

function safeArrayValues(value, code, message, { allowEmpty = false } = {}) {
  let valid = false;
  try {
    valid = Array.isArray(value) && !types.isProxy(value)
      && Object.getPrototypeOf(value) === Array.prototype;
  } catch {
    valid = false;
  }
  if (!valid || (!allowEmpty && value.length === 0)) fail(code, message);

  const values = [];
  for (let index = 0; index < value.length; index += 1) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    } catch {
      fail(code, message);
    }
    if (descriptor === undefined
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(code, message);
    }
    values.push(descriptor.value);
  }
  return values;
}

function safeRecordValues(value, code, message) {
  if (!isPlainObject(value)) fail(code, message);
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(code, message);
  }
  if (keys.length === 0 || keys.some(key => typeof key !== 'string')) fail(code, message);
  return keys.map(key => {
    const candidate = semanticOwnData(value, key, code, message);
    if (candidate === MISSING) fail(code, message);
    return candidate;
  });
}

function optionalPlainRecord(container, key, code, message) {
  const value = semanticOwnData(container, key, code, message);
  if (value === MISSING) return MISSING;
  if (!isPlainObject(value)) fail(code, message);
  return value;
}

function equivalentCandidate(candidates, { missingCode, conflictCode, message }) {
  if (candidates.length === 0) fail(missingCode, message);
  if (new Set(candidates).size !== 1) fail(conflictCode, message);
  return candidates[0];
}

function normalizeIdentifier(
  value,
  name,
  requiredCode = 'WEBHOOK_IDENTIFIER_INVALID',
  maxBytes = MAX_IDENTIFIER_BYTES,
) {
  const validType = typeof value === 'string'
    || (typeof value === 'number' && Number.isSafeInteger(value));
  if (!validType || String(value).trim() === '') {
    fail(requiredCode, `${name} is required`);
  }
  const identifier = String(value);
  if (!IDENTIFIER_PATTERN.test(identifier) || Buffer.byteLength(identifier, 'utf8') > maxBytes) {
    fail('WEBHOOK_IDENTIFIER_INVALID', `${name} is malformed`);
  }
  return identifier;
}

function normalizeEventId(value) {
  if (value === undefined || value === null || value === '') {
    fail('WEBHOOK_EVENT_ID_REQUIRED', 'event id is required');
  }
  if (typeof value !== 'string'
      || Buffer.byteLength(value, 'utf8') > MAX_EVENT_ID_BYTES
      || !OPAQUE_EVENT_ID_PATTERN.test(value)) {
    fail('WEBHOOK_EVENT_ID_INVALID', 'event id is invalid');
  }
  return value;
}

function readEventId(body) {
  let eventDescriptor;
  try {
    eventDescriptor = Object.getOwnPropertyDescriptor(body, 'event');
  } catch {
    fail('WEBHOOK_EVENT_ID_INVALID', 'event id is invalid');
  }
  if (eventDescriptor === undefined) {
    let inherited;
    try {
      inherited = 'event' in body;
    } catch {
      fail('WEBHOOK_EVENT_ID_INVALID', 'event id is invalid');
    }
    if (inherited) fail('WEBHOOK_EVENT_ID_INVALID', 'event id is invalid');
    fail('WEBHOOK_EVENT_ID_REQUIRED', 'event id is required');
  }
  if (!Object.prototype.hasOwnProperty.call(eventDescriptor, 'value')) {
    fail('WEBHOOK_EVENT_ID_INVALID', 'event id is invalid');
  }
  const event = eventDescriptor.value;
  if (event === undefined) fail('WEBHOOK_EVENT_ID_REQUIRED', 'event id is required');
  if (!isPlainObject(event)) fail('WEBHOOK_EVENT_ID_INVALID', 'event id is invalid');

  let idDescriptor;
  try {
    idDescriptor = Object.getOwnPropertyDescriptor(event, 'id');
  } catch {
    fail('WEBHOOK_EVENT_ID_INVALID', 'event id is invalid');
  }
  if (idDescriptor === undefined) {
    let inherited;
    try {
      inherited = 'id' in event;
    } catch {
      fail('WEBHOOK_EVENT_ID_INVALID', 'event id is invalid');
    }
    if (inherited) fail('WEBHOOK_EVENT_ID_INVALID', 'event id is invalid');
    fail('WEBHOOK_EVENT_ID_REQUIRED', 'event id is required');
  }
  if (!Object.prototype.hasOwnProperty.call(idDescriptor, 'value')) {
    fail('WEBHOOK_EVENT_ID_INVALID', 'event id is invalid');
  }
  return normalizeEventId(idDescriptor.value);
}

function resolveEnvelopeIdentifier(bodyValue, callbackValue, name) {
  const bodyId = bodyValue === undefined || bodyValue === null
    ? undefined
    : normalizeIdentifier(bodyValue, name);
  const callbackId = callbackValue === undefined || callbackValue === null
    ? undefined
    : normalizeIdentifier(callbackValue, name);
  if (bodyId !== undefined && callbackId !== undefined && bodyId !== callbackId) {
    fail('WEBHOOK_IDENTIFIER_CONFLICT', `${name} conflicts with the verified callback identity`);
  }
  if (callbackId !== undefined) return callbackId;
  if (bodyId !== undefined) return bodyId;
  fail('WEBHOOK_IDENTIFIER_INVALID', `${name} is required`);
}

function ownDescriptor(container, key) {
  try {
    if (!isPlainObject(container)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    if (descriptor === undefined) return { present: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
    return { present: true, value: descriptor.value };
  } catch {
    return null;
  }
}

function trustedOwnData(container, key, code, { required = true } = {}) {
  const descriptor = ownDescriptor(container, key);
  if (descriptor === null) fail(code, 'Webhook trusted identity is invalid');
  if (!descriptor.present) {
    if (required) fail(code, 'Webhook trusted identity is invalid');
    return undefined;
  }
  return descriptor.value;
}

function normalizeTrustedEnvelopeIdentifier(bodyValue, callbackValue, name, maxBytes, { required }) {
  const bodyPresent = bodyValue !== undefined && bodyValue !== null;
  const callbackPresent = callbackValue !== undefined && callbackValue !== null;
  const normalizedBody = bodyPresent
    ? normalizeIdentifier(bodyValue, name, 'WEBHOOK_IDENTIFIER_INVALID', maxBytes)
    : null;
  const normalizedCallback = callbackPresent
    ? normalizeIdentifier(callbackValue, name, 'WEBHOOK_IDENTIFIER_INVALID', maxBytes)
    : null;
  if (normalizedBody !== null && normalizedCallback !== null && normalizedBody !== normalizedCallback) {
    fail('WEBHOOK_IDENTIFIER_CONFLICT', `${name} conflicts with the verified callback identity`);
  }
  if (normalizedCallback !== null) return normalizedCallback;
  if (normalizedBody !== null) return normalizedBody;
  if (!required) return null;
  fail('WEBHOOK_IDENTIFIER_INVALID', `${name} is required`);
}

function extractTrustedShipmentIdentity({ eventName, body, companyId, applicationId } = {}) {
  if (eventName !== EVENT_NAME) {
    fail('WEBHOOK_EVENT_UNSUPPORTED', 'Webhook event is not supported');
  }
  if (!isPlainObject(body)) {
    if (isObject(body) && !types.isProxy(body) && Object.getPrototypeOf(body) !== null) {
      fail('WEBHOOK_EVENT_ID_INVALID', 'event id is invalid');
    }
    fail('WEBHOOK_PAYLOAD_INVALID', 'Webhook payload is invalid');
  }

  const eventContainerDescriptor = ownDescriptor(body, 'event');
  if (eventContainerDescriptor === null) fail('WEBHOOK_EVENT_ID_INVALID', 'event id is invalid');
  if (!eventContainerDescriptor.present || eventContainerDescriptor.value === undefined) {
    fail('WEBHOOK_EVENT_ID_REQUIRED', 'event id is required');
  }
  const event = eventContainerDescriptor.value;
  if (!isPlainObject(event)) fail('WEBHOOK_EVENT_ID_INVALID', 'event id is invalid');
  const eventDescriptor = ownDescriptor(event, 'id');
  if (eventDescriptor === null) fail('WEBHOOK_EVENT_ID_INVALID', 'event id is invalid');
  if (!eventDescriptor.present || eventDescriptor.value === undefined || eventDescriptor.value === null
      || eventDescriptor.value === '') {
    fail('WEBHOOK_EVENT_ID_REQUIRED', 'event id is required');
  }
  const eventId = normalizeEventId(eventDescriptor.value);

  const bodyCompanyId = trustedOwnData(
    body,
    'company_id',
    'WEBHOOK_IDENTIFIER_INVALID',
    { required: false },
  );
  const bodyApplicationId = trustedOwnData(
    body,
    'application_id',
    'WEBHOOK_IDENTIFIER_INVALID',
    { required: false },
  );
  const normalizedCompanyId = normalizeTrustedEnvelopeIdentifier(
    bodyCompanyId,
    companyId,
    'company id',
    MAX_IDENTIFIER_BYTES,
    { required: true },
  );
  const normalizedApplicationId = normalizeTrustedEnvelopeIdentifier(
    bodyApplicationId,
    applicationId,
    'application id',
    MAX_APPLICATION_ID_BYTES,
    { required: false },
  );

  const payload = trustedOwnData(body, 'payload', 'WEBHOOK_PAYLOAD_INVALID');
  if (!isPlainObject(payload)) fail('WEBHOOK_PAYLOAD_INVALID', 'Webhook payload is invalid');
  const shipment = trustedOwnData(payload, 'shipment', 'WEBHOOK_PAYLOAD_INVALID');
  if (!isPlainObject(shipment)) fail('WEBHOOK_PAYLOAD_INVALID', 'Webhook payload is invalid');

  const shipmentIdDescriptor = ownDescriptor(shipment, 'shipment_id');
  const idDescriptor = ownDescriptor(shipment, 'id');
  if (shipmentIdDescriptor === null || idDescriptor === null) {
    fail('WEBHOOK_IDENTIFIER_INVALID', 'shipment id is malformed');
  }
  const shipmentIdPresent = shipmentIdDescriptor.present
    && shipmentIdDescriptor.value !== undefined && shipmentIdDescriptor.value !== null;
  const idPresent = idDescriptor.present && idDescriptor.value !== undefined && idDescriptor.value !== null;
  if (!shipmentIdPresent && !idPresent) fail('WEBHOOK_IDENTIFIER_INVALID', 'shipment id is required');
  const normalizedShipmentId = shipmentIdPresent
    ? normalizeIdentifier(shipmentIdDescriptor.value, 'shipment id')
    : null;
  const normalizedAliasId = idPresent
    ? normalizeIdentifier(idDescriptor.value, 'shipment id')
    : null;
  if (normalizedShipmentId !== null && normalizedAliasId !== null
      && normalizedShipmentId !== normalizedAliasId) {
    fail('WEBHOOK_IDENTIFIER_CONFLICT', 'shipment id conflicts with its alias');
  }

  const identity = Object.freeze({
    eventName: EVENT_NAME,
    eventId,
    companyId: normalizedCompanyId,
    applicationId: normalizedApplicationId,
    shipmentId: normalizedShipmentId ?? normalizedAliasId,
  });
  trustedIdentityContexts.set(identity, Object.freeze({ shipment }));
  return identity;
}

function nonEmptyValue(value) {
  return (typeof value === 'string' && value.trim() !== '')
    || (typeof value === 'number' && Number.isFinite(value));
}

function normalizeDecimal(value, code, { positive = false } = {}) {
  if (!nonEmptyValue(value) || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value))) {
    fail(code, 'Shipment financial value is invalid');
  }
  const [whole, fraction = ''] = String(value).split('.');
  if (fraction.length > 2) fail(code, 'Shipment financial value has too much precision');
  const normalized = `${whole}.${fraction.padEnd(2, '0')}`;
  if (positive && normalized === '0.00') fail(code, 'Shipment financial value must be positive');
  return normalized;
}

function getFinancialBreakupSources(bag) {
  const source = semanticOwnData(
    bag,
    'financial_breakup',
    'SHIPMENT_FINANCIAL_BREAKUP_REQUIRED',
    'Bag financial breakup is required',
  );
  if (source === MISSING) {
    fail('SHIPMENT_FINANCIAL_BREAKUP_REQUIRED', 'Bag financial breakup is required');
  }
  if (isPlainObject(source)) return [source];
  const sources = safeArrayValues(
    source,
    'SHIPMENT_FINANCIAL_BREAKUP_REQUIRED',
    'Bag financial breakup is required',
  );
  if (sources.some(value => !isPlainObject(value))) {
    fail('SHIPMENT_FINANCIAL_BREAKUP_REQUIRED', 'Bag financial breakup is required');
  }
  return sources;
}

function normalizeFinancialCandidate(field, value) {
  if (field === 'price_effective') {
    return normalizeDecimal(value, 'SHIPMENT_PRICE_INVALID', { positive: true });
  }
  if (DISCOUNT_FIELDS.includes(field)) {
    return normalizeDecimal(value, 'SHIPMENT_DISCOUNT_INVALID');
  }
  if (field === 'gst_tax_percentage') {
    const taxRate = normalizeDecimal(value, 'SHIPMENT_TAX_RATE_INVALID');
    if (!['0.00', '15.00'].includes(taxRate)) {
      fail('SHIPMENT_TAX_RATE_INVALID', 'Shipment tax rate must be 0.00 or 15.00');
    }
    return taxRate;
  }
  return normalizeDecimal(value, 'SHIPMENT_FINANCIAL_VALUE_INVALID');
}

function financialConflictCode(field) {
  if (DISCOUNT_FIELDS.includes(field)) return 'SHIPMENT_DISCOUNT_CONFLICT';
  if (field === 'price_effective') return 'SHIPMENT_PRICE_INVALID';
  if (field === 'gst_tax_percentage') return 'SHIPMENT_TAX_RATE_INVALID';
  return 'SHIPMENT_FINANCIAL_VALUE_INVALID';
}

function copyRequiredFinancialBreakup(financialSources, pricesSource) {
  const financialBreakup = {};
  for (const field of FINANCIAL_FIELDS) {
    const candidates = [];
    for (const source of financialSources) {
      const value = semanticOwnData(
        source,
        field,
        'SHIPMENT_FINANCIAL_BREAKUP_REQUIRED',
        'Bag financial breakup is invalid',
      );
      if (value !== MISSING) candidates.push(normalizeFinancialCandidate(field, value));
    }
    if (pricesSource !== undefined) {
      const value = semanticOwnData(
        pricesSource,
        field,
        'SHIPMENT_PRICES_INVALID',
        'Bag prices must be an object',
      );
      if (value !== MISSING) candidates.push(normalizeFinancialCandidate(field, value));
    }
    if (candidates.length === 0) {
      fail('SHIPMENT_FINANCIAL_BREAKUP_REQUIRED', 'Bag financial breakup is incomplete');
    }
    financialBreakup[field] = equivalentCandidate(candidates, {
      missingCode: 'SHIPMENT_FINANCIAL_BREAKUP_REQUIRED',
      conflictCode: financialConflictCode(field),
      message: 'Bag financial breakup fields conflict',
    });
  }
  const deliveryCandidates = [];
  for (const source of financialSources) {
    const value = semanticOwnData(
      source,
      'delivery_charge',
      'SHIPMENT_DELIVERY_VALUE_INVALID',
      'Bag delivery charge is invalid',
    );
    if (value !== MISSING) {
      deliveryCandidates.push(normalizeDecimal(value, 'SHIPMENT_DELIVERY_VALUE_INVALID'));
    }
  }
  if (pricesSource !== undefined) {
    const value = semanticOwnData(
      pricesSource,
      'delivery_charge',
      'SHIPMENT_PRICES_INVALID',
      'Bag prices must be an object',
    );
    if (value !== MISSING) {
      deliveryCandidates.push(normalizeDecimal(value, 'SHIPMENT_DELIVERY_VALUE_INVALID'));
    }
  }
  if (deliveryCandidates.length > 0) {
    const deliveryCharge = equivalentCandidate(deliveryCandidates, {
      missingCode: 'SHIPMENT_DELIVERY_VALUE_INVALID',
      conflictCode: 'SHIPMENT_DELIVERY_TOTAL_MISMATCH',
      message: 'Bag delivery charge fields conflict',
    });
    if (deliveryCharge !== '0.00') financialBreakup.delivery_charge = deliveryCharge;
  }
  return financialBreakup;
}

function moneyCents(value) {
  return BigInt(value.replace('.', ''));
}

function declaredDeliveryNet(shipment) {
  const declared = [];
  const deliveryCharges = semanticOwnData(
    shipment,
    'delivery_charges',
    'SHIPMENT_DELIVERY_VALUE_INVALID',
    'Shipment delivery charge is invalid',
  );
  if (deliveryCharges !== MISSING) {
    declared.push(normalizeDecimal(deliveryCharges, 'SHIPMENT_DELIVERY_VALUE_INVALID'));
  }
  const prices = semanticOwnData(
    shipment,
    'prices',
    'SHIPMENT_DELIVERY_VALUE_INVALID',
    'Shipment delivery charge is invalid',
  );
  if (prices !== MISSING) {
    if (!isPlainObject(prices)) {
      fail('SHIPMENT_DELIVERY_VALUE_INVALID', 'Shipment delivery charge is invalid');
    }
    const priceDeliveryCharge = semanticOwnData(
      prices,
      'delivery_charge',
      'SHIPMENT_DELIVERY_VALUE_INVALID',
      'Shipment delivery charge is invalid',
    );
    if (priceDeliveryCharge !== MISSING) {
      declared.push(normalizeDecimal(priceDeliveryCharge, 'SHIPMENT_DELIVERY_VALUE_INVALID'));
    }
  }
  if (new Set(declared).size > 1) {
    fail('SHIPMENT_DELIVERY_TOTAL_MISMATCH', 'Shipment delivery charge totals do not reconcile');
  }
  return declared[0];
}

function normalizeDeliveryCharge(shipment, bags) {
  const allocatedNet = bags.reduce((total, bag) => total
    + moneyCents(bag.financialBreakup.delivery_charge || '0.00'), 0n);
  const declaredNet = declaredDeliveryNet(shipment);
  const source = semanticOwnData(
    shipment,
    'delivery_charges_breakup',
    'SHIPMENT_DELIVERY_CHARGE_REQUIRED',
    'Shipment delivery charge breakup is required',
  );
  if (source === MISSING || source === null) {
    if (allocatedNet !== 0n
        || (declaredNet !== undefined && declaredNet !== '0.00')) {
      fail('SHIPMENT_DELIVERY_CHARGE_REQUIRED', 'Shipment delivery charge breakup is required');
    }
    return undefined;
  }
  if (!isPlainObject(source)) {
    fail('SHIPMENT_DELIVERY_CHARGE_REQUIRED', 'Shipment delivery charge breakup is required');
  }

  const rawTaxRate = semanticOwnData(
    source,
    'gst_tax_percentage',
    'SHIPMENT_DELIVERY_TAX_RATE_INVALID',
    'Shipment delivery tax rate is invalid',
  );
  const rawNetAmount = semanticOwnData(
    source,
    'value_of_good',
    'SHIPMENT_DELIVERY_VALUE_INVALID',
    'Shipment delivery value is invalid',
  );
  const rawTaxAmount = semanticOwnData(
    source,
    'gst_fee',
    'SHIPMENT_DELIVERY_VALUE_INVALID',
    'Shipment delivery value is invalid',
  );
  const rawPaidAmount = semanticOwnData(
    source,
    'amount_paid',
    'SHIPMENT_DELIVERY_VALUE_INVALID',
    'Shipment delivery value is invalid',
  );
  const taxRate = normalizeDecimal(
    rawTaxRate === MISSING ? undefined : rawTaxRate,
    'SHIPMENT_DELIVERY_TAX_RATE_INVALID',
  );
  const netAmount = normalizeDecimal(
    rawNetAmount === MISSING ? undefined : rawNetAmount,
    'SHIPMENT_DELIVERY_VALUE_INVALID',
  );
  const taxAmount = normalizeDecimal(
    rawTaxAmount === MISSING ? undefined : rawTaxAmount,
    'SHIPMENT_DELIVERY_VALUE_INVALID',
  );
  const paidAmount = normalizeDecimal(
    rawPaidAmount === MISSING ? undefined : rawPaidAmount,
    'SHIPMENT_DELIVERY_VALUE_INVALID',
  );
  const netCents = moneyCents(netAmount);
  const taxCents = moneyCents(taxAmount);
  const paidCents = moneyCents(paidAmount);

  if (netCents + taxCents !== paidCents) {
    fail('SHIPMENT_DELIVERY_TOTAL_MISMATCH', 'Shipment delivery charge totals do not reconcile');
  }
  if (taxRate !== '15.00') {
    fail('SHIPMENT_DELIVERY_TAX_RATE_INVALID', 'Shipment delivery tax rate must be 15.00');
  }
  if (paidCents === 0n) {
    if (allocatedNet !== 0n || (declaredNet !== undefined && declaredNet !== '0.00')) {
      fail('SHIPMENT_DELIVERY_TOTAL_MISMATCH', 'Shipment delivery charge totals do not reconcile');
    }
    return undefined;
  }
  const expectedTax = (netCents * 15n + 50n) / 100n;
  if (expectedTax !== taxCents) {
    fail('SHIPMENT_DELIVERY_TOTAL_MISMATCH', 'Shipment delivery charge totals do not reconcile');
  }
  if (allocatedNet !== netCents) {
    fail('SHIPMENT_DELIVERY_TOTAL_MISMATCH', 'Shipment delivery charge allocation does not reconcile');
  }
  if (declaredNet !== undefined && declaredNet !== netAmount) {
    fail('SHIPMENT_DELIVERY_TOTAL_MISMATCH', 'Shipment delivery charge totals do not reconcile');
  }
  return {
    taxCategory: 'S',
    taxRate,
    netAmount,
    taxAmount,
    paidAmount,
  };
}

function getBagPricesSource(bag) {
  const source = semanticOwnData(
    bag,
    'prices',
    'SHIPMENT_PRICES_INVALID',
    'Bag prices must be an object',
  );
  if (source === MISSING || source === null) return undefined;
  if (!isPlainObject(source)) fail('SHIPMENT_PRICES_INVALID', 'Bag prices must be an object');
  return source;
}

function copyPrices(source) {
  if (source === undefined) return undefined;
  const prices = {};
  for (const field of DISCOUNT_FIELDS) {
    const value = semanticOwnData(
      source,
      field,
      'SHIPMENT_PRICES_INVALID',
      'Bag prices must be an object',
    );
    if (value !== MISSING) {
      prices[field] = normalizeDecimal(value, 'SHIPMENT_DISCOUNT_INVALID');
    }
  }
  return prices;
}

function getStatusProvenance(shipment) {
  const statusRecord = ownData(shipment, 'shipment_status');
  if (!isPlainObject(statusRecord)) {
    fail('SHIPMENT_STATUS_REQUIRED', 'Shipment status is required');
  }
  const status = ownData(statusRecord, 'status');
  if (typeof status !== 'string' || status.trim() === '') {
    fail('SHIPMENT_STATUS_REQUIRED', 'Shipment status is required');
  }
  const rawVerifiedAt = ownData(statusRecord, 'created_ts');
  return {
    status,
    verifiedAt: validEligibilityTimestamp(rawVerifiedAt)
      ? new Date(rawVerifiedAt).toISOString()
      : null,
  };
}

function validEligibilityTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offset] = match;
  const [numericYear, numericMonth, numericDay, numericHour, numericMinute, numericSecond]
    = [year, month, day, hour, minute, second].map(Number);
  const offsetHour = offset === 'Z' ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === 'Z' ? 0 : Number(offset.slice(4, 6));
  return numericMonth >= 1 && numericMonth <= 12
    && numericDay >= 1 && numericDay <= new Date(Date.UTC(numericYear, numericMonth, 0)).getUTCDate()
    && numericHour <= 23 && numericMinute <= 59 && numericSecond <= 59
    && offsetHour <= 23 && offsetMinute <= 59
    && !Number.isNaN(Date.parse(value));
}

function readCustomConditions(shipment) {
  let value = shipment;
  for (const field of ['order', 'meta', 'custom_cart_meta', 'custom_conditions']) {
    if (!isPlainObject(value)) return undefined;
    value = ownData(value, field);
  }
  return isPlainObject(value) ? value : undefined;
}

function normalizeTaxEligibility(shipment, eventId, verifiedAt) {
  const conditions = readCustomConditions(shipment);
  const rawDecision = conditions && ownData(conditions, 'taxation_nationality');
  const governmentBorneVatEligible = typeof rawDecision === 'boolean' ? rawDecision : null;
  let buyerName = null;
  let buyerNationalId = null;
  if (governmentBorneVatEligible === true && conditions) {
    const rawBuyerName = ownData(conditions, 'recipient_name');
    const rawNationalId = ownData(conditions, 'national_id');
    if (typeof rawBuyerName === 'string' && rawBuyerName.trim() !== ''
        && !/[\u0000-\u001F\u007F-\u009F]/.test(rawBuyerName)) {
      buyerName = rawBuyerName;
    }
    if (typeof rawNationalId === 'string' && /^[0-9]{10}$/.test(rawNationalId)) {
      buyerNationalId = rawNationalId;
    }
  }
  return {
    governmentBorneVatEligible,
    reasonCode: governmentBorneVatEligible === true ? 'VATEX-SA-HEA' : null,
    evidenceReference: eventId,
    verifiedAt,
    buyerName,
    buyerNationalId,
  };
}

function getOptionalOrder(shipment, code, message) {
  const order = semanticOwnData(shipment, 'order', code, message);
  if (order === MISSING) return undefined;
  if (!isPlainObject(order)) fail(code, message);
  return order;
}

function appendCurrencyCandidate(container, key, candidates) {
  const source = semanticOwnData(
    container,
    key,
    'CURRENCY_UNSUPPORTED',
    'Shipment currency is invalid',
  );
  if (source === MISSING) return;
  if (typeof source === 'string') {
    candidates.push(source);
    return;
  }
  if (!isPlainObject(source)) {
    fail('CURRENCY_UNSUPPORTED', 'Shipment currency is invalid');
  }
  const currencyCode = semanticOwnData(
    source,
    'currency_code',
    'CURRENCY_UNSUPPORTED',
    'Shipment currency is invalid',
  );
  if (currencyCode === MISSING || typeof currencyCode !== 'string') {
    fail('CURRENCY_UNSUPPORTED', 'Shipment currency is invalid');
  }
  candidates.push(currencyCode);
}

function getShipmentCurrency(shipment) {
  const candidates = [];
  appendCurrencyCandidate(shipment, 'currency', candidates);
  const order = getOptionalOrder(
    shipment,
    'CURRENCY_UNSUPPORTED',
    'Shipment currency is invalid',
  );
  if (order !== undefined) {
    appendCurrencyCandidate(order, 'currency', candidates);
    const meta = optionalPlainRecord(
      order,
      'meta',
      'CURRENCY_UNSUPPORTED',
      'Shipment currency is invalid',
    );
    if (meta !== MISSING) appendCurrencyCandidate(meta, 'currency', candidates);
  }
  const currency = equivalentCandidate(candidates, {
    missingCode: 'CURRENCY_UNSUPPORTED',
    conflictCode: 'CURRENCY_UNSUPPORTED',
    message: 'Shipment currency must be SAR',
  });
  if (currency !== 'SAR') fail('CURRENCY_UNSUPPORTED', 'Shipment currency must be SAR');
  return currency;
}

function appendPaymentCandidates(container, candidates) {
  const paymentInfo = semanticOwnData(
    container,
    'payment_info',
    'PAYMENT_MODE_INVALID',
    'Shipment payment mode is invalid',
  );
  if (paymentInfo !== MISSING) {
    const payments = safeArrayValues(
      paymentInfo,
      'PAYMENT_MODE_INVALID',
      'Shipment payment mode is invalid',
    );
    for (const payment of payments) {
      if (!isPlainObject(payment)) {
        fail('PAYMENT_MODE_INVALID', 'Shipment payment mode is invalid');
      }
      const mode = semanticOwnData(
        payment,
        'mode',
        'PAYMENT_MODE_INVALID',
        'Shipment payment mode is invalid',
      );
      if (mode === MISSING || typeof mode !== 'string' || mode.trim() === '') {
        fail('PAYMENT_MODE_INVALID', 'Shipment payment mode is invalid');
      }
      candidates.push(mode);
    }
  }

  const paymentMethods = semanticOwnData(
    container,
    'payment_methods',
    'PAYMENT_MODE_INVALID',
    'Shipment payment mode is invalid',
  );
  if (paymentMethods !== MISSING) {
    for (const payment of safeRecordValues(
      paymentMethods,
      'PAYMENT_MODE_INVALID',
      'Shipment payment mode is invalid',
    )) {
      if (!isPlainObject(payment)) {
        fail('PAYMENT_MODE_INVALID', 'Shipment payment mode is invalid');
      }
      const mode = semanticOwnData(
        payment,
        'mode',
        'PAYMENT_MODE_INVALID',
        'Shipment payment mode is invalid',
      );
      if (mode === MISSING || typeof mode !== 'string' || mode.trim() === '') {
        fail('PAYMENT_MODE_INVALID', 'Shipment payment mode is invalid');
      }
      candidates.push(mode);
    }
  }
}

function getPaymentMode(shipment) {
  const modes = [];
  appendPaymentCandidates(shipment, modes);
  const order = getOptionalOrder(
    shipment,
    'PAYMENT_MODE_INVALID',
    'Shipment payment mode is invalid',
  );
  if (order !== undefined) appendPaymentCandidates(order, modes);
  const mode = equivalentCandidate(modes, {
    missingCode: 'PAYMENT_MODE_INVALID',
    conflictCode: 'PAYMENT_MODE_INVALID',
    message: 'Shipment must have exactly one payment mode',
  });
  if (!SUPPORTED_PAYMENT_MODES.has(mode)) {
    fail('PAYMENT_MODE_UNSUPPORTED', 'Shipment payment mode is not supported');
  }
  return mode;
}

function appendDirectAmount(container, key, candidates) {
  const value = semanticOwnData(
    container,
    key,
    'SHIPMENT_AMOUNT_PAID_INVALID',
    'Shipment amount paid is invalid',
  );
  if (value !== MISSING) {
    candidates.push(normalizeDecimal(value, 'SHIPMENT_AMOUNT_PAID_INVALID'));
  }
}

function appendNestedAmount(container, key, candidates) {
  const source = semanticOwnData(
    container,
    key,
    'SHIPMENT_AMOUNT_PAID_INVALID',
    'Shipment amount paid is invalid',
  );
  if (source === MISSING) return;
  if (!isPlainObject(source)) {
    fail('SHIPMENT_AMOUNT_PAID_INVALID', 'Shipment amount paid is invalid');
  }
  appendDirectAmount(source, 'amount_paid', candidates);
}

function getShipmentAmountPaid(shipment) {
  const candidates = [];
  appendDirectAmount(shipment, 'amount_paid', candidates);
  appendNestedAmount(shipment, 'financial_breakup', candidates);
  appendDirectAmount(shipment, 'total_amount', candidates);
  appendNestedAmount(shipment, 'prices', candidates);
  const order = getOptionalOrder(
    shipment,
    'SHIPMENT_AMOUNT_PAID_INVALID',
    'Shipment amount paid is invalid',
  );
  if (order !== undefined) {
    appendDirectAmount(order, 'amount_paid', candidates);
    appendNestedAmount(order, 'financial_breakup', candidates);
    appendDirectAmount(order, 'total_amount', candidates);
    appendNestedAmount(order, 'prices', candidates);
  }
  return equivalentCandidate(candidates, {
    missingCode: 'SHIPMENT_AMOUNT_PAID_REQUIRED',
    conflictCode: 'SHIPMENT_AMOUNT_PAID_INVALID',
    message: 'Shipment amount paid is required',
  });
}

function appendProductCandidates(source, candidates, { includeIdentifiers = false } = {}) {
  const sellerIdentifier = semanticOwnData(
    source,
    'seller_identifier',
    'WEBHOOK_IDENTIFIER_INVALID',
    'product code is malformed',
  );
  if (sellerIdentifier !== MISSING) candidates.push(sellerIdentifier);

  const skuCode = semanticOwnData(
    source,
    'sku_code',
    'WEBHOOK_IDENTIFIER_INVALID',
    'product code is malformed',
  );
  if (skuCode !== MISSING) candidates.push(skuCode);

  if (includeIdentifiers) {
    const directIdentifiers = semanticOwnData(
      source,
      'identifiers',
      'WEBHOOK_IDENTIFIER_INVALID',
      'product code is malformed',
    );
    if (directIdentifiers !== MISSING) {
      if (!isPlainObject(directIdentifiers)) {
        fail('WEBHOOK_IDENTIFIER_INVALID', 'product code is malformed');
      }
      const directSkuCode = semanticOwnData(
        directIdentifiers,
        'sku_code',
        'WEBHOOK_IDENTIFIER_INVALID',
        'product code is malformed',
      );
      if (directSkuCode !== MISSING) candidates.push(directSkuCode);
    }
  }

  const article = semanticOwnData(
    source,
    'article',
    'WEBHOOK_IDENTIFIER_INVALID',
    'product code is malformed',
  );
  if (article === MISSING) return;
  if (!isPlainObject(article)) {
    fail('WEBHOOK_IDENTIFIER_INVALID', 'product code is malformed');
  }
  const articleSellerIdentifier = semanticOwnData(
    article,
    'seller_identifier',
    'WEBHOOK_IDENTIFIER_INVALID',
    'product code is malformed',
  );
  if (articleSellerIdentifier !== MISSING) candidates.push(articleSellerIdentifier);

  const identifiers = semanticOwnData(
    article,
    'identifiers',
    'WEBHOOK_IDENTIFIER_INVALID',
    'product code is malformed',
  );
  if (identifiers === MISSING) return;
  if (!isPlainObject(identifiers)) {
    fail('WEBHOOK_IDENTIFIER_INVALID', 'product code is malformed');
  }
  const articleSkuCode = semanticOwnData(
    identifiers,
    'sku_code',
    'WEBHOOK_IDENTIFIER_INVALID',
    'product code is malformed',
  );
  if (articleSkuCode !== MISSING) candidates.push(articleSkuCode);
}

function productCodeFromSource(source, options) {
  const rawCandidates = [];
  appendProductCandidates(source, rawCandidates, options);
  if (rawCandidates.length === 0) return undefined;
  const candidates = rawCandidates.map(value => normalizeIdentifier(value, 'product code'));
  return equivalentCandidate(candidates, {
    missingCode: 'WEBHOOK_IDENTIFIER_INVALID',
    conflictCode: 'WEBHOOK_IDENTIFIER_CONFLICT',
    message: 'product code aliases conflict',
  });
}

function resolveProductAndFinancialSources(bag, financialSources) {
  const bagProductCode = productCodeFromSource(bag);
  const breakupEntries = financialSources.map(source => ({
    source,
    productCode: productCodeFromSource(source, { includeIdentifiers: true }),
  }));

  if (bagProductCode !== undefined) {
    if (breakupEntries.length === 1) {
      const [entry] = breakupEntries;
      if (entry.productCode !== undefined && entry.productCode !== bagProductCode) {
        fail('WEBHOOK_IDENTIFIER_CONFLICT', 'product code aliases conflict');
      }
      return { productCode: bagProductCode, financialSources: [entry.source] };
    }
    const matching = breakupEntries
      .filter(entry => entry.productCode === bagProductCode)
      .map(entry => entry.source);
    if (matching.length > 0) {
      return { productCode: bagProductCode, financialSources: matching };
    }
    if (breakupEntries.some(entry => entry.productCode !== undefined)) {
      fail('WEBHOOK_IDENTIFIER_CONFLICT', 'product code aliases conflict');
    }
    return { productCode: bagProductCode, financialSources };
  }

  const breakupCodes = breakupEntries
    .map(entry => entry.productCode)
    .filter(value => value !== undefined);
  const productCode = equivalentCandidate(breakupCodes, {
    missingCode: 'WEBHOOK_IDENTIFIER_INVALID',
    conflictCode: 'WEBHOOK_IDENTIFIER_CONFLICT',
    message: 'product code aliases conflict',
  });
  return {
    productCode,
    financialSources: breakupEntries
      .filter(entry => entry.productCode === productCode)
      .map(entry => entry.source),
  };
}

function validateQuantity(quantity) {
  if (!nonEmptyValue(quantity) || !/^[1-9]\d*$/.test(String(quantity)) || !Number.isSafeInteger(Number(quantity))) {
    fail('SHIPMENT_QUANTITY_INVALID', 'Bag quantity must be positive');
  }
  return Number(quantity);
}

function normalizeShipmentWebhook({
  eventName,
  body,
  companyId,
  applicationId,
  trustedIdentity,
  policyVersion = POLICY_VERSION,
}) {
  const trustedContext = trustedIdentity === undefined
    ? null
    : trustedIdentityContexts.get(trustedIdentity);
  if (trustedIdentity !== undefined && trustedContext === undefined) {
    fail('WEBHOOK_IDENTIFIER_INVALID', 'Webhook trusted identity is invalid');
  }
  const resolvedEventName = trustedContext === null ? eventName : trustedIdentity.eventName;
  if (resolvedEventName !== EVENT_NAME) {
    fail('WEBHOOK_EVENT_UNSUPPORTED', 'Webhook event is not supported');
  }
  if (policyVersion !== POLICY_VERSION) {
    fail('TAX_ELIGIBILITY_POLICY_INVALID', 'Healthcare tax policy version is invalid');
  }
  let shipment;
  if (trustedContext !== null) {
    shipment = trustedContext.shipment;
  } else {
    if (!isObject(body) || !isObject(body.payload) || !isObject(body.payload.shipment)) {
      fail('WEBHOOK_PAYLOAD_INVALID', 'Webhook payload is invalid');
    }
    shipment = body.payload.shipment;
  }
  const statusProvenance = getStatusProvenance(shipment);
  if (statusProvenance.status !== 'bag_confirmed') return { ignored: true };

  const normalizedEventId = trustedContext === null ? readEventId(body) : trustedIdentity.eventId;
  const normalizedCompanyId = trustedContext === null
    ? resolveEnvelopeIdentifier(body.company_id, companyId, 'company id')
    : trustedIdentity.companyId;
  const normalizedApplicationId = trustedContext === null
    ? resolveEnvelopeIdentifier(body.application_id, applicationId, 'application id')
    : trustedIdentity.applicationId;
  const shipmentId = trustedContext === null
    ? normalizeIdentifier(shipment.shipment_id ?? shipment.id, 'shipment id')
    : trustedIdentity.shipmentId;
  const confirmedAt = statusProvenance.verifiedAt;
  const taxEligibility = normalizeTaxEligibility(shipment, normalizedEventId, confirmedAt);

  const fulfillingStore = semanticOwnData(
    shipment,
    'fulfilling_store',
    'SHIPMENT_BRANCH_REQUIRED',
    'Shipment fulfilling store is required',
  );
  if (!isPlainObject(fulfillingStore)) {
    fail('SHIPMENT_BRANCH_REQUIRED', 'Shipment fulfilling store is required');
  }
  const rawBranchCode = semanticOwnData(
    fulfillingStore,
    'code',
    'SHIPMENT_BRANCH_REQUIRED',
    'Shipment fulfilling store is required',
  );
  if (rawBranchCode === MISSING || !nonEmptyValue(rawBranchCode)) {
    fail('SHIPMENT_BRANCH_REQUIRED', 'Shipment fulfilling store is required');
  }
  const branchCode = normalizeIdentifier(rawBranchCode, 'branch code');
  const currency = getShipmentCurrency(shipment);
  const paymentMode = getPaymentMode(shipment);
  const amountPaid = getShipmentAmountPaid(shipment);

  const rawBags = semanticOwnData(
    shipment,
    'bags',
    'SHIPMENT_BAGS_REQUIRED',
    'Shipment bags are required',
  );
  if (rawBags === MISSING) {
    fail('SHIPMENT_BAGS_REQUIRED', 'Shipment bags are required');
  }
  const sourceBags = safeArrayValues(
    rawBags,
    'SHIPMENT_BAGS_REQUIRED',
    'Shipment bags are required',
  );
  const bags = sourceBags.map((bag, index) => {
    if (!isPlainObject(bag)) fail('SHIPMENT_BAG_INVALID', 'Shipment bag is invalid');
    const allFinancialSources = getFinancialBreakupSources(bag);
    const {
      productCode,
      financialSources,
    } = resolveProductAndFinancialSources(bag, allFinancialSources);
    const pricesSource = getBagPricesSource(bag);
    const prices = copyPrices(pricesSource);
    const rawBagIdCandidates = [
      semanticOwnData(bag, 'bag_id', 'WEBHOOK_IDENTIFIER_INVALID', 'bag id is malformed'),
      semanticOwnData(bag, 'id', 'WEBHOOK_IDENTIFIER_INVALID', 'bag id is malformed'),
    ].filter(value => value !== MISSING);
    const bagIdCandidates = rawBagIdCandidates
      .map(value => normalizeIdentifier(value, 'bag id'));
    const bagId = equivalentCandidate(bagIdCandidates, {
      missingCode: 'WEBHOOK_IDENTIFIER_INVALID',
      conflictCode: 'WEBHOOK_IDENTIFIER_CONFLICT',
      message: 'bag id aliases conflict',
    });
    const rawQuantity = semanticOwnData(
      bag,
      'quantity',
      'SHIPMENT_QUANTITY_INVALID',
      'Bag quantity must be positive',
    );
    return {
      bagId,
      lineNumber: index + 1,
      productCode,
      quantity: validateQuantity(rawQuantity === MISSING ? undefined : rawQuantity),
      financialBreakup: copyRequiredFinancialBreakup(financialSources, pricesSource),
      ...(prices === undefined ? {} : { prices }),
    };
  });
  const deliveryCharge = normalizeDeliveryCharge(shipment, bags);

  return {
    eventRecord: {
      eventId: normalizedEventId,
      companyId: normalizedCompanyId,
      applicationId: normalizedApplicationId,
      shipmentId,
      eventType: EVENT_NAME,
      status: statusProvenance.status,
    },
    shipment: {
      shipmentId,
      confirmedAt,
      branchCode,
      currency,
      paymentMode,
      amountPaid,
      policyVersion,
      taxEligibility,
      ...(deliveryCharge === undefined ? {} : { deliveryCharge }),
      bags,
    },
  };
}

module.exports = { extractTrustedShipmentIdentity, normalizeShipmentWebhook };
