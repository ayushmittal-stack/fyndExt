'use strict';

const { types } = require('util');
const { Long } = require('mongodb');

const { EinvoiceError } = require('../errors');

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function inputError() {
  return new EinvoiceError('REPOSITORY_INPUT_INVALID', 'Invoice repository input is invalid');
}

function dataError() {
  return new EinvoiceError('REPOSITORY_DATA_INVALID', 'Invoice repository data is invalid');
}

function encodeLong(value, allowZero) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw inputError();
  return Long.fromNumber(value, false);
}

function decodeLong(value, allowZero) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) throw dataError();
  let descriptors;
  try {
    if (Object.getPrototypeOf(value) !== Long.prototype) throw dataError();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || keys.some(key => !['high', 'low', 'unsigned'].includes(key))) {
      throw dataError();
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw dataError();
  }
  const highDescriptor = descriptors.high;
  const lowDescriptor = descriptors.low;
  const unsignedDescriptor = descriptors.unsigned;
  if (!highDescriptor || !lowDescriptor || !unsignedDescriptor
      || !Object.prototype.hasOwnProperty.call(highDescriptor, 'value')
      || !Object.prototype.hasOwnProperty.call(lowDescriptor, 'value')
      || !Object.prototype.hasOwnProperty.call(unsignedDescriptor, 'value')
      || !Number.isInteger(highDescriptor.value) || highDescriptor.value < -0x80000000
      || highDescriptor.value > 0x7fffffff
      || !Number.isInteger(lowDescriptor.value) || lowDescriptor.value < -0x80000000
      || lowDescriptor.value > 0x7fffffff || unsignedDescriptor.value !== false) throw dataError();
  const decoded = (BigInt(highDescriptor.value) << 32n) + BigInt(lowDescriptor.value >>> 0);
  if (decoded < (allowZero ? 0n : 1n) || decoded > MAX_SAFE_BIGINT) throw dataError();
  return Number(decoded);
}

function encodePositiveLong(value) {
  return encodeLong(value, false);
}

function encodeNonnegativeLong(value) {
  return encodeLong(value, true);
}

function encodeNullablePositiveLong(value) {
  return value === null ? null : encodePositiveLong(value);
}

function decodePositiveLong(value) {
  return decodeLong(value, false);
}

function decodeNonnegativeLong(value) {
  return decodeLong(value, true);
}

function decodeNullablePositiveLong(value) {
  return value === null ? null : decodePositiveLong(value);
}

function encodeDate(value) {
  if (typeof value !== 'string' || !CANONICAL_INSTANT.test(value)) throw inputError();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw inputError();
  const date = new Date(milliseconds);
  if (date.toISOString() !== value) throw inputError();
  return date;
}

function encodeNullableDate(value) {
  return value === null ? null : encodeDate(value);
}

function decodeDate(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)
      || Object.getPrototypeOf(value) !== Date.prototype) throw dataError();
  const milliseconds = Date.prototype.getTime.call(value);
  if (!Number.isFinite(milliseconds)) throw dataError();
  const encoded = new Date(milliseconds).toISOString();
  if (!CANONICAL_INSTANT.test(encoded)) throw dataError();
  return encoded;
}

function decodeNullableDate(value) {
  return value === null ? null : decodeDate(value);
}

module.exports = {
  decodeDate,
  decodeNonnegativeLong,
  decodeNullableDate,
  decodeNullablePositiveLong,
  decodePositiveLong,
  encodeDate,
  encodeNonnegativeLong,
  encodeNullableDate,
  encodeNullablePositiveLong,
  encodePositiveLong,
};
