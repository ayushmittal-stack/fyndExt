'use strict';

const { types } = require('util');
const { EinvoiceError } = require('./errors');
const { parseMoney } = require('./decimal');

const POLICY_VERSION = '2026-08-17';
const HEA_REASON_CODE = 'VATEX-SA-HEA';
const HEA_REASON_TEXT = 'Private healthcare to citizen';
const STRICT_DECIMAL = /^(?:0|[1-9]\d*)\.\d{2}$/;
const STRICT_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const ELIGIBILITY_FRESHNESS_MS = 24 * 60 * 60 * 1000;

function fail(code, message) {
  throw new EinvoiceError(code, message);
}

function isPlainObject(value) {
  try {
    return value !== null && typeof value === 'object' && !types.isProxy(value)
      && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function readOwn(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function validInstant(value, now) {
  if (typeof value !== 'string') return false;
  const match = STRICT_INSTANT.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offset] = match;
  const [numericYear, numericMonth, numericDay, numericHour, numericMinute, numericSecond]
    = [year, month, day, hour, minute, second].map(Number);
  const offsetHour = offset === 'Z' ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === 'Z' ? 0 : Number(offset.slice(4, 6));
  if (numericMonth < 1 || numericMonth > 12
      || numericDay < 1 || numericDay > new Date(Date.UTC(numericYear, numericMonth, 0)).getUTCDate()
      || numericHour > 23 || numericMinute > 59 || numericSecond > 59
      || offsetHour > 23 || offsetMinute > 59) return false;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return false;
  const ageMs = now.getTime() - instant.getTime();
  return ageMs >= 0 && ageMs <= ELIGIBILITY_FRESHNESS_MS;
}

function validateProduct(product) {
  if (!isPlainObject(product)
      || readOwn(product, 'uqc') !== 'OTH'
      || readOwn(product, 'supplyClass') !== 'PRIVATE_HEALTHCARE_SERVICE'
      || readOwn(product, 'allowedZeroRateReason') !== HEA_REASON_CODE) {
    fail('TAX_ELIGIBILITY_PRODUCT_UNSUPPORTED', 'Healthcare product classification is unsupported');
  }
}

function readFinancials(financialBreakup) {
  if (!isPlainObject(financialBreakup)) {
    fail('TAX_ELIGIBILITY_FINANCIAL_MISMATCH', 'Healthcare tax financials do not reconcile');
  }
  const values = {};
  for (const field of ['netAmount', 'taxRate', 'taxAmount', 'paidAmount']) {
    const value = readOwn(financialBreakup, field);
    if (typeof value !== 'string' || !STRICT_DECIMAL.test(value)) {
      fail('TAX_ELIGIBILITY_FINANCIAL_MISMATCH', 'Healthcare tax financials do not reconcile');
    }
    try {
      values[field] = parseMoney(value);
    } catch {
      fail('TAX_ELIGIBILITY_FINANCIAL_MISMATCH', 'Healthcare tax financials do not reconcile');
    }
  }
  return values;
}

function difference(left, right) {
  const result = left - right;
  return result < 0n ? -result : result;
}

function createTaxPolicyResolver(options = {}) {
  if (!isPlainObject(options)) {
    fail('TAX_ELIGIBILITY_POLICY_INVALID', 'Healthcare tax policy configuration is invalid');
  }
  const policyVersion = readOwn(options, 'policyVersion');
  const now = readOwn(options, 'now');
  if (policyVersion !== POLICY_VERSION || typeof now !== 'function') {
    fail('TAX_ELIGIBILITY_POLICY_INVALID', 'Healthcare tax policy configuration is invalid');
  }

  return Object.freeze({
    resolveLineTax(input) {
      if (!isPlainObject(input)) {
        fail('TAX_ELIGIBILITY_DECISION_REQUIRED', 'Healthcare tax eligibility decision is required');
      }
      const product = readOwn(input, 'product');
      const eligibility = readOwn(input, 'eligibility');
      const financialBreakup = readOwn(input, 'financialBreakup');
      validateProduct(product);
      if (!isPlainObject(eligibility)) {
        fail('TAX_ELIGIBILITY_DECISION_REQUIRED', 'Healthcare tax eligibility decision is required');
      }
      const eligible = readOwn(eligibility, 'governmentBorneVatEligible');
      if (typeof eligible !== 'boolean') {
        fail('TAX_ELIGIBILITY_DECISION_REQUIRED', 'Healthcare tax eligibility decision is required');
      }

      let currentTime;
      try {
        currentTime = now();
      } catch {
        fail('TAX_ELIGIBILITY_POLICY_INVALID', 'Healthcare tax policy configuration is invalid');
      }
      if (!(currentTime instanceof Date) || Number.isNaN(currentTime.getTime())) {
        fail('TAX_ELIGIBILITY_POLICY_INVALID', 'Healthcare tax policy configuration is invalid');
      }
      const reasonCode = readOwn(eligibility, 'reasonCode');
      const evidenceReference = readOwn(eligibility, 'evidenceReference');
      const verifiedAt = readOwn(eligibility, 'verifiedAt');
      if ((eligible ? reasonCode !== HEA_REASON_CODE : reasonCode !== null)
          || typeof evidenceReference !== 'string' || evidenceReference.trim() === ''
          || !validInstant(verifiedAt, currentTime)) {
        fail('TAX_ELIGIBILITY_EVIDENCE_INVALID', 'Healthcare tax eligibility evidence is invalid');
      }
      const buyerName = readOwn(eligibility, 'buyerName');
      const buyerNationalId = readOwn(eligibility, 'buyerNationalId');
      const validBuyerName = typeof buyerName === 'string' && buyerName.trim() !== ''
        && !/[\u0000-\u001F\u007F-\u009F]/.test(buyerName);
      const validBuyerNationalId = typeof buyerNationalId === 'string'
        && /^[0-9]{10}$/.test(buyerNationalId);
      if ((eligible && (!validBuyerName || !validBuyerNationalId))
          || (!eligible && !((buyerName === null || validBuyerName)
            && (buyerNationalId === null || validBuyerNationalId)))) {
        fail('TAX_ELIGIBILITY_IDENTITY_REQUIRED', 'Healthcare buyer identity is required');
      }

      const amounts = readFinancials(financialBreakup);
      if (eligible) {
        if (amounts.taxRate !== 0n || amounts.taxAmount !== 0n
            || difference(amounts.paidAmount, amounts.netAmount) > 1n) {
          fail('TAX_ELIGIBILITY_FINANCIAL_MISMATCH', 'Healthcare tax financials do not reconcile');
        }
        return Object.freeze({
          category: 'Z', rate: '0.00', reasonCode: HEA_REASON_CODE,
          reasonText: HEA_REASON_TEXT, policyVersion: POLICY_VERSION, evidenceReference,
        });
      }

      const expectedTax = (amounts.netAmount * 15n + 50n) / 100n;
      if (amounts.taxRate !== 1500n
          || difference(amounts.taxAmount, expectedTax) > 1n
          || difference(amounts.paidAmount, amounts.netAmount + amounts.taxAmount) > 1n) {
        fail('TAX_ELIGIBILITY_FINANCIAL_MISMATCH', 'Healthcare tax financials do not reconcile');
      }
      return Object.freeze({
        category: 'S', rate: '15.00', reasonCode: null, reasonText: null,
        policyVersion: POLICY_VERSION, evidenceReference,
      });
    },
  });
}

module.exports = { POLICY_VERSION, createTaxPolicyResolver };
