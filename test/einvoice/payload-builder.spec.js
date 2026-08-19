'use strict';

const crypto = require('crypto');
const { buildOeisPayload } = require('../../src/einvoice/payload-builder');
const { EinvoiceError } = require('../../src/einvoice/errors');
const { createTaxPolicyResolver } = require('../../src/einvoice/tax-policy-resolver');

const taxPolicyResolver = createTaxPolicyResolver({
  policyVersion: '2026-08-17',
  now: () => new Date('2026-08-10T12:00:00.000Z'),
});

function makeSnapshot() {
  return {
    shipmentId: '17861361389811907489',
    confirmedAt: '2026-08-10T06:30:00.000Z',
    branchCode: 'BRANCH-01',
    currency: 'SAR',
    paymentMode: 'CARD',
    amountPaid: '230.00',
    policyVersion: '2026-08-17',
    taxEligibility: {
      governmentBorneVatEligible: false,
      reasonCode: null,
      evidenceReference: 'event-standard-1',
      verifiedAt: '2026-08-10T06:30:00.000Z',
      buyerName: null,
      buyerNationalId: null,
    },
    bags: [
      {
        bagId: 'bag-1', lineNumber: 99, productCode: 'SKU-01', quantity: 2,
        financialBreakup: {
          price_effective: '50.00', promotion_effective_discount: '10.00', coupon_effective_discount: '5.00',
          value_of_good: '85.00', gst_tax_percentage: '15.00', gst_fee: '12.75', amount_paid: '97.75',
        },
        prices: { promotion_effective_discount: '10.00', coupon_effective_discount: '5.00' },
      },
      {
        bagId: 'bag-2', lineNumber: 3, productCode: 'SKU-02', quantity: 1,
        financialBreakup: {
          price_effective: '130.00', promotion_effective_discount: '15.00', coupon_effective_discount: '0.00',
          value_of_good: '115.00', gst_tax_percentage: '15.00', gst_fee: '17.25', amount_paid: '132.25',
        },
        prices: { promotion_effective_discount: '15.00', coupon_effective_discount: '0.00' },
      },
    ],
  };
}

function makeMasterData(overrides = {}) {
  const products = {
    'SKU-01': { code: 'SKU-01', uqc: 'OTH', supplyClass: 'PRIVATE_HEALTHCARE_SERVICE', allowedZeroRateReason: 'VATEX-SA-HEA' },
    'SKU-02': { code: 'SKU-02', uqc: 'OTH', supplyClass: 'PRIVATE_HEALTHCARE_SERVICE', allowedZeroRateReason: 'VATEX-SA-HEA' },
  };
  return {
    getBranch(code) {
      if (code !== 'BRANCH-01') throw new EinvoiceError('MASTER_BRANCH_UNKNOWN', 'Shipment branch is not approved');
      return { code };
    },
    getProduct(code) {
      if (!products[code]) throw new EinvoiceError('MASTER_PRODUCT_UNKNOWN', 'Shipment product is not approved');
      return products[code];
    },
    ...overrides,
  };
}

function build(snapshot = makeSnapshot(), overrides = {}) {
  return buildOeisPayload(snapshot, {
    companyCode: 'COMPANY',
    sourceErp: 'Fynd.com',
    supplierCountryCode: 'SA',
    amountTolerance: '0.01',
    masterData: makeMasterData(),
    taxPolicyResolver,
    ...overrides,
  });
}

test('builds a bare B2C row array with hand-derived line and invoice totals', () => {
  const result = build();

  expect(result.documentNumber).toBe('VR-17861361389811907489-1');
  expect(result.rows).toHaveLength(2);
  expect(result.rows[0]).toEqual({
    COMPANY_CODE: 'COMPANY', SOURCE_ERP: 'Fynd.com',
    SUPPLIER_COUNTRY_CODE_ENGLISH: 'SA', COMPANY_ROLE: 'S',
    INVOICE_TYPE: 'Simplified Tax Invoice', INVOICE_SUBTYPE: 'Regular Domestic Supply',
    TEMPLATE_CODE: 'SIMPLIFIED IN', TRAN_DOC_TYPE: 'IN',
    TRAN_DOC_NO: 'VR-17861361389811907489-1', TRAN_LINE_NO: 1,
    ERP_TRANSACTION_REF: 'VR-17861361389811907489-1_1',
    TRAN_DOC_DATE: '20260810', DATE_OF_SUPPLY: '20260810',
    TRAN_BRANCH: 'BRANCH-01', TRAN_SERVICE_BRANCH: 'BRANCH-01',
    PRODUCT_CODE: 'SKU-01', TRAN_UQC: 'OTH',
    INV_CURRENCY_CODE: 'SAR', VAT_CURRENCY_CODE: 'SAR',
    TRAN_QUANTITY: 2, TRAN_UNIT_PRICE: '50.00', TRAN_GROSS_AMOUNT: '100.00',
    TRAN_DISC1_REASON_CODE: '95', TRAN_DISC1_REASON_TEXT: 'Promotion Discount', TRAN_DISC1_AMOUNT: '10.00',
    TRAN_DISC2_REASON_CODE: '95', TRAN_DISC2_REASON_TEXT: 'Coupon Discount', TRAN_DISC2_AMOUNT: '5.00',
    TRAN_NET_AMOUNT: '85.00', TRAN_TAX_CODE_CATEGORY: 'S', TRAN_TAX_RATE: '15.00',
    TRAN_TAX_AMOUNT: '12.75', TRAN_NET_PLUS_TAX: '97.75',
    INV_NET_AMOUNT: '200.00', INV_TOTAL_TAX_AMOUNT: '30.00', INV_TOTAL_AMOUNT: '230.00',
    INV_CUSTOMER_PAID_AMOUNT: '230.00', INV_CUSTOMER_AMOUNT_DUE: '0.00', PAY_METHOD: '48',
  });
  expect(result.rows[1]).toEqual(expect.objectContaining({
    TRAN_LINE_NO: 2, ERP_TRANSACTION_REF: 'VR-17861361389811907489-1_2', PRODUCT_CODE: 'SKU-02',
    TRAN_UQC: 'OTH', TRAN_GROSS_AMOUNT: '130.00', TRAN_NET_AMOUNT: '115.00',
    TRAN_TAX_AMOUNT: '17.25', TRAN_NET_PLUS_TAX: '132.25', INV_TOTAL_AMOUNT: '230.00',
  }));
  expect(result.rows[1]).not.toHaveProperty('TRAN_DISC2_AMOUNT');
  expect(JSON.parse(result.requestJson)).toEqual(result.rows);
  expect(result.requestJson.startsWith('[')).toBe(true);
  expect(result.requestHash).toBe(crypto.createHash('sha256').update(result.requestJson, 'utf8').digest('hex'));
});

test('maps eligible HEA product amounts while preserving standard-rated document delivery', () => {
  const snapshot = makeSnapshot();
  snapshot.taxEligibility = {
    governmentBorneVatEligible: true,
    reasonCode: 'VATEX-SA-HEA',
    evidenceReference: 'event-synthetic-hea-1',
    verifiedAt: '2026-08-10T06:30:00.000Z',
    buyerName: 'Synthetic Citizen',
    buyerNationalId: '1000000000',
  };
  snapshot.bags = [{
    bagId: 'bag-hea', lineNumber: 1, productCode: 'SKU-01', quantity: 1,
    financialBreakup: {
      price_effective: '299.00', promotion_effective_discount: '32.00', coupon_effective_discount: '0.00',
      value_of_good: '267.00', gst_tax_percentage: '0.00', gst_fee: '0.00',
      amount_paid: '301.50', delivery_charge: '30.00',
    },
    prices: { promotion_effective_discount: '32.00', coupon_effective_discount: '0.00' },
  }];
  snapshot.deliveryCharge = {
    taxCategory: 'S', taxRate: '15.00', netAmount: '30.00', taxAmount: '4.50', paidAmount: '34.50',
  };
  snapshot.amountPaid = '301.50';

  const result = build(snapshot);

  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toEqual(expect.objectContaining({
    TRAN_NET_AMOUNT: '267.00',
    TRAN_TAX_CODE_CATEGORY: 'Z',
    TRAN_TAX_RATE: '0.00',
    TRAN_TAX_AMOUNT: '0.00',
    TRAN_NET_PLUS_TAX: '267.00',
    TRAN_VAT_EXEMPT_REASON_CODE: 'VATEX-SA-HEA',
    TRAN_VAT_EXEMPT_REASON_TEXT: 'Private healthcare to citizen',
    CUST_NAME_WALKIN: 'Synthetic Citizen',
    CUST_ADDITIONAL_ID_NO_WALKIN: '1000000000',
    CUST_ADDL_ID_TYP_WALKIN: 'NAT',
    INV_CHGS_TAX_CATEGORY: 'S',
    INV_CHGS_VAT_RATE: '15.00',
    INV_CHGS_VAT_AMOUNT: '4.50',
    INV_CHGS_REASON_CODE: 'DL',
    INV_CHGS_REASON_TEXT: 'Delivery',
    INV_CHGS_AMOUNT: '30.00',
    INV_NET_AMOUNT: '297.00',
    INV_TOTAL_TAX_AMOUNT: '4.50',
    INV_TOTAL_AMOUNT: '301.50',
  }));
});

test.each([
  ['one halala below net', '266.99'],
  ['one halala above net', '267.01'],
])('preserves an eligible Z/0 Fynd paid amount %s at the one-halala boundary', (_description, paidAmount) => {
  const snapshot = makeSnapshot();
  snapshot.taxEligibility = {
    governmentBorneVatEligible: true,
    reasonCode: 'VATEX-SA-HEA',
    evidenceReference: 'event-synthetic-hea-1',
    verifiedAt: '2026-08-10T06:30:00.000Z',
    buyerName: 'Synthetic Citizen',
    buyerNationalId: '1000000000',
  };
  snapshot.bags = [{
    bagId: 'bag-hea-boundary', lineNumber: 1, productCode: 'SKU-01', quantity: 1,
    financialBreakup: {
      price_effective: '267.00', promotion_effective_discount: '0.00', coupon_effective_discount: '0.00',
      value_of_good: '267.00', gst_tax_percentage: '0.00', gst_fee: '0.00', amount_paid: paidAmount,
    },
    prices: { promotion_effective_discount: '0.00', coupon_effective_discount: '0.00' },
  }];
  snapshot.amountPaid = paidAmount;

  const row = build(snapshot).rows[0];

  expect(row).toEqual(expect.objectContaining({
    TRAN_TAX_CODE_CATEGORY: 'Z',
    TRAN_TAX_RATE: '0.00',
    TRAN_TAX_AMOUNT: '0.00',
    TRAN_NET_PLUS_TAX: paidAmount,
    INV_TOTAL_AMOUNT: paidAmount,
    INV_CUSTOMER_PAID_AMOUNT: paidAmount,
  }));
});

test.each([
  ['two halala below net', '266.98'],
  ['two halala above net', '267.02'],
])('rejects an eligible Z/0 Fynd paid amount %s outside the one-halala boundary', (_description, paidAmount) => {
  const snapshot = makeSnapshot();
  snapshot.taxEligibility = {
    governmentBorneVatEligible: true,
    reasonCode: 'VATEX-SA-HEA',
    evidenceReference: 'event-synthetic-hea-1',
    verifiedAt: '2026-08-10T06:30:00.000Z',
    buyerName: 'Synthetic Citizen',
    buyerNationalId: '1000000000',
  };
  snapshot.bags = [{
    bagId: 'bag-hea-boundary', lineNumber: 1, productCode: 'SKU-01', quantity: 1,
    financialBreakup: {
      price_effective: '267.00', promotion_effective_discount: '0.00', coupon_effective_discount: '0.00',
      value_of_good: '267.00', gst_tax_percentage: '0.00', gst_fee: '0.00', amount_paid: paidAmount,
    },
    prices: { promotion_effective_discount: '0.00', coupon_effective_discount: '0.00' },
  }];
  snapshot.amountPaid = paidAmount;

  expect(() => build(snapshot)).toThrow(expect.objectContaining({ code: 'LINE_TOTAL_MISMATCH' }));
});

test('legacy standard-rate rows without recipient identity omit the customer block', () => {
  const row = build().rows[0];

  for (const field of [
    'TRAN_VAT_EXEMPT_REASON_CODE', 'TRAN_VAT_EXEMPT_REASON_TEXT',
    'CUST_NAME_WALKIN', 'CUST_ADDITIONAL_ID_NO_WALKIN', 'CUST_ADDL_ID_TYP_WALKIN',
  ]) expect(row).not.toHaveProperty(field);
});

test.each([
  ['both recipient values', 'Standard Buyer', '1999999999', {
    CUST_NAME_WALKIN: 'Standard Buyer',
    CUST_ADDITIONAL_ID_NO_WALKIN: '1999999999',
    CUST_ADDL_ID_TYP_WALKIN: 'NAT',
  }],
  ['recipient name only', 'Standard Buyer', null, {
    CUST_NAME_WALKIN: 'Standard Buyer',
    CUST_ADDITIONAL_ID_NO_WALKIN: null,
    CUST_ADDL_ID_TYP_WALKIN: 'NAT',
  }],
  ['National ID only', null, '1999999999', {
    CUST_NAME_WALKIN: null,
    CUST_ADDITIONAL_ID_NO_WALKIN: '1999999999',
    CUST_ADDL_ID_TYP_WALKIN: 'NAT',
  }],
])('maps an available S/15 %s into the confirmed OEIS customer block',
  (_description, buyerName, buyerNationalId, expected) => {
    const snapshot = makeSnapshot();
    snapshot.taxEligibility.buyerName = buyerName;
    snapshot.taxEligibility.buyerNationalId = buyerNationalId;

    const result = build(snapshot);

    for (const row of result.rows) {
      expect(row).toEqual(expect.objectContaining(expected));
      expect(row).not.toHaveProperty('TRAN_VAT_EXEMPT_REASON_CODE');
      expect(row).not.toHaveProperty('TRAN_VAT_EXEMPT_REASON_TEXT');
    }
    expect(JSON.parse(result.requestJson)).toEqual(result.rows);
  });

test('holds an order containing mixed product-line rates', () => {
  const snapshot = makeSnapshot();
  snapshot.bags[1].financialBreakup.gst_tax_percentage = '0.00';
  snapshot.bags[1].financialBreakup.gst_fee = '0.00';
  snapshot.bags[1].financialBreakup.amount_paid = '115.00';
  snapshot.amountPaid = '212.75';

  expect(() => build(snapshot)).toThrow(expect.objectContaining({
    code: 'TAX_ELIGIBILITY_MIXED_RATES',
  }));
});

test('maps taxed delivery as one invoice-level charge without inflating the product line', () => {
  const snapshot = makeSnapshot();
  snapshot.bags = [{
    bagId: 'bag-delivery', lineNumber: 1, productCode: 'SKU-01', quantity: 1,
    financialBreakup: {
      price_effective: '299.00', promotion_effective_discount: '32.00', coupon_effective_discount: '0.00',
      value_of_good: '267.00', gst_tax_percentage: '15.00', gst_fee: '40.05', amount_paid: '341.55',
      delivery_charge: '30.00',
    },
    prices: { promotion_effective_discount: '32.00', coupon_effective_discount: '0.00' },
  }];
  snapshot.deliveryCharge = {
    taxCategory: 'S', taxRate: '15.00', netAmount: '30.00', taxAmount: '4.50', paidAmount: '34.50',
  };
  snapshot.amountPaid = '341.55';

  const result = build(snapshot);

  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toEqual(expect.objectContaining({
    TRAN_GROSS_AMOUNT: '299.00',
    TRAN_NET_AMOUNT: '267.00',
    TRAN_TAX_AMOUNT: '40.05',
    TRAN_NET_PLUS_TAX: '307.05',
    INV_CHGS_TAX_CATEGORY: 'S',
    INV_CHGS_VAT_RATE: '15.00',
    INV_CHGS_VAT_AMOUNT: '4.50',
    INV_CHGS_REASON_CODE: 'DL',
    INV_CHGS_REASON_TEXT: 'Delivery',
    INV_CHGS_AMOUNT: '30.00',
    INV_NET_AMOUNT: '297.00',
    INV_TOTAL_TAX_AMOUNT: '44.55',
    INV_TOTAL_AMOUNT: '341.55',
    INV_CUSTOMER_PAID_AMOUNT: '341.55',
  }));
  expect(result.rows[0]).not.toHaveProperty('TRAN_CHGS_AMOUNT');
  expect(result.rows[0]).not.toHaveProperty('INV_CHGS_PERCENT');
});

test('allocates shipment delivery across bags but emits the invoice charge only once in totals', () => {
  const snapshot = makeSnapshot();
  snapshot.bags[0].financialBreakup.delivery_charge = '15.00';
  snapshot.bags[0].financialBreakup.amount_paid = '115.00';
  snapshot.bags[1].financialBreakup.delivery_charge = '15.00';
  snapshot.bags[1].financialBreakup.amount_paid = '149.50';
  snapshot.deliveryCharge = {
    taxCategory: 'S', taxRate: '15.00', netAmount: '30.00', taxAmount: '4.50', paidAmount: '34.50',
  };
  snapshot.amountPaid = '264.50';

  const result = build(snapshot);

  expect(result.rows).toHaveLength(2);
  expect(result.rows[0]).toEqual(expect.objectContaining({
    TRAN_NET_PLUS_TAX: '97.75', INV_CHGS_AMOUNT: '30.00', INV_TOTAL_AMOUNT: '264.50',
  }));
  expect(result.rows[1]).toEqual(expect.objectContaining({
    TRAN_NET_PLUS_TAX: '132.25', INV_CHGS_AMOUNT: '30.00', INV_TOTAL_AMOUNT: '264.50',
  }));
});

test('reconciles aggregate delivery VAT without rounding VAT independently per bag', () => {
  const snapshot = makeSnapshot();
  snapshot.bags = Array.from({ length: 4 }, (_, index) => ({
    bagId: `bag-rounding-${index + 1}`,
    lineNumber: index + 1,
    productCode: 'SKU-01',
    quantity: 1,
    financialBreakup: {
      price_effective: '1.00', promotion_effective_discount: '0.00', coupon_effective_discount: '0.00',
      value_of_good: '1.00', gst_tax_percentage: '15.00', gst_fee: '0.15',
      amount_paid: index < 2 ? '1.19' : '1.18', delivery_charge: '0.03',
    },
    prices: { promotion_effective_discount: '0.00', coupon_effective_discount: '0.00' },
  }));
  snapshot.deliveryCharge = {
    taxCategory: 'S', taxRate: '15.00', netAmount: '0.12', taxAmount: '0.02', paidAmount: '0.14',
  };
  snapshot.amountPaid = '4.74';

  const result = build(snapshot);

  expect(result.rows).toHaveLength(4);
  expect(result.rows.every(row => row.TRAN_NET_PLUS_TAX === '1.15')).toBe(true);
  expect(result.rows[0]).toEqual(expect.objectContaining({
    INV_CHGS_AMOUNT: '0.12', INV_CHGS_VAT_AMOUNT: '0.02', INV_TOTAL_AMOUNT: '4.74',
  }));
});

test('treats an explicit zero delivery allocation like an absent one-cent line rounding field', () => {
  const snapshot = makeSnapshot();
  snapshot.bags[0].financialBreakup.delivery_charge = '0.00';
  snapshot.bags[0].financialBreakup.amount_paid = '97.76';
  snapshot.amountPaid = '230.01';

  const result = build(snapshot);

  expect(result.rows[0].TRAN_NET_PLUS_TAX).toBe('97.76');
  expect(result.rows[0]).not.toHaveProperty('INV_CHGS_AMOUNT');
  expect(result.rows[0].INV_TOTAL_AMOUNT).toBe('230.01');
});

test.each([
  ['SHIPMENT_DELIVERY_CHARGE_REQUIRED', (snapshot) => {
    snapshot.bags[0].financialBreakup.delivery_charge = '1.00';
    snapshot.bags[0].financialBreakup.amount_paid = '98.90';
  }],
  ['SHIPMENT_DELIVERY_ALLOCATION_MISMATCH', (snapshot) => {
    snapshot.deliveryCharge = {
      taxCategory: 'S', taxRate: '15.00', netAmount: '1.00', taxAmount: '0.15', paidAmount: '1.15',
    };
  }],
  ['SHIPMENT_DELIVERY_TOTAL_MISMATCH', (snapshot) => {
    snapshot.deliveryCharge = {
      taxCategory: 'S', taxRate: '15.00', netAmount: '1.00', taxAmount: '0.15', paidAmount: '1.14',
    };
  }],
  ['SHIPMENT_DELIVERY_TAX_RATE_INVALID', (snapshot) => {
    snapshot.deliveryCharge = {
      taxCategory: 'S', taxRate: '14.00', netAmount: '1.00', taxAmount: '0.14', paidAmount: '1.14',
    };
  }],
])('fails closed on delivery corruption with %s', (code, change) => {
  const snapshot = makeSnapshot();
  change(snapshot);
  expect(() => build(snapshot)).toThrow(expect.objectContaining({ code }));
});

test('keeps canonical request bytes deterministic and does not mutate its input', () => {
  const snapshot = makeSnapshot();
  const before = JSON.parse(JSON.stringify(snapshot));
  const first = build(snapshot);
  const second = build(snapshot);

  expect(second.requestJson).toBe(first.requestJson);
  expect(second.requestHash).toBe(first.requestHash);
  expect(snapshot).toEqual(before);
});

test('uses the Riyadh calendar date at a UTC date boundary', () => {
  const snapshot = makeSnapshot();
  snapshot.confirmedAt = '2026-08-09T21:30:00.000Z';

  expect(build(snapshot).rows[0]).toEqual(expect.objectContaining({
    TRAN_DOC_DATE: '20260810', DATE_OF_SUPPLY: '20260810',
  }));
});

test('rejects timestamp values without an explicit valid ISO offset', () => {
  for (const confirmedAt of [
    '2026-08-10T06:30:00',
    '2026-08-10T06:30:00+25:00',
    '2026-02-30T06:30:00Z',
    Symbol('timestamp'),
    { toString() { return '2026-08-10T06:30:00Z'; } },
  ]) {
    const snapshot = makeSnapshot();
    snapshot.confirmedAt = confirmedAt;
    let caught;
    try {
      build(snapshot);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EinvoiceError);
    expect(caught).toEqual(expect.objectContaining({ code: 'SHIPMENT_CONFIRMED_AT_INVALID' }));
  }
});

test('rejects unavailable or mismatched approved masters', () => {
  expect(() => build(makeSnapshot(), { masterData: makeMasterData({
    getBranch() { return undefined; },
  }) })).toThrow(expect.objectContaining({ code: 'MASTER_BRANCH_UNKNOWN' }));
  expect(() => build(makeSnapshot(), { masterData: makeMasterData({
    getProduct() { throw new EinvoiceError('MASTER_PRODUCT_UNKNOWN', 'Shipment product is not approved'); },
  }) })).toThrow(expect.objectContaining({ code: 'MASTER_PRODUCT_UNKNOWN' }));
  expect(() => build(makeSnapshot(), { masterData: makeMasterData({
    getProduct(code) { return { code: `${code}-OTHER`, uqc: 'OTH', supplyClass: 'PRIVATE_HEALTHCARE_SERVICE', allowedZeroRateReason: 'VATEX-SA-HEA' }; },
  }) })).toThrow(expect.objectContaining({ code: 'MASTER_PRODUCT_MISMATCH' }));
  expect(() => build(makeSnapshot(), { masterData: makeMasterData({
    getProduct(code) { return { code, uqc: 'OTH', supplyClass: 'MEDICINE', allowedZeroRateReason: 'VATEX-SA-35' }; },
  }) })).toThrow(expect.objectContaining({ code: 'MASTER_PRODUCT_CLASSIFICATION_UNSUPPORTED' }));
});

test('rejects duplicate discount sources that differ by more than one cent', () => {
  const snapshot = makeSnapshot();
  snapshot.bags[0].prices.promotion_effective_discount = '10.02';

  expect(() => build(snapshot)).toThrow(expect.objectContaining({ code: 'SHIPMENT_DISCOUNT_CONFLICT' }));
});

test('holds a locally self-consistent tax amount that is not 15 percent of net', () => {
  const snapshot = makeSnapshot();
  snapshot.bags[0].financialBreakup.gst_fee = '12.73';
  snapshot.bags[0].financialBreakup.amount_paid = '97.73';
  snapshot.amountPaid = '229.98';

  expect(() => build(snapshot)).toThrow(expect.objectContaining({ code: 'TAX_ELIGIBILITY_FINANCIAL_MISMATCH' }));
});

test('rounds a half-cent 15 percent tax up and rejects a two-cent understatement', () => {
  const snapshot = makeSnapshot();
  snapshot.bags = [{
    bagId: 'half-cent', lineNumber: 1, productCode: 'SKU-01', quantity: 1,
    financialBreakup: {
      price_effective: '0.10', promotion_effective_discount: '0.00', coupon_effective_discount: '0.00',
      value_of_good: '0.10', gst_tax_percentage: '15.00', gst_fee: '0.02', amount_paid: '0.12',
    },
    prices: { promotion_effective_discount: '0.00', coupon_effective_discount: '0.00' },
  }];
  snapshot.amountPaid = '0.12';
  expect(build(snapshot).rows[0]).toEqual(expect.objectContaining({ TRAN_TAX_AMOUNT: '0.02' }));

  snapshot.bags[0].financialBreakup.gst_fee = '0.00';
  snapshot.bags[0].financialBreakup.amount_paid = '0.10';
  snapshot.amountPaid = '0.10';
  expect(() => build(snapshot)).toThrow(expect.objectContaining({ code: 'TAX_ELIGIBILITY_FINANCIAL_MISMATCH' }));
});

test('rejects invoice-level two-cent drift even when each line is within one cent', () => {
  const snapshot = makeSnapshot();
  snapshot.bags[0].financialBreakup.amount_paid = '97.76';
  snapshot.bags[1].financialBreakup.amount_paid = '132.26';
  snapshot.amountPaid = '230.02';

  expect(() => build(snapshot)).toThrow(expect.objectContaining({ code: 'INVOICE_TOTAL_MISMATCH' }));
});

test('requires the configured amount tolerance to be exactly one cent', () => {
  for (const amountTolerance of ['0.00', '0.02', '-0.01', '0.010', 'invalid']) {
    expect(() => build(makeSnapshot(), { amountTolerance }))
      .toThrow(expect.objectContaining({ code: 'PAYLOAD_CONFIG_INVALID' }));
  }
});

test('rejects malformed, unsupported, and unreconciled snapshots', () => {
  const cases = [
    ['SHIPMENT_BAGS_REQUIRED', (snapshot) => { snapshot.bags = []; }],
    ['SHIPMENT_QUANTITY_INVALID', (snapshot) => { snapshot.bags[0].quantity = 0; }],
    ['SHIPMENT_QUANTITY_INVALID', (snapshot) => { snapshot.bags[0].quantity = -1; }],
    ['CURRENCY_UNSUPPORTED', (snapshot) => { snapshot.currency = 'USD'; }],
    ['PAYMENT_MODE_UNSUPPORTED', (snapshot) => { snapshot.paymentMode = 'COD'; }],
    ['LINE_TOTAL_MISMATCH', (snapshot) => { snapshot.bags[0].financialBreakup.value_of_good = '84.00'; }],
    ['INVOICE_TOTAL_MISMATCH', (snapshot) => { snapshot.amountPaid = '229.00'; }],
  ];

  for (const [code, change] of cases) {
    const snapshot = makeSnapshot();
    change(snapshot);
    expect(() => build(snapshot)).toThrow(expect.objectContaining({ code }));
  }
});
