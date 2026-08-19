'use strict';

const crypto = require('crypto');
const { TextDecoder, types } = require('util');
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
const LIVE_TOP_LEVEL_FIELDS = new Set([
  'InvoiceNumber', 'QRCodeData', 'CompanyName', 'TaxableAmount', 'TaxAmount', 'TotalAmount',
  'TRAN_NO', 'UUID', 'InvoiceCounterValue', 'ReportingApiResponse', 'IsSystemException',
]);
const LIVE_REPORTING_FIELDS = new Set([
  'invoicehash', 'status', 'SignatureValueStamp', 'MatchingKey', 'SignedXmlEncoded',
]);

function invalidResponse() {
  throw new EinvoiceError('OEIS_SIGNED_XML_INVALID', 'OEIS response validation failed');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && !types.isProxy(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactOwnData(value, fields) {
  if (!isPlainObject(value)) invalidResponse();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.size
      || keys.some(key => typeof key !== 'string' || !fields.has(key))) invalidResponse();
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalidResponse();
    result[key] = descriptor.value;
  }
  return result;
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

function fixedMoney(value) {
  if (typeof value === 'number' && Number.isFinite(value)) value = value.toFixed(2);
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,15})\.[0-9]{2}$/.test(value)) {
    invalidResponse();
  }
  return value;
}

function requestRows(requestJson, sourceDocumentNumber) {
  if (typeof requestJson !== 'string' || typeof sourceDocumentNumber !== 'string'
      || sourceDocumentNumber.trim() === '') invalidResponse();
  let rows;
  try { rows = JSON.parse(requestJson); } catch { invalidResponse(); }
  if (!Array.isArray(rows) || rows.length === 0) invalidResponse();
  return rows.map((row, index) => {
    if (!isPlainObject(row) || row.TRAN_DOC_NO !== sourceDocumentNumber
        || row.TRAN_LINE_NO !== index + 1 || row.INV_CURRENCY_CODE !== 'SAR'
        || row.VAT_CURRENCY_CODE !== 'SAR') invalidResponse();
    for (const field of [
      'TRAN_NET_AMOUNT', 'TRAN_TAX_AMOUNT', 'TRAN_TAX_RATE', 'TRAN_DISC1_AMOUNT',
      'INV_NET_AMOUNT', 'INV_TOTAL_TAX_AMOUNT', 'INV_TOTAL_AMOUNT',
      'INV_CUSTOMER_PAID_AMOUNT', 'INV_CUSTOMER_AMOUNT_DUE',
    ]) fixedMoney(row[field]);
    if (row.INV_CUSTOMER_PAID_AMOUNT !== '0.00'
        || row.INV_CUSTOMER_AMOUNT_DUE !== row.INV_TOTAL_AMOUNT
        || row.PAY_METHOD !== '48' || !/^[0-9]{8}$/.test(row.TRAN_DOC_DATE)
        || !Number.isSafeInteger(row.TRAN_QUANTITY) || row.TRAN_QUANTITY < 1
        || !['S', 'Z'].includes(row.TRAN_TAX_CODE_CATEGORY)) invalidResponse();
    return row;
  });
}

function extractUblEvidence(signedXml) {
  const xml = signedXml.replace(/^\uFEFF?\s*/, '');
  const entries = [];
  const stack = [];
  let lineCount = 0;
  let sawDoctype = false;
  try {
    const parser = new SaxesParser({ xmlns: true });
    parser.on('doctype', () => { sawDoctype = true; });
    parser.on('opentag', tag => {
      const parent = stack[stack.length - 1];
      const lineIndex = tag.local === 'InvoiceLine' ? lineCount++ : (parent?.lineIndex ?? null);
      stack.push({ local: tag.local, uri: tag.uri, lineIndex, text: '', nested: false });
      if (parent) parent.nested = true;
    });
    parser.on('text', value => { if (stack.length) stack[stack.length - 1].text += value; });
    parser.on('cdata', value => { if (stack.length) stack[stack.length - 1].text += value; });
    parser.on('closetag', () => {
      const frame = stack[stack.length - 1];
      const path = stack.map(value => value.local).join('/');
      if (!frame.nested && frame.text.trim() !== '') {
        entries.push({ path, value: frame.text.trim(), lineIndex: frame.lineIndex, uri: frame.uri });
      }
      stack.pop();
    });
    parser.write(xml).close();
  } catch { invalidResponse(); }
  if (sawDoctype || stack.length !== 0) invalidResponse();
  const one = path => {
    const found = entries.filter(entry => entry.path === path);
    if (found.length !== 1 || found[0].uri !== UBL_COMMON_BASIC_COMPONENTS_NAMESPACE) invalidResponse();
    return found[0].value;
  };
  const perLine = path => Array.from({ length: lineCount }, (_, index) => {
    const found = entries.filter(entry => entry.path === `Invoice/InvoiceLine/${path}`
      && entry.lineIndex === index);
    if (found.length !== 1 || found[0].uri !== UBL_COMMON_BASIC_COMPONENTS_NAMESPACE) {
      invalidResponse();
    }
    return found[0].value;
  });
  return {
    invoiceNumber: one('Invoice/ID'),
    uuid: one('Invoice/UUID'),
    issueDate: one('Invoice/IssueDate'),
    currency: one('Invoice/DocumentCurrencyCode'),
    paymentMethod: one('Invoice/PaymentMeans/PaymentMeansCode'),
    net: one('Invoice/LegalMonetaryTotal/TaxExclusiveAmount'),
    tax: entries.filter(entry => entry.path === 'Invoice/TaxTotal/TaxAmount')[0]?.value,
    total: one('Invoice/LegalMonetaryTotal/TaxInclusiveAmount'),
    payable: one('Invoice/LegalMonetaryTotal/PayableAmount'),
    lines: Array.from({ length: lineCount }, (_, index) => ({
      number: perLine('ID')[index],
      quantity: perLine('InvoicedQuantity')[index],
      net: perLine('LineExtensionAmount')[index],
      tax: perLine('TaxTotal/TaxAmount')[index],
      category: perLine('Item/ClassifiedTaxCategory/ID')[index],
      rate: perLine('Item/ClassifiedTaxCategory/Percent')[index],
      discountCode: perLine('Price/AllowanceCharge/AllowanceChargeReasonCode')[index],
      discountText: perLine('Price/AllowanceCharge/AllowanceChargeReason')[index],
      discount: perLine('Price/AllowanceCharge/Amount')[index],
    })),
  };
}

function parseLiveResponse(body, options) {
  const envelope = exactOwnData(body, LIVE_TOP_LEVEL_FIELDS);
  const reporting = exactOwnData(envelope.ReportingApiResponse, LIVE_REPORTING_FIELDS);
  const expected = exactOwnData(options, new Set(['sourceDocumentNumber', 'requestJson']));
  const rows = requestRows(expected.requestJson, expected.sourceDocumentNumber);
  if (envelope.IsSystemException !== false || reporting.status !== 'Yet to send ZATCA') {
    invalidResponse();
  }
  for (const field of ['InvoiceNumber', 'TRAN_NO', 'UUID', 'InvoiceCounterValue', 'CompanyName']) {
    requireNonEmptyString(envelope[field]);
  }
  for (const field of ['invoicehash', 'SignatureValueStamp', 'MatchingKey']) {
    requireNonEmptyString(reporting[field]);
  }
  const { bytes, signedXml } = decodeCanonicalBase64(reporting.SignedXmlEncoded);
  validateUblInvoice(signedXml);
  const xml = extractUblEvidence(signedXml);
  const first = rows[0];
  const issueDate = `${first.TRAN_DOC_DATE.slice(0, 4)}-${first.TRAN_DOC_DATE.slice(4, 6)}-${first.TRAN_DOC_DATE.slice(6)}`;
  if (fixedMoney(envelope.TaxableAmount) !== first.INV_NET_AMOUNT
      || fixedMoney(envelope.TaxAmount) !== first.INV_TOTAL_TAX_AMOUNT
      || fixedMoney(envelope.TotalAmount) !== first.INV_TOTAL_AMOUNT
      || xml.invoiceNumber !== envelope.InvoiceNumber || xml.uuid !== envelope.UUID
      || xml.issueDate !== issueDate || xml.currency !== 'SAR' || xml.paymentMethod !== first.PAY_METHOD
      || fixedMoney(xml.net) !== first.INV_NET_AMOUNT
      || fixedMoney(xml.tax) !== first.INV_TOTAL_TAX_AMOUNT
      || fixedMoney(xml.total) !== first.INV_TOTAL_AMOUNT
      || fixedMoney(xml.payable) !== first.INV_CUSTOMER_AMOUNT_DUE
      || xml.lines.length !== rows.length) invalidResponse();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const line = xml.lines[index];
    if (line.number !== String(row.TRAN_LINE_NO)
        || Number(line.quantity) !== row.TRAN_QUANTITY
        || fixedMoney(line.net) !== row.TRAN_NET_AMOUNT
        || fixedMoney(line.tax) !== row.TRAN_TAX_AMOUNT
        || line.category !== row.TRAN_TAX_CODE_CATEGORY
        || fixedMoney(line.rate) !== row.TRAN_TAX_RATE
        || line.discountCode !== row.TRAN_DISC1_REASON_CODE
        || line.discountText !== row.TRAN_DISC1_REASON_TEXT
        || fixedMoney(line.discount) !== row.TRAN_DISC1_AMOUNT) invalidResponse();
  }
  const responseJson = JSON.stringify(envelope);
  return {
    sourceDocumentNumber: expected.sourceDocumentNumber,
    invoiceNumber: expected.sourceDocumentNumber,
    oeisInvoiceNumber: envelope.InvoiceNumber,
    transactionNumber: envelope.TRAN_NO,
    uuid: envelope.UUID,
    invoiceCounter: envelope.InvoiceCounterValue,
    matchingKey: reporting.MatchingKey,
    responseStatus: 'OEIS_ACCEPTED_REPORTING_PENDING',
    signedXmlBase64: reporting.SignedXmlEncoded,
    signedXml,
    signedXmlSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    qrCodeData: requireNonEmptyString(envelope.QRCodeData),
    responseJson,
    responseByteCount: Buffer.byteLength(responseJson, 'utf8'),
    responseSha256: crypto.createHash('sha256').update(responseJson, 'utf8').digest('hex'),
  };
}

function parseOeisB2cResponse(body, options) {
  if (isPlainObject(body) && Object.prototype.hasOwnProperty.call(body, 'CompanyName')) {
    return parseLiveResponse(body, options);
  }
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
