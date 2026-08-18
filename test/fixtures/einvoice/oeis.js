'use strict';

const SIGNED_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"><cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode></Invoice>';
const SIGNED_XML_BASE64 = Buffer.from(SIGNED_XML, 'utf8').toString('base64');

function makeOeisB2cSuccess() {
  return {
    IsSystemException: false,
    TransactionList: [{
      IsValidated: true,
      ERROR_TAG: '',
      ERROR_DESC: '',
      ValidationError: { ErrorMessage: '' },
    }],
    InvoiceNumber: 'INV-1',
    TRAN_NO: 'TRAN-1',
    UUID: 'uuid-1',
    InvoiceCounterValue: '1',
    ReportingApiResponse: {
      status: 'Yet to send ZATCA',
      errors: '',
      MatchingKey: 'matching-key-1',
      SignedXmlEncoded: SIGNED_XML_BASE64,
    },
  };
}

module.exports = { SIGNED_XML, SIGNED_XML_BASE64, makeOeisB2cSuccess };
