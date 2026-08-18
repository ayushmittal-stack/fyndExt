'use strict';

const { TextDecoder } = require('node:util');
const { types } = require('node:util');
const { EinvoiceError } = require('../errors');

const AUDIT_CURSOR_MAX_CHARS = 1_024;
const EVENT_KEY_PATTERN = /^v1\.[A-Za-z0-9_-]{43}$/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function cursorError() {
  return new EinvoiceError('AUDIT_CURSOR_INVALID', 'Shipment activity cursor is invalid');
}

function isObjectLike(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function isProxy(value) {
  return isObjectLike(value) && types.isProxy(value);
}

function exactObjectValues(value, expectedKeys) {
  if (value === null || typeof value !== 'object' || isProxy(value)) throw cursorError();
  if (Object.getPrototypeOf(value) !== Object.prototype) throw cursorError();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== expectedKeys.length || ownKeys.some(key => typeof key !== 'string')) throw cursorError();
  const expected = new Set(expectedKeys);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of ownKeys) {
    const descriptor = descriptors[key];
    if (!expected.has(key)
      || !descriptor
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
      || descriptor.enumerable !== true) {
      throw cursorError();
    }
  }
  const result = Object.create(null);
  for (const key of expectedKeys) {
    if (!descriptors[key]) throw cursorError();
    result[key] = descriptors[key].value;
  }
  return result;
}

function validateTimestamp(value) {
  if (typeof value !== 'string') throw cursorError();
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch (_error) {
    throw cursorError();
  }
  if (canonical !== value) throw cursorError();
  return value;
}

function validateShipmentId(value) {
  if (typeof value !== 'string'
    || !PRINTABLE_ASCII_PATTERN.test(value)
    || !/[!-~]/.test(value)
    || Buffer.byteLength(value, 'utf8') > 512) {
    throw cursorError();
  }
  return value;
}

function validateEventKey(value) {
  if (typeof value !== 'string' || !EVENT_KEY_PATTERN.test(value)) throw cursorError();
  return value;
}

function encodeCanonical(canonical) {
  const token = Buffer.from(JSON.stringify(canonical), 'utf8').toString('base64url');
  if (token.length === 0 || token.length > AUDIT_CURSOR_MAX_CHARS) throw cursorError();
  return token;
}

function encodeHeadCursor(input) {
  const values = exactObjectValues(input, ['lastOccurredAt', 'shipmentId']);
  validateTimestamp(values.lastOccurredAt);
  validateShipmentId(values.shipmentId);
  return encodeCanonical({
    v: 1,
    lastOccurredAt: values.lastOccurredAt,
    shipmentId: values.shipmentId,
  });
}

function encodeTimelineCursor(input) {
  const values = exactObjectValues(input, ['occurredAt', 'eventKey']);
  validateTimestamp(values.occurredAt);
  validateEventKey(values.eventKey);
  return encodeCanonical({
    v: 1,
    occurredAt: values.occurredAt,
    eventKey: values.eventKey,
  });
}

function decodeToken(token) {
  if (typeof token !== 'string'
    || token.length === 0
    || token.length > AUDIT_CURSOR_MAX_CHARS
    || !BASE64URL_PATTERN.test(token)
    || token.length % 4 === 1) {
    throw cursorError();
  }

  let bytes;
  let text;
  try {
    bytes = Buffer.from(token, 'base64url');
    if (bytes.length === 0 || bytes.toString('base64url') !== token) throw cursorError();
    text = UTF8_DECODER.decode(bytes);
  } catch (_error) {
    throw cursorError();
  }
  if (text.length === 0 || text.charCodeAt(0) === 0xfeff) throw cursorError();

  let value;
  try {
    value = JSON.parse(text);
  } catch (_error) {
    throw cursorError();
  }
  return { value, text };
}

function decodeHeadCursor(token) {
  const decoded = decodeToken(token);
  const values = exactObjectValues(decoded.value, ['v', 'lastOccurredAt', 'shipmentId']);
  if (values.v !== 1) throw cursorError();
  validateTimestamp(values.lastOccurredAt);
  validateShipmentId(values.shipmentId);
  const canonical = {
    v: 1,
    lastOccurredAt: values.lastOccurredAt,
    shipmentId: values.shipmentId,
  };
  if (JSON.stringify(canonical) !== decoded.text || encodeCanonical(canonical) !== token) throw cursorError();
  return Object.freeze({
    lastOccurredAt: values.lastOccurredAt,
    shipmentId: values.shipmentId,
  });
}

function decodeTimelineCursor(token) {
  const decoded = decodeToken(token);
  const values = exactObjectValues(decoded.value, ['v', 'occurredAt', 'eventKey']);
  if (values.v !== 1) throw cursorError();
  validateTimestamp(values.occurredAt);
  validateEventKey(values.eventKey);
  const canonical = {
    v: 1,
    occurredAt: values.occurredAt,
    eventKey: values.eventKey,
  };
  if (JSON.stringify(canonical) !== decoded.text || encodeCanonical(canonical) !== token) throw cursorError();
  return Object.freeze({
    occurredAt: values.occurredAt,
    eventKey: values.eventKey,
  });
}

module.exports = {
  AUDIT_CURSOR_MAX_CHARS,
  encodeHeadCursor,
  decodeHeadCursor,
  encodeTimelineCursor,
  decodeTimelineCursor,
};
