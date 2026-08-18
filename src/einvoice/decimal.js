'use strict';

const { EinvoiceError } = require('./errors');

function fail(code, message) {
  throw new EinvoiceError(code, message);
}

function parseMoney(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    fail('MONEY_INVALID', 'Money value is invalid');
  }
  const raw = String(value);
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(raw);
  if (!match) fail('MONEY_INVALID', 'Money value is invalid');

  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > 2 && /[1-9]/.test(fraction.slice(2))) {
    fail('MONEY_PRECISION_INVALID', 'Money value has too much precision');
  }
  const cents = BigInt(whole) * 100n + BigInt((fraction.slice(0, 2)).padEnd(2, '0'));
  return sign === '-' ? -cents : cents;
}

function formatMoney(cents) {
  if (typeof cents !== 'bigint') fail('MONEY_INVALID', 'Money cents are invalid');
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function addMoney(...values) {
  return formatMoney(values.reduce((total, value) => total + parseMoney(value), 0n));
}

function multiplyMoney(value, quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    fail('MONEY_QUANTITY_INVALID', 'Money quantity must be a positive integer');
  }
  return formatMoney(parseMoney(value) * BigInt(quantity));
}

function withinTolerance(left, right, tolerance) {
  const difference = parseMoney(left) - parseMoney(right);
  const absolute = difference < 0n ? -difference : difference;
  const toleranceCents = parseMoney(tolerance);
  if (toleranceCents < 0n) {
    fail('MONEY_TOLERANCE_INVALID', 'Money tolerance must not be negative');
  }
  return absolute <= toleranceCents;
}

module.exports = { parseMoney, formatMoney, addMoney, multiplyMoney, withinTolerance };
