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

function makeLiveOeisSuccess() {
  const signedXml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
  <cbc:ID>OEIS-INVOICE-1</cbc:ID><cbc:UUID>4245897A-8CA2-4F8E-8CFC-D431A587376B</cbc:UUID><cbc:IssueDate>2026-08-19</cbc:IssueDate><cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>2530</cbc:UUID></cac:AdditionalDocumentReference>
  <cac:PaymentMeans><cbc:PaymentMeansCode>48</cbc:PaymentMeansCode></cac:PaymentMeans>
  <cac:TaxTotal><cbc:TaxAmount currencyID="SAR">118.56</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="SAR">790.42</cbc:TaxableAmount><cbc:TaxAmount currencyID="SAR">118.56</cbc:TaxAmount><cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>15.00</cbc:Percent></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="SAR">790.42</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="SAR">790.42</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="SAR">908.98</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="SAR">908.98</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity>1.000000</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="SAR">790.42</cbc:LineExtensionAmount><cac:TaxTotal><cbc:TaxAmount currencyID="SAR">118.56</cbc:TaxAmount></cac:TaxTotal><cac:Item><cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>15.00</cbc:Percent></cac:ClassifiedTaxCategory></cac:Item><cac:Price><cbc:PriceAmount currencyID="SAR">790.42</cbc:PriceAmount><cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:AllowanceChargeReasonCode>95</cbc:AllowanceChargeReasonCode><cbc:AllowanceChargeReason>Promotion Discount</cbc:AllowanceChargeReason><cbc:Amount currencyID="SAR">9.58</cbc:Amount></cac:AllowanceCharge></cac:Price></cac:InvoiceLine>
</Invoice>`;
  return {
    body: {
      InvoiceNumber: 'OEIS-INVOICE-1', QRCodeData: 'qr-data', CompanyName: 'Viva Radix',
      TaxableAmount: 790.42, TaxAmount: 118.56, TotalAmount: 908.98,
      TRAN_NO: '260800000004', UUID: '4245897A-8CA2-4F8E-8CFC-D431A587376B',
      InvoiceCounterValue: '2530', IsSystemException: false,
      ReportingApiResponse: {
        invoicehash: 'invoice-hash', status: 'Yet to send ZATCA',
        SignatureValueStamp: 'signature-stamp', MatchingKey: 'matching-key-1',
        SignedXmlEncoded: Buffer.from(signedXml, 'utf8').toString('base64'),
      },
    },
    requestJson: JSON.stringify([{
      TRAN_DOC_NO: 'VR-SOURCE-1', TRAN_LINE_NO: 1, TRAN_DOC_DATE: '20260819',
      INV_CURRENCY_CODE: 'SAR', VAT_CURRENCY_CODE: 'SAR', TRAN_QUANTITY: 1,
      TRAN_NET_AMOUNT: '790.42', TRAN_TAX_CODE_CATEGORY: 'S', TRAN_TAX_RATE: '15.00',
      TRAN_TAX_AMOUNT: '118.56', TRAN_DISC1_REASON_CODE: '95',
      TRAN_DISC1_REASON_TEXT: 'Promotion Discount', TRAN_DISC1_AMOUNT: '9.58',
      INV_NET_AMOUNT: '790.42', INV_TOTAL_TAX_AMOUNT: '118.56', INV_TOTAL_AMOUNT: '908.98',
      INV_CUSTOMER_PAID_AMOUNT: '0.00', INV_CUSTOMER_AMOUNT_DUE: '908.98', PAY_METHOD: '48',
    }]),
    signedXml,
  };
}

module.exports = { SIGNED_XML, SIGNED_XML_BASE64, makeLiveOeisSuccess, makeOeisB2cSuccess };
