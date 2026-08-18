'use strict';

const crypto = require('crypto');
const { TextDecoder } = require('util');
const { SaxesParser } = require('saxes');
const { EinvoiceError } = require('./errors');

const UBL_INVOICE_NAMESPACE = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2';
const UBL_COMMON_BASIC_COMPONENTS_NAMESPACE = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const TOP_LEVEL_FIELDS = new Set([
  'IsSystemException', 'TransactionList', 'InvoiceNumber', 'TRAN_NO', 'UUID',
  'InvoiceCounterValue', 'ReportingApiResponse', 'QRCodeData',
]);
const TRANSACTION_FIELDS = new Set(['IsValidated', 'ERROR_TAG', 'ERROR_DESC', 'ValidationError']);
const VALIDATION_ERROR_FIELDS = new Set(['ErrorMessage']);
const REPORTING_FIELDS = new Set(['status', 'errors', 'MatchingKey', 'SignedXmlEncoded']);

function invalidResponse() {
  throw new EinvoiceError('OEIS_SIGNED_XML_INVALID', 'OEIS response validation failed');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyFields(value, fields) {
  return Object.keys(value).every(key => fields.has(key));
}

function requireNonEmptyString(value) {
  if (typeof value !== 'string' || value.trim() === '') invalidResponse();
  return value;
}

function requireEmptyString(value) {
  if (typeof value !== 'string' || value !== '') invalidResponse();
}

function validateTransactionList(value) {
  if (!Array.isArray(value) || value.length === 0) invalidResponse();
  for (const transaction of value) {
    if (!isPlainObject(transaction) || !hasOnlyFields(transaction, TRANSACTION_FIELDS)
      || transaction.IsValidated !== true || typeof transaction.ERROR_TAG !== 'string'
      || transaction.ERROR_TAG === '1') invalidResponse();
    requireEmptyString(transaction.ERROR_DESC);
    if (!isPlainObject(transaction.ValidationError)
      || !hasOnlyFields(transaction.ValidationError, VALIDATION_ERROR_FIELDS)) invalidResponse();
    requireEmptyString(transaction.ValidationError.ErrorMessage);
  }
}

function decodeCanonicalBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    invalidResponse();
  }

  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) invalidResponse();

  let signedXml;
  try {
    signedXml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    invalidResponse();
  }
  if (signedXml.includes('\0') || signedXml.includes('\uFFFD')) invalidResponse();
  return { bytes, signedXml };
}

function validateUblInvoice(signedXml) {
  const xml = signedXml.replace(/^\uFEFF?\s*/, '');
  let depth = 0;
  let rootValid = false;
  let currencyCount = 0;
  let currencyDepth = null;
  let currencyText = '';
  let currencyHasNestedElement = false;
  let currencyValid = false;
  let sawDoctype = false;

  try {
    const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', () => { sawDoctype = true; });
    parser.on('opentag', tag => {
      depth += 1;
      if (depth === 1) {
        rootValid = tag.local === 'Invoice' && tag.uri === UBL_INVOICE_NAMESPACE;
      }
      if (currencyDepth !== null && depth > currencyDepth) currencyHasNestedElement = true;
      if (tag.local === 'DocumentCurrencyCode' && tag.uri === UBL_COMMON_BASIC_COMPONENTS_NAMESPACE) {
        currencyCount += 1;
        currencyDepth = depth;
        currencyText = '';
        currencyHasNestedElement = false;
      }
    });
    parser.on('text', text => {
      if (currencyDepth !== null) currencyText += text;
    });
    parser.on('cdata', text => {
      if (currencyDepth !== null) currencyText += text;
    });
    parser.on('closetag', () => {
      if (currencyDepth === depth) {
        if (!currencyHasNestedElement && currencyText.trim() === 'SAR') currencyValid = true;
        currencyDepth = null;
      }
      depth -= 1;
    });
    parser.write(xml).close();
  } catch {
    invalidResponse();
  }

  if (sawDoctype || !rootValid || currencyCount !== 1 || !currencyValid) invalidResponse();
}

function parseOeisB2cResponse(body) {
  if (!isPlainObject(body) || !hasOnlyFields(body, TOP_LEVEL_FIELDS)
    || body.IsSystemException !== false) invalidResponse();

  validateTransactionList(body.TransactionList);
  const invoiceNumber = requireNonEmptyString(body.InvoiceNumber);
  const transactionNumber = requireNonEmptyString(body.TRAN_NO);
  const uuid = requireNonEmptyString(body.UUID);
  const invoiceCounter = requireNonEmptyString(body.InvoiceCounterValue);
  if (!isPlainObject(body.ReportingApiResponse)
    || !hasOnlyFields(body.ReportingApiResponse, REPORTING_FIELDS)
    || body.ReportingApiResponse.status !== 'Yet to send ZATCA') invalidResponse();

  requireEmptyString(body.ReportingApiResponse.errors);
  const matchingKey = requireNonEmptyString(body.ReportingApiResponse.MatchingKey);
  const signedXmlBase64 = body.ReportingApiResponse.SignedXmlEncoded;
  const { bytes, signedXml } = decodeCanonicalBase64(signedXmlBase64);
  validateUblInvoice(signedXml);

  let qrCodeData;
  if (Object.prototype.hasOwnProperty.call(body, 'QRCodeData')) {
    qrCodeData = requireNonEmptyString(body.QRCodeData);
  }

  return {
    invoiceNumber,
    transactionNumber,
    uuid,
    invoiceCounter,
    matchingKey,
    responseStatus: 'OEIS_ACCEPTED_REPORTING_PENDING',
    signedXmlBase64,
    signedXml,
    signedXmlSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    qrCodeData,
  };
}

module.exports = { parseOeisB2cResponse };
