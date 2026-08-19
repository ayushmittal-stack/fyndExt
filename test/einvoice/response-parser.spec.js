'use strict';

const crypto = require('crypto');
const { EinvoiceError } = require('../../src/einvoice/errors');
const { parseOeisB2cResponse } = require('../../src/einvoice/response-parser');
const {
  SIGNED_XML, SIGNED_XML_BASE64, makeLiveOeisSuccess, makeOeisB2cSuccess,
} = require('../fixtures/einvoice/oeis');

function expectRejected(body, forbidden = []) {
  try {
    parseOeisB2cResponse(body);
  } catch (error) {
    expect(error).toBeInstanceOf(EinvoiceError);
    expect(error).toEqual(expect.objectContaining({
      code: 'OEIS_SIGNED_XML_INVALID', retryable: false,
    }));
    expect(error).not.toHaveProperty('config');
    expect(error).not.toHaveProperty('request');
    expect(error).not.toHaveProperty('response');
    expect(error).not.toHaveProperty('cause');
    for (const value of forbidden) {
      expect(error.message).not.toContain(value);
      expect(JSON.stringify(error)).not.toContain(value);
    }
    return;
  }
  throw new Error('Expected OEIS B2C response to be rejected');
}

test('accepts only a complete B2C reporting-pending envelope and preserves its signed XML artifact', () => {
  const result = parseOeisB2cResponse(makeOeisB2cSuccess());

  expect(result).toEqual({
    invoiceNumber: 'INV-1',
    transactionNumber: 'TRAN-1',
    uuid: 'uuid-1',
    invoiceCounter: '1',
    matchingKey: 'matching-key-1',
    responseStatus: 'OEIS_ACCEPTED_REPORTING_PENDING',
    signedXmlBase64: SIGNED_XML_BASE64,
    signedXml: SIGNED_XML,
    signedXmlSha256: crypto.createHash('sha256').update(Buffer.from(SIGNED_XML, 'utf8')).digest('hex'),
    qrCodeData: undefined,
  });
});

test.each([
  ['a system exception', body => { body.IsSystemException = true; }],
  ['an invalid transaction row', body => { body.TransactionList[0].IsValidated = false; }],
  ['an error-tagged transaction row', body => { body.TransactionList[0].ERROR_TAG = '1'; }],
  ['a transaction description error', body => { body.TransactionList[0].ERROR_DESC = 'Not accepted'; }],
  ['a nested transaction validation error', body => { body.TransactionList[0].ValidationError.ErrorMessage = 'Not accepted'; }],
  ['a missing InvoiceNumber', body => { delete body.InvoiceNumber; }],
  ['a missing TRAN_NO', body => { delete body.TRAN_NO; }],
  ['a missing UUID', body => { delete body.UUID; }],
  ['a missing InvoiceCounterValue', body => { delete body.InvoiceCounterValue; }],
  ['a missing MatchingKey', body => { delete body.ReportingApiResponse.MatchingKey; }],
  ['a missing SignedXmlEncoded', body => { delete body.ReportingApiResponse.SignedXmlEncoded; }],
  ['an unknown reporting status', body => { body.ReportingApiResponse.status = 'Accepted'; }],
  ['a pending reporting status', body => { body.ReportingApiResponse.status = 'Pending'; }],
  ['non-empty reporting errors', body => { body.ReportingApiResponse.errors = 'queued'; }],
  ['an unknown top-level field', body => { body.Unexpected = true; }],
  ['a wrong field type', body => { body.InvoiceNumber = 1; }],
  ['a missing transaction error tag', body => { delete body.TransactionList[0].ERROR_TAG; }],
  ['a non-string transaction error tag', body => { body.TransactionList[0].ERROR_TAG = 0; }],
])('rejects %s', (_description, mutate) => {
  const body = makeOeisB2cSuccess();
  mutate(body);
  expectRejected(body);
});

test.each([
  ['invalid Base64 characters', '****'],
  ['URL alphabet Base64', SIGNED_XML_BASE64.replace(/\/+/, '-').replace(/\++/, '_')],
  ['Base64 whitespace', `${SIGNED_XML_BASE64.slice(0, 8)} ${SIGNED_XML_BASE64.slice(8)}`],
  ['noncanonical Base64 padding', `${SIGNED_XML_BASE64}=`],
  ['non-UTF8 bytes', Buffer.from([0xc3, 0x28]).toString('base64')],
  ['non-XML bytes', Buffer.from('not an XML document', 'utf8').toString('base64')],
  ['a non-Invoice root', Buffer.from('<CreditNote xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/>', 'utf8').toString('base64')],
  ['a wrong UBL namespace', Buffer.from('<Invoice xmlns="urn:wrong"><DocumentCurrencyCode>SAR</DocumentCurrencyCode></Invoice>', 'utf8').toString('base64')],
  ['a non-SAR currency', Buffer.from(SIGNED_XML.replace('>SAR<', '>USD<'), 'utf8').toString('base64')],
  ['a DOCTYPE', Buffer.from('<!DOCTYPE Invoice><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><DocumentCurrencyCode>SAR</DocumentCurrencyCode></Invoice>', 'utf8').toString('base64')],
  ['malformed XML', Buffer.from('<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><DocumentCurrencyCode>SAR</DocumentCurrencyCode><unclosed></Invoice>', 'utf8').toString('base64')],
])('rejects signed XML with %s', (_description, signedXmlBase64) => {
  const body = makeOeisB2cSuccess();
  body.ReportingApiResponse.SignedXmlEncoded = signedXmlBase64;
  expectRejected(body, [signedXmlBase64]);
});

test.each([
  ['a DocumentCurrencyCode spoofed in a comment', '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><!-- <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode> --></Invoice>'],
  ['a DocumentCurrencyCode spoofed in CDATA', '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><![CDATA[<cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>]]></Invoice>'],
  ['an undeclared currency prefix', '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode></Invoice>'],
  ['a wrong currency namespace', '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:wrong"><cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode></Invoice>'],
  ['a duplicate XML attribute', '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cbc:DocumentCurrencyCode xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">SAR</cbc:DocumentCurrencyCode></Invoice>'],
  ['an invalid XML entity', '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cbc:DocumentCurrencyCode xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">SAR &bad;</cbc:DocumentCurrencyCode></Invoice>'],
  ['multiple currency elements', '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode><cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode></Invoice>'],
])('rejects signed XML with %s', (_description, signedXml) => {
  const body = makeOeisB2cSuccess();
  body.ReportingApiResponse.SignedXmlEncoded = Buffer.from(signedXml, 'utf8').toString('base64');
  expectRejected(body, [signedXml]);
});

test('accepts an XML BOM and leading whitespace before the UBL Invoice root', () => {
  const body = makeOeisB2cSuccess();
  const xml = `\uFEFF \n${SIGNED_XML}`;
  body.ReportingApiResponse.SignedXmlEncoded = Buffer.from(xml, 'utf8').toString('base64');

  expect(parseOeisB2cResponse(body).signedXml).toBe(xml);
});

test('rejects a B2B clearance-shaped envelope', () => {
  const body = makeOeisB2cSuccess();
  delete body.ReportingApiResponse;
  body.ClearanceApiResponse = {
    status: 'CLEARED',
    errors: '',
    MatchingKey: 'matching-key-1',
    SignedXmlEncoded: SIGNED_XML_BASE64,
  };

  expectRejected(body);
});

test('preserves optional QRCodeData when it is present', () => {
  const body = makeOeisB2cSuccess();
  body.QRCodeData = 'qr-data';

  expect(parseOeisB2cResponse(body).qrCodeData).toBe('qr-data');
});

test('accepts the real OEIS envelope and binds its signed invoice to the exact source request', () => {
  const fixture = makeLiveOeisSuccess();
  const result = parseOeisB2cResponse(fixture.body, {
    sourceDocumentNumber: 'VR-SOURCE-1', requestJson: fixture.requestJson,
  });

  expect(result).toEqual(expect.objectContaining({
    sourceDocumentNumber: 'VR-SOURCE-1',
    invoiceNumber: 'VR-SOURCE-1',
    oeisInvoiceNumber: 'OEIS-INVOICE-1',
    transactionNumber: '260800000004',
    uuid: '4245897A-8CA2-4F8E-8CFC-D431A587376B',
    invoiceCounter: '2530',
    matchingKey: 'matching-key-1',
    responseStatus: 'OEIS_ACCEPTED_REPORTING_PENDING',
    signedXml: fixture.signedXml,
    qrCodeData: 'qr-data',
    responseJson: JSON.stringify(fixture.body),
    responseByteCount: Buffer.byteLength(JSON.stringify(fixture.body), 'utf8'),
    responseSha256: crypto.createHash('sha256').update(JSON.stringify(fixture.body)).digest('hex'),
  }));
});

test.each([
  ['source identity', fixture => { fixture.requestJson = fixture.requestJson.replace('VR-SOURCE-1', 'VR-OTHER'); }],
  ['envelope total', fixture => { fixture.body.TotalAmount = 908.97; }],
  ['signed invoice identity', fixture => {
    const xml = fixture.signedXml.replace('OEIS-INVOICE-1', 'OEIS-INVOICE-2');
    fixture.body.ReportingApiResponse.SignedXmlEncoded = Buffer.from(xml).toString('base64');
  }],
  ['signed UUID', fixture => {
    const xml = fixture.signedXml.replace('4245897A-8CA2-4F8E-8CFC-D431A587376B', '5245897A-8CA2-4F8E-8CFC-D431A587376B');
    fixture.body.ReportingApiResponse.SignedXmlEncoded = Buffer.from(xml).toString('base64');
  }],
  ['signed payable total', fixture => {
    const xml = fixture.signedXml.replace('>908.98</cbc:PayableAmount>', '>908.97</cbc:PayableAmount>');
    fixture.body.ReportingApiResponse.SignedXmlEncoded = Buffer.from(xml).toString('base64');
  }],
  ['payment method', fixture => {
    const xml = fixture.signedXml.replace('>48</cbc:PaymentMeansCode>', '>10</cbc:PaymentMeansCode>');
    fixture.body.ReportingApiResponse.SignedXmlEncoded = Buffer.from(xml).toString('base64');
  }],
  ['line discount', fixture => {
    const xml = fixture.signedXml.replace('>9.58</cbc:Amount>', '>9.57</cbc:Amount>');
    fixture.body.ReportingApiResponse.SignedXmlEncoded = Buffer.from(xml).toString('base64');
  }],
])('rejects a real response with conflicting %s', (_description, mutate) => {
  const fixture = makeLiveOeisSuccess();
  mutate(fixture);
  expectRejectedWithExpected(fixture.body, fixture.requestJson);
});

function expectRejectedWithExpected(body, requestJson) {
  expect(() => parseOeisB2cResponse(body, {
    sourceDocumentNumber: 'VR-SOURCE-1', requestJson,
  })).toThrow(expect.objectContaining({ code: 'OEIS_SIGNED_XML_INVALID' }));
}
