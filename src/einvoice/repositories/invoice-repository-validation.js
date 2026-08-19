'use strict';

const { EinvoiceError } = require('../errors');

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
const STRICT_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

function fail(code, message) {
  throw new EinvoiceError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function requireString(value) {
  if (typeof value !== 'string' || value === '') {
    fail('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid');
  }
  return value;
}

function hasOwnData(value, field) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, 'value');
  } catch {
    return false;
  }
}

function requireOwn(value, field) {
  if (!hasOwnData(value, field)) {
    fail('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid');
  }
  return value[field];
}

function normalizeTaxEligibility(value) {
  if (!isPlainObject(value)) fail('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid');
  const decision = requireOwn(value, 'governmentBorneVatEligible');
  const reasonCode = requireOwn(value, 'reasonCode');
  const evidenceReference = requireOwn(value, 'evidenceReference');
  const verifiedAt = requireOwn(value, 'verifiedAt');
  const buyerName = requireOwn(value, 'buyerName');
  const buyerNationalId = requireOwn(value, 'buyerNationalId');
  const validBuyerName = buyerName === null || (typeof buyerName === 'string'
    && buyerName.trim() !== '' && !/[\u0000-\u001F\u007F-\u009F]/.test(buyerName));
  const validBuyerNationalId = buyerNationalId === null
    || (typeof buyerNationalId === 'string' && /^[0-9]{10}$/.test(buyerNationalId));
  if (![true, false, null].includes(decision)
      || typeof evidenceReference !== 'string' || evidenceReference === ''
      || !(verifiedAt === null || (typeof verifiedAt === 'string' && verifiedAt !== ''))
      || (decision === true && reasonCode !== 'VATEX-SA-HEA')
      || (decision !== true && reasonCode !== null)
      || (decision !== null && (!validBuyerName || !validBuyerNationalId))
      || (decision === null && (buyerName !== null || buyerNationalId !== null))) {
    fail('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid');
  }
  return {
    governmentBorneVatEligible: decision,
    reasonCode,
    evidenceReference,
    verifiedAt,
    buyerName,
    buyerNationalId,
  };
}

function requirePositiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid');
  }
  return value;
}

function copyFields(source, fields) {
  if (!isPlainObject(source)) fail('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid');
  const copy = {};
  for (const field of fields) copy[field] = requireString(source[field]);
  return copy;
}

function copyOptionalFields(source, fields) {
  if (!isPlainObject(source)) fail('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid');
  const copy = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) copy[field] = requireString(source[field]);
  }
  return copy;
}

function normalizeSnapshot(value) {
  if (!isPlainObject(value) || !Array.isArray(value.bags) || value.bags.length === 0) {
    fail('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid');
  }
  const snapshot = {
    shipmentId: requireString(value.shipmentId),
    confirmedAt: value.confirmedAt === null ? null : requireString(value.confirmedAt),
    branchCode: requireString(value.branchCode),
    currency: requireString(value.currency),
    paymentMode: requireString(value.paymentMode),
    amountPaid: requireString(value.amountPaid),
    policyVersion: requireOwn(value, 'policyVersion') === '2026-08-17'
      ? '2026-08-17'
      : fail('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid'),
    taxEligibility: normalizeTaxEligibility(requireOwn(value, 'taxEligibility')),
    bags: value.bags.map(bag => {
      if (!isPlainObject(bag)) fail('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid');
      const normalizedBag = {
        bagId: requireString(bag.bagId),
        lineNumber: requirePositiveInteger(bag.lineNumber),
        productCode: requireString(bag.productCode),
        quantity: requirePositiveInteger(bag.quantity),
        financialBreakup: {
          ...copyFields(bag.financialBreakup, FINANCIAL_FIELDS),
          ...copyOptionalFields(bag.financialBreakup, OPTIONAL_FINANCIAL_FIELDS),
        },
      };
      if (bag.prices !== undefined) normalizedBag.prices = copyOptionalFields(bag.prices, PRICE_FIELDS);
      return normalizedBag;
    }),
  };
  if (value.deliveryCharge !== undefined) {
    snapshot.deliveryCharge = copyFields(value.deliveryCharge, DELIVERY_CHARGE_FIELDS);
  }
  let json;
  try {
    json = JSON.stringify(snapshot);
  } catch {
    fail('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid');
  }
  return { snapshot, json };
}

function strictInstant(value, code = 'REPOSITORY_INPUT_INVALID') {
  if (typeof value !== 'string') fail(code, 'Invoice repository timestamp is invalid');
  const match = STRICT_INSTANT.exec(value);
  if (!match) fail(code, 'Invoice repository timestamp is invalid');
  const [, year, month, day, hour, minute, second, , offset] = match;
  const values = [year, month, day, hour, minute, second].map(Number);
  const [numericYear, numericMonth, numericDay, numericHour, numericMinute, numericSecond] = values;
  const offsetHour = offset === 'Z' ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === 'Z' ? 0 : Number(offset.slice(4, 6));
  if (numericMonth < 1 || numericMonth > 12
      || numericDay < 1 || numericDay > new Date(Date.UTC(numericYear, numericMonth, 0)).getUTCDate()
      || numericHour > 23 || numericMinute > 59 || numericSecond > 59
      || offsetHour > 23 || offsetMinute > 59) {
    fail(code, 'Invoice repository timestamp is invalid');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail(code, 'Invoice repository timestamp is invalid');
  return date.toISOString();
}

function timestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return strictInstant(value);
}

function validateClaim(workerId, leaseUntil, currentTime) {
  if (typeof workerId !== 'string' || workerId.trim() === '') {
    fail('REPOSITORY_CLAIM_INVALID', 'Invoice repository claim is invalid');
  }
  let lease;
  try {
    lease = strictInstant(leaseUntil, 'REPOSITORY_CLAIM_INVALID');
  } catch (error) {
    if (error instanceof EinvoiceError && error.code === 'REPOSITORY_CLAIM_INVALID') {
      throw new EinvoiceError('REPOSITORY_CLAIM_INVALID', 'Invoice repository claim is invalid');
    }
    throw error;
  }
  const current = timestamp(currentTime);
  if (Date.parse(lease) <= Date.parse(current)) {
    fail('REPOSITORY_CLAIM_INVALID', 'Invoice repository claim is invalid');
  }
  return { workerId, leaseUntil: lease, currentTime: current };
}

module.exports = { normalizeSnapshot, timestamp, validateClaim };
