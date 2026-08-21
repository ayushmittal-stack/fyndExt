'use strict';

const {
  extractTrustedShipmentIdentity,
  normalizeShipmentWebhook,
} = require('../../src/einvoice/snapshot-normalizer');
const { buildOeisPayload } = require('../../src/einvoice/payload-builder');
const { createTaxPolicyResolver } = require('../../src/einvoice/tax-policy-resolver');
const {
  makeLiveNestedShipmentWebhook,
  makeShipmentWebhook,
} = require('../fixtures/einvoice/shipment');

function webhookWithShipment(change) {
  const webhook = makeShipmentWebhook();
  change(webhook.payload.shipment);
  return webhook;
}

function liveWebhookWithShipment(change) {
  const webhook = makeLiveNestedShipmentWebhook();
  change(webhook.payload.shipment);
  return webhook;
}

function normalizeLive(body = makeLiveNestedShipmentWebhook()) {
  return normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body,
    companyId: 12655,
    applicationId: 'app-1',
  });
}

test('normalizes only invoice-required fields from a bag_confirmed webhook', () => {
  const result = normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body: makeShipmentWebhook(), companyId: 12655, applicationId: 'app-1',
  });

  expect(result.eventRecord).toEqual({
    eventId: 'evt-1', companyId: '12655', applicationId: 'app-1',
    shipmentId: '17861361389811907489', eventType: 'application/shipment/update/v1', status: 'bag_confirmed',
  });
  expect(result.shipment).toEqual({
    shipmentId: '17861361389811907489',
    confirmedAt: '2026-08-10T06:30:00.000Z',
    branchCode: 'BRANCH-01',
    currency: 'SAR',
    paymentMode: 'CARD',
    amountPaid: '115.00',
    policyVersion: '2026-08-17',
    taxEligibility: {
      governmentBorneVatEligible: false,
      reasonCode: null,
      evidenceReference: 'evt-1',
      verifiedAt: '2026-08-10T06:30:00.000Z',
      buyerName: 'Synthetic Standard Buyer',
      buyerNationalId: '1999999999',
    },
    bags: [{
      bagId: 'bag-1', lineNumber: 1, productCode: 'SKU-01', quantity: 1,
      financialBreakup: {
        price_effective: '100.00', promotion_effective_discount: '0.00', coupon_effective_discount: '0.00',
        value_of_good: '100.00', gst_tax_percentage: '15.00', gst_fee: '15.00', amount_paid: '115.00',
      },
      prices: { promotion_effective_discount: '0.00', coupon_effective_discount: '0.00' },
    }],
  });
  expect(result.shipment).not.toHaveProperty('user');
  expect(result.shipment.bags[0]).not.toHaveProperty('customer');
});

test.each([
  ['name only', conditions => { delete conditions.national_id; }, {
    buyerName: 'Synthetic Standard Buyer', buyerNationalId: null,
  }],
  ['National ID only', conditions => { delete conditions.recipient_name; }, {
    buyerName: null, buyerNationalId: '1999999999',
  }],
  ['invalid optional identity', conditions => {
    conditions.recipient_name = '   ';
    conditions.national_id = 'private-invalid-id';
  }, { buyerName: null, buyerNationalId: null }],
])('preserves independently valid optional recipient identity for an S/15 candidate: %s',
  (_description, change, expected) => {
    const body = webhookWithShipment((shipment) => {
      change(shipment.order.meta.custom_cart_meta.custom_conditions);
    });

    const result = normalizeShipmentWebhook({
      eventName: 'application/shipment/update/v1', body, companyId: 12655, applicationId: 'app-1',
    });

    expect(result.shipment.taxEligibility).toEqual(expect.objectContaining(expected));
    expect(JSON.stringify(result.shipment.taxEligibility)).not.toContain('private-invalid-id');
  });

test('builds an S/15 OEIS customer block from the valid Fynd recipient fields', () => {
  const normalized = normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body: makeShipmentWebhook(), companyId: 12655, applicationId: 'app-1',
  });

  const result = buildOeisPayload(normalized.shipment, {
    companyCode: 'COMPANY',
    sourceErp: 'Fynd.com',
    supplierCountryCode: 'SA',
    amountTolerance: '0.01',
    masterData: {
      getBranch: code => ({ code }),
      getProduct: code => ({
        code, uqc: 'OTH', supplyClass: 'PRIVATE_HEALTHCARE_SERVICE',
        allowedZeroRateReason: 'VATEX-SA-HEA',
      }),
    },
    taxPolicyResolver: createTaxPolicyResolver({
      policyVersion: '2026-08-17',
      now: () => new Date('2026-08-10T12:00:00.000Z'),
    }),
  });

  expect(result.rows).toEqual([
    expect.objectContaining({
      TRAN_TAX_CODE_CATEGORY: 'S',
      TRAN_TAX_RATE: '15.00',
      CUST_NAME_WALKIN: 'Synthetic Standard Buyer',
      CUST_ADDITIONAL_ID_NO_WALKIN: '1999999999',
      CUST_ADDL_ID_TYP_WALKIN: 'NAT',
    }),
  ]);
  expect(JSON.parse(result.requestJson)).toEqual(result.rows);
});

test.each([
  ['missing item', (shipment) => { delete shipment.bags[0].item; }],
  ['malformed item', (shipment) => { shipment.bags[0].item = []; }],
  ['missing attributes', (shipment) => { delete shipment.bags[0].item.attributes; }],
  ['missing product type', (shipment) => {
    delete shipment.bags[0].item.attributes['product-type'];
  }],
  ['malformed attributes', (shipment) => { shipment.bags[0].item.attributes = []; }],
  ['inherited product type', (shipment) => {
    shipment.bags[0].item.attributes = Object.create({ 'product-type': 'service' });
  }],
  ['non-string product type', (shipment) => {
    shipment.bags[0].item.attributes['product-type'] = ['service'];
  }],
  ['non-service product type', (shipment) => {
    shipment.bags[0].item.attributes['product-type'] = 'product';
  }],
  ['mixed service and product bags', (shipment) => {
    const first = shipment.bags[0];
    shipment.bags.push({
      ...first,
      bag_id: 'bag-2',
      seller_identifier: 'SKU-02',
      item: { attributes: { 'product-type': 'product' } },
      financial_breakup: { ...first.financial_breakup },
      prices: { ...first.prices },
    });
  }],
])('rejects shipments unless every bag is a service: %s', (_description, change) => {
  const body = webhookWithShipment(change);

  expect(() => normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body,
    companyId: 12655,
    applicationId: 'app-1',
  })).toThrow(expect.objectContaining({ code: 'SHIPMENT_PRODUCT_TYPE_INVALID' }));
});

test('rejects an accessor product type without executing its getter', () => {
  const getter = jest.fn(() => 'service');
  const body = webhookWithShipment((shipment) => {
    Object.defineProperty(shipment.bags[0].item.attributes, 'product-type', { get: getter });
  });

  expect(() => normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body,
    companyId: 12655,
    applicationId: 'app-1',
  })).toThrow(expect.objectContaining({ code: 'SHIPMENT_PRODUCT_TYPE_INVALID' }));
  expect(getter).not.toHaveBeenCalled();
});

test('rejects proxied product attributes without executing proxy traps', () => {
  const getPrototypeOf = jest.fn(() => Object.prototype);
  const body = webhookWithShipment((shipment) => {
    shipment.bags[0].item.attributes = new Proxy({}, { getPrototypeOf });
  });

  expect(() => normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body,
    companyId: 12655,
    applicationId: 'app-1',
  })).toThrow(expect.objectContaining({ code: 'SHIPMENT_PRODUCT_TYPE_INVALID' }));
  expect(getPrototypeOf).not.toHaveBeenCalled();
});

test('rejects a missing service product type before validating bag tax', () => {
  const body = webhookWithShipment((shipment) => {
    delete shipment.bags[0].item.attributes['product-type'];
    shipment.bags[0].financial_breakup.gst_tax_percentage = '25.00';
  });

  expect(() => normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body,
    companyId: 12655,
    applicationId: 'app-1',
  })).toThrow(expect.objectContaining({ code: 'SHIPMENT_PRODUCT_TYPE_INVALID' }));
});

test.each([
  ['tax policy', () => undefined, { policyVersion: 'unsupported-policy' }],
  ['branch', (shipment) => { delete shipment.fulfilling_store; }, {}],
  ['currency', (shipment) => { shipment.currency = 'USD'; }, {}],
  ['payment mode', (shipment) => { shipment.payment_info = [{ mode: 'COD' }]; }, {}],
  ['paid amount', (shipment) => { shipment.amount_paid = 'invalid'; }, {}],
])('rejects a missing service product type before validating shipment %s',
  (_description, addInvalidField, options) => {
    const body = webhookWithShipment((shipment) => {
      delete shipment.bags[0].item.attributes['product-type'];
      addInvalidField(shipment);
    });

    expect(() => normalizeShipmentWebhook({
      eventName: 'application/shipment/update/v1',
      body,
      companyId: 12655,
      applicationId: 'app-1',
      ...options,
    })).toThrow(expect.objectContaining({ code: 'SHIPMENT_PRODUCT_TYPE_INVALID' }));
  });

test('accepts a trimmed case-insensitive service product type', () => {
  const body = webhookWithShipment((shipment) => {
    shipment.bags[0].item.attributes['product-type'] = '  SeRvIcE  ';
  });

  const result = normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body,
    companyId: 12655,
    applicationId: 'app-1',
  });

  expect(result.shipment.bags).toHaveLength(1);
  expect(result.shipment.shipmentId).toBe('17861361389811907489');
});

test('normalizes the sanitized live Fynd shipment shape to the existing canonical snapshot', () => {
  const result = normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body: makeLiveNestedShipmentWebhook(),
    companyId: 12655,
    applicationId: 'app-1',
  });

  expect(result).toEqual({
    eventRecord: {
      eventId: 'evt-live-safe-1',
      companyId: '12655',
      applicationId: 'app-1',
      shipmentId: '17861361389811907490',
      eventType: 'application/shipment/update/v1',
      status: 'bag_confirmed',
    },
    shipment: {
      shipmentId: '17861361389811907490',
      confirmedAt: '2026-08-18T06:30:00.000Z',
      branchCode: 'BRANCH-01',
      currency: 'SAR',
      paymentMode: 'CARD',
      amountPaid: '38.38',
      policyVersion: '2026-08-17',
      taxEligibility: {
        governmentBorneVatEligible: false,
        reasonCode: null,
        evidenceReference: 'evt-live-safe-1',
        verifiedAt: '2026-08-18T06:30:00.000Z',
        buyerName: null,
        buyerNationalId: null,
      },
      bags: [{
        bagId: 'bag-live-safe-1',
        lineNumber: 1,
        productCode: 'SKU-LIVE-01',
        quantity: 1,
        financialBreakup: {
          price_effective: '33.37',
          promotion_effective_discount: '0.00',
          coupon_effective_discount: '0.00',
          value_of_good: '33.37',
          gst_tax_percentage: '15.00',
          gst_fee: '5.01',
          amount_paid: '38.38',
        },
        prices: {
          promotion_effective_discount: '0.00',
          coupon_effective_discount: '0.00',
        },
      }],
    },
  });
});

test('builds the exact OEIS row from the normalized sanitized live Fynd shipment', () => {
  const normalized = normalizeLive(liveWebhookWithShipment((shipment) => {
    shipment.shipment_status.created_ts = '2026-08-18T03:00:00+05:30';
  }));
  expect(normalized.shipment.confirmedAt).toBe('2026-08-17T21:30:00.000Z');
  expect(normalized.shipment.taxEligibility.verifiedAt).toBe('2026-08-17T21:30:00.000Z');
  const result = buildOeisPayload(normalized.shipment, {
    companyCode: 'COMPANY',
    sourceErp: 'Fynd.com',
    supplierCountryCode: 'SA',
    amountTolerance: '0.01',
    masterData: {
      getBranch(code) {
        return code === 'BRANCH-01' ? { code } : null;
      },
      getProduct(code) {
        return code === 'SKU-LIVE-01' ? {
          code,
          uqc: 'OTH',
          supplyClass: 'PRIVATE_HEALTHCARE_SERVICE',
          allowedZeroRateReason: 'VATEX-SA-HEA',
        } : null;
      },
    },
    taxPolicyResolver: createTaxPolicyResolver({
      policyVersion: '2026-08-17',
      now: () => new Date('2026-08-18T09:00:00.000Z'),
    }),
  });

  expect(result.documentNumber).toBe('VR-17861361389811907490-1');
  expect(result.rows).toEqual([{
    COMPANY_CODE: 'COMPANY',
    SOURCE_ERP: 'Fynd.com',
    SUPPLIER_COUNTRY_CODE_ENGLISH: 'SA',
    COMPANY_ROLE: 'S',
    INVOICE_TYPE: 'Simplified Tax Invoice',
    INVOICE_SUBTYPE: 'Regular Domestic Supply',
    TEMPLATE_CODE: 'SIMPLIFIED IN',
    TRAN_DOC_TYPE: 'IN',
    TRAN_DOC_NO: 'VR-17861361389811907490-1',
    TRAN_LINE_NO: 1,
    ERP_TRANSACTION_REF: 'VR-17861361389811907490-1_1',
    TRAN_DOC_DATE: '20260818',
    DATE_OF_SUPPLY: '20260818',
    TRAN_BRANCH: 'BRANCH-01',
    TRAN_SERVICE_BRANCH: 'BRANCH-01',
    PRODUCT_CODE: 'SKU-LIVE-01',
    TRAN_UQC: 'OTH',
    INV_CURRENCY_CODE: 'SAR',
    VAT_CURRENCY_CODE: 'SAR',
    TRAN_QUANTITY: 1,
    TRAN_UNIT_PRICE: '33.37',
    TRAN_GROSS_AMOUNT: '33.37',
    TRAN_NET_AMOUNT: '33.37',
    TRAN_TAX_CODE_CATEGORY: 'S',
    TRAN_TAX_RATE: '15.00',
    TRAN_TAX_AMOUNT: '5.01',
    TRAN_NET_PLUS_TAX: '38.38',
    INV_NET_AMOUNT: '33.37',
    INV_TOTAL_TAX_AMOUNT: '5.01',
    INV_TOTAL_AMOUNT: '38.38',
    INV_CUSTOMER_PAID_AMOUNT: '0.00',
    INV_CUSTOMER_AMOUNT_DUE: '38.38',
    PAY_METHOD: '48',
  }]);
  expect(JSON.parse(result.requestJson)).toEqual(result.rows);
});

test.each([
  ['currency', 'CURRENCY_UNSUPPORTED', shipment => {
    shipment.order.currency.currency_code = 'USD';
  }],
  ['payment mode', 'PAYMENT_MODE_INVALID', shipment => {
    shipment.order.payment_methods.card.mode = 'APPLE_PAY';
  }],
  ['amount paid', 'SHIPMENT_AMOUNT_PAID_INVALID', shipment => {
    shipment.order.prices.amount_paid = '38.39';
  }],
  ['product code', 'WEBHOOK_IDENTIFIER_CONFLICT', shipment => {
    shipment.bags[0].article.identifiers.sku_code = 'OTHER-SKU';
  }],
])('rejects conflicting redundant live %s candidates', (_description, code, change) => {
  expect(() => normalizeLive(liveWebhookWithShipment(change)))
    .toThrow(expect.objectContaining({ code }));
});

test.each([
  ['currency', 'CURRENCY_UNSUPPORTED', shipment => {
    delete shipment.currency;
    delete shipment.order.currency;
    delete shipment.order.meta.currency;
  }],
  ['payment mode', 'PAYMENT_MODE_INVALID', shipment => {
    delete shipment.payment_info;
    delete shipment.payment_methods;
    delete shipment.order.payment_info;
    delete shipment.order.payment_methods;
  }],
  ['amount paid', 'SHIPMENT_AMOUNT_PAID_REQUIRED', shipment => {
    delete shipment.prices.amount_paid;
    delete shipment.order.prices.amount_paid;
  }],
  ['product code', 'WEBHOOK_IDENTIFIER_INVALID', shipment => {
    delete shipment.bags[0].seller_identifier;
    delete shipment.bags[0].article;
    delete shipment.bags[0].financial_breakup[0].identifiers;
  }],
])('retains the fixed rejection code when all live %s paths are missing', (_description, code, change) => {
  expect(() => normalizeLive(liveWebhookWithShipment(change)))
    .toThrow(expect.objectContaining({ code }));
});

test.each([
  ['shipment payment_info', shipment => {
    delete shipment.payment_methods;
    delete shipment.order.payment_info;
    delete shipment.order.payment_methods;
  }],
  ['shipment payment_methods', shipment => {
    delete shipment.payment_info;
    delete shipment.order.payment_info;
    delete shipment.order.payment_methods;
  }],
  ['order payment_info', shipment => {
    delete shipment.payment_info;
    delete shipment.payment_methods;
    delete shipment.order.payment_methods;
  }],
  ['order payment_methods', shipment => {
    delete shipment.payment_info;
    delete shipment.payment_methods;
    delete shipment.order.payment_info;
  }],
])('accepts CARD from only %s', (_description, change) => {
  expect(normalizeLive(liveWebhookWithShipment(change)).shipment.paymentMode).toBe('CARD');
});

test.each([
  ['bag seller_identifier', shipment => {
    delete shipment.bags[0].article;
    delete shipment.bags[0].financial_breakup[0].identifiers;
  }],
  ['article seller_identifier', shipment => {
    delete shipment.bags[0].seller_identifier;
    delete shipment.bags[0].article.identifiers;
    delete shipment.bags[0].financial_breakup[0].identifiers;
  }],
  ['article identifiers sku_code', shipment => {
    delete shipment.bags[0].seller_identifier;
    delete shipment.bags[0].article.seller_identifier;
    delete shipment.bags[0].financial_breakup[0].identifiers;
  }],
  ['financial breakup identifiers sku_code', shipment => {
    delete shipment.bags[0].seller_identifier;
    delete shipment.bags[0].article;
  }],
])('accepts the product code from only %s', (_description, change) => {
  expect(normalizeLive(liveWebhookWithShipment(change)).shipment.bags[0].productCode)
    .toBe('SKU-LIVE-01');
});

test('takes tax fields from the breakup item matching the bag product identifiers', () => {
  const body = liveWebhookWithShipment(shipment => {
    shipment.bags[0].financial_breakup.unshift({
      identifiers: { sku_code: 'UNRELATED-SKU' },
      gst_tax_percentage: '0.00',
      gst_fee: '0.00',
    });
  });

  expect(normalizeLive(body).shipment.bags[0]).toEqual(expect.objectContaining({
    productCode: 'SKU-LIVE-01',
    financialBreakup: expect.objectContaining({
      gst_tax_percentage: '15.00',
      gst_fee: '5.01',
    }),
  }));
});

test('rejects a lone breakup product identifier that conflicts with the bag aliases', () => {
  expect(() => normalizeLive(liveWebhookWithShipment(shipment => {
    shipment.bags[0].financial_breakup[0].identifiers.sku_code = 'UNRELATED-SKU';
  }))).toThrow(expect.objectContaining({ code: 'WEBHOOK_IDENTIFIER_CONFLICT' }));
});

test('resolves either nested paid-amount path using decimal normalization without float arithmetic', () => {
  const shipmentPricesOnly = liveWebhookWithShipment(shipment => {
    shipment.prices.amount_paid = 38.38;
    delete shipment.order.prices;
  });
  const orderPricesOnly = liveWebhookWithShipment(shipment => {
    delete shipment.prices.amount_paid;
    shipment.order.prices.amount_paid = 38.38;
  });

  expect(normalizeLive(shipmentPricesOnly).shipment.amountPaid).toBe('38.38');
  expect(normalizeLive(orderPricesOnly).shipment.amountPaid).toBe('38.38');

  expect(() => normalizeLive(liveWebhookWithShipment(shipment => {
    shipment.prices.amount_paid = 0.1 + 0.2;
    delete shipment.order.prices.amount_paid;
  }))).toThrow(expect.objectContaining({ code: 'SHIPMENT_AMOUNT_PAID_INVALID' }));
});

test.each([
  ['currency object', 'CURRENCY_UNSUPPORTED', (shipment, counter) => {
    shipment.currency = new Proxy({ currency_code: 'SAR' }, {
      getPrototypeOf() { counter.calls += 1; throw new Error('currency-proxy-secret'); },
      getOwnPropertyDescriptor() { counter.calls += 1; throw new Error('currency-proxy-secret'); },
    });
  }],
  ['currency_code accessor', 'CURRENCY_UNSUPPORTED', (shipment, counter) => {
    Object.defineProperty(shipment.currency, 'currency_code', {
      enumerable: true,
      get() { counter.calls += 1; throw new Error('currency-accessor-secret'); },
    });
  }],
  ['payment_info object', 'PAYMENT_MODE_INVALID', shipment => {
    shipment.payment_info = { mode: 'CARD' };
  }],
  ['payment_info Proxy', 'PAYMENT_MODE_INVALID', (shipment, counter) => {
    shipment.payment_info = new Proxy([{ mode: 'CARD' }], {
      getPrototypeOf() { counter.calls += 1; throw new Error('payment-proxy-secret'); },
      getOwnPropertyDescriptor() { counter.calls += 1; throw new Error('payment-proxy-secret'); },
      get() { counter.calls += 1; throw new Error('payment-proxy-secret'); },
    });
  }],
  ['payment method mode accessor', 'PAYMENT_MODE_INVALID', (shipment, counter) => {
    Object.defineProperty(shipment.payment_methods.card, 'mode', {
      enumerable: true,
      get() { counter.calls += 1; throw new Error('payment-accessor-secret'); },
    });
  }],
  ['shipment prices array', 'SHIPMENT_AMOUNT_PAID_INVALID', shipment => {
    shipment.prices = [{ amount_paid: '38.38' }];
  }],
  ['amount_paid accessor', 'SHIPMENT_AMOUNT_PAID_INVALID', (shipment, counter) => {
    Object.defineProperty(shipment.prices, 'amount_paid', {
      enumerable: true,
      get() { counter.calls += 1; throw new Error('amount-accessor-secret'); },
    });
  }],
  ['delivery_charges accessor', 'SHIPMENT_DELIVERY_VALUE_INVALID', (shipment, counter) => {
    Object.defineProperty(shipment, 'delivery_charges', {
      enumerable: true,
      get() { counter.calls += 1; throw new Error('delivery-accessor-secret'); },
    });
  }],
  ['prices delivery_charge accessor', 'SHIPMENT_DELIVERY_VALUE_INVALID', (shipment, counter) => {
    Object.defineProperty(shipment.prices, 'delivery_charge', {
      enumerable: true,
      get() { counter.calls += 1; throw new Error('delivery-price-accessor-secret'); },
    });
  }],
  ['delivery breakup accessor', 'SHIPMENT_DELIVERY_CHARGE_REQUIRED', (shipment, counter) => {
    Object.defineProperty(shipment, 'delivery_charges_breakup', {
      enumerable: true,
      get() { counter.calls += 1; throw new Error('delivery-breakup-accessor-secret'); },
    });
  }],
  ['delivery breakup Proxy', 'SHIPMENT_DELIVERY_CHARGE_REQUIRED', (shipment, counter) => {
    shipment.delivery_charges_breakup = new Proxy({
      gst_tax_percentage: '15.00',
      value_of_good: '0.00',
      gst_fee: '0.00',
      amount_paid: '0.00',
    }, {
      getPrototypeOf() { counter.calls += 1; throw new Error('delivery-breakup-proxy-secret'); },
      getOwnPropertyDescriptor() { counter.calls += 1; throw new Error('delivery-breakup-proxy-secret'); },
      get() { counter.calls += 1; throw new Error('delivery-breakup-proxy-secret'); },
    });
  }],
  ['delivery breakup tax accessor', 'SHIPMENT_DELIVERY_TAX_RATE_INVALID', (shipment, counter) => {
    shipment.delivery_charges_breakup = {
      gst_tax_percentage: '15.00',
      value_of_good: '0.00',
      gst_fee: '0.00',
      amount_paid: '0.00',
    };
    Object.defineProperty(shipment.delivery_charges_breakup, 'gst_tax_percentage', {
      enumerable: true,
      get() { counter.calls += 1; throw new Error('delivery-tax-accessor-secret'); },
    });
  }],
  ['bag Proxy', 'SHIPMENT_BAG_INVALID', (shipment, counter) => {
    shipment.bags[0] = new Proxy(shipment.bags[0], {
      getPrototypeOf() { counter.calls += 1; throw new Error('bag-proxy-secret'); },
      getOwnPropertyDescriptor() { counter.calls += 1; throw new Error('bag-proxy-secret'); },
      get() { counter.calls += 1; throw new Error('bag-proxy-secret'); },
    });
  }],
  ['article Proxy', 'WEBHOOK_IDENTIFIER_INVALID', (shipment, counter) => {
    shipment.bags[0].article = new Proxy(shipment.bags[0].article, {
      getPrototypeOf() { counter.calls += 1; throw new Error('article-proxy-secret'); },
      getOwnPropertyDescriptor() { counter.calls += 1; throw new Error('article-proxy-secret'); },
    });
  }],
  ['breakup identifiers Proxy', 'WEBHOOK_IDENTIFIER_INVALID', (shipment, counter) => {
    shipment.bags[0].financial_breakup[0].identifiers = new Proxy(
      shipment.bags[0].financial_breakup[0].identifiers,
      {
        getPrototypeOf() { counter.calls += 1; throw new Error('identifiers-proxy-secret'); },
        getOwnPropertyDescriptor() { counter.calls += 1; throw new Error('identifiers-proxy-secret'); },
      },
    );
  }],
  ['bag prices array', 'SHIPMENT_PRICES_INVALID', shipment => {
    shipment.bags[0].prices = [];
  }],
  ['financial breakup Proxy', 'SHIPMENT_FINANCIAL_BREAKUP_REQUIRED', (shipment, counter) => {
    shipment.bags[0].financial_breakup = new Proxy(shipment.bags[0].financial_breakup, {
      getPrototypeOf() { counter.calls += 1; throw new Error('breakup-proxy-secret'); },
      getOwnPropertyDescriptor() { counter.calls += 1; throw new Error('breakup-proxy-secret'); },
      get() { counter.calls += 1; throw new Error('breakup-proxy-secret'); },
    });
  }],
  ['financial breakup accessor item', 'SHIPMENT_FINANCIAL_BREAKUP_REQUIRED', (shipment, counter) => {
    Object.defineProperty(shipment.bags[0].financial_breakup, '0', {
      get() { counter.calls += 1; throw new Error('breakup-accessor-secret'); },
    });
  }],
  ['financial breakup array item', 'SHIPMENT_FINANCIAL_BREAKUP_REQUIRED', shipment => {
    shipment.bags[0].financial_breakup[0] = [];
  }],
])('fails closed for malformed or hostile live %s without executing caller code',
  (_description, code, change) => {
    const counter = { calls: 0 };
    const body = liveWebhookWithShipment(shipment => change(shipment, counter));

    expect(() => normalizeLive(body)).toThrow(expect.objectContaining({ code }));
    expect(counter.calls).toBe(0);
  });

test('normalizes the exact authoritative HEA path and keeps product and delivery tax distinct', () => {
  const body = webhookWithShipment((shipment) => {
    shipment.order.meta.custom_cart_meta.custom_conditions = {
      taxation_nationality: true,
      recipient_name: 'Synthetic Citizen',
      national_id: '1000000000',
    };
    shipment.amount_paid = '301.50';
    shipment.delivery_charges = '30.00';
    shipment.prices = { delivery_charge: '30.00' };
    shipment.delivery_charges_breakup = {
      gst_tax_percentage: '15.00', value_of_good: '30.00', gst_fee: '4.50', amount_paid: '34.50',
    };
    shipment.bags[0].financial_breakup = {
      price_effective: '299.00', promotion_effective_discount: '32.00', coupon_effective_discount: '0.00',
      value_of_good: '267.00', gst_tax_percentage: '0.00', gst_fee: '0.00',
      amount_paid: '301.50', delivery_charge: '30.00',
    };
    shipment.bags[0].prices = {
      promotion_effective_discount: '32.00', coupon_effective_discount: '0.00',
    };
  });

  const result = normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body, companyId: 12655, applicationId: 'app-1',
  });

  expect(result.shipment.taxEligibility).toEqual({
    governmentBorneVatEligible: true,
    reasonCode: 'VATEX-SA-HEA',
    evidenceReference: 'evt-1',
    verifiedAt: '2026-08-10T06:30:00.000Z',
    buyerName: 'Synthetic Citizen',
    buyerNationalId: '1000000000',
  });
  expect(result.shipment.policyVersion).toBe('2026-08-17');
  expect(result.shipment.bags[0].financialBreakup).toEqual(expect.objectContaining({
    value_of_good: '267.00', gst_tax_percentage: '0.00', gst_fee: '0.00',
    amount_paid: '301.50', delivery_charge: '30.00',
  }));
  expect(result.shipment.deliveryCharge).toEqual({
    taxCategory: 'S', taxRate: '15.00', netAmount: '30.00', taxAmount: '4.50', paidAmount: '34.50',
  });
});

test.each([
  ['missing eligibility', (shipment) => { delete shipment.order.meta.custom_cart_meta.custom_conditions.taxation_nationality; }],
  ['wrong-type eligibility', (shipment) => { shipment.order.meta.custom_cart_meta.custom_conditions.taxation_nationality = 'true'; }],
  ['missing eligible name', (shipment) => {
    shipment.order.meta.custom_cart_meta.custom_conditions.taxation_nationality = true;
    delete shipment.order.meta.custom_cart_meta.custom_conditions.recipient_name;
  }],
  ['invalid eligible National ID', (shipment) => {
    shipment.order.meta.custom_cart_meta.custom_conditions.taxation_nationality = true;
    shipment.order.meta.custom_cart_meta.custom_conditions.national_id = 'sensitive-invalid-id';
  }],
  ['invalid exact verification timestamp', (shipment) => {
    delete shipment.shipment_status.created_ts;
    shipment.created_ts = '2026-08-10T06:30:00.000Z';
  }],
])('persists a safe unresolved eligibility candidate for %s', (_case, change) => {
  const body = webhookWithShipment(change);

  const result = normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body, companyId: 12655, applicationId: 'app-1',
  });

  expect(result.shipment.taxEligibility).toEqual(expect.objectContaining({
    evidenceReference: 'evt-1',
  }));
  expect(JSON.stringify(result.shipment.taxEligibility)).not.toContain('sensitive-invalid-id');
  expect(JSON.stringify(result.shipment.taxEligibility)).not.toContain('invalid-private-time');
  if (_case === 'invalid exact verification timestamp') {
    expect(result.shipment.confirmedAt).toBeNull();
    expect(result.shipment.taxEligibility.verifiedAt).toBeNull();
  }
});

test('does not infer eligibility from a similarly named path or inherited raw fields', () => {
  const body = webhookWithShipment((shipment) => {
    const conditions = Object.create({ taxation_nationality: true, recipient_name: 'Inherited Name', national_id: '1000000000' });
    shipment.order.meta.custom_cart_meta.custom_conditions = conditions;
    shipment.custom_conditions = { taxation_nationality: true };
  });

  const result = normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body, companyId: 12655, applicationId: 'app-1',
  });

  expect(result.shipment.taxEligibility).toEqual(expect.objectContaining({
    governmentBorneVatEligible: null, reasonCode: null, buyerName: null, buyerNationalId: null,
  }));
  expect(JSON.stringify(result.shipment)).not.toContain('Inherited Name');
});

test.each([
  '2026-02-30T06:30:00.000Z',
  '2026-08-10T06:30:00+25:00',
  1786343400,
])('drops an invalid exact eligibility timestamp without using a general timestamp fallback: %p', timestamp => {
  const body = webhookWithShipment((shipment) => {
    shipment.shipment_status.created_ts = timestamp;
    shipment.shipment_status.status_created_at = '2026-08-10T06:30:00.000Z';
    shipment.created_ts = '2026-08-10T06:31:00.000Z';
  });

  const result = normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body, companyId: 12655, applicationId: 'app-1',
  });

  expect(result.shipment.confirmedAt).toBeNull();
  expect(result.shipment.taxEligibility.verifiedAt).toBeNull();
});

test('requires the exact own nested status even when a flat status and nested timestamp are valid', () => {
  const body = webhookWithShipment(shipment => {
    delete shipment.shipment_status.status;
    shipment.status = 'bag_confirmed';
  });

  expect(() => normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body, companyId: 12655, applicationId: 'app-1',
  })).toThrow(expect.objectContaining({ code: 'SHIPMENT_STATUS_REQUIRED' }));
});

test('ignores a conflicting flat status and never invokes its getter', () => {
  const body = webhookWithShipment(shipment => {
    const counter = { calls: 0 };
    Object.defineProperty(shipment, 'status', {
      enumerable: true,
      get() {
        counter.calls += 1;
        return 'bag_packed';
      },
    });
    shipment.flatStatusCounter = counter;
  });
  const counter = body.payload.shipment.flatStatusCounter;
  delete body.payload.shipment.flatStatusCounter;

  const result = normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body, companyId: 12655, applicationId: 'app-1',
  });

  expect(result.eventRecord.status).toBe('bag_confirmed');
  expect(result.shipment.confirmedAt).toBe('2026-08-10T06:30:00.000Z');
  expect(result.shipment.taxEligibility.verifiedAt).toBe('2026-08-10T06:30:00.000Z');
  expect(counter.calls).toBe(0);
});

test.each([
  ['inherited shipment_status', (shipment, counter) => {
    const value = shipment.shipment_status;
    delete shipment.shipment_status;
    Object.setPrototypeOf(shipment, { shipment_status: value });
    counter.calls = 0;
  }],
  ['accessor shipment_status', (shipment, counter) => {
    const value = shipment.shipment_status;
    Object.defineProperty(shipment, 'shipment_status', {
      enumerable: true,
      get() {
        counter.calls += 1;
        return value;
      },
    });
  }],
  ['proxied shipment_status', (shipment, counter) => {
    shipment.shipment_status = new Proxy(shipment.shipment_status, {
      get(target, property, receiver) {
        counter.calls += 1;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        counter.calls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      getPrototypeOf(target) {
        counter.calls += 1;
        return Reflect.getPrototypeOf(target);
      },
    });
  }],
  ['array shipment_status', shipment => {
    shipment.shipment_status = Object.assign([], shipment.shipment_status);
  }],
  ['class shipment_status', shipment => {
    class ShipmentStatus {
      constructor() {
        this.status = 'bag_confirmed';
        this.created_ts = '2026-08-10T06:30:00.000Z';
      }
    }
    shipment.shipment_status = new ShipmentStatus();
  }],
  ['accessor nested status', (shipment, counter) => {
    Object.defineProperty(shipment.shipment_status, 'status', {
      enumerable: true,
      get() {
        counter.calls += 1;
        return 'bag_confirmed';
      },
    });
  }],
])('rejects hostile %s without executing a getter or proxy trap', (_description, change) => {
  const counter = { calls: 0 };
  const body = webhookWithShipment(shipment => change(shipment, counter));

  expect(() => normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body, companyId: 12655, applicationId: 'app-1',
  })).toThrow(expect.objectContaining({ code: 'SHIPMENT_STATUS_REQUIRED' }));
  expect(counter.calls).toBe(0);
});

test('treats an accessor verification timestamp as unresolved without invoking it or falling back', () => {
  const counter = { calls: 0 };
  const body = webhookWithShipment(shipment => {
    Object.defineProperty(shipment.shipment_status, 'created_ts', {
      enumerable: true,
      get() {
        counter.calls += 1;
        return '2026-08-10T06:30:00.000Z';
      },
    });
    shipment.shipment_status.status_created_at = '2026-08-10T06:31:00.000Z';
    shipment.created_ts = '2026-08-10T06:32:00.000Z';
    shipment.updated_ts = '2026-08-10T06:32:00.000Z';
  });

  const result = normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body, companyId: 12655, applicationId: 'app-1',
  });

  expect(result.shipment.confirmedAt).toBeNull();
  expect(result.shipment.taxEligibility.verifiedAt).toBeNull();
  expect(counter.calls).toBe(0);
});

test('uses callback company and application identifiers while rejecting body conflicts', () => {
  expect(normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body: makeShipmentWebhook(), companyId: '12655', applicationId: 'app-1',
  }).eventRecord).toEqual(expect.objectContaining({ companyId: '12655', applicationId: 'app-1' }));

  const conflictingCompany = makeShipmentWebhook({});
  conflictingCompany.company_id = 999;
  expect(() => normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body: conflictingCompany, companyId: 12655, applicationId: 'app-1',
  })).toThrow(expect.objectContaining({ code: 'WEBHOOK_IDENTIFIER_CONFLICT' }));
});

test('ignores an unrelated shipment status', () => {
  const result = normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body: webhookWithShipment((shipment) => { shipment.shipment_status.status = 'bag_packed'; }),
    companyId: 12655,
    applicationId: 'app-1',
  });

  expect(result).toEqual({ ignored: true });
});

test('rejects a webhook with no event id', () => {
  const body = makeShipmentWebhook();
  delete body.event.id;
  expect(() => normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body, companyId: 12655, applicationId: 'app-1',
  })).toThrow(expect.objectContaining({ code: 'WEBHOOK_EVENT_ID_REQUIRED' }));
});

test.each([
  ['missing event container', 'WEBHOOK_EVENT_ID_REQUIRED', (body) => { delete body.event; }],
  ['null event container', 'WEBHOOK_EVENT_ID_INVALID', (body) => { body.event = null; }],
  ['inherited event container', 'WEBHOOK_EVENT_ID_INVALID', (body) => {
    delete body.event;
    Object.setPrototypeOf(body, { event: { id: 'inherited-event-secret' } });
  }],
  ['accessor event container', 'WEBHOOK_EVENT_ID_INVALID', (body) => {
    Object.defineProperty(body, 'event', {
      enumerable: true,
      get() { throw new Error('accessor-event-secret'); },
    });
  }],
  ['inherited event id', 'WEBHOOK_EVENT_ID_INVALID', (body) => {
    body.event = Object.create({ id: 'inherited-id-secret' });
  }],
  ['accessor event id', 'WEBHOOK_EVENT_ID_INVALID', (body) => {
    Object.defineProperty(body.event, 'id', {
      enumerable: true,
      get() { throw new Error('accessor-id-secret'); },
    });
  }],
  ['proxied event container', 'WEBHOOK_EVENT_ID_INVALID', (body) => {
    body.event = new Proxy({ id: 'proxied-id-secret' }, {});
  }],
  ['array event container', 'WEBHOOK_EVENT_ID_INVALID', (body) => {
    body.event = Object.assign([], { id: 'array-id-secret' });
  }],
  ['class event container', 'WEBHOOK_EVENT_ID_INVALID', (body) => {
    class EventContainer {
      constructor() { this.id = 'class-id-secret'; }
    }
    body.event = new EventContainer();
  }],
])('rejects %s without trusting or exposing its event value', (_case, code, change) => {
  const body = makeShipmentWebhook();
  change(body);

  let caught;
  try {
    normalizeShipmentWebhook({
      eventName: 'application/shipment/update/v1', body, companyId: 12655, applicationId: 'app-1',
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toEqual(expect.objectContaining({ code }));
  expect(`${caught.name} ${caught.code} ${caught.message}`).not.toMatch(/(?:inherited|accessor|proxied|array|class)-(?:event|id)-secret/);
});

test('preserves Fynd opaque Base64 event identifiers used for webhook idempotency', () => {
  const body = makeShipmentWebhook();
  body.event.id = 'DZlcvyBgMu/zX1n9knpNNfl7lVPsG/Pgqbpyjt+SbhU=';

  const result = normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body, companyId: 12655, applicationId: 'app-1',
  });

  expect(result.eventRecord.eventId).toBe(body.event.id);
});

test.each([
  ['a non-string identifier', 123],
  ['leading whitespace', ' opaque/+id=='],
  ['embedded whitespace', 'opaque event/+id=='],
  ['a control character', 'opaque\nevent/+id=='],
  ['an oversized identifier', 'a'.repeat(513)],
])('rejects %s as an opaque webhook event identifier', (_description, eventId) => {
  const body = makeShipmentWebhook();
  body.event.id = eventId;

  expect(() => normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body, companyId: 12655, applicationId: 'app-1',
  })).toThrow(expect.objectContaining({ code: 'WEBHOOK_EVENT_ID_INVALID' }));
});

test('rejects mixed or empty payment modes', () => {
  for (const paymentInfo of [[{ mode: 'CARD' }, { mode: 'APPLE_PAY' }], []]) {
    expect(() => normalizeShipmentWebhook({
      eventName: 'application/shipment/update/v1',
      body: webhookWithShipment((shipment) => { shipment.payment_info = paymentInfo; }), companyId: 12655, applicationId: 'app-1',
    })).toThrow(expect.objectContaining({ code: 'PAYMENT_MODE_INVALID' }));
  }
});

test('rejects COD before any workflow can lock the shipment', () => {
  expect(() => normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body: webhookWithShipment((shipment) => { shipment.payment_info = [{ mode: 'COD' }]; }),
    companyId: 12655, applicationId: 'app-1',
  })).toThrow(expect.objectContaining({ code: 'PAYMENT_MODE_UNSUPPORTED' }));
});

test('uses bag prices as the discount fallback and rejects conflicting duplicate discounts', () => {
  const fallback = webhookWithShipment((shipment) => {
    delete shipment.bags[0].financial_breakup.promotion_effective_discount;
    delete shipment.bags[0].financial_breakup.coupon_effective_discount;
  });
  expect(normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body: fallback, companyId: 12655, applicationId: 'app-1',
  }).shipment.bags[0].financialBreakup).toEqual(expect.objectContaining({
    promotion_effective_discount: '0.00', coupon_effective_discount: '0.00',
  }));

  expect(() => normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body: webhookWithShipment((shipment) => { shipment.bags[0].prices.promotion_effective_discount = '0.02'; }),
    companyId: 12655,
    applicationId: 'app-1',
  })).toThrow(expect.objectContaining({ code: 'SHIPMENT_DISCOUNT_CONFLICT' }));
});

test('rejects a bag with a non-positive quantity', () => {
  expect(() => normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body: webhookWithShipment((shipment) => { shipment.bags[0].quantity = 0; }), companyId: 12655, applicationId: 'app-1',
  })).toThrow(expect.objectContaining({ code: 'SHIPMENT_QUANTITY_INVALID' }));
});

test('canonicalizes valid financial fields to fixed decimal strings', () => {
  const result = normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body: webhookWithShipment((shipment) => {
      shipment.amount_paid = 115;
      shipment.bags[0].financial_breakup.price_effective = '100';
      shipment.bags[0].financial_breakup.promotion_effective_discount = 0;
      shipment.bags[0].financial_breakup.coupon_effective_discount = '0';
      shipment.bags[0].financial_breakup.value_of_good = 100;
      shipment.bags[0].financial_breakup.gst_tax_percentage = '15.0';
      shipment.bags[0].financial_breakup.gst_fee = 15;
      shipment.bags[0].financial_breakup.amount_paid = '115';
      shipment.bags[0].financial_breakup.delivery_charge = 0;
      shipment.bags[0].prices = { promotion_effective_discount: '0', coupon_effective_discount: 0 };
    }), companyId: 12655, applicationId: 'app-1',
  });

  expect(result.shipment.amountPaid).toBe('115.00');
  expect(result.shipment.bags[0]).toEqual(expect.objectContaining({ quantity: 1, financialBreakup: {
    price_effective: '100.00', promotion_effective_discount: '0.00', coupon_effective_discount: '0.00',
    value_of_good: '100.00', gst_tax_percentage: '15.00', gst_fee: '15.00', amount_paid: '115.00',
  }, prices: { promotion_effective_discount: '0.00', coupon_effective_discount: '0.00' } }));
});

test('normalizes a taxed shipment delivery charge and its bag allocation separately from product totals', () => {
  const body = webhookWithShipment((shipment) => {
    shipment.amount_paid = '341.55';
    shipment.delivery_charges = '30.00';
    shipment.prices = { delivery_charge: '30.00' };
    shipment.delivery_charges_breakup = {
      item_name: 'Delivery Charge',
      gst_tax_percentage: '15.00',
      value_of_good: '30.00',
      gst_fee: '4.50',
      amount_paid: '34.50',
    };
    shipment.bags[0].financial_breakup = {
      price_effective: '299.00',
      promotion_effective_discount: '32.00',
      coupon_effective_discount: '0.00',
      value_of_good: '267.00',
      gst_tax_percentage: '15.00',
      gst_fee: '40.05',
      amount_paid: '341.55',
      delivery_charge: '30.00',
    };
    shipment.bags[0].prices = {
      promotion_effective_discount: '32.00',
      coupon_effective_discount: '0.00',
    };
  });

  const result = normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body, companyId: 12655, applicationId: 'app-1',
  });

  expect(result.shipment.deliveryCharge).toEqual({
    taxCategory: 'S', taxRate: '15.00', netAmount: '30.00', taxAmount: '4.50', paidAmount: '34.50',
  });
  expect(result.shipment.bags[0].financialBreakup.delivery_charge).toBe('30.00');
});

test('omits a present delivery breakup when its valid 15 percent amounts are all zero', () => {
  const result = normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body: webhookWithShipment(shipment => {
      shipment.delivery_charges_breakup = {
        gst_tax_percentage: '15.00',
        value_of_good: '0.00',
        gst_fee: '0.00',
        amount_paid: '0.00',
      };
    }),
    companyId: 12655,
    applicationId: 'app-1',
  });

  expect(result.shipment).not.toHaveProperty('deliveryCharge');
});

test('rejects an invalid delivery tax rate even when the present breakup amounts are all zero', () => {
  expect(() => normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body: webhookWithShipment(shipment => {
      shipment.delivery_charges_breakup = {
        gst_tax_percentage: '999.00',
        value_of_good: '0.00',
        gst_fee: '0.00',
        amount_paid: '0.00',
      };
    }),
    companyId: 12655,
    applicationId: 'app-1',
  })).toThrow(expect.objectContaining({ code: 'SHIPMENT_DELIVERY_TAX_RATE_INVALID' }));
});

test.each([
  ['SHIPMENT_DELIVERY_CHARGE_REQUIRED', (shipment) => {
    shipment.amount_paid = '149.50';
    shipment.bags[0].financial_breakup.amount_paid = '149.50';
    shipment.bags[0].financial_breakup.delivery_charge = '30.00';
  }],
  ['SHIPMENT_DELIVERY_TAX_RATE_INVALID', (shipment) => {
    shipment.delivery_charges_breakup = {
      gst_tax_percentage: '14.00', value_of_good: '30.00', gst_fee: '4.20', amount_paid: '34.20',
    };
  }],
  ['SHIPMENT_DELIVERY_TOTAL_MISMATCH', (shipment) => {
    shipment.delivery_charges_breakup = {
      gst_tax_percentage: '15.00', value_of_good: '30.00', gst_fee: '4.50', amount_paid: '34.49',
    };
  }],
  ['SHIPMENT_DELIVERY_TOTAL_MISMATCH', (shipment) => {
    shipment.delivery_charges = '29.99';
    shipment.delivery_charges_breakup = {
      gst_tax_percentage: '15.00', value_of_good: '30.00', gst_fee: '4.50', amount_paid: '34.50',
    };
  }],
  ['SHIPMENT_DELIVERY_TOTAL_MISMATCH', (shipment) => {
    shipment.prices = { delivery_charge: '29.99' };
    shipment.delivery_charges_breakup = {
      gst_tax_percentage: '15.00', value_of_good: '30.00', gst_fee: '4.50', amount_paid: '34.50',
    };
    shipment.bags[0].financial_breakup.delivery_charge = '30.00';
  }],
  ['SHIPMENT_DELIVERY_TOTAL_MISMATCH', (shipment) => {
    shipment.prices = { delivery_charge: '1.00' };
    shipment.delivery_charges_breakup = {
      gst_tax_percentage: '15.00', value_of_good: '0.00', gst_fee: '0.00', amount_paid: '0.00',
    };
  }],
])('rejects invalid delivery financials with %s', (code, change) => {
  expect(() => normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1',
    body: webhookWithShipment(change),
    companyId: 12655,
    applicationId: 'app-1',
  })).toThrow(expect.objectContaining({ code }));
});

test('rejects invalid financial decimals, an invalid tax rate, and non-integer quantity', () => {
  const cases = [
    ['SHIPMENT_AMOUNT_PAID_INVALID', (shipment) => { shipment.amount_paid = '1e2'; }],
    ['SHIPMENT_FINANCIAL_VALUE_INVALID', (shipment) => { shipment.bags[0].financial_breakup.value_of_good = '-1.00'; }],
    ['SHIPMENT_PRICE_INVALID', (shipment) => { shipment.bags[0].financial_breakup.price_effective = '0'; }],
    ['SHIPMENT_TAX_RATE_INVALID', (shipment) => { shipment.bags[0].financial_breakup.gst_tax_percentage = '14.99'; }],
    ['SHIPMENT_DISCOUNT_INVALID', (shipment) => { shipment.bags[0].prices.promotion_effective_discount = 'NaN'; }],
    ['SHIPMENT_QUANTITY_INVALID', (shipment) => { shipment.bags[0].quantity = '1.5'; }],
  ];

  for (const [code, change] of cases) {
    expect(() => normalizeShipmentWebhook({
      eventName: 'application/shipment/update/v1', body: webhookWithShipment(change), companyId: 12655, applicationId: 'app-1',
    })).toThrow(expect.objectContaining({ code }));
  }
});

test('rejects non-SAR, incomplete shipment fields, and malformed shipment identifiers', () => {
  const cases = [
    ['CURRENCY_UNSUPPORTED', (shipment) => { shipment.currency = 'USD'; }],
    ['SHIPMENT_BRANCH_REQUIRED', (shipment) => { delete shipment.fulfilling_store; }],
    ['SHIPMENT_BAGS_REQUIRED', (shipment) => { shipment.bags = []; }],
    ['WEBHOOK_IDENTIFIER_INVALID', (shipment) => { shipment.shipment_id = 'bad id'; }],
  ];

  for (const [code, change] of cases) {
    expect(() => normalizeShipmentWebhook({
      eventName: 'application/shipment/update/v1', body: webhookWithShipment(change), companyId: 12655, applicationId: 'app-1',
    })).toThrow(expect.objectContaining({ code }));
  }
});

test('does not mutate the FDK webhook object', () => {
  const body = makeShipmentWebhook();
  const before = JSON.parse(JSON.stringify(body));

  normalizeShipmentWebhook({
    eventName: 'application/shipment/update/v1', body, companyId: 12655, applicationId: 'app-1',
  });

  expect(body).toEqual(before);
});

describe('trusted shipment identity boundary', () => {
  function extract(body = makeShipmentWebhook(), overrides = {}) {
    return extractTrustedShipmentIdentity({
      eventName: 'application/shipment/update/v1',
      body,
      companyId: 12655,
      applicationId: 'app-1',
      ...overrides,
    });
  }

  test('preserves the exact opaque event id and returns a fresh deeply frozen identity', () => {
    const body = makeShipmentWebhook();
    body.event.id = 'DZlcvyBgMu/zX1n9knpNNfl7lVPsG/Pgqbpyjt+SbhU=';
    const before = JSON.parse(JSON.stringify(body));

    const identity = extract(body);

    expect(identity).toEqual({
      eventName: 'application/shipment/update/v1',
      eventId: 'DZlcvyBgMu/zX1n9knpNNfl7lVPsG/Pgqbpyjt+SbhU=',
      companyId: '12655',
      applicationId: 'app-1',
      shipmentId: '17861361389811907489',
    });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(identity).not.toBe(body);
    expect(body).toEqual(before);
  });

  test('rejects an unsupported event name before inspecting a hostile body', () => {
    const counter = { calls: 0 };
    const body = new Proxy({}, {
      getPrototypeOf() { counter.calls += 1; throw new Error('must-not-run'); },
      getOwnPropertyDescriptor() { counter.calls += 1; throw new Error('must-not-run'); },
      ownKeys() { counter.calls += 1; throw new Error('must-not-run'); },
      get() { counter.calls += 1; throw new Error('must-not-run'); },
    });

    expect(() => extract(body, { eventName: 'application/order/update/v1' }))
      .toThrow(expect.objectContaining({ code: 'WEBHOOK_EVENT_UNSUPPORTED' }));
    expect(counter.calls).toBe(0);
  });

  test('requires callback/body agreement and permits application id only when absent or null on both sides', () => {
    const body = makeShipmentWebhook();
    expect(extract(body)).toEqual(expect.objectContaining({ companyId: '12655', applicationId: 'app-1' }));

    body.company_id = 'different-company';
    expect(() => extract(body)).toThrow(expect.objectContaining({ code: 'WEBHOOK_IDENTIFIER_CONFLICT' }));

    const nullable = makeShipmentWebhook();
    delete nullable.application_id;
    expect(extract(nullable, { applicationId: null })).toEqual(expect.objectContaining({ applicationId: null }));

    nullable.application_id = 'app-1';
    expect(extract(nullable, { applicationId: null }))
      .toEqual(expect.objectContaining({ applicationId: 'app-1' }));
  });

  test('requires dual shipment aliases to agree', () => {
    const body = makeShipmentWebhook();
    body.payload.shipment.id = body.payload.shipment.shipment_id;
    expect(extract(body).shipmentId).toBe('17861361389811907489');

    body.payload.shipment.id = 'different-shipment';
    expect(() => extract(body)).toThrow(expect.objectContaining({ code: 'WEBHOOK_IDENTIFIER_CONFLICT' }));
  });

  test.each([
    ['event id lower byte boundary', (body) => { body.event.id = '!'; }],
    ['event id upper byte boundary', (body) => { body.event.id = 'x'.repeat(512); }],
    ['safe integer company id', (body, overrides) => { body.company_id = Number.MAX_SAFE_INTEGER; overrides.companyId = Number.MAX_SAFE_INTEGER; }],
    ['512-byte shipment id', (body) => { body.payload.shipment.shipment_id = 's'.repeat(512); }],
    ['256-byte application id', (body, overrides) => { body.application_id = 'a'.repeat(256); overrides.applicationId = 'a'.repeat(256); }],
  ])('accepts %s', (_description, change) => {
    const body = makeShipmentWebhook();
    const overrides = {};
    change(body, overrides);
    expect(() => extract(body, overrides)).not.toThrow();
  });

  test.each([
    ['empty event id', (body) => { body.event.id = ''; }, 'WEBHOOK_EVENT_ID_REQUIRED'],
    ['space event id', (body) => { body.event.id = 'not opaque'; }, 'WEBHOOK_EVENT_ID_INVALID'],
    ['513-byte event id', (body) => { body.event.id = 'x'.repeat(513); }, 'WEBHOOK_EVENT_ID_INVALID'],
    ['unsafe integer company id', (body, overrides) => { body.company_id = Number.MAX_SAFE_INTEGER + 1; overrides.companyId = Number.MAX_SAFE_INTEGER + 1; }, 'WEBHOOK_IDENTIFIER_INVALID'],
    ['513-byte shipment id', (body) => { body.payload.shipment.shipment_id = 's'.repeat(513); }, 'WEBHOOK_IDENTIFIER_INVALID'],
    ['257-byte application id', (body, overrides) => { body.application_id = 'a'.repeat(257); overrides.applicationId = 'a'.repeat(257); }, 'WEBHOOK_IDENTIFIER_INVALID'],
  ])('rejects %s at the trusted boundary', (_description, change, code) => {
    const body = makeShipmentWebhook();
    const overrides = {};
    change(body, overrides);
    expect(() => extract(body, overrides)).toThrow(expect.objectContaining({ code }));
  });

  test.each([
    ['body Proxy', (body, counter) => new Proxy(body, {
      getPrototypeOf() { counter.calls += 1; throw new Error('trap'); },
      getOwnPropertyDescriptor() { counter.calls += 1; throw new Error('trap'); },
    }), 'WEBHOOK_PAYLOAD_INVALID'],
    ['event Proxy', (body, counter) => {
      body.event = new Proxy(body.event, {
        getPrototypeOf() { counter.calls += 1; throw new Error('trap'); },
        getOwnPropertyDescriptor() { counter.calls += 1; throw new Error('trap'); },
      });
      return body;
    }, 'WEBHOOK_EVENT_ID_INVALID'],
    ['payload Proxy', (body, counter) => {
      body.payload = new Proxy(body.payload, {
        getPrototypeOf() { counter.calls += 1; throw new Error('trap'); },
        getOwnPropertyDescriptor() { counter.calls += 1; throw new Error('trap'); },
      });
      return body;
    }, 'WEBHOOK_PAYLOAD_INVALID'],
    ['shipment Proxy', (body, counter) => {
      body.payload.shipment = new Proxy(body.payload.shipment, {
        getPrototypeOf() { counter.calls += 1; throw new Error('trap'); },
        getOwnPropertyDescriptor() { counter.calls += 1; throw new Error('trap'); },
      });
      return body;
    }, 'WEBHOOK_PAYLOAD_INVALID'],
  ])('rejects a %s without executing any Proxy trap', (_description, change, code) => {
    const body = makeShipmentWebhook();
    const counter = { calls: 0 };
    const hostileBody = change(body, counter);

    expect(() => extract(hostileBody)).toThrow(expect.objectContaining({ code }));
    expect(counter.calls).toBe(0);
  });

  test.each([
    ['body.event', (body, counter) => Object.defineProperty(body, 'event', { get() { counter.calls += 1; return { id: 'evt' }; } }), 'WEBHOOK_EVENT_ID_INVALID'],
    ['event.id', (body, counter) => Object.defineProperty(body.event, 'id', { get() { counter.calls += 1; return 'evt'; } }), 'WEBHOOK_EVENT_ID_INVALID'],
    ['body.company_id', (body, counter) => Object.defineProperty(body, 'company_id', { get() { counter.calls += 1; return 12655; } }), 'WEBHOOK_IDENTIFIER_INVALID'],
    ['body.application_id', (body, counter) => Object.defineProperty(body, 'application_id', { get() { counter.calls += 1; return 'app-1'; } }), 'WEBHOOK_IDENTIFIER_INVALID'],
    ['body.payload', (body, counter) => Object.defineProperty(body, 'payload', { get() { counter.calls += 1; return {}; } }), 'WEBHOOK_PAYLOAD_INVALID'],
    ['payload.shipment', (body, counter) => Object.defineProperty(body.payload, 'shipment', { get() { counter.calls += 1; return {}; } }), 'WEBHOOK_PAYLOAD_INVALID'],
    ['shipment.shipment_id', (body, counter) => Object.defineProperty(body.payload.shipment, 'shipment_id', { get() { counter.calls += 1; return 'shipment'; } }), 'WEBHOOK_IDENTIFIER_INVALID'],
  ])('rejects accessor-backed %s without invoking it', (_description, change, code) => {
    const body = makeShipmentWebhook();
    const counter = { calls: 0 };
    change(body, counter);

    expect(() => extract(body)).toThrow(expect.objectContaining({ code }));
    expect(counter.calls).toBe(0);
  });

  test.each([
    ['body', body => Object.assign([], body)],
    ['event', body => { body.event = Object.assign([], body.event); return body; }],
    ['payload', body => { body.payload = Object.assign([], body.payload); return body; }],
    ['shipment', body => { body.payload.shipment = Object.assign([], body.payload.shipment); return body; }],
    ['null-prototype payload', body => { body.payload = Object.assign(Object.create(null), body.payload); return body; }],
    ['class shipment', body => {
      class Shipment {}
      body.payload.shipment = Object.assign(new Shipment(), body.payload.shipment);
      return body;
    }],
  ])('rejects a non-plain %s container', (_description, change) => {
    expect(() => extract(change(makeShipmentWebhook())))
      .toThrow(expect.objectContaining({ code: expect.stringMatching(/^WEBHOOK_(?:EVENT_ID|PAYLOAD)_INVALID$/) }));
  });

  test('uses the branded identity without rereading any identifier path and rejects a lookalike', () => {
    const body = makeShipmentWebhook();
    const identity = extract(body);
    const counter = { calls: 0 };
    for (const [object, key] of [
      [body, 'event'],
      [body, 'company_id'],
      [body, 'application_id'],
      [body, 'payload'],
      [body.payload.shipment, 'shipment_id'],
    ]) {
      Object.defineProperty(object, key, {
        configurable: true,
        get() { counter.calls += 1; throw new Error('identifier-reread'); },
      });
    }

    const normalized = normalizeShipmentWebhook({ trustedIdentity: identity, body });
    expect(normalized.eventRecord).toEqual(expect.objectContaining({
      eventId: 'evt-1', companyId: '12655', applicationId: 'app-1', shipmentId: '17861361389811907489',
    }));
    expect(counter.calls).toBe(0);

    const lookalike = Object.freeze({ ...identity });
    expect(() => normalizeShipmentWebhook({ trustedIdentity: lookalike, body }))
      .toThrow(expect.objectContaining({ code: 'WEBHOOK_IDENTIFIER_INVALID' }));
  });
});
